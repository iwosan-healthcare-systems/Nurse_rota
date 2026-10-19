const { assignmentShiftDefinition } = require("./assignment-shift-definition");

// Check the actual selected cells, not the original generated result snapshot.
// With selectedIds, unrelated conflicts between context cells do not block this batch.
function validateTransitionRest(rows, runs, selectedIds = null) {
  const nurses = new Map();
  for (const row of rows) {
    if (row.shift === "OFF" || row.shift === "LEAVE") continue;
    const runId = row.shift_definition_run_id ?? row.scheduling_run_id;
    const definition = assignmentShiftDefinition(row, runs.get(runId));
    const shift = definition.scheduled_shift;
    if (definition.shift_definition_error || !shift) {
      const error = new Error(`Assignment ${row.id}: rest cannot be verified`);
      error.code = "CONFIGURED_EDIT_INVALID";
      throw error;
    }
    const cells = nurses.get(row.nurse_id) ?? [];
    cells.push({ row, start: Date.parse(shift.startsAt), end: Date.parse(shift.endsAt) });
    nurses.set(row.nurse_id, cells);
  }
  for (const cells of nurses.values()) {
    cells.sort((a, b) => a.start - b.start);
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      for (let j = 0; j < i; j++) {
        const previous = cells[j];
        if (selectedIds && !selectedIds.has(cell.row.id) && !selectedIds.has(previous.row.id))
          continue;
        if (cell.start > previous.end) continue;
        const error = new Error(
          `Assignments ${previous.row.id} and ${cell.row.id} overlap or leave no rest`,
        );
        error.code = "CONFIGURED_EDIT_INVALID";
        throw error;
      }
    }
  }
}

async function validateTransitionRestContext(db, rows, runs) {
  const dates = rows.map((row) => row.shift_date).sort();
  // Definitions allow at most one overnight day. Four date labels also cover
  // assignments with different IANA timezones on either side of the boundary.
  const { rows: context } = await db.query(
    `SELECT *,shift_date::text FROM shift_assignments
     WHERE nurse_id=ANY($1::uuid[]) AND shift_date BETWEEN $2::date-4 AND $3::date+4
       AND NOT (id=ANY($4::uuid[])) AND shift NOT IN ('OFF','LEAVE')
     ORDER BY id FOR SHARE`,
    [
      [...new Set(rows.map((row) => row.nurse_id))],
      dates[0],
      dates.at(-1),
      rows.map((row) => row.id),
    ],
  );
  const missing = [
    ...new Set(
      context
        .map((row) => row.shift_definition_run_id ?? row.scheduling_run_id)
        .filter((id) => id && !runs.has(id)),
    ),
  ];
  const allRuns = new Map(runs);
  if (missing.length) {
    const { rows: saved } = await db.query(
      "SELECT id,configuration_snapshot FROM scheduling_runs WHERE id=ANY($1::uuid[])",
      [missing],
    );
    for (const run of saved) allRuns.set(run.id, run);
  }
  validateTransitionRest([...rows, ...context], allRuns, new Set(rows.map((row) => row.id)));
}

module.exports = { validateTransitionRest, validateTransitionRestContext };
