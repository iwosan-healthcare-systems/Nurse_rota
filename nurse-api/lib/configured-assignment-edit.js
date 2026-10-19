function configuredEditOptions(assignment, run) {
  const id = assignment.shift_definition_run_id ?? assignment.scheduling_run_id;
  if (!id) return null;
  const unavailable = { shifts: [], error: "Saved role shift choices are unavailable" };
  if (!run || run.id !== id) return unavailable;
  const name =
    assignment.nurse_role ??
    run.input_snapshot?.nurses?.find((n) => n.id === assignment.nurse_id)?.role;
  const role = run.configuration_snapshot?.roles?.find((r) => r.name === name);
  if (!role) return unavailable;
  const shifts = role.allowedShifts.map((code) =>
    run.configuration_snapshot.shifts.find((s) => s.code === code),
  );
  if (shifts.some((s) => !s)) return unavailable;
  return {
    shifts: [
      ...shifts.map((s) => ({ code: s.code, name: s.name })),
      { code: "OFF", name: "Off duty" },
    ],
    error: null,
  };
}
function validateConfiguredEditState(assignment, body) {
  if (!(assignment.shift_definition_run_id ?? assignment.scheduling_run_id)) return;
  const fail = (message) => {
    const error = new Error(message);
    error.code = "CONFIGURED_EDIT_INVALID";
    throw error;
  };
  const editing = ["shift", "ward", "shift_date"].some((key) => Object.hasOwn(body, key));
  if (editing && assignment.status !== "draft")
    fail("Return this configured assignment to draft before editing its duty");
  if (
    (Object.hasOwn(body, "ward") && body.ward !== assignment.ward) ||
    (Object.hasOwn(body, "shift_date") && body.shift_date !== assignment.shift_date)
  )
    fail("Configured date or ward reassignment requires a new reviewed schedule");
}
async function validateConfiguredEdit(db, assignment, body) {
  validateConfiguredEditState(assignment, body);
  const id = assignment.shift_definition_run_id ?? assignment.scheduling_run_id;
  const forward = ["submitted", "cno_approved", "published"].includes(body.status);
  if (!id || (body.shift === undefined && !forward)) return;
  const code =
    body.shift ?? (assignment.shift === "LEAVE" ? assignment.pre_leave_shift : assignment.shift);
  const {
    rows: [run],
  } = await db.query(
    "SELECT id,configuration_snapshot,input_snapshot FROM scheduling_runs WHERE id=$1",
    [id],
  );
  const options = configuredEditOptions(assignment, run);
  if (options.error || !options.shifts.some((s) => s.code === code)) {
    const error = new Error(
      options.error ?? "Shift is not allowed by this assignment's saved role",
    );
    error.code = "CONFIGURED_EDIT_INVALID";
    throw error;
  }
}
module.exports = { configuredEditOptions, validateConfiguredEdit, validateConfiguredEditState };
