const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
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
