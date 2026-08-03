// T-14 deadline: auto-publishes any rota unit that's reached hr_approved.
// A unit still stuck in draft/submitted (HR never got to it) is NOT
// published — instead this is treated as an exception and hr_admin/cno/admin
// are alerted so a human resolves it, per the explicit requirement that this
// system never silently publishes an unapproved rota.
const cron = require("node-cron");
const pool = require("../db");
const { getNextPeriodDates } = require("../lib/rota-period-dates");
const { roleGroupOf } = require("../lib/force-submit-rota");

// Distinct from AUTO_SUBMIT_LOCK_KEY (729316) — see jobs/auto-end-shifts.js
// for why the lock exists.
const AUTO_PUBLISH_LOCK_KEY = 729317;
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

async function autoPublishRota(opts = {}) {
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
    await lockClient.query("SELECT pg_advisory_unlock($1)", [AUTO_PUBLISH_LOCK_KEY]).catch(() => {});
    lockClient.release();
  }
}

// Groups nurses in a facility by ward or facility-wide role_group — same
// units the other two rota jobs operate on.
async function scopeUnitNurseIds(facility, ward, roleGroup) {
  const { rows } = await pool.query("SELECT id, role FROM nurses WHERE facility = $1", [facility]);
  return ward ? rows.map((n) => n.id) : rows.filter((n) => roleGroupOf(n.role) === roleGroup).map((n) => n.id);
}

async function runAutoPublish({ simulateToday } = {}) {
  const dates = await getNextPeriodDates({ simulateToday });
  if (!dates || !dates.publishIsOverdue) return;

  const periodStart = dates.nextPeriodStart;
  const periodEnd = addDays(periodStart, DAYS - 1);

  // Publish every hr_approved unit.
  const { rows: approvedUnits } = await pool.query(
    `SELECT DISTINCT n.facility, sa.ward, n.role
       FROM shift_assignments sa
       JOIN nurses n ON n.id = sa.nurse_id
      WHERE sa.status = 'hr_approved' AND sa.shift_date BETWEEN $1 AND $2`,
    [periodStart, periodEnd],
  );
  const seenApproved = new Set();
  for (const row of approvedUnits) {
    const roleGroup = row.ward ? null : roleGroupOf(row.role);
    const unitKey = `${row.facility}|${row.ward ?? roleGroup ?? "unknown"}`;
    if (seenApproved.has(unitKey)) continue;
    seenApproved.add(unitKey);
    if (!row.ward && !roleGroup) continue;
    const unitLabel = row.ward ?? roleGroup;

    if (DRY_RUN) {
      console.log(`[DRY-RUN][auto-publish-rota] would publish ${unitKey}`);
      continue;
    }

    const nurseIds = await scopeUnitNurseIds(row.facility, row.ward, roleGroup);
    const wardClause = row.ward ? "AND sa.ward = $4" : "AND sa.ward IS NULL";
    const params = row.ward
      ? [nurseIds, periodStart, periodEnd, row.ward]
      : [nurseIds, periodStart, periodEnd];

    const { rowCount } = await pool.query(
      `UPDATE shift_assignments sa
          SET status = 'published', updated_at = NOW()
        WHERE sa.nurse_id = ANY($1) AND sa.shift_date BETWEEN $2 AND $3
          AND sa.status = 'hr_approved' ${wardClause}`,
      params,
    );

    await pool
      .query(`INSERT INTO audit_logs (actor_name, action, target) VALUES ('system', $1, $2)`, [
        "Rota auto-published (T-14 deadline)",
        `${row.facility} · ${unitLabel} · ${periodStart} → ${periodEnd} (${rowCount} cell(s))`,
      ])
      .catch(() => {});

    if (roleGroup === "intern") await rotateInterns(row.facility);

    await notifyUnit(row.facility, "rota_autopublished", unitLabel, periodStart, [
      "head_nurse",
      "hr_admin",
      "cno",
      "admin",
    ]);
  }

  // Exception path: units still stuck in draft/submitted at the deadline —
  // never publish these; alert humans instead.
  const { rows: stuckUnits } = await pool.query(
    `SELECT DISTINCT n.facility, sa.ward, n.role
       FROM shift_assignments sa
       JOIN nurses n ON n.id = sa.nurse_id
      WHERE sa.status IN ('draft', 'submitted') AND sa.shift_date BETWEEN $1 AND $2`,
    [periodStart, periodEnd],
  );
  const seenStuck = new Set();
  for (const row of stuckUnits) {
    const roleGroup = row.ward ? null : roleGroupOf(row.role);
    const unitKey = `${row.facility}|${row.ward ?? roleGroup ?? "unknown"}`;
    if (seenStuck.has(unitKey) || seenApproved.has(unitKey)) continue;
    seenStuck.add(unitKey);
    if (!row.ward && !roleGroup) continue;
    const unitLabel = row.ward ?? roleGroup;

    if (DRY_RUN) {
      console.log(
        `[DRY-RUN][auto-publish-rota] would NOT publish ${row.facility}/${unitLabel} — HR approval missing, would alert`,
      );
      continue;
    }
    await pool
      .query(`INSERT INTO audit_logs (actor_name, action, target) VALUES ('system', $1, $2)`, [
        "Rota NOT auto-published — HR approval missing at T-14 deadline",
        `${row.facility} · ${unitLabel} · ${periodStart} → ${periodEnd}`,
      ])
      .catch(() => {});
    await notifyUnit(row.facility, "rota_publish_deadline_missed", unitLabel, periodStart, [
      "hr_admin",
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
  const { rows: wardRows } = await pool.query("SELECT name FROM wards WHERE facility = $1 ORDER BY name", [
    facility,
  ]);
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
    const nextWard = currentWard === null ? wardNames[0] : wardNames[(idx === -1 ? 0 : idx + 1) % wardNames.length];
    if (nextWard !== intern.ward) {
      await pool
        .query("UPDATE nurses SET ward = $1, updated_at = NOW() WHERE id = $2", [nextWard, intern.id])
        .catch(() => {});
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

function startAutoPublishJob() {
  autoPublishRota();
  cron.schedule("*/5 * * * *", () => autoPublishRota());
  console.log("[auto-publish-rota] Auto-publish rota job started (runs every 5 minutes)");
}

module.exports = { startAutoPublishJob, runAutoPublish };
