function assignmentStaffingDefinition(assignment, run) {
  const linked = assignment.shift_definition_run_id ?? assignment.scheduling_run_id;
  if (!linked) return null;
  const unavailable = { error: "Saved staffing requirements unavailable" };
  if (!run || run.id !== linked) return unavailable;
  const ward = run.input_snapshot?.wards?.find((w) => w.name === assignment.ward);
  if (!ward)
    return assignment.ward
      ? unavailable
      : { error: "Ward staffing assessment does not apply to this assignment" };
  const roleName =
    assignment.nurse_role ??
    run.input_snapshot?.nurses?.find((n) => n.id === assignment.nurse_id)?.role;
  const role = run.configuration_snapshot?.roles?.find((r) => r.name === roleName);
  if (!role || !Array.isArray(run.configuration_snapshot.requirements)) return unavailable;
  return {
    wardId: ward.id,
    category: role.category,
    requirements: run.configuration_snapshot.requirements.filter((r) => r.wardId === ward.id),
    error: null,
  };
}
module.exports = { assignmentStaffingDefinition };
