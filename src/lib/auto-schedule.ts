// Auto-scheduling engine for the rota period (a calendar month).
//
// Universal 16-day cycle for ALL roles (strict, no override): 4M → 4OFF → 4N → 4OFF
//   Offsets are snapped to 4-day block boundaries so every nurse always starts
//   at the beginning of a block (never mid-block).
//   enforceMinima reports safety violations only — it does not modify any assignments.
//
// Coverage nurses (no NC — night coverage is an ordinary N shift):
//   Shift pattern : 4 M → 2 OFF → 4 N → 4 OFF (14-day cycle), continued from
//                   the nurse's last shifts, otherwise staggered across the pool
//   Day only      : M Monday–Friday, OFF at weekends. One day coverage nurse per
//                   weekend rotates Sat+Sun MWC, OFF the Friday before and the
//                   Monday after, then M Tuesday–Friday and OFF that weekend.
//
// Matrons: Morning shift every Mon–Fri, OFF on weekends, ward = null (published with coverage nurses).

export type ShiftCode = "M" | "N" | "OFF" | "LEAVE" | "MWC" | "NC";

export const SHIFT_TIMES = {
  M: { start: "08:00", end: "17:00", hours: 9, label: "Morning" },
  N: { start: "17:00", end: "08:00", hours: 15, label: "Night" },
  NC: { start: "17:00", end: "08:00", hours: 15, label: "Night Coverage" },
  MWC: { start: "08:00", end: "17:00", hours: 9, label: "Morning Weekend Coverage" },
} as const;

export interface NurseInput {
  id: string;
  name: string;
  role: string;
  ward: string | null;
  facility?: string | null;
  target_hours: number;
}

export interface WardInput {
  id: string;
  name: string;
  facility?: string | null;
  min_morning_nurses: number;
  min_morning_na: number;
  min_night_nurses: number;
  min_night_na: number;
}

export interface LeaveInput {
  nurse_id: string;
  from_date: string;
  to_date: string;
  status: string;
  type?: string;
}

export interface DraftAssignment {
  nurse_id: string;
  ward: string | null;
  shift_date: string;
  shift: ShiftCode;
  // Set only when `shift` is "LEAVE": the shift the rotation would otherwise have
  // put the nurse on, so leave-credited hours can be reconstructed later without
  // waiting for a runtime approval-time flip (see leave-requests.js).
  pre_leave_shift?: ShiftCode | null;
  // Set only when `shift` is "LEAVE": which leave type (Sick, Annual, Study
  // Leave, etc.) produced it, so the rota grid can show the specific type
  // instead of a generic "LEAVE" pill without a runtime join.
  leave_type?: string | null;
}

export interface SafetyViolation {
  ward: string;
  date: string;
  shift: "M" | "N";
  role: "nurse" | "na";
  required: number;
  actual: number;
}

// 16-day cycle: 4M → 4OFF → 4N → 4OFF. Every N block is followed by 4 OFF days
// so the rest rule (no M the day after N) is always satisfied.
const NURSE_CYCLE: readonly ShiftCode[] = [
  "M",
  "M",
  "M",
  "M",
  "OFF",
  "OFF",
  "OFF",
  "OFF",
  "N",
  "N",
  "N",
  "N",
  "OFF",
  "OFF",
  "OFF",
  "OFF",
];

// 8-day cycle: 4M → 4OFF. No night shifts — for porter-day and nursing assistant-day.
const DAY_ONLY_CYCLE: readonly ShiftCode[] = ["M", "M", "M", "M", "OFF", "OFF", "OFF", "OFF"];

type WardMins = Pick<
  WardInput,
  "min_morning_nurses" | "min_morning_na" | "min_night_nurses" | "min_night_na"
>;

// Ikoyi-specific minimum staffing per ward.
export const IKOYI_WARD_MINIMUMS: Record<string, WardMins> = {
  "IP Ward": {
    min_morning_nurses: 5,
    min_morning_na: 3,
    min_night_nurses: 5,
    min_night_na: 2,
  },
  ER: {
    min_morning_nurses: 1,
    min_morning_na: 1,
    min_night_nurses: 1,
    min_night_na: 1,
  },
  ICU: {
    min_morning_nurses: 5,
    min_morning_na: 2,
    min_night_nurses: 5,
    min_night_na: 2,
  },
  "Operation Theatre": {
    min_morning_nurses: 6,
    min_morning_na: 2,
    min_night_nurses: 1,
    min_night_na: 1,
  },
  NICU: {
    min_morning_nurses: 4,
    min_morning_na: 1,
    min_night_nurses: 3,
    min_night_na: 1,
  },
  SCBU: {
    min_morning_nurses: 4,
    min_morning_na: 1,
    min_night_nurses: 3,
    min_night_na: 1,
  },
  GOPD: {
    min_morning_nurses: 4,
    min_morning_na: 4,
    min_night_nurses: 0,
    min_night_na: 0,
  },
  "Labour Ward": {
    min_morning_nurses: 1,
    min_morning_na: 0,
    min_night_nurses: 1,
    min_night_na: 0,
  },
  Dialysis: {
    min_morning_nurses: 2,
    min_morning_na: 0,
    min_night_nurses: 0,
    min_night_na: 0,
  },
  Oncology: {
    min_morning_nurses: 1,
    min_morning_na: 0,
    min_night_nurses: 0,
    min_night_na: 0,
  },
  "Surgical Unit": {
    min_morning_nurses: 1,
    min_morning_na: 0,
    min_night_nurses: 1,
    min_night_na: 0,
  },
};

export const IKOYI_WARD_NAMES = Object.keys(IKOYI_WARD_MINIMUMS);

// Ligali-specific minimum staffing per ward.
// Note: Operation Theatre is morning-only (no night shift).
// Special rule not yet enforced: all OT nurses on duty every Saturday.
export const LIGALI_WARD_MINIMUMS: Record<string, WardMins> = {
  ER: {
    min_morning_nurses: 2,
    min_morning_na: 1,
    min_night_nurses: 1,
    min_night_na: 1,
  },
  GOPD: {
    min_morning_nurses: 4,
    min_morning_na: 4,
    min_night_nurses: 1,
    min_night_na: 1,
  },
  "IP Ward": {
    min_morning_nurses: 3,
    min_morning_na: 1,
    min_night_nurses: 2,
    min_night_na: 1,
  },
  "ICU & CathLab": {
    min_morning_nurses: 3,
    min_morning_na: 1,
    min_night_nurses: 1,
    min_night_na: 1,
  },
  "Operation Theatre": {
    min_morning_nurses: 2,
    min_morning_na: 2,
    min_night_nurses: 0,
    min_night_na: 0,
  },
};

