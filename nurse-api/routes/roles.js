const router = require("express").Router();
const pool = require("../db");
const { requireCapability } = require("../middleware/capability");
const { runInPlatform } = require("../lib/tenant-context");
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const KEY_RE = /^[a-z][a-z0-9_]{1,49}$/;

router.get(
  "/",
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT r.key, r.label, r.description, r.is_system, r.created_at,
              (r.hospital_id IS NOT NULL AND r.hospital_id = app_current_hospital()) AS owned,
              COUNT(ur.id)::int AS usage_count
         FROM roles r
         LEFT JOIN user_roles ur ON ur.role = r.key
        GROUP BY r.key
        ORDER BY r.is_system DESC, r.label`,
    );
    res.json(rows);
  }),
);

router.post(
  "/",
  requireCapability("manage_roles", ["admin", "service_support"]),
  wrap(async (req, res) => {
    const { key, label, description } = req.body;
    if (!key || !label) return res.status(400).json({ error: "key and label are required" });
    if (!KEY_RE.test(key)) {
      return res.status(400).json({
        error: "Key must be lowercase snake_case, 2-50 characters (e.g. ward_clerk)",
      });
    }

    // Keys are unique across hospitals; another hospital's custom role stays private.
    const { rows: existing } = await runInPlatform(() =>
      pool.query("SELECT key FROM roles WHERE key = $1", [key]),
    );
    if (existing[0])
      return res
        .status(409)
        .json({ error: "This role key is already in use. Choose a different key." });

    const { rows } = await pool.query(
      `INSERT INTO roles (key, label, description, is_system)
       VALUES ($1, $2, $3, false) RETURNING key, label, description, is_system, created_at`,
      [key, label, description || ""],
    );
    res.status(201).json({ ...rows[0], usage_count: 0 });
  }),
);

router.patch(
  "/:key",
  requireCapability("manage_roles", ["admin", "service_support"]),
  wrap(async (req, res) => {
    const { label, description } = req.body;
    const fields = [];
    const values = [];
    if (label !== undefined) {
      fields.push(`label = $${fields.length + 1}`);
      values.push(label);
    }
    if (description !== undefined) {
      fields.push(`description = $${fields.length + 1}`);
      values.push(description);
    }
    if (!fields.length) return res.status(400).json({ error: "No valid fields to update" });

    const { rows: target } = await pool.query("SELECT is_system FROM roles WHERE key = $1", [
      req.params.key,
    ]);
    if (target[0]?.is_system)
      return res
        .status(403)
        .json({ error: "System roles are shared by every hospital and cannot be edited here." });
    values.push(req.params.key);
    const { rows } = await pool.query(
      `UPDATE roles SET ${fields.join(", ")} WHERE key = $${values.length}
       RETURNING key, label, description, is_system, created_at`,
      values,
    );
    if (!rows[0]) return res.status(404).json({ error: "Role not found" });
    res.json(rows[0]);
  }),
);

router.delete(
  "/:key",
  requireCapability("manage_roles", ["admin", "service_support"]),
  wrap(async (req, res) => {
    const { rows: roleRows } = await pool.query("SELECT is_system FROM roles WHERE key = $1", [
      req.params.key,
    ]);
    if (!roleRows[0]) return res.status(404).json({ error: "Role not found" });
    if (roleRows[0].is_system) {
      return res.status(400).json({ error: "System roles cannot be deleted." });
    }

    // Count holders in every hospital that enabled this role, not just this one.
    const { rows: usageRows } = await runInPlatform(() =>
      pool.query("SELECT COUNT(*)::int AS count FROM user_roles WHERE role = $1", [req.params.key]),
    );
    const count = usageRows[0].count;
    if (count > 0) {
      return res.status(409).json({
        error: `Cannot delete a role that is currently assigned to ${count} user${count > 1 ? "s" : ""}. Remove it from those users first.`,
      });
    }

    await pool.query("DELETE FROM roles WHERE key = $1", [req.params.key]);
    res.json({ success: true });
  }),
);

// Built-in roles a hospital has not enabled yet (other hospitals' custom roles
// stay private to hospital administrators; platform admins choose them at setup).
router.get(
  "/available",
  requireCapability("manage_roles", ["admin", "service_support"]),
  wrap(async (req, res) => {
    const { rows } = await runInPlatform(() =>
      pool.query(
        `SELECT key, label, description FROM roles
         WHERE hospital_id IS NULL AND key <> 'admin'
           AND NOT EXISTS (SELECT 1 FROM hospital_roles hr
                           WHERE hr.role_key = roles.key AND hr.hospital_id = $1)
         ORDER BY label`,
        [req.hospitalId],
      ),
    );
    res.json(rows);
  }),
);

// Enable a built-in role in the current hospital.
router.put(
  "/:key/hospital",
  requireCapability("manage_roles", ["admin", "service_support"]),
  wrap(async (req, res) => {
    const { rows } = await runInPlatform(() =>
      pool.query("SELECT hospital_id FROM roles WHERE key = $1", [req.params.key]),
    );
    if (!rows[0] || (rows[0].hospital_id && !req.user.isSuperAdmin))
      return res.status(404).json({ error: "Role not found" });
    await pool.query(
      "INSERT INTO hospital_roles (hospital_id, role_key) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [req.hospitalId, req.params.key],
    );
    res.json({ enabled: true });
  }),
);

// Remove a role from the current hospital (it stays in the catalogue). Only
// possible while nobody with access to this hospital holds it.
router.delete(
  "/:key/hospital",
  requireCapability("manage_roles", ["admin", "service_support"]),
  wrap(async (req, res) => {
    if (req.params.key === "admin")
      return res.status(400).json({ error: "Every hospital keeps the Administrator role." });
    const { rows: holders } = await pool.query(
      "SELECT COUNT(*)::int AS count FROM user_roles WHERE role = $1",
      [req.params.key],
    );
    if (holders[0].count > 0)
      return res.status(409).json({
        error: `${holders[0].count} user${holders[0].count > 1 ? "s" : ""} in this hospital hold this role. Remove it from them first.`,
      });
    const { rowCount } = await pool.query(
      "DELETE FROM hospital_roles WHERE hospital_id = $1 AND role_key = $2",
      [req.hospitalId, req.params.key],
    );
    if (!rowCount) return res.status(404).json({ error: "Role is not enabled in this hospital" });
    res.json({ enabled: false });
  }),
);

module.exports = router;
