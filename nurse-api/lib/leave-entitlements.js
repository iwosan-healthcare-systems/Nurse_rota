const pool = require("../db");
const {
  isMatron,
  isGlobalHead,
  isSurgicalNurseType,
  isSurgicalNurseDayType,
  isNAType,
  isPorterType,
  isInternType,
} = require("./auto-schedule.generated.js");

// Role-level entitlement overrides apply to a GROUP of job-role strings, not
// one literal role — so setting "Surgical Nurse" once covers both "Surgical
// Nurse" and "Surgical Nurse - Day", the same way the scheduling engine
// already treats Day/non-Day variants as one pool for other purposes.
// Reuses auto-schedule.generated.js's own role classifiers directly (rather
// than re-deriving equivalent regexes here) so the two stay in permanent
// agreement about what counts as "the same role family". `key` is what's
// stored in leave_entitlement_overrides.role; `label` is what the frontend
// shows. Falls through to "nurse" (plain ward nurse) when nothing else matches.
const ROLE_GROUPS = [
  { key: "matron", label: "Matron", test: isMatron },
  {
    key: "coverage_nurse",
    label: "Coverage Nurse (Head Nurse) (Day & Normal)",
    test: isGlobalHead,
  },
  {
    key: "surgical_nurse",
    label: "Surgical Nurse (Day & Normal)",
    test: (r) => isSurgicalNurseType(r) || isSurgicalNurseDayType(r),
  },
  { key: "nursing_assistant", label: "Nursing Assistant (Day & Normal)", test: isNAType },
  { key: "porter", label: "Porter (Day & Normal)", test: isPorterType },
  { key: "nurse_intern", label: "Nurse Intern", test: isInternType },
];

function roleGroupKey(role) {
  for (const g of ROLE_GROUPS) {
    if (g.test(role)) return g.key;
  }
  return "nurse";
}

// Per-type leave entitlement caps. "year" resets every leave year
// (Apr 1 - Mar 31, same for every staff member); "month" resets every
// calendar month. Types not listed here (Emergency, Public Holiday, Leave
// of Absence, Swap) have no cap at all — untracked, always allowed.
// These are the SYSTEM DEFAULTS — an individual or job-role override in
// leave_entitlement_overrides (034) replaces the `days` figure for whoever
// it applies to; the `period` (year vs month) is never overridable, since
// that's a structural property of the leave type itself, not a per-person
// allowance.
const LEAVE_ENTITLEMENTS = {
  Annual: { days: 15, period: "year" },
  "Study Leave": { days: 5, period: "year" },
  "Compassionate Leave": { days: 5, period: "year" },
  Maternity: { days: 84, period: "year" }, // 12 weeks
  Sick: { days: 12, period: "month" },
};

function ymd(d) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function leaveYearForDate(dateValue) {
  if (dateValue instanceof Date) {
    const year = dateValue.getFullYear();
    const month = dateValue.getMonth() + 1;
    return month >= 4 ? year : year - 1;
  }
  const [yearStr, monthStr] = String(dateValue).slice(0, 10).split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  return month >= 4 ? year : year - 1;
}

// The current tracking window for a period type, as of right now (Lagos
// wall-clock date — matches how "today" is computed elsewhere in this file's
// caller, leave-requests.js). `month` is 1-12; only meaningful when
// period === "month" (leave_entitlement_adjustments.period_month is NULL
// for year-period types, so callers should only pass month through then).
function currentWindow(period) {
  const today = new Date(new Date().toLocaleString("en-US", { timeZone: "Africa/Lagos" }));
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  if (period === "month") {
    return {
      start: ymd(new Date(year, month - 1, 1)),
      end: ymd(new Date(year, month, 0)),
      year,
      month,
    };
  }
  // The leave year starts on 1 April and ends on 31 March. Store the year in
  // which that leave year starts so adjustments and maternity checks share
  // the same key across the whole entitlement system.
  const leaveYear = month >= 4 ? year : year - 1;
  return {
    start: ymd(new Date(leaveYear, 3, 1)),
    end: ymd(new Date(leaveYear + 1, 2, 31)),
    year: leaveYear,
    month: null,
  };
}

