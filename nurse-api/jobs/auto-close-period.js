const cron = require("node-cron");
const pool = require("../db");
const { forEachHospital } = require("../lib/tenant-context");
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
  // Every run happens once per hospital, inside that hospital's data context.
  const tick = () =>
    forEachHospital(pool, () => autoClosePeriod()).catch((err) =>
      console.error("[auto-close-period] hospital loop failed:", err.message),
    );
  tick();
  cron.schedule("*/5 * * * *", tick);
  console.log("[auto-close] Period auto-close job started (runs every 5 minutes)");
}

module.exports = { startAutoClosePeriodJob };
