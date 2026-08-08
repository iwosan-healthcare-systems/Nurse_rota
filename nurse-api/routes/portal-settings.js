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

// PATCH /portal-settings/capabilities — merge-only update: only the keys
// listed in `changes` are rewritten, everything else already in the DB
// (including a capability key nobody's added to the frontend's list yet)
// survives untouched. This is what the tag-assignment UI's Save/Delete
// actions use, instead of the wholesale PUT above (which stays only for an
// explicit "reset everything to defaults" action) — the wholesale form is
// exactly what silently deleted a real, actively-used capability key
// (view_all_leave_requests) the last time an unrelated capability was
// edited, since the frontend only ever knew how to round-trip the keys it
// already had in its own hardcoded list.
router.patch(
  "/capabilities",
  requireRole("admin"),
  wrap(async (req, res) => {
    const { changes } = req.body;
    if (!Array.isArray(changes) || !changes.length) {
      return res.status(400).json({ error: "changes[] is required" });
    }
    for (const c of changes) {
      if (!c || typeof c.key !== "string" || !Array.isArray(c.roles)) {
        return res.status(400).json({ error: "each change needs a key and a roles[] array" });
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        "SELECT value FROM portal_settings WHERE key = 'capabilities' FOR UPDATE",
      );
      const current = Array.isArray(rows[0]?.value) ? rows[0].value : [];
      const byKey = new Map(current.map((c) => [c.key, c]));
      for (const change of changes) byKey.set(change.key, { key: change.key, roles: change.roles });
      const next = Array.from(byKey.values());

      await client.query(
        `INSERT INTO portal_settings (key, value) VALUES ('capabilities', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify(next)],
      );
      await client.query("COMMIT");
      invalidateCapabilityCache();
      res.json({ value: next });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }),
);

module.exports = router;
