import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
function load(file, deps, env = {}) {
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(new URL(`../nurse-api/${file}`, import.meta.url), "utf8"), {
    module,
    require: (name) => {
      if (!(name in deps)) throw new Error(name);
      return deps[name];
    },
    process: { env },
    console: { log: () => {}, error: () => {} },
  });
  return module.exports;
}
const invalid = () =>
  Object.assign(new Error("Saved role unavailable"), { code: "CONFIGURED_EDIT_INVALID" });
test("automatic submission validates its locked unit and reports blocked configured cells", async () => {
  for (const blocked of [false, true]) {
    const calls = [];
    const pool = {
      query: async (sql) => ({
        rows: sql.includes("SELECT id, role FROM nurses") ? [{ id: "n1", role: "Nurse" }] : [],
      }),
    };
    const { forceSubmitUnit } = load("lib/force-submit-rota.js", {
      "../db": pool,
      "./rota-deadline-settings": {},
      "./configured-assignment-batch": {
        applyValidatedAssignmentBatch: async (db, options) => {
          assert.equal(db, pool);
          calls.push(options);
          if (blocked) throw invalid();
          return { rowCount: 28 };
        },
      },
    });
    const result = await forceSubmitUnit({
      facility: "Demo",
      ward: "ER",
      periodStart: "2044-01-04",
      periodEnd: "2044-01-31",
    });
    assert.equal(result.submitted, !blocked);
    assert.equal(calls[0].body.status, "submitted");
    assert.match(calls[0].where, /status='draft'/);
    assert.equal(calls[0].filterParams[3], "ER");
    if (blocked) assert.equal(result.reason, "CONFIGURED_EDIT_INVALID");
  }
});
for (const mode of ["blocked", "dry", "valid"])
  test(`automatic publish ${mode} uses guarded status writes`, async () => {
    const queries = [],
      batches = [],
      mail = [];
    const pool = {
      query: async (sql) => {
        queries.push(sql);
        return {
          rows: queries.length === 1 ? [{ facility: "Demo", ward: "ER", role: "Nurse" }] : [],
        };
      },
    };
    const { runAutoPublish } = load(
      "jobs/auto-publish-rota.js",
      {
        "node-cron": {},
        "../lib/tenant-context": require("../nurse-api/lib/tenant-context.js"),
        "../db": pool,
        "../lib/rota-period-dates": {
          getUnitPeriod: async () => ({ periodStart: "2044-01-04", periodEnd: "2044-01-31" }),
          getWindowForPeriod: async () => ({ publishIsOverdue: true }),
        },
        "../lib/force-submit-rota": {
          roleGroupOf: () => null,
          resolveUnitNurseIds: async () => ["n1"],
        },
        "../lib/mailer": { sendMail: async (message) => mail.push(message), portalUrl: () => "" },
        "../lib/rota-job-pause": {},
        "../lib/configured-assignment-batch": {
          applyValidatedAssignmentBatch: async (db, options) => {
            batches.push(options);
            if (mode === "blocked") throw invalid();
            return { rowCount: 28 };
          },
        },
      },
      { DRY_RUN_ROTA_JOBS: String(mode === "dry") },
    );
    await runAutoPublish();
    assert.equal(batches.length, mode === "dry" ? 0 : 1);
    if (batches.length) {
      assert.equal(batches[0].body.status, "published");
      assert.match(batches[0].where, /status='cno_approved'/);
    }
    if (mode !== "valid") {
      assert.equal(
        queries.some((sql) => /^(UPDATE|INSERT)/.test(sql.trim())),
        false,
      );
      assert.equal(mail.length, 0);
    }
  });
