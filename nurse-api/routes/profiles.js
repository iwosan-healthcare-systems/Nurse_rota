const router = require("express").Router();
const pool = require("../db");
const { requireRole } = require("../middleware/auth");
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.get(
  "/",
  requireRole("admin", "cno", "chief_matron", "hr_admin"),
  wrap(async (req, res) => {
    const conditions = [];
    const params = [];

    if (req.query.full_name) {
      conditions.push(`lower(full_name) = lower($${params.length + 1})`);
      params.push(req.query.full_name);
    }
    if (req.query.full_names) {
      const names = req.query.full_names.split(",").map((n) => n.trim().toLowerCase());
      conditions.push(`lower(full_name) = ANY($${params.length + 1})`);
      params.push(names);
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const { rows } = await pool.query(
      `SELECT id, email, full_name, is_active, must_change_password, created_at, updated_at FROM profiles ${where} ORDER BY full_name`,
      params,
    );
    res.json(rows);
  }),
);

router.get(
  "/:id",
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      "SELECT id, email, full_name, is_active, must_change_password, created_at, updated_at FROM profiles WHERE id = $1",
      [req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: "Profile not found" });
    res.json(rows[0]);
  }),
);

router.patch(
  "/:id",
  wrap(async (req, res) => {
    const userRoles = req.user?.roles || [];
    const isAdmin = userRoles.some((r) => ["admin", "cno"].includes(r));

    if (!isAdmin && req.params.id !== req.user.userId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const adminOnlyFields = ["is_active", "must_change_password"];
    if (!isAdmin && Object.keys(req.body).some((k) => adminOnlyFields.includes(k))) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const allowed = isAdmin
      ? ["full_name", "email", "is_active", "must_change_password"]
      : ["full_name", "email"];
    const fields = Object.keys(req.body).filter((k) => allowed.includes(k));
    if (!fields.length) return res.status(400).json({ error: "No valid fields to update" });

    const sets = fields.map((f, i) => `${f} = $${i + 1}`);
    sets.push("updated_at = NOW()");
    const values = fields.map((f) => req.body[f]);
    values.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE profiles SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING id, email, full_name, is_active, must_change_password`,
      values,
    );
    if (!rows[0]) return res.status(404).json({ error: "Profile not found" });
    res.json(rows[0]);
  }),
);

module.exports = router;
