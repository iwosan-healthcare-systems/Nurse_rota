const router = require("express").Router();
const pool = require("../db");
const { requireRole } = require("../middleware/auth");
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.get(
  "/",
  requireRole("admin", "cno", "hr_admin", "service_support"),
  wrap(async (req, res) => {
    const conditions = [];
    const params = [];
    if (req.query.user_id) {
      conditions.push(`user_id = $${params.length + 1}`);
      params.push(req.query.user_id);
    }
    if (req.query.role) {
      conditions.push(`role = $${params.length + 1}`);
      params.push(req.query.role);
    }
    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const { rows } = await pool.query(`SELECT * FROM user_roles ${where}`, params);
    res.json(rows);
  }),
);

router.post(
  "/",
  requireRole("admin", "cno", "service_support"),
  wrap(async (req, res) => {
    const { user_id, role } = req.body;
    if (!user_id || !role) return res.status(400).json({ error: "user_id and role required" });

    const callerRoles = req.user?.roles || [];
    const callerIsAdmin = callerRoles.includes("admin");
    if (!callerIsAdmin && role === "admin") {
      return res.status(403).json({ error: "Only administrators can grant the admin role" });
    }

    const { rows } = await pool.query(
      "INSERT INTO user_roles (user_id, role) VALUES ($1, $2) RETURNING *",
      [user_id, role],
    );
    res.status(201).json(rows[0]);
  }),
);

router.delete(
  "/:id",
  requireRole("admin", "cno", "service_support"),
  wrap(async (req, res) => {
    const callerRoles = req.user?.roles || [];
    const callerIsAdmin = callerRoles.includes("admin");
    if (!callerIsAdmin) {
      const { rows } = await pool.query("SELECT role FROM user_roles WHERE id = $1", [req.params.id]);
      if (rows[0]?.role === "admin") {
        return res.status(403).json({ error: "Only administrators can revoke the admin role" });
      }
    }
    await pool.query("DELETE FROM user_roles WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  }),
);

router.delete(
  "/",
  requireRole("admin", "cno", "service_support"),
  wrap(async (req, res) => {
    const { user_id, role } = req.query;
    if (!user_id || !role) return res.status(400).json({ error: "user_id and role required" });

    const callerRoles = req.user?.roles || [];
    const callerIsAdmin = callerRoles.includes("admin");
    if (!callerIsAdmin && role === "admin") {
      return res.status(403).json({ error: "Only administrators can revoke the admin role" });
    }

    await pool.query("DELETE FROM user_roles WHERE user_id = $1 AND role = $2", [user_id, role]);
    res.json({ success: true });
  }),
);

module.exports = router;