export const LIGALI_WARD_NAMES = Object.keys(LIGALI_WARD_MINIMUMS);

// Ikeja-specific minimum staffing per ward.
// Several wards are morning-only (Labour Ward, ER, SCBU, HDU, GOPD).
// Special rule not yet enforced: Ikeja GOPD requires 7 nurses + 3 NA on
// Wednesdays and Fridays (day-of-week override, not expressible as a static min).
export const IKEJA_WARD_MINIMUMS: Record<string, WardMins> = {
  "IP Ward": {
    min_morning_nurses: 10,
    min_morning_na: 3,
    min_night_nurses: 9,
    min_night_na: 2,
  },
  "Labour Ward": {
    min_morning_nurses: 1,
    min_morning_na: 0,
    min_night_nurses: 0,
    min_night_na: 0,
  },
  ER: {
    min_morning_nurses: 1,
    min_morning_na: 0,
    min_night_nurses: 0,
    min_night_na: 0,
  },
  SCBU: {
    min_morning_nurses: 2,
    min_morning_na: 0,
    min_night_nurses: 0,
    min_night_na: 0,
  },
  HDU: {
    min_morning_nurses: 1,
    min_morning_na: 0,
    min_night_nurses: 0,
    min_night_na: 0,
  },
  GOPD: {
    min_morning_nurses: 5,
    min_morning_na: 3,
    min_night_nurses: 0,
    min_night_na: 0,
  },
};

export const IKEJA_WARD_NAMES = Object.keys(IKEJA_WARD_MINIMUMS);

function ymd(d: Date) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function parseWards(ward: string | null): string[] {
  if (!ward) return [];
  return ward.split("|").filter(Boolean);
}

function inLeave(leave: LeaveInput[], nurseId: string, dateStr: string) {
  return leave.some(
    (l) =>
      l.nurse_id === nurseId &&
      l.status === "Approved" &&
      l.from_date <= dateStr &&
      l.to_date >= dateStr,
  );
}

// Companion to inLeave() — the specific leave type covering this nurse/date,
// or null. Only ever called after inLeave() has already confirmed a match,
// so the ?? null fallback is defensive, not expected to actually trigger.
function leaveTypeFor(leave: LeaveInput[], nurseId: string, dateStr: string): string | null {
  return (
    leave.find(
      (l) =>
        l.nurse_id === nurseId &&
        l.status === "Approved" &&
        l.from_date <= dateStr &&
        l.to_date >= dateStr,
    )?.type ?? null
  );
}

export function isNAType(role: string) {
  return /nurs(?:e|ing)\s*assistant/i.test(role);
}

export function isNADayType(role: string) {
  return /nurs(?:e|ing)\s*assistant\s*-\s*day/i.test(role);
}

export function isPorterType(role: string) {
  return /^porter(\s*-\s*day)?$/i.test(role);
}

export function isPorterDayType(role: string) {
  return /^porter\s*-\s*day$/i.test(role);
}

export function isSurgicalNurseDayType(role: string) {
  return /^surgical\s*nurse\s*-\s*day$/i.test(role);
}

export function isSurgicalNurseType(role: string) {
  return /^surgical\s*nurse$/i.test(role);
}

export function isInternType(role: string) {
  return /nurse\s*intern|intern\s*nurse/i.test(role);
}

// Coverage Nurse - Day: same facility-wide Coverage Nurse group (role_group
// "head" everywhere — submission, approval, the Coverage Nurse card) but
// morning-only in the scheduling engine (see scheduleCoverageNurses below).
export function isCoverageNurseDayType(role: string) {
  return /^coverage\s*nurse\s*-\s*day$/i.test(role);
}

export function isGlobalHead(role: string) {
  return /^(head|coverage)\s*nurse$/i.test(role) || isCoverageNurseDayType(role);
}

export function isMatron(role: string) {
  return /^matron$/i.test(role);
}

export function isWardSupervisor(role: string) {
  return (
    !isGlobalHead(role) &&
    !isMatron(role) &&
    /supervisor|matron|sister|senior\s*nurse|experienced\s*nurse/i.test(role)
  );
}

export function isHeadOrSupervisor(role: string) {
  return isGlobalHead(role) || isWardSupervisor(role);
}

function isNurseOrIntern(role: string) {
  return !isNAType(role) && !isHeadOrSupervisor(role);
}

function isMorningOnlyWard(ward: WardInput): boolean {
  return ward.min_night_nurses === 0 && ward.min_night_na === 0;
}

// Oncology and Dialysis (Ikoyi) run outpatient-style hours: morning shift,
// weekdays only — never scheduled on Saturday/Sunday at all, unlike the
// rotating 4M→4OFF DAY_ONLY_CYCLE used by other morning-only wards, whose
// M-block can land on a weekend depending on a nurse's stagger phase.
const FIXED_WEEKDAY_WARDS = new Set(["oncology", "dialysis"]);
function isFixedWeekdayWard(ward: WardInput): boolean {
  return FIXED_WEEKDAY_WARDS.has(ward.name.trim().toLowerCase());
}

// Ikoyi GOPD's night requirement is exactly 1 nurse at a time — not "at
// least 1" the way min_night_nurses normally behaves elsewhere (a floor
// enforceMinima checks, never a ceiling). The standard scheduleGroup
// approach staggers every nurse through their own independent N-block
// position, which puts more than one nurse on N the same night as soon as a
// ward has more nurses than fit cleanly across its 4 stagger slots — fine
// for wards that actually need several nurses overnight, wrong for a ward
// that needs exactly one. Hardcoded to this one ward/facility rather than a
// general min_night_nurses===1 rule (confirmed with the user) — same
// hardcoded-name precedent as FIXED_WEEKDAY_WARDS above.
function isSingleNightSlotWard(ward: WardInput): boolean {
  return (
    (ward.facility ?? "").trim().toLowerCase() === "ikoyi" &&
    ward.name.trim().toLowerCase() === "gopd" &&
    ward.min_night_nurses === 1
  );
}

function stableGroupOffset(group: NurseInput[]): number {
  if (group.length === 0) return 0;
  let h = 5381;
  for (const n of group) {
    for (let k = 0; k < n.id.length; k++) {
      h = (((h << 5) + h) ^ n.id.charCodeAt(k)) >>> 0;
    }
  }
  return h % group.length;
}

type PriorAssignment = { nurse_id: string; shift_date: string; shift: ShiftCode };

