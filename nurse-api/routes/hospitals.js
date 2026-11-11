// Hospitals (tenants): switching, creation and access grants. Hospital data is
// separated by row-level security; these platform operations run in platform
// scope and are limited to super admins, except reading your own hospitals and
// the current hospital's facilities.
const router = require("express").Router();
const pool = require("../db");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { runInPlatform } = require("../lib/tenant-context");
const { validateHospitalSetup } = require("../lib/hospital-setup");
const { LAGOON_HOSPITAL_ID } = require("../lib/hospital-defaults");
const { sendMail, portalUrl } = require("../lib/mailer");
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const platform = (req, fn) => runInPlatform(fn, req.user.userId);
const superAdmin = (req, res, next) =>
  req.user.isSuperAdmin
    ? next()
    : res.status(403).json({ error: "Only platform administrators can manage hospitals" });
const validName = (name) =>
  typeof name === "string" && name.trim().length >= 1 && name.trim().length <= 160;

// Hospitals the signed-in user may switch to, and the one this request is in.
router.get(
  "/mine",
  wrap(async (req, res) => {
    const { rows } = await platform(req, () =>
      pool.query(
        `SELECT h.id, h.name, h.is_active, CASE WHEN h.id = $3 THEN h.logo END AS logo FROM hospitals h
         WHERE $2 OR (h.is_active AND EXISTS (SELECT 1 FROM hospital_memberships m
                             WHERE m.hospital_id = h.id AND m.user_id = $1))
         ORDER BY h.created_at, h.name`,
        [req.user.userId, req.user.isSuperAdmin, req.hospitalId],
      ),
    );
    res.json({
      hospitals: rows.map(({ logo, ...h }) => h),
      current_hospital_id: req.hospitalId,
      // The current hospital's own logo; null means use the application's logo.
      current_logo: rows.find((h) => h.id === req.hospitalId)?.logo ?? null,
      is_super_admin: req.user.isSuperAdmin,
    });
  }),
);

// Hospital logos: a PNG, JPEG, WebP or SVG data URL (the browser downsizes photos),
// or null to fall back to the application's logo.
const LOGO = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/;
async function saveLogo(req, res, hospitalId) {
  const logo = req.body?.logo ?? null;
  if (logo !== null && (typeof logo !== "string" || logo.length > 550000 || !LOGO.test(logo)))
    return res
      .status(400)
      .json({ error: "Upload a PNG, JPEG, WebP or SVG image of about 400 KB or less" });
  const { rows } = await platform(req, () =>
    pool.query(
      `UPDATE hospitals SET logo = $2, logo_updated_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END
       WHERE id = $1 RETURNING id`,
      [hospitalId, logo],
    ),
  );
  if (!rows[0]) return res.status(404).json({ error: "Hospital not found" });
  await pool.query(
    "INSERT INTO audit_logs (action, actor_id, actor_name, target) VALUES ($1,$2,$3,$4)",
    [
      logo ? "Hospital logo updated" : "Hospital logo removed",
      req.user.userId,
      req.user.full_name ?? null,
      hospitalId,
    ],
  );
  res.json({ logo });
}
// The current hospital's administrator manages its own logo.
router.put(
  "/current/logo",
  (req, res, next) =>
    (req.user.roles || []).includes("admin")
      ? next()
      : res.status(403).json({ error: "Only administrators can change the hospital logo" }),
  wrap((req, res) => saveLogo(req, res, req.hospitalId)),
);

