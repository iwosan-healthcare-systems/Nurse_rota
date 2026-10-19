const { seedConfiguration } = require("./scheduling-configuration");
const { assignmentStaffingDefinition } = require("./assignment-staffing-definition");
const { configuredEditOptions } = require("./configured-assignment-edit");
const { zonedInstant, addDays, validDate } = require("./configured-scheduler");
const legacyDefinitions = seedConfiguration(
  { legacy_facility: "", timezone: "Africa/Lagos" },
  [],
).shifts;

// Read historical definitions from the immutable run, never today's draft or
// active policy. Missing provenance must not silently invent legacy timings.
function assignmentShiftDefinition(assignment, run = null) {
  const code = assignment.shift === "LEAVE" ? assignment.pre_leave_shift : assignment.shift;
  if (!code || code === "OFF" || code === "LEAVE")
    return { scheduled_shift: null, shift_definition_error: null };
  const definitionRunId = assignment.shift_definition_run_id ?? assignment.scheduling_run_id;
  const linked = !!definitionRunId;
  if (linked && (!run || run.id !== definitionRunId))
    return {
      scheduled_shift: null,
      shift_definition_error: "Saved shift definition is unavailable",
    };
  const definitions = linked ? run.configuration_snapshot?.shifts : legacyDefinitions;
  const definition = definitions?.find((s) => s.code === code);
  if (!definition)
    return {
      scheduled_shift: null,
      shift_definition_error: `No saved definition for shift ${code}`,
    };
  const timezone = linked ? run.configuration_snapshot.timezone : "Africa/Lagos";
  const date =
    assignment.shift_date instanceof Date
      ? assignment.shift_date.toISOString().slice(0, 10)
      : String(assignment.shift_date).slice(0, 10);
  if (!validDate(date))
    return { scheduled_shift: null, shift_definition_error: "Invalid assignment date" };
  try {
    return {
      scheduled_shift: {
        ...definition,
        timezone,
        startsAt: zonedInstant(date, definition.start, timezone),
        endsAt: zonedInstant(addDays(date, definition.endDayOffset), definition.end, timezone),
        source: linked ? "saved_run" : "legacy",
        runId: linked ? run.id : null,
      },
      shift_definition_error: null,
    };
  } catch (error) {
    return { scheduled_shift: null, shift_definition_error: error.message };
  }
}

async function withAssignmentShiftDefinitions(
  db,
  rows,
  { includeStaffing = false, includeEditOptions = false } = {},
) {
  if (!rows.length) return rows;
  const ids = [
    ...new Set(rows.map((a) => a.shift_definition_run_id ?? a.scheduling_run_id).filter(Boolean)),
  ];
  const runs = ids.length
    ? (
        await db.query(
          `SELECT id,configuration_snapshot${includeStaffing || includeEditOptions ? ",input_snapshot" : ""} FROM scheduling_runs WHERE id=ANY($1::uuid[])`,
          [ids],
        )
      ).rows
    : [];
  const byId = new Map(runs.map((r) => [r.id, r]));
  const cache = new Map();
  return rows.map((a) => {
    const key = JSON.stringify([
      a.shift_definition_run_id ?? a.scheduling_run_id ?? null,
      a.shift_date,
      a.shift,
      a.pre_leave_shift,
    ]);
    if (!cache.has(key))
      cache.set(
        key,
        assignmentShiftDefinition(a, byId.get(a.shift_definition_run_id ?? a.scheduling_run_id)),
      );
    return {
      ...a,
      ...cache.get(key),
      ...(includeEditOptions
        ? {
            configured_edit: configuredEditOptions(
              a,
              byId.get(a.shift_definition_run_id ?? a.scheduling_run_id),
            ),
          }
        : {}),
      ...(includeStaffing
        ? {
            scheduled_staffing: assignmentStaffingDefinition(
              a,
              byId.get(a.shift_definition_run_id ?? a.scheduling_run_id),
            ),
          }
        : {}),
    };
  });
}
module.exports = { assignmentShiftDefinition, withAssignmentShiftDefinitions };