// NC is a coverage nurse's equivalent of a regular N shift — it always lands
// at the nurse's natural N-block cycle position (see scheduleCoverageNurses's
// "NC always lands at the nurse's natural N-block position" comment) — and
// MWC is the equivalent of M. Treating them as their base-cycle counterpart
// for phase-matching purposes (rather than excluding them entirely) lets a
// coverage nurse's actual last NC block be recognized as "the N-family block
// just ended, resume M next" instead of collapsing to an ambiguous run of
// bare OFF days once NC/MWC themselves scroll out of the lookback window.
// Only LEAVE genuinely carries no cycle information and stays excluded.
function normalizeForCycleMatch(s: ShiftCode): ShiftCode {
  if (s === "NC") return "N";
  if (s === "MWC") return "M";
  return s;
}

/**
 * Given a nurse's last N actual shifts (chronological), find the unambiguous
 * next position in the cycle. Returns null when the sequence doesn't match
 * exactly one position in the cycle (i.e. ambiguous, or contains a LEAVE day
 * that doesn't belong to the base cycle at all).
 */
function detectCyclePhase(recent: ShiftCode[], cycle: readonly ShiftCode[]): number | null {
  const n = recent.length;
  if (n === 0) return null;
  const len = cycle.length;
  let found: number | null = null;
  for (let start = 0; start < len; start++) {
    let ok = true;
    for (let i = 0; i < n; i++) {
      if (normalizeForCycleMatch(recent[i]) !== cycle[(start + i) % len]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      if (found !== null) return null; // two matches → ambiguous
      found = (start + n) % len;
    }
  }
  return found;
}

/**
 * A single day's actual shift is enough to guarantee the rest-safety
 * property (no M the day immediately after N, or N immediately after M)
 * even when the full lookback window can't be pattern-matched — e.g. a
 * manual edit, swap, or locum cover on one of the other lookback days broke
 * the exact multi-day match in detectCyclePhase. Anchors on whatever the
 * nurse's most recent REAL assigned shift actually is (reflecting any edits,
 * since it's read straight from shift_assignments) and returns the cycle
 * position for "the day right after that shift-family's block ends" — always
 * a rest day, so always safe to resume on. OFF/LEAVE alone doesn't carry
 * this guarantee (a single OFF day doesn't say which block it follows), so
 * this only fires for an unambiguous M-family or N-family last shift.
 */
function safeNextPositionFromLastShift(
  lastShift: ShiftCode,
  cycle: readonly ShiftCode[],
): number | null {
  const len = cycle.length;
  const isM = lastShift === "M" || lastShift === "MWC";
  const isN = lastShift === "N" || lastShift === "NC";
  if (!isM && !isN) return null;

  for (let i = 0; i < len; i++) {
    const curIsFamily = isM ? cycle[i] === "M" : cycle[i] === "N";
    if (!curIsFamily) continue;
    const nextIdx = (i + 1) % len;
    const nextIsFamily = isM ? cycle[nextIdx] === "M" : cycle[nextIdx] === "N";
    if (!nextIsFamily) return nextIdx; // end of the block — safe rest day to resume on
  }
  return null; // this cycle has no block of that shift family at all (e.g. DAY_ONLY_CYCLE + N)
}

/**
 * For each nurse in group, look at their last 2-5 shifts from prev and detect
 * their cycle position. Returns a map of nurse_id → next cycle index to use
 * as the starting position for the new period.
 *
 * Tiers, most precise first:
 *   1. Trailing-window match, tried at length 5 down to 2 (stopping at the
 *      first that matches): a 5-day window is the most precise — it
 *      disambiguates which OFF block a trailing OFF run belongs to
 *      (M→OOOO = 1st OFF → next N; N→OOOO = 2nd OFF → next M) — but if it
 *      doesn't match the pure cycle at all (a LEAVE day in the window, or a
 *      history irregularity such as a block baked in shorter than 4 days by
 *      an earlier bug run), shorter, more recent trailing windows are tried
 *      instead of giving up outright — a clean 2-4 day tail can still land
 *      an exact, unambiguous match even when the older days can't be used.
 *   2. Safe single-day anchor on the nurse's actual most recent assigned shift
 *      (safeNextPositionFromLastShift) — less precise (may not land on the
 *      exact right day within the OFF block) but still edit-proof: guarantees
 *      no unsafe M-after-N or N-after-M even when every windowed match above
 *      failed, since it's anchored on day -1's real value alone.
 * Only a nurse with no history at all, or whose last real shift was itself
 * OFF/LEAVE (not enough information in one day), falls through to the
 * mathematical phase formula in the caller.
 */
function buildPhaseOverrides(
  group: NurseInput[],
  prev: readonly PriorAssignment[],
  cycle: readonly ShiftCode[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (prev.length === 0) return out;

  const byNurse = new Map<string, PriorAssignment[]>();
  for (const a of prev) {
    if (!byNurse.has(a.nurse_id)) byNurse.set(a.nurse_id, []);
    byNurse.get(a.nurse_id)!.push(a);
  }

  for (const nurse of group) {
    const rows = byNurse.get(nurse.id);
    if (!rows || rows.length === 0) continue;
    const sorted = [...rows].sort((a, b) => a.shift_date.localeCompare(b.shift_date));

    let nextPos: number | null = null;

    // Prefer the longest trailing window first (5 days disambiguates which
    // OFF block a trailing OFF run belongs to — M→OOOO = 1st OFF → next N;
    // N→OOOO = 2nd OFF → next M), then retry with progressively shorter
    // windows (down to 2 days) if the longer one fails to match at all.
    // A longer window can fail not just from a LEAVE day but from a
    // shift-history irregularity earlier in the window — e.g. a block baked
    // in shorter than the standard 4 days by an earlier bug, or an isolated
    // manual edit/swap — in which case a shorter, more recent trailing
    // subsequence can still match cleanly and should be used rather than
    // giving up and losing the block-position precision entirely.
    const maxWindow = Math.min(5, sorted.length);
    for (let windowLen = maxWindow; windowLen >= 2 && nextPos === null; windowLen--) {
      const tail = sorted.slice(-windowLen).map((r) => r.shift);
      if (tail.some((s) => s === "LEAVE")) continue;
      nextPos = detectCyclePhase(tail, cycle);
    }

    if (nextPos === null) {
      const lastShift = sorted[sorted.length - 1].shift;
      nextPos = safeNextPositionFromLastShift(lastShift, cycle);
    }

    if (nextPos !== null) out.set(nurse.id, nextPos);
  }

  return out;
}

/**
 * Schedule a group of nurses strictly following `cycle`, writing into `out`.
 *
 * Each nurse is permanently assigned to one of the numBlocks stagger slots
 * based on their stable ID rank (tiebreaker after target_hours). The slot
 * never changes between periods, guaranteeing that the nurse's cycle position
 * at the start of period P+1 is exactly one day after where it ended in P.
 */
function scheduleGroup(
  group: NurseInput[],
  cycle: readonly ShiftCode[],
  days: number,
  startDate: Date,
  leave: LeaveInput[],
  wardName: string | null,
  out: DraftAssignment[],
  phase = 0,
  prev: readonly PriorAssignment[] = [],
  // Oncology/Dialysis: ignore `cycle` entirely and use the real calendar day
  // of week instead — Mon-Fri M, Sat-Sun OFF, always, regardless of a nurse's
  // stagger phase. Unlike DAY_ONLY_CYCLE (an 8-day repeating block that can
  // drift onto weekends depending on phase), this is pinned to actual weekdays.
  fixedWeekday = false,
): void {
  const N = group.length;
  if (N === 0) return;

  const len = cycle.length;
  const numBlocks = Math.floor(len / 4);

  // Stable output order (by ID).
  const byId = [...group].sort((a, b) => a.id.localeCompare(b.id));
  const idRank = new Map(byId.map((n, i) => [n.id, i]));

  // Assignment order: higher target_hours → earlier slot (more staggered hours).
  // Tiebreaker is stable ID rank — never changes between periods.
  const forAssignment = [...byId].sort((a, b) => {
    const tDiff = (b.target_hours ?? 0) - (a.target_hours ?? 0);
    if (tDiff !== 0) return tDiff;
    return (idRank.get(a.id) ?? 0) - (idRank.get(b.id) ?? 0);
  });

  // Slot maps directly to block — no period-dependent ranking so the block
  // assignment is permanent and the cycle continues across periods.
  const nurseBlock = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    const slot = Math.round((i * numBlocks) / N) % numBlocks;
    nurseBlock.set(forAssignment[i].id, slot);
  }

  // If previous-period assignments were supplied, detect each nurse's actual
  // cycle position from their last 4 shifts and use that as the starting point
  // for this period. Falls back to the mathematical phase for nurses whose last
  // block is ambiguous (pure OFF × 4) or contains non-base shifts (LEAVE/MWC/NC).
  const phaseOverrides = buildPhaseOverrides(group, prev, cycle);

  for (let d = 0; d < days; d++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + d);
    const dateStr = ymd(date);
    for (const nurse of byId) {
      const offset = (nurseBlock.get(nurse.id) ?? 0) * 4;
      const startPos = phaseOverrides.get(nurse.id) ?? (((phase + offset) % len) + len) % len;
      const dow = date.getDay(); // 0 = Sun .. 6 = Sat
      const baseShift: ShiftCode = fixedWeekday
        ? dow >= 1 && dow <= 5
          ? "M"
          : "OFF"
        : cycle[(startPos + d) % len];
      const onLeave = inLeave(leave, nurse.id, dateStr);
      out.push({
        nurse_id: nurse.id,
        ward: wardName,
        shift_date: dateStr,
        shift: onLeave ? "LEAVE" : baseShift,
        ...(onLeave
          ? { pre_leave_shift: baseShift, leave_type: leaveTypeFor(leave, nurse.id, dateStr) }
          : {}),
      });
    }
  }
}

