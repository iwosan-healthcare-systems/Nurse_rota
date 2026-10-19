const { validateConfiguredEdit } = require("./configured-assignment-edit");
const { withAssignmentShiftDefinitions } = require("./assignment-shift-definition");
const { validateConfiguredLeaveRestoration } = require("./configured-leave-restoration");
const fail = (status, message) => {
  const error = new Error(message);
  error.code = "CONFIGURED_SWAP_INVALID";
  error.status = status;
  throw error;
};
async function swapConfiguredAssignments(pool, expected, actor, authorize, approval = null) {
  if (
    !Array.isArray(expected) ||
    expected.length !== 2 ||
    expected[0]?.id === expected[1]?.id ||
    expected.some(
      (e) =>
        !e ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(e.id) ||
        typeof e.shift !== "string",
    )
  )
    fail(400, "Provide two distinct assignments and their expected shifts");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    let request = null;
    if (approval) {
      const { rows: requests } = await db.query(
        "SELECT *,from_date::text,to_date::text FROM leave_requests WHERE id=$1 FOR UPDATE",
        [approval.requestId],
      );
      request = requests[0];
      if (!request || request.type !== "Swap" || request.status !== "Pending")
        fail(409, "A pending switch request is required");
    }
    const { rows } = await db.query(
      `SELECT sa.*,sa.shift_date::text,n.facility FROM shift_assignments sa
      JOIN nurses n ON n.id=sa.nurse_id WHERE sa.id=ANY($1::uuid[]) ORDER BY sa.id FOR UPDATE OF sa`,
      [expected.map((e) => e.id)],
    );
    if (rows.length !== 2) fail(404, "Assignment not found");
    if (!(await authorize(rows))) fail(403, "No active edit-access grant for both assignments");
    const [a, b] = rows;
    const parts = request?.reason?.split("|") ?? [];
    const interWard = parts.includes("INTER_WARD");
    const leaveCover = parts.includes("LEAVE_COVER");
    // Nurse A is the request's subject; Nurse B covers or exchanges with them.
    const first = request ? rows.find((row) => row.nurse_id === request.nurse_id) : a;
    const second = request ? rows.find((row) => row.nurse_id === parts[1]) : b;
    if (request && (!a.ward || !b.ward))
      fail(409, "Facility-wide configured switches are not supported yet");
    if (request) {
      if (
        parts[0] !== "SHIFT_SWITCH" ||
        !first ||
        !second ||
        first === second ||
        parts[3] !== (leaveCover ? first.pre_leave_shift : first.shift) ||
        parts[4] !== second.shift ||
        request.from_date !== a.shift_date ||
        request.to_date !== a.shift_date
      )
        fail(409, "Switch request no longer matches these duties");
    }
    if (
      a.nurse_id === b.nurse_id ||
      a.shift_date !== b.shift_date ||
      (a.ward !== b.ward && !interWard && !leaveCover) ||
      a.facility !== b.facility
    )
      fail(409, "Swap requires different nurses in the same ward, facility and date");
    for (const row of rows) {
      const wanted = expected.find((e) => e.id === row.id);
      const runId = row.shift_definition_run_id ?? row.scheduling_run_id;
      if (!runId || wanted.definitionRunId !== runId || wanted.shift !== row.shift)
        fail(409, "Assignment changed. Reload before swapping");
      const onLeave = row.shift === "LEAVE";
      if (
        row.status !== (request ? "published" : "draft") ||
        onLeave !== (leaveCover && row === first)
      )
        fail(409, "Assignments are not in the required state for this switch");
    }
    // Leave cover requires Nurse A's approved leave; everyone who changes duty
    // must be free of leave, filled locum cover and attendance on the date.
    const changing = leaveCover ? [second] : rows;
    const { rows: protectedRows } = await db.query(
      `SELECT 1 FROM leave_requests WHERE nurse_id=ANY($1::uuid[])
      AND status='Approved' AND $2::date BETWEEN from_date AND to_date
      UNION ALL SELECT 1 FROM locum_requests WHERE accepted_by_nurse_id=ANY($1::uuid[])
      AND status='filled' AND shift_date=$2::date
      UNION ALL SELECT 1 FROM shift_logs WHERE nurse_id=ANY($1::uuid[]) AND shift_date=$2::date LIMIT 1`,
      [changing.map((row) => row.nurse_id), a.shift_date],
    );
    if (protectedRows.length)
      fail(409, "Leave, coverage or attendance must be resolved before swapping");
    if (leaveCover) {
      const { rows: leave } = await db.query(
        `SELECT 1 FROM leave_requests WHERE nurse_id=$1 AND status='Approved' AND type<>'Swap'
         AND $2::date BETWEEN from_date AND to_date LIMIT 1`,
        [first.nurse_id, a.shift_date],
      );
      if (!leave.length) fail(409, "Leave cover requires Nurse A's approved leave on this date");
    }
    if (!request) {
      await validateConfiguredEdit(db, a, { shift: b.shift });
      await validateConfiguredEdit(db, b, { shift: a.shift });
    }
    // Leave cover: B takes A's planned duty in A's ward while A stays on leave.
    // Exchange: each takes the other's duty, and wards too when inter-ward.
    const changes = leaveCover
      ? [[second, first.pre_leave_shift, first.ward, first]]
      : [
          [first, second.shift, interWard ? second.ward : first.ward, second],
          [second, first.shift, interWard ? first.ward : second.ward, first],
        ];
    const proposedRows = changes.map(([row, shift, ward]) => ({ ...row, shift, ward }));
    const original = await withAssignmentShiftDefinitions(
      db,
      changes.map(([, , , source]) => source),
    );
    const proposed = await withAssignmentShiftDefinitions(db, proposedRows);
    const identity = (d) =>
      d
        ? JSON.stringify([
            d.code,
            d.name,
            d.startsAt,
            d.endsAt,
            d.breakMinutes,
            d.creditedMinutes,
            d.timezone,
          ])
        : null;
    if (
      [...original, ...proposed].some((r) => r.shift_definition_error) ||
      proposed.some((r, i) => identity(r.scheduled_shift) !== identity(original[i].scheduled_shift))
    )
      fail(409, "The saved shift definitions differ; edit these assignments individually");
    for (const [row, shift, ward] of changes)
      await db.query(
        `UPDATE shift_assignments
      SET shift=$2,ward=$5,updated_by=$3,updated_by_name=$4,updated_at=NOW() WHERE id=$1`,
        [row.id, shift, actor.userId, actor.name, ward],
      );
    // Check the proposed duties against the persisted change and neighboring days
    // (role choices, rest and published ward staffing) before anything commits.
    await validateConfiguredLeaveRestoration(db, proposed);
    if (request)
      await db.query(
        "UPDATE leave_requests SET status='Approved',reviewed_by=$2,reviewed_at=NOW(),review_note=$3 WHERE id=$1",
        [request.id, actor.userId, approval.note || null],
      );
    if (request)
      await db.query(
        `INSERT INTO notification_state(user_id,notif_key,is_read)
         SELECT id,$3,false FROM profiles WHERE id IN (
           SELECT profile_id FROM nurses WHERE id=ANY($1::uuid[])
           UNION SELECT $2::uuid
         ) ON CONFLICT(user_id,notif_key) DO NOTHING`,
        [[a.nurse_id, b.nurse_id], request.requested_by, `switch_approved_${request.id}`],
      );
    await db.query(
      "INSERT INTO audit_logs(actor_id,actor_name,action,target) VALUES ($1,$2,$3,$4)",
      [actor.userId, actor.name, "Swapped configured shifts", `${a.id} / ${b.id}`],
    );
    await db.query("COMMIT");
    return { swapped: true };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
module.exports = { swapConfiguredAssignments };
