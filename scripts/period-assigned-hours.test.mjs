import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { withPeriodAssignedHours } = require("../nurse-api/lib/period-assigned-hours");
const periods = [0, 1, 2].map((index) => ({
  nurse_id: `n${index}`,
  period_start: "2044-01-04",
  period_end: "2044-01-31",
}));
test("archive totals preserve fractional saved credits, leave credits and OFF zero", async () => {
  const rows = [
    { period_index: 0, shift: "M", shift_date: "2044-01-04", shift_definition_run_id: "r1" },
    {
      period_index: 0,
      shift: "LEAVE",
      pre_leave_shift: "M",
      shift_date: "2044-01-05",
      shift_definition_run_id: "r1",
    },
    { period_index: 1, shift: "OFF", shift_date: "2044-01-04" },
    { period_index: 2, shift: "N", shift_date: "2044-01-04" },
  ];
  const run = {
    id: "r1",
    configuration_snapshot: {
      timezone: "Africa/Lagos",
      shifts: [
        {
          code: "M",
          start: "08:00",
          end: "17:00",
          endDayOffset: 0,
          breakMinutes: 90,
          creditedMinutes: 450,
        },
      ],
    },
  };
  const db = {
    query: async (sql) => ({ rows: sql.includes("FROM scheduling_runs") ? [run] : rows }),
  };
  assert.deepEqual(
    (await withPeriodAssignedHours(db, periods)).map((p) => p.assigned_hours),
    [15, 0, 15],
  );
});
test("one unresolved cell makes the total unavailable instead of exposing a partial sum", async () => {
  const db = {
    query: async (sql) => ({
      rows: sql.includes("FROM scheduling_runs")
        ? []
        : [
            { period_index: 0, shift: "M", shift_date: "2044-01-04" },
            {
              period_index: 0,
              shift: "E",
              shift_date: "2044-01-05",
              shift_definition_run_id: "missing",
            },
          ],
    }),
  };
  const result = await withPeriodAssignedHours(db, periods);
  assert.equal(result[0].assigned_hours, null);
  assert.match(result[0].assigned_hours_error, /unavailable/);
  assert.equal(result[1].assigned_hours, 0);
});
