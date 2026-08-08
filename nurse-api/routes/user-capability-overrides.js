const router = require("express").Router();
const pool = require("../db");
const { requireRole } = require("../middleware/auth");
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// GET /api/user-capability-overrides — every override currently in effect,
// optionally scoped to one user (?user_id=). Admin only — matches the write
// gate below (avoids a capability-controls-itself chicken-and-egg problem:
// granting/viewing this is never itself delegable via the matrix).
router.get(
  "/",
  requireRole("admin"),
  wrap(async (req, res) => {
    const params = [];
    let where = "";
    if (req.query.user_id) {
      params.push(req.query.user_id);
      where = "WHERE o.user_id = $1";
    }
    const { rows } = await pool.query(
      `SELECT o.*, p.full_name AS user_name
         FROM user_capability_overrides o
         LEFT JOIN profiles p ON p.id = o.user_id
         ${where}
        ORDER BY p.full_name, o.capability_key`,
      params,
    );
    res.json(rows);
  }),
);

// POST /api/user-capability-overrides — grant one or more capabilities to a
// user, additive to whatever their role(s) already give them. Bulk upsert —
// re-granting an already-held key is a no-op, not an error.
router.post(
  "/",
  requireRole("admin"),
  wrap(async (req, res) => {
    const { user_id, keys } = req.body;
    if (!user_id || !Array.isArray(keys) || !keys.length) {
      return res.status(400).json({ error: "user_id and a non-empty keys[] are required" });
    }
    for (const key of keys) {
      await pool
        .query(
          `INSERT INTO user_capability_overrides (user_id, capability_key, created_by, created_by_name)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, capability_key) DO NOTHING`,
          [user_id, key, req.user.userId, req.user.full_name || null],
        )
        .catch(() => {});
    }
    await pool
      .query(`INSERT INTO audit_logs (actor_name, action, target) VALUES ($1, $2, $3)`, [
        req.user.full_name || "admin",
        "User capability override granted",
        `${keys.join(", ")} → user ${user_id}`,
      ])
      .catch(() => {});
    res.status(201).json({ success: true });
  }),
);

// DELETE /api/user-capability-overrides — revoke one or more overrides from
// a user. Only removes the INDIVIDUAL grant recorded here — never touches
// what their role(s) still give them.
router.delete(
  "/",
  requireRole("admin"),
  wrap(async (req, res) => {
    const { user_id, keys } = req.body;
    if (!user_id || !Array.isArray(keys) || !keys.length) {
      return res.status(400).json({ error: "user_id and a non-empty keys[] are required" });
    }
    await pool.query(
      `DELETE FROM user_capability_overrides WHERE user_id = $1 AND capability_key = ANY($2::text[])`,
      [user_id, keys],
    );
    await pool
      .query(`INSERT INTO audit_logs (actor_name, action, target) VALUES ($1, $2, $3)`, [
        req.user.full_name || "admin",
        "User capability override revoked",
        `${keys.join(", ")} ← user ${user_id}`,
      ])
      .catch(() => {});
    res.json({ success: true });
  }),
);

module.exports = router;
