import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";

// Exercise the browser source and the checked-in module deployed to the API.
// No database, network, real staff records, or generated-file writes are needed.
const source = readFileSync(new URL("../src/lib/auto-schedule.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const browser = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const server = createRequire(import.meta.url)("../nurse-api/lib/auto-schedule.generated.js");
const cycle = [
  "M",
  "M",
  "M",
  "M",
  "OFF",
  "OFF",
  "OFF",
  "OFF",
  "N",
  "N",
  "N",
  "N",
  "OFF",
  "OFF",
  "OFF",
  "OFF",
];
const dayCycle = cycle.slice(0, 8);
const nurse = (id, role = "Nurse", ward = "Test Ward") => ({
  id,
  name: id,
  role,
  ward,
  facility: "Test Hospital",
  target_hours: 150,
});
const ward = (overrides = {}) => ({
  id: "ward-1",
  name: "Test Ward",
  facility: "Test Hospital",
  min_morning_nurses: 1,
  min_morning_na: 1,
  min_night_nurses: 1,
  min_night_na: 1,
  ...overrides,
});
const options = (overrides = {}) => ({
  nurses: [nurse("n1")],
  wards: [ward()],
  leave: [],
  startDate: new Date(2026, 8, 21),
  days: 28,
  ...overrides,
});
const shifts = (result, id = "n1") =>
  result.assignments.filter((a) => a.nurse_id === id).map((a) => a.shift);
const weekdayPattern = Array.from({ length: 28 }, (_, i) => (i % 7 < 5 ? "M" : "OFF"));

for (const [runtime, engine] of [
  ["browser", browser],
  ["server", server],
]) {
  const run = (overrides) => engine.generateSchedule(options(overrides));
  test(`${runtime}: regular role repeats the 16-day cycle`, () => {
    assert.deepEqual(
      shifts(run()),
      Array.from({ length: 28 }, (_, i) => cycle[i % 16]),
    );
  });
  test(`${runtime}: day-only roles never receive nights`, () => {
    for (const role of ["Nursing Assistant - Day", "Porter - Day"]) {
      assert.deepEqual(
        shifts(run({ nurses: [nurse("n1", role)] })),
        Array.from({ length: 28 }, (_, i) => dayCycle[i % 8]),
      );
    }
  });
  test(`${runtime}: matrons and surgical day nurses follow weekdays`, () => {
    for (const role of ["Matron", "Surgical Nurse - Day"]) {
      const result = run({ nurses: [nurse("n1", role)] });
      assert.deepEqual(shifts(result), weekdayPattern);
      assert.equal(result.assignments[0].ward, role === "Matron" ? null : "Test Ward");
    }
  });
  test(`${runtime}: weekday ward exceptions override the rotating pattern`, () => {
    for (const name of ["Oncology", "Dialysis"]) {
      assert.deepEqual(
        shifts(run({ nurses: [nurse("n1", "Nurse", name)], wards: [ward({ name })] })),
        weekdayPattern,
      );
    }
  });
  test(`${runtime}: morning-only wards and NA-specific night minima select day cycles`, () => {
    assert.deepEqual(
      shifts(run({ wards: [ward({ min_night_nurses: 0, min_night_na: 0 })] })),
      Array.from({ length: 28 }, (_, i) => dayCycle[i % 8]),
    );
    assert.deepEqual(
      shifts(
        run({ nurses: [nurse("n1", "Nursing Assistant")], wards: [ward({ min_night_na: 0 })] }),
      ),
      Array.from({ length: 28 }, (_, i) => dayCycle[i % 8]),
    );
  });
  test(`${runtime}: approved leave preserves the underlying shift and pending leave does not apply`, () => {
    const result = run({
      leave: [
        {
          nurse_id: "n1",
          from_date: "2026-09-21",
          to_date: "2026-09-25",
          status: "Approved",
          type: "Annual",
        },
        {
          nurse_id: "n1",
          from_date: "2026-09-29",
          to_date: "2026-09-30",
          status: "Pending",
          type: "Sick",
        },
      ],
    });
    assert.deepEqual(
      result.assignments.slice(0, 5).map((a) => [a.shift, a.pre_leave_shift, a.leave_type]),
      ["M", "M", "M", "M", "OFF"].map((s) => ["LEAVE", s, "Annual"]),
    );
    assert.equal(result.assignments[8].shift, "N");
  });
  test(`${runtime}: a 28-day boundary preserves the ongoing rotation`, () => {
    const first = run();
    const second = run({
      startDate: new Date(2026, 9, 19),
      periodOffset: 28,
      previousAssignments: first.assignments.slice(-4),
    });
    assert.deepEqual([...shifts(first), ...shifts(second)], shifts(run({ days: 56 })));
  });
  test(`${runtime}: actual prior night block takes precedence over calculated phase`, () => {
    const previousAssignments = [17, 18, 19, 20].map((d) => ({
      nurse_id: "n1",
      shift_date: `2026-09-${d}`,
      shift: "N",
    }));
    assert.deepEqual(shifts(run({ days: 8, previousAssignments })), [
      "OFF",
      "OFF",
      "OFF",
      "OFF",
      "M",
      "M",
      "M",
      "M",
    ]);
  });
  test(`${runtime}: minima report shortages without changing assignments`, () => {
    const low = run();
    const high = run({ wards: [ward({ min_morning_nurses: 20 })] });
    assert.deepEqual(high.assignments, low.assignments);
    assert.ok(high.violations.some((v) => v.shift === "M" && v.required === 20 && v.actual === 1));
    assert.deepEqual(high.extraShifts, []);
  });
  test(`${runtime}: unassigned staff are OFF and staff-free wards currently produce no violations`, () => {
    assert.ok(shifts(run({ nurses: [nurse("n1", "Nurse", null)] })).every((s) => s === "OFF"));
    assert.deepEqual(run({ nurses: [] }).violations, []);
  });
  test(`${runtime}: ward staff input order does not alter assignments`, () => {
    const nurses = Array.from({ length: 8 }, (_, i) => nurse(`n${i}`));
    assert.deepEqual(run({ nurses }), run({ nurses: [...nurses].reverse() }));
    const result = run({ nurses });
    assert.equal(
      new Set(result.assignments.map((a) => `${a.nurse_id}:${a.shift_date}`)).size,
      8 * 28,
    );
  });
  test(`${runtime}: Ikoyi GOPD uses a single night slot with a sufficiently staffed pool`, () => {
    const nurses = Array.from({ length: 8 }, (_, i) => ({
      ...nurse(`n${i}`, "Nurse", "GOPD"),
      facility: "Ikoyi",
    }));
    const result = run({
      nurses,
      wards: [ward({ name: "GOPD", facility: "Ikoyi" })],
      facility: "Ikoyi",
    });
    for (const date of new Set(result.assignments.map((a) => a.shift_date))) {
      assert.equal(
        result.assignments.filter((a) => a.shift_date === date && a.shift === "N").length,
        1,
        date,
      );
    }
  });
  test(`${runtime}: coverage day staff receive weekend coverage but no night duty`, () => {
    const result = run({ nurses: [nurse("n1", "Coverage Nurse - Day", null)] });
    assert.ok(shifts(result).includes("MWC"));
    assert.ok(shifts(result).every((s) => ["M", "MWC", "OFF"].includes(s)));
    for (const a of result.assignments.filter((a) => a.shift === "MWC")) {
      assert.ok([0, 6].includes(new Date(`${a.shift_date}T12:00:00`).getDay()));
      assert.equal(a.ward, null);
    }
    assert.deepEqual(shifts(result).slice(4, 8), ["OFF", "MWC", "MWC", "OFF"]);
  });
  test(`${runtime}: shift coverage nurses work 4 M, 2 OFF, 4 N, 4 OFF and never NC`, () => {
    const nurses = Array.from({ length: 4 }, (_, i) => nurse(`c${i}`, "Coverage Nurse", null));
    const result = run({
      nurses,
      leave: [
        {
          nurse_id: "c0",
          from_date: "2026-09-21",
          to_date: "2026-10-18",
          status: "Approved",
          type: "Sick",
        },
      ],
    });
    assert.ok(!result.assignments.some((a) => ["NC", "MWC"].includes(a.shift)));
    assert.ok(shifts(result, "c0").every((s) => s === "LEAVE"));
    assert.equal(result.assignments.length, 4 * 28);
    for (const id of ["c0", "c1", "c2", "c3"]) {
      const planned = result.assignments
        .filter((a) => a.nurse_id === id)
        .map((a) => a.pre_leave_shift ?? a.shift);
      const start = engine.COVERAGE_SHIFT_CYCLE.findIndex((_, p) =>
        planned.every((s, d) => s === engine.COVERAGE_SHIFT_CYCLE[(p + d) % 14]),
      );
      assert.ok(start >= 0, `${id} follows the 14-day pattern: ${planned.join(" ")}`);
    }
  });
  test(`${runtime}: shift coverage continues from the previous period's last shifts`, () => {
    const prior = (shifts) =>
      shifts.map((shift, i) => ({
        nurse_id: "c0",
        shift_date: `2026-09-${String(16 + i).padStart(2, "0")}`,
        shift,
      }));
    const first = (previousAssignments) =>
      shifts(
        run({ nurses: [nurse("c0", "Coverage Nurse", null)], previousAssignments }),
        "c0",
      ).slice(0, 8);
    // Old NC nights count as nights: finish the 4 days off, then mornings.
    assert.deepEqual(first(prior(["OFF", "NC", "NC", "NC", "NC"])), [
      "OFF",
      "OFF",
      "OFF",
      "OFF",
      "M",
      "M",
      "M",
      "M",
    ]);
    assert.deepEqual(first(prior(["OFF", "OFF", "M", "M", "M"])), [
      "M",
      "OFF",
      "OFF",
      "N",
      "N",
      "N",
      "N",
      "OFF",
    ]);
    assert.deepEqual(first(prior(["N", "N", "N", "N", "OFF"])), [
      "OFF",
      "OFF",
      "OFF",
      "M",
      "M",
      "M",
      "M",
      "OFF",
    ]);
  });
  test(`${runtime}: one day coverage nurse covers each weekend, off the Friday before and Monday after`, () => {
    const nurses = [
      nurse("d0", "Coverage Nurse - Day", null),
      nurse("d1", "Coverage Nurse - Day", null),
      nurse("d2", "Coverage Nurse - Day", null),
      nurse("c0", "Coverage Nurse", null),
    ];
    const result = run({ nurses });
    const cell = (id, d) => result.assignments.find((a) => a.nurse_id === id && a.shift_date === d);
    const dates = [...new Set(result.assignments.map((a) => a.shift_date))].sort();
    const covering = new Set();
    for (const date of dates) {
      const dow = new Date(`${date}T12:00:00`).getDay();
      const mwc = result.assignments.filter((a) => a.shift_date === date && a.shift === "MWC");
      if (dow !== 0 && dow !== 6) {
        assert.equal(mwc.length, 0, date);
        continue;
      }
      assert.equal(mwc.length, 1, date);
      assert.notEqual(mwc[0].nurse_id, "c0", "Shift coverage nurses do not take MWC");
      covering.add(mwc[0].nurse_id);
      if (dow === 6) {
        const at = dates.indexOf(date);
        if (at >= 1) assert.equal(cell(mwc[0].nurse_id, dates[at - 1]).shift, "OFF");
        assert.equal(cell(mwc[0].nurse_id, dates[at + 1]).shift, "MWC");
        if (dates[at + 2]) assert.equal(cell(mwc[0].nurse_id, dates[at + 2]).shift, "OFF");
        for (let k = 3; k <= 6 && dates[at + k]; k++)
          assert.equal(cell(mwc[0].nurse_id, dates[at + k]).shift, "M");
      }
    }
    assert.equal(covering.size, 3, "The weekend rotates through every day coverage nurse");
    for (const id of ["d0", "d1", "d2"]) {
      const worked = shifts(result, id).filter((s) => s === "M" || s === "MWC").length;
      assert.ok(worked >= 19 && worked <= 21, `${id} works about 5 days a week (${worked})`);
    }
  });
  test(`${runtime}: weekend cover is shared evenly in the month when someone is on leave`, () => {
    const nurses = ["d0", "d1", "d2", "d3"].map((id) => nurse(id, "Coverage Nurse - Day", null));
    const result = run({
      nurses,
      leave: ["d0", "d1"].map((id) => ({
        nurse_id: id,
        from_date: "2026-09-26",
        to_date: "2026-09-27",
        status: "Approved",
        type: "Annual",
      })),
    });
    const weekends = {};
    for (const a of result.assignments)
      if (a.shift === "MWC" && new Date(`${a.shift_date}T12:00:00`).getDay() === 6)
        weekends[a.nurse_id] = (weekends[a.nurse_id] ?? 0) + 1;
    // Four weekends, four nurses: everyone covers once, nobody twice.
    assert.deepEqual(Object.values(weekends).sort(), [1, 1, 1, 1]);
  });
  test(`${runtime}: a weekend covered before the period still gives its Monday off`, () => {
    const result = run({
      nurses: [
        nurse("d0", "Coverage Nurse - Day", null),
        nurse("d1", "Coverage Nurse - Day", null),
      ],
      previousAssignments: [
        { nurse_id: "d1", shift_date: "2026-09-19", shift: "MWC" },
        { nurse_id: "d1", shift_date: "2026-09-20", shift: "MWC" },
        { nurse_id: "d0", shift_date: "2026-09-19", shift: "OFF" },
        { nurse_id: "d0", shift_date: "2026-09-20", shift: "OFF" },
      ],
    });
    assert.equal(shifts(result, "d1")[0], "OFF", "Monday 21 Sep after covering the weekend");
    assert.equal(shifts(result, "d0")[0], "M");
  });
}

test("browser and deployed server agree across mixed roles and period offsets", () => {
  const nurses = [
    "Nurse",
    "Nursing Assistant",
    "Surgical Nurse - Day",
    "Matron",
    "Coverage Nurse",
    "Coverage Nurse - Day",
    "Porter",
    "Porter - Day",
    "Nurse Intern",
  ].map((role, i) => nurse(`n${i}`, role));
  for (const periodOffset of [0, 28, 56]) {
    const input = options({ nurses, periodOffset });
    assert.deepEqual(server.generateSchedule(input), browser.generateSchedule(input));
  }
});
