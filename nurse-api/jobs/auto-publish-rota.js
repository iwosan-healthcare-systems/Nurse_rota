// T-14 deadline: auto-publishes any rota unit that's reached hr_approved.
// A unit still stuck in draft/submitted (HR never got to it) is NOT
// published — instead this is treated as an exception and hr_admin/cno/admin
// are alerted so a human resolves it, per the explicit requirement that this
// system never silently publishes an unapproved rota.
const cron = require("node-cron");
const pool = require("../db");
const { getWindowForPeriod, getUnitPeriod } = require("../lib/rota-period-dates");
const { roleGroupOf, resolveUnitNurseIds } = require("../lib/force-submit-rota");
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
  rota_autopublished: (facility, unitLabel, periodStart) => ({
    subject: `Rota published — ${unitLabel}`,
    bodyHtml: `<p>The rota for <strong>${unitLabel}</strong> · ${facility} (period starting ${fmtPeriodDate(periodStart)}) has been published automatically at the T-14 deadline.</p>`,
    ctaPath: "/rota",
  }),
  rota_publish_deadline_missed: (facility, unitLabel, periodStart) => ({
    subject: `Action needed: rota not published — ${unitLabel}`,
    bodyHtml: `<p>The rota for <strong>${unitLabel}</strong> · ${facility} (period starting ${fmtPeriodDate(periodStart)}) hit the T-14 publish deadline still without CNO approval, so it was <strong>not</strong> published automatically. Please review and resolve.</p>`,
    ctaPath: "/approvals",
  }),
};

// Distinct from AUTO_SUBMIT_LOCK_KEY (729316) — see jobs/auto-end-shifts.js
// for why the lock exists.
const AUTO_PUBLISH_LOCK_KEY = 729317;
const DRY_RUN = process.env.DRY_RUN_ROTA_JOBS === "true";

async function autoPublishRota(opts = {}) {
  if (await isRotaJobPaused("auto_publish")) return;
  const lockClient = await pool.connect();
  try {
    const { rows } = await lockClient.query("SELECT pg_try_advisory_lock($1) AS locked", [
      AUTO_PUBLISH_LOCK_KEY,
    ]);
    if (!rows[0].locked) return;
    await runAutoPublish(opts);
  } catch (err) {
    console.error("[auto-publish-rota] Error:", err.message);
  } finally {
    await lockClient
      .query("SELECT pg_advisory_unlock($1)", [AUTO_PUBLISH_LOCK_KEY])
      .catch(() => {});
    lockClient.release();
  }
}

