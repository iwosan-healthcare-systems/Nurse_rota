// Auto-generates the next period's draft rota at T-19 (19 days before the
// next period start — see lib/rota-period-dates.js), so a head_nurse no
// longer has to click "Generate." Runs the exact same generateSchedule()
// engine the Rota page's manual "Generate" button uses (ported to plain JS —
// see nurse-api/lib/auto-schedule.generated.js and
// nurse-api/scripts/build-auto-schedule.js), and the same pre-flight/write
// sequence handleGenerate()/handleGenerateFacilityWide() do in rota.tsx,
// just run server-side against the DB directly instead of via the browser +
// HTTP API (no req.user for a cron tick — see routes/shift-assignments.js's
// capability rewrite for why manual generation now requires admin).
const cron = require("node-cron");
const pool = require("../db");
const { getNextPeriodDates } = require("../lib/rota-period-dates");
const {
  generateSchedule,
  isMatron,
  isGlobalHead,
  isPorterType,
  isInternType,
  parseWards,
} = require("../lib/auto-schedule.generated.js");

// Distinct from AUTO_END_LOCK_KEY (729312), AUTO_DECLINE_LOCK_KEY (729313),
// AUTO_EXPIRE_LOCUM_LOCK_KEY (729314) — see jobs/auto-end-shifts.js for why
// the lock exists.
const AUTO_GENERATE_LOCK_KEY = 729315;
const DAYS = 28;
const DRY_RUN = process.env.DRY_RUN_ROTA_JOBS === "true";

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return ymd(d);
}
function daysBetween(fromStr, toStr) {
  return Math.round(
    (new Date(toStr + "T00:00:00").getTime() - new Date(fromStr + "T00:00:00").getTime()) /
      (24 * 60 * 60 * 1000),
  );
}

async function autoGenerateRota(opts = {}) {
  const lockClient = await pool.connect();
  try {
    const { rows } = await lockClient.query("SELECT pg_try_advisory_lock($1) AS locked", [
      AUTO_GENERATE_LOCK_KEY,
    ]);
    if (!rows[0].locked) return;
    await runAutoGenerate(opts);
  } catch (err) {
    console.error("[auto-generate-rota] Error:", err.message);
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [AUTO_GENERATE_LOCK_KEY]).catch(() => {});
    lockClient.release();
  }
}

async function runAutoGenerate({ simulateToday } = {}) {
  const dates = await getNextPeriodDates({ simulateToday });
  if (!dates || !dates.generateIsDue) return;

  const genStart = dates.nextPeriodStart;
  const genEnd = addDays(genStart, DAYS - 1);

  const { rows: facilities } = await pool.query(
    "SELECT DISTINCT facility FROM nurses WHERE facility IS NOT NULL AND is_active = true",
  );

  for (const { facility } of facilities) {
    const { rows: facilityNurses } = await pool.query(
      "SELECT id, name, role, ward, facility, target_hours FROM nurses WHERE facility = $1 AND is_active = true",
      [facility],
    );
    if (!facilityNurses.length) continue;

    const { rows: wards } = await pool.query(
      `SELECT id, name, facility, min_morning_nurses, min_morning_na, min_night_nurses, min_night_na
         FROM wards WHERE facility = $1 OR facility IS NULL`,
      [facility],
    );

    const facilityIds = facilityNurses.map((n) => n.id);
    let periodOffset = 0;
    let previousAssignments = [];
    const dayBefore = addDays(genStart, -1);
    const { rows: epochRows } = await pool.query(
      `SELECT shift_date FROM shift_assignments
        WHERE nurse_id = ANY($1) AND shift_date <= $2
        ORDER BY shift_date DESC LIMIT 1`,
      [facilityIds, dayBefore],
    );
    if (epochRows[0]) {
      periodOffset = daysBetween(epochRows[0].shift_date.slice(0, 10), genStart);
    }
    if (periodOffset > 0) {
      const { rows: prevRows } = await pool.query(
        `SELECT nurse_id, shift_date, shift FROM shift_assignments
          WHERE nurse_id = ANY($1) AND shift_date BETWEEN $2 AND $3`,
        [facilityIds, addDays(genStart, -5), addDays(genStart, -1)],
      );
      previousAssignments = prevRows;
    }

    const { rows: leaveRows } = await pool.query(
      `SELECT nurse_id, from_date::text, to_date::text, status FROM leave_requests
        WHERE nurse_id = ANY($1) AND status = 'Approved' AND from_date <= $3 AND to_date >= $2`,
      [facilityIds, genStart, genEnd],
    );

    // Ward-based units — everyone not in a facility-wide role, grouped by their first ward.
    const wardNurses = facilityNurses.filter(
      (n) => !isGlobalHead(n.role) && !isMatron(n.role) && !isInternType(n.role) && !isPorterType(n.role),
    );
    const wardNames = [...new Set(wardNurses.map((n) => parseWards(n.ward)[0]).filter(Boolean))];
    for (const wardName of wardNames) {
      await generateUnit({
        facility,
        unitNurses: wardNurses.filter((n) => parseWards(n.ward)[0] === wardName),
        wardsForGen: wards.filter((w) => w.name === wardName),
        ward: wardName,
        roleGroup: null,
        genStart,
        genEnd,
        periodOffset,
        previousAssignments,
        leave: leaveRows,
      });
    }

    // Facility-wide role groups.
    const GROUPS = [
      { key: "matron", filter: isMatron },
      { key: "head", filter: isGlobalHead },
      { key: "porter", filter: isPorterType },
      { key: "intern", filter: isInternType },
    ];
    for (const { key, filter } of GROUPS) {
      const groupNurses = facilityNurses.filter((n) => filter(n.role));
      if (!groupNurses.length) continue;
      await generateUnit({
        facility,
        unitNurses: groupNurses,
        wardsForGen: [],
        ward: null,
        roleGroup: key,
        genStart,
        genEnd,
        periodOffset,
        previousAssignments,
        leave: leaveRows,
      });
    }
  }
}

