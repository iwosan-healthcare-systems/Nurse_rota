const router = require("express").Router();
const pool = require("../db");
const { requireCapability } = require("../middleware/capability");
const { getWindowForPeriod } = require("../lib/rota-period-dates");
const { forceSubmitUnit, wasRevertedToDraft } = require("../lib/force-submit-rota");
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

async function notify(userId, notifKey) {
  if (!userId) return;
  await pool
    .query(
      `INSERT INTO notification_state (user_id, notif_key, is_read)
       VALUES ($1, $2, false)
       ON CONFLICT (user_id, notif_key) DO UPDATE SET is_read = false, updated_at = NOW()`,
      [userId, notifKey],
    )
    .catch(() => {});
}

async function notifyRole(role, notifKey) {
  const { rows } = await pool.query(
    `SELECT DISTINCT p.id FROM profiles p
       JOIN user_roles ur ON ur.user_id = p.id AND ur.role = $1
      WHERE p.is_active = true`,
    [role],
  );
  for (const { id } of rows) await notify(id, notifKey);
}

router.get(
  "/",
  wrap(async (req, res) => {
    const conditions = [];
    const params = [];
    if (req.query.facility) {
      conditions.push(`facility = $${params.length + 1}`);
      params.push(req.query.facility);
    }
    if (req.query.ward) {
      conditions.push(`ward = $${params.length + 1}`);
      params.push(req.query.ward);
    }
    if (req.query.role_group) {
      conditions.push(`role_group = $${params.length + 1}`);
      params.push(req.query.role_group);
    }
    if (req.query.period_start) {
      conditions.push(`period_start = $${params.length + 1}`);
      params.push(req.query.period_start);
    }
    if (req.query.status) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(req.query.status);
    }
    if (req.query.requested_by) {
      conditions.push(`requested_by = $${params.length + 1}`);
      params.push(req.query.requested_by);
    }
    if (req.query.active === "true") {
      conditions.push(`status = 'Approved' AND revoked_at IS NULL`);
    }
    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const { rows } = await pool.query(
      `SELECT * FROM rota_edit_requests ${where} ORDER BY created_at DESC`,
      params,
    );
    res.json(rows);
  }),
);

router.post(
  "/",
  requireCapability("request_rota_edit_access", ["admin", "head_nurse"]),
  wrap(async (req, res) => {
    const { facility, ward, role_group, period_start, period_end, reason } = req.body;
    if (!facility || (!ward && !role_group) || !period_start || !period_end || !reason?.trim()) {
      return res
        .status(400)
        .json({ error: "facility, ward or role_group, period_start, period_end and reason are required" });
    }

    // The edit-access window is only open from T-19 (auto-generate) to T-17
    // (auto-submit deadline) — enforced here, not just hidden in the UI.
    // Computed directly from THIS request's period_start (getWindowForPeriod),
    // not the globally-inferred "next period" (getNextPeriodDates) — a unit
    // that's fallen behind the rest of the system (e.g. reverted by HR after
    // other wards/facilities already published further ahead) has its own
    // period_start, which the global inference would otherwise silently
    // replace with the wrong, more-advanced period.
    //
    // Exception: if HR reviewed this unit after T-17 and sent it back to
    // draft (reject), the normal window is already closed and can never
    // reopen on its own — the head_nurse would have no way to fix what HR
    // flagged. In that specific case only, allow a fresh request even though
    // we're past editCloseDate. wasRevertedToDraft() confirms the unit's
    // most recent transition really is that revert (not just any old draft).
    const dates = await getWindowForPeriod(period_start);
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
    if (today < dates.generateDate) {
      return res.status(422).json({
        error: "Edit-access requests can only be raised between the rota's generate date and its edit-close deadline.",
        code: "OUTSIDE_EDIT_WINDOW",
      });
    }
    if (dates.editIsClosed) {
      const reopened = await wasRevertedToDraft({
        facility,
        ward: ward || null,
        roleGroup: ward ? null : role_group,
        periodStart: period_start,
      });
      if (!reopened) {
        return res.status(422).json({
          error: "Edit-access requests can only be raised between the rota's generate date and its edit-close deadline.",
          code: "OUTSIDE_EDIT_WINDOW",
        });
      }
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO rota_edit_requests
           (facility, ward, role_group, period_start, period_end, requested_by, requested_by_name, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          facility,
          ward || null,
          ward ? null : role_group,
          period_start,
          period_end,
          req.user.userId,
          req.user.full_name || null,
          reason.trim(),
        ],
      );
      const created = rows[0];
      await notifyRole("hr_admin", `rota_edit_pending_${created.id}`);
      res.status(201).json(created);
    } catch (err) {
      if (err.code === "23505") {
        return res
          .status(409)
          .json({ error: "You already have a live edit-access request for this ward/period." });
      }
      throw err;
    }
  }),
);

router.patch(
  "/:id",
  requireCapability("grant_rota_edit_access", ["admin", "hr_admin"]),
  wrap(async (req, res) => {
    const { status, review_note } = req.body;
    if (!["Approved", "Declined"].includes(status)) {
      return res.status(400).json({ error: "status must be 'Approved' or 'Declined'" });
    }

    const { rows } = await pool.query(
      `UPDATE rota_edit_requests
          SET status = $1, review_note = $2, reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
        WHERE id = $4 AND status = 'Pending'
        RETURNING *`,
      [status, review_note || null, req.user.userId, req.params.id],
    );
    const updated = rows[0];
    if (!updated) {
      return res.status(404).json({ error: "Request not found or already decided" });
    }

    if (status === "Declined") {
      // Declining an edit-access request also force-submits the as-is draft —
      // if the safety guards block that (pending/unapplied leave), the rota
      // just stays in draft; the decline itself still succeeds.
      const result = await forceSubmitUnit({
        facility: updated.facility,
        ward: updated.ward,
        roleGroup: updated.role_group,
        periodStart: updated.period_start,
        periodEnd: updated.period_end,
      });
      await notify(updated.requested_by, `rota_edit_declined_${updated.id}`);
      return res.json({ ...updated, autoSubmit: result });
    }

    await notify(updated.requested_by, `rota_edit_approved_${updated.id}`);
    res.json(updated);
  }),
);

module.exports = router;
