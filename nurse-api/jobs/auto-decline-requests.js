// Auto-decline leave & shift-switch requests that are still Pending once their
// deadline passes, so nothing is left showing as "Pending" for a date that has
// already arrived (or, for same-day-filed leave types, already passed).
//
// Two deadlines:
//   - Everything except Sick/Emergency (Annual, Maternity, Public Holiday, Study
//     Leave, Leave of Absence, Compassionate Leave, and Swap/shift-switch):
//     declined the moment `from_date` arrives (00:00 on the requested date).
//   - Sick, Emergency: these can legitimately be filed same-day or after the
//     fact, so they get one extra day of grace — declined at 00:00 the day
//     AFTER `from_date`, never later (no backdated approvals).
//
// Mirrors the human-review notification pattern in src/routes/_app/leave.tsx
// (leave_rejected_/switch_rejected_ notif_key prefixes) so the existing bell UI
// picks these up with no frontend changes needed.
const cron = require("node-cron");
const pool = require("../db");

// Arbitrary fixed key for this job's mutex, distinct from AUTO_END_LOCK_KEY
// (729312) in jobs/auto-end-shifts.js — see that file for why the lock exists.
const AUTO_DECLINE_LOCK_KEY = 729313;

const GRACE_TYPES = ["Sick", "Emergency"];

async function autoDeclineExpiredRequests() {
  const lockClient = await pool.connect();
  try {
    const { rows: lockRows } = await lockClient.query(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [AUTO_DECLINE_LOCK_KEY],
    );
    if (!lockRows[0].locked) return; // another instance already holds the lock this tick

    await runAutoDecline();
  } catch (err) {
    console.error("[auto-decline] Error:", err.message);
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [AUTO_DECLINE_LOCK_KEY]).catch(() => {});
    lockClient.release();
  }
}

async function runAutoDecline() {
  const { rows: expired } = await pool.query(
    `
    UPDATE leave_requests
       SET status = 'Rejected',
           reviewed_at = NOW(),
           review_note = 'Automatically declined — not reviewed before the deadline (no backdated approval).'
     WHERE status = 'Pending'
       AND (
         (type != ALL($1::text[]) AND from_date <= CURRENT_DATE)
         OR
         (type = ANY($1::text[]) AND from_date < CURRENT_DATE)
       )
     RETURNING id, nurse_id, nurse_name, type, from_date, to_date, requested_by, switch_nurse_b
    `,
    [GRACE_TYPES],
  );

  if (!expired.length) return;

  console.log(
    `[auto-decline] ${new Date().toISOString()} — auto-declined ${expired.length} request(s)`,
  );

  for (const r of expired) {
    const isSwap = r.type === "Swap";

    await pool
      .query(`INSERT INTO audit_logs (actor_name, action, target) VALUES ('system', $1, $2)`, [
        isSwap ? "Shift switch request auto-declined" : "Leave request auto-declined",
        `${r.nurse_name} · ${r.type} · ${r.from_date} → ${r.to_date}`,
      ])
      .catch((err) => console.error("[auto-decline] audit log failed:", err.message));

    await notify(r.requested_by, isSwap ? `switch_rejected_${r.id}_initiator` : `leave_rejected_${r.id}`);

    const profileId = await findProfileId(r.nurse_id, r.nurse_name);
    if (profileId && profileId !== r.requested_by) {
      await notify(profileId, isSwap ? `switch_rejected_${r.id}` : `leave_rejected_${r.id}_staff`);
    }

    if (isSwap && r.switch_nurse_b) {
      const profileBId = await findProfileId(r.switch_nurse_b, null);
      if (profileBId) await notify(profileBId, `switch_rejected_${r.id}_b`);
    }
  }
}

// Resolve a nurse to their login profile — by profile_id first, then by the
// nurse's current name, then (if nurseId is missing, e.g. a deleted nurse) by
// the historical nurseName snapshot stored on the leave_requests row. Mirrors
// the profile_id-then-name fallback already used elsewhere in this codebase
// (e.g. auth.js deactivate/reactivate) for nurses without a linked profile_id.
async function findProfileId(nurseId, nurseName) {
  const { rows } = await pool.query(
    `SELECT COALESCE(
       (SELECT p.id FROM nurses n JOIN profiles p ON p.id = n.profile_id WHERE n.id = $1),
       (SELECT p.id FROM nurses n JOIN profiles p ON LOWER(p.full_name) = LOWER(n.name) WHERE n.id = $1 LIMIT 1),
       (SELECT p.id FROM profiles p WHERE $2::text IS NOT NULL AND LOWER(p.full_name) = LOWER($2) LIMIT 1)
     ) AS profile_id`,
    [nurseId, nurseName],
  );
  return rows[0]?.profile_id ?? null;
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

function startAutoDeclineJob() {
  // Run once immediately on startup to catch anything that expired while the server was down.
  autoDeclineExpiredRequests();
  // Then run every 5 minutes via cron.
  cron.schedule("*/5 * * * *", autoDeclineExpiredRequests);
  console.log("[auto-decline] Auto-decline job started (runs every 5 minutes)");
}

module.exports = { startAutoDeclineJob };
