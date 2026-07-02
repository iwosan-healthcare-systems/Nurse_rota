const router = require('express').Router();
const pool = require('../db');
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

// ── Locum Requests ────────────────────────────────────────────

router.get('/requests', wrap(async (req, res) => {
  const conditions = [];
  const params = [];

  if (req.query.status) {
    conditions.push(`status = $${params.length + 1}`);
    params.push(req.query.status);
  }
  if (req.query.facility) {
    conditions.push(`facility = $${params.length + 1}`);
    params.push(req.query.facility);
  }
  if (req.query.requested_by) {
    conditions.push(`requested_by = $${params.length + 1}`);
    params.push(req.query.requested_by);
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
  if (req.query.accepted_by_nurse_id) {
    conditions.push(`accepted_by_nurse_id = $${params.length + 1}`);
    params.push(req.query.accepted_by_nurse_id);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  let query = `SELECT * FROM locum_requests ${where} ORDER BY created_at DESC`;
  if (req.query.limit) {
    query += ` LIMIT $${params.length + 1}`;
    params.push(parseInt(req.query.limit, 10));
  }
  const { rows } = await pool.query(query, params);
  res.json(rows);
}));

router.post('/requests', wrap(async (req, res) => {
  const { shift_date, shift, facility, ward, nurses_in_ward, ventilated_patients,
    hdu_nurses, requested_by, requested_by_name } = req.body;
  if (!shift_date || !shift || !facility || !ward || !requested_by || !requested_by_name)
    return res.status(400).json({ error: 'Missing required fields' });

  const { rows } = await pool.query(
    `INSERT INTO locum_requests
     (shift_date, shift, facility, ward, nurses_in_ward, ventilated_patients, hdu_nurses, requested_by, requested_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [shift_date, shift, facility, ward, nurses_in_ward || 0, ventilated_patients || 0,
      hdu_nurses || 0, requested_by, requested_by_name]
  );
  res.status(201).json(rows[0]);
}));

router.patch('/requests/:id', wrap(async (req, res) => {
  const allowed = ['status', 'reviewed_by', 'reviewed_by_name', 'reviewed_at', 'decline_reason',
    'accepted_by_nurse_id', 'accepted_by_nurse_name', 'accepted_at', 'updated_at'];
  const fields = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'No valid fields to update' });

  const sets = fields.map((f, i) => `${f} = $${i + 1}`);
  sets.push('updated_at = NOW()');
  const values = fields.map(f => req.body[f]);
  values.push(req.params.id);

  const { rows } = await pool.query(
    `UPDATE locum_requests SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Locum request not found' });
  res.json(rows[0]);
}));

// Atomic claim: update to filled only if status=invites_sent (race-safe)
router.post('/requests/:id/claim', wrap(async (req, res) => {
  const { accepted_by_nurse_id, accepted_by_nurse_name } = req.body;
  if (!accepted_by_nurse_id || !accepted_by_nurse_name)
    return res.status(400).json({ error: 'accepted_by_nurse_id and accepted_by_nurse_name required' });

  const { rows } = await pool.query(
    `UPDATE locum_requests
     SET status = 'filled', accepted_by_nurse_id = $1, accepted_by_nurse_name = $2,
         accepted_at = NOW(), updated_at = NOW()
     WHERE id = $3 AND status = 'invites_sent'
     RETURNING *`,
    [accepted_by_nurse_id, accepted_by_nurse_name, req.params.id]
  );
  res.json(rows[0] ?? null);
}));

// ── Locum Invites ─────────────────────────────────────────────

router.get('/invites', wrap(async (req, res) => {
  const conditions = [];
  const params = [];

  if (req.query.nurse_id) {
    conditions.push(`li.nurse_id = $${params.length + 1}`);
    params.push(req.query.nurse_id);
  }
  if (req.query.locum_request_id) {
    conditions.push(`li.locum_request_id = $${params.length + 1}`);
    params.push(req.query.locum_request_id);
  }
  if (req.query.status) {
    conditions.push(`li.status = $${params.length + 1}`);
    params.push(req.query.status);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const { rows } = await pool.query(
    `SELECT li.*, row_to_json(lr.*) as locum_request
     FROM locum_invites li
     LEFT JOIN locum_requests lr ON lr.id = li.locum_request_id
     ${where} ORDER BY li.created_at DESC`,
    params
  );
  res.json(rows);
}));

router.post('/invites', wrap(async (req, res) => {
  const invites = Array.isArray(req.body) ? req.body : [req.body];
  if (!invites.length) return res.status(400).json({ error: 'Invite data required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const results = [];
    for (const invite of invites) {
      const { rows } = await client.query(
        `INSERT INTO locum_invites (locum_request_id, nurse_id, nurse_name, status)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [invite.locum_request_id, invite.nurse_id, invite.nurse_name, invite.status || 'pending']
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

// Bulk PATCH invites by filter (e.g. mark others unavailable after claim)
router.patch('/invites', wrap(async (req, res) => {
  const conditions = [];
  const params = [];

  if (req.query.locum_request_id) {
    conditions.push(`locum_request_id = $${params.length + 1}`);
    params.push(req.query.locum_request_id);
  }
  if (req.query.status) {
    conditions.push(`status = $${params.length + 1}`);
    params.push(req.query.status);
  }
  if (req.query.neq_id) {
    conditions.push(`id != $${params.length + 1}`);
    params.push(req.query.neq_id);
  }
  if (!conditions.length) return res.status(400).json({ error: 'At least one filter required' });

  const allowed = ['status', 'decline_reason', 'responded_at'];
  const fields = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'No valid update fields' });

  const sets = fields.map((f, i) => `${f} = $${params.length + i + 1}`);
  const setValues = fields.map(f => req.body[f]);

  await pool.query(
    `UPDATE locum_invites SET ${sets.join(', ')} WHERE ${conditions.join(' AND ')}`,
    [...params, ...setValues]
  );
  res.json({ success: true });
}));

router.patch('/invites/:id', wrap(async (req, res) => {
  const allowed = ['status', 'decline_reason', 'responded_at'];
  const fields = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'No valid fields to update' });

  const sets = fields.map((f, i) => `${f} = $${i + 1}`);
  const values = fields.map(f => req.body[f]);
  values.push(req.params.id);

  const { rows } = await pool.query(
    `UPDATE locum_invites SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Invite not found' });
  res.json(rows[0]);
}));

module.exports = router;
