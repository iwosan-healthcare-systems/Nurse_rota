const cron = require("node-cron");
const pool = require("../db");
const { forEachHospital } = require("../lib/tenant-context");
const { sendMail, portalUrl } = require("../lib/mailer");
const { getShiftReminderSettings } = require("../lib/shift-reminder-settings");
const {
  configuredShiftReminders,
  escapeReminderHtml,
} = require("../lib/configured-shift-reminders");

// Arbitrary fixed key for this job's mutex — see auto-end-shifts.js for why
// this is needed (multiple PM2 instances, same wall-clock cron tick).
const AUTO_SHIFT_START_REMINDER_LOCK_KEY = 729318;

const SHIFT_LABELS = {
  M: "Morning",
  MWC: "Morning Weekend Coverage",
  N: "Night",
  NC: "Night Coverage",
};

// Same "shift_date + offset, cast through Africa/Lagos" pattern used by
// auto-end-shifts.js, so this start-time math stays consistent with the
// end-time math already relied on elsewhere. `col` is the table-qualified
// shift/shift_date prefix, e.g. "sa" or "lr".
function startTimeSql(col) {
  return `CASE WHEN ${col}.shift IN ('N', 'NC')
    THEN (${col}.shift_date::timestamp + INTERVAL '17 hours') AT TIME ZONE 'Africa/Lagos'
    ELSE (${col}.shift_date::timestamp + INTERVAL '8 hours') AT TIME ZONE 'Africa/Lagos'
  END`;
}

