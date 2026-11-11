// Removing a staff member from the rota partway through a month, and bringing
// them back. Callers own authorization; these run in one transaction.

const { withAssignmentShiftDefinitions } = require("./assignment-shift-definition");
const { zonedInstant, addDays } = require("./configured-scheduler");

class RemovalError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.code = "REMOVAL_INVALID";
  }
}
const validDate = (d) =>
  typeof d === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(d) &&
  new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

/**
 * Remove a staff member from the rota after `lastDay` (their last working day):
 * - their shifts after that day are deleted, whatever their status;
 * - their pending leave and switch requests running past it expire, including
 *   switches where they are the partner, and their open bank shift invites close;
 * - the record becomes inactive with `left_on`, so new rotas leave them out while
 *   the days they worked stay on the rota and in hours;
 * - optionally their login ends when their last shift ends (straight away if
 *   that has passed), so they can still sign in to work it.
 * `lastDay` must fall in the current rota period (Lagos date).
 */
async function removeFromRota(db, { nurseId, lastDay, deactivateLogin = false, actor }) {
  if (!validDate(lastDay)) throw new RemovalError(400, "Choose a valid last working day");
  const {
    rows: [nurse],
  } = await db.query(
    "SELECT id, name, profile_id, is_active, facility FROM nurses WHERE id = $1 FOR UPDATE",
    [nurseId],
  );
  if (!nurse) throw new RemovalError(404, "Staff member not found");
  if (!nurse.is_active) throw new RemovalError(409, `${nurse.name} is already off the rota`);
  const {
    rows: [period],
  } = await db.query(
    `SELECT rota_period_start(d)::text AS start, rota_period_end(d)::text AS end
     FROM (SELECT (now() AT TIME ZONE 'Africa/Lagos')::date AS d) t`,
  );
  if (lastDay < period.start || lastDay > period.end)
    throw new RemovalError(
      422,
      "The last working day must fall in the current rota month. For a later date, do this nearer the time.",
    );
  const { rowCount: shiftsCleared } = await db.query(
    "DELETE FROM shift_assignments WHERE nurse_id = $1 AND shift_date > $2",
    [nurseId, lastDay],
  );
  const note = `Automatically expired — ${nurse.name} left the rota after ${lastDay}.`;
  const { rowCount: requestsExpired } = await db.query(
    `UPDATE leave_requests
        SET status = 'Expired', reviewed_at = NOW(), review_note = $3
      WHERE status = 'Pending' AND to_date > $2
        AND (nurse_id = $1
             OR (type = 'Swap' AND (reason LIKE 'SHIFT_SWITCH|' || $1::text || '|%'
                 ${(await hasSwitchPartnerColumn(db)) ? "OR switch_nurse_b = $1" : ""})))`,
    [nurseId, lastDay, note],
  );
  const { rowCount: invitesClosed } = await db.query(
    `UPDATE locum_invites SET status = 'declined', decline_reason = 'Left the rota',
            responded_at = NOW()
      WHERE nurse_id = $1 AND status = 'pending'`,
    [nurseId],
  );
  await db.query(
    "UPDATE nurses SET is_active = false, left_on = $2, updated_at = NOW() WHERE id = $1",
    [nurseId, lastDay],
  );
  let loginEndsAt = null;
  if (deactivateLogin && nurse.profile_id) {
    loginEndsAt = await lastShiftEnd(db, nurseId, lastDay);
    if (Date.parse(loginEndsAt) <= Date.now()) {
      loginEndsAt = null;
      await db.query(
        "UPDATE profiles SET is_active = false, login_ends_at = NULL, updated_at = NOW() WHERE id = $1",
        [nurse.profile_id],
      );
    } else
      await db.query("UPDATE profiles SET login_ends_at = $2, updated_at = NOW() WHERE id = $1", [
        nurse.profile_id,
        loginEndsAt,
      ]);
  }
  await db.query(
    "INSERT INTO audit_logs (action, actor_id, actor_name, target) VALUES ($1, $2, $3, $4)",
    [
      "Removed staff from rota",
      actor?.id ?? null,
      actor?.name ?? null,
      `${nurse.name} · last working day ${lastDay} · ${shiftsCleared} shift(s) cleared, ${requestsExpired} request(s) expired${
        !deactivateLogin || !nurse.profile_id
          ? ""
          : loginEndsAt
            ? ` · login ends ${new Date(loginEndsAt).toLocaleString("en-GB", {
                timeZone: "Africa/Lagos",
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}`
            : " · login deactivated"
      }`,
    ],
  );
  return { name: nurse.name, shiftsCleared, requestsExpired, invitesClosed, loginEndsAt };
}

// When the staff member's last shift ends: the end of their duty on the last
// working day (next morning for a night), or midnight after that day when they
// are off or on leave.
async function lastShiftEnd(db, nurseId, lastDay) {
  const endOfDay = zonedInstant(addDays(lastDay, 1), "00:00", "Africa/Lagos");
  const { rows } = await db.query(
    "SELECT *, shift_date::text FROM shift_assignments WHERE nurse_id = $1 AND shift_date = $2",
    [nurseId, lastDay],
  );
  if (!rows[0] || ["OFF", "LEAVE"].includes(rows[0].shift)) return endOfDay;
  const [cell] = await withAssignmentShiftDefinitions(db, rows);
  const ends = cell.scheduled_shift?.endsAt;
  return ends && ends > endOfDay ? ends : endOfDay;
}

let partnerColumn = null;
async function hasSwitchPartnerColumn(db) {
  if (partnerColumn === null)
    partnerColumn =
      (
        await db.query(
          "SELECT 1 FROM information_schema.columns WHERE table_name = 'leave_requests' AND column_name = 'switch_nurse_b'",
        )
      ).rowCount > 0;
  return partnerColumn;
}

/** Put a removed staff member back on the rota (and reactivate their login if asked). */
async function returnToRota(db, { nurseId, reactivateLogin = false, actor }) {
  const {
    rows: [nurse],
  } = await db.query(
    `UPDATE nurses SET is_active = true, left_on = NULL, updated_at = NOW()
      WHERE id = $1 AND is_active = false RETURNING name, profile_id`,
    [nurseId],
  );
  if (!nurse) throw new RemovalError(404, "Staff member not found or already on the rota");
  // A login waiting to end after their last shift stays on.
  if (nurse.profile_id)
    await db.query(
      `UPDATE profiles SET login_ends_at = NULL,
              is_active = CASE WHEN $2 THEN true ELSE is_active END, updated_at = NOW()
        WHERE id = $1`,
      [nurse.profile_id, reactivateLogin],
    );
  await db.query(
    "INSERT INTO audit_logs (action, actor_id, actor_name, target) VALUES ($1, $2, $3, $4)",
    ["Returned staff to rota", actor?.id ?? null, actor?.name ?? null, nurse.name],
  );
  return { name: nurse.name };
}

module.exports = { removeFromRota, returnToRota, RemovalError };