/**
 * Schedule a ward's night duty as a single continuous rotating slot — one
 * nurse on N at a time, 4-day blocks, gapless, fairly rotated through the
 * whole group — instead of scheduleGroup's normal per-nurse staggered
 * cycle (which doesn't cap how many nurses can independently land on N the
 * same night). Everyone's own days OTHER than their rotation turn follow
 * the plain 4M-4OFF DAY_ONLY_CYCLE.
 *
 * Rest safety is asymmetric here, unlike the general 4M-4OFF-4N-4OFF cycle
 * elsewhere: an M shift (08:00-17:00) immediately followed by an N shift
 * the very next calendar day (17:00-08:00) already has a full 24-hour gap
 * between them — genuinely safe, not merely "policy" — so a night block is
 * allowed to start right after a nurse's last M day with no rest buffer
 * imposed by default. But that gap being individually safe doesn't mean an
 * unbroken run of M-then-N is comfortable at any length: a nurse who was
 * already deep into their 4-day M block when their rotation turn lands
 * would otherwise work a straight 7-8 consecutive days (trailing M days +
 * the 4-day N block) with no rest at all in between. So the lead-in is
 * conditional, not blanket: only when the combined stretch would reach 7+
 * consecutive working days does it force 2 OFF days immediately before the
 * block starts, breaking the run — a short nurse-was-only-1-2-days-into-M
 * case needs no intervention at all.
 *
 * The reverse direction is never safe regardless of run length: N ending at
 * 08:00 immediately followed by an M shift starting at 08:00 the same day
 * is a zero-hour gap. That keeps the mandatory 4-day rest after every night
 * block (inPostOff below) — never relaxed, never conditional.
 */
