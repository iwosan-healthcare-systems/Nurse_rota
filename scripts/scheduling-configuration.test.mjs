import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const {
  seedConfiguration,
  validateConfiguration,
  configurationWarnings,
} = require("../nurse-api/lib/scheduling-configuration");
const {
  createSchedulingConfigurationService,
} = require("../nurse-api/lib/scheduling-configuration-service");
const wardId = "10000000-0000-4000-8000-000000000001";
const facility = { legacy_facility: "Ikoyi", timezone: "Africa/Lagos" };
const wards = [
  {
    id: wardId,
    name: "GOPD",
    min_morning_nurses: 7,
    min_morning_na: 2,
    min_night_nurses: 1,
    min_night_na: 0,
  },
];
const seed = () => seedConfiguration(facility, wards);

test("defaults preserve database minima and identify legacy ward/role exceptions", () => {
  const c = seed();
  assert.deepEqual(validateConfiguration(c, wards), { valid: true, errors: [] });
  assert.equal(c.requirements.find((r) => r.shift === "M" && r.category === "nurse").minimum, 7);
  assert.equal(c.wardPolicies[0].specialRule, "legacy_single_night_slot_v1");
  assert.equal(c.wardPolicies[0].naPatternId, "day_only");
  assert.equal(c.roles.find((r) => r.name === "Surgical Nurse - Day").patternId, "weekdays");
  // The weekend rule needs day coverage staff in the facility.
  assert.equal(c.coverageRules, undefined);
  const withDay = seedConfiguration(facility, wards, ["Coverage Nurse - Day"]);
  const day = withDay.roles.find((r) => r.name === "Coverage Nurse - Day");
  const shift = c.roles.find((r) => r.name === "Coverage Nurse");
  assert.equal(day.specialRule, "none");
  assert.equal(day.patternId, "weekdays");
  assert.equal(shift.specialRule, "none");
  assert.deepEqual(c.patterns.find((p) => p.id === shift.patternId).steps, [
    { shift: "M", days: 4 },
    { shift: "OFF", days: 2 },
    { shift: "N", days: 4 },
    { shift: "OFF", days: 4 },
  ]);
  assert.deepEqual(withDay.coverageRules, [
    {
      id: "weekend_coverage",
      name: "Weekend coverage",
      shift: "MWC",
      roleIds: [day.id],
      anchorDate: "2026-01-03",
      blockDays: 2,
      repeatDays: 7,
      staffPerBlock: 1,
      restBefore: 1,
      restAfter: 1,
    },
  ]);
  assert.ok(!c.roles.some((r) => r.allowedShifts.includes("NC")));
  assert.equal(
    seedConfiguration(facility, wards, [], { legacyCoverage: true }).roles.find(
      (r) => r.name === "Coverage Nurse - Day",
    ).specialRule,
    "legacy_coverage_v1",
  );
  assert.equal(c.roles.find((r) => r.name === "Porter").scope, "facility");
  assert.ok(configurationWarnings(c).some((w) => w.code === "DRAFT_ONLY"));
});

test("a new hospital's defaults set a pattern for every role, without Lagoon's rules", () => {
  const other = { ...facility, organization_id: "20000000-0000-4000-8000-000000000002" };
  const c = seedConfiguration(other, [{ ...wards[0], name: "Oncology" }], ["Ward Clerk"]);
  assert.deepEqual(validateConfiguration(c, wards), { valid: true, errors: [] });
  assert.deepEqual(
    c.roles.map((r) => r.name),
    ["Nurse", "Nursing Assistant", "Matron", "Porter", "Ward Clerk"],
  );
  for (const r of c.roles) {
    assert.equal(r.specialRule, "none");
    assert.ok(
      c.patterns.some((p) => p.id === r.patternId),
      r.name,
    );
  }
  assert.equal(c.roles.find((r) => r.name === "Ward Clerk").requiresReview, true);
  assert.equal(c.roles.find((r) => r.name === "Nurse").requiresReview, false);
  assert.deepEqual(
    c.shifts.map((s) => s.code),
    ["M", "N"],
  );
  assert.equal(c.coverageRules, undefined);
  assert.equal(c.wardPolicies[0].specialRule, "none");
  assert.equal(c.wardPolicies[0].fixedWeeklyPatternId, null);
  // Lagoon is the hospital of facilities without one (before tenancy).
  const lagoon = { ...facility, organization_id: "00000000-0000-4000-8000-000000000001" };
  assert.deepEqual(seedConfiguration(lagoon, wards), seedConfiguration(facility, wards));
});

test("unknown staff roles are retained for review and names map to stable IDs", () => {
  const a = seedConfiguration(facility, wards, ["Ward Clerk", "nurse"]);
  const b = seedConfiguration(facility, wards, ["nurse", "Ward Clerk"]);
  assert.deepEqual(a.roles, b.roles);
  assert.equal(a.roles.filter((r) => r.name.toLowerCase() === "nurse").length, 1);
  assert.equal(a.roles.find((r) => r.name === "Ward Clerk").requiresReview, true);
});

