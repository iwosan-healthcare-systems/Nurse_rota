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
const { checkDraftPeriodLeaveClosed } = require("../lib/rota-period-dates");

// Mirrors leave-requests.js's own EXEMPT_LEAVE_TYPES (kept as a separate
// local copy — this job only needs it for the one check below, not the full
// submission-time validation that file does).
const EXEMPT_LEAVE_TYPES = ["Sick", "Emergency", "Swap"];

// Arbitrary fixed key for this job's mutex, distinct from AUTO_END_LOCK_KEY
// (729312) in jobs/auto-end-shifts.js — see that file for why the lock exists.
const AUTO_DECLINE_LOCK_KEY = 729313;

// Admin-configurable via System Settings — which leave types get one extra
// day of grace (declined at 00:00 the day AFTER from_date, not the moment
// from_date arrives) because they can legitimately be filed same-day or
// after the fact. Default matches what this system shipped with.
const DEFAULT_GRACE_TYPES = ["Sick", "Emergency"];

async function getGraceTypes() {
  const { rows } = await pool.query(
    "SELECT value FROM portal_settings WHERE key = 'grace_leave_types'",
  );
  return Array.isArray(rows[0]?.value) && rows[0].value.length ? rows[0].value : DEFAULT_GRACE_TYPES;
}

async function autoDeclineExpiredRequests() {
  const lockClient = await pool.connect();
  try {
    const { rows: lockRows } = await lockClient.query("SELECT pg_try_advisory_lock($1) AS locked", [
      AUTO_DECLINE_LOCK_KEY,
    ]);
    if (!lockRows[0].locked) return; // another instance already holds the lock this tick

    await runAutoDecline();
    await runAutoDeclineDraftClosedLeave();
  } catch (err) {
    console.error("[auto-decline] Error:", err.message);
  } finally {
    await lockClient
      .query("SELECT pg_advisory_unlock($1)", [AUTO_DECLINE_LOCK_KEY])
      .catch(() => {});
    lockClient.release();
  }
}

async function runAutoDecline() {
  const graceTypes = await getGraceTypes();
  const { rows: expired } = await pool.query(
    `
    UPDATE leave_requests
       SET status = 'Rejected',
           reviewed_at = NOW(),
           review_note = 'Automatically declined — not reviewed before the deadline (no backdated approval).'
     WHERE status = 'Pending'
       AND (
         (type::text != ALL($1::text[]) AND from_date <= CURRENT_DATE)
         OR
         (type::text = ANY($1::text[]) AND from_date < CURRENT_DATE)
       )
     RETURNING id, nurse_id, nurse_name, type, from_date, to_date, requested_by, switch_nurse_b
    `,
    [graceTypes],
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

    await notify(
      r.requested_by,
      isSwap ? `switch_rejected_${r.id}_initiator` : `leave_rejected_${r.id}`,
    );

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

// Second pass: a Pending non-exempt-type leave request whose nurse's ward
// already has a DRAFT rota covering the requested dates, and that draft's
// OWN leave-closure window has already passed, is now permanently stale —
// the draft was (or should have been) generated without this leave factored
// in, and nobody reviewing it late can retroactively fix that. This is the
// same per-unit-period check leave-requests.js does at submission time (see
// its header comment for why the GLOBAL leave-closure check alone isn't
// enough for a unit that's fallen behind the rest of the system) — this pass
// exists so a request that slipped through some other path (or was Pending
// before that submit-time check existed) still gets cleaned up, not just
// prevented from happening again.
async function runAutoDeclineDraftClosedLeave() {
  const { rows: candidates } = await pool.query(
    `SELECT id, nurse_id, nurse_name, type, from_date, to_date, requested_by
       FROM leave_requests
      WHERE status = 'Pending' AND type::text != ALL($1::text[])`,
    [EXEMPT_LEAVE_TYPES],
  );
  if (!candidates.length) return;

  let declinedCount = 0;
  for (const r of candidates) {
    const draftCheck = await checkDraftPeriodLeaveClosed(r.nurse_id, r.from_date, r.to_date);
    if (!draftCheck.closed) continue;

    await pool
      .query(
        `UPDATE leave_requests
            SET status = 'Rejected', reviewed_at = NOW(),
                review_note = 'Automatically declined — the rota draft for this period is already locked in and the leave window has closed.'
          WHERE id = $1 AND status = 'Pending'`,
        [r.id],
      )
      .catch((err) => {
        console.error("[auto-decline] draft-closed decline failed:", err.message);
        return null;
      });
    declinedCount++;

    await pool
      .query(`INSERT INTO audit_logs (actor_name, action, target) VALUES ('system', $1, $2)`, [
        "Leave request auto-declined (draft period leave window closed)",
        `${r.nurse_name} · ${r.type} · ${r.from_date} → ${r.to_date}`,
      ])
      .catch((err) => console.error("[auto-decline] audit log failed:", err.message));

    await notify(r.requested_by, `leave_rejected_${r.id}`);
    const profileId = await findProfileId(r.nurse_id, r.nurse_name);
    if (profileId && profileId !== r.requested_by) {
      await notify(profileId, `leave_rejected_${r.id}_staff`);
    }
  }

  if (declinedCount > 0) {
    console.log(
      `[auto-decline] ${new Date().toISOString()} — auto-declined ${declinedCount} request(s) (draft period leave window closed)`,
    );
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
