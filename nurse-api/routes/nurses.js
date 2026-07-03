const router = require('express').Router();
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

router.get('/', wrap(async (req, res) => {
  let query = 'SELECT * FROM nurses';
  const params = [];
  const conditions = [];

  if (req.query.ward) {
    conditions.push(`ward = $${params.length + 1}`);
    params.push(req.query.ward);
  }
  if (req.query.facility) {
    conditions.push(`facility = $${params.length + 1}`);
    params.push(req.query.facility);
  }
  if (req.query.id) {
    conditions.push(`id = $${params.length + 1}`);
    params.push(req.query.id);
  }

  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY name';

  const { rows } = await pool.query(query, params);
  res.json(rows);
}));

router.get('/:id', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM nurses WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Nurse not found' });
  res.json(rows[0]);
}));

router.post('/', requireRole('admin', 'hr_admin'), wrap(async (req, res) => {
  const { name, email, role, facility, ward, employee_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const { rows } = await pool.query(
    `INSERT INTO nurses (name, email, role, facility, ward, employee_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [name, email || null, role || 'nurse', facility || null, ward || null, employee_id || null]
  );
  res.status(201).json(rows[0]);
}));

// Bulk insert nurses
router.post('/bulk', requireRole('admin', 'hr_admin'), wrap(async (req, res) => {
  const nurses = Array.isArray(req.body) ? req.body : [req.body];
  if (!nurses.length) return res.status(400).json({ error: 'Array of nurses required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const results = [];
    for (const n of nurses) {
      if (!n.name) continue;
      const { rows } = await client.query(
        `INSERT INTO nurses (name, email, role, facility, ward, employee_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [n.name, n.email || null, n.role || 'nurse', n.facility || null, n.ward || null, n.employee_id || null]
      );
      results.push(rows[0]);
    }
    await client.query('COMMIT');
    res.status(201).json(results);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// Reset hours_this_month to 0 for a list of nurse IDs (or all if no ids given)
router.patch('/reset-hours', requireRole('admin', 'hr_admin'), wrap(async (req, res) => {
  const { nurse_ids } = req.body;
  if (nurse_ids && Array.isArray(nurse_ids) && nurse_ids.length) {
    await pool.query(
      'UPDATE nurses SET hours_this_month = 0, updated_at = NOW() WHERE id = ANY($1)',
      [nurse_ids],
    );
  } else {
    await pool.query('UPDATE nurses SET hours_this_month = 0, updated_at = NOW()');
  }
  res.json({ success: true });
}));

// Bulk update target_hours for all nurses
router.patch('/bulk-target-hours', requireRole('admin', 'hr_admin'), wrap(async (req, res) => {
  const { target_hours } = req.body;
  if (target_hours == null) return res.status(400).json({ error: 'target_hours required' });
  await pool.query('UPDATE nurses SET target_hours = $1, updated_at = NOW()', [target_hours]);
  res.json({ success: true });
}));

router.patch('/:id', requireRole('admin', 'hr_admin'), wrap(async (req, res) => {
  const allowed = ['name', 'email', 'role', 'facility', 'ward', 'employee_id', 'hours_this_month', 'target_hours', 'certifications'];
  const fields = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'No valid fields to update' });

  const sets = fields.map((f, i) => `${f} = $${i + 1}`);
  sets.push(`updated_at = NOW()`);
  const values = fields.map(f => req.body[f]);
  values.push(req.params.id);

  const { rows } = await pool.query(
    `UPDATE nurses SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Nurse not found' });
  res.json(rows[0]);
}));

router.delete('/:id', requireRole('admin', 'hr_admin'), wrap(async (req, res) => {
  await pool.query('DELETE FROM nurses WHERE id = $1', [req.params.id]);
  res.json({ success: true });
}));

module.exports = router;
