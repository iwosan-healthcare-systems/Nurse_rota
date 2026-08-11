const pool = require("../db");

// Live pause/resume for the three rota-lifecycle cron jobs (auto-generate,
// auto-submit, auto-publish) — a System Settings toggle instead of a code
// change + redeploy each time. Read fresh from portal_settings on every cron
// tick (not cached in memory), so flipping the switch takes effect within one
// 5-minute tick in either direction. A missing row or missing individual key
// defaults to "not paused" (false) — the jobs run normally until someone
// explicitly pauses them.
const DEFAULT_PAUSE_STATE = { auto_generate: false, auto_submit: false, auto_publish: false };

async function getRotaJobPauseState() {
  const { rows } = await pool.query(
    "SELECT value FROM portal_settings WHERE key = 'rota_jobs_paused'",
  );
  return { ...DEFAULT_PAUSE_STATE, ...(rows[0]?.value ?? {}) };
}

async function isRotaJobPaused(job) {
  const state = await getRotaJobPauseState();
  return !!state[job];
}

module.exports = { getRotaJobPauseState, isRotaJobPaused, DEFAULT_PAUSE_STATE };
