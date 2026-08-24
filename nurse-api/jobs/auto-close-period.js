const cron = require("node-cron");
const pool = require("../db");
const { closeCompletedPeriod } = require("../lib/auto-close-period");

const AUTO_CLOSE_LOCK_KEY = 729313;

async function autoClosePeriod() {
  const lockClient = await pool.connect();
  try {
    const { rows } = await lockClient.query("SELECT pg_try_advisory_lock($1) AS locked", [
      AUTO_CLOSE_LOCK_KEY,
    ]);
    if (!rows[0].locked) return;
    const result = await closeCompletedPeriod();
    if (result.closed) {
      console.log(
        `[auto-close] ${new Date().toISOString()} — closed ${result.period_start} → ${result.period_end}`,
      );
    }
  } catch (err) {
    console.error("[auto-close] Error:", err.message);
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [AUTO_CLOSE_LOCK_KEY]).catch(() => {});
    lockClient.release();
  }
}

function startAutoClosePeriodJob() {
  autoClosePeriod();
  cron.schedule("*/5 * * * *", autoClosePeriod);
  console.log("[auto-close] Period auto-close job started (runs every 5 minutes)");
}

module.exports = { startAutoClosePeriodJob };
