async function guardLegacySwitchApproval(db, request, from, to) {
  const fail = (message) => {
    const error = new Error(message);
    error.code = "CONFIGURED_EDIT_INVALID";
    throw error;
  };
  const partner = request.reason?.startsWith("SHIFT_SWITCH|") ? request.reason.split("|")[1] : null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(partner ?? "") || !uuid.test(request.nurse_id ?? ""))
    fail("Shift switch participants cannot be verified");
  const { rows } = await db.query(
    `SELECT id FROM shift_assignments WHERE nurse_id=ANY($1::uuid[])
       AND shift_date BETWEEN $2::date AND $3::date
       AND COALESCE(shift_definition_run_id,scheduling_run_id) IS NOT NULL
       ORDER BY id FOR SHARE`,
    [[request.nurse_id, partner], from, to],
  );
  if (rows.length)
    fail(
      "Configured shift switches require an atomic reviewed workflow; this legacy switch cannot be approved",
    );
}
async function guardConfiguredSwitchRequest(db, request) {
  const fail = (message) => {
    const error = new Error(message);
    error.code = "CONFIGURED_EDIT_INVALID";
    throw error;
  };
  const parts = request.reason?.split("|") ?? [];
  const partner = parts[0] === "SHIFT_SWITCH" ? parts[1] : null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(partner ?? "") || !uuid.test(request.nurse_id ?? ""))
    fail("Shift switch participants cannot be verified");
  const { rows } = await db.query(
    `SELECT sa.*,sa.shift_date::text,n.facility FROM shift_assignments sa
     JOIN nurses n ON n.id=sa.nurse_id WHERE sa.nurse_id=ANY($1::uuid[])
     AND sa.shift_date BETWEEN $2::date AND $3::date`,
    [[request.nurse_id, partner], request.from_date, request.to_date],
  );
  const linked = (row) => !!(row?.shift_definition_run_id ?? row?.scheduling_run_id);
  if (!rows.some(linked)) return;
  const a = rows.find((row) => row.nurse_id === request.nurse_id);
  const b = rows.find((row) => row.nurse_id === partner);
  if (!a || !b || !linked(a) || !linked(b))
    fail("Both duties must use configured schedules for this switch");
  if (a === b || rows.length !== 2 || request.from_date !== request.to_date)
    fail("Configured switches require two different nurses on one date");
  const interWard = parts.includes("INTER_WARD");
  const leaveCover = parts.includes("LEAVE_COVER");
  if (!a.ward || !b.ward || a.facility !== b.facility)
    fail("Configured switches require ward duties in the same facility");
  if (a.ward !== b.ward && !interWard && !leaveCover)
    fail("Mark this as an inter-ward switch to exchange duties across wards");
  // Leave cover: Nurse A is on leave and B takes A's planned duty; otherwise neither is on leave.
  if ((a.shift === "LEAVE") !== leaveCover || b.shift === "LEAVE")
    fail(
      leaveCover
        ? "Leave cover requires Nurse A on approved leave and Nurse B not on leave"
        : "Use a leave-cover switch when Nurse A is on leave",
    );
  if (
    a.status !== "published" ||
    b.status !== "published" ||
    parts[3] !== (leaveCover ? a.pre_leave_shift : a.shift) ||
    parts[4] !== b.shift
  )
    fail("Switch request no longer matches the published duties. Reload before requesting");
}
module.exports = { guardLegacySwitchApproval, guardConfiguredSwitchRequest };
