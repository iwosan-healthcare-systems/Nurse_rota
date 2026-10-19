import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const legacy = require("../nurse-api/lib/auto-schedule.generated.js");
const period = { periodStart: "2044-01-04", periodEnd: "2044-01-31", hasActive: false };
function fixture({
  result,
  error,
  due = true,
  noHistory = false,
  dryRun = false,
  nurses = [{ id: "n1", name: "Demo nurse", role: "Nurse", ward: "ER" }],
  roleGroups = {},
}) {
  const calls = [],
    logs = [];
  const module = { exports: {} };
  const pool = {
    query: async (sql) => {
      if (sql.includes("FROM profiles p")) return { rows: [] };
      if (sql.includes("SELECT DISTINCT facility")) return { rows: [{ facility: "Demo" }] };
      if (sql.includes("FROM nurses WHERE facility")) return { rows: nurses };
      if (sql.includes("FROM wards WHERE facility")) return { rows: [{ name: "ER" }] };
      throw new Error("legacy generation reached");
    },
  };
  const deps = {
    "node-cron": {},
    "../lib/tenant-context": require("../nurse-api/lib/tenant-context.js"),
    "../db": pool,
    "../lib/persist-rota-draft": {},
    "../lib/role-groups": {
      ...require("../nurse-api/lib/role-groups.js"),
      activeRoleGroups: async () => roleGroups,
    },
    "../lib/scheduling-configuration-service": {
      createSchedulingConfigurationService: () => ({
        initialAutomaticPeriod: async () => period,
        generateAutomaticUnit: async (input) => {
          calls.push(input);
          if (error) throw error;
          return result;
        },
      }),
    },
    "../lib/rota-period-dates": {
      getUnitPeriod: async () => (noHistory ? null : period),
      getWindowForPeriod: async () => ({ generateIsDue: due }),
    },
    "../lib/auto-schedule.generated.js": legacy,
    "../lib/mailer": {},
    "../lib/rota-job-pause": {},
  };
  vm.runInNewContext(
    readFileSync(new URL("../nurse-api/jobs/auto-generate-rota.js", import.meta.url), "utf8"),
    {
      module,
      require: (name) => {
        if (!(name in deps)) throw new Error(`Unexpected dependency ${name}`);
        return deps[name];
      },
      process: { env: { DRY_RUN_ROTA_JOBS: String(dryRun) } },
      console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    },
  );
  return { run: module.exports.runAutoGenerate, calls, logs };
}
test("recurring job uses configured generation and forwards dry-run without legacy writes", async () => {
  const f = fixture({ result: { handled: true, dryRun: true, written: 0 }, dryRun: true });
  await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].dryRun, true);
  assert.equal(f.calls[0].startDate, period.periodStart);
});
test("new facilities can generate their first activated period without published history", async () => {
  const f = fixture({ result: { handled: true, written: 28 }, noHistory: true });
  await f.run();
  assert.equal(f.calls.length, 1);
});
test("paused and failed configured jobs never fall through to the legacy generator", async () => {
  for (const options of [
    { result: { handled: true, skipped: true, reason: "Paused" } },
    { error: new Error("Pending leave") },
  ]) {
    const f = fixture(options);
    await f.run();
    assert.equal(f.calls.length, 1);
    assert.ok(f.logs.length);
  }
});
test("recurring generation retains the existing due-date gate", async () => {
  const f = fixture({ due: false });
  await f.run();
  assert.equal(f.calls.length, 0);
});
test("facilities without an effective policy still reach legacy generation", async () => {
  const f = fixture({ result: null });
  await assert.rejects(f.run(), /legacy generation reached/);
});
test("configured role groups partition custom facility-wide roles into their units", async () => {
  const f = fixture({
    result: { handled: true, written: 28 },
    nurses: [
      { id: "n1", name: "Ward nurse", role: "Nurse", ward: "ER" },
      { id: "n2", name: "Theatre lead", role: "Theatre Coordinator", ward: null },
      { id: "n3", name: "Renamed matron", role: "Matron", ward: "ER" },
    ],
    roleGroups: { Demo: { "theatre coordinator": "head", matron: null } },
  });
  await f.run();
  const units = f.calls.map((c) => [...c.nurseIds].sort());
  assert.deepEqual(units, [["n1", "n3"], ["n2"]]);
});