test("custom timed shifts and non-four-day patterns can be saved as drafts", () => {
  const c = seed();
  c.shifts.push({
    code: "E",
    name: "Evening",
    start: "14:00",
    end: "22:00",
    endDayOffset: 0,
    breakMinutes: 30,
    creditedMinutes: 450,
    color: "#abcdef",
  });
  c.patterns.push({
    id: "custom",
    name: "Custom",
    kind: "repeating",
    steps: [
      { shift: "E", days: 2 },
      { shift: "N", days: 2 },
      { shift: "OFF", days: 3 },
    ],
  });
  assert.equal(validateConfiguration(c, wards).valid, true);
  assert.ok(configurationWarnings(c).some((w) => w.code === "CUSTOM_SHIFTS"));
});

for (const [name, mutate] of [
  [
    "unknown root field",
    (c) => {
      c.activate = true;
    },
  ],
  [
    "unsupported schema",
    (c) => {
      c.schemaVersion = 2;
    },
  ],
  [
    "unsupported period",
    (c) => {
      c.periodDays = 14;
    },
  ],
  [
    "invalid timezone",
    (c) => {
      c.timezone = "Mars/Olympus";
    },
  ],
  [
    "duplicate shift",
    (c) => {
      c.shifts.push(c.shifts[0]);
    },
  ],
  [
    "reserved shift",
    (c) => {
      c.shifts[0].code = "LEAVE";
    },
  ],
  [
    "negative duration",
    (c) => {
      c.shifts[0].end = "07:00";
    },
  ],
  [
    "break too long",
    (c) => {
      c.shifts[0].breakMinutes = 1000;
    },
  ],
  [
    "credit too long",
    (c) => {
      c.shifts[0].creditedMinutes = 1000;
    },
  ],
  [
    "invalid time",
    (c) => {
      c.shifts[0].start = "25:00";
    },
  ],
  [
    "invalid color",
    (c) => {
      c.shifts[0].color = "red";
    },
  ],
  [
    "unknown pattern shift",
    (c) => {
      c.patterns[0].steps[0].shift = "UNKNOWN";
    },
  ],
  [
    "zero block",
    (c) => {
      c.patterns[0].steps[0].days = 0;
    },
  ],
  [
    "invalid weekly shape",
    (c) => {
      c.patterns[2].steps.pop();
    },
  ],
  [
    "empty pattern",
    (c) => {
      c.patterns[0].steps = [];
    },
  ],
  [
    "dangling role pattern",
    (c) => {
      c.roles[0].patternId = "missing";
    },
  ],
  [
    "disallowed pattern shift",
    (c) => {
      c.roles[0].allowedShifts = ["M"];
    },
  ],
  [
    "cross-facility policy",
    (c) => {
      c.wardPolicies[0].wardId = "20000000-0000-4000-8000-000000000001";
    },
  ],
  [
    "cross-facility requirement",
    (c) => {
      c.requirements[0].wardId = "20000000-0000-4000-8000-000000000001";
    },
  ],
  [
    "duplicate requirement",
    (c) => {
      c.requirements.push(c.requirements[0]);
    },
  ],
  [
    "negative requirement",
    (c) => {
      c.requirements[0].minimum = -1;
    },
  ],
  [
    "maximum below minimum",
    (c) => {
      c.requirements[0].maximum = 0;
    },
  ],
  [
    "invalid weekday",
    (c) => {
      c.requirements[0].weekday = 0;
    },
  ],
  [
    "null nested shift",
    (c) => {
      c.shifts[0] = null;
    },
  ],
  [
    "null pattern step",
    (c) => {
      c.patterns[0].steps[0] = null;
    },
  ],
]) {
  test(`validation rejects ${name}`, () => {
    const c = seed();
    mutate(c);
    const result = validateConfiguration(c, wards);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
    assert.ok(
      result.errors.every((e) => typeof e.path === "string" && typeof e.message === "string"),
    );
  });
}

test("malformed top-level input returns errors rather than throwing", () => {
  for (const value of [null, [], true, "text", {}, { schemaVersion: 1 }])
    assert.equal(validateConfiguration(value).valid, false);
});

test("failed creation rolls back and releases the client on an audit failure", async () => {
  const calls = [];
  let released = false;
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("FROM scheduling_facilities"))
        return { rows: [{ ...facility, organization_id: wardId }] };
      if (sql.includes("FROM wards")) return { rows: wards };
      if (sql.includes("INSERT INTO scheduling_config_versions"))
        return {
          rows: [
            { id: wardId, facility_id: wardId, version: 1, revision: 1, configuration: seed() },
          ],
        };
      if (sql.includes("INSERT INTO audit_logs")) throw new Error("Audit unavailable");
      return { rows: [] };
    },
    release() {
      released = true;
    },
  };
  const service = createSchedulingConfigurationService({ connect: async () => client });
  await assert.rejects(
    service.create(wardId, wardId, { configuration: seed() }),
    /Audit unavailable/,
  );
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.equal(calls.includes("COMMIT"), false);
  assert.equal(released, true);
});
