// Caller owns the transaction containing duty restoration and leave changes.
async function reverseLeaveCredits(db, leave, from, to) {
  const { rows } = await db.query(
    `DELETE FROM shift_logs WHERE leave_request_id=$1 AND nurse_id=$2 AND is_leave=true
       AND shift_date BETWEEN $3::date AND $4::date RETURNING hours_logged`,
    [leave.id, leave.nurse_id, from, to],
  );
  const hours =
    Math.round(rows.reduce((sum, row) => sum + Number(row.hours_logged || 0), 0) * 100) / 100;
  if (hours > 0) await db.query("SELECT increment_nurse_hours($1,$2)", [leave.nurse_id, -hours]);
  return hours;
}
module.exports = { reverseLeaveCredits };
