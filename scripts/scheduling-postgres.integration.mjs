import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
const require = createRequire(new URL("../nurse-api/package.json", import.meta.url));
const { Pool } = require("pg");
const { createSchedulingConfigurationService } = require("./lib/scheduling-configuration-service");
const connectionString = process.env.SCHEDULING_TEST_DATABASE_URL;
if (!connectionString || !["localhost", "127.0.0.1"].includes(new URL(connectionString).hostname))
  throw new Error("Use test-scheduling-postgres.mjs to create an isolated local database.");
// Production stamps every connection with the hospital being worked in; these
// scenarios run as Iwosan Lagoon Hospital (the hospital created by migration 049).
const tenant = require("./lib/tenant-context");
const LAGOON = "00000000-0000-4000-8000-000000000001";
const pool = tenant.bindTenantPool(new Pool({ connectionString }));
const admin = "10000000-0000-4000-8000-000000000001";
const reader = "10000000-0000-4000-8000-000000000002";
const outsider = "10000000-0000-4000-8000-000000000003";
const service = createSchedulingConfigurationService(pool);
const sentMail = [];
let mailHook = async () => {};
const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
// Apply each migration once, in deploy order; scenarios that name one later are no-ops.
const applied = new Set();
const migrate = async (file) => {
  if (applied.has(file)) return;
  await pool.query(read(`nurse-api/migrations/${file}`));
  applied.add(file);
};
const migrations = readdirSync(new URL("../nurse-api/migrations/", import.meta.url))
  .filter((file) => file.endsWith(".sql"))
  .sort();

test("PostgreSQL migration and scheduling draft API integration", (t) =>
  tenant.runInHospital(LAGOON, () => scenarios(t), admin));

