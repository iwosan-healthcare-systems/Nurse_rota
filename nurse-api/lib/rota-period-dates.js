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

module.exports = { getNextPeriodDates };
