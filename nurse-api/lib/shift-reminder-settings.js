const pool = require("../db");

// Admin-configurable via System Settings — how long after a shift's start
// time a "you haven't clocked in" email fires (default 3 hours), and how
// long before a shift's start time a "starts soon" email fires (default 15
// minutes). Shared by auto-shift-missed-reminder.js and
// auto-shift-start-reminder.js.
const DEFAULT_SHIFT_REMINDER_SETTINGS = {
  missed_shift_hours: 3,
  upcoming_shift_minutes: 15,
};

async function getShiftReminderSettings() {
  const { rows } = await pool.query(
    "SELECT value FROM portal_settings WHERE key = 'shift_reminder_settings'",
  );
  return { ...DEFAULT_SHIFT_REMINDER_SETTINGS, ...(rows[0]?.value ?? {}) };
}

module.exports = { getShiftReminderSettings, DEFAULT_SHIFT_REMINDER_SETTINGS };