function scheduleSingleNightSlotWard(
  group: NurseInput[],
  days: number,
  startDate: Date,
  leave: LeaveInput[],
  wardName: string,
  out: DraftAssignment[],
  periodOffset: number,
  prev: readonly PriorAssignment[],
): void {
  const sorted = [...group].sort((a, b) => a.id.localeCompare(b.id));
  const N = sorted.length;
  if (N === 0) return;

  const DL = DAY_ONLY_CYCLE.length; // 8
  const numBlocks = DL / 4; // 2
  const periodsElapsed = Math.round(periodOffset / days);
  const seed = stableGroupOffset(sorted);

  const idRank = new Map(sorted.map((n, i) => [n.id, i]));
  const forAssignment = [...sorted].sort((a, b) => {
    const tDiff = (b.target_hours ?? 0) - (a.target_hours ?? 0);
    if (tDiff !== 0) return tDiff;
    return (idRank.get(a.id) ?? 0) - (idRank.get(b.id) ?? 0);
  });
  const nurseBlock = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    const slot = Math.round((i * numBlocks) / N) % numBlocks;
    nurseBlock.set(forAssignment[i].id, slot);
  }

  const phaseOverrides = buildPhaseOverrides(sorted, prev, DAY_ONLY_CYCLE);
  function nurseEffectiveBase(i: number): number {
    return (
      phaseOverrides.get(sorted[i].id) ??
      (((periodOffset + (nurseBlock.get(sorted[i].id) ?? 0) * 4) % DL) + DL) % DL
    );
  }

  // What would nurse i actually render as on day d, given every night block
  // (and any run-breaking rest forced before one) decided so far this
  // period?
  const nightStartDays = new Map<number, number[]>(); // nurseIdx → all night-block start days
  const runBreakOff = new Map<number, Set<number>>(); // nurseIdx → day-offsets forced OFF to break a long run

  function predictedShift(i: number, d: number): ShiftCode {
    if (runBreakOff.get(i)?.has(d)) return "OFF";
    const starts = nightStartDays.get(i) ?? [];
    const past = starts.filter((s) => s <= d);
    const relevantStart = past.length > 0 ? Math.max(...past) : undefined;
    const inNight = relevantStart !== undefined && d < relevantStart + 4;
    const inPostOff = relevantStart !== undefined && !inNight && d < relevantStart + 8;
    if (inNight) return "N";
    if (inPostOff) return "OFF"; // mandatory rest before ever resuming M — see function comment
    if (relevantStart !== undefined) return DAY_ONLY_CYCLE[(d - (relevantStart + 8)) % DL];
    return DAY_ONLY_CYCLE[(((nurseEffectiveBase(i) + d) % DL) + DL) % DL];
  }

  // How many consecutive M days immediately precede blockStart? Only asked
  // right before assigning a block, so it only ever sees real personal-cycle
  // M days (or a run already broken by an earlier iteration) — never an
  // in-progress night block, which can't be adjacent to a not-yet-decided
  // future one.
  function trailingMDays(i: number, blockStart: number): number {
    let count = 0;
    for (let k = blockStart - 1; k >= 0 && count < 4; k--) {
      if (predictedShift(i, k) !== "M") break;
      count++;
    }
    return count;
  }

  // Continuous round-robin — leave-only selection, same as
  // scheduleCoverageNurses' NC rotation, so the pool rotates fairly.
  if (N > 0) {
    const blockCount = Math.floor(days / 4);
    let rotPtr = (periodsElapsed * blockCount + seed) % N;
    for (let b = 0; b < blockCount; b++) {
      const blockStart = b * 4;
      const blockDates: string[] = [];
      for (let k = 0; k < 4; k++) {
        const d = new Date(startDate);
        d.setDate(d.getDate() + blockStart + k);
        blockDates.push(ymd(d));
      }
      let chosen = -1;
      for (let attempt = 0; attempt < N; attempt++) {
        const candidateIdx = (rotPtr + attempt) % N;
        if (!blockDates.some((dt) => inLeave(leave, sorted[candidateIdx].id, dt))) {
          chosen = candidateIdx;
          rotPtr += attempt + 1;
          break;
        }
      }
      if (chosen === -1) continue; // everyone on leave this block

      // Would this block's 4 N days plus whatever M days already lead
      // straight into it add up to a 7+ day consecutive working run? Only
      // then force 2 OFF days right before the block — otherwise leave the
      // natural M→N transition alone (see function comment).
      const trailingM = trailingMDays(chosen, blockStart);
      if (trailingM + 4 >= 7) {
        if (!runBreakOff.has(chosen)) runBreakOff.set(chosen, new Set());
        const set = runBreakOff.get(chosen)!;
        for (let k = blockStart - 2; k < blockStart; k++) {
          if (k >= 0) set.add(k);
        }
      }

      if (!nightStartDays.has(chosen)) nightStartDays.set(chosen, []);
      nightStartDays.get(chosen)!.push(blockStart);
    }
  }

  for (let d = 0; d < days; d++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + d);
    const dateStr = ymd(date);
    for (let i = 0; i < N; i++) {
      const nurse = sorted[i];
      const onLeave = inLeave(leave, nurse.id, dateStr);
      const baseShift = predictedShift(i, d);
      out.push({
        nurse_id: nurse.id,
        ward: wardName,
        shift_date: dateStr,
        shift: onLeave ? "LEAVE" : baseShift,
        ...(onLeave
          ? { pre_leave_shift: baseShift, leave_type: leaveTypeFor(leave, nurse.id, dateStr) }
          : {}),
      });
    }
  }
}

/**
 * Check ward minimum staffing for every day in the window and report violations.
 * Does not modify any assignments — report only.
 */
export function enforceMinima(
  out: DraftAssignment[],
  wardNurses: NurseInput[],
  ward: WardInput,
  days: number,
  startDate: Date,
): { violations: SafetyViolation[]; extraPromos: Map<string, number> } {
  const nurseIds = new Set(wardNurses.map((n) => n.id));
  const nurseById = new Map(wardNurses.map((n) => [n.id, n]));
  const violations: SafetyViolation[] = [];

  for (let d = 0; d < days; d++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + d);
    const dateStr = ymd(date);

    const dayAssignments = out.filter((a) => a.shift_date === dateStr && nurseIds.has(a.nurse_id));

    const count = (shift: ShiftCode, roleTest: (r: string) => boolean) =>
      dayAssignments.filter(
        (a) => a.shift === shift && roleTest(nurseById.get(a.nurse_id)?.role ?? ""),
      ).length;

    const check = (
      shift: "M" | "N",
      required: number,
      roleTest: (r: string) => boolean,
      role: "nurse" | "na",
    ) => {
      if (required <= 0) return;
      const actual = count(shift, roleTest);
      if (actual < required) {
        violations.push({ ward: ward.name, date: dateStr, shift, role, required, actual });
      }
    };

    check("M", ward.min_morning_nurses, isNurseOrIntern, "nurse");
    check("M", ward.min_morning_na, isNAType, "na");
    check("N", ward.min_night_nurses, isNurseOrIntern, "nurse");
    check("N", ward.min_night_na, isNAType, "na");
  }

  return { violations, extraPromos: new Map() };
}

// Collapse per-day violations into a per-ward/shift/role worst-case summary
// — enforceMinima reports one violation per day a minimum isn't met, which
// for a whole 28-day period is far too granular to show anyone directly.
// Shared between the frontend (manual Generate's toast) and the backend
// (auto-generate-rota.js's email + audit log) so both report the exact same
// numbers from the exact same logic, not two independently-written summaries.
export function summariseViolations(violations: SafetyViolation[]) {
  const map = new Map<
    string,
    { ward: string; shift: "M" | "N"; role: string; required: number; actual: number }
  >();
  for (const v of violations) {
    const key = `${v.ward}|${v.shift}|${v.role}`;
    const existing = map.get(key);
    if (!existing || v.actual < existing.actual) {
      map.set(key, {
        ward: v.ward,
        shift: v.shift,
        role: v.role,
        required: v.required,
        actual: v.actual,
      });
    }
  }
  return [...map.values()].sort(
    (a, b) => a.ward.localeCompare(b.ward) || a.shift.localeCompare(b.shift),
  );
}

