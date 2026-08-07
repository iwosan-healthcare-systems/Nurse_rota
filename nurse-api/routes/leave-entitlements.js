const router = require("express").Router();
const pool = require("../db");
const { requireRole } = require("../middleware/auth");
const { requireCapability } = require("../middleware/capability");
const {
  LEAVE_ENTITLEMENTS,
  getEntitlementUsage,
  getEntitlementUsageForNurses,
  createAdjustment,
  getAdjustmentHistory,
} = require("../lib/leave-entitlements");
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// GET /api/leave-entitlements — every active nurse's current-year/current-
// month usage for every tracked type, for the admin/HR-facing overview.
// Admin/HR only — this is every staff member's leave data at once, not a
// single person looking at their own. Optional ?facility= narrows the list.
router.get(
  "/",
  requireRole("admin", "hr_admin"),
  wrap(async (req, res) => {
    const params = [];
    let where = "WHERE is_active = true";
    if (req.query.facility) {
      params.push(req.query.facility);
      where += ` AND facility = $${params.length}`;
    }
    const { rows: nurses } = await pool.query(
      `SELECT id, name, role, ward, facility FROM nurses ${where} ORDER BY name`,
      params,
    );
    const usage = await getEntitlementUsageForNurses(nurses.map((n) => n.id));
    res.json(
      nurses.map((n) => ({
        nurse_id: n.id,
        name: n.name,
        role: n.role,
        ward: n.ward,
        facility: n.facility,
        entitlements: usage[n.id] ?? {},
      })),
    );
  }),
);

// GET /api/leave-entitlements/:nurse_id — current-year/current-month usage
// for every tracked leave type. Used by the leave-request page (to show
// remaining balances and disable exhausted types) and by the dedicated Leave
// Entitlements page's own-record view for regular staff. Admin/HR can look
// up anyone; everyone else can only look up their own record — same
// profile_id-then-name-match resolution used throughout this app to find
// "the nurse record for the logged-in user".
router.get(
  "/:nurse_id",
  wrap(async (req, res) => {
    // chief_matron can also look up someone else's balance — she's the one
    // other role allowed to submit leave on a staff member's behalf (see the
    // "staffMode" toggle in leave.tsx, gated the same way), and the request
    // modal previews the target nurse's entitlement before submitting.
    const userRoles = req.user?.roles || [];
    if (!userRoles.includes("admin") && !userRoles.includes("hr_admin") && !userRoles.includes("chief_matron")) {
      const { rows: ownNurse } = await pool.query(
        `SELECT id FROM nurses
          WHERE profile_id = $1
             OR LOWER(name) = LOWER((SELECT full_name FROM profiles WHERE id = $1))
          LIMIT 1`,
        [req.user.userId],
      );
      if (ownNurse[0]?.id !== req.params.nurse_id) {
        return res.status(403).json({ error: "You can only view your own leave entitlements." });
      }
    }
    const usage = await getEntitlementUsage(req.params.nurse_id);
    res.json(usage);
  }),
);

// GET /api/leave-entitlements/:nurse_id/adjustments — full manual-adjustment
// history for one nurse, newest first. Gated by the same capability as
// creating one (below) — same sensitivity, same audience.
router.get(
  "/:nurse_id/adjustments",
  requireCapability("manage_leave_entitlements", ["admin", "hr_admin"]),
  wrap(async (req, res) => {
    const history = await getAdjustmentHistory(req.params.nurse_id);
    res.json(history);
  }),
);

// POST /api/leave-entitlements/:nurse_id/adjustments — credit (or, with a
// negative `days`, correct) leave taken before this system existed, or any
// other case never submitted as a real request. Gated by a capability
// (fallback admin/hr_admin, same as before this was made adjustable) rather
// than a fixed role list, so admin can grant/revoke it via the Permissions
// page. Append-only — there is deliberately no PATCH/DELETE here (see
// migration 033's header).
router.post(
  "/:nurse_id/adjustments",
  requireCapability("manage_leave_entitlements", ["admin", "hr_admin"]),
  wrap(async (req, res) => {
    const { type, days, period_year, period_month, reason } = req.body;
    const entitlement = LEAVE_ENTITLEMENTS[type];
    if (!entitlement) {
      return res.status(400).json({
        error: `type must be one of: ${Object.keys(LEAVE_ENTITLEMENTS).join(", ")}`,
      });
    }
    if (typeof days !== "number" || !Number.isFinite(days) || days === 0) {
      return res.status(400).json({ error: "days must be a non-zero number" });
    }
    if (!Number.isInteger(period_year)) {
      return res.status(400).json({ error: "period_year is required" });
    }
    if (entitlement.period === "month" && !(Number.isInteger(period_month) && period_month >= 1 && period_month <= 12)) {
      return res.status(400).json({ error: `${type} resets monthly — period_month (1-12) is required` });
    }
    if (!reason?.trim()) {
      return res.status(400).json({ error: "reason is required" });
    }

    const created = await createAdjustment({
      nurseId: req.params.nurse_id,
      type,
      days,
      periodYear: period_year,
      periodMonth: entitlement.period === "month" ? period_month : null,
      reason: reason.trim(),
      createdBy: req.user.userId,
      createdByName: req.user.full_name || null,
    });
    res.status(201).json(created);
  }),
);

module.exports = router;
