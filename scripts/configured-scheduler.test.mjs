import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const {
  generateConfiguredPreview: generate,
  zonedInstant,
  validDate,
} = require("../nurse-api/lib/configured-scheduler");
const { seedConfiguration } = require("../nurse-api/lib/scheduling-configuration");
const legacy = require("../nurse-api/lib/auto-schedule.generated");
const facility = { legacy_facility: "Test", timezone: "Africa/Lagos" };
const ward = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "Ward",
  facility: "Test",
  min_morning_nurses: 1,
  min_morning_na: 1,
  min_night_nurses: 1,
  min_night_na: 1,
};
const nurse = (id, role = "Nurse") => ({
  id,
  role,
  name: id,
  facility: "Test",
  ward: "Ward",
  target_hours: 150,
  is_active: true,
});
function fixture(overrides = {}) {
  const wards = overrides.wards ?? [ward];
  const f = overrides.facility ?? facility;
  return {
    facility: f,
    wards,
    nurses: [nurse("n1")],
    startDate: "2026-09-21",
    configuration: seedConfiguration(f, wards),
    ...overrides,
  };
}
function custom() {
  const f = fixture();
  f.configuration.patterns.push({
    id: "custom",
    name: "2M 2N 3OFF",
    kind: "repeating",
    steps: [
      { shift: "M", days: 2 },
      { shift: "N", days: 2 },
      { shift: "OFF", days: 3 },
    ],
  });
  Object.assign(
    f.configuration.roles.find((r) => r.name === "Nurse"),
    { patternId: "custom", useWardPattern: false },
  );
  return f;
}
test("seeded ordinary and special role assignments match the legacy engine", () => {
  const roles = [
    "Nurse",
    "Surgical Nurse",
    "Surgical Nurse - Day",
    "Nursing Assistant",
    "Nursing Assistant - Day",
    "Matron",
    "Coverage Nurse",
    "Coverage Nurse - Day",
    "Porter",
    "Porter - Day",
    "Nurse Intern",
  ];
  const nurses = roles
    .flatMap((role, i) => Array.from({ length: 4 }, (_, j) => nurse(`${i}-${j}`, role)))
    .sort((a, b) => a.id.localeCompare(b.id));
  const f = fixture({ nurses });
  for (const offset of [0, 28, 56]) {
    const startDate = new Date(Date.parse("2026-09-21T00:00:00Z") + offset * 86400000)
      .toISOString()
      .slice(0, 10);
    const actual = generate({ ...f, startDate, anchorDate: "2026-09-21" });
    const expected = legacy.generateSchedule({
      nurses,
      wards: [ward],
      leave: [],
      startDate: new Date(`${startDate}T12:00:00`),
      periodOffset: offset,
    });
    const sorted = (rows) =>
      rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    assert.deepEqual(
      sorted(actual.assignments.map((a) => [a.nurseId, a.date, a.shift])),
      sorted(expected.assignments.map((a) => [a.nurse_id, a.shift_date, a.shift])),
    );
  }
});
test("fixed ward calendar preserves Oncology day assistant schedules and can be disabled", () => {
  const wards = [{ ...ward, name: "Oncology" }];
  const nurses = [{ ...nurse("day", "Nursing Assistant - Day"), ward: "Oncology" }];
  const f = fixture({ wards, nurses });
  const expected = legacy.generateSchedule({
    nurses,
    wards,
    leave: [],
    startDate: new Date("2026-09-21T12:00:00"),
    periodOffset: 0,
  });
  assert.deepEqual(
    generate(f).assignments.map((a) => a.shift),
    expected.assignments.map((a) => a.shift),
  );
  delete f.configuration.wardPolicies[0].fixedWeeklyPatternId;
  assert.deepEqual(
    generate(f).assignments.map((a) => a.shift),
    expected.assignments.map((a) => a.shift),
  );
  f.configuration.wardPolicies[0].fixedWeeklyPatternId = null;
  assert.notDeepEqual(
    generate(f).assignments.map((a) => a.shift),
    expected.assignments.map((a) => a.shift),
  );
});

