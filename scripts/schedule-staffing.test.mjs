import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
const require = createRequire(import.meta.url);
const { assignmentStaffingDefinition } = require("../nurse-api/lib/assignment-staffing-definition");
const compiled = ts.transpileModule(
  readFileSync(new URL("../src/lib/schedule-staffing.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText;
const { assessScheduleStaffing } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const requirement = {
  wardId: "w1",
  shift: "E",
  category: "nurse",
  weekday: 1,
  minimum: 2,
  maximum: 3,
};
const cell = {
  nurse_id: "n1",
  shift_date: "2044-01-04",
  shift: "E",
  shift_definition_run_id: "r1",
  scheduled_staffing: { wardId: "w1", category: "nurse", requirements: [requirement], error: null },
};
test("saved minima assess actual assignments and exclude leave and duplicate nurses", () => {
  const result = assessScheduleStaffing(
    [cell, cell, { ...cell, nurse_id: "n2", shift: "LEAVE" }],
    ["2044-01-04"],
  );
  assert.equal(result.rows[0].Actual, 1);
  assert.equal(result.rows[0].Status, "Shortfall");
  assert.equal(
    assessScheduleStaffing([cell, { ...cell, nurse_id: "n2" }], ["2044-01-04"]).rows[0].Status,
    "Met",
  );
  assert.equal(
    assessScheduleStaffing(
      [0, 1, 2, 3].map((i) => ({ ...cell, nurse_id: String(i) })),
      ["2044-01-04"],
    ).rows[0].Status,
    "Excess",
  );
});
test("mixed provenance, missing dates and conflicting requirements do not report compliance", () => {
  for (const [cells, dates] of [
    [[cell, { nurse_id: "n2", shift: "E", shift_date: cell.shift_date }], [cell.shift_date]],
    [[cell], [cell.shift_date, "2044-01-05"]],
    [
      [
        cell,
        {
          ...cell,
          nurse_id: "n2",
          scheduled_staffing: {
            ...cell.scheduled_staffing,
            requirements: [{ ...requirement, minimum: 4 }],
          },
        },
      ],
      [cell.shift_date],
    ],
  ])
    assert.match(assessScheduleStaffing(cells, dates).html, /unavailable/);
  assert.equal(assessScheduleStaffing([{ shift: "M" }], []), null);
});
test("staffing metadata exposes only the saved ward requirements and role category", () => {
  const run = {
    id: "r1",
    input_snapshot: {
      wards: [{ id: "w1", name: "ER" }],
      nurses: [{ id: "n1", role: "Former role" }],
    },
    configuration_snapshot: {
      roles: [{ name: "Saved role", category: "nurse" }],
      requirements: [requirement, { ...requirement, wardId: "other" }],
    },
  };
  const result = assignmentStaffingDefinition(
    { ...cell, ward: "ER", nurse_role: "Saved role" },
    run,
  );
  assert.deepEqual(result.requirements, [requirement]);
  assert.equal(result.category, "nurse");
  assert.ok(assignmentStaffingDefinition({ ...cell, ward: "Unknown" }, run).error);
  assert.ok(assignmentStaffingDefinition(cell, null).error);
});
