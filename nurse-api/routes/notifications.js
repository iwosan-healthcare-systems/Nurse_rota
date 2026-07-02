const router = require('express').Router();
const pool = require('../db');
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

router.get('/', wrap(async (req, res) => {
  const userId = req.query.user_id || req.user.userId;
  const { rows } = await pool.query(
    'SELECT * FROM notification_state WHERE user_id = $1',
    [userId]
  );
  res.json(rows);
}));

router.post('/upsert', wrap(async (req, res) => {
  const items = Array.isArray(req.body) ? req.body : [req.body];
  if (!items.length) return res.status(400).json({ error: 'Array required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of items) {
      await client.query(
        `INSERT INTO notification_state (user_id, notif_key, is_read)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, notif_key) DO UPDATE SET is_read = EXCLUDED.is_read, updated_at = NOW()`,
        [item.user_id, item.notif_key, item.is_read ?? false]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
