const { validateTransitionStaffingContext } = require("./configured-transition-staffing");

// Leave approval may represent an unavoidable absence. Report staffing failures
// without treating the nurse as available or silently rejecting their leave.
async function assessConfiguredLeaveStaffing(db, rows) {
  const configured = rows.filter((row) => row.shift_definition_run_id ?? row.scheduling_run_id);
  if (!configured.length) return [];
  const ids = [
    ...new Set(configured.map((row) => row.shift_definition_run_id ?? row.scheduling_run_id)),
  ];
  const { rows: saved } = await db.query(
    "SELECT id,facility_id,configuration_snapshot,input_snapshot FROM scheduling_runs WHERE id=ANY($1::uuid[])",
    [ids],
  );
  const runs = new Map(saved.map((run) => [run.id, run]));
  const warnings = [];
  for (const row of configured.filter((cell) => cell.ward !== null && cell.status !== "draft")) {
    try {
      await validateTransitionStaffingContext(db, [row], runs, { status: row.status });
    } catch (error) {
      if (error.code !== "CONFIGURED_EDIT_INVALID") throw error;
      if (!warnings.includes(error.message)) warnings.push(error.message);
    }
  }
  return warnings;
}
module.exports = { assessConfiguredLeaveStaffing };
