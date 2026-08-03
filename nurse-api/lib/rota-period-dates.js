const pool = require("../db");

// Shared timeline math for the automated rota lifecycle, all relative to the
// next period's start date (day after the last published shift_date):
//   T-21 : leave_closure_date — non-exempt leave requests blocked (existing,
//          also computed independently in routes/rpc.js and
//          routes/leave-requests.js — this helper doesn't touch those, it's
//          only for the new T-19/T-17/T-14 jobs so there's one source of
//          truth for THEM, rather than a fourth/fifth copy of the math).
//   T-19 : generate_date     — system auto-generates the draft rota
//   T-17 : edit_close_date   — draft force-submitted; edit-access grants close
//   T-14 : publish_deadline  — system auto-publishes if HR-approved
//
// Each "*_is_due" boolean uses the same day-boundary semantics already
// established in rpc.js's workflow-status endpoint: due only once the WHOLE
// milestone day has elapsed in Africa/Lagos time (date + 1 day), not the
// instant it begins — and uses >= rather than an exact-day match, so a job
// that was down and catches up later still fires correctly (mirrors every
// other cron job in this codebase re-running on startup to catch up).
async function getNextPeriodDates({ simulateToday } = {}) {
  const { rows: pubRows } = await pool.query(
    `SELECT MAX(shift_date::date) AS last_date FROM shift_assignments WHERE status = 'published'`,
  );
  const lastDate = pubRows[0]?.last_date;
  if (!lastDate) return null;

  // Real "now" unless a test/UAT caller asks to simulate a different date
  // (pretends it's noon Lagos time on that date — only the calendar day
  // relative to each milestone boundary matters here).
  const now = simulateToday ? new Date(`${simulateToday}T12:00:00+01:00`) : new Date();

  const { rows } = await pool.query(
    `
    SELECT
      ($1::date + 1)::text                             AS next_period_start,
      ($1::date + 1 - INTERVAL '21 days')::date::text  AS leave_closure_date,
      ($1::date + 1 - INTERVAL '19 days')::date::text  AS generate_date,
      ($1::date + 1 - INTERVAL '17 days')::date::text  AS edit_close_date,
      ($1::date + 1 - INTERVAL '14 days')::date::text  AS publish_deadline,
      ($2::timestamptz >= (($1::date + 1 - INTERVAL '19 days') + INTERVAL '1 day')::timestamp AT TIME ZONE 'Africa/Lagos') AS generate_is_due,
      ($2::timestamptz >= (($1::date + 1 - INTERVAL '17 days') + INTERVAL '1 day')::timestamp AT TIME ZONE 'Africa/Lagos') AS edit_is_closed,
      ($2::timestamptz >= (($1::date + 1 - INTERVAL '14 days') + INTERVAL '1 day')::timestamp AT TIME ZONE 'Africa/Lagos') AS publish_is_overdue
    `,
    [lastDate, now.toISOString()],
  );

  const row = rows[0];
  return {
    nextPeriodStart: row.next_period_start,
    leaveClosureDate: row.leave_closure_date,
    generateDate: row.generate_date,
    editCloseDate: row.edit_close_date,
    publishDeadline: row.publish_deadline,
    generateIsDue: row.generate_is_due,
    editIsClosed: row.edit_is_closed,
    publishIsOverdue: row.publish_is_overdue,
  };
}

