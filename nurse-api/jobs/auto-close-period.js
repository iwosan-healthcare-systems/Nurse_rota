const cron = require("node-cron");
const { closeCompletedPeriod } = require("../lib/auto-close-period");

async function autoClosePeriod() {
  try {
    // Catch up oldest-first after downtime; each close owns its transaction/locks.
    for (let i = 0; i < 24; i++) {
      const result = await closeCompletedPeriod();
      if (!result.closed) break;
      console.log(
        `[auto-close] ${new Date().toISOString()} — closed ${result.period_start} → ${result.period_end}`,
      );
    }
  } catch (err) {
    console.error("[auto-close] Error:", err.message);
  }
}

function startAutoClosePeriodJob() {
  autoClosePeriod();
  cron.schedule("*/5 * * * *", autoClosePeriod);
  console.log("[auto-close] Period auto-close job started (runs every 5 minutes)");
}

module.exports = { startAutoClosePeriodJob };
