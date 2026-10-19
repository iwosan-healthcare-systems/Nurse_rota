import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { periodShiftReadiness } = require("../nurse-api/lib/period-shift-readiness");
const cell = { id: "a1", shift: "E", shift_date: "2044-01-31", shift_definition_run_id: "r1" };
const run = {
  id: "r1",
  configuration_snapshot: {
    timezone: "America/New_York",
    shifts: [
      {
        code: "E",
        name: "Extended night",
        start: "22:00",
        end: "12:00",
        endDayOffset: 1,
        breakMinutes: 0,
        creditedMinutes: 840,
      },
    ],
  },
};
const db = (rows = [cell], runs = [run]) => ({
  query: async (sql) => ({ rows: sql.includes("FROM scheduling_runs") ? runs : rows }),
});

test("archive waits past legacy night end for the saved end in its timezone", async () => {
  assert.equal(
    (await periodShiftReadiness(db(), "2044-01-04", "2044-01-31", new Date("2044-02-01T07:00:00Z")))
      .ready,
    false,
  );
  assert.equal(
    (await periodShiftReadiness(db(), "2044-01-04", "2044-01-31", new Date("2044-02-01T17:00:00Z")))
      .ready,
    true,
  );
});
test("missing definition blocks archive instead of assuming a legacy end", async () => {
  const result = await periodShiftReadiness(
    db([cell], []),
    "2044-01-04",
    "2044-01-31",
    new Date("2044-02-02"),
  );
  assert.equal(result.ready, false);
  assert.equal(result.assignmentId, "a1");
  assert.match(result.reason, /unavailable/);
});
test("legacy overnight windows and staff-free periods keep their existing completion behavior", async () => {
  const legacy = { id: "old", shift: "N", shift_date: "2044-01-31" };
  assert.equal(
    (
      await periodShiftReadiness(
        db([legacy], []),
        "2044-01-04",
        "2044-01-31",
        new Date("2044-02-01T06:59:59Z"),
      )
    ).ready,
    false,
  );
  assert.equal(
    (
      await periodShiftReadiness(
        db([legacy], []),
        "2044-01-04",
        "2044-01-31",
        new Date("2044-02-01T07:00:00Z"),
      )
    ).ready,
    true,
  );
  assert.equal(
    (await periodShiftReadiness(db([], []), "2044-01-04", "2044-01-31", new Date("2044-02-01")))
      .ready,
    true,
  );
});
