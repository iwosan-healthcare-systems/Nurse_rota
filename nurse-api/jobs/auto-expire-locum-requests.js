// Auto-expire locum requests once their shift's cutoff passes without the shift
// being filled — 7:00 AM on shift_date for a Morning request, 4:00 PM on
// shift_date for a Night request. Once expired, no further CNO review, invite,
// or claim action is possible (the frontend hides those controls once status
// leaves pending/approved/invites_sent, and POST /locum/requests/:id/claim only
// accepts status = 'invites_sent').
//
// Covers pending (never reviewed by CNO), approved (reviewed but no invites sent
// yet), and invites_sent (invites out, nobody accepted) requests. A request that
// already has at least one accepted invite is left alone even past cutoff and
// even if it hasn't reached nurses_needed yet — real nurses are already
// committed to it, so the remaining unmet need is simply dropped rather than
// the whole request being voided.
//
// Mirrors the human-review notification pattern (locum_expired_ notif_key) so
// the existing bell UI in AppShell.tsx picks these up with no extra wiring.
const cron = require("node-cron");
const pool = require("../db");

// Arbitrary fixed key for this job's mutex, distinct from AUTO_END_LOCK_KEY
// (729312) and AUTO_DECLINE_LOCK_KEY (729313) — see jobs/auto-end-shifts.js for
// why the lock exists.
const AUTO_EXPIRE_LOCUM_LOCK_KEY = 729314;

async function autoExpireLocumRequests() {
  const lockClient = await pool.connect();
  try {
    const { rows: lockRows } = await lockClient.query(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [AUTO_EXPIRE_LOCUM_LOCK_KEY],
    );
    if (!lockRows[0].locked) return; // another instance already holds the lock this tick

    await runAutoExpireLocumRequests();
  } catch (err) {
    console.error("[auto-expire-locum] Error:", err.message);
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [AUTO_EXPIRE_LOCUM_LOCK_KEY]).catch(() => {});
    lockClient.release();
  }
}

async function runAutoExpireLocumRequests() {
  const { rows: expired } = await pool.query(`
    UPDATE locum_requests lr
       SET status = 'expired',
           updated_at = NOW()
     WHERE status IN ('pending', 'approved', 'invites_sent')
       AND NOT EXISTS (
         SELECT 1 FROM locum_invites li
         WHERE li.locum_request_id = lr.id AND li.status = 'accepted'
       )
       AND (
         CASE WHEN lr.shift = 'N'
           THEN (lr.shift_date::timestamp + INTERVAL '16 hours') AT TIME ZONE 'Africa/Lagos'
           ELSE (lr.shift_date::timestamp + INTERVAL '7 hours') AT TIME ZONE 'Africa/Lagos'
         END
       ) < NOW()
    RETURNING id, requested_by, requested_by_name, shift_date, shift, ward, facility
  `);

  if (!expired.length) return;

  console.log(
    `[auto-expire-locum] ${new Date().toISOString()} — expired ${expired.length} locum request(s)`,
  );

  const ids = expired.map((r) => r.id);

  // Any invite still sitting "pending" for a now-expired request would otherwise
  // stay forever in a nurse's "Pending invites — respond soon" list even though
  // accepting it can no longer succeed (claim requires status = 'invites_sent').
  await pool
    .query(
      `UPDATE locum_invites
         SET status = 'unavailable', responded_at = NOW()
       WHERE status = 'pending' AND locum_request_id = ANY($1::uuid[])`,
      [ids],
    )
    .catch((err) => console.error("[auto-expire-locum] invite cleanup failed:", err.message));

  for (const r of expired) {
    await pool
      .query(`INSERT INTO audit_logs (actor_name, action, target) VALUES ('system', $1, $2)`, [
        "Locum request auto-expired",
        `${r.ward} · ${r.facility} · ${r.shift === "N" ? "Night" : "Morning"} · ${r.shift_date}`,
      ])
      .catch((err) => console.error("[auto-expire-locum] audit log failed:", err.message));

    await notify(r.requested_by, `locum_expired_${r.id}`);
  }
}

async function notify(userId, notifKey) {
  if (!userId) return;
  await pool
    .query(
      `INSERT INTO notification_state (user_id, notif_key, is_read)
       VALUES ($1, $2, false)
       ON CONFLICT (user_id, notif_key) DO NOTHING`,
      [userId, notifKey],
    )
    .catch(() => {});
}

function startAutoExpireLocumJob() {
  // Run once immediately on startup to catch anything that expired while the
  // server was down — this also backfills any currently pending/approved/
  // invites_sent requests already past their cutoff from before this job existed.
  autoExpireLocumRequests();
  // Then run every 5 minutes via cron.
  cron.schedule("*/5 * * * *", autoExpireLocumRequests);
  console.log("[auto-expire-locum] Auto-expire locum job started (runs every 5 minutes)");
}

module.exports = { startAutoExpireLocumJob };
