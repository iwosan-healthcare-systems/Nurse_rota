const router = require("express").Router();
const pool = require("../db");
const { requireCapability } = require("../middleware/capability");
const { getNextPeriodDates } = require("../lib/rota-period-dates");
const { closeCompletedPeriod } = require("../lib/auto-close-period");
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Mirrors lib/force-submit-rota.js's roleGroupOf, plus the "naday" bucket
// approvals.tsx's own frontend copy also classifies — kept as its own copy
// here per this codebase's existing convention (each file carries its own).
function roleGroupOf(role) {
  if (!role) return null;
  if (/^matron$/i.test(role)) return "matron";
  if (/^(head|coverage)\s*nurse$/i.test(role) || /^coverage\s*nurse\s*-\s*day$/i.test(role))
    return "head";
  if (/^porter(\s*-\s*day)?$/i.test(role)) return "porter";
  if (/nurse\s*intern|intern\s*nurse/i.test(role)) return "intern";
  if (/nurs(?:e|ing)\s*assistant\s*-\s*day/i.test(role)) return "naday";
  return null;
}

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
  requireCapability("manage_rota_periods", ["admin", "cno"]),
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
//   T-19  : generate_date       — system auto-generates the draft rota
//   T-17  : edit_close_date     — draft force-submitted; edit-access grants close
//   T-14  : publish_deadline    — system auto-publishes if HR-approved
//
// nextRotaStage: 'none' | 'draft' | 'submitted' | 'cno_approved' | 'published'
router.get(
  "/workflow-status",
  wrap(async (req, res) => {
    // Single source of truth for every milestone (T-21 leave closure through
    // T-14 publish) — day-offsets are admin-configurable via System Settings,
    // see lib/rota-deadline-settings.js. Also returns null when nothing has
    // ever been published, which is exactly this endpoint's own "nothing to
    // report yet" case, so no separate up-front query is needed here either.
    const periodDates = await getNextPeriodDates();
    if (!periodDates) {
      return res.json({ firstRotaPublished: false });
    }
    const {
      nextPeriodStart,
      leaveClosureDate,
      generateDate,
      editCloseDate,
      publishDeadline,
      leaveIsClosed,
      generateIsDue,
      editIsClosed,
      publishIsOverdue,
    } = periodDates;

    // Determine per-UNIT (ward, or facility-wide role group) approval stage
    // for the next period, then roll that up into both a single "most
    // advanced stage present" value (nextRotaStage — kept for backward
    // compatibility, drives which banner section the dashboard shows) and a
    // count of units at each stage (stageCounts/totalUnits — lets the
    // banner say "3 of 8 units approved" instead of implying the WHOLE
    // rota shares whichever single ward happens to be furthest along, which
    // was actively misleading when different wards are at different stages).
    const { rows: unitRows } = await pool.query(
      `SELECT n.facility, sa.ward, n.role, sa.status
         FROM shift_assignments sa
         JOIN nurses n ON n.id = sa.nurse_id
        WHERE sa.shift_date >= $1`,
      [nextPeriodStart],
    );
    const STAGE_RANK = { published: 1, cno_approved: 2, submitted: 3, draft: 4 };
    const unitStage = new Map(); // "facility|ward-or-roleGroup" -> most-advanced status for that unit
    for (const row of unitRows) {
      const group = row.ward ? null : roleGroupOf(row.role);
      if (!row.ward && !group) continue; // unclassifiable role, skip defensively
      const rank = STAGE_RANK[row.status];
      if (!rank) continue; // ignore anything outside the 4 known stages
      const key = `${row.facility}|${row.ward ?? group}`;
      const current = unitStage.get(key);
      if (!current || rank < STAGE_RANK[current]) unitStage.set(key, row.status);
    }

    const stageCounts = { draft: 0, submitted: 0, cno_approved: 0, published: 0 };
    for (const status of unitStage.values()) stageCounts[status]++;
    const totalUnits = unitStage.size;

    let nextRotaStage = "none";
    for (const s of ["published", "cno_approved", "submitted", "draft"]) {
      if (stageCounts[s] > 0) {
        nextRotaStage = s;
        break;
      }
    }

    res.json({
      firstRotaPublished: true,
      nextPeriodStart,
      leaveClosureDate,
      generateDate,
      editCloseDate,
      publishDeadline,
      leaveIsClosed,
      generateIsDue,
      editIsClosed,
      publishIsOverdue,
      nextRotaStage,
      stageCounts,
      totalUnits,
    });
  }),
);

router.post(
  "/auto-close-period",
  requireCapability("manage_rota_periods", ["admin", "cno"]),
  wrap(async (req, res) => {
    res.json(await closeCompletedPeriod());
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

// ── Daily hours by facility (Dashboard chart) ──────────────────────────────
// Same worked-hours definition as weekly-hours-by-facility above, but grouped
// per calendar day instead of per ISO week, over a rolling window anchored to
// CURRENT_DATE — so the window naturally shifts forward as days pass without
// any extra bookkeeping.
router.get(
  "/daily-hours-by-facility",
  wrap(async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);
    const { rows } = await pool.query(
      `SELECT
         sl.shift_date::date AS day,
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
         AND sl.shift_date >= (CURRENT_DATE - ($1::int - 1))
       GROUP BY day, n.facility
       ORDER BY day`,
      [days],
    );
    res.json(rows);
  }),
);

module.exports = router;
