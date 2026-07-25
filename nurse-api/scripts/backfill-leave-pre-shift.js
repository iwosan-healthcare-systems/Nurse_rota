// One-time script: backfill pre_leave_shift for LEAVE cells that were created by
// rota generation/regeneration before the fix in routes/shift-assignments.js that
// captures the original shift (the UPDATE ... SET shift = 'LEAVE' there used to
// overwrite the scheduled M/N value without saving it first).
//
// Rather than guess what each nurse's original schedule literally was — impossible
// for long leave blocks, since the value is already gone — this fills each nurse's
// LEAVE days with 4-day M/N blocks (mirroring the app's own 4M-4OFF-4N-4OFF cycle)
// up to their target_hours for the period, so leave doesn't shortchange their pay.
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

    const dates = days.map((d) => d.shift_date);
    const assign = new Map();
    let i = 0;
    if (hasNight) {
      while (gap >= 60 && dates.length - i >= 4) {
        for (let k = 0; k < 4; k++) assign.set(dates[i + k], "N");
        gap -= 60;
        i += 4;
      }
    }
    while (gap >= 36 && dates.length - i >= 4) {
      for (let k = 0; k < 4; k++) assign.set(dates[i + k], "M");
      gap -= 36;
      i += 4;
    }
    while (gap > 0 && i < dates.length) {
      if (hasNight && gap >= 12) {
        assign.set(dates[i], "N");
        gap -= 15;
      } else {
        assign.set(dates[i], "M");
        gap -= 9;
      }
      i++;
    }
    while (i < dates.length) {
      assign.set(dates[i], "OFF");
      i++;
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
      leaveDays: dates.length,
      addedHours,
      projected: workedHours + addedHours,
      breakdown: dates.map((d) => `${d}:${assign.get(d)}`).join(", "),
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