// Same grouping as summariseViolations (per ward/shift/role) but keeps every
// individual day instead of collapsing to one worst-case row — for reports
// where someone needs to know exactly which dates fell short, not just the
// worst number seen across the whole period.
export function groupViolationsByDay(violations: SafetyViolation[]) {
  const map = new Map<
    string,
    {
      ward: string;
      shift: "M" | "N";
      role: string;
      required: number;
      days: { date: string; actual: number }[];
    }
  >();
  for (const v of violations) {
    const key = `${v.ward}|${v.shift}|${v.role}`;
    let entry = map.get(key);
    if (!entry) {
      entry = { ward: v.ward, shift: v.shift, role: v.role, required: v.required, days: [] };
      map.set(key, entry);
    }
    entry.days.push({ date: v.date, actual: v.actual });
  }
  for (const entry of map.values()) entry.days.sort((a, b) => a.date.localeCompare(b.date));
  return [...map.values()].sort(
    (a, b) => a.ward.localeCompare(b.ward) || a.shift.localeCompare(b.shift),
  );
}

export function nextInternWard(currentWard: string | null, wardNames: string[]): string | null {
  if (!wardNames.length) return currentWard;
  if (!currentWard) return wardNames[0];
  const idx = wardNames.indexOf(currentWard);
  return wardNames[(idx + 1) % wardNames.length];
}

export interface ExtraShift {
  nurseId: string;
  nurseName: string;
  /** Number of extra shifts added by safety enforcement. */
  extraCount: number;
}

export interface ScheduleResult {
  assignments: DraftAssignment[];
  violations: SafetyViolation[];
  extraShifts: ExtraShift[];
}

/** Coverage nurses on the shift pattern: 4 mornings, 2 off, 4 nights, 4 off. */
export const COVERAGE_SHIFT_CYCLE: readonly ShiftCode[] = [
  "M",
  "M",
  "M",
  "M",
  "OFF",
  "OFF",
  "N",
  "N",
  "N",
  "N",
  "OFF",
  "OFF",
  "OFF",
  "OFF",
];

/**
 * Where a shift-pattern coverage nurse continues in COVERAGE_SHIFT_CYCLE, from
 * their last shifts (chronological, consecutive days). Reads the last duty run
 * (NC counts as N, MWC as M) and the OFF days since, so the new period finishes
 * that block or its rest before starting the next. Null when there is no duty
 * in the history, or the latest non-OFF day is leave.
 */
export function coverageCyclePosition(recent: readonly ShiftCode[]): number | null {
  let i = recent.length - 1;
  let rest = 0;
  while (i >= 0 && recent[i] === "OFF") {
    rest++;
    i--;
  }
  if (i < 0) return null;
  const family = normalizeForCycleMatch(recent[i]);
  if (family !== "M" && family !== "N") return null;
  let run = 0;
  while (i >= 0 && normalizeForCycleMatch(recent[i]) === family) {
    run++;
    i--;
  }
  if (family === "M") return rest === 0 ? Math.min(run, 4) : rest < 2 ? 4 + rest : 6;
  return rest === 0 ? (run < 4 ? 6 + run : 10) : rest < 4 ? 10 + rest : 0;
}

/**
 * Schedule coverage nurses (global, not ward-bound). Approved leave replaces
 * the planned shift (kept as pre_leave_shift).
 *
 *   Shift pattern ("Coverage Nurse", "Head Nurse"): COVERAGE_SHIFT_CYCLE. Each
 *     nurse continues from their previous shifts when known; otherwise the pool
 *     is staggered evenly across the cycle from the facility's first scheduled
 *     day, so the pattern is continuous across periods.
 *   Day only ("Coverage Nurse - Day"): M Monday–Friday, weekends OFF. Weekend
 *     coverage rotates weekly through the day coverage nurses (skipping anyone
 *     on leave that weekend): Friday OFF, Saturday and Sunday MWC, Monday OFF,
 *     then M Tuesday–Friday and OFF the following weekend.
 */
function scheduleCoverageNurses(
  group: NurseInput[],
  days: number,
  startDate: Date,
  leave: LeaveInput[],
  out: DraftAssignment[],
  periodOffset = 0,
  prev: readonly PriorAssignment[] = [],
): void {
  group = [...group].sort((a, b) => a.id.localeCompare(b.id));
  if (group.length === 0) return;
  const dayNurses = group.filter((n) => isCoverageNurseDayType(n.role));
  const shiftNurses = group.filter((n) => !isCoverageNurseDayType(n.role));
  const dateAt = (d: number) => {
    const date = new Date(startDate);
    date.setDate(date.getDate() + d);
    return date;
  };
  const priorShifts = (nurseId: string) =>
    prev
      .filter((a) => a.nurse_id === nurseId)
      .sort((a, b) => a.shift_date.localeCompare(b.shift_date))
      .map((a) => a.shift);
  const push = (nurseId: string, dateStr: string, shift: ShiftCode) => {
    const onLeave = inLeave(leave, nurseId, dateStr);
    out.push({
      nurse_id: nurseId,
      ward: null,
      shift_date: dateStr,
      shift: onLeave ? "LEAVE" : shift,
      ...(onLeave
        ? { pre_leave_shift: shift, leave_type: leaveTypeFor(leave, nurseId, dateStr) }
        : {}),
    });
  };

  // ── Shift pattern ─────────────────────────────────────────────────────────
  const CL = COVERAGE_SHIFT_CYCLE.length;
  shiftNurses.forEach((n, i) => {
    const stagger = Math.round((i * CL) / shiftNurses.length) % CL;
    const base = coverageCyclePosition(priorShifts(n.id)) ?? (periodOffset + stagger) % CL;
    for (let d = 0; d < days; d++)
      push(n.id, ymd(dateAt(d)), COVERAGE_SHIFT_CYCLE[(((base + d) % CL) + CL) % CL]);
  });

  // ── Day only, with rotating weekend coverage ──────────────────────────────
  if (dayNurses.length === 0) return;
  // Saturday offset → index into dayNurses of whoever covers that weekend.
  // Includes the weekends either side of the period, whose Monday/Friday rest
  // days fall inside it; a weekend already scheduled is read from prev.
  const weekendCover = new Map<number, number | null>();
  // Weekends each day coverage nurse covers in this period: turns are shared
  // evenly among whoever is available this month.
  const turns = dayNurses.map(() => 0);
  for (let d = -2; d <= days; d++) {
    const sat = dateAt(d);
    if (sat.getDay() !== 6) continue;
    const satStr = ymd(sat);
    const sunStr = ymd(dateAt(d + 1));
    const inPeriod = d + 1 >= 0 && d < days; // Saturday or Sunday falls in the period
    const scheduled = prev.filter((a) => a.shift_date === satStr || a.shift_date === sunStr);
    if (scheduled.length) {
      const who = dayNurses.findIndex((n) =>
        scheduled.some((a) => a.nurse_id === n.id && a.shift === "MWC"),
      );
      weekendCover.set(d, who < 0 ? null : who);
      if (who >= 0 && inPeriod) turns[who]++;
      continue;
    }
    // Available nurses (no leave that weekend) with the fewest weekends this
    // period; ties follow a weekly rotation from a fixed calendar epoch, so the
    // order continues from month to month.
    const week = Math.floor(
      Date.UTC(sat.getFullYear(), sat.getMonth(), sat.getDate()) / 86400000 / 7,
    );
    let who: number | null = null;
    for (let k = 0; k < dayNurses.length; k++) {
      const candidate = (week + k) % dayNurses.length;
      const id = dayNurses[candidate].id;
      if (inLeave(leave, id, satStr) || inLeave(leave, id, sunStr)) continue;
      if (who === null || turns[candidate] < turns[who]) who = candidate;
    }
    weekendCover.set(d, who);
    if (who !== null && inPeriod) turns[who]++;
  }
  dayNurses.forEach((n, i) => {
    for (let d = 0; d < days; d++) {
      const date = dateAt(d);
      const dow = date.getDay(); // 0 = Sun .. 6 = Sat
      const covers = (satOffset: number) => weekendCover.get(satOffset) === i;
      let shift: ShiftCode;
      if (dow === 6 || dow === 0) shift = covers(dow === 6 ? d : d - 1) ? "MWC" : "OFF";
      else if (dow === 5) shift = covers(d + 1) ? "OFF" : "M";
      else if (dow === 1) shift = covers(d - 2) ? "OFF" : "M";
      else shift = "M";
      push(n.id, ymd(date), shift);
    }
  });
}

