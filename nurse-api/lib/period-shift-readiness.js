const { withAssignmentShiftDefinitions } = require("./assignment-shift-definition");

// The caller holds the period-close transaction. Lock the published cells while
// resolving their saved windows so a concurrent duty edit cannot shorten them.
async function periodShiftReadiness(db, start, end, now) {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid archive evaluation time");
  const { rows } = await db.query(
    `SELECT sa.*,sa.shift_date::text FROM shift_assignments sa
     WHERE sa.status='published' AND sa.shift_date BETWEEN $1::date AND $2::date
       AND sa.shift NOT IN ('OFF','LEAVE')
     ORDER BY sa.shift_date,sa.id FOR SHARE OF sa`,
    [start, end],
  );
  const resolved = await withAssignmentShiftDefinitions(db, rows);
  for (const row of resolved) {
    if (row.shift_definition_error || !row.scheduled_shift)
      return {
        ready: false,
        assignmentId: row.id,
        reason: row.shift_definition_error ?? "Missing shift definition",
      };
    if (Date.parse(row.scheduled_shift.endsAt) > now.getTime())
      return { ready: false, assignmentId: row.id, reason: "A scheduled shift has not ended" };
  }
  return { ready: true };
}

module.exports = { periodShiftReadiness };
