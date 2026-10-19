const { assignmentStaffingDefinition } = require("./assignment-staffing-definition");
const { validDate, addDays } = require("./configured-scheduler");
const rank = { draft: 0, submitted: 1, cno_approved: 2, published: 3 };
const linkedId = (row) => row.shift_definition_run_id ?? row.scheduling_run_id;
function invalid(message) {
  const error = new Error(message);
  error.code = "CONFIGURED_EDIT_INVALID";
  throw error;
}
const signature = (rules) =>
  JSON.stringify(
    rules
      .map((r) => [r.wardId, r.weekday, r.shift, r.category, r.minimum, r.maximum])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );

function validateWardStaffing(rows, runs, targetStatus) {
  const definitions = rows.map((row) => ({
    row,
    definition: assignmentStaffingDefinition(row, runs.get(linkedId(row))),
  }));
  if (!definitions.length || definitions.some(({ definition }) => !definition || definition.error))
    invalid("Ward staffing cannot be verified: missing saved definitions or mixed legacy cells");
  const requirements = definitions[0].definition.requirements;
  if (
    definitions.some(
      ({ definition }) => signature(definition.requirements) !== signature(requirements),
    )
  )
    invalid("Ward staffing cannot be verified: conflicting saved requirements");
  const date = rows[0].shift_date;
  const weekday = ((new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7) + 1;
  for (const requirement of requirements.filter((r) => r.weekday === weekday)) {
    const actual = new Set(
      definitions
        .filter(
          ({ row, definition }) =>
            row.shift !== "OFF" &&
            row.shift !== "LEAVE" &&
            rank[row.status] >= rank[targetStatus] &&
            row.shift === requirement.shift &&
            definition.category === requirement.category &&
            definition.wardId === requirement.wardId,
        )
        .map(({ row }) => row.nurse_id),
    ).size;
    if (
      actual < requirement.minimum ||
      (requirement.maximum !== null && actual > requirement.maximum)
    )
      invalid(
        `Ward staffing on ${date}: ${requirement.shift} ${requirement.category} has ${actual}, requires ${requirement.minimum}${requirement.maximum === null ? "+" : `–${requirement.maximum}`}`,
      );
  }
}

function staffingDates(window) {
  if (!window) return null;
  if (!validDate(window.start) || !validDate(window.end) || window.end < window.start)
    invalid("Invalid staffing assessment period");
  const dates = [];
  for (let date = window.start; date <= window.end; date = addDays(date, 1)) {
    if (dates.length >= 366) invalid("Staffing assessment period exceeds 366 days");
    dates.push(date);
  }
  return dates;
}

async function validateTransitionStaffingContext(db, selected, runs, body, window) {
  const dates = staffingDates(window);
  const groups = new Map();
  for (const row of selected.filter((r) => linkedId(r) && r.ward !== null)) {
    const run = runs.get(linkedId(row));
    if (!run?.facility_id) invalid("Saved staffing facility is unavailable");
    if (dates && !dates.includes(row.shift_date))
      invalid("Assignment is outside the staffing assessment period");
    for (const date of dates ?? [row.shift_date])
      groups.set(JSON.stringify([run.facility_id, row.ward, date]), {
        facilityId: run.facility_id,
        ward: row.ward,
        date,
      });
  }
  const projected = new Map(
    selected.map((row) => [
      row.id,
      {
        ...row,
        shift: body.shift ?? row.shift,
        status: body.status,
      },
    ]),
  );
  for (const group of groups.values()) {
    const { rows } = await db.query(
      `SELECT sa.*,sa.shift_date::text FROM shift_assignments sa
       JOIN nurses n ON n.id=sa.nurse_id
       JOIN scheduling_facilities f ON f.legacy_facility=n.facility
       WHERE f.id=$1 AND sa.ward=$2 AND sa.shift_date=$3::date
       ORDER BY sa.id FOR SHARE OF sa`,
      [group.facilityId, group.ward, group.date],
    );
    if (!rows.length)
      invalid(
        `Ward staffing cannot be verified: ${group.ward} has no assignments on ${group.date}`,
      );
    if (
      selected.some(
        (row) =>
          row.ward === group.ward &&
          row.shift_date === group.date &&
          runs.get(linkedId(row))?.facility_id === group.facilityId &&
          !rows.some((cell) => cell.id === row.id),
      )
    )
      invalid("Ward staffing cannot be verified: assignment facility has changed");
    const missing = [...new Set(rows.map(linkedId).filter((id) => id && !runs.has(id)))];
    if (missing.length) {
      const { rows: saved } = await db.query(
        "SELECT id,facility_id,configuration_snapshot,input_snapshot FROM scheduling_runs WHERE id=ANY($1::uuid[])",
        [missing],
      );
      for (const run of saved) runs.set(run.id, run);
    }
    if (
      rows.some((row) => linkedId(row) && runs.get(linkedId(row))?.facility_id !== group.facilityId)
    )
      invalid("Ward staffing cannot be verified: saved facility mismatch");
    validateWardStaffing(
      rows.map((row) => projected.get(row.id) ?? row),
      runs,
      body.status,
    );
  }
}
module.exports = { validateWardStaffing, validateTransitionStaffingContext, staffingDates };
