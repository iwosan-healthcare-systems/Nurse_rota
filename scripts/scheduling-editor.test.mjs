import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";
const require = createRequire(import.meta.url);
const {
  seedConfiguration,
  validateConfiguration,
} = require("../nurse-api/lib/scheduling-configuration");
const compiled = ts.transpileModule(
  readFileSync(new URL("../src/lib/scheduling-configuration.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.ESNext } },
).outputText;
const { renameShift, shiftIsUsed, patternIsUsed, patternPreview, setRequirement } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const wards = [
  {
    id: "10000000-0000-4000-8000-000000000001",
    name: "Test",
    min_morning_nurses: 2,
    min_morning_na: 1,
    min_night_nurses: 2,
    min_night_na: 1,
  },
];
const fixture = () =>
  seedConfiguration({ legacy_facility: "Test", timezone: "Africa/Lagos" }, wards);
test("renaming a shift updates all draft references without modifying the source", () => {
  const original = fixture();
  original.coverageRules = [
    {
      id: "cover",
      name: "Cover",
      shift: "M",
      roleIds: [],
      anchorDate: "2026-09-26",
      blockDays: 2,
      repeatDays: 7,
      staffPerBlock: 1,
      restBefore: 1,
      restAfter: 1,
    },
  ];
  const coverageRole = original.roles.find((r) => r.name === "Coverage Nurse");
  coverageRole.specialRule = "none";
  original.coverageRules[0].roleIds = [coverageRole.id];
  const changed = renameShift(original, "M", "AM");
  assert.equal(original.shifts[0].code, "M");
  assert.equal(original.coverageRules[0].shift, "M");
  assert.equal(changed.coverageRules[0].shift, "AM");
  assert.ok(changed.patterns[0].steps.some((s) => s.shift === "AM"));
  assert.ok(changed.roles[0].allowedShifts.includes("AM"));
  assert.ok(changed.requirements.some((r) => r.shift === "AM"));
  assert.equal(validateConfiguration(changed, wards).valid, true);
  assert.equal(shiftIsUsed(changed, "AM"), true);
  assert.equal(shiftIsUsed(changed, "UNUSED"), false);
  assert.equal(patternIsUsed(changed, "standard"), true);
});
test("pattern illustration supports irregular cycles and empty/invalid step counts", () => {
  const p = {
    id: "p",
    name: "p",
    kind: "repeating",
    steps: [
      { shift: "M", days: 2 },
      { shift: "N", days: 2 },
      { shift: "OFF", days: 3 },
    ],
  };
  assert.deepEqual(patternPreview(p, 9), ["M", "M", "N", "N", "OFF", "OFF", "OFF", "M", "M"]);
  assert.deepEqual(patternPreview({ ...p, steps: [{ shift: "M", days: -1 }] }), []);
  assert.equal(patternPreview(fixture().patterns[2]).length, 28);
});
test("copy requirement to all days replaces only the selected ward/shift/category", () => {
  const config = fixture();
  const row = { ...config.requirements[0], minimum: 5, maximum: 5 };
  const changed = setRequirement(config, row, true);
  assert.equal(changed.requirements.length, config.requirements.length);
  assert.equal(
    changed.requirements.filter(
      (r) => r.shift === row.shift && r.category === row.category && r.minimum === 5,
    ).length,
    7,
  );
  assert.deepEqual(
    changed.requirements.filter((r) => r.shift !== row.shift || r.category !== row.category),
    config.requirements.filter((r) => r.shift !== row.shift || r.category !== row.category),
  );
  assert.equal(validateConfiguration(changed, wards).valid, true);
});
