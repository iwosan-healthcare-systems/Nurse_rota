const router = require("express").Router();
const { getEntitlementUsage } = require("../lib/leave-entitlements");
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// GET /api/leave-entitlements/:nurse_id — current-year/current-month usage
// for every tracked leave type, so the leave-request page can show remaining
// balances and disable types the nurse has already exhausted.
router.get(
  "/:nurse_id",
  wrap(async (req, res) => {
    const usage = await getEntitlementUsage(req.params.nurse_id);
    res.json(usage);
  }),
);

module.exports = router;
