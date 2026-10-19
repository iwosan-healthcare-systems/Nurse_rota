import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const {
  seedConfiguration,
  validateConfiguration,
} = require("../nurse-api/lib/scheduling-configuration");
const { generateConfiguredPreview: generate } = require("../nurse-api/lib/configured-scheduler");
function fixture(count = 4) {
  const facility = { legacy_facility: "Test", timezone: "Africa/Lagos" };
  const configuration = seedConfiguration(facility, []);
  const role = configuration.roles.find((r) => r.name === "Coverage Nurse");
  role.specialRule = "none";
  configuration.coverageRules = [
    {
      id: "weekend",
      name: "Weekend coverage",
      shift: "MWC",
      roleIds: [role.id],
      anchorDate: "2026-09-26",
      blockDays: 2,
      repeatDays: 7,
      staffPerBlock: 1,
      restBefore: 1,
      restAfter: 1,
    },
  ];
  const nurses = Array.from({ length: count }, (_, i) => ({
    id: `n${i}`,
    name: `Nurse ${i}`,
    role: role.name,
    facility: "Test",
    is_active: true,
    target_hours: 150,
  }));
  return {
    facility,
    configuration,
    nurses,
    wards: [],
    startDate: "2026-09-21",
    anchorDate: "2026-09-21",
  };
}
test("configured weekend coverage rotates staff and protects pre/post rest", () => {
  const result = generate(fixture());
  const at = (n, date) => result.assignments.find((a) => a.nurseId === n && a.date === date).shift;
  assert.equal(at("n0", "2026-09-25"), "OFF");
  assert.equal(at("n0", "2026-09-26"), "MWC");
  assert.equal(at("n0", "2026-09-27"), "MWC");
  assert.equal(at("n0", "2026-09-28"), "OFF");
  assert.equal(at("n1", "2026-10-03"), "MWC");
  assert.equal(at("n2", "2026-10-10"), "MWC");
  assert.ok(!result.diagnostics.some((d) => d.code === "LEGACY_ADAPTER"));
});
test("fixed coverage is identical across split periods with published history", () => {
  const f = fixture();
  const whole = generate(f);
  const first = generate({ ...f, days: 7 });
  const rest = generate({
    ...f,
    startDate: "2026-09-28",
    days: 21,
    previousAssignments: first.assignments.map((a) => ({
      nurse_id: a.nurseId,
      shift_date: a.date,
      shift: a.shift,
      pre_leave_shift: a.plannedShift,
    })),
  });
  const normalize = (rows) =>
    rows
      .map((a) => [a.nurseId, a.date, a.shift])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(
    normalize([...first.assignments, ...rest.assignments]),
    normalize(whole.assignments),
  );
});
test("approved leave preserves the fixed coverage slot and reports an actionable gap", () => {
  const f = fixture();
  f.leave = [
    {
      nurse_id: "n0",
      status: "Approved",
      type: "Annual",
      from_date: "2026-09-26",
      to_date: "2026-09-27",
    },
  ];
  const result = generate(f);
  const a = result.assignments.find((a) => a.nurseId === "n0" && a.date === "2026-09-26");
  assert.equal(a.shift, "LEAVE");
  assert.equal(a.plannedShift, "MWC");
  assert.equal(a.creditedMinutes, 0);
  assert.ok(result.diagnostics.some((d) => d.code === "CONFIGURED_COVERAGE_GAP" && d.actual === 0));
});
test("empty pools and insufficient staffing produce gaps without duplicate assignments", () => {
  assert.ok(generate(fixture(0)).diagnostics.some((d) => d.code === "CONFIGURED_COVERAGE_GAP"));
  const f = fixture(1);
  f.configuration.coverageRules[0].staffPerBlock = 2;
  const r = generate(f);
  assert.equal(r.assignments.length, 28);
  assert.ok(r.diagnostics.some((d) => d.code === "CONFIGURED_COVERAGE_GAP" && d.actual === 1));
});
test("custom shifts and multi-person continuous blocks use configured values", () => {
  const f = fixture(4);
  f.configuration.shifts.push({
    code: "X",
    name: "Late cover",
    start: "18:00",
    end: "23:00",
    endDayOffset: 0,
    breakMinutes: 0,
    creditedMinutes: 300,
    color: "#ffffff",
  });
  f.configuration.roles.find((r) => r.name === "Coverage Nurse").allowedShifts.push("X");
  Object.assign(f.configuration.coverageRules[0], {
    shift: "X",
    anchorDate: f.startDate,
    blockDays: 3,
    repeatDays: 3,
    staffPerBlock: 2,
    restBefore: 0,
    restAfter: 0,
  });
  const r = generate(f);
  for (const date of r.dates)
    assert.equal(r.assignments.filter((a) => a.date === date && a.shift === "X").length, 2);
  assert.equal(r.assignments.find((a) => a.shift === "X").creditedMinutes, 300);
});
test("overlapping duty and rest reservations report blocking conflicts", () => {
  const f = fixture(1);
  Object.assign(f.configuration.coverageRules[0], { blockDays: 4, repeatDays: 4, restAfter: 2 });
  assert.ok(generate(f).diagnostics.some((d) => d.code === "COVERAGE_CONFLICT"));
  const other = fixture();
  other.configuration.coverageRules.push({
    ...other.configuration.coverageRules[0],
    id: "second",
    shift: "NC",
  });
  assert.ok(generate(other).diagnostics.some((d) => d.code === "COVERAGE_CONFLICT"));
});
test("published duties conflicting with coverage rest are reported without mutation", () => {
  const f = fixture();
  f.startDate = "2026-09-26";
  f.previousAssignments = [{ nurse_id: "n0", shift_date: "2026-09-25", shift: "N" }];
  const before = structuredClone(f.previousAssignments);
  const r = generate(f);
  assert.ok(r.diagnostics.some((d) => d.code === "COVERAGE_BOUNDARY_REST"));
  assert.deepEqual(f.previousAssignments, before);
});
test("rotation does not start duty before its first block and ignores inactive staff", () => {
  const f = fixture();
  f.nurses[0].is_active = false;
  const r = generate(f);
  assert.ok(!r.assignments.some((a) => a.nurseId === "n0"));
  assert.ok(!r.assignments.some((a) => a.date < "2026-09-26" && a.shift === "MWC"));
  assert.equal(
    r.assignments.find((a) => a.nurseId === "n1" && a.date === "2026-09-26").shift,
    "MWC",
  );
});
for (const [name, mutate] of [
  ["unknown field", (r) => (r.script = "anything")],
  ["invalid date", (r) => (r.anchorDate = "2026-02-30")],
  ["fractional block", (r) => (r.blockDays = 1.5)],
  ["overlapping repeat", (r) => (r.repeatDays = 1)],
  ["no roles", (r) => (r.roleIds = [])],
  ["unknown role", (r) => (r.roleIds = ["missing"])],
  ["unknown shift", (r) => (r.shift = "NO")],
  ["unbounded rest", (r) => (r.restAfter = 29)],
  ["duplicate roles", (r) => r.roleIds.push(r.roleIds[0])],
])
  test(`coverage validation rejects ${name}`, () => {
    const f = fixture();
    mutate(f.configuration.coverageRules[0]);
    assert.equal(validateConfiguration(f.configuration, []).valid, false);
  });
test("coverage rejects retained legacy methods and ward-scoped roles", () => {
  const f = fixture();
  const role = f.configuration.roles.find((r) => r.name === "Coverage Nurse");
  role.specialRule = "legacy_coverage_v1";
  assert.equal(validateConfiguration(f.configuration, []).valid, false);
  role.specialRule = "none";
  role.scope = "ward";
  assert.equal(validateConfiguration(f.configuration, []).valid, false);
});
