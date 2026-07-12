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

    // Record missed shifts: published assignments in the past with no shift log at all.
    // Idempotent — the NOT EXISTS guard skips already-recorded rows.
    await pool.query(`
      INSERT INTO shift_logs
        (nurse_id, shift_date, shift_type, started_at, expected_end_at, ended_at,
         period_start, hours_logged, is_missed, is_leave, is_locum, is_swap)
      SELECT
        sa.nurse_id,
        sa.shift_date,
        sa.shift                    AS shift_type,
        sa.shift_date::timestamp    AS started_at,
        sa.shift_date::timestamp    AS expected_end_at,
        sa.shift_date::timestamp    AS ended_at,
        COALESCE(
          (SELECT MIN(s2.shift_date)
           FROM shift_assignments s2
           WHERE s2.status = 'published'
             AND s2.shift_date BETWEEN sa.shift_date - 27 AND sa.shift_date),
          sa.shift_date
        )                           AS period_start,
        0                           AS hours_logged,
        true                        AS is_missed,
        false                       AS is_leave,
        false                       AS is_locum,
        false                       AS is_swap
      FROM shift_assignments sa
      WHERE sa.status = 'published'
        AND (
          (sa.shift NOT IN ('N', 'NC') AND sa.shift_date < CURRENT_DATE)
          OR (sa.shift IN ('N', 'NC') AND sa.shift_date + INTERVAL '1 day 8 hours' < NOW())
        )
        AND sa.shift NOT IN ('LEAVE', 'OFF')
        AND NOT EXISTS (
          SELECT 1 FROM shift_logs sl
          WHERE sl.nurse_id = sa.nurse_id
            AND sl.shift_date = sa.shift_date
        )
    `);

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
    // Find the most recently completed published period.
    // The period is identified by the MAX published shift_date (= period end).
    // We treat it as a 28-day block, so period_start = period_end - 27 days.
    // "Complete" means every shift in the period is in the past (MAX < today).
    const { rows } = await pool.query(`
      WITH latest AS (
        SELECT MAX(shift_date::date) AS last_date
        FROM shift_assignments
        WHERE status = 'published'
      )
      SELECT
        (last_date - 27)::text AS period_start,
        last_date::text        AS period_end
      FROM latest
      WHERE last_date IS NOT NULL
        AND last_date < CURRENT_DATE
    `);

    if (!rows[0]?.period_end)
      return res.json({ closed: false, period_start: null, period_end: null });

    res.json({ closed: true, period_start: rows[0].period_start, period_end: rows[0].period_end });
  }),
);

module.exports = router;