/**
 * Generate a rota-period draft schedule and return both the assignments and any
 * safety-rule violations that could not be resolved given the available staff.
 */
export function generateSchedule(opts: {
  nurses: NurseInput[];
  wards: WardInput[];
  leave: LeaveInput[];
  startDate: Date;
  days?: number;
  facility?: string;
  /** Days elapsed since the facility's very first scheduled day (period 0 = 0). */
  periodOffset?: number;
  /**
   * Actual shift assignments from the last 4 days of the previous period.
   * When supplied, the generator detects each nurse's real cycle position at
   * period end and continues from there instead of relying purely on the
   * mathematical periodOffset. Nurses with ambiguous or non-base shifts in
   * those 4 days fall back to the mathematical phase automatically.
   */
  previousAssignments?: readonly PriorAssignment[];
}): ScheduleResult {
  const { nurses, wards, leave } = opts;
  const days = opts.days ?? 28;
  const periodOffset = opts.periodOffset ?? 0;
  const prev = opts.previousAssignments ?? [];
  const out: DraftAssignment[] = [];
  const scheduled = new Set<string>();
  const allViolations: SafetyViolation[] = [];
  const allExtraShifts: ExtraShift[] = [];

  // Matrons: Morning shift Mon–Fri only, no ward, published alongside coverage nurses.
  const matrons = nurses.filter((n) => isMatron(n.role));
  for (let d = 0; d < days; d++) {
    const date = new Date(opts.startDate);
    date.setDate(date.getDate() + d);
    const dateStr = ymd(date);
    const isWeekday = date.getDay() >= 1 && date.getDay() <= 5;
    for (const matron of matrons) {
      const baseShift: ShiftCode = isWeekday ? "M" : "OFF";
      const onLeave = inLeave(leave, matron.id, dateStr);
      out.push({
        nurse_id: matron.id,
        ward: null,
        shift_date: dateStr,
        shift: onLeave ? "LEAVE" : baseShift,
        ...(onLeave
          ? { pre_leave_shift: baseShift, leave_type: leaveTypeFor(leave, matron.id, dateStr) }
          : {}),
      });
    }
  }
  matrons.forEach((n) => scheduled.add(n.id));

  // 1. Coverage Nurses (global, not ward-bound)
  // Uses scheduleCoverageNurses: shift pattern 4M/2OFF/4N/4OFF; day only Mon–Fri
  // with a rotating Sat+Sun MWC weekend.
  const headNurses = nurses.filter((n) => isGlobalHead(n.role));
  scheduleCoverageNurses(headNurses, days, opts.startDate, leave, out, periodOffset, prev);
  headNurses.forEach((n) => scheduled.add(n.id));

  // 2. Nurse Interns— grouped by assigned ward so interns in the same ward share
  //    an identical phase (equal M/N/OFF counts).  Phases are staggered across
  //    ward-groups so different wards don't all share the same off-days.
  //    Assignments are stored with ward = null (same as Coverage Nurses) so that
  //    interns are bundled into the Coverage Nurses approval card and published
  //    together with coverage nurses, independently of any specific ward's
  //    approval timeline.
  const interns = nurses.filter((n) => isInternType(n.role));
  const internsByWard = new Map<string | null, NurseInput[]>();
  for (const intern of interns) {
    const ward = parseWards(intern.ward)[0] ?? null;
    const group = internsByWard.get(ward) ?? [];
    group.push(intern);
    internsByWard.set(ward, group);
  }
  const internGroupList = [...internsByWard.entries()];
  const numInternGroups = internGroupList.length;
  for (let gi = 0; gi < numInternGroups; gi++) {
    const [, rawGroup] = internGroupList[gi];
    // Sort by ID for stable, DB-order-independent phase assignment.
    const group = [...rawGroup].sort((a, b) => a.id.localeCompare(b.id));
    const stagger =
      numInternGroups > 1 ? Math.round((gi * NURSE_CYCLE.length) / numInternGroups) : 0;
    // Schedule interns as a group (not individually) so their phases are staggered
    // across nurses, mirroring the ward nurse pattern.
    scheduleGroup(
      group,
      NURSE_CYCLE,
      days,
      opts.startDate,
      leave,
      null,
      out,
      periodOffset + stagger,
      prev,
    );
    group.forEach((intern) => scheduled.add(intern.id));
  }

  // 4. Porters (facility-level, ward=null — grouped with coverage nurses for approval)
  //    porter-day: 4M→4OFF only.  porter: full 4M→4OFF→4N→4OFF cycle.
  const porterDay = nurses.filter((n) => isPorterDayType(n.role));
  const porterRegular = nurses.filter((n) => isPorterType(n.role) && !isPorterDayType(n.role));
  scheduleGroup(
    porterDay,
    DAY_ONLY_CYCLE,
    days,
    opts.startDate,
    leave,
    null,
    out,
    periodOffset + stableGroupOffset(porterDay) * 4,
    prev,
  );
  scheduleGroup(
    porterRegular,
    NURSE_CYCLE,
    days,
    opts.startDate,
    leave,
    null,
    out,
    periodOffset + stableGroupOffset(porterRegular) * 4,
    prev,
  );
  porterDay.forEach((n) => scheduled.add(n.id));
  porterRegular.forEach((n) => scheduled.add(n.id));

  // 5. Per-ward scheduling (supervisors, regulars, NAs, NA-Day) + safety rule enforcement
  // All roles use the universal 16-day NURSE_CYCLE (4M→4OFF→4N→4OFF).
  // NA-Day nurses are ward-specific and use DAY_ONLY_CYCLE (morning-only) per ward.

  for (const ward of wards) {
    const wardNurses = nurses.filter(
      (n) =>
        parseWards(n.ward)[0] === ward.name &&
        !isGlobalHead(n.role) &&
        !isInternType(n.role) &&
        !isMatron(n.role) &&
        !isPorterType(n.role),
    );

    // Sort each sub-group by ID for stable, DB-order-independent scheduling.
    // A per-group phase seed (multiple of 4 = one full block) is added so that
    // different ward sub-groups don't all start at the same cycle position.
    const supervisors = wardNurses
      .filter((n) => isWardSupervisor(n.role))
      .sort((a, b) => a.id.localeCompare(b.id));
    // Surgical Nurse - Day always gets DAY_ONLY_CYCLE regardless of the ward cycle,
    // so they are split out from regulars and scheduled separately.
    const surgicalDay = wardNurses
      .filter((n) => isSurgicalNurseDayType(n.role))
      .sort((a, b) => a.id.localeCompare(b.id));
    const regulars = wardNurses
      .filter(
        (n) => !isNAType(n.role) && !isWardSupervisor(n.role) && !isSurgicalNurseDayType(n.role),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    const naRegular = wardNurses
      .filter((n) => isNAType(n.role) && !isNADayType(n.role))
      .sort((a, b) => a.id.localeCompare(b.id));
    const naDay = wardNurses
      .filter((n) => isNADayType(n.role))
      .sort((a, b) => a.id.localeCompare(b.id));

    const supervisorSeed = stableGroupOffset(supervisors) * 4;
    const surgicalDaySeed = stableGroupOffset(surgicalDay) * 4;
    const regularSeed = stableGroupOffset(regulars) * 4;
    const naRegularSeed = stableGroupOffset(naRegular) * 4;
    const naDaySeed = stableGroupOffset(naDay) * 4;

    // Morning-only wards use 4M→4OFF cycle for all ward nurses so they never
    // get night shifts scheduled.  Full-cycle wards use the standard 4M→4OFF→4N→4OFF.
    const wardCycle = isMorningOnlyWard(ward) ? DAY_ONLY_CYCLE : NURSE_CYCLE;
    // NAs get their own cycle decision: min_night_na === 0 means this ward never
    // needs an NA at night, independent of whether ward nurses still cover nights
    // (e.g. Operation Theatre can staff nurses overnight while NAs stay day-only).
    // Falls back to wardCycle so a fully morning-only ward still applies there too.
    const naCycle = ward.min_night_na === 0 ? DAY_ONLY_CYCLE : wardCycle;
    // Oncology/Dialysis: every role in the ward is weekday-mornings-only —
    // overrides whatever cycle would otherwise apply, cycle param below is
    // ignored by scheduleGroup when this is true.
    const fixedWeekday = isFixedWeekdayWard(ward);

    scheduleGroup(
      supervisors,
      wardCycle,
      days,
      opts.startDate,
      leave,
      ward.name,
      out,
      periodOffset + supervisorSeed,
      prev,
      fixedWeekday,
    );
    // Surgical Nurse - Day: always the fixed calendar Mon-Fri M / Sat-Sun OFF
    // pattern (same as Matrons), regardless of which ward they're in — a role
    // guarantee, not something that should depend on whether THIS ward
    // happens to also be a fixedWeekday ward (Oncology/Dialysis). `true` is
    // hardcoded here rather than reusing the ward-level `fixedWeekday`
    // variable for that reason. The `cycle` argument (DAY_ONLY_CYCLE) is
    // inert when fixedWeekday is true — scheduleGroup ignores it entirely.
    scheduleGroup(
      surgicalDay,
      DAY_ONLY_CYCLE,
      days,
      opts.startDate,
      leave,
      ward.name,
      out,
      periodOffset + surgicalDaySeed,
      prev,
      true,
    );
    // Ikoyi GOPD: night duty is a single rotating slot (one nurse at a
    // time), not the normal per-nurse staggered cycle — see
    // isSingleNightSlotWard's comment for why.
    if (isSingleNightSlotWard(ward)) {
      scheduleSingleNightSlotWard(
        regulars,
        days,
        opts.startDate,
        leave,
        ward.name,
        out,
        periodOffset + regularSeed,
        prev,
      );
    } else {
      scheduleGroup(
        regulars,
        wardCycle,
        days,
        opts.startDate,
        leave,
        ward.name,
        out,
        periodOffset + regularSeed,
        prev,
        fixedWeekday,
      );
    }
    scheduleGroup(
      naRegular,
      naCycle,
      days,
      opts.startDate,
      leave,
      ward.name,
      out,
      periodOffset + naRegularSeed,
      prev,
      fixedWeekday,
    );
    scheduleGroup(
      naDay,
      DAY_ONLY_CYCLE,
      days,
      opts.startDate,
      leave,
      ward.name,
      out,
      periodOffset + naDaySeed,
      prev,
      fixedWeekday,
    );

    // Only validate safety rules for wards that have staff in this run.
    // If wardNurses is empty (e.g. generating only for IP Ward, so ER has
    // no nurses here), we skip enforcement — it would always report violations
    // of every minimum since there is literally nobody scheduled.
    if (wardNurses.length > 0) {
      const { violations: wardViolations, extraPromos } = enforceMinima(
        out,
        wardNurses,
        ward,
        days,
        opts.startDate,
      );
      allViolations.push(...wardViolations);
      for (const [id, count] of extraPromos) {
        const nurse = wardNurses.find((n) => n.id === id);
        if (nurse) allExtraShifts.push({ nurseId: id, nurseName: nurse.name, extraCount: count });
      }
    }
    wardNurses.forEach((n) => scheduled.add(n.id));
  }

  // 4. Unassigned nurses — OFF or LEAVE for every day
  for (let d = 0; d < days; d++) {
    const date = new Date(opts.startDate);
    date.setDate(date.getDate() + d);
    const dateStr = ymd(date);
    for (const nurse of nurses) {
      if (scheduled.has(nurse.id)) continue;
      const onLeave = inLeave(leave, nurse.id, dateStr);
      out.push({
        nurse_id: nurse.id,
        ward: nurse.ward,
        shift_date: dateStr,
        shift: onLeave ? "LEAVE" : "OFF",
        ...(onLeave ? { leave_type: leaveTypeFor(leave, nurse.id, dateStr) } : {}),
      });
    }
  }

  return { assignments: out, violations: allViolations, extraShifts: allExtraShifts };
}
