const cron = require("node-cron");
const pool = require("../db");

// Arbitrary fixed key for this job's mutex. The API runs as multiple PM2 instances
// behind one port (see db.js), and node-cron's "*/5 * * * *" fires in every
// process at the same wall-clock tick — without this lock, every instance would
// race to auto-end/miss/credit the same rows concurrently.
const AUTO_END_LOCK_KEY = 729312;

async function autoEndOverdueShifts() {
  const lockClient = await pool.connect();
  try {
    const { rows: lockRows } = await lockClient.query("SELECT pg_try_advisory_lock($1) AS locked", [
      AUTO_END_LOCK_KEY,
    ]);
    if (!lockRows[0].locked) return; // another instance already holds the lock this tick

    await runAutoEndOverdueShifts();
  } catch (err) {
    console.error("[auto-end] Error:", err.message);
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [AUTO_END_LOCK_KEY]).catch(() => {});
    lockClient.release();
  }
}

async function runAutoEndOverdueShifts() {
  try {
    const result = await pool.query(`
      UPDATE shift_logs
      SET
        ended_at     = expected_end_at,
        hours_logged = ROUND(
          EXTRACT(EPOCH FROM (expected_end_at - started_at)) / 3600 * 100
        ) / 100
      WHERE ended_at IS NULL
        AND expected_end_at < NOW()
      RETURNING id, nurse_id, hours_logged, is_locum, is_swap
    `);

    for (const row of result.rows) {
      if (!row.is_locum && !row.is_swap && row.hours_logged > 0) {
        await pool
          .query("SELECT increment_nurse_hours($1, $2)", [row.nurse_id, row.hours_logged])
          .catch((err) =>
            console.error(`[auto-end] hours increment failed for ${row.nurse_id}:`, err.message),
          );
      }
    }

    if (result.rowCount > 0) {
      console.log(
        `[auto-end] ${new Date().toISOString()} — closed ${result.rowCount} overdue shift(s)`,
      );
      await pool
        .query(
          `INSERT INTO audit_logs (actor_name, action, target)
           VALUES ('system', 'Shifts auto-ended', $1)`,
          [`${result.rowCount} shift(s) closed at ${new Date().toISOString()}`],
        )
        .catch((err) => console.error("[auto-end] audit log failed:", err.message));
    }

    // Record missed shifts: published assignments in the past with no shift log at all.
    // Idempotent — the NOT EXISTS guard skips already-recorded rows.
    // A missed shift can itself be a locum-covered one (the locum nurse accepted
    // the request but never clocked in) — matched via locum_requests the same way
    // rota.tsx's locumCellSet does (status = 'filled', accepted_by_nurse_id + shift_date),
    // so it's flagged is_locum = true instead of silently looking like a regular no-show.
    const missed = await pool.query(`
      INSERT INTO shift_logs
        (nurse_id, shift_date, shift_type, started_at, expected_end_at, ended_at,
         period_start, hours_logged, is_missed, is_leave, is_locum, locum_request_id, is_swap)
      SELECT
        sa.nurse_id,
        sa.shift_date,
        (CASE WHEN sa.shift IN ('N', 'NC') THEN 'N' ELSE 'M' END)::shift_code AS shift_type,
        CASE WHEN sa.shift IN ('N', 'NC')
          THEN sa.shift_date::timestamp + INTERVAL '17 hours'
          ELSE sa.shift_date::timestamp + INTERVAL '8 hours'
        END AS started_at,
        CASE WHEN sa.shift IN ('N', 'NC')
          THEN sa.shift_date::timestamp + INTERVAL '1 day 8 hours'
          ELSE sa.shift_date::timestamp + INTERVAL '17 hours'
        END AS expected_end_at,
        CASE WHEN sa.shift IN ('N', 'NC')
          THEN sa.shift_date::timestamp + INTERVAL '1 day 8 hours'
          ELSE sa.shift_date::timestamp + INTERVAL '17 hours'
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
          (sa.shift NOT IN ('N', 'NC') AND sa.shift_date::timestamp + INTERVAL '17 hours' < NOW())
          OR (sa.shift IN ('N', 'NC') AND sa.shift_date::timestamp + INTERVAL '1 day 8 hours' < NOW())
        )
        AND sa.shift NOT IN ('LEAVE', 'OFF')
        AND NOT EXISTS (
          SELECT 1 FROM shift_logs sl
          WHERE sl.nurse_id = sa.nurse_id
            AND sl.shift_date = sa.shift_date
        )
    `);
    if (missed.rowCount > 0) {
      console.log(
        `[auto-end] ${new Date().toISOString()} — recorded ${missed.rowCount} missed shift(s)`,
      );
    }

    // Record missed LOCUM shifts. Accepting a locum request never creates a
    // shift_assignments row (locum.js never touches that table — the frontend
    // resolves "today's shift" for a locum nurse straight from locum_requests,
    // see shift.tsx's todayLocum query), so the block above can't see these at
    // all. Scan filled locum_requests directly instead: if the shift has ended
    // and the accepted nurse never has a shift_logs row for that date, they
    // missed it — recorded the same way as a regular missed shift, but flagged
    // is_locum = true so it's clearly a missed *locum* shift, not a no-show on
    // their own roster.
    const missedLocum = await pool.query(`
      INSERT INTO shift_logs
        (nurse_id, shift_date, shift_type, started_at, expected_end_at, ended_at,
         period_start, hours_logged, is_missed, is_leave, is_locum, locum_request_id, is_swap)
      SELECT
        lr.accepted_by_nurse_id,
        lr.shift_date,
        (CASE WHEN lr.shift IN ('N', 'NC') THEN 'N' ELSE 'M' END)::shift_code AS shift_type,
        CASE WHEN lr.shift IN ('N', 'NC')
          THEN lr.shift_date::timestamp + INTERVAL '17 hours'
          ELSE lr.shift_date::timestamp + INTERVAL '8 hours'
        END AS started_at,
        CASE WHEN lr.shift IN ('N', 'NC')
          THEN lr.shift_date::timestamp + INTERVAL '1 day 8 hours'
          ELSE lr.shift_date::timestamp + INTERVAL '17 hours'
        END AS expected_end_at,
        CASE WHEN lr.shift IN ('N', 'NC')
          THEN lr.shift_date::timestamp + INTERVAL '1 day 8 hours'
          ELSE lr.shift_date::timestamp + INTERVAL '17 hours'
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
          (lr.shift NOT IN ('N', 'NC') AND lr.shift_date::timestamp + INTERVAL '17 hours' < NOW())
          OR (lr.shift IN ('N', 'NC') AND lr.shift_date::timestamp + INTERVAL '1 day 8 hours' < NOW())
        )
        AND NOT EXISTS (
          SELECT 1 FROM shift_logs sl
          WHERE sl.nurse_id = lr.accepted_by_nurse_id
            AND sl.shift_date = lr.shift_date
        )
    `);
    if (missedLocum.rowCount > 0) {
      console.log(
        `[auto-end] ${new Date().toISOString()} — recorded ${missedLocum.rowCount} missed locum shift(s)`,
      );
    }

    // Credit approved leave hours for dates that have now arrived.
    // At approval time, only past/today shifts are credited immediately; future shifts
    // land here once their shift_date reaches CURRENT_DATE.
    const leaveCredit = await pool.query(`
      INSERT INTO shift_logs
        (nurse_id, shift_date, shift_type,
         started_at, expected_end_at, ended_at,
         period_start, hours_logged,
         is_leave, is_missed, is_locum, is_swap,
         leave_request_id)
      SELECT
        sa.nurse_id,
        sa.shift_date,
        CASE WHEN sa.pre_leave_shift IN ('N', 'NC') THEN 'N' ELSE 'M' END::shift_code,
        CASE WHEN sa.pre_leave_shift IN ('N', 'NC')
          THEN sa.shift_date::timestamp + INTERVAL '17 hours'
          ELSE sa.shift_date::timestamp + INTERVAL '8 hours'
        END,
        CASE WHEN sa.pre_leave_shift IN ('N', 'NC')
          THEN sa.shift_date::timestamp + INTERVAL '1 day 8 hours'
          ELSE sa.shift_date::timestamp + INTERVAL '17 hours'
        END,
        CASE WHEN sa.pre_leave_shift IN ('N', 'NC')
          THEN sa.shift_date::timestamp + INTERVAL '1 day 8 hours'
          ELSE sa.shift_date::timestamp + INTERVAL '17 hours'
        END,
        COALESCE(
          (SELECT MIN(s2.shift_date)
           FROM shift_assignments s2
           WHERE s2.status = 'published'
             AND s2.shift_date BETWEEN sa.shift_date - 27 AND sa.shift_date),
          sa.shift_date
        ),
        CASE WHEN sa.pre_leave_shift IN ('N', 'NC') THEN 15 ELSE 9 END,
        true,
        false,
        false,
        false,
        lr.id
      FROM shift_assignments sa
      JOIN leave_requests lr
        ON lr.nurse_id = sa.nurse_id
        AND sa.shift_date BETWEEN lr.from_date AND lr.to_date
        AND lr.status = 'Approved'
        AND lr.type != 'Swap'
      WHERE sa.shift = 'LEAVE'
        AND sa.status = 'published'
        AND sa.shift_date <= CURRENT_DATE
        AND sa.pre_leave_shift IN ('M', 'MWC', 'N', 'NC')
        AND NOT EXISTS (
          SELECT 1 FROM shift_logs sl
          WHERE sl.nurse_id = sa.nurse_id
            AND sl.shift_date = sa.shift_date
            AND sl.is_leave = true
        )
      RETURNING nurse_id, hours_logged
    `);

    for (const row of leaveCredit.rows) {
      if (row.hours_logged > 0) {
        await pool
          .query("SELECT increment_nurse_hours($1, $2)", [row.nurse_id, row.hours_logged])
          .catch((err) =>
            console.error(
              `[auto-end] leave hours increment failed for ${row.nurse_id}:`,
              err.message,
            ),
          );
      }
    }

    if (leaveCredit.rowCount > 0) {
      console.log(
        `[auto-end] ${new Date().toISOString()} — credited ${leaveCredit.rowCount} leave shift(s)`,
      );
    }
  } catch (err) {
    console.error("[auto-end] Error:", err.message);
  }
}

function startAutoEndJob() {
  // Run once immediately on startup to catch any shifts that ended while the server was down.
  autoEndOverdueShifts();
  // Then run every 5 minutes via cron.
  cron.schedule("*/5 * * * *", autoEndOverdueShifts);
  console.log("[auto-end] Shift auto-end job started (runs every 5 minutes)");
}

module.exports = { startAutoEndJob };
