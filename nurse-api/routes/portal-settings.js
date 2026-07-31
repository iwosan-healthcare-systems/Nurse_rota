const router = require("express").Router();
const pool = require("../db");
const { requireRole } = require("../middleware/auth");
const { invalidateCapabilityCache } = require("../middleware/capability");
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.get(
  "/:key",
  wrap(async (req, res) => {
    const { rows } = await pool.query("SELECT * FROM portal_settings WHERE key = $1", [
      req.params.key,
    ]);
    if (!rows[0]) return res.status(404).json({ error: "Setting not found" });
    res.json(rows[0]);
  }),
);

router.put(
  "/:key",
  requireRole("admin"),
  wrap(async (req, res) => {
    const { value } = req.body;
    if (value === undefined) return res.status(400).json({ error: "value is required" });

    const { rows } = await pool.query(
      `INSERT INTO portal_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value RETURNING *`,
      [req.params.key, JSON.stringify(value)],
    );
    if (req.params.key === "capabilities") invalidateCapabilityCache();
    res.json(rows[0]);
  }),
);

module.exports = router;
