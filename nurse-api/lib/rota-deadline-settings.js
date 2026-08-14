const pool = require("../db");

// Admin-configurable day-offsets for the rota lifecycle timeline, all counted
// back from the next period's start date:
//   leave_closure_days : non-exempt leave requests blocked from this many
//                         days before the next period starts
//   generate_days       : system auto-generates the draft rota
//   edit_close_days     : draft force-submitted; edit-access grants close
//   publish_deadline_days: system auto-publishes if HR-approved
//   revert_grace_days   : days after a CNO revert-to-draft before auto-submit
//                         resumes force-submitting that unit as-is — distinct
//                         from the four above (which count back from period
//                         start), this one counts forward from the revert
//                         itself. See lib/force-submit-rota.js's
//                         wasRevertedToDraft.
// Read fresh from portal_settings on every call (not cached) — same
// convention as rota-job-pause.js, so a System Settings change takes effect
// on the very next check, no deploy/restart needed. Defaults match the
// values this system shipped with (T-21/T-19/T-17/T-14, +2 days grace).
const DEFAULT_ROTA_DEADLINES = {
  leave_closure_days: 21,
  generate_days: 19,
  edit_close_days: 17,
  publish_deadline_days: 14,
  revert_grace_days: 2,
};

async function getRotaDeadlineSettings() {
  const { rows } = await pool.query(
    "SELECT value FROM portal_settings WHERE key = 'rota_deadlines'",
  );
  return { ...DEFAULT_ROTA_DEADLINES, ...(rows[0]?.value ?? {}) };
}

module.exports = { getRotaDeadlineSettings, DEFAULT_ROTA_DEADLINES };
