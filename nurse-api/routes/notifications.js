const router = require("express").Router();
const pool = require("../db");
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.get(
  "/",
  wrap(async (req, res) => {
    // Always use the authenticated user's own ID — ignore any user_id query param
    const userId = req.user.userId;
    const { rows } = await pool.query("SELECT * FROM notification_state WHERE user_id = $1", [
      userId,
    ]);
    res.json(rows);
  }),
);

// Facility-level regen check: returns distinct unread rota_regenerate_needed_* keys
// for a facility regardless of which user owns the row. Any head_nurse or admin
// for the facility can see these, even if their personal row was never created.
router.get(
  "/regen-needed",
  wrap(async (req, res) => {
    const { facility } = req.query;
    if (!facility) return res.json([]);
    const facilitySlug = String(facility).toLowerCase().replace(/\s+/g, "_");
    const { rows } = await pool.query(
      `SELECT DISTINCT notif_key
         FROM notification_state
        WHERE notif_key LIKE $1
          AND is_read = false`,
      [`rota_regenerate_needed_${facilitySlug}_%`],
    );
    res.json(rows.map((r) => r.notif_key));
  }),
);

// Mark regen notifications as read for ALL users (called after Regenerate completes).
router.post(
  "/regen-mark-read",
  wrap(async (req, res) => {
    const { notif_keys } = req.body;
    if (!Array.isArray(notif_keys) || !notif_keys.length)
      return res.status(400).json({ error: "notif_keys array required" });
    await pool.query(
      `UPDATE notification_state
          SET is_read = true, updated_at = NOW()
        WHERE notif_key = ANY($1)`,
      [notif_keys],
    );
    res.json({ success: true });
  }),
);

router.post(
  "/upsert",
  wrap(async (req, res) => {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    if (!items.length) return res.status(400).json({ error: "Array required" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const item of items) {
        await client.query(
          `INSERT INTO notification_state (user_id, notif_key, is_read)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, notif_key) DO UPDATE SET is_read = EXCLUDED.is_read, updated_at = NOW()`,
          [req.user.userId, item.notif_key, item.is_read ?? false],
        );
      }
      await client.query("COMMIT");
      res.json({ success: true });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }),
);

module.exports = router;
