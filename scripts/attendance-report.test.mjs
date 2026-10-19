import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
const compiled = ts.transpileModule(
  readFileSync(new URL("../src/lib/attendance-report.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText;
const {
  attendanceShiftLabel,
  attendanceShiftKey,
  attendanceShiftOptions,
  attendanceDefinitionColumns,
} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const saved = {
  shift_type: "M",
  scheduling_definition: {
    code: "MWC",
    name: "Weekend early duty",
    startsAt: "2044-01-02T07:00:00Z",
    endsAt: "2044-01-02T16:00:00Z",
    timezone: "Africa/Lagos",
    breakMinutes: 90,
    creditedMinutes: 450,
  },
};
test("attendance reports preserve saved names and fractional credit in export data", () => {
  assert.equal(attendanceShiftLabel(saved), "Weekend early duty");
  const columns = attendanceDefinitionColumns(saved);
  assert.equal(columns["Shift Code"], "MWC");
  assert.equal(columns["Scheduled Credit Hours"], 7.5);
  assert.equal(columns["Scheduled End (UTC)"], saved.scheduling_definition.endsAt);
  assert.equal(columns["Break Minutes"], 90);
});
test("legacy and unknown codes retain their identity without inventing historical timing", () => {
  assert.equal(attendanceShiftLabel({ shift_type: "M" }), "Morning");
  assert.equal(attendanceShiftLabel({ shift_type: "E" }), "E");
  assert.equal(attendanceDefinitionColumns({ shift_type: "N" })["Scheduled Credit Hours"], "");
});
test("report filters distinguish renamed duties and normalized coverage codes", () => {
  const renamed = {
    ...saved,
    scheduling_definition: { ...saved.scheduling_definition, name: "New weekend duty" },
  };
  assert.notEqual(attendanceShiftKey(saved), attendanceShiftKey(renamed));
  assert.notEqual(attendanceShiftKey(saved), attendanceShiftKey({ shift_type: "M" }));
  const options = attendanceShiftOptions([saved, saved, renamed, { shift_type: "M" }]);
  assert.equal(options.length, 3);
  assert.ok(options.some((option) => option.label === "Weekend early duty (MWC)"));
});
