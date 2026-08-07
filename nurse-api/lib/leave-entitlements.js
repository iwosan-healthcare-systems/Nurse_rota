const pool = require("../db");

// Per-type leave entitlement caps. "year" resets every calendar year
// (Jan 1 - Dec 31, same for every staff member); "month" resets every
// calendar month. Types not listed here (Emergency, Public Holiday, Leave
// of Absence, Swap) have no cap at all — untracked, always allowed.
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
  return { start: ymd(new Date(year, 0, 1)), end: ymd(new Date(year, 11, 31)), year, month: null };
}

function daysBetweenInclusive(fromStr, toStr) {
  return Math.max(0, Math.round((new Date(toStr) - new Date(fromStr)) / 86400000) + 1);
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
// visible separately so the UI can always show which is which.
async function getEntitlementUsage(nurseId) {
  const out = {};
  for (const [type, { days: cap, period }] of Object.entries(LEAVE_ENTITLEMENTS)) {
    const { start, end, year, month } = currentWindow(period);
    const usedFromRequests = await daysUsedFromRequests(nurseId, type, start, end);
    const usedFromAdjustments = await daysUsedFromAdjustments(nurseId, type, period, year, month);
    const used = usedFromRequests + usedFromAdjustments;
    out[type] = {
      cap,
      used,
      usedFromRequests,
      usedFromAdjustments,
      remaining: Math.max(0, cap - used),
      exhausted: used >= cap,
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
// app-submitted request when deciding whether there's room left.
async function wouldExceedEntitlement(nurseId, type, fromDate, toDate) {
  const entitlement = LEAVE_ENTITLEMENTS[type];
  if (!entitlement) return null;
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

  if (used + requestedDaysInWindow > entitlement.cap) {
    return { cap: entitlement.cap, used, requestedDaysInWindow, period: entitlement.period };
  }
  return null;
}

// Same computation as getEntitlementUsage, but for many nurses at once —
// a fixed small number of aggregate queries (two per tracked type: one for
// requests, one for adjustments — both GROUP BY nurse_id) regardless of how
// many nurses are passed in, instead of looping getEntitlementUsage per
// nurse (which would be several queries PER nurse — far too slow for an
// admin-wide listing across hundreds of staff).
// Returns { [nurse_id]: { [type]: {cap, used, usedFromRequests, usedFromAdjustments, ...} } }.
async function getEntitlementUsageForNurses(nurseIds) {
  const usageByNurse = new Map(nurseIds.map((id) => [id, {}]));
  if (nurseIds.length === 0) return {};

  for (const [type, { days: cap, period }] of Object.entries(LEAVE_ENTITLEMENTS)) {
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
    for (const id of nurseIds) {
      const usedFromRequests = reqByNurse.get(id) ?? 0;
      const usedFromAdjustments = adjByNurse.get(id) ?? 0;
      const used = usedFromRequests + usedFromAdjustments;
      usageByNurse.get(id)[type] = {
        cap,
        used,
        usedFromRequests,
        usedFromAdjustments,
        remaining: Math.max(0, cap - used),
        exhausted: used >= cap,
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
    [nurseId, type, days, periodYear, periodMonth ?? null, reason, createdBy ?? null, createdByName ?? null],
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

module.exports = {
  LEAVE_ENTITLEMENTS,
  getEntitlementUsage,
  getEntitlementUsageForNurses,
  wouldExceedEntitlement,
  createAdjustment,
  getAdjustmentHistory,
};
