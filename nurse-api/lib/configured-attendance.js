const { withAssignmentShiftDefinitions } = require("./assignment-shift-definition");
class AttendanceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new AttendanceError(status, message);
};
function creditedAttendanceHours(definition, startedAt, endedAt) {
  const start = Math.max(Date.parse(startedAt), Date.parse(definition.startsAt));
  const end = Math.min(Date.parse(endedAt), Date.parse(definition.endsAt));
  if (!Number.isFinite(start) || !Number.isFinite(end)) fail(400, "Invalid attendance time");
  const minutes = Math.min(
    definition.creditedMinutes,
    Math.max(0, (end - start) / 60000 - definition.breakMinutes),
  );
  return Math.round((minutes / 60) * 100) / 100;
}
async function configuredAttendanceDefinition(db, nurseId, date, shiftType) {
  const { rows } = await db.query(
    "SELECT *,shift_date::text FROM shift_assignments WHERE nurse_id=$1 AND shift_date=$2",
    [nurseId, date],
  );
  const cell = rows[0];
  if (!cell || !(cell.shift_definition_run_id ?? cell.scheduling_run_id)) return null;
  if (cell.status !== "published") fail(409, "The configured assignment is not published");
  if (["OFF", "LEAVE"].includes(cell.shift)) fail(409, "This assignment is not a working shift");
  const [resolved] = await withAssignmentShiftDefinitions(db, rows);
  if (resolved.shift_definition_error || !resolved.scheduled_shift)
    fail(409, "The saved shift definition needs review");
  const logCode = ["M", "MWC"].includes(cell.shift)
    ? "M"
    : ["N", "NC"].includes(cell.shift)
      ? "N"
      : cell.shift;
  if (shiftType !== logCode) fail(409, "Shift type does not match the published assignment");
  return resolved.scheduled_shift;
}
function configuredStart(definition, body, { admin = false, now = new Date() } = {}) {
  const official = Date.parse(definition.startsAt),
    end = Date.parse(definition.endsAt);
  if (body.is_missed) {
    if (now.getTime() < end) fail(409, "The configured shift has not ended");
    return {
      started_at: definition.startsAt,
      expected_end_at: definition.endsAt,
      ended_at: definition.endsAt,
      hours_logged: 0,
      is_late: false,
      late_minutes: null,
    };
  }
  const instant = admin ? Date.parse(body.started_at) : now.getTime();
  if (!Number.isFinite(instant)) fail(400, "Invalid shift start");
  if (instant < official - 15 * 60000 || instant >= end)
    fail(409, "Outside the configured shift sign-in window");
  const started_at = new Date(Math.max(official, instant)).toISOString();
  let ended_at = null,
    hours_logged = null;
  if (body.ended_at != null) {
    if (!admin) fail(400, "Use End shift to complete attendance");
    const ended = Date.parse(body.ended_at);
    if (!Number.isFinite(ended) || ended < Date.parse(started_at)) fail(400, "Invalid shift end");
    ended_at = new Date(Math.min(ended, end)).toISOString();
    hours_logged = creditedAttendanceHours(definition, started_at, ended_at);
  }
  const late_minutes = Math.max(0, Math.floor((instant - official) / 60000));
  return {
    started_at,
    expected_end_at: definition.endsAt,
    ended_at,
    hours_logged,
    is_late: late_minutes > 0,
    late_minutes: late_minutes || null,
  };
}
async function updateConfiguredAttendance(pool, id, userId, admin, body, now = new Date()) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const {
      rows: [log],
    } = await db.query(
      `SELECT * FROM shift_logs WHERE id=$1 AND ($3::boolean OR nurse_id=COALESCE(
        (SELECT id FROM nurses WHERE profile_id=$2 LIMIT 1),
        (SELECT id FROM nurses WHERE LOWER(name)=LOWER((SELECT full_name FROM profiles WHERE id=$2)) LIMIT 1)
      )) FOR UPDATE`,
      [id, userId, admin],
    );
    if (!log?.scheduling_definition) {
      await db.query("ROLLBACK");
      return null;
    }
    if (log.ended_at && !admin) {
      await db.query("COMMIT");
      return { ...log, hours_credited_by_server: true };
    }
    if (!body.ended_at || !Number.isFinite(Date.parse(body.ended_at)))
      fail(400, "Provide a valid shift end time");
    const requested = admin ? Date.parse(body.ended_at) : now.getTime();
    if (requested < Date.parse(log.started_at))
      fail(400, "End time must not precede the shift start");
    const ended = new Date(
      Math.min(requested, Date.parse(log.scheduling_definition.endsAt)),
    ).toISOString();
    const hours = log.is_missed
      ? 0
      : creditedAttendanceHours(log.scheduling_definition, log.started_at, ended);
    const {
      rows: [saved],
    } = await db.query(
      "UPDATE shift_logs SET ended_at=$2,hours_logged=$3 WHERE id=$1 RETURNING *",
      [id, ended, hours],
    );
    const delta = hours - Number(log.hours_logged ?? 0);
    if (delta && !log.is_locum && !log.is_swap)
      await db.query("SELECT increment_nurse_hours($1,$2)", [log.nurse_id, delta]);
    await db.query("COMMIT");
    return { ...saved, hours_credited_by_server: true };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
module.exports = {
  AttendanceError,
  configuredAttendanceDefinition,
  configuredStart,
  creditedAttendanceHours,
  updateConfiguredAttendance,
};
