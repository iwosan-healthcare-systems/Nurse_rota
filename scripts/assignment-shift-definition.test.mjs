import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";
const require = createRequire(import.meta.url);
const {
  assignmentShiftDefinition,
  withAssignmentShiftDefinitions,
} = require("../nurse-api/lib/assignment-shift-definition");
const compiled = ts.transpileModule(
  readFileSync(new URL("../src/lib/assignment-shift-definition.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.ESNext } },
).outputText;
const { assignmentScheduledHours, assignmentTimeLabel } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const shift = {
  code: "EV",
  name: "Evening",
  start: "20:00",
  end: "04:30",
  endDayOffset: 1,
  breakMinutes: 30,
  creditedMinutes: 480,
  color: "#123456",
};
const run = { id: "run1", configuration_snapshot: { timezone: "Africa/Lagos", shifts: [shift] } };
const cell = { nurse_id: "n1", shift: "EV", shift_date: "2044-01-04", scheduling_run_id: "run1" };
test("immutable run defines custom overnight times, breaks and credited hours", () => {
  const resolved = assignmentShiftDefinition(cell, run);
  assert.equal(resolved.shift_definition_error, null);
  assert.equal(resolved.scheduled_shift.startsAt, "2044-01-04T19:00:00.000Z");
  assert.equal(resolved.scheduled_shift.endsAt, "2044-01-05T03:30:00.000Z");
  assert.equal(resolved.scheduled_shift.breakMinutes, 30);
  assert.equal(assignmentScheduledHours({ ...cell, ...resolved }), 8);
  assert.match(
    assignmentTimeLabel(resolved.scheduled_shift),
    /20:00.*04:30.*\+1 day.*Africa\/Lagos/,
  );
});
test("approved leave retains the planned shift credit while OFF stays zero", () => {
  const leave = { ...cell, shift: "LEAVE", pre_leave_shift: "EV" };
  assert.equal(assignmentScheduledHours({ ...leave, ...assignmentShiftDefinition(leave, run) }), 8);
  const off = { ...cell, shift: "OFF" };
  assert.equal(assignmentScheduledHours({ ...off, ...assignmentShiftDefinition(off, run) }), 0);
});
test("missing or mismatched saved definitions do not silently use legacy hours", () => {
  for (const source of [
    null,
    { ...run, id: "wrong" },
    { ...run, configuration_snapshot: { ...run.configuration_snapshot, shifts: [] } },
  ]) {
    const resolved = assignmentShiftDefinition(cell, source);
    assert.ok(resolved.shift_definition_error);
    assert.equal(assignmentScheduledHours({ ...cell, ...resolved }), null);
  }
});
test("legacy assignments preserve Lagos times and nine/fifteen-hour credits", () => {
  for (const [code, hours] of [
    ["M", 9],
    ["MWC", 9],
    ["N", 15],
    ["NC", 15],
  ]) {
    const old = { ...cell, shift: code, scheduling_run_id: null };
    const resolved = assignmentShiftDefinition(old);
    assert.equal(assignmentScheduledHours({ ...old, ...resolved }), hours);
    assert.equal(resolved.scheduled_shift.timezone, "Africa/Lagos");
    assert.equal(assignmentScheduledHours(old), hours);
  }
  assert.equal(assignmentScheduledHours({ shift: "UNKNOWN" }), null);
});
test("DST ambiguity is an explicit metadata error rather than an invented window", () => {
  const resolved = assignmentShiftDefinition(
    { ...cell, shift_date: "2026-11-01" },
    {
      ...run,
      configuration_snapshot: {
        timezone: "America/New_York",
        shifts: [{ ...shift, start: "01:30" }],
      },
    },
  );
  assert.match(resolved.shift_definition_error, /ambiguous/);
});
test("assignment enrichment batches unique runs and exposes no raw configuration", async () => {
  let queries = 0;
  const rows = await withAssignmentShiftDefinitions(
    {
      query: async (sql, params) => {
        queries++;
        assert.deepEqual(params, [["run1"]]);
        return { rows: [run] };
      },
    },
    [cell, { ...cell, nurse_id: "n2" }],
  );
  assert.equal(queries, 1);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].scheduled_shift.name, "Evening");
  assert.equal(rows[0].configuration_snapshot, undefined);
  assert.equal(cell.scheduled_shift, undefined);
});
