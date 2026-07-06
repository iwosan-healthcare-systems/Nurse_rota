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
      RETURNING id, nurse_id, hours_logged, is_locum
    `);

    for (const row of result.rows) {
      if (!row.is_locum && row.hours_logged > 0) {
        await pool
          .query('SELECT increment_nurse_hours($1, $2)', [row.nurse_id, row.hours_logged])
          .catch((err) => console.error(`[auto-end] hours increment failed for ${row.nurse_id}:`, err.message));
      }
    }

    if (result.rowCount > 0) {
      console.log(`[auto-end] ${new Date().toISOString()} — closed ${result.rowCount} overdue shift(s)`);
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
