const router = require("express").Router();
const pool = require("../db");
const { requireCapability } = require("../middleware/capability");
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const KEY_RE = /^[a-z][a-z0-9_]{1,49}$/;

router.get(
  "/",
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT r.key, r.label, r.description, r.is_system, r.created_at,
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

    const { rows: existing } = await pool.query("SELECT key FROM roles WHERE key = $1", [key]);
    if (existing[0]) return res.status(409).json({ error: "A role with this key already exists" });

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

    const { rows: usageRows } = await pool.query(
      "SELECT COUNT(*)::int AS count FROM user_roles WHERE role = $1",
      [req.params.key],
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

module.exports = router;
