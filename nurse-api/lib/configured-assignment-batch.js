const {
  configuredEditOptions,
  validateConfiguredEditState,
} = require("./configured-assignment-edit");
const { assignmentShiftDefinition } = require("./assignment-shift-definition");
const { validateTransitionRestContext } = require("./configured-transition-rest");
const invalid = (message) => {
  const error = new Error(message);
  error.code = "CONFIGURED_EDIT_INVALID";
  throw error;
};

async function applyValidatedAssignmentBatch(
  pool,
  { where, filterParams, updateSql, updateParams, body, authorize, after },
) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const { rows } = await db.query(
      `SELECT *,shift_date::text FROM shift_assignments ${where} ORDER BY id FOR UPDATE`,
      filterParams,
    );
    const configured = rows.filter((r) => r.shift_definition_run_id ?? r.scheduling_run_id);
    for (const row of configured) validateConfiguredEditState(row, body);
    if ((body.shift || body.ward) && configured.length && !(await authorize(configured))) {
      const error = new Error("No active edit-access grant for these configured assignments");
      error.code = "CONFIGURED_EDIT_INVALID";
      error.status = 403;
      throw error;
    }
    const forward = ["submitted", "cno_approved", "published"].includes(body.status);
    if (configured.length && (body.shift || body.ward || forward)) {
      const ids = [
        ...new Set(configured.map((r) => r.shift_definition_run_id ?? r.scheduling_run_id)),
      ];
      const { rows: runs } = await db.query(
        "SELECT id,facility_id,configuration_snapshot,input_snapshot FROM scheduling_runs WHERE id=ANY($1::uuid[])",
        [ids],
      );
      const byId = new Map(runs.map((r) => [r.id, r]));
      for (const row of configured) {
        if (body.ward && body.ward !== row.ward)
          invalid("Configured ward reassignment requires a new reviewed schedule");
        const run = byId.get(row.shift_definition_run_id ?? row.scheduling_run_id);
        const options = configuredEditOptions(row, run);
        const code = body.shift ?? (row.shift === "LEAVE" ? row.pre_leave_shift : row.shift);
        if (options.error || !options.shifts.some((s) => s.code === code))
          invalid(`Assignment ${row.id}: saved role does not allow this shift`);
        const resolved = assignmentShiftDefinition({ ...row, shift: body.shift ?? row.shift }, run);
        if (resolved.shift_definition_error)
          invalid(`Assignment ${row.id}: ${resolved.shift_definition_error}`);
      }
      if (forward) {
        await validateTransitionRestContext(
          db,
          rows.map((row) => ({ ...row, shift: body.shift ?? row.shift })),
          byId,
        );
      }
    }
    // Restrict writes to the rows locked above; concurrently inserted matching
    // cells must not bypass validation in this request.
    const result = await db.query(`${updateSql} AND id=ANY($${updateParams.length + 1}::uuid[])`, [
      ...updateParams,
      rows.map((r) => r.id),
    ]);
    // Ward staffing shortfalls do not block submission, approval or publication;
    // they are shown in Approvals and schedule printouts instead.
    if (after) await after(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
module.exports = { applyValidatedAssignmentBatch };
