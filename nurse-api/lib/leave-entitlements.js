const pool = require("../db");

// Per-type leave entitlement caps. "year" resets every calendar year
// (Jan 1 - Dec 31, same for every staff member); "month" resets every
// calendar month. Types not listed here (Emergency, Public Holiday, Leave
// of Absence, Swap) have no cap at all — untracked, always allowed.
const LEAVE_ENTITLEMENTS = {
  Annual: { days: 21, period: "year" },
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
// caller, leave-requests.js).
function currentWindow(period) {
  const today = new Date(new Date().toLocaleString("en-US", { timeZone: "Africa/Lagos" }));
  if (period === "month") {
    return {
      start: ymd(new Date(today.getFullYear(), today.getMonth(), 1)),
      end: ymd(new Date(today.getFullYear(), today.getMonth() + 1, 0)),
    };
  }
  return {
    start: ymd(new Date(today.getFullYear(), 0, 1)),
    end: ymd(new Date(today.getFullYear(), 11, 31)),
  };
}

function daysBetweenInclusive(fromStr, toStr) {
  return Math.max(0, Math.round((new Date(toStr) - new Date(fromStr)) / 86400000) + 1);
}

// Days already reserved (Pending + Approved — Pending counts too, so several
// simultaneous requests can't jointly blow past the cap before any of them
// are individually decided; Rejected/Expired never count) for one nurse/type,
// clipped to the current tracking window.
async function daysUsed(nurseId, type, windowStart, windowEnd) {
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

// { [type]: { cap, used, remaining, exhausted, period, windowStart, windowEnd } }
// for every tracked type, for one nurse, as of right now.
async function getEntitlementUsage(nurseId) {
  const out = {};
  for (const [type, { days: cap, period }] of Object.entries(LEAVE_ENTITLEMENTS)) {
    const { start, end } = currentWindow(period);
    const used = await daysUsed(nurseId, type, start, end);
    out[type] = {
      cap,
      used,
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
// why it doesn't fit.
async function wouldExceedEntitlement(nurseId, type, fromDate, toDate) {
  const entitlement = LEAVE_ENTITLEMENTS[type];
  if (!entitlement) return null;
  const { start, end } = currentWindow(entitlement.period);
  const used = await daysUsed(nurseId, type, start, end);

  const overlapStart = fromDate > start ? fromDate : start;
  const overlapEnd = toDate < end ? toDate : end;
  const requestedDaysInWindow =
    overlapStart <= overlapEnd ? daysBetweenInclusive(overlapStart, overlapEnd) : 0;

  if (used + requestedDaysInWindow > entitlement.cap) {
    return { cap: entitlement.cap, used, requestedDaysInWindow, period: entitlement.period };
  }
  return null;
}

module.exports = { LEAVE_ENTITLEMENTS, getEntitlementUsage, wouldExceedEntitlement };