function daysBetweenInclusive(fromStr, toStr) {
  return Math.max(0, Math.round((new Date(toStr) - new Date(fromStr)) / 86400000) + 1);
}

// Once a nurse has a Pending or Approved Maternity leave request starting in
// a given leave year, they can't also request Annual leave anywhere in that
// same leave year. The leave year starts in April and is keyed by its start
// year (e.g. Apr 2025-Mar 2026 is leave year 2025).
async function isAnnualBlockedByMaternity(nurseId, year, opts = {}) {
  const queryable = opts.queryable ?? pool;
  const params = [nurseId, year];
  const excludeClause = opts.excludeRequestId ? `AND id <> $${params.length + 1}` : "";
  if (opts.excludeRequestId) params.push(opts.excludeRequestId);
  const { rows } = await queryable.query(
    `SELECT id FROM leave_requests
      WHERE nurse_id = $1 AND type = 'Maternity' AND status IN ('Pending','Approved')
        AND (
          EXTRACT(YEAR FROM from_date) -
          CASE WHEN EXTRACT(MONTH FROM from_date) < 4 THEN 1 ELSE 0 END
        ) = $2
        ${excludeClause}
      LIMIT 1`,
    params,
  );
  return rows.length > 0;
}

// Bulk version — one query for however many nurses, instead of one query per
// nurse. Returns a Set of nurse_ids currently blocked for the given year.
async function annualBlockedByMaternityForNurses(nurseIds, year) {
  if (nurseIds.length === 0) return new Set();
  const { rows } = await pool.query(
    `SELECT DISTINCT nurse_id FROM leave_requests
      WHERE nurse_id = ANY($1) AND type = 'Maternity' AND status IN ('Pending','Approved')
        AND (
          EXTRACT(YEAR FROM from_date) -
          CASE WHEN EXTRACT(MONTH FROM from_date) < 4 THEN 1 ELSE 0 END
        ) = $2`,
    [nurseIds, year],
  );
  return new Set(rows.map((r) => r.nurse_id));
}

// Effective cap for one nurse/type: individual override beats job-role
// override beats the system default — see migration 034's header for why
// this precedence and why it's admin-only to set. `role` is the nurse's
// literal role string (e.g. "Surgical Nurse - Day"); resolved to its role
// GROUP key before matching against a role-scoped override.
async function effectiveCap(nurseId, role, type) {
  const { rows } = await pool.query(
    `SELECT days FROM leave_entitlement_overrides
      WHERE type = $3 AND (
        (scope = 'individual' AND nurse_id = $1) OR
        (scope = 'role' AND role = $2)
      )
      ORDER BY scope = 'individual' DESC
      LIMIT 1`,
    [nurseId, roleGroupKey(role), type],
  );
  return rows[0] ? Number(rows[0].days) : LEAVE_ENTITLEMENTS[type].days;
}

// Same precedence as effectiveCap, but resolved for many nurses at once —
// two queries total (role overrides + individual overrides) regardless of
// how many nurses are passed in. `nurses` is [{ id, role }, ...].
// Returns { [nurseId]: { [type]: capNumber } }.
async function effectiveCapsForNurses(nurses) {
  const out = {};
  for (const n of nurses) {
    out[n.id] = {};
    for (const type of Object.keys(LEAVE_ENTITLEMENTS))
      out[n.id][type] = LEAVE_ENTITLEMENTS[type].days;
  }
  if (nurses.length === 0) return out;

  const groupKeys = [...new Set(nurses.map((n) => roleGroupKey(n.role)))];
  const { rows: roleRows } = await pool.query(
    `SELECT role, type, days FROM leave_entitlement_overrides WHERE scope = 'role' AND role = ANY($1)`,
    [groupKeys],
  );
  const roleCap = new Map(roleRows.map((r) => [`${r.role}|${r.type}`, Number(r.days)]));
  for (const n of nurses) {
    const group = roleGroupKey(n.role);
    for (const type of Object.keys(LEAVE_ENTITLEMENTS)) {
      const key = `${group}|${type}`;
      if (roleCap.has(key)) out[n.id][type] = roleCap.get(key);
    }
  }

  const nurseIds = nurses.map((n) => n.id);
  const { rows: indivRows } = await pool.query(
    `SELECT nurse_id, type, days FROM leave_entitlement_overrides WHERE scope = 'individual' AND nurse_id = ANY($1)`,
    [nurseIds],
  );
  for (const r of indivRows) {
    if (out[r.nurse_id]) out[r.nurse_id][r.type] = Number(r.days);
  }

  return out;
}

