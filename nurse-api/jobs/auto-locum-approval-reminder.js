// Reminds the CNO of a still-pending locum request once its expiry deadline
// (see auto-expire-locum-requests.js) is within 24 hours. Most locum requests
// are filed close to the shift itself, so this window often won't have 24
// hours to catch — it still fires whenever there's enough lead time.
const cron = require("node-cron");
const pool = require("../db");
const { sendMail, portalUrl } = require("../lib/mailer");

// Distinct from every other job's lock key — see jobs/auto-end-shifts.js for why.
const AUTO_LOCUM_APPROVAL_REMINDER_LOCK_KEY = 729321;

async function activeProfilesWithRole(role) {
  const { rows } = await pool.query(
    `SELECT DISTINCT p.id, p.email FROM profiles p
       JOIN user_roles ur ON ur.user_id = p.id AND ur.role = $1
      WHERE p.is_active = true`,
    [role],
  );
  return rows;
}

// Same cutoff hours as auto-expire-locum-requests.js: night shifts need
// coverage arranged earlier in the day (4pm cutoff) than morning shifts (7am
// cutoff, 1 hour before the 8am start).
function locumDeadlineInstant(shiftDate, shift) {
  const hours = ["N", "NC"].includes(shift) ? 16 : 7;
  const base = new Date(`${shiftDate}T00:00:00+01:00`);
  return new Date(base.getTime() + hours * 3600 * 1000);
}

async function sendLocumApprovalReminders() {
  const lockClient = await pool.connect();
  try {
    const { rows: lockRows } = await lockClient.query("SELECT pg_try_advisory_lock($1) AS locked", [
      AUTO_LOCUM_APPROVAL_REMINDER_LOCK_KEY,
    ]);
    if (!lockRows[0].locked) return; // another instance already holds the lock this tick

    await runSendLocumApprovalReminders();
  } catch (err) {
    console.error("[locum-approval-reminder] Error:", err.message);
  } finally {
    await lockClient
      .query("SELECT pg_advisory_unlock($1)", [AUTO_LOCUM_APPROVAL_REMINDER_LOCK_KEY])
      .catch(() => {});
    lockClient.release();
  }
}

async function runSendLocumApprovalReminders() {
  try {
    const { rows: pending } = await pool.query(
      `SELECT id, shift_date, shift, facility, ward FROM locum_requests WHERE status = 'pending'`,
    );

    let sentCount = 0;
    if (pending.length) {
      const cnoProfiles = await activeProfilesWithRole("cno");
      for (const r of pending) {
        const deadline = locumDeadlineInstant(r.shift_date, r.shift);
        const msUntilDeadline = deadline.getTime() - Date.now();
        if (msUntilDeadline <= 0 || msUntilDeadline > 24 * 3600 * 1000) continue;

        for (const { id, email } of cnoProfiles) {
          const notifKey = `locum_approval_reminder_${r.id}_${id}`;
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
            subject: `Reminder — locum request for ${r.ward} · ${r.facility} still awaiting review`,
            title: "Approval reminder",
            bodyHtml: `<p>A locum request for <strong>${r.ward}</strong> · ${r.facility} on ${r.shift_date} (${r.shift}) is still <strong>pending</strong> and will expire if not reviewed soon.</p>`,
            ctaText: "Review Request",
            ctaUrl: portalUrl("/locum"),
          }).catch(() => {});
          sentCount++;
        }
      }
    }

    if (sentCount > 0) {
      console.log(`[locum-approval-reminder] ${new Date().toISOString()} — sent ${sentCount} reminder(s)`);
      await pool
        .query(`INSERT INTO audit_logs (actor_name, action, target) VALUES ('system', $1, $2)`, [
          "Locum approval reminders sent",
          `${sentCount} reminder(s)`,
        ])
        .catch((err) => console.error("[locum-approval-reminder] audit log failed:", err.message));
    }
  } catch (err) {
    console.error("[locum-approval-reminder] Error:", err.message);
  }
}

function startLocumApprovalReminderJob() {
  sendLocumApprovalReminders();
  cron.schedule("*/5 * * * *", sendLocumApprovalReminders);
  console.log("[locum-approval-reminder] Locum approval reminder job started (runs every 5 minutes)");
}

module.exports = { startLocumApprovalReminderJob };
