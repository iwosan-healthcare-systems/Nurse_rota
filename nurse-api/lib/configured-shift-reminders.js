const { withAssignmentShiftDefinitions } = require("./assignment-shift-definition");

// Configured shifts last at most one calendar-day boundary. The date margin
// includes overnight shifts and all supported timezone offsets.
async function configuredShiftReminders(db, kind, threshold, now = new Date()) {
  if (!["start", "missed"].includes(kind)) throw new Error("Unknown reminder kind");
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error("Invalid reminder threshold");
  const windowMinutes = kind === "start" ? threshold : 0;
  const { rows } = await db.query(
    `SELECT sa.*,sa.shift_date::text,n.name,p.id AS profile_id,p.email
     FROM shift_assignments sa
     JOIN nurses n ON n.id=sa.nurse_id
     JOIN profiles p ON p.id=COALESCE(n.profile_id,
       (SELECT id FROM profiles WHERE LOWER(full_name)=LOWER(n.name) LIMIT 1))
     WHERE sa.status='published' AND sa.shift NOT IN ('OFF','LEAVE')
       AND COALESCE(sa.shift_definition_run_id,sa.scheduling_run_id) IS NOT NULL
       AND sa.shift_date BETWEEN ($1::timestamptz AT TIME ZONE 'UTC')::date - 2
         AND (($1::timestamptz + $2::numeric * INTERVAL '1 minute') AT TIME ZONE 'UTC')::date + 2
       AND NOT EXISTS (SELECT 1 FROM shift_logs sl
         WHERE sl.nurse_id=sa.nurse_id AND sl.shift_date=sa.shift_date)`,
    [now.toISOString(), windowMinutes],
  );
  const resolved = await withAssignmentShiftDefinitions(db, rows);
  const due = [],
    errors = [];
  for (const row of resolved) {
    if (row.shift_definition_error || !row.scheduled_shift) {
      errors.push({
        assignmentId: row.id,
        error: row.shift_definition_error ?? "Missing shift definition",
      });
      continue;
    }
    const start = Date.parse(row.scheduled_shift.startsAt);
    const end = Date.parse(row.scheduled_shift.endsAt);
    const instant = now.getTime();
    const isDue =
      kind === "start"
        ? start > instant && start <= instant + threshold * 60000
        : start + threshold * 3600000 <= instant && instant < end;
    if (isDue) due.push(row);
  }
  return { rows: due, errors };
}

function escapeReminderHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

module.exports = { configuredShiftReminders, escapeReminderHtml };
