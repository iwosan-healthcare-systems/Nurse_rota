const router = require('express').Router();
const pool = require('../db');
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

router.post('/increment-nurse-hours', wrap(async (req, res) => {
  const { p_nurse_id, p_hours } = req.body;
  if (!p_nurse_id || p_hours == null) return res.status(400).json({ error: 'p_nurse_id and p_hours required' });
  await pool.query('SELECT increment_nurse_hours($1, $2)', [p_nurse_id, p_hours]);
  res.json({ success: true });
}));

router.post('/auto-end-overdue-shifts', wrap(async (req, res) => {
  const result = await pool.query(`
    UPDATE shift_logs
    SET ended_at = expected_end_at,
        hours_logged = EXTRACT(EPOCH FROM (expected_end_at - started_at)) / 3600
    WHERE ended_at IS NULL AND expected_end_at < NOW()
    RETURNING id, nurse_id, hours_logged, is_locum
  `);

  for (const row of result.rows) {
    if (!row.is_locum && row.hours_logged) {
      await pool.query('SELECT increment_nurse_hours($1, $2)', [row.nurse_id, row.hours_logged]);
    }
  }

  res.json({ ended: result.rowCount });
}));

router.post('/auto-close-period', wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT MIN(shift_date) as period_start, MAX(shift_date) as period_end
    FROM shift_assignments
    WHERE status = 'published'
    AND shift_date < CURRENT_DATE - INTERVAL '1 day'
    AND shift_date >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month')
  `);

  if (!rows[0]?.period_start) return res.json({ closed: false, period_start: null, period_end: null });

  res.json({ closed: true, period_start: rows[0].period_start, period_end: rows[0].period_end });
}));

module.exports = router;
