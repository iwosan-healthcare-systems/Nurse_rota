import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { isLiveCompatible, createPolicyService } = require("../nurse-api/lib/scheduling-policy");
const { seedConfiguration } = require("../nurse-api/lib/scheduling-configuration");
const facility = {
  id: "10000000-0000-4000-8000-000000000001",
  legacy_facility: "Test",
  timezone: "Africa/Lagos",
};
const nurses = [{ id: "n1", role: "Nurse" }];
test("activation permits custom shifts and role groups but only the Lagos timezone", () => {
  const config = seedConfiguration(facility, [], ["Nurse"]);
  config.patterns[0].steps[0].days = 3;
  assert.equal(isLiveCompatible(config), true);
  config.shifts[0].creditedMinutes--;
  config.shifts.push({ ...config.shifts[0], code: "EVE", name: "Evening", start: "14:00" });
  config.roles[0].scope = "facility";
  config.roles[0].approvalGroup = "porter";
  assert.equal(isLiveCompatible(config), true);
  config.timezone = "Europe/London";
  assert.equal(isLiveCompatible(config), false);
});
function policyFixture(policy) {
  const queries = [];
  let generated = 0;
  const db = {
    query: async (sql) => {
      queries.push(sql);
      if (sql.includes("scheduling_facilities")) return { rows: [facility] };
      if (sql.includes("scheduling_policy_events")) return { rows: policy ? [policy] : [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const service = createPolicyService({
    pool: db,
    transaction: async (fn) => fn(db),
    generateRun: async () => {
      generated++;
      throw new Error("Must not generate");
    },
    fail: (status, message) => {
      throw Object.assign(new Error(message), { status });
    },
    assertBody: () => {},
    assertId: () => {},
    facilityFor: async () => facility,
  });
  return { service, queries, generated: () => generated };
}
test("paused recurring generation is handled without falling through to legacy scheduling", async () => {
  const f = policyFixture({ state: "paused" });
  const result = await f.service.generateAutomaticUnit({
    facilityName: "Test",
    startDate: "2042-01-01",
    nurseIds: ["n1"],
  });
  assert.equal(result.handled, true);
  assert.equal(result.skipped, true);
  assert.equal(f.generated(), 0);
  assert.ok(
    f.queries.every(
      (q) => !q.startsWith("INSERT") && !q.startsWith("DELETE") && !q.startsWith("UPDATE"),
    ),
  );
});
test("no effective policy leaves existing generation available", async () => {
  const f = policyFixture(null);
  assert.equal(
    await f.service.generateAutomaticUnit({
      facilityName: "Test",
      startDate: "2042-01-01",
      nurseIds: ["n1"],
    }),
    null,
  );
  assert.equal(f.generated(), 0);
});
test("active policy rejects off-cycle generation before reading or writing a run", async () => {
  const f = policyFixture({ state: "active", period_anchor: "2042-01-01" });
  await assert.rejects(
    f.service.generateAutomaticUnit({
      facilityName: "Test",
      startDate: "2042-01-02",
      nurseIds: ["n1"],
    }),
    (e) => e.status === 422,
  );
  assert.equal(f.generated(), 0);
});
test("manual generation rejects malformed unit identifiers and periods", async () => {
  const f = policyFixture(null);
  for (const body of [
    { startDate: "2042-02-30", unit: "all" },
    { startDate: "2042-01-01", unit: "ward:------------------------------------" },
    { startDate: "2042-01-01", unit: "group:unknown" },
  ])
    await assert.rejects(
      f.service.generateActive("admin", facility.id, body),
      (e) => e.status === 400,
    );
  assert.equal(f.queries.length, 0);
});
