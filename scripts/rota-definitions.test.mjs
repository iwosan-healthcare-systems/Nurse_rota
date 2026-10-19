import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
const compiled = ts.transpileModule(
  readFileSync(new URL("../src/lib/assignment-shift-definition.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText;
const { scheduledHoursByNurse, assignmentDescription } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const definition = {
  name: "Late duty",
  start: "20:00",
  end: "04:00",
  endDayOffset: 1,
  timezone: "Africa/Lagos",
  creditedMinutes: 450,
};
test("Rota totals separate saved working and leave credits without changing legacy hours", () => {
  const result = scheduledHoursByNurse([
    { nurse_id: "n1", shift: "E", scheduled_shift: definition },
    { nurse_id: "n1", shift: "LEAVE", pre_leave_shift: "E", scheduled_shift: definition },
    { nurse_id: "n2", shift: "N" },
    { nurse_id: "n3", shift: "OFF" },
  ]);
  assert.deepEqual(result.get("n1"), { worked: 7.5, leave: 7.5, unavailable: false });
  assert.equal(result.get("n2").worked, 15);
  assert.equal(result.get("n3").worked, 0);
});
test("unresolved cells mark the whole nurse total unavailable", () => {
  assert.equal(
    scheduledHoursByNurse([
      { nurse_id: "n1", shift: "M" },
      { nurse_id: "n1", shift: "E", shift_definition_error: "Missing" },
    ]).get("n1").unavailable,
    true,
  );
  assert.equal(
    assignmentDescription({ shift: "E", shift_definition_error: "Missing" }),
    "Saved shift definition unavailable",
  );
});
test("Rota descriptions retain overnight timezone and credit without relabeling leave", () => {
  assert.match(
    assignmentDescription({ shift: "E", scheduled_shift: definition }),
    /Late duty.*\(\+1 day\).*Africa\/Lagos.*7.5h credit/,
  );
  assert.equal(assignmentDescription({ shift: "LEAVE", scheduled_shift: definition }), "LEAVE");
});
