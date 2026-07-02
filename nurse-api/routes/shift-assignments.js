const router = require('express').Router();
const pool = require('../db');
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

router.get('/', wrap(async (req, res) => {
  const conditions = [];
  const params = [];

  if (req.query.nurse_id) {
    conditions.push(`nurse_id = $${params.length + 1}`);
    params.push(req.query.nurse_id);
  }
  if (req.query.ward) {
    conditions.push(`ward = $${params.length + 1}`);
    params.push(req.query.ward);
  }
  if (req.query.status) {
    conditions.push(`status = $${params.length + 1}`);
    params.push(req.query.status);
  }
  if (req.query.status_in) {
    const statuses = req.query.status_in.split(',');
    conditions.push(`status = ANY($${params.length + 1})`);
    params.push(statuses);
  }
  if (req.query.neq_status) {
    conditions.push(`status != $${params.length + 1}`);
    params.push(req.query.neq_status);
  }
  if (req.query.shift_date) {
    conditions.push(`shift_date = $${params.length + 1}`);
    params.push(req.query.shift_date);
  }
  if (req.query.from) {
    conditions.push(`shift_date >= $${params.length + 1}`);
    params.push(req.query.from);
  }
  if (req.query.to) {
    conditions.push(`shift_date <= $${params.length + 1}`);
    params.push(req.query.to);
  }
  if (req.query.nurse_ids) {
    const ids = req.query.nurse_ids.split(',');
    conditions.push(`nurse_id = ANY($${params.length + 1})`);
    params.push(ids);
  }
  if (req.query.shift) {
    conditions.push(`shift = $${params.length + 1}`);
    params.push(req.query.shift);
  }
  if (req.query.shift_in) {
    const shifts = req.query.shift_in.split(',');
    conditions.push(`shift = ANY($${params.length + 1})`);
    params.push(shifts);
  }
  if (req.query.ward_in) {
    const wards = req.query.ward_in.split(',');
    conditions.push(`ward = ANY($${params.length + 1})`);
    params.push(wards);
  }
  if (req.query.ward_null === 'true') {
    conditions.push('ward IS NULL');
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  let query = `SELECT * FROM shift_assignments ${where} ORDER BY shift_date`;
  if (req.query.limit) {
    query += ` LIMIT $${params.length + 1}`;
    params.push(parseInt(req.query.limit, 10));
  }
  const { rows } = await pool.query(query, params);
  res.json(rows);
}));

router.post('/', wrap(async (req, res) => {
  const { nurse_id, shift, shift_date, ward, status, created_by } = req.body;
  if (!nurse_id || !shift || !shift_date) return res.status(400).json({ error: 'nurse_id, shift, shift_date required' });

  const { rows } = await pool.query(
    `INSERT INTO shift_assignments (nurse_id, shift, shift_date, ward, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [nurse_id, shift, shift_date, ward || null, status || 'draft', created_by || null]
  );
  res.status(201).json(rows[0]);
}));

// Batch upsert (onConflict: nurse_id, shift_date)
router.post('/upsert', wrap(async (req, res) => {
  const rows = req.body;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'Array of assignments required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      await client.query(
        `INSERT INTO shift_assignments (nurse_id, shift, shift_date, ward, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (nurse_id, shift_date)
         DO UPDATE SET shift = EXCLUDED.shift, ward = EXCLUDED.ward, status = EXCLUDED.status, updated_at = NOW()`,
        [row.nurse_id, row.shift, row.shift_date, row.ward || null, row.status || 'draft', row.created_by || null]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true, count: rows.length });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.patch('/:id', wrap(async (req, res) => {
  const allowed = ['shift', 'ward', 'status', 'shift_date'];
  const fields = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'No valid fields to update' });

  const sets = fields.map((f, i) => `${f} = $${i + 1}`);
  sets.push('updated_at = NOW()');
  const values = fields.map(f => req.body[f]);
  values.push(req.params.id);

  const { rows } = await pool.query(
    `UPDATE shift_assignments SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Assignment not found' });
  res.json(rows[0]);
}));

// Batch update by filter
router.patch('/', wrap(async (req, res) => {
  const { nurse_ids, shift_date_from, shift_date_to, ward, status: filterStatus, neq_status, shift: filterShift } = req.query;
  const { shift, status, ward: newWard } = req.body;

  const conditions = [];
  const params = [];

  if (nurse_ids) {
    conditions.push(`nurse_id = ANY($${params.length + 1})`);
    params.push(nurse_ids.split(','));
  }
  if (shift_date_from) {
    conditions.push(`shift_date >= $${params.length + 1}`);
    params.push(shift_date_from);
  }
  if (shift_date_to) {
    conditions.push(`shift_date <= $${params.length + 1}`);
    params.push(shift_date_to);
  }
  if (ward) {
    conditions.push(`ward = $${params.length + 1}`);
    params.push(ward);
  }
  if (req.query.ward_null === 'true') {
    conditions.push('ward IS NULL');
  }
  if (filterStatus) {
    conditions.push(`status = $${params.length + 1}`);
    params.push(filterStatus);
  }
  if (neq_status) {
    conditions.push(`status != $${params.length + 1}`);
    params.push(neq_status);
  }
  if (filterShift) {
    conditions.push(`shift = $${params.length + 1}`);
    params.push(filterShift);
  }

  const sets = [];
  if (shift) { sets.push(`shift = $${params.length + 1}`); params.push(shift); }
  if (status) { sets.push(`status = $${params.length + 1}`); params.push(status); }
  if (newWard) { sets.push(`ward = $${params.length + 1}`); params.push(newWard); }
  sets.push('updated_at = NOW()');

  if (sets.length < 2 || !conditions.length) return res.status(400).json({ error: 'Filters and update fields required' });

  const where = 'WHERE ' + conditions.join(' AND ');
  await pool.query(`UPDATE shift_assignments SET ${sets.join(', ')} ${where}`, params);
  res.json({ success: true });
}));

// Bulk delete by filter (must come before /:id to avoid routing conflict)
router.delete('/', wrap(async (req, res) => {
  const conditions = [];
  const params = [];

  if (req.query.nurse_ids) {
    conditions.push(`nurse_id = ANY($${params.length + 1})`);
    params.push(req.query.nurse_ids.split(','));
  }
  if (req.query.from) {
    conditions.push(`shift_date >= $${params.length + 1}`);
    params.push(req.query.from);
  }
  if (req.query.to) {
    conditions.push(`shift_date <= $${params.length + 1}`);
    params.push(req.query.to);
  }
  if (req.query.status) {
    conditions.push(`status = $${params.length + 1}`);
    params.push(req.query.status);
  }
  if (req.query.neq_status) {
    conditions.push(`status != $${params.length + 1}`);
    params.push(req.query.neq_status);
  }

  if (!conditions.length) return res.status(400).json({ error: 'At least one filter required for bulk delete' });

  const where = 'WHERE ' + conditions.join(' AND ');
  const result = await pool.query(`DELETE FROM shift_assignments ${where}`, params);
  res.json({ success: true, deleted: result.rowCount });
}));

router.delete('/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM shift_assignments WHERE id = $1', [req.params.id]);
  res.json({ success: true });
}));

module.exports = router;