async function generateUnit({
  facility,
  unitNurses,
  wardsForGen,
  ward,
  roleGroup,
  genStart,
  genEnd,
  periodOffset,
  previousAssignments,
  leave,
}) {
  const unitIds = unitNurses.map((n) => n.id);
  const unitLabel = ward ?? roleGroup;

  // Generate exactly once per unit/period. This job ticks every 5 minutes and
  // "generate is due" stays true for the entire T-19-onward window (not just
  // the instant T-19 arrives), so without this guard a unit already generated
  // — whether by this job or by an admin's manual early trigger — would get
  // silently deleted and regenerated on every single tick, wiping out any
  // edits a head_nurse made in between (their edit-access grant only protects
  // against OTHER people's edits, not this job clobbering the whole unit).
  const { rows: existing } = await pool.query(
    `SELECT 1 FROM shift_assignments
      WHERE nurse_id = ANY($1) AND shift_date BETWEEN $2 AND $3 LIMIT 1`,
    [unitIds, genStart, genEnd],
  );
  if (existing.length) return;

  // Expire any leave request still Pending for this unit's nurses/period. By
  // generation time (T-19) it should already have been decided — rather than
  // block generation indefinitely on someone else's inaction (the old
  // behavior here), resolve it automatically so generation always proceeds
  // using only what's actually Approved (generateSchedule/inLeave already
  // only ever honor 'Approved' rows). Distinct from auto-decline-requests.js's
  // 'Rejected' outcome — this is a system timeout at the generation
  // checkpoint, not a human decision, hence 'Expired' rather than 'Rejected'.
  const { rows: pendingLeaves } = await pool.query(
    `SELECT id, nurse_id, nurse_name, requested_by, type, from_date::text, to_date::text
       FROM leave_requests
      WHERE nurse_id = ANY($1) AND status = 'Pending' AND type != 'Swap'
        AND from_date <= $3 AND to_date >= $2`,
    [unitIds, genStart, genEnd],
  );
  if (pendingLeaves.length) {
    if (DRY_RUN) {
      console.log(
        `[DRY-RUN][auto-generate-rota] would expire ${pendingLeaves.length} pending leave request(s) for ${facility}/${unitLabel}`,
      );
    } else {
      for (const lr of pendingLeaves) {
        await pool.query(
          `UPDATE leave_requests
              SET status = 'Expired', reviewed_at = NOW(),
                  review_note = 'Automatically expired — no decision was made before the rota was generated.'
            WHERE id = $1`,
          [lr.id],
        );
        await pool
          .query(`INSERT INTO audit_logs (actor_name, action, target) VALUES ('system', $1, $2)`, [
            "Leave request auto-expired (rota generation)",
            `${lr.nurse_name} · ${lr.type} · ${lr.from_date} → ${lr.to_date}`,
          ])
          .catch(() => {});
        await notify(lr.requested_by, `leave_expired_${lr.id}`);
        const profileId = await findProfileId(lr.nurse_id, lr.nurse_name);
        if (profileId && profileId !== lr.requested_by) {
          await notify(profileId, `leave_expired_${lr.id}_staff`);
        }
      }
      console.log(
        `[auto-generate-rota] expired ${pendingLeaves.length} pending leave request(s) for ${facility}/${unitLabel}`,
      );
    }
  }

  const { assignments, violations } = generateSchedule({
    nurses: unitNurses,
    wards: wardsForGen,
    leave,
    startDate: new Date(genStart + "T00:00:00"),
    days: DAYS,
    facility,
    periodOffset,
    previousAssignments,
  });

  if (DRY_RUN) {
    console.log(
      `[DRY-RUN][auto-generate-rota] would generate ${assignments.length} cell(s) for ${facility}/${unitLabel} (${violations.length} safety violation(s))`,
    );
    return;
  }

  await pool.query(
    `DELETE FROM shift_assignments WHERE nurse_id = ANY($1) AND shift_date BETWEEN $2 AND $3 AND status != 'published'`,
    [unitIds, genStart, genEnd],
  );
  const { rows: pubRows } = await pool.query(
    `SELECT nurse_id, shift_date FROM shift_assignments
      WHERE nurse_id = ANY($1) AND shift_date BETWEEN $2 AND $3 AND status = 'published'`,
    [unitIds, genStart, genEnd],
  );
  const publishedKeys = new Set(pubRows.map((r) => `${r.nurse_id}|${r.shift_date.slice(0, 10)}`));

  const rows = assignments.filter((a) => !publishedKeys.has(`${a.nurse_id}|${a.shift_date}`));
  for (const row of rows) {
    await pool.query(
      `INSERT INTO shift_assignments (nurse_id, shift, shift_date, ward, status)
       VALUES ($1, $2, $3, $4, 'draft')
       ON CONFLICT (nurse_id, shift_date)
       DO UPDATE SET shift = EXCLUDED.shift, ward = EXCLUDED.ward, status = 'draft', updated_at = NOW()`,
      [row.nurse_id, row.shift, row.shift_date, row.ward],
    );
  }

  await pool
    .query(`INSERT INTO audit_logs (actor_name, action, target) VALUES ('system', $1, $2)`, [
      "Rota auto-generated",
      `${facility} · ${unitLabel} · ${genStart} → ${genEnd} (${rows.length} cell(s)${violations.length ? `, ${violations.length} safety warning(s)` : ""})`,
    ])
    .catch(() => {});
  await notifyUnit(facility, "rota_autogenerated", unitLabel, genStart);
}