test("custom role pattern wins when ward inheritance is disabled", () => {
  const result = generate(custom());
  assert.deepEqual(
    result.assignments.slice(0, 7).map((a) => a.shift),
    ["M", "M", "N", "N", "OFF", "OFF", "OFF"],
  );
  assert.equal(result.assignments.length, 28);
});
test("irregular cycle continues across 28-day boundaries with a stable anchor", () => {
  const f = custom();
  f.configuration.patterns.at(-1).steps[2].days = 5;
  const first = generate(f);
  const next = generate({
    ...f,
    startDate: "2026-10-19",
    anchorDate: f.startDate,
    previousAssignments: first.assignments.map((a) => ({
      nurse_id: a.nurseId,
      shift_date: a.date,
      shift: a.shift,
      pre_leave_shift: a.plannedShift,
    })),
  });
  const cycle = ["M", "M", "N", "N", "OFF", "OFF", "OFF", "OFF", "OFF"];
  assert.deepEqual(
    next.assignments.map((a) => a.shift),
    Array.from({ length: 28 }, (_, i) => cycle[(28 + i) % cycle.length]),
  );
  assert.equal(next.staff[0].phaseSource, "history");
});
test("history must end immediately before the preview; stale history cannot restart a cycle", () => {
  const f = custom();
  const baseline = generate({ ...f, anchorDate: "2026-09-01" });
  const result = generate({
    ...f,
    anchorDate: "2026-09-01",
    previousAssignments: [
      { nurse_id: "n1", shift_date: "2026-09-10", shift: "N" },
      { nurse_id: "n1", shift_date: "2026-09-11", shift: "N" },
    ],
  });
  assert.deepEqual(result.assignments, baseline.assignments);
});
test("approved leave preserves planned shifts but does not count towards coverage or working hours", () => {
  const f = custom();
  f.leave = [
    {
      nurse_id: "n1",
      from_date: "2026-09-21",
      to_date: "2026-09-21",
      status: "Approved",
      type: "Annual",
    },
    {
      nurse_id: "n1",
      from_date: "2026-09-22",
      to_date: "2026-09-22",
      status: "Pending",
      type: "Sick",
    },
  ];
  const result = generate(f);
  assert.equal(result.assignments[0].shift, "LEAVE");
  assert.equal(result.assignments[0].plannedShift, "M");
  assert.equal(result.assignments[0].creditedMinutes, 0);
  assert.equal(result.staff[0].plannedLeaveMinutes, 540);
  assert.equal(result.assignments[1].shift, "M");
  assert.ok(
    result.diagnostics.some(
      (d) => d.code === "STAFFING_SHORTFALL" && d.date === "2026-09-21" && d.actual === 0,
    ),
  );
});
test("custom overnight shift uses hospital timezone and credited minutes", () => {
  const f = custom();
  f.configuration.shifts.push({
    code: "E",
    name: "Evening",
    start: "20:00",
    end: "04:00",
    endDayOffset: 1,
    breakMinutes: 30,
    creditedMinutes: 450,
    color: "#ffffff",
  });
  f.configuration.roles.find((r) => r.name === "Nurse").allowedShifts.push("E");
  f.configuration.patterns.at(-1).steps = [
    { shift: "E", days: 1 },
    { shift: "OFF", days: 1 },
  ];
  const a = generate(f).assignments[0];
  assert.equal(a.start, "2026-09-21T19:00:00.000Z");
  assert.equal(a.end, "2026-09-22T03:00:00.000Z");
  assert.equal(a.creditedMinutes, 450);
});
test("DST ambiguity/nonexistent times fail explicitly rather than guessing", () => {
  assert.throws(() => zonedInstant("2026-03-08", "02:30", "America/New_York"), /nonexistent/);
  assert.throws(() => zonedInstant("2026-11-01", "01:30", "America/New_York"), /ambiguous/);
  assert.equal(zonedInstant("2026-01-01", "08:00", "Asia/Kolkata"), "2026-01-01T02:30:00.000Z");
});
test("all configured wards are checked, including empty wards, and excess counts reported", () => {
  assert.ok(
    generate(fixture({ nurses: [] })).diagnostics.some((d) => d.code === "STAFFING_SHORTFALL"),
  );
  const f = custom();
  f.configuration.requirements[0].minimum = 0;
  f.configuration.requirements[0].maximum = 0;
  assert.ok(generate(f).diagnostics.some((d) => d.code === "STAFFING_EXCESS"));
});
test("zero-rest night to morning transition is reported within and across periods", () => {
  const f = custom();
  f.configuration.patterns.at(-1).steps = [
    { shift: "N", days: 1 },
    { shift: "M", days: 1 },
  ];
  assert.ok(generate(f).diagnostics.some((d) => d.code === "NO_REST"));
  f.configuration.patterns.at(-1).steps = [{ shift: "M", days: 1 }];
  const result = generate({
    ...f,
    previousAssignments: [{ nurse_id: "n1", shift_date: "2026-09-20", shift: "N" }],
  });
  assert.ok(result.diagnostics.some((d) => d.code === "NO_REST" && d.date === "2026-09-21"));
});
test("foreign and inactive staff never enter preview or coverage counts", () => {
  const result = generate(
    fixture({
      nurses: [
        nurse("n1"),
        { ...nurse("foreign"), facility: "Other" },
        { ...nurse("inactive"), is_active: false },
      ],
    }),
  );
  assert.deepEqual(
    result.staff.map((n) => n.id),
    ["n1"],
  );
  assert.equal(result.assignments.length, 28);
});
test("unsupported coverage changes, missing role mappings and disallowed overrides fail before output", () => {
  const f = fixture({ nurses: [nurse("c1", "Coverage Nurse")] });
  Object.assign(
    f.configuration.shifts.find((s) => s.code === "N"),
    { start: "18:00", creditedMinutes: 840 },
  );
  assert.throws(
    () => generate(f),
    (e) => e.errors.some((d) => d.message.includes("does not support")),
  );
  assert.throws(
    () => generate(fixture({ nurses: [nurse("unknown", "Unmapped")] })),
    (e) => e.errors.some((d) => d.message.includes("no configuration")),
  );
  const g = fixture();
  g.configuration.roles.find((r) => r.name === "Nurse").allowedShifts = ["M"];
  g.configuration.roles.find((r) => r.name === "Nurse").patternId = "day_only";
  assert.throws(
    () => generate(g),
    (e) => e.errors.some((d) => d.message.includes("disallowed")),
  );
});
test("calendar dates reject rollover and seeded weekly roles follow the actual weekday", () => {
  assert.equal(validDate("2026-02-30"), false);
  assert.equal(validDate("2024-02-29"), true);
  const result = generate(fixture({ nurses: [nurse("m", "Matron")], startDate: "2026-09-26" }));
  assert.deepEqual(
    result.assignments.slice(0, 3).map((a) => a.shift),
    ["OFF", "OFF", "M"],
  );
});
test("legacy rules accept configurations whose keys were reordered by jsonb storage", () => {
  const nurses = [nurse("n1"), { ...nurse("c1", "Coverage Nurse"), ward: null }];
  const configuration = seedConfiguration(
    facility,
    [ward],
    nurses.map((n) => n.role),
  );
  // PostgreSQL jsonb returns object keys sorted by length, e.g. {days, shift}.
  for (const pattern of configuration.patterns)
    pattern.steps = pattern.steps.map(({ shift, days }) => ({ days, shift }));
  const result = generate(fixture({ nurses, configuration }));
  assert.ok(result.assignments.some((a) => a.nurseId === "c1"));
});
