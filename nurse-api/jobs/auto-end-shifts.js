const cron = require('node-cron');
const pool = require('../db');

async function autoEndOverdueShifts() {
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
          .query('SELECT increment_nurse_hours($1, $2)', [row.nurse_id, row.hours_logged])
          .catch((err) => console.error(`[auto-end] hours increment failed for ${row.nurse_id}:`, err.message));
      }
    }

    if (result.rowCount > 0) {
      console.log(`[auto-end] ${new Date().toISOString()} — closed ${result.rowCount} overdue shift(s)`);
    }

    // Record missed shifts: published assignments in the past with no shift log at all.
    // Idempotent — the NOT EXISTS guard skips already-recorded rows.
    const missed = await pool.query(`
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
          (SELECT MIN(s2.shift_date)::text
           FROM shift_assignments s2
           WHERE s2.status = 'published'
             AND s2.shift_date BETWEEN sa.shift_date - 27 AND sa.shift_date),
          sa.shift_date::text
        )                           AS period_start,
        0                           AS hours_logged,
        true                        AS is_missed,
        false                       AS is_leave,
        false                       AS is_locum,
        false                       AS is_swap
      FROM shift_assignments sa
      WHERE sa.status = 'published'
        AND sa.shift_date < CURRENT_DATE
        AND sa.shift NOT IN ('LEAVE', 'OFF')
        AND NOT EXISTS (
          SELECT 1 FROM shift_logs sl
          WHERE sl.nurse_id = sa.nurse_id
            AND sl.shift_date = sa.shift_date
        )
    `);
    if (missed.rowCount > 0) {
      console.log(`[auto-end] ${new Date().toISOString()} — recorded ${missed.rowCount} missed shift(s)`);
    }
  } catch (err) {
    console.error('[auto-end] Error:', err.message);
  }
}

function startAutoEndJob() {
  // Run once immediately on startup to catch any shifts that ended while the server was down.
  autoEndOverdueShifts();
  // Then run every 5 minutes via cron.
  cron.schedule('*/5 * * * *', autoEndOverdueShifts);
  console.log('[auto-end] Shift auto-end job started (runs every 5 minutes)');
}

module.exports = { startAutoEndJob };
