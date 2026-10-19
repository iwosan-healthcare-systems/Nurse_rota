import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { validateWardStaffing } = require("../nurse-api/lib/configured-transition-staffing");
const { staffingDates } = require("../nurse-api/lib/configured-transition-staffing");
test("staffing assessment dates include every day across month and leap boundaries", () => {
  assert.deepEqual(staffingDates({ start: "2028-02-28", end: "2028-03-01" }), [
    "2028-02-28",
    "2028-02-29",
    "2028-03-01",
  ]);
  assert.equal(staffingDates(), null);
  for (const window of [
    { start: "2026-02-30", end: "2026-03-01" },
    { start: "2026-03-02", end: "2026-03-01" },
    { start: "2026-01-01", end: "2028-01-01" },
  ])
    assert.throws(() => staffingDates(window), { code: "CONFIGURED_EDIT_INVALID" });
});
const run = {
  id: "r",
  input_snapshot: { wards: [{ id: "w", name: "Ward" }] },
  configuration_snapshot: {
    roles: [{ name: "Nurse", category: "RN" }],
    requirements: [{ wardId: "w", weekday: 3, shift: "M", category: "RN", minimum: 1, maximum: 1 }],
  },
};
const runs = new Map([["r", run]]);
const cell = (nurse, shift = "M", status = "published") => ({
  id: nurse,
  nurse_id: nurse,
  nurse_role: "Nurse",
  ward: "Ward",
  shift_date: "2026-10-07",
  shift,
  status,
  shift_definition_run_id: "r",
});
test("staffing counts unique nurses at the requested stage or later", () => {
  validateWardStaffing([cell("a"), cell("a"), cell("b", "M", "draft")], runs, "published");
  assert.throws(() => validateWardStaffing([cell("a", "M", "draft")], runs, "submitted"), /has 0/);
  assert.throws(() => validateWardStaffing([cell("a"), cell("b")], runs, "published"), /has 2/);
});
test("leave and OFF cannot satisfy saved minima", () => {
  assert.throws(
    () => validateWardStaffing([cell("a", "OFF"), cell("b", "LEAVE")], runs, "submitted"),
    /has 0/,
  );
});
test("missing, mixed and conflicting saved requirements fail closed", () => {
  assert.throws(() => validateWardStaffing([cell("a")], new Map(), "published"), /missing saved/);
  assert.throws(
    () =>
      validateWardStaffing(
        [cell("a"), { ...cell("b"), shift_definition_run_id: null }],
        runs,
        "published",
      ),
    /mixed legacy/,
  );
  const other = structuredClone(run);
  other.id = "r2";
  other.configuration_snapshot.requirements[0].minimum = 0;
  assert.throws(
    () =>
      validateWardStaffing(
        [cell("a"), { ...cell("b"), shift_definition_run_id: "r2" }],
        new Map([...runs, ["r2", other]]),
        "published",
      ),
    /conflicting/,
  );
});
