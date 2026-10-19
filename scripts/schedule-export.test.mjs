import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
const compiled = ts.transpileModule(
  readFileSync(new URL("../src/lib/schedule-export.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText;
const { scheduleExportDefinitions } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const shift = {
  code: "E",
  name: "Evening <duty>",
  start: "20:00",
  end: "04:00",
  endDayOffset: 1,
  timezone: "Africa/Lagos",
  creditedMinutes: 450,
  breakMinutes: 30,
  color: "#123456",
};
const cell = { nurse_id: "n1", shift_date: "2044-01-04", shift: "E", scheduled_shift: shift };
test("schedule exports retain overnight timing, fractional credits and escaped labels", () => {
  const result = scheduleExportDefinitions([cell]);
  assert.equal(result.cells.get("n1|2044-01-04"), "E");
  assert.equal(result.rows[0]["Credit Hours"], 7.5);
  assert.equal(result.rows[0].End, "04:00 (+1 day)");
  assert.match(result.html, /Evening &lt;duty&gt;/);
  assert.equal(result.colors.get("E"), "#123456");
});
test("multiple historical definitions for one code have distinct cell references", () => {
  const result = scheduleExportDefinitions([
    cell,
    { ...cell, shift_date: "2044-01-05", scheduled_shift: { ...shift, name: "Later duty" } },
  ]);
  assert.equal(result.rows.length, 2);
  assert.notEqual(result.cells.get("n1|2044-01-04"), result.cells.get("n1|2044-01-05"));
  assert.deepEqual(
    result.rows.map((r) => r.Code),
    ["E [1]", "E [2]"],
  );
});
test("missing definitions stay visible and OFF/LEAVE do not inherit working timing", () => {
  const result = scheduleExportDefinitions([
    { ...cell, scheduled_shift: null, shift_definition_error: "Missing" },
    { ...cell, shift: "LEAVE" },
    { ...cell, shift: "OFF" },
  ]);
  assert.equal(result.rows[0].Name, "Definition unavailable");
  assert.equal(result.rows[1].Start, "");
  assert.equal(result.rows[2]["Credit Hours"], "");
  assert.ok(
    !scheduleExportDefinitions([
      { ...cell, scheduled_shift: { ...shift, color: "red;bad" } },
    ]).html.includes("red;bad"),
  );
});
