const jwt = require('jsonwebtoken');
const pool = require('../db');

async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  try {
    const { rows } = await pool.query('SELECT is_active FROM profiles WHERE id = $1', [req.user.userId]);
    if (!rows[0] || !rows[0].is_active) return res.status(401).json({ error: 'Account is inactive' });
    next();
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    const userRoles = req.user?.roles || [];
    const allowed = roles.some(r => userRoles.includes(r)) || userRoles.includes('admin');
    if (allowed) return next();
    res.status(403).json({ error: 'Forbidden' });
  };
}

module.exports = { requireAuth, requireRole };
