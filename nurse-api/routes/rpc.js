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
        `SELECT id FROM nurses WHERE profile_id = $1
         UNION ALL
         SELECT id FROM nurses WHERE profile_id IS NULL
           AND LOWER(name) = LOWER((SELECT full_name FROM profiles WHERE id = $1))
         LIMIT 1`,
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
  requireRole("admin", "cno"),
  wrap(async (req, res) => {
    // Round to 2 decimal places — consistent with the cron job.
    const result = await pool.query(`
      UPDATE shift_logs
      SET ended_at     = expected_end_at,
          hours_logged = ROUND(
            EXTRACT(EPOCH FROM (expected_end_at - started_at)) / 3600 * 100
          ) / 100
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
         period_start, hours_logged, is_missed, is_leave, is_locum, locum_request_id, is_swap)
      SELECT
        sa.nurse_id,
        sa.shift_date,
        (CASE WHEN sa.shift IN ('N', 'NC') THEN 'N' ELSE 'M' END)::shift_code AS shift_type,
        CASE WHEN sa.shift IN ('N', 'NC')
          THEN (sa.shift_date::timestamp + INTERVAL '17 hours') AT TIME ZONE 'Africa/Lagos'
          ELSE (sa.shift_date::timestamp + INTERVAL '8 hours') AT TIME ZONE 'Africa/Lagos'
        END AS started_at,
        CASE WHEN sa.shift IN ('N', 'NC')
          THEN (sa.shift_date::timestamp + INTERVAL '1 day 8 hours') AT TIME ZONE 'Africa/Lagos'
          ELSE (sa.shift_date::timestamp + INTERVAL '17 hours') AT TIME ZONE 'Africa/Lagos'
        END AS expected_end_at,
        CASE WHEN sa.shift IN ('N', 'NC')
          THEN (sa.shift_date::timestamp + INTERVAL '1 day 8 hours') AT TIME ZONE 'Africa/Lagos'
          ELSE (sa.shift_date::timestamp + INTERVAL '17 hours') AT TIME ZONE 'Africa/Lagos'
        END AS ended_at,
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
        lr.id IS NOT NULL           AS is_locum,
        lr.id                       AS locum_request_id,
        false                       AS is_swap
      FROM shift_assignments sa
      LEFT JOIN locum_requests lr
        ON lr.status = 'filled'
       AND lr.accepted_by_nurse_id = sa.nurse_id
       AND lr.shift_date = sa.shift_date
      WHERE sa.status = 'published'
        AND (
          (sa.shift NOT IN ('N', 'NC') AND (sa.shift_date::timestamp + INTERVAL '17 hours') AT TIME ZONE 'Africa/Lagos' < NOW())
          OR (sa.shift IN ('N', 'NC') AND (sa.shift_date::timestamp + INTERVAL '1 day 8 hours') AT TIME ZONE 'Africa/Lagos' < NOW())
        )
        AND sa.shift NOT IN ('LEAVE', 'OFF')
        AND NOT EXISTS (
          SELECT 1 FROM shift_logs sl
          WHERE sl.nurse_id = sa.nurse_id
            AND sl.shift_date = sa.shift_date
        )
    `);

    // Locum acceptance never creates a shift_assignments row (see jobs/auto-end-shifts.js
    // for the full explanation), so a locum no-show needs its own scan of locum_requests.
    await pool.query(`
      INSERT INTO shift_logs
        (nurse_id, shift_date, shift_type, started_at, expected_end_at, ended_at,
         period_start, hours_logged, is_missed, is_leave, is_locum, locum_request_id, is_swap)
      SELECT
        lr.accepted_by_nurse_id,
        lr.shift_date,
        (CASE WHEN lr.shift IN ('N', 'NC') THEN 'N' ELSE 'M' END)::shift_code AS shift_type,
        CASE WHEN lr.shift IN ('N', 'NC')
          THEN (lr.shift_date::timestamp + INTERVAL '17 hours') AT TIME ZONE 'Africa/Lagos'
          ELSE (lr.shift_date::timestamp + INTERVAL '8 hours') AT TIME ZONE 'Africa/Lagos'
        END AS started_at,
        CASE WHEN lr.shift IN ('N', 'NC')
          THEN (lr.shift_date::timestamp + INTERVAL '1 day 8 hours') AT TIME ZONE 'Africa/Lagos'
          ELSE (lr.shift_date::timestamp + INTERVAL '17 hours') AT TIME ZONE 'Africa/Lagos'
        END AS expected_end_at,
        CASE WHEN lr.shift IN ('N', 'NC')
          THEN (lr.shift_date::timestamp + INTERVAL '1 day 8 hours') AT TIME ZONE 'Africa/Lagos'
          ELSE (lr.shift_date::timestamp + INTERVAL '17 hours') AT TIME ZONE 'Africa/Lagos'
        END AS ended_at,
        COALESCE(
          (SELECT MIN(s2.shift_date)
           FROM shift_assignments s2
           WHERE s2.status = 'published'
             AND s2.shift_date BETWEEN lr.shift_date - 27 AND lr.shift_date),
          lr.shift_date
        )                           AS period_start,
        0                           AS hours_logged,
        true                        AS is_missed,
        false                       AS is_leave,
        true                        AS is_locum,
        lr.id                       AS locum_request_id,
        false                       AS is_swap
      FROM locum_requests lr
      WHERE lr.status = 'filled'
        AND lr.accepted_by_nurse_id IS NOT NULL
        AND (
          (lr.shift NOT IN ('N', 'NC') AND (lr.shift_date::timestamp + INTERVAL '17 hours') AT TIME ZONE 'Africa/Lagos' < NOW())
          OR (lr.shift IN ('N', 'NC') AND (lr.shift_date::timestamp + INTERVAL '1 day 8 hours') AT TIME ZONE 'Africa/Lagos' < NOW())
        )
        AND NOT EXISTS (
          SELECT 1 FROM shift_logs sl
          WHERE sl.nurse_id = lr.accepted_by_nurse_id
            AND sl.shift_date = lr.shift_date
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
  requireRole("admin", "cno"),
  wrap(async (req, res) => {
    // Use 28-day bucket logic so a running Period 2 doesn't hide completed
    // Period 1.  Dates are bucketed from the earliest ever published date,
    // giving stable 0-27, 28-55, … windows regardless of how many periods
    // are currently running.
    const { rows: periodRows } = await pool.query(`
      WITH dates AS (
        SELECT DISTINCT shift_date::date AS d
        FROM shift_assignments
        WHERE status = 'published'
      ),
      anchored AS (
        SELECT d, MIN(d) OVER () AS anchor FROM dates
      ),
      bucketed AS (
        SELECT d, (d - anchor) / 28 AS bucket FROM anchored
      ),
      periods AS (
        SELECT
          MIN(d) AS period_start,
          MAX(d) AS period_end
        FROM bucketed
        GROUP BY bucket
      )
      SELECT period_start::text, period_end::text
      FROM periods
      WHERE period_end < CURRENT_DATE
        AND NOT EXISTS (
          SELECT 1 FROM nurse_period_hours nph
          WHERE nph.period_start = periods.period_start
          LIMIT 1
        )
      ORDER BY period_end DESC
      LIMIT 1
    `);

    if (!periodRows[0]) {
      return res.json({ closed: false, period_start: null, period_end: null });
    }

    const { period_start, period_end } = periodRows[0];

    // Aggregate completed shift hours per nurse for this period.
    const { rows: hoursRows } = await pool.query(`
      SELECT
        nurse_id,
        ROUND(SUM(hours_logged) * 100) / 100            AS total_hours,
        COUNT(*) FILTER (WHERE hours_logged > 0 AND NOT is_missed)::int AS total_shifts
      FROM shift_logs
      WHERE shift_date BETWEEN $1 AND $2
        AND is_locum       = false
        AND is_swap        = false
        AND ended_at       IS NOT NULL
        AND hours_logged   IS NOT NULL
      GROUP BY nurse_id
      HAVING SUM(hours_logged) > 0
    `, [period_start, period_end]);

    if (!hoursRows.length) {
      return res.json({ closed: false, period_start: null, period_end: null });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const row of hoursRows) {
        await client.query(`
          INSERT INTO nurse_period_hours
            (nurse_id, period_start, period_end, total_hours, total_shifts)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (nurse_id, period_start) DO UPDATE
          SET period_end   = EXCLUDED.period_end,
              total_hours  = EXCLUDED.total_hours,
              total_shifts = EXCLUDED.total_shifts
        `, [
          row.nurse_id,
          period_start,
          period_end,
          parseFloat(row.total_hours),
          parseInt(row.total_shifts, 10),
        ]);
      }

      const nurseIds = hoursRows.map((r) => r.nurse_id);
      await client.query(
        "UPDATE nurses SET hours_this_month = 0, updated_at = NOW() WHERE id = ANY($1)",
        [nurseIds],
      );

      await client.query(
        `INSERT INTO audit_logs (actor_name, action, target)
         VALUES ('system', 'Period auto-closed', $1)`,
        [`${period_start} → ${period_end} · ${hoursRows.length} nurse(s) archived`],
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    res.json({ closed: true, period_start, period_end });
  }),
);

// ── Weekly hours by facility (Dashboard chart) ─────────────────────────────
// Sums shift_logs.hours_logged per ISO week per facility for actually-worked
// shifts: excludes locum, swap, AND leave-credited entries (is_leave = true)
// — leave hours count toward nurse_period_hours/target_hours elsewhere, but
// they are not "worked" hours, so they don't belong in this chart. Facility
// is derived via nurse_id -> nurses.facility since shift_logs has no facility
// column.
router.get(
  "/weekly-hours-by-facility",
  wrap(async (req, res) => {
    const weeks = Math.min(Math.max(parseInt(req.query.weeks) || 12, 1), 52);
    const { rows } = await pool.query(
      `SELECT
         date_trunc('week', sl.shift_date)::date AS week_start,
         n.facility,
         ROUND(SUM(sl.hours_logged) * 100) / 100 AS hours
       FROM shift_logs sl
       JOIN nurses n ON n.id = sl.nurse_id
       WHERE sl.hours_logged IS NOT NULL
         AND sl.ended_at IS NOT NULL
         AND sl.is_locum = false
         AND sl.is_swap = false
         AND sl.is_leave = false
         AND n.facility IS NOT NULL
         AND sl.shift_date >= (CURRENT_DATE - ($1::int * 7))
       GROUP BY week_start, n.facility
       ORDER BY week_start`,
      [weeks],
    );
    res.json(rows);
  }),
);

module.exports = router;
