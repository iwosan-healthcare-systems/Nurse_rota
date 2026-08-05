// Reminds whoever needs to act next on a rota unit sitting in an intermediate
// stage, once its deadline is within 24 hours:
//   submitted   → hr_admin, before the T-17 force-submit-is-moot deadline
//   hr_approved → cno,      before the T-14 auto-publish deadline
// Mirrors the per-unit enumeration in auto-submit-draft.js / auto-publish-rota.js.
const cron = require("node-cron");
const pool = require("../db");
const { getWindowForPeriod, getUnitPeriod } = require("../lib/rota-period-dates");
const { roleGroupOf, resolveUnitNurseIds } = require("../lib/force-submit-rota");
const { sendMail, portalUrl } = require("../lib/mailer");

// Distinct from every other job's lock key — see jobs/auto-end-shifts.js for why.
const AUTO_ROTA_APPROVAL_REMINDER_LOCK_KEY = 729323;

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

// T-17/T-14 "arrive" at the START of the day after edit_close_date/
// publish_deadline, Africa/Lagos (fixed UTC+1) — mirrors the edit_is_closed/
// publish_is_overdue formulas in rota-period-dates.js.
function deadlineInstant(dateStr) {
  return new Date(`${addDays(dateStr, 1)}T00:00:00+01:00`);
}

function fmtPeriodDate(d) {
  return d
    ? new Date(String(d).slice(0, 10) + "T00:00:00").toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "";
}

async function sendRotaApprovalReminders() {
  const lockClient = await pool.connect();
  try {
    const { rows: lockRows } = await lockClient.query("SELECT pg_try_advisory_lock($1) AS locked", [
      AUTO_ROTA_APPROVAL_REMINDER_LOCK_KEY,
    ]);
    if (!lockRows[0].locked) return; // another instance already holds the lock this tick

    await runSendRotaApprovalReminders();
  } catch (err) {
    console.error("[rota-approval-reminder] Error:", err.message);
  } finally {
    await lockClient
      .query("SELECT pg_advisory_unlock($1)", [AUTO_ROTA_APPROVAL_REMINDER_LOCK_KEY])
      .catch(() => {});
    lockClient.release();
  }
}

// Enumerates distinct (facility, ward|role_group) units currently in `status`,
// same recipe as auto-submit-draft.js / auto-publish-rota.js.
async function enumerateUnits(status) {
  const { rows } = await pool.query(
    `SELECT DISTINCT n.facility, sa.ward, n.role
       FROM shift_assignments sa
       JOIN nurses n ON n.id = sa.nurse_id
      WHERE sa.status = $1`,
    [status],
  );
  const seen = new Set();
  const units = [];
  for (const row of rows) {
    const roleGroup = row.ward ? null : roleGroupOf(row.role);
    if (!row.ward && !roleGroup) continue;
    const unitKey = `${row.facility}|${row.ward ?? roleGroup}`;
    if (seen.has(unitKey)) continue;
    seen.add(unitKey);
    units.push({ facility: row.facility, ward: row.ward, roleGroup, unitLabel: row.ward ?? roleGroup });
  }
  return units;
}

async function remindUnit({ facility, ward, roleGroup, unitLabel, deadlineField, notifPrefix, role, subject, verb }) {
  const nurseIds = await resolveUnitNurseIds({ facility, ward, roleGroup });
  const period = await getUnitPeriod(nurseIds, ward);
  if (!period) return 0;
  const window = await getWindowForPeriod(period.periodStart);
  const overdueFlag = deadlineField === "editCloseDate" ? window.editIsClosed : window.publishIsOverdue;
  if (overdueFlag) return 0; // already past — the force-submit/auto-publish job handles this

  const deadline = deadlineInstant(window[deadlineField]);
  const msUntilDeadline = deadline.getTime() - Date.now();
  if (msUntilDeadline <= 0 || msUntilDeadline > 24 * 3600 * 1000) return 0;

  const recipients = await activeProfilesWithRole(role);
  const facilitySlug = facility.toLowerCase().replace(/\s+/g, "_");
  const unitSlug = String(unitLabel).toLowerCase().replace(/\s+/g, "_");
  let sent = 0;
  for (const { id, email } of recipients) {
    const notifKey = `${notifPrefix}_${facilitySlug}|${unitSlug}|${period.periodStart}`;
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
      subject,
      title: "Approval reminder",
      bodyHtml: `<p>The rota for <strong>${unitLabel}</strong> · ${facility} (period starting ${fmtPeriodDate(period.periodStart)}) is still ${verb}, and the deadline is approaching.</p>`,
      ctaText: "Open Approvals",
      ctaUrl: portalUrl("/approvals"),
    }).catch(() => {});
    sent++;
  }
  return sent;
}

async function runSendRotaApprovalReminders() {
  try {
    let sentCount = 0;

    for (const unit of await enumerateUnits("submitted")) {
      sentCount += await remindUnit({
        ...unit,
        deadlineField: "editCloseDate",
        notifPrefix: "rota_submit_approval_reminder",
        role: "hr_admin",
        subject: `Reminder — rota for ${unit.unitLabel} still awaiting HR approval`,
        verb: "awaiting your approval",
      });
    }

    for (const unit of await enumerateUnits("hr_approved")) {
      sentCount += await remindUnit({
        ...unit,
        deadlineField: "publishDeadline",
        notifPrefix: "rota_publish_approval_reminder",
        role: "cno",
        subject: `Reminder — rota for ${unit.unitLabel} is HR-approved and awaiting publish`,
        verb: "HR-approved and awaiting publish",
      });
    }

    if (sentCount > 0) {
      console.log(`[rota-approval-reminder] ${new Date().toISOString()} — sent ${sentCount} reminder(s)`);
      await pool
        .query(`INSERT INTO audit_logs (actor_name, action, target) VALUES ('system', $1, $2)`, [
          "Rota approval reminders sent",
          `${sentCount} reminder(s)`,
        ])
        .catch((err) => console.error("[rota-approval-reminder] audit log failed:", err.message));
    }
  } catch (err) {
    console.error("[rota-approval-reminder] Error:", err.message);
  }
}

function startRotaApprovalReminderJob() {
  sendRotaApprovalReminders();
  cron.schedule("*/5 * * * *", sendRotaApprovalReminders);
  console.log("[rota-approval-reminder] Rota approval reminder job started (runs every 5 minutes)");
}

module.exports = { startRotaApprovalReminderJob };
