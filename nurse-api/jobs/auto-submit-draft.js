// T-17 hard deadline: force-submits any rota unit still sitting in draft
// (whether or not the head_nurse manually submitted it), and closes out
// every live rota_edit_requests grant for that period — matching "even if
// the draft is reverted back, edit access does not return; must re-request."
const cron = require("node-cron");
const pool = require("../db");
const { getNextPeriodDates } = require("../lib/rota-period-dates");
const { forceSubmitUnit, roleGroupOf, wasRevertedToDraft } = require("../lib/force-submit-rota");

// Distinct from AUTO_GENERATE_LOCK_KEY (729315) — see jobs/auto-end-shifts.js
// for why the lock exists.
const AUTO_SUBMIT_LOCK_KEY = 729316;
const DAYS = 28;
const DRY_RUN = process.env.DRY_RUN_ROTA_JOBS === "true";

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return ymd(d);
}

async function autoSubmitDraft(opts = {}) {
  const lockClient = await pool.connect();
  try {
    const { rows } = await lockClient.query("SELECT pg_try_advisory_lock($1) AS locked", [
      AUTO_SUBMIT_LOCK_KEY,
    ]);
    if (!rows[0].locked) return;
    await runAutoSubmit(opts);
  } catch (err) {
    console.error("[auto-submit-draft] Error:", err.message);
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [AUTO_SUBMIT_LOCK_KEY]).catch(() => {});
    lockClient.release();
  }
}

async function runAutoSubmit({ simulateToday } = {}) {
  const dates = await getNextPeriodDates({ simulateToday });
  if (!dates || !dates.editIsClosed) return;

  const periodStart = dates.nextPeriodStart;
  const periodEnd = addDays(periodStart, DAYS - 1);

  // Every distinct (facility, ward|role_group) that still has a draft cell
  // in this period.
  const { rows: units } = await pool.query(
    `SELECT DISTINCT n.facility, sa.ward, n.role
       FROM shift_assignments sa
       JOIN nurses n ON n.id = sa.nurse_id
      WHERE sa.status = 'draft' AND sa.shift_date BETWEEN $1 AND $2`,
    [periodStart, periodEnd],
  );

  const seen = new Set();
  for (const row of units) {
    const roleGroup = row.ward ? null : roleGroupOf(row.role);
    const unitKey = `${row.facility}|${row.ward ?? roleGroup ?? "unknown"}`;
    if (seen.has(unitKey)) continue;
    seen.add(unitKey);

    if (!row.ward && !roleGroup) continue; // unclassifiable role, skip defensively

    // HR already reviewed this unit and explicitly sent it back to draft —
    // don't silently re-submit the same as-is draft on the very next tick.
    // It now waits for the head_nurse to request edit access, fix it, and
    // resubmit manually (see routes/rota-edit-requests.js's window exception).
    if (await wasRevertedToDraft({ facility: row.facility, ward: row.ward, roleGroup, periodStart })) {
      continue;
    }

    if (DRY_RUN) {
      console.log(`[DRY-RUN][auto-submit-draft] would force-submit ${unitKey}`);
      continue;
    }

    const result = await forceSubmitUnit({
      facility: row.facility,
      ward: row.ward,
      roleGroup,
      periodStart,
      periodEnd,
    });

    const unitLabel = row.ward ?? roleGroup;
    if (result.submitted) {
      await pool
        .query(`INSERT INTO audit_logs (actor_name, action, target) VALUES ('system', $1, $2)`, [
          "Rota auto-submitted (T-17 deadline)",
          `${row.facility} · ${unitLabel} · ${periodStart} → ${periodEnd} (${result.count} cell(s))`,
        ])
        .catch(() => {});
      await notifyUnit(row.facility, "rota_autosubmitted", unitLabel, periodStart, [
        "head_nurse",
        "hr_admin",
        "admin",
      ]);
    } else if (result.reason !== "NO_NURSES") {
      await notifyUnit(row.facility, "rota_autosubmit_blocked", unitLabel, periodStart, [
        "head_nurse",
        "hr_admin",
        "admin",
      ]);
    }
  }

  // Close out every live edit-access grant for this period, regardless of
  // whether its unit had a draft cell (a request could be Pending with no
  // draft rows left, e.g. everything was already deleted/regenerated) —
  // EXCEPT a unit HR just reverted to draft after review. This job re-runs
  // every 5 minutes and editIsClosed stays true for the rest of the period,
  // so without this exclusion a grant freshly approved for the post-revert
  // re-request case (see routes/rota-edit-requests.js) would get revoked
  // again on the very next tick.
  if (!DRY_RUN) {
    const { rows: liveGrants } = await pool.query(
      `SELECT id, facility, ward, role_group FROM rota_edit_requests
        WHERE period_start = $1
          AND (status = 'Pending' OR (status = 'Approved' AND revoked_at IS NULL))`,
      [periodStart],
    );
    for (const grant of liveGrants) {
      const reverted = await wasRevertedToDraft({
        facility: grant.facility,
        ward: grant.ward,
        roleGroup: grant.role_group,
        periodStart,
      });
      if (reverted) continue;
      await pool.query(
        `UPDATE rota_edit_requests
            SET revoked_at = NOW(), revoke_reason = 'auto_closed_t17', updated_at = NOW()
          WHERE id = $1`,
        [grant.id],
      );
    }
  }
}

async function notifyUnit(facility, prefix, unitLabel, periodStart, roles) {
  const facilitySlug = facility.toLowerCase().replace(/\s+/g, "_");
  const unitSlug = String(unitLabel).toLowerCase().replace(/\s+/g, "_");
  const notifKey = `${prefix}_${facilitySlug}_${unitSlug}_${periodStart}`;
  const { rows } = await pool.query(
    `SELECT DISTINCT p.id FROM profiles p
       JOIN user_roles ur ON ur.user_id = p.id
      WHERE ur.role = ANY($1) AND p.is_active = true`,
    [roles],
  );
  for (const { id } of rows) {
    await pool
      .query(
        `INSERT INTO notification_state (user_id, notif_key, is_read)
         VALUES ($1, $2, false)
         ON CONFLICT (user_id, notif_key) DO UPDATE SET is_read = false, updated_at = NOW()`,
        [id, notifKey],
      )
      .catch(() => {});
  }
}

function startAutoSubmitJob() {
  autoSubmitDraft();
  cron.schedule("*/5 * * * *", () => autoSubmitDraft());
  console.log("[auto-submit-draft] Auto-submit draft job started (runs every 5 minutes)");
}

module.exports = { startAutoSubmitJob, runAutoSubmit };
