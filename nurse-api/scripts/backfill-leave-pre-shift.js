// One-time script: backfill pre_leave_shift for LEAVE cells that were created by
// rota generation/regeneration before the fix in routes/shift-assignments.js that
// captures the original shift (the UPDATE ... SET shift = 'LEAVE' there used to
// overwrite the scheduled M/N value without saving it first).
//
// Rather than guess what each nurse's original schedule literally was — impossible
// for long leave blocks, since the value is already gone — this fills each nurse's
// LEAVE days up to their target_hours for the period, so leave doesn't shortchange
// their pay. The fill follows the app's own 4M-4OFF-4N-4OFF cycle grammar: work
// segments are up to 4 consecutive days, and two work segments within the same
// contiguous leave block are always separated by an OFF segment (up to 4 days) —
// never back-to-back. Segments only run shorter than 4 days when the leave block
// itself runs out of days first (e.g. a 2-day leave block still gets 2 days of the
// next shift the cycle calls for, rather than being zeroed to OFF for being under
// 4 days). Each nurse's separate leave blocks within a period are filled
// independently (in chronological order), sharing one running hours gap, so a
// later block naturally goes OFF once target_hours has already been met.
// Nurses who never work nights (porter-day, NA-day, surgical-nurse-day roles, or
// any ward with min_night_nurses = 0 and min_night_na = 0) only get morning fill.
//
// Run from /home/ubuntu/nurse-api on NRota (ubuntu@13.53.223.160):
//   node scripts/backfill-leave-pre-shift.js            (dry run — prints the plan)
//   node scripts/backfill-leave-pre-shift.js --apply     (writes pre_leave_shift)

require("dotenv").config();
const pool = require("../db");

const HOURS = { M: 9, MWC: 9, N: 15, NC: 15 };
const DEFAULT_TARGET = 180;
const DAY_MS = 86400000;

function isPorterDayType(role) {
  return /^porter\s*-\s*day$/i.test(role);
}
function isNADayType(role) {
  return /nurs(?:e|ing)\s*assistant\s*-\s*day/i.test(role);
}
function isSurgicalNurseDayType(role) {
  return /^surgical\s*nurse\s*-\s*day$/i.test(role);
}

function toUTCDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
function fromUTCDate(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Split a chronologically-sorted list of leave rows into contiguous calendar blocks
// (a gap of more than 1 day between two leave rows starts a new block — those days
// in between were real worked/OFF days, so each side must be filled independently).
function splitIntoBlocks(days) {
  const blocks = [];
  let current = [];
  for (const d of days) {
    if (current.length) {
      const prevMs = toUTCDate(current[current.length - 1].shift_date);
      const curMs = toUTCDate(d.shift_date);
      if (curMs - prevMs > DAY_MS) {
        blocks.push(current);
        current = [];
      }
    }
    current.push(d);
  }
  if (current.length) blocks.push(current);
  return blocks;
}

// Fill one contiguous leave block with [work][OFF] segments (each up to 4 days),
// starting with a work attempt if hours are still owed. A work segment takes as
// many of the next 4 days as the block actually has left (so a block shorter than
// 4 days still gets a partial shift, rather than being zeroed to OFF) — it only
// stops adding work segments once target_hours has been met, at which point every
// remaining day in the block is OFF.
//
// Work segment type strictly ALTERNATES M/N/M/N... (never picked by "whichever
// closes the gap faster" — that produced unrealistic runs of all-N blocks). The
// alternation state (nextIsNight) is threaded in and back out so it stays
// continuous across a nurse's separate leave blocks within the same period, the
// same way a real nurse's rotation wouldn't reset just because leave interrupted
// it. Morning-only nurses (hasNight = false) always get M, no alternation.
//
// Returns { assign: Map<date, shift>, gap, nextIsNight }.
function fillBlock(dates, gapIn, hasNight, nextIsNightIn) {
  const assign = new Map();
  let gap = gapIn;
  let nextIsNight = nextIsNightIn;
  let i = 0;
  let workTurn = true;
  while (i < dates.length) {
    const remaining = dates.length - i;
    if (workTurn && gap > 0) {
      const shiftType = hasNight && nextIsNight ? "N" : "M";
      const take = Math.min(4, remaining);
      for (let k = 0; k < take; k++) assign.set(dates[i + k], shiftType);
      gap -= (shiftType === "N" ? 15 : 9) * take;
      i += take;
      workTurn = false;
      if (hasNight) nextIsNight = !nextIsNight;
    } else if (workTurn) {
      // Target already met — nothing more owed for the rest of this block.
      for (; i < dates.length; i++) assign.set(dates[i], "OFF");
    } else {
      const offLen = Math.min(4, remaining);
      for (let k = 0; k < offLen; k++) assign.set(dates[i + k], "OFF");
      i += offLen;
      workTurn = true;
    }
  }
  return { assign, gap: Math.max(gap, 0), nextIsNight };
}

async function main() {
  const apply = process.argv.includes("--apply");

  const { rows: anchorRows } = await pool.query(
    `SELECT MIN(shift_date) AS anchor FROM shift_assignments WHERE status = 'published'`,
  );
  const anchor = anchorRows[0].anchor;
  if (!anchor) {
    console.log("No published assignments found — nothing to do.");
    return pool.end();
  }
  const anchorMs = toUTCDate(anchor);
  const periodIndex = (dateStr) => Math.floor((toUTCDate(dateStr) - anchorMs) / (28 * DAY_MS));
  const periodStart = (idx) => fromUTCDate(anchorMs + idx * 28 * DAY_MS);
  const periodEnd = (idx) => fromUTCDate(anchorMs + (idx * 28 + 27) * DAY_MS);

  const { rows: leaveRows } = await pool.query(
    `SELECT sa.id, sa.nurse_id, sa.shift_date, n.name, n.role, n.ward, n.facility,
            COALESCE(NULLIF(n.target_hours, 0), $1) AS target_hours
     FROM shift_assignments sa
     JOIN nurses n ON n.id = sa.nurse_id
     WHERE sa.shift = 'LEAVE' AND sa.status = 'published' AND sa.pre_leave_shift IS NULL
     ORDER BY sa.nurse_id, sa.shift_date`,
    [DEFAULT_TARGET],
  );

  if (!leaveRows.length) {
    console.log("Nothing to backfill.");
    return pool.end();
  }

  const groups = new Map();
  for (const r of leaveRows) {
    const idx = periodIndex(r.shift_date);
    const key = `${r.nurse_id}|${idx}`;
    if (!groups.has(key)) groups.set(key, { nurse: r, idx, days: [] });
    groups.get(key).days.push(r);
  }

  const plan = [];
  const report = [];

  for (const { nurse, idx, days } of groups.values()) {
    const pStart = periodStart(idx);
    const pEnd = periodEnd(idx);

    const { rows: realRows } = await pool.query(
      `SELECT shift FROM shift_assignments
       WHERE nurse_id = $1 AND status = 'published'
         AND shift_date BETWEEN $2 AND $3 AND shift NOT IN ('LEAVE', 'OFF')`,
      [nurse.nurse_id, pStart, pEnd],
    );
    const workedHours = realRows.reduce((sum, r) => sum + (HOURS[r.shift] || 0), 0);
    const empiricalNight = realRows.some((r) => r.shift === "N" || r.shift === "NC");

    let morningOnly =
      isPorterDayType(nurse.role) || isNADayType(nurse.role) || isSurgicalNurseDayType(nurse.role);
    if (!morningOnly && nurse.ward) {
      const { rows: wardRows } = await pool.query(
        `SELECT min_night_nurses, min_night_na FROM wards WHERE name = $1 AND facility = $2 LIMIT 1`,
        [nurse.ward, nurse.facility],
      );
      if (wardRows[0] && wardRows[0].min_night_nurses === 0 && wardRows[0].min_night_na === 0) {
        morningOnly = true;
      }
    }
    const hasNight = empiricalNight ? true : !morningOnly;

    const target = parseFloat(nurse.target_hours);
    let gap = Math.max(target - workedHours, 0);

    // Blocks are processed in chronological order, sharing one running gap and one
    // running M/N alternation state — once an earlier block satisfies target_hours,
    // later blocks in the same period naturally come out all-OFF; the alternation
    // keeps going across blocks rather than resetting to M every time.
    const blocks = splitIntoBlocks(days);
    const assign = new Map();
    const blockSummaries = [];
    let nextIsNight = false; // first work segment of the period starts on M
    for (const block of blocks) {
      const dates = block.map((d) => d.shift_date);
      const { assign: blockAssign, gap: gapAfter, nextIsNight: nextAfter } = fillBlock(
        dates,
        gap,
        hasNight,
        nextIsNight,
      );
      gap = gapAfter;
      nextIsNight = nextAfter;
      for (const [date, shift] of blockAssign) assign.set(date, shift);
      blockSummaries.push(`[${dates[0]}..${dates[dates.length - 1]}] ${dates.map((d) => assign.get(d)).join("")}`);
    }

    let addedHours = 0;
    for (const d of days) {
      const shift = assign.get(d.shift_date);
      plan.push({ id: d.id, shift });
      addedHours += HOURS[shift] || 0;
    }

    report.push({
      name: nurse.name,
      role: nurse.role,
      period: `${pStart} -> ${pEnd}`,
      workedHours,
      target,
      hasNight,
      leaveDays: days.length,
      addedHours,
      projected: workedHours + addedHours,
      breakdown: blockSummaries.join(" | "),
    });
  }

  report.forEach((r) => {
    console.log(`\n${r.name} (${r.role}) - period ${r.period}`);
    console.log(
      `  worked ${r.workedHours}h / target ${r.target}h - night-eligible: ${r.hasNight} - ${r.leaveDays} leave day(s)`,
    );
    console.log(`  plan adds ${r.addedHours}h -> projected ${r.projected}h`);
    console.log(`  ${r.breakdown}`);
  });

  console.log(`\n${plan.length} leave day(s) across ${report.length} nurse-period(s).`);

  if (!apply) {
    console.log("\nDry run only - rerun with --apply to write pre_leave_shift.");
    return pool.end();
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const p of plan) {
      await client.query(
        "UPDATE shift_assignments SET pre_leave_shift = $1 WHERE id = $2 AND pre_leave_shift IS NULL",
        [p.shift, p.id],
      );
    }
    await client.query("COMMIT");
    console.log(`Applied pre_leave_shift to ${plan.length} row(s).`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Failed, rolled back:", e.message);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
