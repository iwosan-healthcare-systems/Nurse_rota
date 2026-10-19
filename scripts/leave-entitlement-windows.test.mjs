import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { requestWindows } = require("../nurse-api/lib/leave-entitlement-windows");
test("yearly request windows split on April 1", () => {
  assert.deepEqual(requestWindows("year", "2027-03-31", "2027-04-01"), [
    { start: "2026-04-01", end: "2027-03-31", year: 2026, month: null },
    { start: "2027-04-01", end: "2028-03-31", year: 2027, month: null },
  ]);
});
test("monthly windows handle leap February and year rollover", () => {
  assert.equal(requestWindows("month", "2028-02-01", "2028-02-29")[0].end, "2028-02-29");
  assert.deepEqual(
    requestWindows("month", "2026-12-31", "2027-01-01").map((w) => [w.year, w.month]),
    [
      [2026, 12],
      [2027, 1],
    ],
  );
});
test("invalid or reversed request dates reject", () => {
  assert.throws(() => requestWindows("year", "2026-02-30", "2026-03-01"));
  assert.throws(() => requestWindows("month", "2026-03-02", "2026-03-01"));
});