// Days already reserved (Pending + Approved — Pending counts too, so several
// simultaneous requests can't jointly blow past the cap before any of them
// are individually decided; Rejected/Expired never count) for one nurse/type,
// clipped to the current tracking window.
async function daysUsedFromRequests(nurseId, type, windowStart, windowEnd) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(
       GREATEST(0, (LEAST(to_date, $4::date) - GREATEST(from_date, $3::date)) + 1)
     ), 0) AS days
     FROM leave_requests
     WHERE nurse_id = $1 AND type = $2 AND status IN ('Pending','Approved')
       AND from_date <= $4::date AND to_date >= $3::date`,
    [nurseId, type, windowStart, windowEnd],
  );
  return Number(rows[0]?.days ?? 0);
}

// Manually-credited days (leave taken before this system existed, or any
// other case never submitted as a real request) for one nurse/type in the
// current window — see migrations/033_leave_entitlement_adjustments.sql.
async function daysUsedFromAdjustments(nurseId, type, period, year, month) {
  const { rows } = await pool.query(
    period === "month"
      ? `SELECT COALESCE(SUM(days), 0) AS days FROM leave_entitlement_adjustments
          WHERE nurse_id = $1 AND type = $2 AND period_year = $3 AND period_month = $4`
      : `SELECT COALESCE(SUM(days), 0) AS days FROM leave_entitlement_adjustments
          WHERE nurse_id = $1 AND type = $2 AND period_year = $3`,
    period === "month" ? [nurseId, type, year, month] : [nurseId, type, year],
  );
  return Number(rows[0]?.days ?? 0);
}

// { [type]: { cap, used, usedFromRequests, usedFromAdjustments, remaining,
//   exhausted, period, windowStart, windowEnd } } for every tracked type,
// for one nurse, as of right now. `used` is always the combined total — a
// day taken is a day taken regardless of source — but the two sources stay
// visible separately so the UI can always show which is which. `cap`
// already reflects any individual/role override in effect.
async function getEntitlementUsage(nurseId) {
  const { rows: nurseRows } = await pool.query(`SELECT role FROM nurses WHERE id = $1`, [nurseId]);
  const role = nurseRows[0]?.role ?? "";

  const out = {};
  for (const [type, { period }] of Object.entries(LEAVE_ENTITLEMENTS)) {
    const cap = await effectiveCap(nurseId, role, type);
    const { start, end, year, month } = currentWindow(period);
    const usedFromRequests = await daysUsedFromRequests(nurseId, type, start, end);
    const usedFromAdjustments = await daysUsedFromAdjustments(nurseId, type, period, year, month);
    const used = usedFromRequests + usedFromAdjustments;
    const maternityBlock = type === "Annual" && (await isAnnualBlockedByMaternity(nurseId, year));
    out[type] = {
      cap,
      used,
      usedFromRequests,
      usedFromAdjustments,
      remaining: Math.max(0, cap - used),
      exhausted: used >= cap || maternityBlock,
      blockedReason: maternityBlock ? "maternity" : null,
      period,
      windowStart: start,
      windowEnd: end,
    };
  }
  return out;
}

// Would this NEW request (not yet inserted) push nurseId over their cap for
// `type`? Returns null when the type isn't tracked, or when it fits within
// the remaining allowance. Otherwise returns the numbers needed to explain
// why it doesn't fit. Manual adjustments count toward "already used" here
// too — a day credited for pre-system leave is just as real as one from an
// app-submitted request when deciding whether there's room left. The cap
// used is the nurse's EFFECTIVE cap (individual/role override applied).
async function wouldExceedEntitlement(nurseId, type, fromDate, toDate) {
  const entitlement = LEAVE_ENTITLEMENTS[type];
  if (!entitlement) return null;

  const { rows: nurseRows } = await pool.query(`SELECT role FROM nurses WHERE id = $1`, [nurseId]);
  const role = nurseRows[0]?.role ?? "";
  const cap = await effectiveCap(nurseId, role, type);

  const { start, end, year, month } = currentWindow(entitlement.period);
  const usedFromRequests = await daysUsedFromRequests(nurseId, type, start, end);
  const usedFromAdjustments = await daysUsedFromAdjustments(
    nurseId,
    type,
    entitlement.period,
    year,
    month,
  );
  const used = usedFromRequests + usedFromAdjustments;

  const overlapStart = fromDate > start ? fromDate : start;
  const overlapEnd = toDate < end ? toDate : end;
  const requestedDaysInWindow =
    overlapStart <= overlapEnd ? daysBetweenInclusive(overlapStart, overlapEnd) : 0;

  if (used + requestedDaysInWindow > cap) {
    return { cap, used, requestedDaysInWindow, period: entitlement.period };
  }
  return null;
}

// Same computation as getEntitlementUsage, but for many nurses at once —
// a fixed small number of aggregate queries (two per tracked type: one for
// requests, one for adjustments — both GROUP BY nurse_id) regardless of how
// many nurses are passed in, instead of looping getEntitlementUsage per
// nurse (which would be several queries PER nurse — far too slow for an
// admin-wide listing across hundreds of staff). `nurses` is [{id, role}].
// Returns { [nurse_id]: { [type]: {cap, used, usedFromRequests, usedFromAdjustments, ...} } }.
async function getEntitlementUsageForNurses(nurses) {
  const nurseIds = nurses.map((n) => n.id);
  const usageByNurse = new Map(nurseIds.map((id) => [id, {}]));
  if (nurseIds.length === 0) return {};

  const caps = await effectiveCapsForNurses(nurses);

  for (const [type, { period }] of Object.entries(LEAVE_ENTITLEMENTS)) {
    const { start, end, year, month } = currentWindow(period);

    const { rows: reqRows } = await pool.query(
      `SELECT nurse_id, COALESCE(SUM(
         GREATEST(0, (LEAST(to_date, $3::date) - GREATEST(from_date, $2::date)) + 1)
       ), 0) AS days
       FROM leave_requests
       WHERE nurse_id = ANY($1) AND type = $4 AND status IN ('Pending','Approved')
         AND from_date <= $3::date AND to_date >= $2::date
       GROUP BY nurse_id`,
      [nurseIds, start, end, type],
    );
    const { rows: adjRows } = await pool.query(
      period === "month"
        ? `SELECT nurse_id, COALESCE(SUM(days), 0) AS days FROM leave_entitlement_adjustments
            WHERE nurse_id = ANY($1) AND type = $2 AND period_year = $3 AND period_month = $4
            GROUP BY nurse_id`
        : `SELECT nurse_id, COALESCE(SUM(days), 0) AS days FROM leave_entitlement_adjustments
            WHERE nurse_id = ANY($1) AND type = $2 AND period_year = $3
            GROUP BY nurse_id`,
      period === "month" ? [nurseIds, type, year, month] : [nurseIds, type, year],
    );

    const reqByNurse = new Map(reqRows.map((r) => [r.nurse_id, Number(r.days)]));
    const adjByNurse = new Map(adjRows.map((r) => [r.nurse_id, Number(r.days)]));
    const maternityBlocked =
      type === "Annual" ? await annualBlockedByMaternityForNurses(nurseIds, year) : null;
    for (const id of nurseIds) {
      const cap = caps[id]?.[type] ?? LEAVE_ENTITLEMENTS[type].days;
      const usedFromRequests = reqByNurse.get(id) ?? 0;
      const usedFromAdjustments = adjByNurse.get(id) ?? 0;
      const used = usedFromRequests + usedFromAdjustments;
      const isBlocked = !!maternityBlocked?.has(id);
      usageByNurse.get(id)[type] = {
        cap,
        used,
        usedFromRequests,
        usedFromAdjustments,
        remaining: Math.max(0, cap - used),
        exhausted: used >= cap || isBlocked,
        blockedReason: isBlocked ? "maternity" : null,
        period,
        windowStart: start,
        windowEnd: end,
      };
    }
  }
  return Object.fromEntries(usageByNurse);
}

// Records a manual adjustment — append-only, no update/delete (see the
// migration's header comment for why: a mistaken entry is corrected by
// adding a new offsetting row, not by editing history).
async function createAdjustment({
  nurseId,
  type,
  days,
  periodYear,
  periodMonth,
  reason,
  createdBy,
  createdByName,
}) {
  const { rows } = await pool.query(
    `INSERT INTO leave_entitlement_adjustments
       (nurse_id, type, days, period_year, period_month, reason, created_by, created_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      nurseId,
      type,
      days,
      periodYear,
      periodMonth ?? null,
      reason,
      createdBy ?? null,
      createdByName ?? null,
    ],
  );
  return rows[0];
}

