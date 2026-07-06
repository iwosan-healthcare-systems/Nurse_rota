const router = require("express").Router();
const pool = require("../db");
const { requireRole } = require("../middleware/auth");
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.get(
  "/",
  requireRole("admin", "cno"),
  wrap(async (req, res) => {
    const conditions = [];
    const params = [];

    if (req.query.actor_id) {
      conditions.push(`actor_id = $${params.length + 1}`);
      params.push(req.query.actor_id);
    }
    if (req.query.from) {
      conditions.push(`created_at >= $${params.length + 1}`);
      params.push(req.query.from);
    }
    if (req.query.to) {
      conditions.push(`created_at <= $${params.length + 1}`);
      params.push(req.query.to);
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const { rows } = await pool.query(
      `SELECT al.*,
              COALESCE(al.actor_name, p.full_name) AS actor_name
       FROM audit_logs al
       LEFT JOIN profiles p ON p.id = al.actor_id
       ${where}
       ORDER BY al.created_at DESC LIMIT 500`,
      params,
    );
    res.json(rows);
  }),
);

router.post(
  "/",
  wrap(async (req, res) => {
    const { action, target } = req.body;
    if (!action) return res.status(400).json({ error: "action is required" });

    // Always derive actor identity from the authenticated session — never trust the body
    const actor_id = req.user.userId;
    const actor_name = req.user.full_name;
    const actor_role = (req.user.roles || [])[0] ?? null;

    const { rows } = await pool.query(
      "INSERT INTO audit_logs (action, actor_id, actor_name, actor_role, target) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [action, actor_id, actor_name, actor_role, target || null],
    );
    res.status(201).json(rows[0]);
  }),
);

module.exports = router;
