const router = require('express').Router();
const pool = require('../db');
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

router.get('/', wrap(async (req, res) => {
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

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const { rows } = await pool.query(
    `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT 500`,
    params
  );
  res.json(rows);
}));

router.post('/', wrap(async (req, res) => {
  const { action, actor_id, actor_name, actor_role, target } = req.body;
  if (!action) return res.status(400).json({ error: 'action is required' });

  const { rows } = await pool.query(
    'INSERT INTO audit_logs (action, actor_id, actor_name, actor_role, target) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [action, actor_id || null, actor_name || null, actor_role || null, target || null]
  );
  res.status(201).json(rows[0]);
}));

module.exports = router;
