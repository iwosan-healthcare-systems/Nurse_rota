const jwt = require("jsonwebtoken");
const pool = require("../db");
const { runInHospital, runInPlatform } = require("../lib/tenant-context");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  const requested = req.headers["x-hospital-id"] || null;
  if (requested && !UUID.test(requested))
    return res.status(400).json({ error: "Invalid hospital selection" });
  let account;
  try {
    // Platform scope: resolve the account and the hospital this request works in.
    // Super admins may enter any hospital; everyone else only hospitals they belong to.
    ({
      rows: [account],
    } = await runInPlatform(() =>
      pool.query(
        `SELECT p.is_active, p.is_super_admin,
           (SELECT h.id FROM hospitals h
             WHERE ($2::uuid IS NULL OR h.id = $2::uuid)
               AND (p.is_super_admin OR EXISTS (
                 SELECT 1 FROM hospital_memberships m WHERE m.hospital_id = h.id AND m.user_id = p.id))
             ORDER BY h.created_at, h.name LIMIT 1) AS hospital_id
         FROM profiles p WHERE p.id = $1`,
        [req.user.userId, requested],
      ),
    ));
  } catch {
    return res.status(500).json({ error: "Internal server error" });
  }
  if (!account || !account.is_active) return res.status(401).json({ error: "Account is inactive" });
  if (!account.hospital_id)
    return res.status(403).json({
      error: requested
        ? "You do not have access to this hospital"
        : "Your account is not assigned to a hospital",
      code: "HOSPITAL_ACCESS_DENIED",
    });
  req.user.isSuperAdmin = account.is_super_admin;
  // Super admins administer whichever hospital they enter.
  if (account.is_super_admin && !(req.user.roles || []).includes("admin"))
    req.user.roles = [...(req.user.roles || []), "admin"];
  req.hospitalId = account.hospital_id;
  runInHospital(account.hospital_id, () => next(), req.user.userId);
}

function requireRole(...roles) {
  return (req, res, next) => {
    const userRoles = req.user?.roles || [];
    const allowed = roles.some((r) => userRoles.includes(r)) || userRoles.includes("admin");
    if (allowed) return next();
    res.status(403).json({ error: "Forbidden" });
  };
}

module.exports = { requireAuth, requireRole };
