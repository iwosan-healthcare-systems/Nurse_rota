const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

router.post('/login', wrap(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const { rows } = await pool.query(
    `SELECT id, email, full_name, password_hash, is_active, must_change_password
     FROM profiles WHERE lower(email) = lower($1)`,
    [email.trim()]
  );

  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (!user.is_active) return res.status(401).json({ error: 'Account is inactive' });
  if (!user.password_hash) return res.status(401).json({ error: 'Password not set — contact your admin' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const { rows: roleRows } = await pool.query(
    'SELECT role FROM user_roles WHERE user_id = $1',
    [user.id]
  );
  const roles = roleRows.map(r => r.role);

  const { rows: nurseRows } = await pool.query(
    'SELECT id, facility FROM nurses WHERE name = $1 LIMIT 1',
    [user.full_name]
  );
  const nurse = nurseRows[0] ?? null;

  const token = jwt.sign(
    { userId: user.id, roles, mustChangePassword: user.must_change_password },
    process.env.JWT_SECRET,
    { expiresIn: '10h' }
  );

  res.json({
    token,
    user: {
      id: user.id, email: user.email, full_name: user.full_name, roles,
      must_change_password: user.must_change_password,
      nurse_id: nurse?.id ?? null,
      nurse_facility: nurse?.facility ?? null
    }
  });
}));

router.get('/me', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, email, full_name, is_active, must_change_password FROM profiles WHERE id = $1',
    [req.user.userId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });

  const [{ rows: roleRows }, { rows: nurseRows }] = await Promise.all([
    pool.query('SELECT role FROM user_roles WHERE user_id = $1', [req.user.userId]),
    pool.query('SELECT id, facility FROM nurses WHERE name = $1 LIMIT 1', [rows[0].full_name]),
  ]);

  const nurse = nurseRows[0] ?? null;
  res.json({
    ...rows[0],
    roles: roleRows.map(r => r.role),
    nurse_id: nurse?.id ?? null,
    nurse_facility: nurse?.facility ?? null,
  });
}));

router.post('/change-password', requireAuth, wrap(async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!new_password || new_password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const { rows } = await pool.query('SELECT password_hash FROM profiles WHERE id = $1', [req.user.userId]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });

  if (current_password && rows[0].password_hash) {
    const valid = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = await bcrypt.hash(new_password, 12);
  await pool.query(
    'UPDATE profiles SET password_hash = $1, must_change_password = false, updated_at = NOW() WHERE id = $2',
    [hash, req.user.userId]
  );

  res.json({ success: true });
}));

// ── Admin endpoints ───────────────────────────────────────────
router.get('/admin/users', requireAuth, requireRole('admin', 'cno'), wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, email, full_name, is_active, must_change_password, created_at, updated_at FROM profiles ORDER BY full_name'
  );
  res.json(rows);
}));

router.post('/admin/create-user', requireAuth, requireRole('admin', 'cno'), wrap(async (req, res) => {
  const { email, password, full_name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const hash = await bcrypt.hash(password, 12);
  const { rows } = await pool.query(
    'INSERT INTO profiles (email, full_name, password_hash, must_change_password) VALUES (lower($1), $2, $3, true) RETURNING id',
    [email.trim(), full_name || null, hash]
  );
  res.json({ id: rows[0].id });
}));

router.delete('/admin/users/:id', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  await pool.query('DELETE FROM profiles WHERE id = $1', [req.params.id]);
  res.json({ success: true });
}));

router.patch('/admin/users/:id/ban', requireAuth, requireRole('admin', 'cno'), wrap(async (req, res) => {
  await pool.query('UPDATE profiles SET is_active = false, updated_at = NOW() WHERE id = $1', [req.params.id]);
  res.json({ success: true });
}));

router.patch('/admin/users/:id/unban', requireAuth, requireRole('admin', 'cno'), wrap(async (req, res) => {
  await pool.query('UPDATE profiles SET is_active = true, updated_at = NOW() WHERE id = $1', [req.params.id]);
  res.json({ success: true });
}));

router.patch('/admin/users/:id/reset-password', requireAuth, requireRole('admin', 'cno'), wrap(async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    'UPDATE profiles SET password_hash = $1, must_change_password = true, updated_at = NOW() WHERE id = $2',
    [hash, req.params.id]
  );
  res.json({ success: true });
}));

module.exports = router;
