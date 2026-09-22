const pool = require("../db");

async function periodStartForShiftDate(shiftDate, fallback) {
  const { rows } = await pool.query(
    `SELECT (anchor + (($1::date - anchor) / 28) * 28)::text AS period_start
       FROM (
         SELECT MIN(shift_date)::date AS anchor FROM shift_assignments
         WHERE status = 'published' AND shift_date <= $1::date
       ) cycle`,
    [shiftDate],
  );
  return rows[0]?.period_start || fallback || shiftDate;
}

module.exports = { periodStartForShiftDate };