// Full adjustment history for one nurse, newest first — the audit trail the
// admin overview links out to.
async function getAdjustmentHistory(nurseId) {
  const { rows } = await pool.query(
    `SELECT * FROM leave_entitlement_adjustments WHERE nurse_id = $1 ORDER BY created_at DESC`,
    [nurseId],
  );
  return rows;
}

// All overrides currently in effect (both scopes) — the admin config
// listing that shows what's been customized away from system defaults.
async function getOverrides() {
  const { rows } = await pool.query(
    `SELECT o.*, n.name AS nurse_name
       FROM leave_entitlement_overrides o
       LEFT JOIN nurses n ON n.id = o.nurse_id
      ORDER BY o.scope, COALESCE(n.name, o.role), o.type`,
  );
  return rows;
}

// Set (or update) an override — a config table, not a log, so this is a
// real UPSERT keyed on the matching partial unique index (034).
async function upsertOverride({ scope, nurseId, role, type, days, createdBy, createdByName }) {
  const { rows } = await pool.query(
    scope === "individual"
      ? `INSERT INTO leave_entitlement_overrides (scope, nurse_id, type, days, created_by, created_by_name)
         VALUES ('individual', $1, $2, $3, $4, $5)
         ON CONFLICT (nurse_id, type) WHERE scope = 'individual'
         DO UPDATE SET days = EXCLUDED.days, created_by = EXCLUDED.created_by,
                        created_by_name = EXCLUDED.created_by_name, updated_at = NOW()
         RETURNING *`
      : `INSERT INTO leave_entitlement_overrides (scope, role, type, days, created_by, created_by_name)
         VALUES ('role', $1, $2, $3, $4, $5)
         ON CONFLICT (role, type) WHERE scope = 'role'
         DO UPDATE SET days = EXCLUDED.days, created_by = EXCLUDED.created_by,
                        created_by_name = EXCLUDED.created_by_name, updated_at = NOW()
         RETURNING *`,
    scope === "individual"
      ? [nurseId, type, days, createdBy ?? null, createdByName ?? null]
      : [role, type, days, createdBy ?? null, createdByName ?? null],
  );
  return rows[0];
}

// Removes an override — reverts that nurse/role+type back to the system
// default (LEAVE_ENTITLEMENTS).
async function deleteOverride(id) {
  const { rows } = await pool.query(
    `DELETE FROM leave_entitlement_overrides WHERE id = $1 RETURNING *`,
    [id],
  );
  return rows[0];
}

// { key, label } pairs only — the frontend's role-override dropdown source
// of truth, without leaking the classifier functions themselves. "nurse"
// (plain ward nurse) is listed first since it's the fallthrough default in
// roleGroupKey rather than an explicit ROLE_GROUPS entry.
const ROLE_GROUP_OPTIONS = [
  { key: "nurse", label: "Nurse" },
  ...ROLE_GROUPS.map(({ key, label }) => ({ key, label })),
];

module.exports = {
  LEAVE_ENTITLEMENTS,
  ROLE_GROUP_OPTIONS,
  getEntitlementUsage,
  getEntitlementUsageForNurses,
  wouldExceedEntitlement,
  isAnnualBlockedByMaternity,
  leaveYearForDate,
  createAdjustment,
  getAdjustmentHistory,
  getOverrides,
  upsertOverride,
  deleteOverride,
};