function fmtShiftDate(shiftDate) {
  return new Date(shiftDate).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

async function sendReminderEmails() {
  const lockClient = await pool.connect();
  try {
    const { rows: lockRows } = await lockClient.query("SELECT pg_try_advisory_lock($1) AS locked", [
      AUTO_SHIFT_START_REMINDER_LOCK_KEY,
    ]);
    if (!lockRows[0].locked) return; // another instance already holds the lock this tick

    await runSendReminderEmails();
  } catch (err) {
    console.error("[shift-start-reminder] Error:", err.message);
  } finally {
    await lockClient
      .query("SELECT pg_advisory_unlock($1)", [AUTO_SHIFT_START_REMINDER_LOCK_KEY])
      .catch(() => {});
    lockClient.release();
  }
}

async function runSendReminderEmails() {
  try {
    // Regular roster assignments starting in the next N minutes (default 15,
    // admin-configurable via System Settings), not yet clocked in.
    const { upcoming_shift_minutes } = await getShiftReminderSettings();
    const { rows: regular } = await pool.query(
      `SELECT sa.nurse_id, sa.shift, sa.shift_date, sa.ward, n.name, p.id AS profile_id, p.email
       FROM shift_assignments sa
       JOIN nurses n ON n.id = sa.nurse_id
       JOIN profiles p ON p.id = COALESCE(
         n.profile_id,
         (SELECT id FROM profiles WHERE LOWER(full_name) = LOWER(n.name) LIMIT 1)
       )
       WHERE sa.status = 'published'
         AND COALESCE(sa.shift_definition_run_id,sa.scheduling_run_id) IS NULL
         AND sa.shift IN ('M', 'MWC', 'N', 'NC')
         AND (${startTimeSql("sa")}) > NOW()
         AND (${startTimeSql("sa")}) <= NOW() + ($1::numeric * INTERVAL '1 minute')
         AND NOT EXISTS (
           SELECT 1 FROM shift_logs sl WHERE sl.nurse_id = sa.nurse_id AND sl.shift_date = sa.shift_date
         )`,
      [upcoming_shift_minutes],
    );

    // Locum-covered shifts — these never get a shift_assignments row (see
    // auto-end-shifts.js's comment on this), so they're resolved separately
    // straight from locum_requests.
    const { rows: locum } = await pool.query(
      `SELECT lr.accepted_by_nurse_id AS nurse_id, lr.shift, lr.shift_date, lr.ward, n.name, p.id AS profile_id, p.email
       FROM locum_requests lr
       JOIN nurses n ON n.id = lr.accepted_by_nurse_id
       JOIN profiles p ON p.id = COALESCE(
         n.profile_id,
         (SELECT id FROM profiles WHERE LOWER(full_name) = LOWER(n.name) LIMIT 1)
       )
       WHERE lr.status = 'filled'
         AND lr.accepted_by_nurse_id IS NOT NULL
         AND (${startTimeSql("lr")}) > NOW()
         AND (${startTimeSql("lr")}) <= NOW() + ($1::numeric * INTERVAL '1 minute')
         AND NOT EXISTS (
           SELECT 1 FROM shift_logs sl WHERE sl.nurse_id = lr.accepted_by_nurse_id AND sl.shift_date = lr.shift_date
         )`,
      [upcoming_shift_minutes],
    );

    const configured = await configuredShiftReminders(
      pool,
      "start",
      Number(upcoming_shift_minutes),
    );
    for (const error of configured.errors)
      console.error(
        "[shift-start-reminder] Skipped unresolved assignment",
        error.assignmentId,
        error.error,
      );
    let sentCount = 0;
    for (const row of [...regular, ...configured.rows, ...locum]) {
      if (!row.email) continue;
      const notifKey = `shift_reminder_start_${row.nurse_id}_${row.shift_date}_${row.shift}`;
      // ON CONFLICT DO NOTHING + no row returned = this reminder was already
      // sent for this exact shift, so skip — the 15-minute window can be seen
      // on 2-3 separate 5-minute ticks, but the email must only go out once.
      const { rowCount } = await pool
        .query(
          `INSERT INTO notification_state (user_id, notif_key, is_read)
           VALUES ($1, $2, false)
           ON CONFLICT (user_id, notif_key) DO NOTHING`,
          [row.profile_id, notifKey],
        )
        .catch(() => ({ rowCount: 0 }));
      if (rowCount === 0) continue;

      const label = row.scheduled_shift?.name ?? SHIFT_LABELS[row.shift] ?? row.shift;
      sendMail({
        to: row.email,
        subject: `Reminder — your ${label} shift starts in ${upcoming_shift_minutes} minutes`,
        title: "Your shift starts soon",
        bodyHtml: `<p>Hi ${escapeReminderHtml(row.name ?? "there")},</p><p>This is a reminder that your <strong>${escapeReminderHtml(label)}</strong> shift${row.ward ? ` at <strong>${escapeReminderHtml(row.ward)}</strong>` : ""} starts in about ${upcoming_shift_minutes} minutes, on ${fmtShiftDate(row.shift_date)}.</p><p>Please sign in to the portal and start your shift as soon as you arrive.</p>`,
        ctaText: "Open Shift Page",
        ctaUrl: portalUrl("/shift"),
      }).catch(() => {});
      sentCount++;
    }

    if (sentCount > 0) {
      console.log(
        `[shift-start-reminder] ${new Date().toISOString()} — sent ${sentCount} reminder(s)`,
      );
      await pool
        .query(`INSERT INTO audit_logs (actor_name, action, target) VALUES ('system', $1, $2)`, [
          "Shift start reminders sent",
          `${sentCount} reminder(s)`,
        ])
        .catch((err) => console.error("[shift-start-reminder] audit log failed:", err.message));
    }
  } catch (err) {
    console.error("[shift-start-reminder] Error:", err.message);
  }
}

function startShiftStartReminderJob() {
  // Every run happens once per hospital, inside that hospital's data context.
  const tick = () =>
    forEachHospital(pool, () => sendReminderEmails()).catch((err) =>
      console.error("[auto-shift-start-reminder] hospital loop failed:", err.message),
    );
  tick();
  cron.schedule("*/5 * * * *", tick);
  console.log("[shift-start-reminder] Shift start reminder job started (runs every 5 minutes)");
}

module.exports = { startShiftStartReminderJob, runSendReminderEmails };
