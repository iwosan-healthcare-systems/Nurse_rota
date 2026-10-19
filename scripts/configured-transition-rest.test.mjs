import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { validateTransitionRest } = require("../nurse-api/lib/configured-transition-rest");
const run = {
  id: "run",
  configuration_snapshot: {
    timezone: "Africa/Lagos",
    shifts: [
      { code: "M", start: "08:00", end: "17:00", endDayOffset: 0 },
      { code: "N", start: "17:00", end: "08:00", endDayOffset: 1 },
    ],
  },
};
const runs = new Map([[run.id, run]]);
const cell = (id, date, shift, nurse = "n1") => ({
  id,
  shift_date: date,
  shift,
  nurse_id: nurse,
  shift_definition_run_id: run.id,
});
test("context conflicts only block when they involve a selected cell", () => {
  const rows = [
    cell("a", "2026-10-07", "N"),
    cell("b", "2026-10-08", "M"),
    cell("c", "2026-10-10", "M"),
  ];
  validateTransitionRest(rows, runs, new Set(["c"]));
  assert.throws(() => validateTransitionRest(rows, runs, new Set(["b"])), {
    code: "CONFIGURED_EDIT_INVALID",
  });
});
test("transition rest rejects touching overnight shifts regardless of row order", () => {
  assert.throws(
    () =>
      validateTransitionRest([cell("b", "2026-10-08", "M"), cell("a", "2026-10-07", "N")], runs),
    { code: "CONFIGURED_EDIT_INVALID" },
  );
});
test("transition rest allows positive gaps and independent nurses", () => {
  validateTransitionRest(
    [
      cell("b", "2026-10-08", "N"),
      cell("a", "2026-10-07", "N"),
      cell("c", "2026-10-08", "M", "n2"),
    ],
    runs,
  );
});
test("OFF and leave do not count as worked shifts; missing definitions block", () => {
  validateTransitionRest(
    [
      cell("a", "2026-10-07", "N"),
      { ...cell("b", "2026-10-08", "LEAVE"), pre_leave_shift: "M" },
      cell("c", "2026-10-08", "OFF"),
    ],
    runs,
  );
  assert.throws(() => validateTransitionRest([cell("a", "2026-10-07", "N")], new Map()), {
    code: "CONFIGURED_EDIT_INVALID",
  });
});