// Facility (site) names in the current hospital: its GPS sites, wards and staff.
router.get(
  "/current/facilities",
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT DISTINCT btrim(facility) AS name FROM (
         SELECT facility FROM wards UNION SELECT facility FROM nurses
         UNION SELECT jsonb_object_keys(value->'facilities') FROM portal_settings
           WHERE key = 'gps_settings' AND jsonb_typeof(value->'facilities') = 'object') f
       WHERE facility IS NOT NULL AND btrim(facility) <> '' ORDER BY 1`,
    );
    res.json({ facilities: rows.map((r) => r.name) });
  }),
);

// Whether row-level security actually applies to the API's database user.
// Postgres skips it for superusers and BYPASSRLS roles.
router.get(
  "/security",
  superAdmin,
  wrap(async (req, res) => {
    const {
      rows: [role],
    } = await pool.query(
      "SELECT current_user AS database_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    res.json({
      database_user: role.database_user,
      superuser: role.rolsuper,
      bypasses_row_security: role.rolbypassrls,
      isolation_enforced: !role.rolsuper && !role.rolbypassrls,
    });
  }),
);

router.get(
  "/",
  superAdmin,
  wrap(async (req, res) => {
    const { rows } = await platform(req, () =>
      pool.query(
        `SELECT h.id, h.name, h.created_at, h.logo, h.is_active,
           (SELECT COUNT(*)::int FROM hospital_memberships m WHERE m.hospital_id = h.id) AS members,
           (SELECT COUNT(*)::int FROM nurses n WHERE n.hospital_id = h.id AND n.is_active) AS staff
         FROM hospitals h ORDER BY h.created_at, h.name`,
      ),
    );
    res.json({ hospitals: rows });
  }),
);

// Create a hospital from its full setup: name, sites with GPS fences, password
// and session policy, leave rules and default caps, rota deadlines, reminders,
// permissions, menu access and its first administrator. Nothing is copied from
// another hospital and nothing falls back to defaults.
router.post(
  "/",
  superAdmin,
  wrap(async (req, res) => {
    // Any catalogue role may be enabled: system roles and other hospitals' custom roles.
    const { rows: roleRows } = await platform(req, () => pool.query("SELECT key FROM roles"));
    const setup = validateHospitalSetup(req.body, {
      roleKeys: new Set(roleRows.map((r) => r.key)),
    });
    if (setup.errors.length)
      return res.status(400).json({ error: "Complete every setup step", errors: setup.errors });
    const temporaryPassword = `Nr-${crypto.randomBytes(9).toString("base64url")}`;
    const hash = await bcrypt.hash(temporaryPassword, 12);
    const result = await platform(req, async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: taken } = await client.query(
          "SELECT 1 FROM profiles WHERE lower(email) = $1 LIMIT 1",
          [setup.admin.email],
        );
        if (taken.length) {
          await client.query("ROLLBACK");
          return {
            status: 409,
            error:
              "That administrator email already has an account. Use another email, or grant the existing account access after creating the hospital.",
          };
        }
        const {
          rows: [hospital],
        } = await client.query(
          `INSERT INTO hospitals (name, logo, logo_updated_at)
           VALUES ($1, $2, CASE WHEN $2::text IS NULL THEN NULL ELSE now() END)
           RETURNING id, name, created_at`,
          [setup.name, setup.logo],
        );
        // Roles created for this hospital belong to it; every chosen role is enabled.
        for (const role of setup.roles.custom)
          await client.query(
            "INSERT INTO roles (key, label, description, is_system, hospital_id) VALUES ($1, $2, $3, false, $4)",
            [role.key, role.label, role.description, hospital.id],
          );
        for (const key of setup.roles.keys)
          await client.query("INSERT INTO hospital_roles (hospital_id, role_key) VALUES ($1, $2)", [
            hospital.id,
            key,
          ]);
        for (const [key, value] of setup.settings)
          await client.query(
            "INSERT INTO portal_settings (hospital_id, key, value) VALUES ($1, $2, $3)",
            [hospital.id, key, JSON.stringify(value)],
          );
        const {
          rows: [account],
        } = await client.query(
          `INSERT INTO profiles (email, full_name, password_hash, must_change_password)
           VALUES ($1, $2, $3, true) RETURNING id`,
          [setup.admin.email, setup.admin.full_name, hash],
        );
        await client.query("INSERT INTO user_roles (user_id, role) VALUES ($1, 'admin')", [
          account.id,
        ]);
        await client.query(
          "INSERT INTO hospital_memberships (hospital_id, user_id, granted_by) VALUES ($1, $2, $3)",
          [hospital.id, account.id, req.user.userId],
        );
        await client.query(
          "INSERT INTO audit_logs (hospital_id, action, actor_id, actor_name, target) VALUES ($1,$2,$3,$4,$5)",
          [
            hospital.id,
            "Hospital created",
            req.user.userId,
            req.user.full_name ?? null,
            `${hospital.name}; administrator ${setup.admin.email}`,
          ],
        );
        await client.query("COMMIT");
        return { status: 201, hospital, adminId: account.id };
      } catch (error) {
        await client.query("ROLLBACK");
        if (error.code === "23505")
          return { status: 409, error: "A hospital with this name already exists" };
        throw error;
      } finally {
        client.release();
      }
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    // Best effort after commit; the temporary password is also returned once so
    // the platform administrator can hand it over if the email does not arrive.
    // The mailer logs delivery failures rather than reporting them.
    sendMail({
      to: setup.admin.email,
      subject: `Your ${result.hospital.name} Nurses Rota account`,
      title: "Your administrator account has been created",
      bodyHtml: `<p>Hi ${escapeHtml(setup.admin.full_name)},</p>
<p>You are the administrator for <strong>${escapeHtml(result.hospital.name)}</strong> on Nurses Rota.</p>
<p><strong>Username:</strong> ${escapeHtml(setup.admin.email)}<br><strong>Temporary password:</strong> ${escapeHtml(temporaryPassword)}</p>
<p>You will be asked to change it when you first sign in.</p>`,
      ctaText: "Open Portal",
      ctaUrl: portalUrl("/login"),
    }).catch(() => {});
    res.status(201).json({
      ...result.hospital,
      administrator: { id: result.adminId, email: setup.admin.email },
      temporary_password: temporaryPassword,
    });
  }),
);

router.patch(
  "/:id",
  superAdmin,
  wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Invalid hospital" });
    if (!validName(req.body?.name))
      return res.status(400).json({ error: "Enter a hospital name (up to 160 characters)" });
    const { rows } = await platform(req, () =>
      pool.query("UPDATE hospitals SET name = $2 WHERE id = $1 RETURNING id, name", [
        req.params.id,
        req.body.name.trim(),
      ]),
    ).catch((error) => {
      if (error.code === "23505") return { rows: null };
      throw error;
    });
    if (rows === null)
      return res.status(409).json({ error: "A hospital with this name already exists" });
    if (!rows[0]) return res.status(404).json({ error: "Hospital not found" });
    res.json(rows[0]);
  }),
);

// Settings the setup wizard writes, read back so the wizard can edit them.
const SETUP_KEYS = [
  "gps_settings",
  "min_password_length",
  "password_expiry_days",
  "idle_timeout_minutes",
  "sick_emergency_max_days",
  "shift_switch_min_notice_hours",
  "grace_leave_types",
  "leave_entitlement_defaults",
  "rota_deadlines",
  "rota_jobs_paused",
  "shift_reminder_settings",
  "capabilities",
  "menu_permissions",
];
const parseSetting = (value) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

router.get(
  "/:id/setup",
  superAdmin,
  wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Invalid hospital" });
    const result = await platform(req, async () => {
      const {
        rows: [hospital],
      } = await pool.query("SELECT id, name, logo, is_active FROM hospitals WHERE id = $1", [
        req.params.id,
      ]);
      if (!hospital) return null;
      const [{ rows: roles }, { rows: settings }] = await Promise.all([
        pool.query(
          "SELECT role_key FROM hospital_roles WHERE hospital_id = $1 AND role_key <> 'admin' ORDER BY role_key",
          [hospital.id],
        ),
        pool.query(
          "SELECT key, value FROM portal_settings WHERE hospital_id = $1 AND key = ANY($2)",
          [hospital.id, SETUP_KEYS],
        ),
      ]);
      return {
        ...hospital,
        roles: { enabled: roles.map((r) => r.role_key) },
        settings: Object.fromEntries(settings.map((s) => [s.key, parseSetting(s.value)])),
      };
    });
    if (!result) return res.status(404).json({ error: "Hospital not found" });
    res.json(result);
  }),
);

// Save the wizard's settings for an existing hospital. The first administrator
// is set only at creation; accounts are managed under Users and Access.
router.put(
  "/:id/setup",
  superAdmin,
  wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Invalid hospital" });
    const { rows: roleRows } = await platform(req, () => pool.query("SELECT key FROM roles"));
    const setup = validateHospitalSetup(req.body, {
      roleKeys: new Set(roleRows.map((r) => r.key)),
      requireAdmin: false,
    });
    if (setup.errors.length)
      return res.status(400).json({ error: "Complete every setup step", errors: setup.errors });
    const result = await platform(req, async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const {
          rows: [hospital],
        } = await client.query(
          `UPDATE hospitals SET name = $2,
             logo_updated_at = CASE WHEN logo IS DISTINCT FROM $3::text
               THEN CASE WHEN $3::text IS NULL THEN NULL ELSE now() END ELSE logo_updated_at END,
             logo = $3
           WHERE id = $1 RETURNING id, name`,
          [req.params.id, setup.name, setup.logo],
        );
        if (!hospital) {
          await client.query("ROLLBACK");
          return { status: 404, error: "Hospital not found" };
        }
        for (const role of setup.roles.custom)
          await client.query(
            "INSERT INTO roles (key, label, description, is_system, hospital_id) VALUES ($1, $2, $3, false, $4)",
            [role.key, role.label, role.description, hospital.id],
          );
        await client.query(
          "DELETE FROM hospital_roles WHERE hospital_id = $1 AND role_key <> ALL($2::text[])",
          [hospital.id, setup.roles.keys],
        );
        for (const key of setup.roles.keys)
          await client.query(
            "INSERT INTO hospital_roles (hospital_id, role_key) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [hospital.id, key],
          );
        for (const [key, value] of setup.settings)
          await client.query(
            `INSERT INTO portal_settings (hospital_id, key, value) VALUES ($1, $2, $3)
             ON CONFLICT (hospital_id, key) DO UPDATE SET value = EXCLUDED.value`,
            [hospital.id, key, JSON.stringify(value)],
          );
        await client.query(
          "INSERT INTO audit_logs (hospital_id, action, actor_id, actor_name, target) VALUES ($1,$2,$3,$4,$5)",
          [
            hospital.id,
            "Hospital setup updated",
            req.user.userId,
            req.user.full_name ?? null,
            hospital.name,
          ],
        );
        await client.query("COMMIT");
        return { status: 200, hospital };
      } catch (error) {
        await client.query("ROLLBACK");
        if (error.code === "23505")
          return { status: 409, error: "A hospital with this name already exists" };
        throw error;
      } finally {
        client.release();
      }
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.hospital);
  }),
);

// Deactivate or reactivate a hospital. Its data is kept; while inactive its staff
// cannot sign in to it and scheduled jobs skip it.
router.patch(
  "/:id/status",
  superAdmin,
  wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Invalid hospital" });
    if (typeof req.body?.active !== "boolean")
      return res.status(400).json({ error: "Choose active or inactive" });
    if (req.params.id === LAGOON_HOSPITAL_ID && !req.body.active)
      return res.status(409).json({ error: "The pilot hospital cannot be deactivated" });
    const { rows } = await platform(req, async () => {
      const result = await pool.query(
        "UPDATE hospitals SET is_active = $2 WHERE id = $1 RETURNING id, name, is_active",
        [req.params.id, req.body.active],
      );
      if (result.rows[0])
        await pool.query(
          "INSERT INTO audit_logs (hospital_id, action, actor_id, actor_name, target) VALUES ($1,$2,$3,$4,$5)",
          [
            req.params.id,
            req.body.active ? "Hospital reactivated" : "Hospital deactivated",
            req.user.userId,
            req.user.full_name ?? null,
            result.rows[0].name,
          ],
        );
      return result;
    });
    if (!rows[0]) return res.status(404).json({ error: "Hospital not found" });
    res.json(rows[0]);
  }),
);

// Delete a hospital that has no staff or rota yet (for example one created by
// mistake or for testing), with its settings, roles and the accounts that belong
// to no other hospital. Hospitals with records are deactivated instead.
router.delete(
  "/:id",
  superAdmin,
  wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Invalid hospital" });
    if (req.params.id === LAGOON_HOSPITAL_ID)
      return res.status(409).json({ error: "The pilot hospital cannot be deleted" });
    if (req.params.id === req.hospitalId)
      return res.status(409).json({ error: "Switch to another hospital before deleting this one" });
    const hasData =
      "This hospital has staff or rota records, so it cannot be deleted. Deactivate it instead to keep its records.";
    const result = await platform(req, async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const {
          rows: [hospital],
        } = await client.query("SELECT id, name FROM hospitals WHERE id = $1 FOR UPDATE", [
          req.params.id,
        ]);
        if (!hospital) {
          await client.query("ROLLBACK");
          return { status: 404, error: "Hospital not found" };
        }
        const {
          rows: [usage],
        } = await client.query(
          `SELECT EXISTS (SELECT 1 FROM nurses WHERE hospital_id = $1)
               OR EXISTS (SELECT 1 FROM shift_assignments WHERE hospital_id = $1)
               OR EXISTS (SELECT 1 FROM leave_requests WHERE hospital_id = $1)
               OR EXISTS (SELECT 1 FROM shift_logs WHERE hospital_id = $1) AS used`,
          [hospital.id],
        );
        if (usage.used) {
          await client.query("ROLLBACK");
          return { status: 409, error: hasData };
        }
        // Accounts that belong only to this hospital go with it.
        const { rows: accounts } = await client.query(
          `SELECT p.id FROM profiles p JOIN hospital_memberships m ON m.user_id = p.id
            WHERE m.hospital_id = $1 AND NOT p.is_super_admin
              AND NOT EXISTS (SELECT 1 FROM hospital_memberships o
                              WHERE o.user_id = p.id AND o.hospital_id <> $1)`,
          [hospital.id],
        );
        for (const table of [
          "notification_state",
          "user_capability_overrides",
          "rota_edit_requests",
          "rota_transitions",
          "nurse_period_hours",
          "leave_entitlement_adjustments",
          "leave_entitlement_overrides",
          "locum_invites",
          "locum_requests",
          "wards",
          "portal_settings",
          "audit_logs",
        ])
          await client.query(`DELETE FROM ${table} WHERE hospital_id = $1`, [hospital.id]);
        const facilities = "SELECT id FROM scheduling_facilities WHERE organization_id = $1";
        for (const sql of [
          `DELETE FROM scheduling_policy_events WHERE facility_id IN (${facilities})`,
          `DELETE FROM scheduling_facility_access WHERE facility_id IN (${facilities})`,
          "DELETE FROM scheduling_runs WHERE organization_id = $1",
          "DELETE FROM scheduling_config_versions WHERE organization_id = $1",
          "DELETE FROM scheduling_facilities WHERE organization_id = $1",
          "DELETE FROM scheduling_organizations WHERE id = $1",
        ])
          await client.query(sql, [hospital.id]);
        await client.query("DELETE FROM hospitals WHERE id = $1", [hospital.id]);
        // An account still referenced elsewhere (for example as an author) is
        // switched off instead of deleted.
        for (const { id } of accounts) {
          await client.query("SAVEPOINT account");
          try {
            await client.query("DELETE FROM profiles WHERE id = $1", [id]);
          } catch {
            await client.query("ROLLBACK TO SAVEPOINT account");
            await client.query("UPDATE profiles SET is_active = false WHERE id = $1", [id]);
          }
        }
        await client.query(
          "INSERT INTO audit_logs (hospital_id, action, actor_id, actor_name, target) VALUES ($1,$2,$3,$4,$5)",
          [
            LAGOON_HOSPITAL_ID,
            "Hospital deleted",
            req.user.userId,
            req.user.full_name ?? null,
            hospital.name,
          ],
        );
        await client.query("COMMIT");
        return { status: 200, name: hospital.name };
      } catch (error) {
        await client.query("ROLLBACK");
        if (error.code === "23503") return { status: 409, error: hasData };
        throw error;
      } finally {
        client.release();
      }
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ deleted: true, name: result.name });
  }),
);

// The role catalogue for setting up a hospital: system roles and every hospital's
// custom roles, with the hospital that owns each custom role.
router.get(
  "/role-catalog",
  superAdmin,
  wrap(async (req, res) => {
    const { rows } = await platform(req, () =>
      pool.query(
        `SELECT r.key, r.label, r.description, r.is_system, h.name AS hospital_name
         FROM roles r LEFT JOIN hospitals h ON h.id = r.hospital_id
         ORDER BY r.is_system DESC, r.label`,
      ),
    );
    res.json({ roles: rows });
  }),
);

router.put(
  "/:id/logo",
  superAdmin,
  wrap((req, res) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "Invalid hospital" });
    return saveLogo(req, res, req.params.id);
  }),
);

// Every account with the hospitals it can access, for granting cross-hospital access.
router.get(
  "/users",
  superAdmin,
  wrap(async (req, res) => {
    const { rows } = await platform(req, () =>
      pool.query(
        `SELECT p.id, p.full_name, p.email, p.is_active, p.is_super_admin,
           COALESCE(array_agg(m.hospital_id) FILTER (WHERE m.hospital_id IS NOT NULL), '{}') AS hospital_ids,
           COALESCE((SELECT array_agg(ur.role ORDER BY ur.role) FROM user_roles ur WHERE ur.user_id = p.id), '{}') AS roles
         FROM profiles p LEFT JOIN hospital_memberships m ON m.user_id = p.id
         GROUP BY p.id ORDER BY lower(p.full_name)`,
      ),
    );
    res.json({ users: rows });
  }),
);

async function setMembership(req, res, granted) {
  const { id, userId } = req.params;
  if (!UUID.test(id) || !UUID.test(userId))
    return res.status(400).json({ error: "Invalid hospital or user" });
  const result = await platform(req, async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rowCount } = granted
        ? await client.query(
            `INSERT INTO hospital_memberships (hospital_id, user_id, granted_by)
             SELECT h.id, p.id, $3 FROM hospitals h, profiles p WHERE h.id = $1 AND p.id = $2
             ON CONFLICT DO NOTHING`,
            [id, userId, req.user.userId],
          )
        : await client.query(
            "DELETE FROM hospital_memberships WHERE hospital_id = $1 AND user_id = $2",
            [id, userId],
          );
      if (rowCount)
        await client.query(
          "INSERT INTO audit_logs (hospital_id, action, actor_id, actor_name, target) VALUES ($1,$2,$3,$4,$5)",
          [
            id,
            granted ? "Hospital access granted" : "Hospital access revoked",
            req.user.userId,
            req.user.full_name ?? null,
            userId,
          ],
        );
      await client.query("COMMIT");
      return rowCount;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
  res.json({ changed: result > 0 });
}
router.put(
  "/:id/members/:userId",
  superAdmin,
  wrap((req, res) => setMembership(req, res, true)),
);
router.delete(
  "/:id/members/:userId",
  superAdmin,
  wrap((req, res) => setMembership(req, res, false)),
);

router.patch(
  "/users/:userId/super-admin",
  superAdmin,
  wrap(async (req, res) => {
    const { userId } = req.params;
    if (!UUID.test(userId) || typeof req.body?.is_super_admin !== "boolean")
      return res.status(400).json({ error: "Invalid request" });
    if (userId === req.user.userId && !req.body.is_super_admin)
      return res.status(409).json({ error: "You cannot remove your own platform access" });
    const { rows } = await platform(req, () =>
      pool.query(
        "UPDATE profiles SET is_super_admin = $2 WHERE id = $1 RETURNING id, is_super_admin",
        [userId, req.body.is_super_admin],
      ),
    );
    if (!rows[0]) return res.status(404).json({ error: "User not found" });
    res.json(rows[0]);
  }),
);

module.exports = router;
