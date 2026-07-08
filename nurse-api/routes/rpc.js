const router = require("express").Router();
const pool = require("../db");
const { requireRole } = require("../middleware/auth");
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.post(
  "/increment-nurse-hours",
  wrap(async (req, res) => {
    const { p_nurse_id, p_hours } = req.body;
    if (!p_nurse_id || p_hours == null)
      return res.status(400).json({ error: "p_nurse_id and p_hours required" });
    const hours = parseFloat(p_hours);
    if (!isFinite(hours) || hours <= 0 || hours > 24)
      return res
        .status(400)
        .json({ error: "p_hours must be a positive number no greater than 24" });

    // Admins/CNO can increment any nurse's hours; nurses can only increment their own
    const userRoles = req.user?.roles || [];
    const isAdmin = userRoles.some((r) => ["admin", "cno"].includes(r));
    if (!isAdmin) {
      const { rows: nurseRows } = await pool.query(
        "SELECT id FROM nurses WHERE name = (SELECT full_name FROM profiles WHERE id = $1) LIMIT 1",
        [req.user.userId],
      );
      if (!nurseRows[0] || nurseRows[0].id !== p_nurse_id) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    await pool.query("SELECT increment_nurse_hours($1, $2)", [p_nurse_id, hours]);
    res.json({ success: true });
  }),
);

router.post(
  "/auto-end-overdue-shifts",
  wrap(async (req, res) => {
    const result = await pool.query(`
    UPDATE shift_logs
    SET ended_at = expected_end_at,
        hours_logged = EXTRACT(EPOCH FROM (expected_end_at - started_at)) / 3600
    WHERE ended_at IS NULL AND expected_end_at < NOW()
    RETURNING id, nurse_id, hours_logged, is_locum, is_swap
  `);

    for (const row of result.rows) {
      if (!row.is_locum && !row.is_swap && row.hours_logged) {
        await pool.query("SELECT increment_nurse_hours($1, $2)", [row.nurse_id, row.hours_logged]);
      }
    }

    res.json({ ended: result.rowCount });
  }),
);

// ── Rota workflow status ──────────────────────────────────────────────────
// Returns the current stage of the next-period workflow so the frontend can
// show role-specific action notifications and enforce leave closure.
//
// Timeline (all relative to next period start date):
//   T-21  : leave_closure_date  — non-exempt leave requests blocked
//   T-19/20: generate window     — head nurse notified to generate rota
//   T-14  : publish_deadline    — rota must be published by this date
//
// nextRotaStage: 'none' | 'draft' | 'submitted' | 'approved_chief' | 'approved_cno' | 'published'
router.get(
  "/workflow-status",
  wrap(async (req, res) => {
    // Find the last published shift date across all facilities.
    const { rows: pubRows } = await pool.query(`
      SELECT MAX(shift_date::date) AS last_date
      FROM shift_assignments
      WHERE status = 'published'
    `);

    const lastDate = pubRows[0]?.last_date;
    if (!lastDate) {
      return res.json({ firstRotaPublished: false });
    }

    // Compute the next period start and key milestone dates in Postgres so we
    // never have to worry about JS Date timezone/DST edge cases.
    const { rows: dateRows } = await pool.query(`
      SELECT
        ($1::date + 1)::text                                 AS next_period_start,
        ($1::date + 1 - INTERVAL '21 days')::date::text     AS leave_closure_date,
        ($1::date + 1 - INTERVAL '14 days')::date::text     AS publish_deadline
    `, [lastDate]);

    const { next_period_start: nextPeriodStart, leave_closure_date: leaveClosureDate, publish_deadline: publishDeadline } = dateRows[0];
    const today = new Date().toISOString().slice(0, 10);

    // Closure only applies when the next period is still in the future.
    // If nextPeriodStart is today or in the past the schedule is overdue —
    // don't block leave in that case (no current cycle to protect).
    const leaveIsClosed = nextPeriodStart > today && today >= leaveClosureDate;

    // Determine the highest approval stage reached for the next period.
    // Ordering ensures we return the most-advanced status present.
    const { rows: stageRows } = await pool.query(`
      SELECT status FROM shift_assignments
      WHERE shift_date >= $1
      ORDER BY
        CASE status
          WHEN 'published'      THEN 1
          WHEN 'approved_cno'   THEN 2
          WHEN 'approved_chief' THEN 3
          WHEN 'submitted'      THEN 4
          WHEN 'draft'          THEN 5
          ELSE 6
        END
      LIMIT 1
    `, [nextPeriodStart]);

    const nextRotaStage = stageRows[0]?.status ?? 'none';

    res.json({
      firstRotaPublished: true,
      nextPeriodStart,
      leaveClosureDate,
      publishDeadline,
      leaveIsClosed,
      nextRotaStage,
    });
  }),
);

router.post(
  "/auto-close-period",
  wrap(async (req, res) => {
    const { rows } = await pool.query(`
    SELECT MIN(shift_date) as period_start, MAX(shift_date) as period_end
    FROM shift_assignments
    WHERE status = 'published'
    AND shift_date < CURRENT_DATE - INTERVAL '1 day'
    AND shift_date >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month')
  `);

    if (!rows[0]?.period_start)
      return res.json({ closed: false, period_start: null, period_end: null });

    res.json({ closed: true, period_start: rows[0].period_start, period_end: rows[0].period_end });
  }),
);

module.exports = router;
