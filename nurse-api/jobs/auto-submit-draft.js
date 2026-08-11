// T-17 hard deadline: force-submits any rota unit still sitting in draft
// (whether or not the head_nurse manually submitted it), and closes out
// every live rota_edit_requests grant for that period — matching "even if
// the draft is reverted back, edit access does not return; must re-request."
const cron = require("node-cron");
const pool = require("../db");
const { getWindowForPeriod, getUnitPeriod } = require("../lib/rota-period-dates");
const {
  forceSubmitUnit,
  roleGroupOf,
  wasRevertedToDraft,
  resolveUnitNurseIds,
} = require("../lib/force-submit-rota");
const { sendMail, portalUrl } = require("../lib/mailer");
const { isRotaJobPaused } = require("../lib/rota-job-pause");

function fmtPeriodDate(d) {
  return d
    ? new Date(String(d).slice(0, 10) + "T00:00:00").toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "";
}

const EMAIL_COPY = {
  rota_autosubmitted: (facility, unitLabel, periodStart) => ({
    subject: `Rota auto-submitted for review — ${unitLabel}`,
    bodyHtml: `<p>The rota for <strong>${unitLabel}</strong> · ${facility} (period starting ${fmtPeriodDate(periodStart)}) reached the T-17 deadline still in draft and was automatically submitted for CNO review.</p>`,
    ctaPath: "/approvals",
  }),
  rota_autosubmit_blocked: (facility, unitLabel, periodStart) => ({
    subject: `Action needed: rota could not auto-submit — ${unitLabel}`,
    bodyHtml: `<p>The rota for <strong>${unitLabel}</strong> · ${facility} (period starting ${fmtPeriodDate(periodStart)}) hit the T-17 deadline but could not be auto-submitted — unresolved leave requests are still blocking it. Please review.</p>`,
    ctaPath: "/rota",
  }),
};

// Distinct from AUTO_GENERATE_LOCK_KEY (729315) — see jobs/auto-end-shifts.js
// for why the lock exists.
const AUTO_SUBMIT_LOCK_KEY = 729316;
const DRY_RUN = process.env.DRY_RUN_ROTA_JOBS === "true";

async function autoSubmitDraft(opts = {}) {
  if (await isRotaJobPaused("auto_submit")) return;
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
  // Every distinct (facility, ward|role_group) that currently has a draft
  // cell, regardless of date — each unit's own T-17 deadline is checked
  // individually below, since a unit can be at a different period than the
  // rest of the system (e.g. it fell behind after being reverted by HR while
  // other units already moved on).
  const { rows: units } = await pool.query(
    `SELECT DISTINCT n.facility, sa.ward, n.role
       FROM shift_assignments sa
       JOIN nurses n ON n.id = sa.nurse_id
      WHERE sa.status = 'draft'`,
  );

  const seen = new Set();
  for (const row of units) {
    const roleGroup = row.ward ? null : roleGroupOf(row.role);
    const unitKey = `${row.facility}|${row.ward ?? roleGroup ?? "unknown"}`;
    if (seen.has(unitKey)) continue;
    seen.add(unitKey);

    if (!row.ward && !roleGroup) continue; // unclassifiable role, skip defensively

    const nurseIds = await resolveUnitNurseIds({
      facility: row.facility,
      ward: row.ward,
      roleGroup,
    });
    const period = await getUnitPeriod(nurseIds, row.ward);
    if (!period) continue; // defensive — draft rows exist, so this shouldn't happen
    const window = await getWindowForPeriod(period.periodStart, { simulateToday });
    if (!window.editIsClosed) continue;

    // HR already reviewed this unit and explicitly sent it back to draft —
    // don't silently re-submit the same as-is draft on the very next tick.
    // It now waits for the head_nurse to request edit access, fix it, and
    // resubmit manually (see routes/rota-edit-requests.js's window exception).
    if (
      await wasRevertedToDraft({
        facility: row.facility,
        ward: row.ward,
        roleGroup,
        periodStart: period.periodStart,
      })
    ) {
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
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
    });

    const unitLabel = row.ward ?? roleGroup;
    if (result.submitted) {
      await pool
        .query(`INSERT INTO audit_logs (actor_name, action, target) VALUES ('system', $1, $2)`, [
          "Rota auto-submitted (T-17 deadline)",
          `${row.facility} · ${unitLabel} · ${period.periodStart} → ${period.periodEnd} (${result.count} cell(s))`,
        ])
        .catch(() => {});
      await notifyUnit(row.facility, "rota_autosubmitted", unitLabel, period.periodStart, [
        "head_nurse",
        "cno",
        "admin",
      ]);
    } else if (result.reason !== "NO_NURSES") {
      await notifyUnit(row.facility, "rota_autosubmit_blocked", unitLabel, period.periodStart, [
        "head_nurse",
        "cno",
        "admin",
      ]);
    }
  }

  // Close out every live edit-access grant whose OWN unit/period is past
  // T-17 — checked per-grant now rather than against one global period_start,
  // for the same reason as above. EXCEPT a unit HR just reverted to draft
  // after review: this job re-runs every 5 minutes and editIsClosed stays
  // true for the rest of that unit's period, so without this exclusion a
  // grant freshly approved for the post-revert re-request case (see
  // routes/rota-edit-requests.js) would get revoked again on the very next
  // tick.
  if (!DRY_RUN) {
    const { rows: liveGrants } = await pool.query(
      `SELECT id, status, facility, ward, role_group, period_start FROM rota_edit_requests
        WHERE status = 'Pending' OR (status = 'Approved' AND revoked_at IS NULL)`,
    );
    for (const grant of liveGrants) {
      const window = await getWindowForPeriod(grant.period_start, { simulateToday });
      if (!window.editIsClosed) continue;
      const reverted = await wasRevertedToDraft({
        facility: grant.facility,
        ward: grant.ward,
        roleGroup: grant.role_group,
        periodStart: grant.period_start,
      });
      if (reverted) continue;
      if (grant.status === "Pending") {
        // Never decided before the deadline — mark it Expired (not just
        // revoked) so it's unambiguous in the UI and can no longer be
        // approved/declined (PATCH /:id only matches status = 'Pending').
        // Access only returns once the draft is reverted and a fresh
        // request is raised — see routes/rota-edit-requests.js.
        await pool.query(
          `UPDATE rota_edit_requests
              SET status = 'Expired',
                  review_note = 'Auto-expired — the T-17 deadline passed before this request was decided.',
                  reviewed_at = NOW(), updated_at = NOW()
            WHERE id = $1`,
          [grant.id],
        );
      } else {
        await pool.query(
          `UPDATE rota_edit_requests
              SET revoked_at = NOW(), revoke_reason = 'auto_closed_t17', updated_at = NOW()
            WHERE id = $1`,
          [grant.id],
        );
      }
    }
  }
}