async function runAutoPublish({ simulateToday } = {}) {
  // Publish every hr_approved unit whose OWN T-14 deadline has passed —
  // checked per-unit rather than against one global period, since a unit can
  // be at a different period than the rest of the system (e.g. it fell
  // behind after being reverted by HR while other units already moved on).
  const { rows: approvedUnits } = await pool.query(
    `SELECT DISTINCT n.facility, sa.ward, n.role
       FROM shift_assignments sa
       JOIN nurses n ON n.id = sa.nurse_id
      WHERE sa.status = 'hr_approved'`,
  );
  const seenApproved = new Set();
  for (const row of approvedUnits) {
    const roleGroup = row.ward ? null : roleGroupOf(row.role);
    const unitKey = `${row.facility}|${row.ward ?? roleGroup ?? "unknown"}`;
    if (seenApproved.has(unitKey)) continue;
    seenApproved.add(unitKey);
    if (!row.ward && !roleGroup) continue;
    const unitLabel = row.ward ?? roleGroup;

    const nurseIds = await resolveUnitNurseIds({
      facility: row.facility,
      ward: row.ward,
      roleGroup,
    });
    const period = await getUnitPeriod(nurseIds, row.ward);
    if (!period) continue; // defensive — hr_approved rows exist, so this shouldn't happen
    const window = await getWindowForPeriod(period.periodStart, { simulateToday });
    if (!window.publishIsOverdue) continue;

    if (DRY_RUN) {
      console.log(`[DRY-RUN][auto-publish-rota] would publish ${unitKey}`);
      continue;
    }

    const wardClause = row.ward ? "AND sa.ward = $4" : "AND sa.ward IS NULL";
    const params = row.ward
      ? [nurseIds, period.periodStart, period.periodEnd, row.ward]
      : [nurseIds, period.periodStart, period.periodEnd];

    const { rowCount } = await pool.query(
      `UPDATE shift_assignments sa
          SET status = 'published', updated_at = NOW()
        WHERE sa.nurse_id = ANY($1) AND sa.shift_date BETWEEN $2 AND $3
          AND sa.status = 'hr_approved' ${wardClause}`,
      params,
    );

    // Same reasoning as the manual-publish path in routes/shift-assignments.js:
    // publishing spends any open edit-access grant for this unit — a fresh
    // request is always required for anything that comes up post-publish.
    await pool
      .query(
        `UPDATE rota_edit_requests
            SET revoked_at = NOW()
          WHERE facility = $1
            AND status = 'Approved' AND revoked_at IS NULL
            AND (($2::text IS NOT NULL AND ward = $2) OR ($2::text IS NULL AND ward IS NULL AND role_group = $3))
            AND period_start <= $5 AND period_end >= $4`,
        [row.facility, row.ward || null, roleGroup, period.periodStart, period.periodEnd],
      )
      .catch(() => {});

    await pool
      .query(`INSERT INTO audit_logs (actor_name, action, target) VALUES ('system', $1, $2)`, [
        "Rota auto-published (T-14 deadline)",
        `${row.facility} · ${unitLabel} · ${period.periodStart} → ${period.periodEnd} (${rowCount} cell(s))`,
      ])
      .catch(() => {});

    if (roleGroup === "intern") await rotateInterns(row.facility);

    await notifyUnit(row.facility, "rota_autopublished", unitLabel, period.periodStart, [
      "head_nurse",
      "cno",
      "admin",
    ]);

    // Publishing is the one event every staff nurse in the unit cares about,
    // not just managers — everyone whose schedule just went live gets their
    // own copy, same as the manual-publish path in routes/shift-assignments.js.
    const { rows: staffEmails } = await pool.query(
      `SELECT DISTINCT COALESCE(
         (SELECT p.email FROM profiles p WHERE p.id = n.profile_id),
         (SELECT p.email FROM profiles p WHERE LOWER(p.full_name) = LOWER(n.name) LIMIT 1)
       ) AS email
       FROM nurses n WHERE n.id = ANY($1)`,
      [nurseIds],
    );
    for (const { email } of staffEmails) {
      if (!email) continue;
      sendMail({
        to: email,
        subject: `Your rota is published — ${unitLabel}`,
        title: "Your rota is published",
        bodyHtml: `<p>The rota for <strong>${unitLabel}</strong> · ${row.facility} (period starting ${fmtPeriodDate(period.periodStart)}) has been published automatically at the T-14 deadline. You can view your schedule now.</p>`,
        ctaText: "View My Rota",
        ctaUrl: portalUrl("/rota"),
      }).catch(() => {});
    }
  }

  // Exception path: units still stuck in draft/submitted whose OWN T-14
  // deadline has passed — never publish these; alert humans instead.
  const { rows: stuckUnits } = await pool.query(
    `SELECT DISTINCT n.facility, sa.ward, n.role
       FROM shift_assignments sa
       JOIN nurses n ON n.id = sa.nurse_id
      WHERE sa.status IN ('draft', 'submitted')`,
  );
  const seenStuck = new Set();
  for (const row of stuckUnits) {
    const roleGroup = row.ward ? null : roleGroupOf(row.role);
    const unitKey = `${row.facility}|${row.ward ?? roleGroup ?? "unknown"}`;
    if (seenStuck.has(unitKey) || seenApproved.has(unitKey)) continue;
    seenStuck.add(unitKey);
    if (!row.ward && !roleGroup) continue;
    const unitLabel = row.ward ?? roleGroup;

    const nurseIds = await resolveUnitNurseIds({
      facility: row.facility,
      ward: row.ward,
      roleGroup,
    });
    const period = await getUnitPeriod(nurseIds, row.ward);
    if (!period) continue; // defensive — draft/submitted rows exist, so this shouldn't happen
    const window = await getWindowForPeriod(period.periodStart, { simulateToday });
    if (!window.publishIsOverdue) continue;

    if (DRY_RUN) {
      console.log(
        `[DRY-RUN][auto-publish-rota] would NOT publish ${row.facility}/${unitLabel} — CNO approval missing, would alert`,
      );
      continue;
    }
    await pool
      .query(`INSERT INTO audit_logs (actor_name, action, target) VALUES ('system', $1, $2)`, [
        "Rota NOT auto-published — CNO approval missing at T-14 deadline",
        `${row.facility} · ${unitLabel} · ${period.periodStart} → ${period.periodEnd}`,
      ])
      .catch(() => {});
    await notifyUnit(row.facility, "rota_publish_deadline_missed", unitLabel, period.periodStart, [
      "cno",
      "admin",
    ]);
  }
}

// Mirrors POST /nurses/rotate-interns (routes/nurses.js) — rotates every
// intern in the facility to their next ward in alphabetical order, run here
// as the server-side equivalent of the side effect approvals.tsx's advance()
// triggers on a manual publish, since auto-publish has no req to call that
// route through.
async function rotateInterns(facility) {
  const { rows: wardRows } = await pool.query(
    "SELECT name FROM wards WHERE facility = $1 ORDER BY name",
    [facility],
  );
  const wardNames = wardRows.map((r) => r.name);
  if (!wardNames.length) return;

  const { rows: interns } = await pool.query(
    `SELECT id, ward FROM nurses
      WHERE facility = $1 AND role ~* '^(nurse\\s+intern|intern\\s+nurse|nursing\\s+intern)$'
      ORDER BY id`,
    [facility],
  );
  if (!interns.length) return;

  for (const intern of interns) {
    const currentWard = intern.ward ? intern.ward.split("|")[0] : null;
    const idx = wardNames.indexOf(currentWard);
    const nextWard =
      currentWard === null
        ? wardNames[0]
        : wardNames[(idx === -1 ? 0 : idx + 1) % wardNames.length];
    if (nextWard !== intern.ward) {
      await pool
        .query("UPDATE nurses SET ward = $1, updated_at = NOW() WHERE id = $2", [
          nextWard,
          intern.id,
        ])
        .catch(() => {});
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
    // This job re-checks every stuck unit on every 5-minute tick for as long
    // as it stays unresolved, calling notifyUnit() again each time — the
    // bell entry is meant to keep re-surfacing as unread, but email must NOT
    // go out again on every tick. `xmax = 0` reports whether this row was
    // just INSERTed vs already existed and only got touched by the ON
    // CONFLICT branch — email only fires the first time this notif_key is seen.
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

function startAutoPublishJob() {
  autoPublishRota();
  cron.schedule("*/5 * * * *", () => autoPublishRota());
  console.log("[auto-publish-rota] Auto-publish rota job started (runs every 5 minutes)");
}

module.exports = { startAutoPublishJob, runAutoPublish };
