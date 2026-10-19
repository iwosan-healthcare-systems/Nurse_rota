const pool = require("../db");

async function periodStartForShiftDate(shiftDate, fallback) {
  // The rota period (calendar month, or an earlier 28-day period) holding the shift.
  const { rows } = await pool.query("SELECT rota_period_start($1::date)::text AS period_start", [
    shiftDate,
  ]);
  return rows[0]?.period_start || fallback || shiftDate;
}

module.exports = { periodStartForShiftDate };