async function scenarios(t) {
  let server;
  try {
    // Fail closed if pointed at anything except an empty disposable database.
    assert.equal(
      (await pool.query("SELECT COUNT(*)::int AS count FROM pg_tables WHERE schemaname = 'public'"))
        .rows[0].count,
      0,
      "Refusing to run against a nonempty database",
    );
    await pool.query(read("schema.sql"));
    // Existing data predates the scheduling migrations (042+), as in production.
    for (const file of migrations.filter((f) => f < "042")) await migrate(file);
    await pool.query("INSERT INTO profiles (id, full_name) VALUES ($1, $4), ($2, $5), ($3, $6)", [
      admin,
      reader,
      outsider,
      "Admin",
      "Reader",
      "Outsider",
    ]);
    await pool.query(
      "INSERT INTO user_roles (user_id, role) VALUES ($1, 'admin'), ($2, 'chief_matron'), ($3, 'admin')",
      [admin, reader, outsider],
    );
    await pool.query(
      "INSERT INTO nurses (name, facility, role, profile_id) VALUES ('Test Reader', 'Ikoyi', 'Nurse', $1)",
      [reader],
    );
    await pool.query(
      "INSERT INTO wards (name, facility, min_morning_nurses, min_night_nurses) VALUES ('GOPD', 'Ikoyi', 7, 1), ('ER', 'Other', 2, 1)",
    );
    await pool.query(
      `INSERT INTO portal_settings (key, value) VALUES ('capabilities', '[{"key":"unrelated","roles":["nurse"]}]')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    for (const file of migrations.filter((f) => f >= "042")) await migrate(file);
    // Outsider is an admin role but has no grant to this organization/facility.
    await pool.query("DELETE FROM scheduling_facility_access WHERE user_id = $1", [outsider]);
    const facilities = (await service.listFacilities(admin)).facilities;
    const a = facilities.find((f) => f.name === "Ikoyi").id;
    const b = facilities.find((f) => f.name === "Other").id;
    let version;
    await t.test("migration preserves capability settings and seeds explicit scope", async () => {
      assert.equal(facilities.length, 2);
      assert.equal((await service.listFacilities(reader)).facilities.length, 1);
      const caps = (await pool.query("SELECT value FROM portal_settings WHERE key='capabilities'"))
        .rows[0].value;
      assert.deepEqual(caps.find((c) => c.key === "unrelated").roles, ["nurse"]);
      assert.ok(caps.some((c) => c.key === "manage_scheduling_configuration"));
    });
    await t.test("seed, read and clone stay draft-only and preserve current minima", async () => {
      version = await service.create(admin, a, {});
      assert.equal(version.status, "draft");
      assert.equal(version.activationAvailable, true);
      assert.equal(
        version.configuration.requirements.find((r) => r.shift === "M" && r.category === "nurse")
          .minimum,
        7,
      );
      assert.equal((await service.getVersion(admin, a, version.id)).revision, 1);
      const clone = await service.create(admin, a, { sourceVersionId: version.id });
      assert.deepEqual(clone.configuration, version.configuration);
      assert.equal(clone.version, 2);
    });
    await t.test("concurrent creates receive unique sequential versions", async () => {
      const created = await Promise.all([
        service.create(admin, a, {}),
        service.create(admin, a, {}),
      ]);
      assert.deepEqual(created.map((c) => c.version).sort(), [3, 4]);
    });
    await t.test("foreign facility reads, clones and references are rejected", async () => {
      await assert.rejects(service.defaults(outsider, a), (e) => e.status === 404);
      await assert.rejects(service.getVersion(reader, b, version.id), (e) => e.status === 404);
      await assert.rejects(
        service.create(admin, b, { sourceVersionId: version.id }),
        (e) => e.status === 404,
      );
      await assert.rejects(
        service.create(admin, b, { configuration: version.configuration }),
        (e) => e.status === 422,
      );
    });
    await t.test("concurrent edits reject the stale revision", async () => {
      const results = await Promise.allSettled(
        [1, 2].map(() =>
          service.update(admin, a, version.id, {
            revision: 1,
            configuration: version.configuration,
          }),
        ),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(results.find((r) => r.status === "rejected").reason.status, 409);
      assert.equal((await service.getVersion(admin, a, version.id)).revision, 2);
    });
    await t.test(
      "database rejects activation, cross-organization identity and archived edits",
      async () => {
        await assert.rejects(
          pool.query(
            "UPDATE scheduling_config_versions SET status='active', revision=revision+1 WHERE id=$1",
            [version.id],
          ),
        );
        await assert.rejects(
          pool.query(
            "UPDATE scheduling_config_versions SET organization_id=gen_random_uuid(), revision=revision+1 WHERE id=$1",
            [version.id],
          ),
        );
        await pool.query(
          "UPDATE scheduling_config_versions SET status='archived', revision=revision+1 WHERE id=$1",
          [version.id],
        );
        await assert.rejects(
          service.update(admin, a, version.id, {
            revision: 3,
            configuration: version.configuration,
          }),
          (e) => e.status === 409,
        );
        await assert.rejects(
          pool.query("DELETE FROM scheduling_config_versions WHERE id=$1", [version.id]),
        );
      },
    );

    // Load the actual router and actual capability middleware with the isolated pool.
    // Authentication is supplied by the harness; production mounts requireAuth first.
    const load = (file, dependencies, globals = {}) => {
      const module = { exports: {} };
      vm.runInNewContext(read(file), {
        module,
        require: (name) => (name in dependencies ? dependencies[name] : require(name)),
        ...globals,
      });
      return module.exports;
    };
    const capability = load("nurse-api/middleware/capability.js", {
      "../db": pool,
      "../lib/tenant-context": tenant,
    });
    const router = load("nurse-api/routes/scheduling-configuration.js", {
      "../db": pool,
      "../middleware/capability": capability,
      "../lib/scheduling-configuration-service": require("./lib/scheduling-configuration-service"),
      "../lib/role-groups": require("./lib/role-groups"),
      "../lib/configured-scheduler": require("./lib/configured-scheduler"),
    });
    const express = require("express");
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = {
        userId: req.headers["x-test-user"] || admin,
        roles: req.headers["x-test-user"] === reader ? ["chief_matron"] : ["admin"],
      };
      tenant.runInHospital(LAGOON, () => next(), req.user.userId);
    });
    app.use("/api/scheduling", router);
    app.use(
      "/api/shift-logs",
      load("nurse-api/routes/shift-logs.js", {
        "../db": pool,
        "../middleware/capability": capability,
        "../lib/period-start": { periodStartForShiftDate: async (date) => date },
        "../lib/configured-attendance": require("./lib/configured-attendance"),
      }),
    );
    app.use(
      "/api/shift-assignments",
      load("nurse-api/routes/shift-assignments.js", {
        "../db": pool,
        "../middleware/capability": capability,
        "../lib/mailer": {
          sendMail: async (message) => {
            sentMail.push(message);
            await mailHook(message);
          },
          portalUrl: () => "",
        },
        "../lib/legacy-generation-guard": require("./lib/legacy-generation-guard"),
        "../lib/assignment-shift-definition": require("./lib/assignment-shift-definition"),
        "../lib/configured-assignment-edit": require("./lib/configured-assignment-edit"),
        "../lib/configured-assignment-swap": require("./lib/configured-assignment-swap"),
        "../lib/configured-assignment-batch": require("./lib/configured-assignment-batch"),
      }),
    );
    app.use(
      "/api/locum",
      load("nurse-api/routes/locum.js", {
        "../db": pool,
        "../middleware/capability": capability,
        "../lib/claim-locum": require("./lib/claim-locum"),
        "../lib/locum-shift-options": require("./lib/locum-shift-options"),
        "../lib/mailer": { sendMail: async () => {}, portalUrl: () => "" },
      }),
    );
    app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}/api/scheduling/facilities/${a}`;
    await t.test("HTTP capability checks allow readers to view but prohibit mutation", async () => {
      assert.equal(
        (await fetch(`${base}/defaults`, { headers: { "x-test-user": reader } })).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${base}/versions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-test-user": reader },
            body: "{}",
          })
        ).status,
        403,
      );
      assert.equal(
        (await fetch(`${base}/defaults`, { headers: { "x-test-user": outsider } })).status,
        404,
      );
    });
    await t.test("HTTP returns structured validation errors and no activation route", async () => {
      const invalid = await fetch(`${base}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ configuration: {} }),
      });
      assert.equal(invalid.status, 422);
      assert.ok((await invalid.json()).errors.length > 0);
      const second = await fetch(`${base}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ configuration: version.configuration }),
      });
      assert.equal(second.status, 409, "One current configuration per facility");
      assert.equal(
        (await fetch(`${base}/versions/${version.id}/activate`, { method: "POST" })).status,
        404,
      );
    });
    await t.test(
      "audit records accompany successful writes; existing assignments untouched",
      async () => {
        assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM audit_logs")).rows[0].n, 5);
        assert.equal(
          (await pool.query("SELECT COUNT(*)::int AS n FROM shift_assignments")).rows[0].n,
          0,
        );
      },
    );
    await t.test(
      "preview scopes staff and leave, checks revisions, and never persists assignments",
      async () => {
        await pool.query("UPDATE nurses SET ward = 'GOPD' WHERE profile_id = $1", [reader]);
        const nurseId = (await pool.query("SELECT id FROM nurses WHERE profile_id = $1", [reader]))
          .rows[0].id;
        await pool.query(
          "INSERT INTO nurses (name, role, ward, facility, is_active) VALUES ('Inactive staff', 'Nurse', 'GOPD', 'Ikoyi', false), ('Other hospital', 'Nurse', 'ER', 'Other', true)",
        );
        const { configuration } = await service.defaults(admin, a);
        configuration.patterns.push({
          id: "custom",
          name: "2 Morning, 2 Night, 3 OFF",
          kind: "repeating",
          steps: [
            { shift: "M", days: 2 },
            { shift: "N", days: 2 },
            { shift: "OFF", days: 3 },
          ],
        });
        Object.assign(
          configuration.roles.find((r) => r.name === "Nurse"),
          { patternId: "custom", useWardPattern: false },
        );
        configuration.wardPolicies.forEach((w) => {
          w.specialRule = "none";
        });
        const draft = await service.create(admin, a, { configuration });
        await pool.query(
          "INSERT INTO leave_requests (nurse_id,nurse_name,type,status,from_date,to_date) VALUES ($1,'Test Reader','Annual','Approved','2026-09-21','2026-09-21')",
          [nurseId],
        );
        const auditCount = (await pool.query("SELECT COUNT(*)::int AS n FROM audit_logs")).rows[0]
          .n;
        const result = await service.preview(admin, a, draft.id, {
          revision: 1,
          startDate: "2026-09-21",
        });
        assert.deepEqual(
          result.staff.map((n) => n.id),
          [nurseId],
        );
        // A mid-month start runs to the end of its rota period (September).
        assert.equal(result.assignments.length, 10);
        assert.equal(result.assignments[0].shift, "LEAVE");
        assert.equal(result.configurationRevision, 1);
        assert.equal(result.activationAvailable, true);
        assert.ok(result.diagnostics.some((d) => d.code === "STAFFING_SHORTFALL"));
        assert.equal(
          (await pool.query("SELECT COUNT(*)::int AS n FROM shift_assignments")).rows[0].n,
          0,
        );
        assert.equal(
          (await pool.query("SELECT COUNT(*)::int AS n FROM audit_logs")).rows[0].n,
          auditCount,
        );
        await assert.rejects(
          service.preview(admin, a, draft.id, { revision: 2, startDate: "2026-09-21" }),
          (e) => e.status === 409,
        );
        await assert.rejects(
          service.preview(outsider, a, draft.id, { revision: 1, startDate: "2026-09-21" }),
          (e) => e.status === 404,
        );
        await assert.rejects(
          service.preview(admin, a, draft.id, { revision: 1, startDate: "2026-02-30" }),
          (e) => e.status === 400,
        );
        const response = await fetch(`${base}/versions/${draft.id}/preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision: 1, startDate: "2026-09-21" }),
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).assignments.length, 10);
        assert.equal(
          (
            await fetch(`${base}/versions/${draft.id}/preview`, {
              method: "POST",
              headers: { "content-type": "application/json", "x-test-user": reader },
              body: JSON.stringify({ revision: 1, startDate: "2026-09-21" }),
            })
          ).status,
          403,
        );
      },
    );
    await t.test("saved coverage rules round-trip and drive read-only previews", async () => {
      const { configuration } = await service.defaults(admin, a);
      const role = configuration.roles.find((r) => r.name === "Nurse");
      role.scope = "facility";
      role.specialRule = "none";
      role.useWardPattern = false;
      configuration.coverageRules = [
        {
          id: "morning_cover",
          name: "Morning cover",
          shift: "M",
          roleIds: [role.id],
          anchorDate: "2026-09-26",
          blockDays: 2,
          repeatDays: 7,
          staffPerBlock: 1,
          restBefore: 1,
          restAfter: 1,
        },
      ];
      const draft = await service.create(admin, a, { configuration });
      assert.deepEqual(draft.configuration.coverageRules, configuration.coverageRules);
      const response = await fetch(`${base}/versions/${draft.id}/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: 1, startDate: "2026-09-21" }),
      });
      assert.equal(response.status, 200);
      const preview = await response.json();
      assert.equal(preview.assignments.find((row) => row.date === "2026-09-26").shift, "M");
      assert.equal(preview.assignments.find((row) => row.date === "2026-09-25").shift, "OFF");
      assert.ok(preview.diagnostics.some((d) => d.code === "FIXED_COVERAGE_ROTATION"));
      assert.equal(
        (await pool.query("SELECT COUNT(*)::int AS n FROM shift_assignments")).rows[0].n,
        0,
      );
    });
    await t.test(
      "saved review runs preserve configuration, inputs and timed output after edits",
      async () => {
        const { configuration } = await service.defaults(admin, a);
        configuration.wardPolicies.forEach((p) => (p.specialRule = "none"));
        const draft = await service.create(admin, a, { configuration });
        const run = await service.saveRun(admin, a, draft.id, {
          revision: 1,
          startDate: "2026-09-21",
        });
        assert.ok(run.runId);
        assert.match(run.inputFingerprint, /^[a-f0-9]{64}$/);
        // 21-30 September: the rest of the monthly rota period.
        assert.equal(run.assignments.length, 10);
        const original = await service.getRun(admin, a, run.runId);
        const config2 = structuredClone(configuration);
        config2.shifts[0].name = "Changed Morning";
        config2.shifts[0].creditedMinutes = 480;
        await service.update(admin, a, draft.id, { revision: 1, configuration: config2 });
        await pool.query("UPDATE nurses SET name='Renamed later' WHERE profile_id=$1", [reader]);
        const reopened = await service.getRun(admin, a, run.runId);
        assert.deepEqual(reopened, original);
        assert.equal(reopened.configurationRevision, 1);
        assert.equal(reopened.shiftDefinitions[0].name, "Morning");
        const {
          rows: [stored],
        } = await pool.query(
          "SELECT configuration_snapshot,input_snapshot FROM scheduling_runs WHERE id=$1",
          [run.runId],
        );
        assert.equal(stored.configuration_snapshot.shifts[0].creditedMinutes, 540);
        assert.ok(stored.input_snapshot.nurses.some((n) => n.name === "Test Reader"));
        await assert.rejects(
          service.saveRun(admin, a, draft.id, { revision: 1, startDate: "2026-09-21" }),
          (e) => e.status === 409,
        );
        await assert.rejects(
          service.saveRun(admin, a, draft.id, {
            revision: 2,
            startDate: "2026-09-21",
            assignments: [],
          }),
          (e) => e.status === 400,
        );
        assert.ok((await service.listRuns(admin, a)).runs.some((r) => r.id === run.runId));
        assert.equal((await service.listRuns(admin, b)).runs.length, 0);
        await assert.rejects(service.getRun(admin, b, run.runId), (e) => e.status === 404);
        await assert.rejects(service.getRun(outsider, a, run.runId), (e) => e.status === 404);
        await assert.rejects(
          pool.query("UPDATE scheduling_runs SET engine_version='changed' WHERE id=$1", [
            run.runId,
          ]),
          /immutable/,
        );
        await assert.rejects(
          pool.query("DELETE FROM scheduling_runs WHERE id=$1", [run.runId]),
          /immutable/,
        );
        const url = `${base}/runs/${run.runId}`;
        assert.equal((await fetch(url)).status, 200);
        assert.equal((await fetch(url, { headers: { "x-test-user": reader } })).status, 403);
        assert.equal((await fetch(url, { headers: { "x-test-user": outsider } })).status, 404);
        const post = await fetch(`${base}/versions/${draft.id}/runs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision: 2, startDate: "2026-09-21" }),
        });
        assert.equal(post.status, 201);
        assert.ok((await post.json()).runId);
        const before = (await pool.query("SELECT COUNT(*)::int AS n FROM scheduling_runs")).rows[0]
          .n;
        await pool.query(
          `CREATE FUNCTION reject_review_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'Scheduling review run saved' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER reject_review_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_review_audit()`,
        );
        try {
          await assert.rejects(
            service.saveRun(admin, a, draft.id, { revision: 2, startDate: "2026-09-21" }),
            /test audit failure/,
          );
        } finally {
          await pool.query(
            "DROP TRIGGER reject_review_audit ON audit_logs; DROP FUNCTION reject_review_audit()",
          );
        }
        assert.equal(
          (await pool.query("SELECT COUNT(*)::int AS n FROM scheduling_runs")).rows[0].n,
          before,
        );
        assert.equal(
          (await pool.query("SELECT COUNT(*)::int AS n FROM shift_assignments")).rows[0].n,
          0,
        );
      },
    );
    await t.test(
      "configured drafts enforce freshness, compatibility, approval protection and provenance",
      async () => {
        const { configuration } = await service.defaults(admin, a);
        configuration.wardPolicies.forEach((p) => (p.specialRule = "none"));
        configuration.requirements.forEach((r) => (r.minimum = 0));
        const draft = await service.create(admin, a, { configuration });
        const body = { revision: 1, startDate: "2026-11-01" };
        const run = await service.saveRun(admin, a, draft.id, body);
        assert.equal(run.hasBlockingIssues, false);
        const url = `${base}/runs/${run.runId}/draft`;
        assert.equal(
          (
            await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json", "x-test-user": reader },
              body: "{}",
            })
          ).status,
          403,
        );
        await assert.rejects(
          service.createDraftFromRun(outsider, a, run.runId, {}),
          (e) => e.status === 404,
        );
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        assert.equal(response.status, 201);
        const saved = await response.json();
        assert.equal(saved.written, 30); // November
        const rows = (
          await pool.query(
            "SELECT * FROM shift_assignments WHERE scheduling_run_id=$1 ORDER BY shift_date",
            [run.runId],
          )
        ).rows;
        assert.equal(rows.length, 30);
        assert.ok(rows.every((r) => r.status === "draft"));
        await pool.query("UPDATE shift_assignments SET status='published' WHERE id=$1", [
          rows[0].id,
        ]);
        assert.equal(
          (
            await pool.query("SELECT scheduling_run_id FROM shift_assignments WHERE id=$1", [
              rows[0].id,
            ])
          ).rows[0].scheduling_run_id,
          run.runId,
        );
        await assert.rejects(
          service.createDraftFromRun(admin, a, run.runId, {}),
          (e) => e.status === 409,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT COUNT(*)::int AS n FROM shift_assignments WHERE scheduling_run_id=$1",
              [run.runId],
            )
          ).rows[0].n,
          30,
        );
        await pool.query(
          "UPDATE shift_assignments SET shift=CASE WHEN shift='OFF' THEN 'M' ELSE 'OFF' END WHERE id=$1",
          [rows[1].id],
        );
        assert.equal(
          (
            await pool.query("SELECT scheduling_run_id FROM shift_assignments WHERE id=$1", [
              rows[1].id,
            ])
          ).rows[0].scheduling_run_id,
          null,
        );
        const later = await service.saveRun(admin, a, draft.id, {
          revision: 1,
          startDate: "2026-12-01",
        });
        await pool.query("UPDATE nurses SET target_hours=target_hours+1 WHERE profile_id=$1", [
          reader,
        ]);
        await assert.rejects(
          service.createDraftFromRun(admin, a, later.runId, {}),
          (e) => e.status === 409,
        );
        const fresh = await service.saveRun(admin, a, draft.id, {
          revision: 1,
          startDate: "2026-12-01",
        });
        const nurseId = fresh.staff[0].id;
        const pending = (
          await pool.query(
            "INSERT INTO leave_requests(nurse_id,nurse_name,type,status,from_date,to_date) VALUES ($1,'Test','Annual','Pending','2026-12-01','2026-12-15') RETURNING id",
            [nurseId],
          )
        ).rows[0].id;
        await assert.rejects(
          service.createDraftFromRun(admin, a, fresh.runId, {}),
          (e) => e.status === 409,
        );
        await pool.query("DELETE FROM leave_requests WHERE id=$1", [pending]);
        // Custom definitions are live-compatible; only non-Lagos timezones remain blocked.
        const custom = structuredClone(configuration);
        custom.timezone = "Europe/London";
        const customDraft = await service.create(admin, a, { configuration: custom });
        const customRun = await service.saveRun(admin, a, customDraft.id, {
          revision: 1,
          startDate: "2026-12-01",
        });
        await assert.rejects(
          service.createDraftFromRun(admin, a, customRun.runId, {}),
          (e) => e.status === 422 && /timezone/.test(e.message),
        );
      },
    );
    await t.test(
      "shared background writer skips races and rolls back partial replacements",
      async () => {
        const { persistRotaDraft } = require("./lib/persist-rota-draft");
        const nurseId = (await pool.query("SELECT id FROM nurses WHERE profile_id=$1", [reader]))
          .rows[0].id;
        const assignments = [
          { nurse_id: nurseId, shift_date: "2040-01-01", shift: "M", ward: "GOPD" },
          { nurse_id: nurseId, shift_date: "2040-01-02", shift: "OFF", ward: "GOPD" },
        ];
        const params = {
          nurseIds: [nurseId],
          startDate: "2040-01-01",
          endDate: "2040-01-02",
          assignments,
          actorName: "Test system",
          onlyIfEmpty: true,
        };
        const write = async (options) => {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            const result = await persistRotaDraft(client, options);
            await client.query("COMMIT");
            return result;
          } catch (e) {
            await client.query("ROLLBACK");
            throw e;
          } finally {
            client.release();
          }
        };
        const results = await Promise.all([write(params), write(params)]);
        assert.deepEqual(results.map((r) => r.written).sort(), [0, 2]);
        const before = (
          await pool.query(
            "SELECT * FROM shift_assignments WHERE nurse_id=$1 AND shift_date BETWEEN '2040-01-01' AND '2040-01-02' ORDER BY shift_date",
            [nurseId],
          )
        ).rows;
        await assert.rejects(
          write({
            ...params,
            onlyIfEmpty: false,
            assignments: [assignments[0], { ...assignments[1], shift: "not a code" }],
          }),
        );
        const after = (
          await pool.query(
            "SELECT * FROM shift_assignments WHERE nurse_id=$1 AND shift_date BETWEEN '2040-01-01' AND '2040-01-02' ORDER BY shift_date",
            [nurseId],
          )
        ).rows;
        assert.deepEqual(after, before);
        await pool.query("UPDATE shift_assignments SET status='submitted' WHERE id=$1", [
          before[0].id,
        ]);
        await assert.rejects(write({ ...params, onlyIfEmpty: false }), /approval|submitted/);
      },
    );
    await t.test(
      "dormant policy event storage preserves scope, history and pause ordering",
      async () => {
        const { policyAt } = require("./lib/scheduling-policy");
        const source = (await service.listRuns(admin, a)).runs[0].id;
        assert.equal(await policyAt(pool, a, "2042-01-01"), null);
        const {
          rows: [active],
        } = await pool.query(
          "INSERT INTO scheduling_policy_events(facility_id,sequence,state,source_run_id,effective_from,period_anchor,created_by) VALUES ($1,1,'active',$2,'2042-01-01','2042-01-01',$3) RETURNING id",
          [a, source, admin],
        );
        assert.equal((await policyAt(pool, a, "2042-01-01")).source_run_id, source);
        assert.equal(await policyAt(pool, a, "2041-12-31"), null);
        await assert.rejects(
          pool.query(
            "INSERT INTO scheduling_policy_events(facility_id,sequence,state,source_run_id,effective_from,period_anchor,created_by) VALUES ($1,1,'active',$2,'2042-01-01','2042-01-01',$3)",
            [b, source, admin],
          ),
          (e) => e.code === "23503",
        );
        await assert.rejects(
          pool.query("UPDATE scheduling_policy_events SET state='paused' WHERE id=$1", [active.id]),
          /immutable/,
        );
        await assert.rejects(
          pool.query("DELETE FROM scheduling_policy_events WHERE id=$1", [active.id]),
          /immutable/,
        );
        await pool.query(
          "INSERT INTO scheduling_policy_events(facility_id,sequence,state,effective_from,period_anchor,created_by) VALUES ($1,2,'paused','1900-01-01','1900-01-01',$2)",
          [a, admin],
        );
        assert.equal((await policyAt(pool, a, "2042-02-01")).state, "paused");
        await pool.query(
          "INSERT INTO scheduling_policy_events(facility_id,sequence,state,source_run_id,effective_from,period_anchor,created_by) VALUES ($1,3,'active',$2,'2042-03-01','2042-03-01',$3)",
          [a, source, admin],
        );
        assert.equal((await policyAt(pool, a, "2042-02-28")).state, "paused");
        assert.equal((await policyAt(pool, a, "2042-03-01")).state, "active");
        assert.equal(await policyAt(pool, b, "2042-03-01"), null);
      },
    );
    await t.test(
      "activation, pinned manual/automatic generation, legacy guards and pause lifecycle",
      async () => {
        const policyBase = base.replace(a, b);
        const post = (path, body = {}, user = admin) =>
          fetch(`${policyBase}/${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-test-user": user },
            body: JSON.stringify(body),
          });
        const { configuration } = await service.defaults(admin, b);
        configuration.requirements.forEach((r) => {
          r.minimum = 0;
          r.maximum = null;
        });
        configuration.wardPolicies.forEach((w) => {
          w.specialRule = "none";
        });
        const draft = await service.create(admin, b, { configuration });
        const DAYS_JAN = 31;
        const run = await service.saveRun(admin, b, draft.id, {
          revision: 1,
          startDate: "2044-01-01",
        });
        assert.equal(run.hasBlockingIssues, false, JSON.stringify(run.diagnostics));
        const ids = run.staff.map((n) => n.id);
        assert.equal((await post(`runs/${run.runId}/activate`, {}, reader)).status, 403);
        assert.equal((await post(`runs/${run.runId}/activate`, {}, outsider)).status, 404);
        assert.equal((await post(`runs/${run.runId}/activate`, { assignments: [] })).status, 400);
        // A saved review cannot be activated after staff inputs change.
        await pool.query("UPDATE nurses SET target_hours=target_hours+1 WHERE id=ANY($1::uuid[])", [
          ids,
        ]);
        assert.equal((await post(`runs/${run.runId}/activate`)).status, 409);
        const fresh = await service.saveRun(admin, b, draft.id, {
          revision: 1,
          startDate: "2044-01-01",
        });
        const activated = await post(`runs/${fresh.runId}/activate`);
        assert.equal(activated.status, 201, JSON.stringify(await activated.json()));
        assert.equal((await service.activePolicy(admin, b, "2043-12-31")).policy, null);
        assert.equal(
          (await service.activePolicy(admin, b, "2044-01-01")).policy.source_run_id,
          fresh.runId,
        );
        assert.equal((await service.initialAutomaticPeriod("Other")).periodStart, fresh.startDate);
        await assert.rejects(
          service.createDraftFromRun(admin, b, fresh.runId, {}),
          (e) => e.status === 409,
        );
        // Source edits never alter the activated snapshot.
        const changed = structuredClone(configuration);
        changed.patterns[0].steps[0].days++;
        changed.shifts[0].name = "Edited shift label";
        await service.update(admin, b, draft.id, { revision: 1, configuration: changed });
        const count = async (table) =>
          (await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;
        const beforeRuns = await count("scheduling_runs"),
          beforeCells = await count("shift_assignments");
        const dry = await service.generateAutomaticUnit({
          facilityName: "Other",
          startDate: fresh.startDate,
          nurseIds: ids,
          dryRun: true,
        });
        assert.equal(dry.written, 0);
        assert.equal(dry.assignments, ids.length * DAYS_JAN);
        assert.equal(await count("scheduling_runs"), beforeRuns);
        assert.equal(await count("shift_assignments"), beforeCells);
        const automatic = await service.generateAutomaticUnit({
          facilityName: "Other",
          startDate: fresh.startDate,
          nurseIds: ids,
        });
        assert.equal(automatic.written, ids.length * DAYS_JAN);
        const stored = (
          await pool.query("SELECT * FROM scheduling_runs WHERE id=$1", [automatic.runId])
        ).rows[0];
        assert.equal(stored.created_by, null);
        assert.equal(stored.generation_source, "automatic");
        assert.deepEqual(stored.configuration_snapshot, configuration);
        assert.deepEqual(stored.result_snapshot.assignments, fresh.assignments);
        const repeated = await service.generateAutomaticUnit({
          facilityName: "Other",
          startDate: fresh.startDate,
          nurseIds: ids,
        });
        assert.equal(repeated.skipped, true);
        assert.equal(await count("scheduling_runs"), beforeRuns + 1);
        const manual = await post("generate-active", { startDate: fresh.startDate, unit: "all" });
        assert.equal(manual.status, 201);
        const manualRun = await service.getRun(admin, b, (await manual.json()).runId);
        assert.deepEqual(manualRun.assignments, fresh.assignments);
        assert.equal(
          (await post("generate-active", { startDate: "2044-01-05", unit: "all" })).status,
          422,
        );
        const legacyBase = base.slice(0, base.indexOf("/api/")) + "/api/shift-assignments";
        const assignmentsResponse = await fetch(
          `${legacyBase}?nurse_ids=${ids.join(",")}&from=${fresh.startDate}&to=${fresh.endDate}&include_shift_definition=true`,
        );
        const assignmentRows = await assignmentsResponse.json();
        assert.equal(assignmentsResponse.status, 200, JSON.stringify(assignmentRows));
        const timed = assignmentRows.find((r) => r.shift === configuration.shifts[0].code);
        assert.ok(timed);
        assert.equal(timed.scheduled_shift.name, configuration.shifts[0].name);
        assert.equal(timed.scheduled_shift.source, "saved_run");
        assert.equal(timed.scheduled_shift.runId, manualRun.runId);
        assert.equal(timed.shift_definition_error, null);
        assert.equal(timed.scheduled_shift.startsAt.slice(0, 10), timed.shift_date);
        assert.equal(timed.configuration_snapshot, undefined);
        const transition = fresh.assignments.slice(0, 2).map((r) => ({
          nurse_id: r.nurseId,
          shift_date: r.date,
          shift: r.shift,
          ward: "ER",
          status: "submitted",
        }));
        const transitionResponse = await fetch(`${legacyBase}/upsert`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(transition),
        });
        assert.equal(
          transitionResponse.status,
          409,
          JSON.stringify(await transitionResponse.json()),
        );
        await pool.query(
          "UPDATE shift_assignments SET status='draft' WHERE nurse_id=ANY($1::uuid[]) AND shift_date BETWEEN $2 AND $3",
          [ids, fresh.startDate, fresh.endDate],
        );
        assert.equal(
          (
            await pool.query(
              "SELECT DISTINCT nurse_role FROM shift_assignments WHERE nurse_id=ANY($1::uuid[]) AND shift_date BETWEEN $2 AND $3",
              [ids, fresh.startDate, fresh.endDate],
            )
          ).rows[0].nurse_role,
          "Nurse",
        );
        const legacyRows = fresh.assignments.slice(0, 2).map((r) => ({
          nurse_id: r.nurseId,
          shift_date: r.date,
          shift: r.shift === "OFF" ? "M" : "OFF",
          ward: "ER",
        }));
        for (const route of ["upsert", "new-staff-upsert"]) {
          const response = await fetch(`${legacyBase}/${route}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(legacyRows),
          });
          assert.equal(response.status, 409, JSON.stringify(await response.json()));
        }
        const remove = await fetch(
          `${legacyBase}?nurse_ids=${ids.join(",")}&from=${fresh.startDate}&to=${fresh.endDate}&status=draft`,
          { method: "DELETE" },
        );
        // Clearing drafts is allowed (Rota "Clear draft"); they are regenerated
        // with the rules in use.
        assert.equal(remove.status, 200);
        assert.equal(await count("shift_assignments"), beforeCells);
        assert.equal(
          (await post("generate-active", { startDate: fresh.startDate, unit: "all" })).status,
          201,
        );
        assert.equal(await count("shift_assignments"), beforeCells + ids.length * DAYS_JAN);
        // Approval changes remain possible; regeneration cannot overwrite them.
        await pool.query(
          "UPDATE shift_assignments SET status='submitted' WHERE nurse_id=ANY($1::uuid[]) AND shift_date=$2",
          [ids, fresh.startDate],
        );
        const savedRunCount = await count("scheduling_runs");
        assert.equal(
          (await post("generate-active", { startDate: fresh.startDate, unit: "all" })).status,
          409,
        );
        assert.equal(await count("scheduling_runs"), savedRunCount);
        // Resume keeps the original period boundary even before any publication.
        assert.equal((await post("pause")).status, 200);
        assert.equal((await service.activePolicy(admin, b, "2044-02-01")).policy.state, "paused");
        const paused = await service.generateAutomaticUnit({
          facilityName: "Other",
          startDate: "2044-02-01",
          nurseIds: ids,
        });
        assert.equal(paused.handled, true);
        assert.equal(paused.skipped, true);
        assert.equal(
          (await post("generate-active", { startDate: "2044-02-01", unit: "all" })).status,
          409,
        );
        assert.equal(await count("scheduling_runs"), savedRunCount);
        const offBoundary = await service.saveRun(admin, b, draft.id, {
          revision: 2,
          startDate: "2044-02-02",
        });
        assert.equal((await post(`runs/${offBoundary.runId}/activate`)).status, 422);
        const resume = await service.saveRun(admin, b, draft.id, {
          revision: 2,
          startDate: "2044-02-01",
        });
        assert.equal((await post(`runs/${resume.runId}/activate`)).status, 201);
        assert.equal((await service.activePolicy(admin, b, "2044-01-31")).policy.state, "paused");
        assert.equal((await service.activePolicy(admin, b, "2044-02-01")).policy.state, "active");
        const {
          rows: [pending],
        } = await pool.query(
          "INSERT INTO leave_requests(nurse_id,nurse_name,type,status,from_date,to_date) VALUES ($1,'Other hospital','Annual','Pending','2044-02-01','2044-02-02') RETURNING id",
          [ids[0]],
        );
        const resumeRuns = await count("scheduling_runs");
        await assert.rejects(
          service.generateAutomaticUnit({
            facilityName: "Other",
            startDate: "2044-02-01",
            nurseIds: ids,
          }),
          (e) => e.status === 409,
        );
        assert.equal(await count("scheduling_runs"), resumeRuns);
        await pool.query("DELETE FROM leave_requests WHERE id=$1", [pending.id]);
        // Current staff mappings can make an activated policy infeasible: fail atomically.
        await pool.query("UPDATE nurses SET role='Unmapped role' WHERE id=$1", [ids[0]]);
        await assert.rejects(
          service.generateAutomaticUnit({
            facilityName: "Other",
            startDate: "2044-02-01",
            nurseIds: ids,
          }),
          (e) => e.status === 422,
        );
        assert.equal(await count("scheduling_runs"), resumeRuns);
        assert.equal(await count("shift_assignments"), beforeCells + ids.length * DAYS_JAN);
        await pool.query("UPDATE nurses SET role='Nurse' WHERE id=$1", [ids[0]]);
        assert.equal(
          (
            await service.generateAutomaticUnit({
              facilityName: "Other",
              startDate: "2044-02-01",
              nurseIds: ids,
            })
          ).written,
          ids.length * 29,
        );
        // A nurse who joins mid-period is scheduled from their first date only,
        // leaving everyone else's already generated cells untouched.
        const {
          rows: [joiner],
        } = await pool.query(
          "INSERT INTO nurses(name,role,ward,facility) VALUES ('Mid-period joiner','Nurse','ER','Other') RETURNING id",
        );
        const others = async () =>
          (
            await pool.query(
              "SELECT id,shift,status,updated_at FROM shift_assignments WHERE nurse_id=ANY($1::uuid[]) AND shift_date BETWEEN '2044-02-01' AND '2044-02-29' ORDER BY id",
              [ids],
            )
          ).rows;
        const before = await others();
        const candidateIds = async () =>
          (await service.addStaffCandidates(admin, b, "2044-02-01")).staff.map((n) => n.id);
        assert.ok((await candidateIds()).includes(joiner.id));
        assert.ok(!(await candidateIds()).includes(ids[0]), "Scheduled staff are not candidates");
        const addBody = { startDate: "2044-02-01", nurseId: joiner.id, fromDate: "2044-02-10" };
        assert.equal((await post("add-staff", addBody, reader)).status, 403);
        assert.equal(
          (await post("add-staff", { ...addBody, fromDate: "2044-03-01" })).status,
          422,
          "First date must be inside the period",
        );
        assert.equal((await post("add-staff", { ...addBody, extra: true })).status, 400);
        const added = await post("add-staff", addBody);
        const addedBody = await added.json();
        assert.equal(added.status, 201, JSON.stringify(addedBody));
        assert.equal(addedBody.written, 20);
        const joinerCells = (
          await pool.query(
            "SELECT shift_date::text,status,scheduling_run_id FROM shift_assignments WHERE nurse_id=$1 ORDER BY shift_date",
            [joiner.id],
          )
        ).rows;
        assert.equal(joinerCells.length, 20);
        assert.equal(joinerCells[0].shift_date, "2044-02-10");
        assert.equal(joinerCells.at(-1).shift_date, "2044-02-29");
        assert.ok(
          joinerCells.every((c) => c.status === "draft" && c.scheduling_run_id === addedBody.runId),
        );
        assert.deepEqual(await others(), before, "Existing staff cells are unchanged");
        assert.ok(!(await candidateIds()).includes(joiner.id));
        assert.equal((await post("add-staff", addBody)).status, 409, "No double scheduling");
        assert.equal(
          (await post("add-staff", { ...addBody, nurseId: ids[0] })).status,
          409,
          "Staff with cells use Rota edits instead",
        );
        await pool.query("UPDATE nurses SET is_active=false WHERE id=$1", [joiner.id]);
        assert.equal((await post("add-staff", { ...addBody, fromDate: "2044-02-05" })).status, 404);
        await pool.query("DELETE FROM shift_assignments WHERE nurse_id=$1", [joiner.id]);
        await pool.query("DELETE FROM nurses WHERE id=$1", [joiner.id]);
      },
    );
    await t.test(
      "generation waiting behind pause rejects its stale transaction snapshot",
      async () => {
        let releaseCommit, pauseReady;
        const ready = new Promise((resolve) => {
          pauseReady = resolve;
        });
        const release = new Promise((resolve) => {
          releaseCommit = resolve;
        });
        const delayedPool = {
          query: pool.query.bind(pool),
          connect: async () => {
            const db = await pool.connect();
            return {
              query: async (sql, params) => {
                if (sql === "COMMIT") {
                  pauseReady();
                  await release;
                }
                return db.query(sql, params);
              },
              release: () => db.release(),
            };
          },
        };
        const pausing = createSchedulingConfigurationService(delayedPool).pauseScheduling(
          admin,
          b,
          {},
        );
        await ready;
        const ids = (
          await pool.query("SELECT id FROM nurses WHERE facility='Other' AND is_active=true")
        ).rows.map((n) => n.id);
        const generating = service.generateAutomaticUnit({
          facilityName: "Other",
          startDate: "2044-03-01",
          nurseIds: ids,
        });
        const rejected = assert.rejects(generating, (e) => e.status === 409);
        let waiting = false;
        try {
          for (let attempt = 0; attempt < 100; attempt++) {
            waiting =
              (
                await pool.query(
                  "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT * FROM scheduling_facilities WHERE legacy_facility=%'",
                )
              ).rows.length > 0;
            if (waiting) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        } finally {
          releaseCommit();
        }
        await pausing;
        await rejected;
        assert.equal(waiting, true, "Generator must have waited behind pause");
        assert.equal((await service.activePolicy(admin, b, "2044-02-29")).policy.state, "paused");
      },
    );
    await t.test(
      "configured attendance pins definitions across leave edits and credits hours once",
      async () => {
        const {
          rows: [cell],
        } = await pool.query(
          "SELECT a.*,a.shift_date::text FROM shift_assignments a JOIN nurses n ON n.id=a.nurse_id WHERE n.facility='Other' AND a.shift='M' ORDER BY a.shift_date LIMIT 1",
        );
        assert.ok(cell.shift_definition_run_id);
        await pool.query("UPDATE shift_assignments SET status='published' WHERE id=$1", [cell.id]);
        const { withAssignmentShiftDefinitions } = require("./lib/assignment-shift-definition");
        const [resolved] = await withAssignmentShiftDefinitions(pool, [cell]);
        const definition = resolved.scheduled_shift;
        const logsBase = base.slice(0, base.indexOf("/api/")) + "/api/shift-logs";
        const postBody = {
          nurse_id: cell.nurse_id,
          shift_date: cell.shift_date,
          shift_type: "M",
          started_at: definition.startsAt,
          expected_end_at: "2099-01-01T00:00:00Z",
          hours_logged: 999,
          scheduling_definition: { creditedMinutes: 99999 },
        };
        const start = await fetch(logsBase, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(postBody),
        });
        const log = await start.json();
        assert.equal(start.status, 201, JSON.stringify(log));
        assert.equal(log.expected_end_at, definition.endsAt);
        assert.equal(log.hours_logged, null);
        assert.deepEqual(log.scheduling_definition, definition);
        await pool.query(
          "UPDATE shift_assignments SET shift='LEAVE',pre_leave_shift='M',leave_type='Annual' WHERE id=$1",
          [cell.id],
        );
        const edited = (
          await pool.query("SELECT *,shift_date::text FROM shift_assignments WHERE id=$1", [
            cell.id,
          ])
        ).rows[0];
        assert.equal(edited.scheduling_run_id, null);
        assert.equal(edited.shift_definition_run_id, cell.shift_definition_run_id);
        assert.deepEqual(
          (await withAssignmentShiftDefinitions(pool, [edited]))[0].scheduled_shift,
          definition,
        );
        const forbiddenStart = await fetch(logsBase, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(postBody),
        });
        assert.equal(forbiddenStart.status, 409);
        const before = Number(
          (await pool.query("SELECT hours_this_month FROM nurses WHERE id=$1", [cell.nurse_id]))
            .rows[0].hours_this_month,
        );
        const end = async (user = admin, ended_at = definition.endsAt) =>
          fetch(`${logsBase}/${log.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json", "x-test-user": user },
            body: JSON.stringify({ ended_at, hours_logged: 999 }),
          });
        assert.equal((await end(reader)).status, 404);
        const concurrentEnds = await Promise.all([end(), end()]);
        const finished = concurrentEnds[0];
        assert.equal(concurrentEnds[1].status, 200);
        const saved = await finished.json();
        assert.equal(finished.status, 200, JSON.stringify(saved));
        assert.equal(Number(saved.hours_logged), definition.creditedMinutes / 60);
        assert.equal(saved.hours_credited_by_server, true);
        assert.equal((await end()).status, 200);
        assert.equal(
          Number(
            (await pool.query("SELECT hours_this_month FROM nurses WHERE id=$1", [cell.nurse_id]))
              .rows[0].hours_this_month,
          ),
          before + definition.creditedMinutes / 60,
        );
        const correctedEnd = new Date(Date.parse(definition.endsAt) - 3600000).toISOString();
        assert.equal((await end(admin, correctedEnd)).status, 200);
        assert.equal(
          Number(
            (await pool.query("SELECT hours_this_month FROM nurses WHERE id=$1", [cell.nurse_id]))
              .rows[0].hours_this_month,
          ),
          before + definition.creditedMinutes / 60 - 1,
        );
      },
    );
    await t.test("SQL auto-end credit matches manual attendance arithmetic", async () => {
      const { creditedAttendanceHours } = require("./lib/configured-attendance");
      const definition = {
        startsAt: "2044-01-04T19:00:00Z",
        endsAt: "2044-01-05T03:30:00Z",
        breakMinutes: 30,
        creditedMinutes: 480,
      };
      for (const start of [
        "2044-01-04T18:00:00Z",
        "2044-01-04T20:00:00Z",
        "2044-01-05T03:20:00Z",
      ]) {
        const {
          rows: [row],
        } = await pool.query(
          "SELECT configured_attendance_hours($1::jsonb,$2::timestamptz,$3::timestamptz) AS hours",
          [JSON.stringify(definition), start, definition.endsAt],
        );
        assert.equal(
          Number(row.hours),
          creditedAttendanceHours(definition, start, definition.endsAt),
        );
      }
    });
    await t.test(
      "configured end rolls back attendance and counter together on credit failure",
      async () => {
        const { updateConfiguredAttendance } = require("./lib/configured-attendance");
        const {
          rows: [before],
        } = await pool.query(
          "SELECT * FROM shift_logs WHERE scheduling_definition IS NOT NULL LIMIT 1",
        );
        const failingPool = {
          connect: async () => {
            const db = await pool.connect();
            return {
              query: (sql, params) => {
                if (sql.includes("increment_nurse_hours"))
                  throw new Error("Injected counter failure");
                return db.query(sql, params);
              },
              release: () => db.release(),
            };
          },
        };
        await assert.rejects(
          updateConfiguredAttendance(failingPool, before.id, admin, true, {
            ended_at: before.scheduling_definition.endsAt,
          }),
          /Injected counter failure/,
        );
        const after = (await pool.query("SELECT * FROM shift_logs WHERE id=$1", [before.id]))
          .rows[0];
        assert.deepEqual(after, before);
      },
    );
    await t.test(
      "configured reminder query respects publication, attendance and saved boundaries",
      async () => {
        const { configuredShiftReminders } = require("./lib/configured-shift-reminders");
        const { withAssignmentShiftDefinitions } = require("./lib/assignment-shift-definition");
        const db = await pool.connect();
        try {
          await db.query("BEGIN");
          const {
            rows: [cell],
          } = await db.query(`SELECT a.*,a.shift_date::text FROM shift_assignments a
          WHERE a.shift='M' AND a.shift_definition_run_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM shift_logs l WHERE l.nurse_id=a.nurse_id AND l.shift_date=a.shift_date)
          ORDER BY a.shift_date LIMIT 1`);
          assert.ok(cell);
          await db.query("UPDATE nurses SET profile_id=$1 WHERE id=$2", [admin, cell.nurse_id]);
          const [resolved] = await withAssignmentShiftDefinitions(db, [cell]);
          const now = new Date(Date.parse(resolved.scheduled_shift.startsAt) - 15 * 60000);
          await db.query("UPDATE shift_assignments SET status='draft' WHERE id=$1", [cell.id]);
          assert.ok(
            !(await configuredShiftReminders(db, "start", 15, now)).rows.some(
              (row) => row.id === cell.id,
            ),
          );
          await db.query("UPDATE shift_assignments SET status='published' WHERE id=$1", [cell.id]);
          assert.ok(
            (await configuredShiftReminders(db, "start", 15, now)).rows.some(
              (row) => row.id === cell.id,
            ),
          );
          assert.ok(
            !(
              await configuredShiftReminders(
                db,
                "missed",
                3,
                new Date(resolved.scheduled_shift.endsAt),
              )
            ).rows.some((row) => row.id === cell.id),
          );
          await db.query(
            `INSERT INTO shift_logs(nurse_id,shift_date,shift_type,started_at,expected_end_at,period_start)
          VALUES ($1,$2,'M',$3,$4,$2)`,
            [
              cell.nurse_id,
              cell.shift_date,
              resolved.scheduled_shift.startsAt,
              resolved.scheduled_shift.endsAt,
            ],
          );
          assert.ok(
            !(await configuredShiftReminders(db, "start", 15, now)).rows.some(
              (row) => row.id === cell.id,
            ),
          );
        } finally {
          await db.query("ROLLBACK");
          db.release();
        }
      },
    );
    await t.test(
      "configured missed shifts wait for saved end and concurrent runs record once",
      async () => {
        const { recordConfiguredMissedShifts } = require("./lib/configured-missed-shifts");
        const { withAssignmentShiftDefinitions } = require("./lib/assignment-shift-definition");
        const {
          rows: [cell],
        } = await pool.query(`SELECT a.*,a.shift_date::text FROM shift_assignments a
        WHERE a.shift='M' AND a.shift_definition_run_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM shift_logs l WHERE l.nurse_id=a.nurse_id AND l.shift_date=a.shift_date)
        ORDER BY a.shift_date LIMIT 1`);
        assert.ok(cell);
        await pool.query("UPDATE shift_assignments SET status='published' WHERE id=$1", [cell.id]);
        const [resolved] = await withAssignmentShiftDefinitions(pool, [cell]);
        const before = new Date(Date.parse(resolved.scheduled_shift.endsAt) - 1);
        const logs = async () =>
          (
            await pool.query("SELECT * FROM shift_logs WHERE nurse_id=$1 AND shift_date=$2", [
              cell.nurse_id,
              cell.shift_date,
            ])
          ).rows;
        await recordConfiguredMissedShifts(pool, before);
        assert.equal((await logs()).length, 0);
        const end = new Date(resolved.scheduled_shift.endsAt);
        await Promise.all([
          recordConfiguredMissedShifts(pool, end),
          recordConfiguredMissedShifts(pool, end),
        ]);
        await recordConfiguredMissedShifts(pool, end);
        const saved = await logs();
        assert.equal(saved.length, 1);
        assert.equal(saved[0].is_missed, true);
        assert.equal(Number(saved[0].hours_logged), 0);
        assert.equal(saved[0].ended_at.toISOString(), end.toISOString());
        assert.deepEqual(saved[0].scheduling_definition, resolved.scheduled_shift);
      },
    );
    await t.test("rota periods are calendar months after any legacy 28-day periods", async () => {
      const db = await pool.connect();
      const period = async (d) =>
        (
          await db.query(
            "SELECT rota_period_start($1::date)::text AS start, rota_period_end($1::date)::text AS end",
            [d],
          )
        ).rows[0];
      try {
        await db.query("BEGIN");
        await db.query(
          "UPDATE hospitals SET legacy_period_anchor=NULL, legacy_period_until=NULL WHERE id=app_current_hospital()",
        );
        assert.deepEqual(await period("2027-02-14"), { start: "2027-02-01", end: "2027-02-28" });
        assert.deepEqual(await period("2028-02-29"), { start: "2028-02-01", end: "2028-02-29" });
        assert.deepEqual(await period("2026-12-31"), { start: "2026-12-01", end: "2026-12-31" });
        // Legacy periods 24 Aug-20 Sep and 21 Sep-18 Oct finish as they are; the
        // rest of October is one transition period, then calendar months.
        await db.query(
          "UPDATE hospitals SET legacy_period_anchor='2026-08-24', legacy_period_until='2026-10-18' WHERE id=app_current_hospital()",
        );
        assert.deepEqual(await period("2026-08-24"), { start: "2026-08-24", end: "2026-09-20" });
        assert.deepEqual(await period("2026-10-18"), { start: "2026-09-21", end: "2026-10-18" });
        assert.deepEqual(await period("2026-10-19"), { start: "2026-10-19", end: "2026-10-31" });
        assert.deepEqual(await period("2026-10-31"), { start: "2026-10-19", end: "2026-10-31" });
        assert.deepEqual(await period("2026-11-01"), { start: "2026-11-01", end: "2026-11-30" });
        await assert.rejects(
          db.query("UPDATE hospitals SET legacy_period_until=NULL WHERE id=app_current_hospital()"),
          /hospitals_legacy_periods/,
        );
      } finally {
        await db.query("ROLLBACK");
        db.release();
      }
    });
    await t.test(
      "archive resolves saved windows and closes completed periods transactionally",
      async () => {
        const { periodShiftReadiness } = require("./lib/period-shift-readiness");
        const {
          rows: [source],
        } = await pool.query(
          "SELECT nurse_id,shift_definition_run_id FROM shift_assignments WHERE shift_definition_run_id IS NOT NULL LIMIT 1",
        );
        const {
          rows: [cell],
        } = await pool.query(
          `INSERT INTO shift_assignments(nurse_id,shift_date,shift,status,shift_definition_run_id)
        VALUES ($1,'2000-01-01','M','published',$2) RETURNING *,shift_date::text`,
          [source.nurse_id, source.shift_definition_run_id],
        );
        const db = await pool.connect();
        try {
          await db.query("BEGIN");
          assert.equal(
            (
              await periodShiftReadiness(
                db,
                "2000-01-01",
                "2000-01-28",
                new Date("2000-01-01T06:00:00Z"),
              )
            ).ready,
            false,
          );
          assert.equal(
            (
              await periodShiftReadiness(
                db,
                "2000-01-01",
                "2000-01-28",
                new Date("2000-01-29T00:00:00Z"),
              )
            ).ready,
            true,
          );
          await db.query("ROLLBACK");
        } finally {
          db.release();
        }
        await pool.query(
          `INSERT INTO shift_logs(nurse_id,shift_date,shift_type,started_at,expected_end_at,period_start)
        VALUES ($1,'2000-01-01','M','2000-01-01T07:00:00Z','2000-01-01T16:00:00Z','2000-01-01')`,
          [cell.nurse_id],
        );
        const module = { exports: {} };
        vm.runInNewContext(read("nurse-api/lib/auto-close-period.js"), {
          module,
          require: (name) => (name === "../db" ? pool : { periodShiftReadiness }),
        });
        const result = await module.exports.closeCompletedPeriod();
        assert.equal(result.closed, true);
        assert.equal(result.period_start, "2000-01-01");
        assert.equal(result.period_end, "2000-01-31", "Periods are calendar months");
        const {
          rows: [archive],
        } = await pool.query(
          "SELECT * FROM nurse_period_hours WHERE nurse_id=$1 AND period_start='2000-01-01'",
          [cell.nurse_id],
        );
        assert.equal(Number(archive.total_hours), 9);
        assert.equal(archive.total_shifts, 1);
      },
    );
    await t.test(
      "archived assigned-hour query scopes nurses and periods without shifting dates",
      async () => {
        const { withPeriodAssignedHours } = require("./lib/period-assigned-hours");
        const { rows } = await pool.query(
          "SELECT *,period_start::text,period_end::text FROM nurse_period_hours WHERE period_start='2000-01-01'",
        );
        assert.ok(rows.length);
        const totals = await withPeriodAssignedHours(pool, rows);
        assert.equal(
          totals.reduce((sum, row) => sum + row.assigned_hours, 0),
          9,
        );
        assert.ok(totals.every((row) => row.assigned_hours_error === null));
      },
    );
    await t.test(
      "assignment staffing metadata resolves saved requirements without exposing run inputs",
      async () => {
        const { withAssignmentShiftDefinitions } = require("./lib/assignment-shift-definition");
        const { rows } = await pool.query(
          "SELECT *,shift_date::text FROM shift_assignments WHERE ward IS NOT NULL AND shift_definition_run_id IS NOT NULL LIMIT 1",
        );
        assert.equal(rows.length, 1);
        const [resolved] = await withAssignmentShiftDefinitions(pool, rows, {
          includeStaffing: true,
        });
        assert.equal(resolved.scheduled_staffing.error, null);
        assert.ok(Array.isArray(resolved.scheduled_staffing.requirements));
        assert.ok(
          resolved.scheduled_staffing.requirements.every(
            (r) => r.wardId === resolved.scheduled_staffing.wardId,
          ),
        );
        assert.equal(resolved.input_snapshot, undefined);
        assert.equal(resolved.configuration_snapshot, undefined);
      },
    );
    await t.test(
      "individual configured edits enforce saved choices and retain definition identity",
      async () => {
        const {
          rows: [cell],
        } = await pool.query(
          "SELECT * FROM shift_assignments WHERE shift_definition_run_id IS NOT NULL AND ward IS NOT NULL LIMIT 1",
        );
        const url = base.slice(0, base.indexOf("/api/")) + "/api/shift-assignments/" + cell.id;
        const patch = (shift) =>
          fetch(url, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ shift }),
          });
        await pool.query("UPDATE shift_assignments SET status='published' WHERE id=$1", [cell.id]);
        assert.equal((await patch("OFF")).status, 409);
        await pool.query("UPDATE shift_assignments SET status='draft' WHERE id=$1", [cell.id]);
        assert.equal((await patch("INVALID")).status, 409);
        const saved = await patch("OFF");
        assert.equal(saved.status, 200, await saved.text());
        const {
          rows: [after],
        } = await pool.query("SELECT * FROM shift_assignments WHERE id=$1", [cell.id]);
        assert.equal(after.shift, "OFF");
        assert.equal(after.shift_definition_run_id, cell.shift_definition_run_id);
      },
    );
    await t.test(
      "configured swap rolls back both cells and concurrent retries cannot swap back",
      async () => {
        const { swapConfiguredAssignments } = require("./lib/configured-assignment-swap");
        const {
          rows: [source],
        } =
          await pool.query(`SELECT sa.*,r.configuration_snapshot,n.facility FROM shift_assignments sa
        JOIN scheduling_runs r ON r.id=sa.shift_definition_run_id JOIN nurses n ON n.id=sa.nurse_id
        WHERE sa.ward IS NOT NULL LIMIT 1`);
        const role = source.configuration_snapshot.roles.find((r) =>
          r.allowedShifts.includes("M"),
        ).name;
        const { rows: nurses } = await pool.query(
          "INSERT INTO nurses(name,role,ward,facility) VALUES ('Swap A',$1,$2,$3),('Swap B',$1,$2,$3) RETURNING id",
          [role, source.ward, source.facility],
        );
        const { rows: cells } = await pool.query(
          `INSERT INTO shift_assignments(nurse_id,ward,shift_date,shift,status,nurse_role,shift_definition_run_id)
        VALUES ($1,$3,'2090-01-01','M','draft',$4,$5),($2,$3,'2090-01-01','OFF','draft',$4,$5) RETURNING *`,
          [nurses[0].id, nurses[1].id, source.ward, role, source.shift_definition_run_id],
        );
        const expected = cells.map((c) => ({
          id: c.id,
          shift: c.shift,
          definitionRunId: c.shift_definition_run_id,
        }));
        const actor = { userId: admin, name: "Admin" };
        await assert.rejects(
          swapConfiguredAssignments(pool, expected, actor, async () => false),
          (e) => e.status === 403,
        );
        const failingPool = {
          connect: async () => {
            const db = await pool.connect();
            return {
              query: (sql, args) => {
                if (sql.includes("INSERT INTO audit_logs"))
                  throw new Error("Injected swap audit failure");
                return db.query(sql, args);
              },
              release: () => db.release(),
            };
          },
        };
        await assert.rejects(
          swapConfiguredAssignments(failingPool, expected, actor, async () => true),
          /Injected swap audit failure/,
        );
        const getCells = async () =>
          (
            await pool.query(
              "SELECT id,shift,shift_definition_run_id FROM shift_assignments WHERE id=ANY($1::uuid[])",
              [cells.map((c) => c.id)],
            )
          ).rows;
        for (const c of await getCells())
          assert.equal(c.shift, cells.find((original) => original.id === c.id).shift);
        const url = base.slice(0, base.indexOf("/api/")) + "/api/shift-assignments/configured-swap";
        const request = () =>
          fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ assignments: expected }),
          });
        const responses = await Promise.all([request(), request()]);
        assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
        for (const c of await getCells()) {
          assert.equal(
            c.shift,
            cells.find((original) => original.id === c.id).shift === "M" ? "OFF" : "M",
          );
          assert.equal(c.shift_definition_run_id, source.shift_definition_run_id);
        }
      },
    );
    await t.test(
      "bulk edits and forward transitions reject invalid configured cells atomically",
      async () => {
        const { rows: cells } = await pool.query(
          "SELECT * FROM shift_assignments WHERE shift_date='2090-01-01' ORDER BY id",
        );
        assert.equal(cells.length, 2);
        const ids = cells.map((c) => c.id);
        const nurses = cells.map((c) => c.nurse_id);
        const url =
          base.slice(0, base.indexOf("/api/")) +
          "/api/shift-assignments?nurse_ids=" +
          nurses.join(",") +
          "&shift_date_from=2090-01-01&shift_date_to=2090-01-01&status=draft";
        const patch = (body) =>
          fetch(url, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
        const readCells = async () =>
          (
            await pool.query(
              "SELECT * FROM shift_assignments WHERE id=ANY($1::uuid[]) ORDER BY id",
              [ids],
            )
          ).rows;
        assert.equal((await patch({ shift: "INVALID" })).status, 409);
        assert.deepEqual(
          (await readCells()).map((c) => c.shift),
          cells.map((c) => c.shift),
        );
        await pool.query(
          "UPDATE shift_assignments SET nurse_role='Missing saved role' WHERE id=$1",
          [ids[1]],
        );
        assert.equal((await patch({ status: "submitted" })).status, 409);
        assert.ok((await readCells()).every((c) => c.status === "draft"));
        await pool.query("UPDATE shift_assignments SET nurse_role=$2 WHERE id=$1", [
          ids[1],
          cells[1].nurse_role,
        ]);
        const good = await patch({ shift: "OFF" });
        assert.equal(good.status, 200, await good.text());
        assert.ok((await readCells()).every((c) => c.shift === "OFF"));
        const { applyValidatedAssignmentBatch } = require("./lib/configured-assignment-batch");
        await assert.rejects(
          applyValidatedAssignmentBatch(pool, {
            where: "WHERE id=ANY($1::uuid[])",
            filterParams: [ids],
            updateSql: "UPDATE shift_assignments SET shift='M' WHERE id=ANY($1::uuid[])",
            updateParams: [ids],
            body: { shift: "M" },
            authorize: async () => true,
            after: async () => {
              throw new Error("Injected leave reapply failure");
            },
          }),
          /Injected leave reapply failure/,
        );
        assert.ok((await readCells()).every((c) => c.shift === "OFF"));
      },
    );
    await t.test("batch rest failure rolls back every selected status", async () => {
      const {
        rows: [source],
      } = await pool.query(
        "SELECT * FROM shift_assignments WHERE shift_date='2090-01-01' ORDER BY id LIMIT 1",
      );
      await pool.query("UPDATE shift_assignments SET shift='N' WHERE id=$1", [source.id]);
      const {
        rows: [next],
      } = await pool.query(
        `INSERT INTO shift_assignments (nurse_id,nurse_role,ward,shift_date,shift,status,shift_definition_run_id)
         VALUES ($1,$2,$3,'2090-01-02','M','draft',$4) RETURNING id`,
        [
          source.nurse_id,
          source.nurse_role,
          source.ward,
          source.shift_definition_run_id ?? source.scheduling_run_id,
        ],
      );
      try {
        const { applyValidatedAssignmentBatch } = require("./lib/configured-assignment-batch");
        const ids = [source.id, next.id];
        await assert.rejects(
          applyValidatedAssignmentBatch(pool, {
            where: "WHERE id=ANY($1::uuid[])",
            filterParams: [ids],
            updateSql: "UPDATE shift_assignments SET status='submitted' WHERE id=ANY($1::uuid[])",
            updateParams: [ids],
            body: { status: "submitted" },
          }),
          /overlap or leave no rest/,
        );
        const { rows } = await pool.query(
          "SELECT status FROM shift_assignments WHERE id=ANY($1::uuid[])",
          [ids],
        );
        assert.ok(rows.every((row) => row.status === "draft"));
        await assert.rejects(
          applyValidatedAssignmentBatch(pool, {
            where: "WHERE id=ANY($1::uuid[])",
            filterParams: [[next.id]],
            updateSql: "UPDATE shift_assignments SET status='submitted' WHERE id=ANY($1::uuid[])",
            updateParams: [[next.id]],
            body: { status: "submitted" },
          }),
          /overlap or leave no rest/,
        );
        const { rows: unchanged } = await pool.query(
          "SELECT status FROM shift_assignments WHERE id=ANY($1::uuid[])",
          [ids],
        );
        assert.ok(unchanged.every((row) => row.status === "draft"));
      } finally {
        await pool.query("DELETE FROM shift_assignments WHERE id=$1", [next.id]);
        await pool.query("UPDATE shift_assignments SET shift=$2 WHERE id=$1", [
          source.id,
          source.shift,
        ]);
      }
    });
    await t.test(
      "automatic submission applies saved-role guards before changing any cells",
      async () => {
        const { forceSubmitUnit } = load("nurse-api/lib/force-submit-rota.js", {
          "../db": pool,
          "./rota-deadline-settings": {},
          "./configured-assignment-batch": require("./lib/configured-assignment-batch"),
        });
        const { rows: cells } = await pool.query(
          "SELECT sa.*,n.facility FROM shift_assignments sa JOIN nurses n ON n.id=sa.nurse_id WHERE sa.shift_date='2090-01-01' ORDER BY sa.id",
        );
        const unit = {
          facility: cells[0].facility,
          ward: cells[0].ward,
          periodStart: "2090-01-01",
          periodEnd: "2090-01-28",
        };
        await pool.query(
          "UPDATE shift_assignments SET nurse_role='Missing saved role' WHERE id=$1",
          [cells[1].id],
        );
        const blocked = await forceSubmitUnit(unit);
        assert.equal(blocked.submitted, false);
        assert.equal(blocked.reason, "CONFIGURED_EDIT_INVALID");
        assert.ok(
          (
            await pool.query("SELECT status FROM shift_assignments WHERE id=ANY($1::uuid[])", [
              cells.map((c) => c.id),
            ])
          ).rows.every((c) => c.status === "draft"),
        );
        await pool.query("UPDATE shift_assignments SET nurse_role=$2 WHERE id=$1", [
          cells[1].id,
          cells[1].nurse_role,
        ]);
        const result = await forceSubmitUnit({ ...unit, periodEnd: "2090-01-01" });
        assert.equal(result.submitted, true);
        assert.equal(result.count, 2);
      },
    );
    await t.test(
      "saved ward minima shortfalls do not block publication",
      async () => {
        const { rows: cells } = await pool.query(
          "SELECT * FROM shift_assignments WHERE shift_date='2090-01-01' ORDER BY id",
        );
        const {
          rows: [source],
        } = await pool.query("SELECT * FROM scheduling_runs WHERE id=$1", [
          cells[0].shift_definition_run_id,
        ]);
        const config = structuredClone(source.configuration_snapshot);
        const ward = source.input_snapshot.wards.find((w) => w.name === cells[0].ward);
        const role = config.roles.find((r) => r.name === cells[0].nurse_role);
        config.requirements = Array.from({ length: 7 }, (_, i) => ({
          wardId: ward.id,
          weekday: i + 1,
          shift: "M",
          category: role.category,
          minimum: 1,
          maximum: 1,
        }));
        const {
          rows: [saved],
        } = await pool.query(
          `INSERT INTO scheduling_runs
        (organization_id,facility_id,configuration_id,configuration_version,configuration_revision,
         start_date,end_date,engine_version,input_fingerprint,configuration_snapshot,input_snapshot,result_snapshot,created_by)
        SELECT organization_id,facility_id,configuration_id,configuration_version,configuration_revision,
         start_date,end_date,engine_version,input_fingerprint,$2::jsonb,input_snapshot,result_snapshot,created_by
        FROM scheduling_runs WHERE id=$1 RETURNING id`,
          [source.id, JSON.stringify(config)],
        );
        const ids = cells.map((c) => c.id);
        await pool.query(
          "UPDATE shift_assignments SET shift_definition_run_id=$2,shift='OFF',status='submitted' WHERE id=ANY($1::uuid[])",
          [ids, saved.id],
        );
        const { applyValidatedAssignmentBatch } = require("./lib/configured-assignment-batch");
        const publish = () =>
          applyValidatedAssignmentBatch(pool, {
            where: "WHERE id=ANY($1::uuid[])",
            filterParams: [ids],
            updateSql: "UPDATE shift_assignments SET status='published' WHERE id=ANY($1::uuid[])",
            updateParams: [ids],
            body: { status: "published" },
          });
        // Nobody is on M against a minimum of 1: reported, not blocking.
        await publish();
        assert.ok(
          (
            await pool.query("SELECT status FROM shift_assignments WHERE id=ANY($1::uuid[])", [ids])
          ).rows.every((r) => r.status === "published"),
        );
      },
    );
    await t.test(
      "single configured approval enforces rest and transition rules but not staffing",
      async () => {
        const { rows: cells } = await pool.query(
          "SELECT * FROM shift_assignments WHERE shift_date='2090-01-01' ORDER BY id",
        );
        const cell = cells[0];
        await pool.query(
          "UPDATE shift_assignments SET status='cno_approved',shift='OFF' WHERE id=ANY($1::uuid[])",
          [cells.map((c) => c.id)],
        );
        const patch = (body) =>
          fetch(base.slice(0, base.indexOf("/api/")) + "/api/shift-assignments/" + cell.id, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
        assert.equal((await patch({ status: "published", shift: "M" })).status, 400);
        assert.equal((await patch({ status: "submitted" })).status, 400);
        const shortage = await patch({ status: "published" });
        assert.equal(shortage.status, 200, await shortage.text());
        await pool.query("UPDATE shift_assignments SET status='cno_approved' WHERE id=$1", [
          cell.id,
        ]);
        await pool.query("UPDATE shift_assignments SET shift='M' WHERE id=$1", [cell.id]);
        const {
          rows: [night],
        } = await pool.query(
          `INSERT INTO shift_assignments
        (nurse_id,nurse_role,ward,shift_date,shift,status,shift_definition_run_id)
        VALUES ($1,$2,$3,'2089-12-31','N','published',$4) RETURNING id`,
          [cell.nurse_id, cell.nurse_role, cell.ward, cell.shift_definition_run_id],
        );
        const noRest = await patch({ status: "published" });
        assert.equal(noRest.status, 409, await noRest.text());
        assert.equal(
          (await pool.query("SELECT status FROM shift_assignments WHERE id=$1", [cell.id])).rows[0]
            .status,
          "cno_approved",
        );
        await pool.query("DELETE FROM shift_assignments WHERE id=$1", [night.id]);
        const success = await patch({ status: "published" });
        assert.equal(success.status, 200, await success.text());
        assert.equal(
          (await pool.query("SELECT status FROM shift_assignments WHERE id=$1", [cell.id])).rows[0]
            .status,
          "published",
        );
      },
    );
    await t.test("bulk configured duty edits cannot mutate approved cells", async () => {
      const { rows: cells } = await pool.query(
        "SELECT id,shift,status FROM shift_assignments WHERE shift_date='2090-01-01' ORDER BY id",
      );
      const ids = cells.map((c) => c.id);
      const { applyValidatedAssignmentBatch } = require("./lib/configured-assignment-batch");
      await assert.rejects(
        applyValidatedAssignmentBatch(pool, {
          where: "WHERE id=ANY($1::uuid[])",
          filterParams: [ids],
          updateSql:
            "UPDATE shift_assignments SET shift='OFF',status='draft' WHERE id=ANY($1::uuid[])",
          updateParams: [ids],
          body: { shift: "OFF", status: "draft" },
          authorize: async () => true,
        }),
        /Return.*draft/,
      );
      assert.deepEqual(
        (
          await pool.query(
            "SELECT id,shift,status FROM shift_assignments WHERE id=ANY($1::uuid[]) ORDER BY id",
            [ids],
          )
        ).rows,
        cells,
      );
    });
    await t.test(
      "legacy upserts and deletion cannot bypass configured assignment guards",
      async () => {
        const {
          rows: [cell],
        } = await pool.query(
          "SELECT *,shift_date::text FROM shift_assignments WHERE shift_date='2090-01-01' ORDER BY id LIMIT 1",
        );
        await pool.query("UPDATE shift_assignments SET status='draft' WHERE id=$1", [cell.id]);
        const apiBase = base.slice(0, base.indexOf("/api/")) + "/api/shift-assignments";
        for (const route of ["/upsert", "/new-staff-upsert"]) {
          const response = await fetch(apiBase + route, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify([
              {
                nurse_id: cell.nurse_id,
                shift_date: cell.shift_date,
                ward: cell.ward,
                shift: "OFF",
                status: "published",
              },
            ]),
          });
          assert.equal(response.status, 409, await response.text());
        }
        const single = await fetch(apiBase + "/" + cell.id, { method: "DELETE" });
        assert.equal(single.status, 409, await single.text());
        // Bulk clearing is refused unless every targeted cell is still a draft.
        await pool.query("UPDATE shift_assignments SET status='submitted' WHERE id=$1", [cell.id]);
        const bulk = await fetch(
          apiBase + `?nurse_ids=${cell.nurse_id}&from=2090-01-01&to=2090-01-01`,
          { method: "DELETE" },
        );
        assert.equal(bulk.status, 409, await bulk.text());
        await pool.query("UPDATE shift_assignments SET status='draft' WHERE id=$1", [cell.id]);
        const {
          rows: [after],
        } = await pool.query("SELECT * FROM shift_assignments WHERE id=$1", [cell.id]);
        assert.equal(after.status, "draft");
        assert.equal(after.shift, cell.shift);
        assert.equal(after.shift_definition_run_id, cell.shift_definition_run_id);
      },
    );
    await t.test(
      "single-cell creation cannot bypass configured policy via POST or one-row upsert",
      async () => {
        const {
          rows: [cell],
        } = await pool.query(
          "SELECT * FROM shift_assignments WHERE shift_date='2090-01-01' ORDER BY id LIMIT 1",
        );
        const apiBase = base.slice(0, base.indexOf("/api/")) + "/api/shift-assignments";
        const row = {
          nurse_id: cell.nurse_id,
          shift_date: "2090-01-05",
          shift: "M",
          ward: cell.ward,
        };
        for (const route of ["", "/upsert", "/new-staff-upsert"]) {
          const response = await fetch(apiBase + route, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(route ? [row] : row),
          });
          assert.equal(response.status, 409, await response.text());
        }
        assert.equal(
          (
            await pool.query(
              "SELECT id FROM shift_assignments WHERE nurse_id=$1 AND shift_date=$2",
              [row.nurse_id, row.shift_date],
            )
          ).rowCount,
          0,
        );
      },
    );
    await t.test(
      "single creation still supports legacy dates before configured activation",
      async () => {
        const {
          rows: [cell],
        } = await pool.query(
          "SELECT * FROM shift_assignments WHERE shift_date='2090-01-01' ORDER BY id LIMIT 1",
        );
        const {
          rows: [boundary],
        } = await pool.query(
          `SELECT (MIN(e.effective_from)-1)::text AS date FROM scheduling_policy_events e
           JOIN scheduling_facilities f ON f.id=e.facility_id
           JOIN nurses n ON n.facility=f.legacy_facility WHERE n.id=$1`,
          [cell.nurse_id],
        );
        assert.ok(boundary.date);
        const response = await fetch(
          base.slice(0, base.indexOf("/api/")) + "/api/shift-assignments",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              nurse_id: cell.nurse_id,
              ward: cell.ward,
              shift_date: boundary.date,
              shift: "OFF",
            }),
          },
        );
        const saved = await response.json();
        assert.equal(response.status, 201, JSON.stringify(saved));
        assert.equal(saved.shift, "OFF");
        assert.equal(saved.shift_definition_run_id, null);
        assert.equal(
          (await pool.query("SELECT id FROM shift_assignments WHERE id=$1", [saved.id])).rowCount,
          1,
        );
      },
    );
    await t.test(
      "configured leave closure uses saved credits and rolls back counter failures",
      async () => {
        const { closeConfiguredAttendanceForLeave } = require("./lib/configured-leave-attendance");
        const {
          rows: [nurse],
        } = await pool.query(
          "INSERT INTO nurses(name,role,facility) VALUES ('Leave snapshot test','Nurse','Other') RETURNING id",
        );
        const now = Date.now();
        const date = new Date(now).toISOString().slice(0, 10);
        const definition = {
          code: "M",
          name: "Configured duty",
          startsAt: new Date(now - 7200000).toISOString(),
          endsAt: new Date(now + 21600000).toISOString(),
          breakMinutes: 30,
          creditedMinutes: 450,
        };
        const {
          rows: [log],
        } = await pool.query(
          `INSERT INTO shift_logs
        (nurse_id,shift_date,shift_type,started_at,expected_end_at,period_start,scheduling_definition)
        VALUES ($1,$2,'M',$3,$4,$2,$5::jsonb) RETURNING id`,
          [nurse.id, date, definition.startsAt, definition.endsAt, JSON.stringify(definition)],
        );
        const leave = { id: null, nurse_id: nurse.id, from_date: date, to_date: date };
        const db = await pool.connect();
        try {
          await db.query("BEGIN");
          await assert.rejects(
            closeConfiguredAttendanceForLeave(
              {
                query: (sql, params) => {
                  if (sql.includes("increment_nurse_hours"))
                    throw new Error("Injected counter failure");
                  return db.query(sql, params);
                },
              },
              leave,
              async () => date,
            ),
            /Injected counter failure/,
          );
          await db.query("ROLLBACK");
          assert.equal(
            (await db.query("SELECT ended_at FROM shift_logs WHERE id=$1", [log.id])).rows[0]
              .ended_at,
            null,
          );
          assert.equal(
            (await db.query("SELECT id FROM shift_logs WHERE nurse_id=$1 AND is_leave", [nurse.id]))
              .rowCount,
            0,
          );
          await db.query("BEGIN");
          const result = await closeConfiguredAttendanceForLeave(db, leave, async () => date);
          assert.equal(result.creditedHours, 7.5);
          assert.equal(result.closed, 1);
          await db.query("COMMIT");
          const { rows } = await db.query("SELECT * FROM shift_logs WHERE nurse_id=$1", [nurse.id]);
          assert.equal(rows.length, 2);
          assert.equal(
            rows.reduce((sum, row) => sum + Number(row.hours_logged), 0),
            7.5,
          );
          assert.deepEqual(rows.find((row) => row.is_leave).scheduling_definition, definition);
          await db.query("BEGIN");
          assert.deepEqual(await closeConfiguredAttendanceForLeave(db, leave, async () => date), {
            closed: 0,
            creditedHours: 0,
          });
          await db.query("COMMIT");
        } finally {
          await db.query("ROLLBACK");
          db.release();
        }
      },
    );
    await t.test(
      "whole-day configured leave waits for saved start and concurrent retries credit once",
      async () => {
        const { creditConfiguredLeave } = require("./lib/configured-leave-credit");
        const {
          rows: [cell],
        } = await pool.query(
          "SELECT * FROM shift_assignments WHERE shift_date='2090-01-01' ORDER BY id LIMIT 1",
        );
        const {
          rows: [run],
        } = await pool.query("SELECT * FROM scheduling_runs WHERE id=$1", [
          cell.shift_definition_run_id,
        ]);
        const config = structuredClone(run.configuration_snapshot);
        const shift = config.shifts.find((s) => s.code === "M");
        shift.creditedMinutes = 450;
        const {
          rows: [saved],
        } = await pool.query(
          `INSERT INTO scheduling_runs
        (organization_id,facility_id,configuration_id,configuration_version,configuration_revision,
         start_date,end_date,engine_version,input_fingerprint,configuration_snapshot,input_snapshot,result_snapshot,created_by)
        SELECT organization_id,facility_id,configuration_id,configuration_version,configuration_revision,
         start_date,end_date,engine_version,input_fingerprint,$2::jsonb,input_snapshot,result_snapshot,created_by
        FROM scheduling_runs WHERE id=$1 RETURNING id`,
          [run.id, JSON.stringify(config)],
        );
        await pool.query(
          "INSERT INTO leave_requests(nurse_id,nurse_name,type,status,from_date,to_date) VALUES ($1,'Whole leave','Annual','Approved','2090-01-09','2090-01-09')",
          [cell.nurse_id],
        );
        await pool.query(
          `INSERT INTO shift_assignments(nurse_id,nurse_role,ward,shift_date,shift,pre_leave_shift,status,shift_definition_run_id)
        VALUES ($1,$2,$3,'2090-01-09','LEAVE','M','published',$4)`,
          [cell.nurse_id, cell.nurse_role, cell.ward, saved.id],
        );
        const readCredits = () =>
          pool.query("SELECT * FROM shift_logs WHERE nurse_id=$1 AND shift_date='2090-01-09'", [
            cell.nurse_id,
          ]);
        await creditConfiguredLeave(pool, new Date("2090-01-08T00:00:00Z"));
        assert.equal((await readCredits()).rowCount, 0);
        const failing = {
          connect: async () => {
            const db = await pool.connect();
            return {
              release: () => db.release(),
              query: (sql, params) => {
                if (sql.includes("increment_nurse_hours"))
                  throw new Error("Injected leave counter failure");
                return db.query(sql, params);
              },
            };
          },
        };
        await assert.rejects(
          creditConfiguredLeave(failing, new Date("2090-01-10T12:00:00Z")),
          /Injected leave counter failure/,
        );
        assert.equal((await readCredits()).rowCount, 0);
        await Promise.all([
          creditConfiguredLeave(pool, new Date("2090-01-10T12:00:00Z")),
          creditConfiguredLeave(pool, new Date("2090-01-10T12:00:00Z")),
        ]);
        const credits = await readCredits();
        assert.equal(credits.rowCount, 1);
        assert.equal(Number(credits.rows[0].hours_logged), 7.5);
        assert.equal(credits.rows[0].scheduling_definition.runId, saved.id);
        assert.equal(credits.rows[0].is_leave, true);
      },
    );
    await t.test(
      "leave credit reversal rolls back failures and retries without double subtraction",
      async () => {
        const { reverseLeaveCredits } = require("./lib/reverse-leave-credits");
        const {
          rows: [log],
        } = await pool.query(
          "SELECT *,shift_date::text FROM shift_logs WHERE is_leave AND shift_date='2090-01-09' LIMIT 1",
        );
        assert.ok(log);
        const leave = { id: log.leave_request_id, nurse_id: log.nurse_id };
        const db = await pool.connect();
        try {
          await db.query("BEGIN");
          await assert.rejects(
            reverseLeaveCredits(
              {
                query: (sql, params) => {
                  if (sql.includes("increment_nurse_hours"))
                    throw new Error("Injected reversal failure");
                  return db.query(sql, params);
                },
              },
              leave,
              log.shift_date,
              log.shift_date,
            ),
            /Injected reversal failure/,
          );
          await db.query("ROLLBACK");
          assert.equal(
            (await db.query("SELECT id FROM shift_logs WHERE id=$1", [log.id])).rowCount,
            1,
          );
          await db.query("BEGIN");
          assert.equal(await reverseLeaveCredits(db, leave, log.shift_date, log.shift_date), 7.5);
          await db.query("COMMIT");
          await db.query("BEGIN");
          assert.equal(await reverseLeaveCredits(db, leave, log.shift_date, log.shift_date), 0);
          await db.query("COMMIT");
        } finally {
          await db.query("ROLLBACK");
          db.release();
        }
      },
    );
    await t.test(
      "configured leave restoration rejects boundary conflicts and preserves identity",
      async () => {
        const {
          validateConfiguredLeaveRestoration,
        } = require("./lib/configured-leave-restoration");
        const {
          rows: [cell],
        } = await pool.query(
          "SELECT *,shift_date::text FROM shift_assignments WHERE shift_date='2090-01-09' LIMIT 1",
        );
        await pool.query(
          `INSERT INTO shift_assignments(nurse_id,nurse_role,ward,shift_date,shift,status,shift_definition_run_id)
        VALUES ($1,$2,$3,'2090-01-08','N','published',$4)`,
          [cell.nurse_id, cell.nurse_role, cell.ward, cell.shift_definition_run_id],
        );
        const db = await pool.connect();
        try {
          await db.query("BEGIN");
          const restored = await db.query(
            "UPDATE shift_assignments SET shift=pre_leave_shift,pre_leave_shift=NULL WHERE id=$1 RETURNING *,shift_date::text",
            [cell.id],
          );
          await assert.rejects(
            validateConfiguredLeaveRestoration(db, restored.rows),
            /overlap or leave no rest/,
          );
          await db.query("ROLLBACK");
          assert.equal(
            (await db.query("SELECT shift FROM shift_assignments WHERE id=$1", [cell.id])).rows[0]
              .shift,
            "LEAVE",
          );
          await db.query(
            "UPDATE shift_assignments SET shift='OFF' WHERE nurse_id=$1 AND shift_date='2090-01-08'",
            [cell.nurse_id],
          );
          await db.query("BEGIN");
          const valid = await db.query(
            "UPDATE shift_assignments SET shift=pre_leave_shift,pre_leave_shift=NULL WHERE id=$1 RETURNING *,shift_date::text",
            [cell.id],
          );
          await assert.rejects(
            validateConfiguredLeaveRestoration(db, [
              { ...valid.rows[0], nurse_role: "Missing role" },
            ]),
            /saved role/,
          );
          await validateConfiguredLeaveRestoration(db, valid.rows);
          await db.query("COMMIT");
          assert.equal(valid.rows[0].shift_definition_run_id, cell.shift_definition_run_id);
          assert.equal(valid.rows[0].shift, "M");
        } finally {
          await db.query("ROLLBACK");
          db.release();
        }
      },
    );
    await t.test("leave restoration is not blocked by saved ward staffing", async () => {
      const { validateConfiguredLeaveRestoration } = require("./lib/configured-leave-restoration");
      const {
        rows: [cell],
      } = await pool.query(
        "SELECT *,shift_date::text FROM shift_assignments WHERE shift_date='2090-01-09' LIMIT 1",
      );
      const {
        rows: [nurse],
      } = await pool.query(
        "INSERT INTO nurses(name,role,facility) SELECT 'Restoration coverage',role,facility FROM nurses WHERE id=$1 RETURNING id",
        [cell.nurse_id],
      );
      await pool.query(
        `INSERT INTO shift_assignments(nurse_id,nurse_role,ward,shift_date,shift,status,shift_definition_run_id)
        VALUES ($1,$2,$3,'2090-01-09','M','published',$4)`,
        [nurse.id, cell.nurse_role, cell.ward, cell.shift_definition_run_id],
      );
      await pool.query(
        "UPDATE shift_assignments SET shift='LEAVE',pre_leave_shift='M' WHERE id=$1",
        [cell.id],
      );
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        const { rows } = await db.query(
          "UPDATE shift_assignments SET shift=pre_leave_shift,pre_leave_shift=NULL WHERE id=$1 RETURNING *,shift_date::text",
          [cell.id],
        );
        await validateConfiguredLeaveRestoration(db, rows);
        await db.query("ROLLBACK");
        const {
          rows: [unchanged],
        } = await db.query("SELECT * FROM shift_assignments WHERE id=$1", [cell.id]);
        assert.equal(unchanged.shift, "LEAVE");
        assert.equal(unchanged.pre_leave_shift, "M");
        assert.equal(unchanged.shift_definition_run_id, cell.shift_definition_run_id);
      } finally {
        await db.query("ROLLBACK");
        db.release();
      }
    });
    await t.test(
      "approved configured absence reports staffing shortage without restoring duty",
      async () => {
        const { assessConfiguredLeaveStaffing } = require("./lib/configured-leave-staffing");
        const { rows } = await pool.query(
          "UPDATE shift_assignments SET shift='LEAVE',pre_leave_shift='M' WHERE shift_date='2090-01-09' RETURNING *,shift_date::text",
        );
        const warnings = await assessConfiguredLeaveStaffing(pool, rows);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /Ward staffing.*has 0/);
        assert.ok(
          (
            await pool.query("SELECT shift FROM shift_assignments WHERE shift_date='2090-01-09'")
          ).rows.every((r) => r.shift === "LEAVE"),
        );
        assert.deepEqual(
          await assessConfiguredLeaveStaffing(
            pool,
            rows.map((r) => ({ ...r, status: "draft" })),
          ),
          [],
        );
      },
    );
    await t.test(
      "leave tops up already-closed configured attendance without recrediting worked hours",
      async () => {
        const { closeConfiguredAttendanceForLeave } = require("./lib/configured-leave-attendance");
        const {
          rows: [nurse],
        } = await pool.query(
          "INSERT INTO nurses(name,role,facility,hours_this_month) VALUES ('Closed leave test','Nurse','Other',2.25) RETURNING id",
        );
        const definition = {
          code: "M",
          startsAt: "2091-01-01T07:00:00Z",
          endsAt: "2091-01-01T15:00:00Z",
          breakMinutes: 30,
          creditedMinutes: 450,
        };
        await pool.query(
          `INSERT INTO shift_logs(nurse_id,shift_date,shift_type,started_at,expected_end_at,ended_at,period_start,hours_logged,scheduling_definition)
        VALUES ($1,'2091-01-01','M',$2,$3,'2091-01-01T09:45:00Z','2091-01-01',2.25,$4::jsonb)`,
          [nurse.id, definition.startsAt, definition.endsAt, JSON.stringify(definition)],
        );
        const db = await pool.connect();
        try {
          const leave = {
            id: null,
            nurse_id: nurse.id,
            from_date: "2091-01-01",
            to_date: "2091-01-01",
          };
          await db.query("BEGIN");
          assert.deepEqual(
            await closeConfiguredAttendanceForLeave(db, leave, async () => "2091-01-01"),
            { closed: 0, creditedHours: 5.25 },
          );
          await db.query("COMMIT");
          assert.equal(
            Number(
              (await db.query("SELECT hours_this_month FROM nurses WHERE id=$1", [nurse.id]))
                .rows[0].hours_this_month,
            ),
            7.5,
          );
          await db.query("BEGIN");
          assert.deepEqual(
            await closeConfiguredAttendanceForLeave(db, leave, async () => "2091-01-01"),
            { closed: 0, creditedHours: 0 },
          );
          await db.query("COMMIT");
          assert.equal(
            Number(
              (await db.query("SELECT hours_this_month FROM nurses WHERE id=$1", [nurse.id]))
                .rows[0].hours_this_month,
            ),
            7.5,
          );
        } finally {
          await db.query("ROLLBACK");
          db.release();
        }
      },
    );
    await t.test("switch approval guard detects configured partner in PostgreSQL", async () => {
      const { guardLegacySwitchApproval } = require("./lib/configured-switch-guard");
      const { rows } = await pool.query(
        "SELECT nurse_id FROM shift_assignments WHERE shift_date='2090-01-01' ORDER BY id",
      );
      await assert.rejects(
        guardLegacySwitchApproval(
          pool,
          {
            nurse_id: rows[0].nurse_id,
            reason: `SHIFT_SWITCH|${rows[1].nurse_id}|Partner|M|OFF`,
          },
          "2090-01-01",
          "2090-01-01",
        ),
        /atomic reviewed/,
      );
    });
    await t.test(
      "atomic draft swap rejects adjacent rest conflict without changing either duty",
      async () => {
        const { swapConfiguredAssignments } = require("./lib/configured-assignment-swap");
        const { rows: source } = await pool.query(
          "SELECT * FROM shift_assignments WHERE shift_date='2090-01-01' ORDER BY id",
        );
        const { rows: cells } = await pool.query(
          `INSERT INTO shift_assignments
        (nurse_id,nurse_role,ward,shift_date,shift,status,shift_definition_run_id)
        VALUES ($1,$3,$4,'2092-01-02','OFF','draft',$5),($2,$3,$4,'2092-01-02','M','draft',$5) RETURNING *`,
          [
            source[0].nurse_id,
            source[1].nurse_id,
            source[0].nurse_role,
            source[0].ward,
            source[0].shift_definition_run_id,
          ],
        );
        const {
          rows: [night],
        } = await pool.query(
          `INSERT INTO shift_assignments
        (nurse_id,nurse_role,ward,shift_date,shift,status,shift_definition_run_id)
        VALUES ($1,$2,$3,'2092-01-01','N','published',$4) RETURNING id`,
          [
            source[0].nurse_id,
            source[0].nurse_role,
            source[0].ward,
            source[0].shift_definition_run_id,
          ],
        );
        const expected = cells.map((c) => ({
          id: c.id,
          shift: c.shift,
          definitionRunId: c.shift_definition_run_id,
        }));
        const swap = () =>
          swapConfiguredAssignments(
            pool,
            expected,
            { userId: admin, name: "Admin" },
            async () => true,
          );
        await assert.rejects(swap(), /overlap or leave no rest/);
        const { rows: unchanged } = await pool.query(
          "SELECT id,shift FROM shift_assignments WHERE id=ANY($1::uuid[])",
          [cells.map((c) => c.id)],
        );
        for (const row of unchanged)
          assert.equal(row.shift, cells.find((c) => c.id === row.id).shift);
        await pool.query("UPDATE shift_assignments SET shift='OFF' WHERE id=$1", [night.id]);
        assert.deepEqual(await swap(), { swapped: true });
      },
    );
    await t.test(
      "published configured switch approves both duties and request atomically",
      async () => {
        const { rows: cells } = await pool.query(
          "UPDATE shift_assignments SET status='published' WHERE shift_date='2092-01-02' RETURNING *,shift_date::text",
        );
        const {
          rows: [request],
        } = await pool.query(
          `INSERT INTO leave_requests(nurse_id,nurse_name,type,status,from_date,to_date,reason)
        VALUES ($1,'Switch','Swap','Pending','2092-01-02','2092-01-02',$2) RETURNING id`,
          [
            cells[0].nurse_id,
            `SHIFT_SWITCH|${cells[1].nurse_id}|Partner|${cells[0].shift}|${cells[1].shift}`,
          ],
        );
        const url =
          base.slice(0, base.indexOf("/api/")) +
          "/api/shift-assignments/configured-switch-approval";
        const body = {
          requestId: request.id,
          assignments: cells.map((c) => ({
            id: c.id,
            shift: c.shift,
            definitionRunId: c.shift_definition_run_id,
          })),
        };
        const post = () =>
          fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
        await pool.query("UPDATE leave_requests SET requested_by=$2 WHERE id=$1", [
          request.id,
          admin,
        ]);
        await pool.query("UPDATE nurses SET profile_id=$2 WHERE id=$1", [cells[0].nurse_id, admin]);
        const partnerProfile = "10000000-0000-4000-8000-000000000004";
        await pool.query("INSERT INTO profiles(id,full_name) VALUES ($1,'Switch partner')", [
          partnerProfile,
        ]);
        await pool.query("UPDATE nurses SET profile_id=$2 WHERE id=$1", [
          cells[1].nurse_id,
          partnerProfile,
        ]);
        const notificationKey = `switch_approved_${request.id}`;
        const { guardConfiguredSwitchRequest } = require("./lib/configured-switch-guard");
        const requestDetails = (
          await pool.query(
            "SELECT *,from_date::text,to_date::text FROM leave_requests WHERE id=$1",
            [request.id],
          )
        ).rows[0];
        await guardConfiguredSwitchRequest(pool, requestDetails);
        await assert.rejects(
          guardConfiguredSwitchRequest(pool, {
            ...requestDetails,
            reason: `${requestDetails.reason}|LEAVE_COVER`,
          }),
          /Leave cover/,
        );
        await pool.query("UPDATE profiles SET email=$2 WHERE id=$1", [admin, "admin@example.test"]);
        await pool.query("UPDATE profiles SET email=$2 WHERE id=$1", [
          partnerProfile,
          "partner@example.test",
        ]);
        sentMail.length = 0;
        const mailStatuses = [];
        mailHook = async () => {
          mailStatuses.push(
            (await pool.query("SELECT status FROM leave_requests WHERE id=$1", [request.id]))
              .rows[0].status,
          );
          throw new Error("Injected mail delivery failure");
        };
        const unauthorized = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-test-user": reader },
          body: JSON.stringify(body),
        });
        assert.equal(unauthorized.status, 403);
        const receiver = cells.find((cell) => cell.shift === "OFF");
        await pool.query(
          `INSERT INTO shift_assignments(nurse_id,nurse_role,ward,shift_date,shift,status,shift_definition_run_id)
          VALUES ($1,$2,$3,'2092-01-01','N','published',$4)
          ON CONFLICT(nurse_id,shift_date) DO UPDATE SET shift='N'`,
          [receiver.nurse_id, receiver.nurse_role, receiver.ward, receiver.shift_definition_run_id],
        );
        assert.equal((await post()).status, 409);
        assert.equal(
          (
            await pool.query("SELECT * FROM notification_state WHERE notif_key=$1", [
              notificationKey,
            ])
          ).rowCount,
          0,
        );
        assert.equal(
          (await pool.query("SELECT status FROM leave_requests WHERE id=$1", [request.id])).rows[0]
            .status,
          "Pending",
        );
        const beforeRetry = await pool.query(
          "SELECT id,shift FROM shift_assignments WHERE id=ANY($1::uuid[])",
          [cells.map((cell) => cell.id)],
        );
        for (const row of beforeRetry.rows)
          assert.equal(row.shift, cells.find((cell) => cell.id === row.id).shift);
        await pool.query(
          "UPDATE shift_assignments SET shift='OFF' WHERE nurse_id=$1 AND shift_date='2092-01-01'",
          [receiver.nurse_id],
        );
        const { swapConfiguredAssignments } = require("./lib/configured-assignment-swap");
        const failingPool = {
          connect: async () => {
            const db = await pool.connect();
            return {
              release: () => db.release(),
              query: (sql, params) => {
                if (sql.includes("INSERT INTO audit_logs"))
                  throw new Error("Injected approval audit failure");
                return db.query(sql, params);
              },
            };
          },
        };
        await assert.rejects(
          swapConfiguredAssignments(
            failingPool,
            body.assignments,
            { userId: admin, name: "Admin" },
            async () => true,
            { requestId: request.id },
          ),
          /Injected approval audit failure/,
        );
        assert.equal(
          (await pool.query("SELECT status FROM leave_requests WHERE id=$1", [request.id])).rows[0]
            .status,
          "Pending",
        );
        assert.equal(
          (
            await pool.query("SELECT * FROM notification_state WHERE notif_key=$1", [
              notificationKey,
            ])
          ).rowCount,
          0,
        );
        const rolledBack = await pool.query(
          "SELECT id,shift FROM shift_assignments WHERE id=ANY($1::uuid[])",
          [cells.map((cell) => cell.id)],
        );
        for (const row of rolledBack.rows)
          assert.equal(row.shift, cells.find((cell) => cell.id === row.id).shift);
        const response = await post();
        assert.equal(sentMail.length, 2);
        assert.deepEqual(mailStatuses, ["Approved", "Approved"]);
        assert.deepEqual(sentMail.map((m) => m.to).sort(), [
          "admin@example.test",
          "partner@example.test",
        ]);
        assert.equal(response.status, 200, await response.text());
        assert.equal(
          (await pool.query("SELECT status FROM leave_requests WHERE id=$1", [request.id])).rows[0]
            .status,
          "Approved",
        );
        const { rows: changed } = await pool.query(
          "SELECT id,shift FROM shift_assignments WHERE id=ANY($1::uuid[])",
          [cells.map((c) => c.id)],
        );
        for (const row of changed)
          assert.equal(row.shift, cells.find((c) => c.id !== row.id).shift);
        const notifications = await pool.query(
          "SELECT user_id FROM notification_state WHERE notif_key=$1",
          [notificationKey],
        );
        assert.deepEqual(
          notifications.rows.map((row) => row.user_id).sort(),
          [admin, partnerProfile].sort(),
        );
        await pool.query("UPDATE notification_state SET is_read=true WHERE notif_key=$1", [
          notificationKey,
        ]);
        assert.equal((await post()).status, 409);
        assert.equal(sentMail.length, 2, "Retry must not send approval email again");
        mailHook = async () => {};
        assert.ok(
          (
            await pool.query("SELECT is_read FROM notification_state WHERE notif_key=$1", [
              notificationKey,
            ])
          ).rows.every((row) => row.is_read),
        );
      },
    );
    await t.test("configured weekend leave counting recognizes custom working codes", async () => {
      await migrate("033_leave_entitlement_adjustments.sql");
      await migrate("009_leave_types.sql");
      await migrate("015_add_missing_leave_types.sql");
      await migrate("034_leave_entitlement_overrides.sql");
      class EntitlementDate extends Date {
        constructor(...args) {
          super(...(args.length ? args : ["2026-10-12T12:00:00Z"]));
        }
      }
      const entitlement = load(
        "nurse-api/lib/leave-entitlements.js",
        {
          "../db": pool,
          "./auto-schedule.generated.js": require("./lib/auto-schedule.generated.js"),
          "./leave-entitlement-windows": require("./lib/leave-entitlement-windows"),
        },
        { Date: EntitlementDate },
      );
      const {
        rows: [nurse],
      } = await pool.query(
        "INSERT INTO nurses(name,facility,role) VALUES ('Entitlement test','Ikoyi','Nurse') RETURNING id",
      );
      const {
        rows: [source],
      } = await pool.query(
        "SELECT shift_definition_run_id FROM shift_assignments WHERE shift_definition_run_id IS NOT NULL LIMIT 1",
      );
      const {
        rows: [cell],
      } = await pool.query(
        `INSERT INTO shift_assignments(nurse_id,shift_date,shift,status,shift_definition_run_id)
         VALUES ($1,'2026-10-10','EV_TEST','draft',$2) RETURNING id`,
        [nurse.id, source.shift_definition_run_id],
      );
      const count = () =>
        entitlement.countChargeableLeaveDays(nurse.id, "2026-10-10", "2026-10-10");
      assert.equal(await count(), 1);
      const {
        rows: [annual],
      } = await pool.query(
        `INSERT INTO leave_requests(nurse_id,nurse_name,type,status,from_date,to_date)
         VALUES ($1,'Entitlement test','Annual','Pending','2026-10-10','2026-10-10') RETURNING id`,
        [nurse.id],
      );
      await pool.query(
        `INSERT INTO leave_requests(nurse_id,nurse_name,type,status,from_date,to_date)
         VALUES ($1,'Entitlement test','Sick','Approved','2026-10-11','2026-10-11')`,
        [nurse.id],
      );
      await pool.query(
        "INSERT INTO leave_entitlement_overrides(scope,nurse_id,type,days) VALUES ('individual',$1,'Annual',2)",
        [nurse.id],
      );
      await pool.query(
        "INSERT INTO leave_entitlement_adjustments(nurse_id,type,days,period_year,reason) VALUES ($1,'Annual',0.5,2026,'Test adjustment')",
        [nurse.id],
      );
      const single = await entitlement.getEntitlementUsage(nurse.id);
      const bulk = await entitlement.getEntitlementUsageForNurses([
        { id: nurse.id, role: "Nurse" },
      ]);
      assert.equal(JSON.stringify(bulk[nurse.id]), JSON.stringify(single));
      assert.equal(single.Annual.usedFromRequests, 1);
      assert.equal(single.Annual.usedFromAdjustments, 0.5);
      assert.equal(single.Annual.remaining, 0.5);
      assert.equal(
        single.Sick.usedFromRequests,
        1,
        "Sick remains calendar-day based on an unrostered Sunday",
      );
      const overage = await entitlement.wouldExceedEntitlement(
        nurse.id,
        "Annual",
        "2026-10-12",
        "2026-10-12",
      );
      assert.equal(overage.used, 1.5);
      assert.equal(overage.requestedDaysInWindow, 1);
      assert.equal(overage.cap, 2);
      assert.equal(
        await entitlement.wouldExceedEntitlement(nurse.id, "Annual", "2026-10-10", "2026-10-10", {
          excludeRequestId: annual.id,
        }),
        null,
        "Editing must not count the original request twice",
      );
      const entitlementClient = await pool.connect();
      try {
        await entitlementClient.query("BEGIN");
        await entitlementClient.query(
          "UPDATE leave_entitlement_overrides SET days=3 WHERE nurse_id=$1 AND type='Annual'",
          [nurse.id],
        );
        await entitlementClient.query(
          "INSERT INTO leave_entitlement_adjustments(nurse_id,type,days,period_year,reason) VALUES ($1,'Annual',2,2026,'Uncommitted adjustment')",
          [nurse.id],
        );
        const transactional = await entitlement.wouldExceedEntitlement(
          nurse.id,
          "Annual",
          "2026-10-12",
          "2026-10-12",
          { queryable: entitlementClient },
        );
        assert.equal(transactional.cap, 3, "Cap must use the supplied transaction");
        assert.equal(transactional.used, 3.5, "Adjustments must use the supplied transaction");
      } finally {
        await entitlementClient.query("ROLLBACK");
        entitlementClient.release();
      }
      const afterRollback = await entitlement.wouldExceedEntitlement(
        nurse.id,
        "Annual",
        "2026-10-12",
        "2026-10-12",
      );
      assert.equal(afterRollback.cap, 2);
      assert.equal(afterRollback.used, 1.5);
      await pool.query(
        "INSERT INTO leave_entitlement_adjustments(nurse_id,type,days,period_year,reason) VALUES ($1,'Annual',2,2027,'Future allowance used')",
        [nurse.id],
      );
      const future = await entitlement.wouldExceedEntitlement(
        nurse.id,
        "Annual",
        "2027-04-01",
        "2027-04-01",
      );
      assert.equal(future.used, 2);
      assert.equal(future.windowStart, "2027-04-01");
      const spanning = await entitlement.wouldExceedEntitlement(
        nurse.id,
        "Annual",
        "2027-03-31",
        "2027-04-01",
        { excludeRequestId: annual.id },
      );
      assert.equal(spanning.windowStart, "2027-04-01", "Second leave year must also be checked");
      await pool.query(
        "INSERT INTO leave_entitlement_adjustments(nurse_id,type,days,period_year,period_month,reason) VALUES ($1,'Sick',12,2026,12,'Future month used')",
        [nurse.id],
      );
      const sickFuture = await entitlement.wouldExceedEntitlement(
        nurse.id,
        "Sick",
        "2026-11-30",
        "2026-12-01",
      );
      assert.equal(sickFuture.windowStart, "2026-12-01");
      assert.equal(sickFuture.requestedDaysInWindow, 1);
      const maternityClient = await pool.connect();
      try {
        await maternityClient.query("BEGIN");
        const {
          rows: [maternity],
        } = await maternityClient.query(
          `INSERT INTO leave_requests(nurse_id,nurse_name,type,status,from_date,to_date)
           VALUES ($1,'Entitlement test','Maternity','Pending','2027-04-02','2027-04-10') RETURNING id`,
          [nurse.id],
        );
        const options = { queryable: maternityClient };
        assert.equal(
          await entitlement.annualMaternityConflict(nurse.id, "2027-03-30", "2027-03-31", options),
          null,
        );
        const conflict = await entitlement.annualMaternityConflict(
          nurse.id,
          "2027-03-31",
          "2027-04-01",
          options,
        );
        assert.equal(
          conflict.start,
          "2027-04-01",
          "A conflict in the second leave year must be detected",
        );
        assert.equal(conflict.end, "2028-03-31");
        assert.equal(
          await entitlement.annualMaternityConflict(nurse.id, "2027-03-31", "2027-04-01", {
            ...options,
            excludeRequestId: maternity.id,
          }),
          null,
        );
        await maternityClient.query("UPDATE leave_requests SET status='Rejected' WHERE id=$1", [
          maternity.id,
        ]);
        assert.equal(
          await entitlement.annualMaternityConflict(nurse.id, "2027-03-31", "2027-04-01", options),
          null,
        );
      } finally {
        await maternityClient.query("ROLLBACK");
        maternityClient.release();
      }
      assert.equal(
        await entitlement.wouldExceedEntitlement(nurse.id, "Emergency", "2026-10-10", "2026-10-11"),
        null,
      );
      await pool.query(
        "UPDATE shift_assignments SET shift='LEAVE',pre_leave_shift='EV_TEST' WHERE id=$1",
        [cell.id],
      );
      assert.equal(await count(), 1, "Leave preserves the planned custom working day");
      await pool.query("UPDATE shift_assignments SET shift='OFF' WHERE id=$1", [cell.id]);
      assert.equal(
        await count(),
        0,
        "Stale pre-leave data must not make configured OFF chargeable",
      );
      await pool.query(
        "UPDATE shift_assignments SET shift='LEAVE',pre_leave_shift='OFF' WHERE id=$1",
        [cell.id],
      );
      assert.equal(await count(), 0);
      await pool.query(
        "UPDATE shift_assignments SET shift='M',shift_definition_run_id=NULL WHERE id=$1",
        [cell.id],
      );
      assert.equal(await count(), 1, "Legacy weekend morning remains chargeable");
      await pool.query(
        "UPDATE shift_assignments SET shift='OFF',pre_leave_shift=NULL WHERE id=$1",
        [cell.id],
      );
      assert.equal(await count(), 0);
      assert.equal(
        await entitlement.countChargeableLeaveDays(nurse.id, "2026-10-12", "2026-10-12"),
        1,
        "Weekday policy is unchanged",
      );
    });
    await t.test(
      "concurrent locum claims atomically accept invites without overfilling",
      async () => {
        await migrate("006_locum_nurses_needed.sql");
        const { claimLocum } = require("./lib/claim-locum");
        const {
          rows: [request],
        } = await pool.query(
          `INSERT INTO locum_requests(shift_date,shift,facility,ward,nurses_in_ward,ventilated_patients,hdu_nurses,requested_by,requested_by_name,status,nurses_needed) VALUES ('2099-01-01','M','Ikoyi','ICU',0,0,0,$1,'Admin','invites_sent',2) RETURNING id`,
          [admin],
        );
        const ids = (
          await pool.query(
            "INSERT INTO nurses(name,role,ward,facility) VALUES ('Locum A','Nurse','GOPD','Ikoyi'),('Locum B','Nurse','GOPD','Ikoyi'),('Locum C','Nurse','GOPD','Ikoyi') RETURNING id",
          )
        ).rows.map((r) => r.id);
        for (const id of ids) {
          await pool.query(
            "INSERT INTO locum_invites(locum_request_id,nurse_id,nurse_name) VALUES ($1,$2,'Test')",
            [request.id, id],
          );
          await pool.query(
            "INSERT INTO shift_assignments(nurse_id,ward,shift_date,shift,status) VALUES ($1,'GOPD','2099-01-01','OFF','published')",
            [id],
          );
        }
        const results = await Promise.all(
          ids.map((id) => claimLocum(pool, request.id, id, "Test", { userId: admin, name: "A" })),
        );
        assert.equal(results.filter(Boolean).length, 2);
        assert.ok(results.filter(Boolean).every((r) => r.rota_updated));
        const flipped = (
          await pool.query(
            "SELECT nurse_id,shift FROM shift_assignments WHERE shift_date='2099-01-01' AND nurse_id=ANY($1::uuid[])",
            [ids],
          )
        ).rows;
        assert.equal(flipped.filter((r) => r.shift === "M").length, 2, "Only claimants flip");
        const accepted = (
          await pool.query(
            "SELECT nurse_id FROM locum_invites WHERE locum_request_id=$1 AND status='accepted'",
            [request.id],
          )
        ).rows;
        assert.equal(accepted.length, 2);
        assert.equal(
          (await pool.query("SELECT status FROM locum_requests WHERE id=$1", [request.id])).rows[0]
            .status,
          "filled",
        );
        assert.equal(
          (await claimLocum(pool, request.id, accepted[0].nurse_id, "Test")).already_claimed,
          true,
        );
        const invites = (
          await pool.query("SELECT * FROM locum_invites WHERE locum_request_id=$1", [request.id])
        ).rows;
        const winner = invites.find((i) => i.status === "accepted");
        const pending = invites.find((i) => i.status === "pending");
        const locumBase = base.slice(0, base.indexOf("/api/")) + "/api/locum";
        const patch = (path, body) =>
          fetch(locumBase + path, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
        assert.equal((await patch(`/invites/${winner.id}`, { status: "unavailable" })).status, 409);
        assert.equal((await patch(`/invites/${pending.id}`, { status: "accepted" })).status, 409);
        assert.equal(
          (await patch(`/invites?locum_request_id=${request.id}`, { status: "accepted" })).status,
          409,
        );
        assert.equal(
          (await patch(`/invites?locum_request_id=${request.id}`, { status: "unavailable" }))
            .status,
          200,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT COUNT(*)::int AS n FROM locum_invites WHERE locum_request_id=$1 AND status='accepted'",
              [request.id],
            )
          ).rows[0].n,
          2,
        );
        await pool.query(
          "UPDATE locum_requests SET nurses_needed=3,status='invites_sent' WHERE id=$1",
          [request.id],
        );
        await pool.query("UPDATE locum_invites SET status='pending' WHERE id=$1", [pending.id]);
        const failingPool = {
          connect: async () => {
            const db = await pool.connect();
            return {
              release: () => db.release(),
              query: (sql, params) => {
                if (sql.startsWith("UPDATE locum_requests"))
                  throw new Error("Injected claim failure");
                return db.query(sql, params);
              },
            };
          },
        };
        await assert.rejects(
          claimLocum(failingPool, request.id, pending.nurse_id, "Test"),
          /Injected claim failure/,
        );
        assert.equal(
          (
            await pool.query("SELECT status,responded_at FROM locum_invites WHERE id=$1", [
              pending.id,
            ])
          ).rows[0].status,
          "pending",
        );
        assert.equal(
          (await pool.query("SELECT status FROM locum_requests WHERE id=$1", [request.id])).rows[0]
            .status,
          "invites_sent",
        );
        assert.equal(
          (
            await pool.query(
              "SELECT shift FROM shift_assignments WHERE nurse_id=$1 AND shift_date='2099-01-01'",
              [pending.nurse_id],
            )
          ).rows[0].shift,
          "OFF",
          "A failed claim rolls back the rota flip",
        );
      },
    );
    await t.test("configured locum claims check saved role and rest atomically", async () => {
      const { claimLocum } = require("./lib/claim-locum");
      const {
        rows: [source],
      } =
        await pool.query(`SELECT sa.*,r.configuration_snapshot,n.facility FROM shift_assignments sa
        JOIN scheduling_runs r ON r.id=sa.shift_definition_run_id JOIN nurses n ON n.id=sa.nurse_id
        WHERE sa.ward IS NOT NULL LIMIT 1`);
      const roles = source.configuration_snapshot.roles;
      const both = roles.find(
        (r) => r.allowedShifts.includes("M") && r.allowedShifts.includes("N"),
      );
      const dayOnly = roles.find(
        (r) => r.allowedShifts.includes("M") && !r.allowedShifts.includes("N"),
      );
      assert.ok(both && dayOnly, "Seeded configuration has day-only and rotating roles");
      const {
        rows: [nurse],
      } = await pool.query(
        "INSERT INTO nurses(name,role,ward,facility) VALUES ('Configured locum',$1,$2,$3) RETURNING id",
        [both.name, source.ward, source.facility],
      );
      const cell = async (date, shift, role = both.name) =>
        (
          await pool.query(
            `INSERT INTO shift_assignments(nurse_id,nurse_role,ward,shift_date,shift,status,shift_definition_run_id)
             VALUES ($1,$2,$3,$4,$5,'published',$6) RETURNING id`,
            [nurse.id, role, source.ward, date, shift, source.shift_definition_run_id],
          )
        ).rows[0].id;
      const request = async (date, shift) => {
        const {
          rows: [r],
        } = await pool.query(
          `INSERT INTO locum_requests(shift_date,shift,facility,ward,nurses_in_ward,ventilated_patients,hdu_nurses,requested_by,requested_by_name,status,nurses_needed)
           VALUES ($1,$2,'Ikoyi','ICU',0,0,0,$3,'Admin','invites_sent',1) RETURNING id`,
          [date, shift, admin],
        );
        await pool.query(
          "INSERT INTO locum_invites(locum_request_id,nurse_id,nurse_name) VALUES ($1,$2,'Configured locum')",
          [r.id, nurse.id],
        );
        return r.id;
      };
      const state = async (requestId, cellId) => ({
        invite: (
          await pool.query("SELECT status FROM locum_invites WHERE locum_request_id=$1", [
            requestId,
          ])
        ).rows[0].status,
        request: (await pool.query("SELECT status FROM locum_requests WHERE id=$1", [requestId]))
          .rows[0].status,
        shift: (await pool.query("SELECT shift FROM shift_assignments WHERE id=$1", [cellId]))
          .rows[0].shift,
      });
      const actor = { userId: admin, name: "Admin" };

      // Night ends 08:00 on the locum date, so a morning locum leaves no rest.
      await cell("2091-03-01", "N");
      const tight = await cell("2091-03-02", "OFF");
      const tightRequest = await request("2091-03-02", "M");
      await assert.rejects(
        claimLocum(pool, tightRequest, nurse.id, "Configured locum", actor),
        (e) => e.code === "LOCUM_ROTA_CONFLICT" && /rest/.test(e.message),
      );
      assert.deepEqual(await state(tightRequest, tight), {
        invite: "pending",
        request: "invites_sent",
        shift: "OFF",
      });

      const dayCell = await cell("2091-03-10", "OFF", dayOnly.name);
      const nightRequest = await request("2091-03-10", "N");
      await assert.rejects(
        claimLocum(pool, nightRequest, nurse.id, "Configured locum", actor),
        (e) => e.code === "LOCUM_ROTA_CONFLICT" && /saved role/.test(e.message),
      );
      assert.equal((await state(nightRequest, dayCell)).shift, "OFF");

      const noCellRequest = await request("2091-03-20", "M");
      await assert.rejects(
        claimLocum(pool, noCellRequest, nurse.id, "Configured locum", actor),
        /no longer shows you off duty/,
      );

      const free = await cell("2091-03-15", "OFF");
      const freeRequest = await request("2091-03-15", "M");
      const claimed = await claimLocum(pool, freeRequest, nurse.id, "Configured locum", actor);
      assert.equal(claimed.status, "filled");
      assert.equal(claimed.rota_updated, true);
      const {
        rows: [after],
      } = await pool.query("SELECT * FROM shift_assignments WHERE id=$1", [free]);
      assert.equal(after.shift, "M");
      assert.equal(after.status, "published");
      assert.equal(after.shift_definition_run_id, source.shift_definition_run_id);
      assert.equal(after.updated_by, admin);

      const locumBase = base.slice(0, base.indexOf("/api/")) + "/api/locum";
      const patchRequest = (id, body) =>
        fetch(`${locumBase}/requests/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      assert.equal((await patchRequest(freeRequest, { status: "declined" })).status, 409);
      assert.equal((await patchRequest(freeRequest, { nurses_needed: 0 })).status, 409);
      assert.equal(
        (await patchRequest(freeRequest, { accepted_by_nurse_id: null })).status,
        400,
        "Claimant fields are not writable through review edits",
      );
      assert.equal((await patchRequest(tightRequest, { status: "filled" })).status, 409);
      const {
        rows: [pendingReview],
      } = await pool.query(
        `INSERT INTO locum_requests(shift_date,shift,facility,ward,nurses_in_ward,ventilated_patients,hdu_nurses,requested_by,requested_by_name)
         VALUES ('2091-04-01','M','Ikoyi','ICU',0,0,0,$1,'Admin') RETURNING id`,
        [admin],
      );
      const approved = await patchRequest(pendingReview.id, {
        status: "approved",
        nurses_needed: 2,
      });
      assert.equal(approved.status, 200);
      assert.equal((await approved.json()).nurses_needed, 2);
      assert.equal(
        (await pool.query("SELECT status FROM locum_requests WHERE id=$1", [freeRequest])).rows[0]
          .status,
        "filled",
      );
    });
    await t.test("locum requests use the governing configuration's shift definitions", async () => {
      await migrate("008_locum_role_needed.sql");
      await migrate("048_locum_shift_definitions.sql");
      const { locumShiftOptions } = require("./lib/locum-shift-options");
      const { policyAt } = require("./lib/scheduling-policy");
      const legacy = await locumShiftOptions(pool, "No such facility", "2099-06-01");
      assert.equal(legacy.source, "legacy");
      assert.deepEqual(
        legacy.shifts.map((s) => [s.code, s.startsAt]),
        [
          ["M", "2099-06-01T07:00:00.000Z"],
          ["N", "2099-06-01T16:00:00.000Z"],
        ],
      );
      await assert.rejects(locumShiftOptions(pool, "Ikoyi", "2099-02-30"), /valid shift date/);

      const {
        rows: [facility],
      } = await pool.query("SELECT id FROM scheduling_facilities WHERE legacy_facility='Ikoyi'");
      const policy = await policyAt(pool, facility.id, "2099-06-01");
      const ikoyi = await locumShiftOptions(pool, "Ikoyi", "2099-06-01");
      if (policy?.state === "active") {
        const {
          rows: [run],
        } = await pool.query("SELECT configuration_snapshot FROM scheduling_runs WHERE id=$1", [
          policy.source_run_id,
        ]);
        assert.equal(ikoyi.source, "configured");
        assert.deepEqual(
          ikoyi.shifts.map((s) => s.code),
          run.configuration_snapshot.shifts.map((s) => s.code),
        );
      } else assert.equal(ikoyi.source, "legacy");

      const locumBase = base.slice(0, base.indexOf("/api/")) + "/api/locum";
      const create = (shift, facilityName = "No such facility") =>
        fetch(`${locumBase}/requests`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            shift_date: "2099-06-01",
            shift,
            facility: facilityName,
            ward: "ICU",
            requested_by: admin,
            requested_by_name: "Admin",
          }),
        });
      assert.equal((await create("EVENING")).status, 422, "Unknown codes are rejected");
      const created = await create("N");
      assert.equal(created.status, 201);
      const row = await created.json();
      assert.equal(row.shift_name, "Night");
      assert.equal(new Date(row.shift_starts_at).toISOString(), "2099-06-01T16:00:00.000Z");
      const options = await fetch(
        `${locumBase}/shift-options?facility=${encodeURIComponent("No such facility")}&date=2099-06-01`,
      );
      assert.equal(options.status, 200);
      assert.equal((await options.json()).shifts.length, 2);

      // Expiry uses the stored start: a custom start one hour from now has not
      // reached its cutoff, while the same request starting in 30 minutes has.
      const { runAutoExpireLocumRequests } = load("nurse-api/jobs/auto-expire-locum-requests.js", {
        "../db": pool,
        "node-cron": { schedule: () => {} },
        "../lib/tenant-context": tenant,
        "../lib/mailer": { sendMail: async () => {}, portalUrl: () => "" },
      });
      const insert = async (offsetMinutes) =>
        (
          await pool.query(
            `INSERT INTO locum_requests(shift_date,shift,facility,ward,nurses_in_ward,ventilated_patients,hdu_nurses,requested_by,requested_by_name,status,shift_name,shift_starts_at)
             VALUES ('2099-12-31','EVE','Ikoyi','ICU',0,0,0,$1,'Admin','approved','Evening',NOW()+$2::interval) RETURNING id`,
            [admin, `${offsetMinutes} minutes`],
          )
        ).rows[0].id;
      const later = await insert(90);
      const soon = await insert(30);
      await runAutoExpireLocumRequests();
      const status = async (id) =>
        (await pool.query("SELECT status FROM locum_requests WHERE id=$1", [id])).rows[0].status;
      assert.equal(await status(later), "approved");
      assert.equal(await status(soon), "expired");
    });
    await t.test("new locations join scheduling with initial admin grants only", async () => {
      await pool.query(
        "INSERT INTO wards (name, facility, min_morning_nurses, min_night_nurses) VALUES ('Theatre', 'Newsite', 1, 0)",
      );
      const names = async (user) =>
        (await service.listFacilities(user)).facilities.map((f) => f.name);
      assert.ok((await names(admin)).includes("Newsite"));
      assert.ok(!(await names(reader)).includes("Newsite"), "Non-admins need a staff link");
      // The admin whose Ikoyi grant was removed regains nothing beyond the new site.
      assert.deepEqual(await names(outsider), ["Newsite"]);
      await pool.query("DELETE FROM scheduling_facility_access WHERE user_id=$1", [outsider]);
      assert.deepEqual(await names(outsider), [], "Revoked grants are not re-added");
      const {
        rows: [site],
      } = await pool.query("SELECT id FROM scheduling_facilities WHERE legacy_facility='Newsite'");
      const { configuration } = await service.defaults(admin, site.id);
      assert.equal(configuration.wardPolicies.length, 1, "New site wards seed its defaults");
    });
    await t.test("custom shift codes and role groups activate end to end", async () => {
      const policyBase = base.replace(a, b);
      const apiRoot = base.slice(0, base.indexOf("/facilities"));
      const post = (path, body = {}) =>
        fetch(`${policyBase}/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-test-user": admin },
          body: JSON.stringify(body),
        });
      // A new facility-wide role that legacy role-name matching does not know.
      const {
        rows: [lead],
      } = await pool.query(
        "INSERT INTO nurses(name,role,facility) VALUES ('Theatre lead','Theatre Coordinator','Other') RETURNING id",
      );
      // A second ward and one nurse per ward for inter-ward and leave-cover switches.
      await pool.query(
        "INSERT INTO wards (name, facility, min_morning_nurses, min_night_nurses) VALUES ('ICU', 'Other', 0, 0)",
      );
      const {
        rows: [icuNurse, erNurse],
      } = await pool.query(
        "INSERT INTO nurses(name,role,ward,facility) VALUES ('ICU switcher','Nurse','ICU','Other'),('ER switcher','Nurse','ER','Other') RETURNING id",
      );
      // Earlier scenarios leave ward-less test staff in this facility; retire them.
      await pool.query(
        "UPDATE nurses SET is_active=false WHERE facility='Other' AND ward IS NULL AND id<>$1",
        [lead.id],
      );
      const { configuration } = await service.defaults(admin, b);
      configuration.requirements.forEach((r) => {
        r.minimum = 0;
        r.maximum = null;
      });
      configuration.wardPolicies.forEach((w) => {
        w.specialRule = "none";
      });
      configuration.shifts.push({
        code: "EVE",
        name: "Evening",
        start: "13:00",
        end: "21:00",
        endDayOffset: 0,
        breakMinutes: 30,
        creditedMinutes: 450,
        color: "#14b8a6",
      });
      configuration.patterns.push({
        id: "evenings",
        name: "2 Evening / 2 OFF",
        kind: "repeating",
        steps: [
          { shift: "EVE", days: 2 },
          { shift: "OFF", days: 2 },
        ],
      });
      for (const role of configuration.roles) {
        role.patternId = "evenings";
        role.allowedShifts = ["EVE"];
        role.useWardPattern = false;
        role.specialRule = "none";
        role.requiresReview = false;
      }
      const theatre = configuration.roles.find((r) => r.name === "Theatre Coordinator");
      Object.assign(theatre, { scope: "facility", approvalGroup: "head", category: "none" });

      // Activation must start on the facility's 28-day boundary in the future.
      // Rota periods are calendar months, so a later period starts on the 1st.
      const start = "2046-01-01";

      const draft = await service.create(admin, b, { configuration });
      const run = await service.saveRun(admin, b, draft.id, { revision: 1, startDate: start });
      assert.equal(run.hasBlockingIssues, false, JSON.stringify(run.diagnostics));
      const activated = await post(`runs/${run.runId}/activate`);
      assert.equal(activated.status, 201, JSON.stringify(await activated.json()));

      // The facility-wide unit is chosen by the configured group, not the role name.
      const headUnit = await post("generate-active", { startDate: start, unit: "group:head" });
      const headBody = await headUnit.json();
      assert.equal(headUnit.status, 201, JSON.stringify(headBody));
      assert.equal(headBody.written, 31); // January 2046
      const headCells = (
        await pool.query(
          "SELECT DISTINCT nurse_id FROM shift_assignments WHERE scheduling_run_id=$1",
          [headBody.runId],
        )
      ).rows;
      assert.deepEqual(
        headCells.map((r) => r.nurse_id),
        [lead.id],
      );
      const all = await post("generate-active", { startDate: start, unit: "all" });
      assert.equal(all.status, 201, JSON.stringify(await all.clone().json()));

      const {
        rows: [evening],
      } = await pool.query(
        "SELECT *,shift_date::text FROM shift_assignments WHERE nurse_id=$1 AND shift='EVE' ORDER BY shift_assignments.shift_date LIMIT 1",
        [lead.id],
      );
      assert.ok(evening, "Custom code is stored in the rota");
      const legacyBase = base.slice(0, base.indexOf("/api/")) + "/api/shift-assignments";
      const read = await fetch(
        `${legacyBase}?nurse_id=${lead.id}&shift_date=${evening.shift_date}&include_shift_definition=true`,
      );
      const [definition] = await read.json();
      assert.equal(definition.scheduled_shift.name, "Evening");
      assert.equal(definition.scheduled_shift.creditedMinutes, 450);
      assert.equal(definition.scheduled_shift.startsAt, `${evening.shift_date}T12:00:00.000Z`);

      // Attendance resolves the saved definition once published.
      await pool.query("UPDATE shift_assignments SET status='published' WHERE id=$1", [evening.id]);
      const { configuredAttendanceDefinition } = require("./lib/configured-attendance");
      const attendance = await configuredAttendanceDefinition(
        pool,
        lead.id,
        evening.shift_date,
        "EVE",
      );
      assert.equal(attendance.code, "EVE");
      assert.equal(attendance.endsAt, `${evening.shift_date}T20:00:00.000Z`);

      const groups = await (
        await fetch(`${apiRoot}/role-groups?date=9999-12-31`, {
          headers: { "x-test-user": reader },
        })
      ).json();
      assert.equal(groups.facilities.Other["theatre coordinator"], "head");
      assert.equal((await fetch(`${apiRoot}/role-groups?date=never`)).status, 400);

      // Configured inter-ward exchange and leave cover approve atomically.
      const { swapConfiguredAssignments } = require("./lib/configured-assignment-swap");
      const day = (offset) =>
        new Date(Date.parse(start) + offset * 86400000).toISOString().slice(0, 10);
      const setCell = async (nurseId, date, shift, preLeave = null) =>
        (
          await pool.query(
            `UPDATE shift_assignments SET shift=$3,pre_leave_shift=$4,status='published'
             WHERE nurse_id=$1 AND shift_date=$2 RETURNING *,shift_date::text`,
            [nurseId, date, shift, preLeave],
          )
        ).rows[0];
      const switchRequest = async (date, reason, nurseId = icuNurse.id) =>
        (
          await pool.query(
            `INSERT INTO leave_requests(nurse_id,nurse_name,type,status,from_date,to_date,reason)
             VALUES ($1,'ICU switcher','Swap','Pending',$2,$2,$3) RETURNING id`,
            [nurseId, date, reason],
          )
        ).rows[0].id;
      const expectedOf = (cells) =>
        cells.map((c) => ({
          id: c.id,
          shift: c.shift,
          definitionRunId: c.shift_definition_run_id ?? c.scheduling_run_id,
        }));
      const actor = { userId: admin, name: "Admin" };
      const cellOf = async (nurseId, date) =>
        (
          await pool.query(
            "SELECT shift,ward,pre_leave_shift FROM shift_assignments WHERE nurse_id=$1 AND shift_date=$2",
            [nurseId, date],
          )
        ).rows[0];

      const exchangeDate = day(10);
      for (const offset of [9, 11]) {
        await setCell(icuNurse.id, day(offset), "OFF");
        await setCell(erNurse.id, day(offset), "OFF");
      }
      const icuDuty = await setCell(icuNurse.id, exchangeDate, "EVE");
      const erOff = await setCell(erNurse.id, exchangeDate, "OFF");
      assert.equal(icuDuty.ward, "ICU");
      assert.equal(erOff.ward, "ER");
      const exchange = await switchRequest(
        exchangeDate,
        `SHIFT_SWITCH|${erNurse.id}|ER switcher|EVE|OFF|INTER_WARD`,
      );
      await swapConfiguredAssignments(pool, expectedOf([icuDuty, erOff]), actor, async () => true, {
        requestId: exchange,
      });
      assert.deepEqual(await cellOf(icuNurse.id, exchangeDate), {
        shift: "OFF",
        ward: "ER",
        pre_leave_shift: null,
      });
      assert.deepEqual(await cellOf(erNurse.id, exchangeDate), {
        shift: "EVE",
        ward: "ICU",
        pre_leave_shift: null,
      });

      const coverDate = day(15);
      for (const offset of [14, 16]) {
        await setCell(icuNurse.id, day(offset), "OFF");
        await setCell(erNurse.id, day(offset), "OFF");
      }
      const onLeave = await setCell(icuNurse.id, coverDate, "LEAVE", "EVE");
      const coverer = await setCell(erNurse.id, coverDate, "OFF");
      const cover = await switchRequest(
        coverDate,
        `SHIFT_SWITCH|${erNurse.id}|ER switcher|EVE|OFF|LEAVE_COVER`,
      );
      await assert.rejects(
        swapConfiguredAssignments(pool, expectedOf([onLeave, coverer]), actor, async () => true, {
          requestId: cover,
        }),
        /approved leave/,
        "Leave cover needs Nurse A's approved leave",
      );
      await pool.query(
        `INSERT INTO leave_requests(nurse_id,nurse_name,type,status,from_date,to_date)
         VALUES ($1,'ICU switcher','Annual','Approved',$2,$2)`,
        [icuNurse.id, coverDate],
      );
      await swapConfiguredAssignments(
        pool,
        expectedOf([onLeave, coverer]),
        actor,
        async () => true,
        {
          requestId: cover,
        },
      );
      assert.deepEqual(await cellOf(icuNurse.id, coverDate), {
        shift: "LEAVE",
        ward: "ICU",
        pre_leave_shift: "EVE",
      });
      assert.deepEqual(await cellOf(erNurse.id, coverDate), {
        shift: "EVE",
        ward: "ICU",
        pre_leave_shift: null,
      });
      assert.equal(
        (await pool.query("SELECT status FROM leave_requests WHERE id=$1", [cover])).rows[0].status,
        "Approved",
      );
    });
    await t.test(
      "saving applies rules from the next rota draft and Rota generation reports shortfalls",
      async () => {
        const otherBase = base.replace(a, b);
        const root = base.slice(0, base.indexOf("/facilities"));
        const call = async (url, method = "GET", body) => {
          const response = await fetch(url, {
            method,
            headers: { "content-type": "application/json" },
            body: body && JSON.stringify(body),
          });
          return { status: response.status, body: await response.json() };
        };
        const { versions } = (await call(`${otherBase}/versions`)).body;
        const current = (await call(`${otherBase}/versions/${versions[0].id}`)).body;
        // Demand more staff than exist, so every generated day is short.
        const configuration = structuredClone(current.configuration);
        configuration.requirements.forEach((r) => {
          r.minimum = 50;
          r.maximum = null;
        });
        const saved = await call(`${otherBase}/versions/${current.id}`, "PUT", {
          revision: current.revision,
          configuration,
        });
        assert.equal(saved.status, 200, JSON.stringify(saved.body));
        const {
          rows: [next],
        } = await pool.query(
          `SELECT GREATEST(rota_period_end(MAX(sa.shift_date)) + 1,
             rota_period_start((now() AT TIME ZONE 'Africa/Lagos')::date))::text AS start
           FROM shift_assignments sa JOIN nurses n ON n.id=sa.nurse_id WHERE n.facility='Other'`,
        );
        assert.equal(saved.body.appliesFrom, next.start, "The first period without a draft");
        assert.equal(
          (await call(`${otherBase}/versions/${current.id}`)).body.appliesFrom,
          next.start,
        );
        const {
          rows: [event],
        } = await pool.query(
          "SELECT state,effective_from::text FROM scheduling_policy_events WHERE facility_id=$1 ORDER BY sequence DESC LIMIT 1",
          [b],
        );
        assert.deepEqual(event, { state: "active", effective_from: next.start });
        assert.equal(
          (await call(`${root}/rota-rules?facility=Other&date=${next.start}`)).body.configured,
          true,
        );
        const {
          rows: [ward],
        } = await pool.query(
          `SELECT w.name FROM wards w WHERE w.facility='Other' AND EXISTS (
             SELECT 1 FROM nurses n WHERE n.facility='Other' AND n.is_active AND n.role='Nurse'
               AND split_part(n.ward, ',', 1)=w.name) ORDER BY w.name LIMIT 1`,
        );
        const generated = await call(`${root}/rota-generate`, "POST", {
          facility: "Other",
          startDate: next.start,
          ward: ward.name,
        });
        assert.equal(generated.status, 201, JSON.stringify(generated.body));
        assert.ok(generated.body.written > 0);
        assert.ok(
          generated.body.issues.some((m) => /required 50\+/.test(m)),
          "Shortfalls are reported, not blocking",
        );
        assert.equal(
          (
            await call(`${root}/rota-generate`, "POST", {
              facility: "Other",
              startDate: next.start,
              group: "unknown",
            })
          ).status,
          400,
        );
      },
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
}