async function notifyUnit(facility, prefix, unitLabel, periodStart, roles) {
  const facilitySlug = facility.toLowerCase().replace(/\s+/g, "_");
  const unitSlug = String(unitLabel).toLowerCase().replace(/\s+/g, "_");
  // "|" separates facility/unit/period so the bell can parse them back out
  // unambiguously (a plain "_" join can't be split reliably — facility and
  // ward names can themselves contain "_").
  const notifKey = `${prefix}_${facilitySlug}|${unitSlug}|${periodStart}`;
  const { rows } = await pool.query(
    `SELECT DISTINCT p.id, p.email FROM profiles p
       JOIN user_roles ur ON ur.user_id = p.id
      WHERE ur.role = ANY($1) AND p.is_active = true`,
    [roles],
  );
  const copy = EMAIL_COPY[prefix]?.(facility, unitLabel, periodStart);
  for (const { id, email } of rows) {
    // This job re-checks every blocked/still-draft unit on every 5-minute
    // tick for as long as it stays blocked, calling notifyUnit() again each
    // time — so the bell entry is meant to keep re-surfacing as unread, but
    // email must NOT go out again on every tick (that's a fresh email every
    // 5 minutes for however long the block lasts). `xmax = 0` is Postgres's
    // way of reporting whether this row was just INSERTed vs already existed
    // and only got UPDATEd by the ON CONFLICT branch — email only fires the
    // first time this exact notif_key is seen.
    const { rows: upserted } = await pool
      .query(
        `INSERT INTO notification_state (user_id, notif_key, is_read)
         VALUES ($1, $2, false)
         ON CONFLICT (user_id, notif_key) DO UPDATE SET is_read = false, updated_at = NOW()
         RETURNING (xmax = 0) AS is_new`,
        [id, notifKey],
      )
      .catch(() => ({ rows: [{ is_new: false }] }));

    if (copy && upserted[0]?.is_new) {
      sendMail({
        to: email,
        subject: copy.subject,
        title: copy.subject,
        bodyHtml: copy.bodyHtml,
        ctaText: copy.ctaPath === "/approvals" ? "Open Approvals" : "Open Rota",
        ctaUrl: portalUrl(copy.ctaPath),
      }).catch(() => {});
    }
  }
}

function startAutoSubmitJob() {
  autoSubmitDraft();
  cron.schedule("*/5 * * * *", () => autoSubmitDraft());
  console.log("[auto-submit-draft] Auto-submit draft job started (runs every 5 minutes)");
}

module.exports = { startAutoSubmitJob, runAutoSubmit };
