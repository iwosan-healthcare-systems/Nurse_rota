// Switch off logins whose end time has passed (staff removed from the rota keep
// their login until their last shift ends). Sign-in and requests already refuse
// these accounts once the time passes; this keeps the profile list accurate.
const cron = require("node-cron");
const pool = require("../db");
const { runInPlatform } = require("../lib/tenant-context");

async function runAutoEndLogins() {
  const { rows } = await runInPlatform(() =>
    pool.query(
      `UPDATE profiles SET is_active = false, login_ends_at = NULL, updated_at = NOW()
        WHERE login_ends_at IS NOT NULL AND login_ends_at <= NOW()
        RETURNING full_name`,
    ),
  );
  if (rows.length)
    console.log(`[auto-end-logins] Deactivated ${rows.length} login(s) after their last shift`);
  return rows.length;
}

function startAutoEndLoginsJob() {
  const tick = () =>
    runAutoEndLogins().catch((err) => console.error("[auto-end-logins] Error:", err.message));
  tick();
  cron.schedule("*/15 * * * *", tick);
  console.log("[auto-end-logins] Job started (runs every 15 minutes)");
}

module.exports = { startAutoEndLoginsJob, runAutoEndLogins };