// Same T-19/T-17/T-14 math as getNextPeriodDates(), but computed directly
// from a known period_start instead of inferring "the next period" from the
// most recently published rota system-wide. getNextPeriodDates() assumes
// every unit shares one global cycle — true most of the time, but wrong for
// a unit that's fallen behind the rest (e.g. its rota was reverted by HR
// after other wards/facilities already progressed to published for that
// period). Anywhere a caller already knows the exact unit/period it cares
// about (rota-edit-requests.js, and the three lifecycle cron jobs via
// getUnitPeriod below), use this instead so the window is always checked
// against the right period, not whatever period the rest of the system has
// moved on to.
async function getWindowForPeriod(periodStart, { simulateToday } = {}) {
  const now = simulateToday ? new Date(`${simulateToday}T12:00:00+01:00`) : new Date();

  const { rows } = await pool.query(
    `
    SELECT
      ($1::date - INTERVAL '19 days')::date::text AS generate_date,
      ($1::date - INTERVAL '17 days')::date::text AS edit_close_date,
      ($1::date - INTERVAL '14 days')::date::text AS publish_deadline,
      ($2::timestamptz >= (($1::date - INTERVAL '19 days') + INTERVAL '1 day')::timestamp AT TIME ZONE 'Africa/Lagos') AS generate_is_due,
      ($2::timestamptz >= (($1::date - INTERVAL '17 days') + INTERVAL '1 day')::timestamp AT TIME ZONE 'Africa/Lagos') AS edit_is_closed,
      ($2::timestamptz >= (($1::date - INTERVAL '14 days') + INTERVAL '1 day')::timestamp AT TIME ZONE 'Africa/Lagos') AS publish_is_overdue
    `,
    [periodStart, now.toISOString()],
  );

  const row = rows[0];
  return {
    generateDate: row.generate_date,
    editCloseDate: row.edit_close_date,
    publishDeadline: row.publish_deadline,
    generateIsDue: row.generate_is_due,
    editIsClosed: row.edit_is_closed,
    publishIsOverdue: row.publish_is_overdue,
  };
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Determine one specific unit's own current period — a ward, or a
// facility-wide role group — independent of what any other unit is doing.
// Mirrors getNextPeriodDates()'s "next period = last published + 1"
// inference, but scoped to just this unit, and additionally recognizes a
// period the unit is already mid-lifecycle on (non-published rows still
// present).
//
// The three rota cron jobs need this because a unit can fall behind the rest
// of the system (e.g. it was reverted by HR after other units already
// published further ahead) — treating every unit as sharing one global
// period would either regenerate over a unit's unfinished work, miss it
// entirely once it's behind, or check its deadlines against the wrong dates.
//
// `nurseIds` should be a broad-enough candidate set: for a ward unit, every
// nurse in the facility is fine (the `ward` argument narrows correctly
// against shift_assignments.ward, which is authoritative per-row); for a
// facility-wide role group, nurseIds must already be filtered to that group
// (there's no per-row column to narrow by, unlike ward) — see
// resolveUnitNurseIds in lib/force-submit-rota.js.
//
// Returns null if this unit has never had a published rota (nothing for the
// automation to act on yet). hasActive is true when the unit currently has
// draft/submitted/hr_approved rows (periodStart is that in-progress period);
// false when periodStart was inferred from the last published rota instead.
async function getUnitPeriod(nurseIds, ward) {
  if (!nurseIds || !nurseIds.length) return null;
  const wardClause = ward ? "AND ward = $2" : "AND ward IS NULL";
  const params = ward ? [nurseIds, ward] : [nurseIds];

  const { rows: activeRows } = await pool.query(
    `SELECT MIN(shift_date)::text AS start FROM shift_assignments
      WHERE nurse_id = ANY($1) ${wardClause} AND status IN ('draft', 'submitted', 'hr_approved')`,
    params,
  );
  const activeStart = activeRows[0]?.start;
  if (activeStart) {
    return { periodStart: activeStart, periodEnd: addDays(activeStart, 27), hasActive: true };
  }

  const { rows: pubRows } = await pool.query(
    `SELECT MAX(shift_date)::text AS last FROM shift_assignments
      WHERE nurse_id = ANY($1) ${wardClause} AND status = 'published'`,
    params,
  );
  let lastPublished = pubRows[0]?.last;

  // A unit with no rota history of its own (e.g. a ward just added) has
  // nothing to anchor a period to — bootstrap it onto the system-wide cycle
  // instead of skipping it forever, matching what happened before per-unit
  // tracking existed. Once it gets its own first published rota, it follows
  // its own independent cadence from then on (the branches above).
  if (!lastPublished) {
    const { rows: globalRows } = await pool.query(
      `SELECT MAX(shift_date)::text AS last FROM shift_assignments WHERE status = 'published'`,
    );
    lastPublished = globalRows[0]?.last;
  }
  if (!lastPublished) return null; // nothing published anywhere yet — no reference point at all

  const periodStart = addDays(lastPublished, 1);
  return { periodStart, periodEnd: addDays(periodStart, 27), hasActive: false };
}

module.exports = { getNextPeriodDates, getWindowForPeriod, getUnitPeriod };
