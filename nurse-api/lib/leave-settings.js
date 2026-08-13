const pool = require("../db");

// How many days (inclusive of the start date) Sick/Emergency leave can span —
// admin-configurable via System Settings instead of a hardcoded literal.
// Default matches what this system shipped with: 3 days (start date + 2).
const DEFAULT_SICK_EMERGENCY_MAX_DAYS = 3;

async function getSickEmergencyMaxDays() {
  const { rows } = await pool.query(
    "SELECT value FROM portal_settings WHERE key = 'sick_emergency_max_days'",
  );
  const value = Number(rows[0]?.value);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SICK_EMERGENCY_MAX_DAYS;
}

// Minimum hours' notice required before a shift-switch (Swap) request's
// shift start — admin-configurable via System Settings. Defaults to 24 to
// match the rule this system already enforced (previously hardcoded,
// frontend-only, in leave.tsx's submit() — see the shared waiver logic
// there and in leave-requests.js). This is a pre-existing rule being made
// configurable and backend-enforced, not a new restriction, so the default
// must match what was already in effect — 0 would silently remove the
// 24-hour protection the moment this setting went live.
const DEFAULT_SHIFT_SWITCH_MIN_NOTICE_HOURS = 24;

async function getShiftSwitchMinNoticeHours() {
  const { rows } = await pool.query(
    "SELECT value FROM portal_settings WHERE key = 'shift_switch_min_notice_hours'",
  );
  const value = Number(rows[0]?.value);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SHIFT_SWITCH_MIN_NOTICE_HOURS;
}

module.exports = {
  getSickEmergencyMaxDays,
  DEFAULT_SICK_EMERGENCY_MAX_DAYS,
  getShiftSwitchMinNoticeHours,
  DEFAULT_SHIFT_SWITCH_MIN_NOTICE_HOURS,
};
