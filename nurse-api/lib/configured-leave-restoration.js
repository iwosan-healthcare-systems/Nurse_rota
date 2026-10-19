const { configuredEditOptions } = require("./configured-assignment-edit");
const { validateTransitionRestContext } = require("./configured-transition-rest");
const { validateTransitionStaffingContext } = require("./configured-transition-staffing");

// Caller must keep restored rows locked in the leave-reversal transaction.
async function validateConfiguredLeaveRestoration(db, rows) {
  const configured = rows.filter((row) => row.shift_definition_run_id ?? row.scheduling_run_id);
  if (!configured.length) return;
  const ids = [
    ...new Set(configured.map((row) => row.shift_definition_run_id ?? row.scheduling_run_id)),
  ];
  const { rows: saved } = await db.query(
    "SELECT id,facility_id,configuration_snapshot,input_snapshot FROM scheduling_runs WHERE id=ANY($1::uuid[])",
    [ids],
  );
  const runs = new Map(saved.map((run) => [run.id, run]));
  for (const row of configured) {
    const options = configuredEditOptions(
      row,
      runs.get(row.shift_definition_run_id ?? row.scheduling_run_id),
    );
    if (options.error || !options.shifts.some((shift) => shift.code === row.shift)) {
      const error = new Error(
        `Assignment ${row.id}: restored duty is not allowed by its saved role`,
      );
      error.code = "CONFIGURED_EDIT_INVALID";
      throw error;
    }
  }
  await validateTransitionRestContext(db, configured, runs);
  for (const status of ["submitted", "cno_approved", "published"]) {
    const restored = configured.filter((row) => row.status === status);
    if (restored.length) await validateTransitionStaffingContext(db, restored, runs, { status });
  }
}
module.exports = { validateConfiguredLeaveRestoration };
