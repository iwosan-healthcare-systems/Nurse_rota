import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
const require = createRequire(new URL("../nurse-api/package.json", import.meta.url));
const { Pool } = require("pg");
const tenant = require("./lib/tenant-context");
const connectionString = process.env.SCHEDULING_TEST_DATABASE_URL;
if (!connectionString || !["localhost", "127.0.0.1"].includes(new URL(connectionString).hostname))
  throw new Error("Use test-scheduling-postgres.mjs to create an isolated local database.");
const LAGOON = "00000000-0000-4000-8000-000000000001";
const root = new Pool({ connectionString });

test("hospital row-level security isolates tenant data", async (t) => {
  let app;
  try {
    assert.equal(
      (await root.query("SELECT COUNT(*)::int AS n FROM pg_tables WHERE schemaname='public'"))
        .rows[0].n,
      0,
      "Refusing to run against a nonempty database",
    );
    await root.query(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
    const dir = new URL("../nurse-api/migrations/", import.meta.url);
    // Existing Lagoon data before the hospital migration.
    const migrations = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of migrations.filter((f) => f < "049"))
      await root.query(readFileSync(new URL(file, dir), "utf8"));
    const { rows: before } = await root.query(
      "INSERT INTO profiles(full_name,email) VALUES ('Lagoon admin','admin@lagoon.test') RETURNING id",
    );
    const lagoonAdmin = before[0].id;
    const { rows: platformRows } = await root.query(
      "INSERT INTO profiles(full_name,email) VALUES ('Ekene','Ekene.Okoli@lagoonhospitals.com') RETURNING id",
    );
    await root.query(
      "INSERT INTO roles(key,label,description,is_system) VALUES ('ward_clerk','Ward Clerk','',false)",
    );
    await root.query(
      "INSERT INTO nurses(name,role,ward,facility) VALUES ('Lagoon nurse','Nurse','ICU','Ikoyi')",
    );
    await root.query("INSERT INTO wards(name,facility) VALUES ('ICU','Ikoyi')");
    for (const file of migrations.filter((f) => f >= "049"))
      await root.query(readFileSync(new URL(file, dir), "utf8"));

    // Production connects as the (non-superuser) table owner; FORCE RLS applies to owners.
    await root.query("CREATE ROLE rota_app LOGIN NOSUPERUSER PASSWORD 'test'");
    const { rows: tables } = await root.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public'",
    );
    for (const { tablename } of tables)
      await root.query(`ALTER TABLE ${tablename} OWNER TO rota_app`);
    const url = new URL(connectionString);
    url.username = "rota_app";
    url.password = "test";
    app = tenant.bindTenantPool(new Pool({ connectionString: url.toString() }));

    const other = (
      await tenant.runInPlatform(() =>
        app.query("INSERT INTO hospitals(name) VALUES ('Test Hospital') RETURNING id"),
      )
    ).rows[0].id;
    const inLagoon = (fn) => tenant.runInHospital(LAGOON, fn, lagoonAdmin);
    const inOther = (fn) => tenant.runInHospital(other, fn);

    await t.test("existing data belongs to Iwosan Lagoon Hospital", async () => {
      const { rows } = await tenant.runInPlatform(() =>
        app.query("SELECT hospital_id FROM nurses UNION SELECT hospital_id FROM wards"),
      );
      assert.deepEqual(rows, [{ hospital_id: LAGOON }]);
      const members = await tenant.runInPlatform(() =>
        app.query("SELECT hospital_id FROM hospital_memberships WHERE user_id=$1", [lagoonAdmin]),
      );
      assert.deepEqual(members.rows, [{ hospital_id: LAGOON }]);
    });

    await t.test(
      "each hospital sees only its own rows, even with the same facility name",
      async () => {
        await inOther(() =>
          app.query(
            "INSERT INTO nurses(name,role,ward,facility,employee_id) VALUES ('Other nurse','Nurse','ICU','Ikoyi','E1')",
          ),
        );
        const names = async (scope) =>
          (await scope(() => app.query("SELECT name FROM nurses ORDER BY name"))).rows.map(
            (r) => r.name,
          );
        assert.deepEqual(await names(inLagoon), ["Lagoon nurse"]);
        assert.deepEqual(await names(inOther), ["Other nurse"]);
        assert.deepEqual(await names(tenant.runInPlatform), ["Lagoon nurse", "Other nurse"]);
        assert.equal(
          (
            await inOther(() =>
              app.query("SELECT hospital_id FROM nurses WHERE name='Other nurse'"),
            )
          ).rows[0].hospital_id,
          other,
          "New rows default to the current hospital",
        );
        const updated = await inLagoon(() =>
          app.query("UPDATE nurses SET role='Matron' WHERE name='Other nurse'"),
        );
        assert.equal(updated.rowCount, 0, "Another hospital's rows cannot be changed");
        await assert.rejects(
          inLagoon(() =>
            app.query(
              "INSERT INTO nurses(name,role,facility,hospital_id) VALUES ('Smuggled','Nurse','Ikoyi',$1)",
              [other],
            ),
          ),
          /row-level security/,
        );
      },
    );

    await t.test("per-hospital uniqueness and settings", async () => {
      await inLagoon(() =>
        app.query(
          "INSERT INTO nurses(name,role,facility,employee_id) VALUES ('Lagoon E1','Nurse','Ikoyi','E1')",
        ),
      );
      await assert.rejects(
        inLagoon(() =>
          app.query(
            "INSERT INTO nurses(name,role,facility,employee_id) VALUES ('Dup','Nurse','Ikoyi','E1')",
          ),
        ),
        /nurses_employee_id_unique/,
      );
      for (const [scope, value] of [
        [inLagoon, "lagoon"],
        [inOther, "other"],
      ])
        await scope(() =>
          app.query(
            `INSERT INTO portal_settings(key,value) VALUES ('gps_settings',$1)
             ON CONFLICT (hospital_id,key) DO UPDATE SET value=EXCLUDED.value`,
            [JSON.stringify({ name: value })],
          ),
        );
      const setting = async (scope) =>
        (await scope(() => app.query("SELECT value FROM portal_settings WHERE key='gps_settings'")))
          .rows[0].value.name;
      assert.equal(await setting(inLagoon), "lagoon");
      assert.equal(await setting(inOther), "other");
    });

    await t.test("accounts are visible only inside their hospitals", async () => {
      const created = await inOther(() =>
        app.query(
          "INSERT INTO profiles(full_name,email) VALUES ('Other admin','admin@other.test') RETURNING id",
        ),
      );
      const otherAdmin = created.rows[0].id;
      await inOther(() =>
        app.query("INSERT INTO user_roles(user_id,role) VALUES ($1,'admin')", [otherAdmin]),
      );
      const visible = async (scope) =>
        (
          await scope(() => app.query("SELECT full_name FROM profiles ORDER BY full_name"))
        ).rows.map((r) => r.full_name);
      assert.deepEqual(await visible(inOther), ["Other admin"]);
      assert.deepEqual(await visible(inLagoon), ["Ekene", "Lagoon admin"]);
      const admins = await inLagoon(() =>
        app.query("SELECT user_id FROM user_roles WHERE role='admin'"),
      );
      assert.ok(!admins.rows.some((r) => r.user_id === otherAdmin), "Role lookups stay local");
      // A super admin outside the hospital still sees their own profile.
      const own = await tenant.runInHospital(
        other,
        () => app.query("SELECT id FROM profiles WHERE id=$1", [lagoonAdmin]),
        lagoonAdmin,
      );
      assert.equal(own.rowCount, 1);
    });

    await t.test("scheduling facilities are scoped per hospital", async () => {
      for (const scope of [inLagoon, inOther])
        await scope(() =>
          app.query(
            "INSERT INTO scheduling_facilities(name,legacy_facility) VALUES ('Ikoyi','Ikoyi')",
          ),
        );
      const facilities = async (scope) =>
        (
          await scope(() =>
            app.query(
              "SELECT organization_id FROM scheduling_facilities WHERE legacy_facility='Ikoyi'",
            ),
          )
        ).rows.map((r) => r.organization_id);
      assert.deepEqual(await facilities(inOther), [other]);
      assert.deepEqual(await facilities(inLagoon), [LAGOON]);
    });

    await t.test("API switching, access checks, creation and grants", async () => {
      process.env.JWT_SECRET = "tenancy-test-secret";
      const jwt = require("jsonwebtoken");
      const load = (file, deps) => {
        const module = { exports: {} };
        vm.runInNewContext(readFileSync(new URL(`../nurse-api/${file}`, import.meta.url), "utf8"), {
          module,
          process,
          console,
          require: (name) => (name in deps ? deps[name] : require(name)),
        });
        return module.exports;
      };
      const deps = {
        "../db": app,
        "../lib/tenant-context": tenant,
        "../lib/hospital-setup": require("./lib/hospital-setup"),
        "../lib/mailer": { sendMail: async () => {}, portalUrl: () => "" },
      };
      const { requireAuth } = load("middleware/auth.js", deps);
      const express = require("express");
      const server = express();
      server.use(express.json());
      server.use("/api/hospitals", requireAuth, load("routes/hospitals.js", deps));
      server.use((error, req, res, next) => res.status(500).json({ error: error.message }));
      const listener = await new Promise((resolve) => {
        const s = server.listen(0, "127.0.0.1", () => resolve(s));
      });
      const base = `http://127.0.0.1:${listener.address().port}/api/hospitals`;
      const token = (userId, roles = ["admin"]) =>
        jwt.sign({ userId, full_name: "Tester", roles }, process.env.JWT_SECRET);
      const call = (userId, path, { method = "GET", hospital, body, roles } = {}) =>
        fetch(base + path, {
          method,
          headers: {
            authorization: `Bearer ${token(userId, roles)}`,
            "content-type": "application/json",
            ...(hospital ? { "x-hospital-id": hospital } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      try {
        const mine = await (await call(lagoonAdmin, "/mine")).json();
        assert.deepEqual(
          mine.hospitals.map((h) => h.name),
          ["Iwosan Lagoon Hospital"],
        );
        assert.equal(mine.current_hospital_id, LAGOON);
        assert.equal((await call(lagoonAdmin, "/mine", { hospital: other })).status, 403);
        assert.equal((await call(lagoonAdmin, "/mine", { hospital: "nope" })).status, 400);
        const setup = {
          name: "Third",
          admin: { full_name: "Third Admin", email: "admin@third.test" },
          gps: {
            radius_m: 500,
            sites: [{ name: "Main", locations: [{ label: "Main gate", lat: 9.05, lng: 7.49 }] }],
          },
          security: { min_password_length: 10, password_expiry_days: 90, idle_timeout_minutes: 20 },
          leave: {
            sick_emergency_max_days: 4,
            shift_switch_min_notice_hours: 12,
            grace_leave_types: ["Sick"],
            entitlements: {
              Annual: 21,
              "Study Leave": 3,
              "Compassionate Leave": 2,
              Maternity: 90,
              Sick: 10,
            },
          },
          rota: {
            deadlines: {
              leave_closure_days: 20,
              generate_days: 18,
              edit_close_days: 16,
              publish_deadline_days: 12,
              revert_grace_days: 3,
            },
            jobs_paused: { auto_generate: false, auto_submit: true, auto_publish: true },
          },
          reminders: { missed_shift_hours: 2, upcoming_shift_minutes: 30 },
          roles: {
            enabled: ["nurse", "chief_matron", "ward_clerk"],
            custom: [{ key: "theatre_lead", label: "Theatre Lead", description: "" }],
          },
          permissions: {
            capabilities: [{ key: "view_rota", roles: ["nurse", "theatre_lead"] }],
            menu_permissions: { "/": ["nurse"] },
          },
        };
        assert.equal(
          (await call(lagoonAdmin, "/", { method: "POST", body: setup })).status,
          403,
          "Hospital admins cannot create hospitals",
        );
        const facilities = await (await call(lagoonAdmin, "/current/facilities")).json();
        assert.deepEqual(facilities.facilities, ["Ikoyi"]);

        await tenant.runInPlatform(() =>
          app.query("UPDATE profiles SET is_super_admin=true WHERE id=$1", [lagoonAdmin]),
        );
        const switched = await call(lagoonAdmin, "/mine", { hospital: other });
        assert.equal(switched.status, 200, "Super admins may enter any hospital");
        assert.equal((await switched.json()).hospitals.length, 2);
        // Creation requires the full setup; nothing is copied or defaulted.
        const partial = await call(lagoonAdmin, "/", {
          method: "POST",
          body: { name: "Third", admin: setup.admin },
        });
        assert.equal(partial.status, 400);
        const partialErrors = (await partial.json()).errors.map((e) => e.path);
        for (const path of [
          "gps.radius_m",
          "security.min_password_length",
          "permissions.capabilities",
        ])
          assert.ok(partialErrors.includes(path), path);
        const foreignRole = await call(lagoonAdmin, "/", {
          method: "POST",
          body: {
            ...setup,
            permissions: {
              ...setup.permissions,
              capabilities: [{ key: "view_rota", roles: ["hr_admin"] }],
            },
          },
        });
        assert.equal(foreignRole.status, 400, "Only the hospital's own roles can be granted");
        const created = await call(lagoonAdmin, "/", { method: "POST", body: setup });
        const third = await created.json();
        assert.equal(created.status, 201, JSON.stringify(third));
        assert.match(third.temporary_password, /^Nr-/);
        const repeated = await call(lagoonAdmin, "/", { method: "POST", body: setup });
        assert.equal(repeated.status, 400);
        assert.ok(
          (await repeated.json()).errors.some((e) => e.path === "roles.custom[0].key"),
          "A new role's key must not already exist",
        );
        const again = {
          ...setup,
          roles: { enabled: ["nurse"], custom: [] },
          permissions: {
            capabilities: [{ key: "view_rota", roles: ["nurse"] }],
            menu_permissions: { "/": ["nurse"] },
          },
        };
        assert.equal(
          (await call(lagoonAdmin, "/", { method: "POST", body: again })).status,
          409,
          "Duplicate administrator email",
        );
        const renamedAdmin = { ...again, admin: { ...setup.admin, email: "other@third.test" } };
        assert.equal(
          (await call(lagoonAdmin, "/", { method: "POST", body: renamedAdmin })).status,
          409,
          "Duplicate hospital name",
        );
        const settingRows = await tenant.runInHospital(third.id, () =>
          app.query("SELECT key, value FROM portal_settings"),
        );
        const settings = Object.fromEntries(settingRows.rows.map((r) => [r.key, r.value]));
        assert.deepEqual(Object.keys(settings.gps_settings.facilities), ["Main"]);
        assert.equal(settings.gps_settings.radius_m, 500);
        assert.equal(settings.min_password_length, 10);
        assert.equal(settings.leave_entitlement_defaults.Annual, 21);
        assert.deepEqual(settings.rota_jobs_paused, {
          auto_generate: false,
          auto_submit: true,
          auto_publish: true,
        });
        assert.deepEqual(settings.capabilities, [
          { key: "view_rota", roles: ["admin", "nurse", "theatre_lead"] },
        ]);
        assert.equal(Object.keys(settings).length, 13, "Exactly the entered settings");
        const thirdRoles = await tenant.runInHospital(third.id, () =>
          app.query("SELECT key, (hospital_id IS NOT NULL) AS custom FROM roles ORDER BY key"),
        );
        assert.deepEqual(thirdRoles.rows, [
          { key: "admin", custom: false },
          { key: "chief_matron", custom: false },
          { key: "nurse", custom: false },
          { key: "theatre_lead", custom: true },
          { key: "ward_clerk", custom: true },
        ]);
        const lagoonSeesTheatreLead = await tenant.runInHospital(LAGOON, () =>
          app.query("SELECT 1 FROM roles WHERE key = 'theatre_lead'"),
        );
        assert.equal(lagoonSeesTheatreLead.rowCount, 0, "New hospital's own role stays private");
        const thirdAdmin = await tenant.runInHospital(third.id, () =>
          app.query(
            `SELECT p.must_change_password, ur.role FROM profiles p
             JOIN user_roles ur ON ur.user_id = p.id WHERE p.email = 'admin@third.test'`,
          ),
        );
        assert.deepEqual(thirdAdmin.rows, [{ must_change_password: true, role: "admin" }]);
        const thirdFacilities = await (
          await call(lagoonAdmin, "/current/facilities", { hospital: third.id })
        ).json();
        assert.deepEqual(thirdFacilities.facilities, ["Main"]);

        // A Lagoon nurse account is granted access to Test Hospital.
        const nurseUser = (
          await tenant.runInHospital(LAGOON, () =>
            app.query("INSERT INTO profiles(full_name) VALUES ('Floating CNO') RETURNING id"),
          )
        ).rows[0].id;
        assert.equal((await call(nurseUser, "/mine", { hospital: other })).status, 403);
        assert.equal(
          (await call(nurseUser, `/${other}/members/${nurseUser}`, { method: "PUT" })).status,
          403,
          "Only super admins grant access",
        );
        const grant = await call(lagoonAdmin, `/${other}/members/${nurseUser}`, { method: "PUT" });
        assert.deepEqual(await grant.json(), { changed: true });
        const granted = await (await call(nurseUser, "/mine", { hospital: other })).json();
        assert.deepEqual(
          granted.hospitals.map((h) => h.name),
          ["Iwosan Lagoon Hospital", "Test Hospital"],
        );
        assert.equal(granted.current_hospital_id, other);
        await call(lagoonAdmin, `/${other}/members/${nurseUser}`, { method: "DELETE" });
        assert.equal((await call(nurseUser, "/mine", { hospital: other })).status, 403);
        const users = await (await call(lagoonAdmin, "/users")).json();
        assert.ok(
          users.users.some((u) => u.full_name === "Other admin"),
          "Platform user list",
        );

        // Hospital logos: platform admins set any hospital's; a hospital's own
        // admin sets its own; others cannot; invalid files are refused.
        const png = "data:image/png;base64,iVBORw0KGgo=";
        const setLogo = (userId, path, logo, roles) =>
          call(userId, path, { method: "PUT", body: { logo }, roles });
        assert.equal((await setLogo(lagoonAdmin, `/${other}/logo`, png)).status, 200);
        const otherMine = await (await call(lagoonAdmin, "/mine", { hospital: other })).json();
        assert.equal(otherMine.current_logo, png, "Current hospital's logo is returned");
        const lagoonMine = await (await call(lagoonAdmin, "/mine")).json();
        assert.equal(lagoonMine.current_logo, null, "Hospitals without a logo get none");
        assert.ok(
          lagoonMine.hospitals.every((h) => !("logo" in h)),
          "Other logos not sent",
        );
        assert.equal(
          (await setLogo(lagoonAdmin, `/${other}/logo`, "data:text/html;base64,PHA+")).status,
          400,
          "Only images are accepted",
        );
        const otherAdmin = (
          await tenant.runInPlatform(() =>
            app.query("SELECT id FROM profiles WHERE email='admin@other.test'"),
          )
        ).rows[0].id;
        assert.equal((await setLogo(otherAdmin, "/current/logo", null)).status, 200);
        assert.equal(
          (await setLogo(otherAdmin, `/${LAGOON}/logo`, png)).status,
          403,
          "Hospital admins cannot change other hospitals' logos",
        );
        assert.equal(
          (await setLogo(nurseUser, "/current/logo", png, ["nurse"])).status,
          403,
          "Non-admins cannot change the logo",
        );
        const cleared = await tenant.runInPlatform(() =>
          app.query("SELECT logo FROM hospitals WHERE id=$1", [other]),
        );
        assert.equal(cleared.rows[0].logo, null);
      } finally {
        await new Promise((resolve) => listener.close(resolve));
      }
    });

    await t.test("custom roles belong to one hospital; platform admin is seeded", async () => {
      const promoted = await tenant.runInPlatform(() =>
        app.query("SELECT is_super_admin FROM profiles WHERE id=$1", [platformRows[0].id]),
      );
      assert.equal(promoted.rows[0].is_super_admin, true);
      const keys = async (scope) =>
        (
          await scope(() => app.query("SELECT key FROM roles WHERE NOT is_system ORDER BY key"))
        ).rows.map((r) => r.key);
      assert.deepEqual(
        await keys(inLagoon),
        ["ward_clerk", "ward_manager"],
        "Existing custom roles stay Lagoon's",
      );
      await inOther(() =>
        app.query(
          "INSERT INTO roles(key,label,description,is_system) VALUES ('porter_lead','Porter Lead','',false)",
        ),
      );
      assert.deepEqual(await keys(inOther), ["porter_lead"]);
      assert.ok(!(await keys(inLagoon)).includes("porter_lead"));
      // Built-in roles appear in a hospital only once it enables them.
      const nurseRole = () => inOther(() => app.query("SELECT 1 FROM roles WHERE key='nurse'"));
      assert.equal((await nurseRole()).rowCount, 0, "Not enabled in this hospital");
      await inOther(() =>
        app.query("INSERT INTO hospital_roles(hospital_id, role_key) VALUES ($1, 'nurse')", [
          other,
        ]),
      );
      assert.equal((await nurseRole()).rowCount, 1, "Enabled built-in roles are visible");
      assert.equal(
        (await inOther(() => app.query("SELECT 1 FROM roles WHERE key='admin'"))).rowCount,
        1,
        "Every hospital has Administrator",
      );
      assert.equal(
        (await inLagoon(() => app.query("SELECT 1 FROM roles WHERE key='cno'"))).rowCount,
        1,
        "Lagoon keeps every role it had",
      );
      const otherUser = (
        await inOther(() =>
          app.query("INSERT INTO profiles(full_name) VALUES ('Role test') RETURNING id"),
        )
      ).rows[0].id;
      await assert.rejects(
        inOther(() =>
          app.query("INSERT INTO user_roles(user_id,role) VALUES ($1,'ward_clerk')", [otherUser]),
        ),
        /not available in this hospital/,
      );
      await inOther(() =>
        app.query("INSERT INTO user_roles(user_id,role) VALUES ($1,'porter_lead')", [otherUser]),
      );
      const edited = await inOther(() =>
        app.query("UPDATE roles SET label='Renamed' WHERE key IN ('nurse','ward_clerk')"),
      );
      assert.equal(edited.rowCount, 0, "System and other hospitals' roles are read-only");
    });

    await t.test("a new hospital's locations join Scheduling with grants", async () => {
      const {
        createSchedulingConfigurationService,
      } = require("./lib/scheduling-configuration-service");
      const service = createSchedulingConfigurationService(app);
      const otherAdmin = (
        await tenant.runInPlatform(() =>
          app.query("SELECT id FROM profiles WHERE email='admin@other.test'"),
        )
      ).rows[0].id;
      await inOther(() => app.query("INSERT INTO wards(name,facility) VALUES ('Theatre','Annex')"));
      // Facility and access grants are created together under row-level security.
      const listed = await inOther(() => service.listFacilities(otherAdmin));
      assert.ok(listed.facilities.some((f) => f.name === "Annex"));
      const lagoonSees = await inLagoon(() =>
        app.query("SELECT 1 FROM scheduling_facilities WHERE legacy_facility='Annex'"),
      );
      assert.equal(lagoonSees.rowCount, 0);
    });

    await t.test("background tasks run once per hospital in its context", async () => {
      const seen = [];
      await tenant.forEachHospital(app, async (hospital) => {
        const { rows } = await app.query("SELECT COUNT(*)::int AS n FROM nurses");
        seen.push([hospital.name, rows[0].n]);
      });
      assert.deepEqual(seen, [
        ["Iwosan Lagoon Hospital", 2],
        ["Test Hospital", 1],
        ["Third", 0],
      ]);
    });
  } finally {
    if (app) await app.end();
    await root.end();
  }
});
