// Reminds whoever needs to approve a still-Pending leave/switch request, once
// its auto-decline deadline (see auto-decline-requests.js) is within 24 hours.
// One reminder per request — never re-sent once fired, dedup via
// notification_state exactly like every other one-shot job notification.
const cron = require("node-cron");
const pool = require("../db");
const { sendMail, portalUrl } = require("../lib/mailer");

// Distinct from every other job's lock key — see jobs/auto-end-shifts.js for why.
const AUTO_LEAVE_APPROVAL_REMINDER_LOCK_KEY = 729320;

// Same grace-period rule as auto-decline-requests.js: Sick/Emergency get one
// extra day before the deadline arrives.
const GRACE_TYPES = ["Sick", "Emergency"];

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Africa/Lagos is a fixed UTC+1 offset (no DST) — matches the offset used
// throughout rota-period-dates.js for the same reason.
function leaveDeadlineInstant(fromDate, isGrace) {
  const base = isGrace ? addDays(fromDate, 1) : fromDate;
  return new Date(`${base}T00:00:00+01:00`);
}

// Mirrors the approver-routing logic in routes/leave-requests.js's POST /
// handler exactly: CNO for a shift switch or for leave belonging to a chief
// matron; chief matron(s) at the nurse's own facility for everything else.
async function resolveApprovers(nurseId, type) {
  let approverRole = "chief_matron";
  let facilityFilter = null;
  if (type === "Swap") {
    approverRole = "cno";
  } else if (nurseId) {
    const { rows: roleRows } = await pool.query(
      `SELECT
         EXISTS (
           SELECT 1 FROM nurses n
           JOIN user_roles ur ON ur.user_id = n.profile_id AND ur.role = 'chief_matron'
           WHERE n.id = $1
         ) AS is_chief_matron,
         (SELECT facility FROM nurses WHERE id = $1) AS facility`,
      [nurseId],
    );
    if (roleRows[0]?.is_chief_matron) approverRole = "cno";
    else facilityFilter = roleRows[0]?.facility ?? null;
  }

  const params = facilityFilter ? [approverRole, facilityFilter] : [approverRole];
  const facilityClause = facilityFilter
    ? "AND EXISTS (SELECT 1 FROM nurses n2 WHERE LOWER(n2.name) = LOWER(p.full_name) AND n2.facility = $2)"
    : "";
  const { rows } = await pool.query(
    `SELECT DISTINCT p.id, p.email FROM profiles p
       JOIN user_roles ur ON ur.user_id = p.id AND ur.role = $1
      WHERE p.is_active = true ${facilityClause}`,
    params,
  );
  return rows;
}

async function sendLeaveApprovalReminders() {
  const lockClient = await pool.connect();
  try {
    const { rows: lockRows } = await lockClient.query("SELECT pg_try_advisory_lock($1) AS locked", [
      AUTO_LEAVE_APPROVAL_REMINDER_LOCK_KEY,
    ]);
    if (!lockRows[0].locked) return; // another instance already holds the lock this tick

    await runSendLeaveApprovalReminders();
  } catch (err) {
    console.error("[leave-approval-reminder] Error:", err.message);
  } finally {
    await lockClient
      .query("SELECT pg_advisory_unlock($1)", [AUTO_LEAVE_APPROVAL_REMINDER_LOCK_KEY])
      .catch(() => {});
    lockClient.release();
  }
}

async function runSendLeaveApprovalReminders() {
  try {
    const { rows: pending } = await pool.query(
      `SELECT id, nurse_id, nurse_name, type, from_date, to_date, reason FROM leave_requests WHERE status = 'Pending'`,
    );

    let sentCount = 0;
    for (const r of pending) {
      const isGrace = GRACE_TYPES.includes(r.type);
      const deadline = leaveDeadlineInstant(r.from_date, isGrace);
      const msUntilDeadline = deadline.getTime() - Date.now();
      if (msUntilDeadline <= 0 || msUntilDeadline > 24 * 3600 * 1000) continue;

      const approvers = await resolveApprovers(r.nurse_id, r.type);
      if (!approvers.length) continue;

      const typeLabel = r.type === "Swap" ? "shift switch" : `${r.type.toLowerCase()} leave`;
      for (const { id, email } of approvers) {
        const notifKey = `leave_approval_reminder_${r.id}_${id}`;
        const { rowCount } = await pool
          .query(
            `INSERT INTO notification_state (user_id, notif_key, is_read)
             VALUES ($1, $2, false)
             ON CONFLICT (user_id, notif_key) DO NOTHING`,
            [id, notifKey],
          )
          .catch(() => ({ rowCount: 0 }));
        if (rowCount === 0) continue;

        sendMail({
          to: email,
          subject: `Reminder — ${typeLabel} request from ${r.nurse_name} still awaiting approval`,
          title: "Approval reminder",
          bodyHtml: `<p>The ${typeLabel} request from <strong>${r.nurse_name}</strong> (${r.from_date} → ${r.to_date}) is still <strong>Pending</strong> and will be automatically declined if not reviewed soon.</p>`,
          ctaText: "Review Request",
          ctaUrl: portalUrl("/leave"),
        }).catch(() => {});
        sentCount++;
      }
    }

    if (sentCount > 0) {
      console.log(`[leave-approval-reminder] ${new Date().toISOString()} — sent ${sentCount} reminder(s)`);
      await pool
        .query(`INSERT INTO audit_logs (actor_name, action, target) VALUES ('system', $1, $2)`, [
          "Leave approval reminders sent",
          `${sentCount} reminder(s)`,
        ])
        .catch((err) => console.error("[leave-approval-reminder] audit log failed:", err.message));
    }
  } catch (err) {
    console.error("[leave-approval-reminder] Error:", err.message);
  }
}

function startLeaveApprovalReminderJob() {
  sendLeaveApprovalReminders();
  cron.schedule("*/5 * * * *", sendLeaveApprovalReminders);
  console.log("[leave-approval-reminder] Leave approval reminder job started (runs every 5 minutes)");
}

module.exports = { startLeaveApprovalReminderJob };
