const pool = require("../db");

// The API runs as multiple PM2 cluster workers with no shared cache, so a
// pure in-memory per-process TTL is the pragmatic no-new-infra choice: an
// admin's edit in the Permissions UI is reflected instantly on the worker
// that handled the save (see invalidateCapabilityCache, called from
// routes/portal-settings.js), and on every other worker within this TTL.
const CACHE_TTL_MS = 30_000;
let cache = { data: null, loadedAt: 0 };

async function loadCapabilities() {
  const now = Date.now();
  if (cache.data && now - cache.loadedAt < CACHE_TTL_MS) return cache.data;
  const { rows } = await pool.query(
    "SELECT value FROM portal_settings WHERE key = 'capabilities'",
  );
  cache = { data: Array.isArray(rows[0]?.value) ? rows[0].value : [], loadedAt: now };
  return cache.data;
}

function invalidateCapabilityCache() {
  cache = { data: null, loadedAt: 0 };
}

// Same admin-bypass semantics as requireRole (middleware/auth.js): a caller
// holding the literal "admin" role is always allowed, regardless of what the
// capability matrix says — this is what makes the matrix un-lockable even if
// misconfigured. fallbackRoles is used only when the key has no entry yet in
// portal_settings.capabilities (e.g. freshly introduced, not yet saved via
// the Permissions UI) — it should always mirror the endpoint's pre-migration
// requireRole(...) list so wrapping a route in requireCapability is
// behavior-neutral until an admin explicitly edits it.
//
// Returns true/false rather than throwing — for the common case (one fixed
// capability guarding a whole route) use requireCapability() below, which
// wraps this as Express middleware. checkCapability() is for routes like
// PATCH /shift-assignments that serve several different transitions off one
// handler, where the key to check isn't known until the request body/query
// has been inspected.
async function checkCapability(req, key, fallbackRoles) {
  const userRoles = req.user?.roles || [];
  if (userRoles.includes("admin")) return true;
  const caps = await loadCapabilities();
  const entry = caps.find((c) => c.key === key);
  const allowedRoles = entry ? entry.roles : fallbackRoles;
  return userRoles.some((r) => allowedRoles.includes(r));
}

function requireCapability(key, fallbackRoles) {
  return async (req, res, next) => {
    try {
      const allowed = await checkCapability(req, key, fallbackRoles);
      if (allowed) return next();
      return res.status(403).json({ error: "Forbidden" });
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireCapability, checkCapability, invalidateCapabilityCache };