// Resolve a nurse to their login profile — mirrors the same fallback chain
// used in jobs/auto-decline-requests.js (profile_id link, then name match).
async function findProfileId(nurseId, nurseName) {
  const { rows } = await pool.query(
    `SELECT COALESCE(
       (SELECT p.id FROM nurses n JOIN profiles p ON p.id = n.profile_id WHERE n.id = $1),
       (SELECT p.id FROM nurses n JOIN profiles p ON LOWER(p.full_name) = LOWER(n.name) WHERE n.id = $1 LIMIT 1),
       (SELECT p.id FROM profiles p WHERE $2::text IS NOT NULL AND LOWER(p.full_name) = LOWER($2) LIMIT 1)
     ) AS profile_id`,
    [nurseId, nurseName],
  );
  return rows[0]?.profile_id ?? null;
}

async function notify(userId, notifKey) {
  if (!userId) return;
  await pool
    .query(
      `INSERT INTO notification_state (user_id, notif_key, is_read)
       VALUES ($1, $2, false)
       ON CONFLICT (user_id, notif_key) DO NOTHING`,
      [userId, notifKey],
    )
    .catch(() => {});
}

async function notifyUnit(facility, prefix, unitLabel, periodStart) {
  const facilitySlug = facility.toLowerCase().replace(/\s+/g, "_");
  const unitSlug = String(unitLabel).toLowerCase().replace(/\s+/g, "_");
  const notifKey = `${prefix}_${facilitySlug}_${unitSlug}_${periodStart}`;
  const { rows } = await pool.query(
    `SELECT DISTINCT p.id FROM profiles p
       JOIN user_roles ur ON ur.user_id = p.id
      WHERE ur.role IN ('head_nurse', 'admin') AND p.is_active = true`,
  );
  for (const { id } of rows) {
    await pool
      .query(
        `INSERT INTO notification_state (user_id, notif_key, is_read)
         VALUES ($1, $2, false)
         ON CONFLICT (user_id, notif_key) DO UPDATE SET is_read = false, updated_at = NOW()`,
        [id, notifKey],
      )
      .catch(() => {});
  }
}

function startAutoGenerateJob() {
  autoGenerateRota();
  cron.schedule("*/5 * * * *", () => autoGenerateRota());
  console.log("[auto-generate-rota] Auto-generate rota job started (runs every 5 minutes)");
}

module.exports = { startAutoGenerateJob, runAutoGenerate };
