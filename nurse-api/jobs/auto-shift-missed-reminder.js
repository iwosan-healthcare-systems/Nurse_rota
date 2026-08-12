const cron = require("node-cron");
const pool = require("../db");
const { sendMail, portalUrl } = require("../lib/mailer");
const { getShiftReminderSettings } = require("../lib/shift-reminder-settings");

// Arbitrary fixed key for this job's mutex — see auto-end-shifts.js for why
// this is needed (multiple PM2 instances, same wall-clock cron tick).
const AUTO_SHIFT_MISSED_REMINDER_LOCK_KEY = 729319;

const SHIFT_LABELS = { M: "Morning", MWC: "Morning Weekend Coverage", N: "Night", NC: "Night Coverage" };

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

async function sendMissedReminderEmails() {
  const lockClient = await pool.connect();
  try {
    const { rows: lockRows } = await lockClient.query("SELECT pg_try_advisory_lock($1) AS locked", [
      AUTO_SHIFT_MISSED_REMINDER_LOCK_KEY,
    ]);
    if (!lockRows[0].locked) return; // another instance already holds the lock this tick

    await runSendMissedReminderEmails();
  } catch (err) {
    console.error("[shift-missed-reminder] Error:", err.message);
  } finally {
    await lockClient
      .query("SELECT pg_advisory_unlock($1)", [AUTO_SHIFT_MISSED_REMINDER_LOCK_KEY])
      .catch(() => {});
    lockClient.release();
  }
}

async function runSendMissedReminderEmails() {
  try {
    // Regular roster assignments whose start time was N+ hours ago (default
    // 3, admin-configurable via System Settings), still not clocked in. The
    // full is_missed flag (auto-end-shifts.js) only fires at shift END
    // (9-15h later) — this is an earlier, separate "you're late" heads-up,
    // not a replacement for it.
    const { missed_shift_hours } = await getShiftReminderSettings();
    const { rows: regular } = await pool.query(
      `SELECT sa.nurse_id, sa.shift, sa.shift_date, sa.ward, n.name, p.id AS profile_id, p.email
       FROM shift_assignments sa
       JOIN nurses n ON n.id = sa.nurse_id
       JOIN profiles p ON p.id = COALESCE(
         n.profile_id,
         (SELECT id FROM profiles WHERE LOWER(full_name) = LOWER(n.name) LIMIT 1)
       )
       WHERE sa.status = 'published'
         AND sa.shift IN ('M', 'MWC', 'N', 'NC')
         AND (${startTimeSql("sa")}) + ($1::numeric * INTERVAL '1 hour') <= NOW()
         AND NOT EXISTS (
           SELECT 1 FROM shift_logs sl WHERE sl.nurse_id = sa.nurse_id AND sl.shift_date = sa.shift_date
         )`,
      [missed_shift_hours],
    );

    // Locum-covered shifts — never get a shift_assignments row, resolved
    // straight from locum_requests (same split as auto-end-shifts.js).
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
         AND (${startTimeSql("lr")}) + ($1::numeric * INTERVAL '1 hour') <= NOW()
         AND NOT EXISTS (
           SELECT 1 FROM shift_logs sl WHERE sl.nurse_id = lr.accepted_by_nurse_id AND sl.shift_date = lr.shift_date
         )`,
      [missed_shift_hours],
    );

    let sentCount = 0;
    for (const row of [...regular, ...locum]) {
      if (!row.email) continue;
      const notifKey = `shift_reminder_missed_${row.nurse_id}_${row.shift_date}_${row.shift}`;
      // ON CONFLICT DO NOTHING + no row returned = this alert already went out
      // for this exact shift — fire once, not on every 5-minute tick for the
      // rest of the shift.
      const { rowCount } = await pool
        .query(
          `INSERT INTO notification_state (user_id, notif_key, is_read)
           VALUES ($1, $2, false)
           ON CONFLICT (user_id, notif_key) DO NOTHING`,
          [row.profile_id, notifKey],
        )
        .catch(() => ({ rowCount: 0 }));
      if (rowCount === 0) continue;

      const label = SHIFT_LABELS[row.shift] ?? row.shift;
      sendMail({
        to: row.email,
        subject: `You haven't started your ${label} shift`,
        title: "Shift not started",
        bodyHtml: `<p>Hi ${row.name ?? "there"},</p><p>Your <strong>${label}</strong> shift${row.ward ? ` at <strong>${row.ward}</strong>` : ""} on ${fmtShiftDate(row.shift_date)} was due to start over ${missed_shift_hours} hour(s) ago, and we don't have a record of you signing in yet.</p><p>If you're on site, please start your shift in the portal now. If you're unable to make this shift, contact your supervisor as soon as possible.</p>`,
        ctaText: "Open Shift Page",
        ctaUrl: portalUrl("/shift"),
      }).catch(() => {});
      sentCount++;
    }

    if (sentCount > 0) {
      console.log(`[shift-missed-reminder] ${new Date().toISOString()} — sent ${sentCount} alert(s)`);
      await pool
        .query(`INSERT INTO audit_logs (actor_name, action, target) VALUES ('system', $1, $2)`, [
          "Shift missed reminders sent",
          `${sentCount} alert(s)`,
        ])
        .catch((err) => console.error("[shift-missed-reminder] audit log failed:", err.message));
    }
  } catch (err) {
    console.error("[shift-missed-reminder] Error:", err.message);
  }
}

function startShiftMissedReminderJob() {
  sendMissedReminderEmails();
  cron.schedule("*/5 * * * *", sendMissedReminderEmails);
  console.log("[shift-missed-reminder] Shift missed reminder job started (runs every 5 minutes)");
}

module.exports = { startShiftMissedReminderJob };
