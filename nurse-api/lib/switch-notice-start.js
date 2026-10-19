const { withAssignmentShiftDefinitions } = require("./assignment-shift-definition");

async function switchNoticeStart(db, nurseId, date) {
  const { rows } = await db.query(
    "SELECT *,shift_date::text FROM shift_assignments WHERE nurse_id=$1 AND shift_date=$2 LIMIT 1",
    [nurseId, date],
  );
  const assignment = rows[0];
  if (assignment?.shift_definition_run_id || assignment?.scheduling_run_id) {
    const [resolved] = await withAssignmentShiftDefinitions(db, rows);
    if (resolved.shift_definition_error) {
      const error = new Error(resolved.shift_definition_error);
      error.code = "CONFIGURED_EDIT_INVALID";
      throw error;
    }
    if (resolved.scheduled_shift) return Date.parse(resolved.scheduled_shift.startsAt);
  }
  // Preserve the existing conservative midnight fallback for OFF/missing duties.
  const hour = assignment?.shift === "N" ? "17" : assignment?.shift === "M" ? "08" : "00";
  return Date.parse(`${date}T${hour}:00:00+01:00`);
}

async function validateSwitchNotice(db, nurseId, date, minNoticeHours, now = Date.now()) {
  if (!(minNoticeHours > 0)) return;
  const { rows } = await db.query(
    `SELECT type FROM leave_requests WHERE nurse_id=$1 AND status='Approved'
     AND from_date<=$2 AND to_date>=$2 LIMIT 1`,
    [nurseId, date],
  );
  if (rows[0] && ["Sick", "Emergency"].includes(rows[0].type)) return;
  const start = await switchNoticeStart(db, nurseId, date);
  if (!Number.isFinite(start) || !Number.isFinite(now)) {
    const error = new Error("Shift notice cannot be verified: invalid start time or clock");
    error.code = "CONFIGURED_EDIT_INVALID";
    throw error;
  }
  const remaining = (start - now) / 3600000;
  if (remaining < minNoticeHours) {
    const error = new Error(
      `Shift switch requests need at least ${minNoticeHours} hour(s) notice before the shift (${Math.max(0, Math.floor(remaining))}h remaining).`,
    );
    error.code = "SWITCH_MIN_NOTICE_NOT_MET";
    throw error;
  }
}
module.exports = { switchNoticeStart, validateSwitchNotice };
