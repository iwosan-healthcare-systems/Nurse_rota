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

module.exports = { getSickEmergencyMaxDays, DEFAULT_SICK_EMERGENCY_MAX_DAYS };
