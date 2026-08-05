// Reminds hr_admin of a still-Pending rota edit-access request once the T-17
// edit-close deadline (see auto-submit-draft.js / lib/rota-period-dates.js)
// is within 24 hours.
const cron = require("node-cron");
const pool = require("../db");
const { getWindowForPeriod } = require("../lib/rota-period-dates");
const { sendMail, portalUrl } = require("../lib/mailer");

// Distinct from every other job's lock key — see jobs/auto-end-shifts.js for why.
const AUTO_ROTA_EDIT_APPROVAL_REMINDER_LOCK_KEY = 729322;

async function activeProfilesWithRole(role) {
  const { rows } = await pool.query(
    `SELECT DISTINCT p.id, p.email FROM profiles p
       JOIN user_roles ur ON ur.user_id = p.id AND ur.role = $1
      WHERE p.is_active = true`,
    [role],
  );
  return rows;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// T-17 "closes" at the START of the day after edit_close_date, Africa/Lagos
// (fixed UTC+1) — mirrors the edit_is_closed formula in rota-period-dates.js.
function editCloseDeadlineInstant(editCloseDate) {
  return new Date(`${addDays(editCloseDate, 1)}T00:00:00+01:00`);
}

async function sendRotaEditApprovalReminders() {
  const lockClient = await pool.connect();
  try {
    const { rows: lockRows } = await lockClient.query("SELECT pg_try_advisory_lock($1) AS locked", [
      AUTO_ROTA_EDIT_APPROVAL_REMINDER_LOCK_KEY,
    ]);
    if (!lockRows[0].locked) return; // another instance already holds the lock this tick

    await runSendRotaEditApprovalReminders();
  } catch (err) {
    console.error("[rota-edit-approval-reminder] Error:", err.message);
  } finally {
    await lockClient
      .query("SELECT pg_advisory_unlock($1)", [AUTO_ROTA_EDIT_APPROVAL_REMINDER_LOCK_KEY])
      .catch(() => {});
    lockClient.release();
  }
}

async function runSendRotaEditApprovalReminders() {
  try {
    const { rows: pending } = await pool.query(
      `SELECT id, facility, ward, role_group, period_start, requested_by_name FROM rota_edit_requests WHERE status = 'Pending'`,
    );

    let sentCount = 0;
    if (pending.length) {
      const hrProfiles = await activeProfilesWithRole("hr_admin");
      for (const r of pending) {
        const window = await getWindowForPeriod(r.period_start);
        if (window.editIsClosed) continue; // already past deadline — auto-submit job handles this
        const deadline = editCloseDeadlineInstant(window.editCloseDate);
        const msUntilDeadline = deadline.getTime() - Date.now();
        if (msUntilDeadline <= 0 || msUntilDeadline > 24 * 3600 * 1000) continue;

        const unitLabel = r.ward ?? r.role_group;
        for (const { id, email } of hrProfiles) {
          const notifKey = `rota_edit_approval_reminder_${r.id}_${id}`;
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
            subject: `Reminder — edit-access request for ${unitLabel} still awaiting approval`,
            title: "Approval reminder",
            bodyHtml: `<p><strong>${r.requested_by_name ?? "A head nurse"}</strong>'s edit-access request for <strong>${unitLabel}</strong> · ${r.facility} is still <strong>Pending</strong>, and the T-17 deadline is approaching — after that, the draft force-submits as-is and this request expires unactioned.</p>`,
            ctaText: "Review in Approvals",
            ctaUrl: portalUrl("/approvals"),
          }).catch(() => {});
          sentCount++;
        }
      }
    }

    if (sentCount > 0) {
      console.log(
        `[rota-edit-approval-reminder] ${new Date().toISOString()} — sent ${sentCount} reminder(s)`,
      );
      await pool
        .query(`INSERT INTO audit_logs (actor_name, action, target) VALUES ('system', $1, $2)`, [
          "Rota edit-access approval reminders sent",
          `${sentCount} reminder(s)`,
        ])
        .catch((err) => console.error("[rota-edit-approval-reminder] audit log failed:", err.message));
    }
  } catch (err) {
    console.error("[rota-edit-approval-reminder] Error:", err.message);
  }
}

function startRotaEditApprovalReminderJob() {
  sendRotaEditApprovalReminders();
  cron.schedule("*/5 * * * *", sendRotaEditApprovalReminders);
  console.log(
    "[rota-edit-approval-reminder] Rota edit-access approval reminder job started (runs every 5 minutes)",
  );
}

module.exports = { startRotaEditApprovalReminderJob };
