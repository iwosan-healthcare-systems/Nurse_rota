const pool = require("../db");

async function periodStartForShiftDate(shiftDate, fallback) {
  const { rows } = await pool.query(
    `SELECT period_end::text
       FROM nurse_period_hours
      WHERE period_end < $1::date
      ORDER BY period_end DESC
      LIMIT 1`,
    [shiftDate],
  );
  if (!rows[0]?.period_end) return fallback || shiftDate;

  const nextStart = new Date(rows[0].period_end.slice(0, 10) + "T00:00:00");
  nextStart.setDate(nextStart.getDate() + 1);
  return nextStart.toISOString().slice(0, 10);
}

module.exports = { periodStartForShiftDate };