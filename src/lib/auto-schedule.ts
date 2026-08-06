// Auto-scheduling engine for the 28-day rota.
//
// Universal 16-day cycle for ALL roles (strict, no override): 4M → 4OFF → 4N → 4OFF
//   Offsets are snapped to 4-day block boundaries so every nurse always starts
//   at the beginning of a block (never mid-block).
//   enforceMinima reports safety violations only — it does not modify any assignments.
//
// Coverage nurses follow a bespoke per-period pattern:
//   NC block  : 4 consecutive NC shifts, phase-aligned to the nurse's natural N block
//               and rotating lead nurse each period
//   Post-NC   : 4 forced OFF days immediately after the NC block
//   Post-NC+  : staggered default cycle (NC alignment guarantees it resumes correctly)
//   MWC       : one nurse per weekend rotates Sat+Sun MWC duty
//   Fri/Mon/Tue/Wed : 4 forced OFFs for the MWC nurse (1 before + 3 after)
//   Post-MWC+ : staggered default cycle resumes (same stable block as scheduleGroup)
//   Default   : stable-block staggered cycle -- continuous across period boundaries
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
      const startPos =
        phaseOverrides.get(nurse.id) ?? (((phase + offset) % len) + len) % len;
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
        ...(onLeave ? { pre_leave_shift: baseShift } : {}),
      });
    }
  }
}

/**
 * Check ward minimum staffing for every day in the window and report violations.
 * Does not modify any assignments — report only.
 */
function enforceMinima(
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

/**
 * Schedule coverage nurses (global, not ward-bound).
 *
 * Per-period pattern for each nurse (priority order, highest first):
 *   1. LEAVE       — approved leave overrides everything
 *   2. NC block    — 4 consecutive NC shifts; laid down as a CONTINUOUS, gapless
 *                    round-robin across the whole period (block 0-3, 4-7, 8-11, …),
 *                    cycling through eligible nurses — every night is covered by
 *                    exactly one nurse's NC block, never zero, never two at once.
 *   3. MWC         — Sat+Sun for the rotating MWC duty nurse
 *   4. Fri/Mon/Tue/Wed — 4 forced OFFs for the MWC nurse (OFF,MWC,MWC,OFF,OFF,OFF)
 *   5. Post-NC     — 4 forced OFF days immediately after the NC block
 *   6. Post-NC+    — resume NURSE_CYCLE from position 0 (4M first)
 *   7. Post-MWC+   — resume NURSE_CYCLE from position 0 the Thursday after MWC block
 *   8. Default     — NURSE_CYCLE with 4-block staggered phase
 *                    Morning shifts (M) on weekends → OFF; night shifts (N) are
 *                    unaffected — night coverage continues 7 days/week.
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
  const N = group.length;
  if (N === 0) return;

  const CL = NURSE_CYCLE.length; // 16
  const numBlocks = CL / 4; // 4
  const periodsElapsed = Math.round(periodOffset / days);
  const seed = stableGroupOffset(group);

  // Stable block assignment -- same pattern as scheduleGroup so coverage nurses'
  // default cycle is continuous across period boundaries.
  const idRank = new Map(group.map((n, i) => [n.id, i]));
  const forAssignment = [...group].sort((a, b) => {
    const tDiff = (b.target_hours ?? 0) - (a.target_hours ?? 0);
    if (tDiff !== 0) return tDiff;
    return (idRank.get(a.id) ?? 0) - (idRank.get(b.id) ?? 0);
  });
  const nurseBlock = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    const slot = Math.round((i * numBlocks) / N) % numBlocks;
    nurseBlock.set(forAssignment[i].id, slot);
  }

  // Phase offset (0, 4, 8, or 12) for nurse i -- uses the stable block assignment.
  function nursePhase(i: number): number {
    return (nurseBlock.get(group[i].id) ?? 0) * 4;
  }

  // Detect actual cycle positions from end of previous period.
  const phaseOverrides = buildPhaseOverrides(group, prev, NURSE_CYCLE);

  // Effective cycle position at day 0 of this period for nurse i.
  // Uses the detected actual position when available (honours manual edits made
  // at the end of the previous period); falls back to the mathematical formula.
  function nurseEffectiveBase(i: number): number {
    return phaseOverrides.get(group[i].id) ?? ((periodOffset + nursePhase(i)) % CL);
  }

  // ── Continuous NC round-robin ────────────────────────────────────────────
  // NC coverage must never have a gap: the moment one nurse's 4-day block
  // ends, the next nurse's block starts immediately — night coverage is a
  // 7-days-a-week duty, not something tied to each nurse's own natural N-block
  // position. Blocks are laid down back-to-back from day 0 of the period
  // (0-3, 4-7, 8-11, …), so they're non-overlapping and gapless by
  // construction, and stay continuous across period boundaries too since
  // period P+1 starts the calendar day right after period P ends.
  //
  // Cycles fairly through the pool of NC-eligible (non-Day-type) coverage
  // nurses, continuing the rotation pointer from where the previous period's
  // math would have left off (periodsElapsed * block count + seed) rather
  // than resetting to the same starting nurse every period. A nurse on leave
  // for any day within a block is skipped in favour of the next eligible
  // nurse in rotation, so leave doesn't leave the block empty.
  //
  // Selection is leave-only, unchanged — it must NOT also skip a candidate
  // for a personal-cycle rest conflict: the fixed block grid rarely lines up
  // with any given nurse's own staggered cycle phase, so filtering on that
  // would eliminate most candidates most blocks and collapse the "fair"
  // rotation onto whichever one nurse's phase happens to clear every block
  // this period (this is exactly what happened before this fix — one nurse
  // ended up with NC every single block all period while the other three
  // barely got picked at all). Instead, whoever IS picked has their own
  // conflicting lead-in days force-recorded into ncPersonalOff below, which
  // the main loop overrides to OFF — the rotation stays fair; the rest
  // requirement is satisfied by adjusting the chosen nurse's days, not by
  // choosing a different nurse.
  const eligibleForNc: number[] = [];
  for (let i = 0; i < N; i++) {
    if (!isCoverageNurseDayType(group[i].role)) eligibleForNc.push(i);
  }
  const ncStartDays = new Map<number, number[]>(); // nurseIdx → all NC start days
  const ncPersonalOff = new Map<number, Set<number>>(); // nurseIdx → day-offsets forced OFF for NC rest

  // What would nurse i actually be rendered as on day d, given everything
  // decided about them so far (their own base cycle, any earlier NC block
  // this same period, and any lead-in days already forced OFF for a PRIOR
  // block)? Blocks are assigned in chronological order below, so by the time
  // this is called for block b, every earlier block's ncStartDays/
  // ncPersonalOff entries for this nurse are already recorded — mirrors the
  // main loop's own inNcBlock/inPostNcOff/afterNcOff logic exactly, since a
  // nurse who gets a SECOND NC block this period has their lead-in days
  // governed by the resumed-cycle-after-their-first-block math, not their
  // original base phase; checking only the base phase (as an earlier version
  // of this fix did) missed that case entirely.
  function predictedShift(i: number, d: number): ShiftCode {
    if (ncPersonalOff.get(i)?.has(d)) return "OFF";
    const nurseNcStarts = ncStartDays.get(i) ?? [];
    const pastNcStarts = nurseNcStarts.filter((s) => s <= d);
    const relevantNcStart = pastNcStarts.length > 0 ? Math.max(...pastNcStarts) : undefined;
    const inNc = relevantNcStart !== undefined && d < relevantNcStart + 4;
    const inPostOff = relevantNcStart !== undefined && !inNc && d < relevantNcStart + 8;
    if (inNc) return "NC";
    if (inPostOff) return "OFF";
    // afterNcOff case — d >= relevantNcStart + 8 is guaranteed here (inNc/inPostOff already ruled out), so the offset below is never negative.
    if (relevantNcStart !== undefined) return NURSE_CYCLE[(d - (relevantNcStart + 8)) % CL];
    const pos = (((nurseEffectiveBase(i) + d) % CL) + CL) % CL;
    return NURSE_CYCLE[pos];
  }

  // The main loop always forces 4 OFF days immediately AFTER an NC block
  // (inPostNcOff, below), so the trailing rest buffer is already guaranteed.
  // Nothing equivalent protects the 4 days BEFORE a block starts, so whoever
  // the round-robin picks could otherwise go straight from real M/N duty
  // into NC with no rest between them.
  function personalCycleConflictDays(i: number, blockStart: number): number[] {
    const conflicts: number[] = [];
    for (let k = blockStart - 4; k < blockStart; k++) {
      if (k < 0) continue; // falls before this period's day 0 — nothing here to check against
      const s = predictedShift(i, k);
      if (s === "M" || s === "N") conflicts.push(k);
    }
    return conflicts;
  }

  if (eligibleForNc.length > 0) {
    const ncBlockCount = Math.floor(days / 4);
    let rotPtr = (periodsElapsed * ncBlockCount + seed) % eligibleForNc.length;
    for (let b = 0; b < ncBlockCount; b++) {
      const blockStart = b * 4;
      const blockDates: string[] = [];
      for (let k = 0; k < 4; k++) {
        const d = new Date(startDate);
        d.setDate(d.getDate() + blockStart + k);
        blockDates.push(ymd(d));
      }
      let chosen = -1;
      for (let attempt = 0; attempt < eligibleForNc.length; attempt++) {
        const candidateIdx = eligibleForNc[(rotPtr + attempt) % eligibleForNc.length];
        if (!blockDates.some((dt) => inLeave(leave, group[candidateIdx].id, dt))) {
          chosen = candidateIdx;
          rotPtr += attempt + 1;
          break;
        }
      }
      if (chosen === -1) continue; // every eligible nurse is on leave this block
      if (!ncStartDays.has(chosen)) ncStartDays.set(chosen, []);
      ncStartDays.get(chosen)!.push(blockStart);

      const conflicts = personalCycleConflictDays(chosen, blockStart);
      if (conflicts.length > 0) {
        if (!ncPersonalOff.has(chosen)) ncPersonalOff.set(chosen, new Set());
        const set = ncPersonalOff.get(chosen)!;
        for (const k of conflicts) set.add(k);
      }
    }
  }

  // ── MWC pre-pass ──────────────────────────────────────────────────────────
  // mwcByDate         : dateStr (Sat or Sun) → nurseIdx on MWC duty
  // mwcForcedOff      : dateStr (Fri / Mon / Tue / Wed) → set of nurseIdx forced OFF
  // mwcNurseResumeDays: nurseIdx → resume entries (day + cycle offset) per MWC block
  const mwcByDate = new Map<string, number>();
  const mwcForcedOff = new Map<string, Set<number>>();
  const mwcForcedM = new Map<string, Set<number>>();
  // nurseIdx → [{resumeAt, cycleOffset}] for each MWC weekend this period.
  // cycleOffset 0 → resume M (non-M case); cycleOffset 8 → resume N (M-block case).
  const mwcNurseResumeDays = new Map<number, Array<{ resumeAt: number; cycleOffset: number }>>();
  let weekendDutyIdx = (periodsElapsed * 4 + seed) % N;
  // Track who has already received an MWC block this period so no nurse gets
  // a second block before every other eligible nurse has had their first.
  const mwcAssignedThisPeriod = new Set<number>();

  for (let d = 0; d < days; d++) {
    const satDate = new Date(startDate);
    satDate.setDate(satDate.getDate() + d);
    if (satDate.getDay() !== 6) continue; // process each Saturday only

    // Exclude nurses whose NC block or post-NC rest covers Saturday (d) or Sunday (d+1),
    // AND nurses whose NC block starts on Monday (d+2) or Tuesday (d+3) — assigning MWC
    // to such a nurse would cause NC (highest-priority check) to override the forced M/OFF
    // assignments that immediately follow MWC, creating 6+ consecutive shift blocks.
    // Also exclude nurses on approved leave during this weekend — assigning them MWC
    // wastes the rotation slot (LEAVE overrides MWC in the main loop), which causes the
    // rotation to skip that nurse and potentially double-assign another nurse later.
    const excluded = new Set<number>();
    for (const [nurseIdx, starts] of ncStartDays) {
      for (const startD of starts) {
        if ((d >= startD && d < startD + 8) || (d + 1 >= startD && d + 1 < startD + 8)) {
          excluded.add(nurseIdx);
        }
        if (startD >= d + 2 && startD <= d + 3) {
          excluded.add(nurseIdx);
        }
      }
    }
    const satStr = ymd(satDate);
    const sunDate = new Date(satDate);
    sunDate.setDate(sunDate.getDate() + 1);
    const sunStr = ymd(sunDate);
    for (let ni = 0; ni < N; ni++) {
      if (inLeave(leave, group[ni].id, satStr) || inLeave(leave, group[ni].id, sunStr)) {
        excluded.add(ni);
      }
    }

    // Prefer nurses who haven't had MWC this period (round-robin fairness).
    // Only fall back to repeating a nurse if every non-excluded nurse has already
    // had an MWC block this period.
    let mwcNurse = -1;
    for (let attempt = 0; attempt < N; attempt++) {
      const candidate = (weekendDutyIdx + attempt) % N;
      if (!excluded.has(candidate) && !mwcAssignedThisPeriod.has(candidate)) {
        mwcNurse = candidate;
        weekendDutyIdx = (candidate + 1) % N;
        break;
      }
    }
    if (mwcNurse < 0) {
      // All available nurses already have an MWC block this period — allow repeats.
      for (let attempt = 0; attempt < N; attempt++) {
        const candidate = (weekendDutyIdx + attempt) % N;
        if (!excluded.has(candidate)) {
          mwcNurse = candidate;
          weekendDutyIdx = (candidate + 1) % N;
          break;
        }
      }
    }
    if (mwcNurse < 0) continue;
    mwcAssignedThisPeriod.add(mwcNurse);

    mwcByDate.set(ymd(satDate), mwcNurse); // Saturday
    if (d + 1 < days) {
      const sunDate = new Date(startDate);
      sunDate.setDate(sunDate.getDate() + d + 1);
      mwcByDate.set(ymd(sunDate), mwcNurse); // Sunday
    }

    // Compute the effective cycle position on the Friday before MWC.
    // If the nurse already had NC this period their cycle restarted from M at (ncS+8),
    // so use that effective position rather than the staggered base cycle.
    const nurseNcStarts = ncStartDays.get(mwcNurse) ?? [];
    const pastStarts = nurseNcStarts.filter((s) => s <= d - 1);
    const ncS = pastStarts.length > 0 ? Math.max(...pastStarts) : undefined;
    const fridayCyclePos =
      d === 0
        ? CL - 4 // no prior Friday: treat as 2nd OFF block (pos 12)
        : ncS !== undefined && d - 1 >= ncS + 8
          ? (d - 1 - (ncS + 8)) % CL
          : (nurseEffectiveBase(mwcNurse) + (d - 1)) % CL;

    // Which phase the nurse is in on Friday determines both whether a pre-MWC
    // rest day is needed and what phase follows after the post-MWC OFFs:
    //   pos 0-3  (M block)       : MWC merges into M; 4 OFFs after (Mon-Thu); resume N Fri.
    //   pos 4-5  (early 1st OFF) : Fri naturally OFF; 3 OFFs (Mon-Wed) after → N Thu.
    //   pos 6-7  (deep 1st OFF)  : 3+ OFFs already precede; add M M Mon/Tue after MWC;
    //                              4 OFFs after M M; resume N.
    //                              pattern: OFF OFF OFF MWC MWC M M OFF OFF OFF OFF → N …
    //   pos 8-11 (N block)       : force Fri OFF; 3 OFFs (Mon-Wed) after → M Thu.
    //   pos 12-15 (2nd OFF)      : N already done; Fri naturally OFF; 3 OFFs (Mon-Wed) → M Thu.
    const mBlockOnFriday = fridayCyclePos < 4;
    const deepFirstOff = fridayCyclePos >= 6 && fridayCyclePos < 8;
    const cycleOffset = fridayCyclePos < 8 ? 8 : 0; // before N-phase done → N; else → M
    const resumeAt = mBlockOnFriday ? d + 6 : deepFirstOff ? d + 8 : d + 5;
    if (!mwcNurseResumeDays.has(mwcNurse)) mwcNurseResumeDays.set(mwcNurse, []);
    mwcNurseResumeDays.get(mwcNurse)!.push({ resumeAt, cycleOffset });

    // Forced OFFs (and forced M for deep-1st-OFF case) around MWC:
    //   M-block (pos 0-3)       : no pre-MWC Fri OFF; 4 OFFs (Mon-Thu) after → N Fri
    //   1st OFF early (pos 4-5) : Fri naturally OFF; 3 OFFs (Mon-Wed) after → N Thu
    //   1st OFF deep (pos 6-7)  : Fri naturally OFF; M Mon/Tue; 4 OFFs (Wed-Sat) → N Sun
    //   N block (pos 8-11)      : force Fri OFF; 3 OFFs (Mon-Wed) after → M Thu
    //   2nd OFF (pos 12-15)     : Fri naturally OFF; 3 OFFs (Mon-Wed) after → M Thu
    const forcedOffDays = mBlockOnFriday
      ? [d + 2, d + 3, d + 4, d + 5]
      : deepFirstOff
        ? [d + 4, d + 5, d + 6, d + 7]
        : [d - 1, d + 2, d + 3, d + 4];
    for (const off of forcedOffDays) {
      if (off < 0 || off >= days) continue;
      const offDate = new Date(startDate);
      offDate.setDate(offDate.getDate() + off);
      const offStr = ymd(offDate);
      if (!mwcForcedOff.has(offStr)) mwcForcedOff.set(offStr, new Set());
      mwcForcedOff.get(offStr)!.add(mwcNurse);
    }

    // Deep-1st-OFF: force M shifts on the two days immediately after MWC weekend.
    if (deepFirstOff) {
      for (const mDay of [d + 2, d + 3]) {
        if (mDay < 0 || mDay >= days) continue;
        const mDate = new Date(startDate);
        mDate.setDate(mDate.getDate() + mDay);
        const mStr = ymd(mDate);
        if (!mwcForcedM.has(mStr)) mwcForcedM.set(mStr, new Set());
        mwcForcedM.get(mStr)!.add(mwcNurse);
      }
    }
  }

  // ── NC-vs-MWC rest-buffer guard ────────────────────────────────────────────
  // personalCycleBlocksNcLeadIn (above) already keeps the round-robin from
  // picking a candidate whose own M/OFF/N/OFF cycle occupies its block's
  // lead-in — but that check runs before the MWC pre-pass exists yet, so it
  // can't see MWC's forced-M/MWC-duty days, which are decided afterwards and
  // can independently land on the same lead-in window. Catch that narrower
  // case here: if MWC ended up forcing real duty onto an already-chosen NC
  // block's lead-in days, drop that NC start entirely rather than let the
  // block start with no rest before it — the nurse just continues on their
  // default cycle for that stretch instead, which is always rest-safe.
  for (const [nurseIdx, starts] of [...ncStartDays.entries()]) {
    const validStarts = starts.filter((start) => {
      for (let k = start - 4; k < start; k++) {
        if (k < 0) continue; // lead-in falls before this period — nothing to conflict with
        const kDate = new Date(startDate);
        kDate.setDate(kDate.getDate() + k);
        const kStr = ymd(kDate);
        if (mwcForcedM.get(kStr)?.has(nurseIdx)) return false;
        if (mwcByDate.get(kStr) === nurseIdx) return false;
      }
      return true;
    });
    if (validStarts.length === starts.length) continue;
    if (validStarts.length > 0) ncStartDays.set(nurseIdx, validStarts);
    else ncStartDays.delete(nurseIdx);
  }

  // ── Main scheduling loop ──────────────────────────────────────────────────
  for (let d = 0; d < days; d++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + d);
    const dateStr = ymd(date);

    for (let i = 0; i < N; i++) {
      const onLeave = inLeave(leave, group[i].id, dateStr);

      // Coverage Nurse - Day: matron-style fixed weekly pattern (Mon-Fri M,
      // Sat/Sun OFF) — NOT the rotating 4-on-4-off NURSE_CYCLE regular
      // (night-based) Coverage Nurses use. The only thing they share with the
      // rotation is the MWC weekend-duty pool: mwcByDate is computed once above
      // over the whole group (day nurses included — they're never excluded from
      // it, since that exclusion is purely NC-conflict-based and they never have
      // an NC block), so when it's their turn they get MWC that Sat/Sun — padded
      // with the Friday before and Monday after also OFF (Fri OFF, Sat MWC, Sun
      // MWC, Mon OFF), then normal M Tue-Fri resumes. Skips the regular
      // machinery's forced-off/forced-M/resume-day logic entirely — that varies
      // by night-cycle phase, which doesn't apply here; the day-nurse pattern
      // around MWC is the same fixed 4-day shape every time.
      if (isCoverageNurseDayType(group[i].role)) {
        const dow = date.getDay(); // 0 = Sun .. 6 = Sat
        let shift: ShiftCode;
        if (mwcByDate.get(dateStr) === i) {
          shift = "MWC";
        } else if (dow === 5) {
          // Friday: OFF if tomorrow (Saturday) starts this nurse's MWC block.
          const sat = new Date(date);
          sat.setDate(sat.getDate() + 1);
          shift = mwcByDate.get(ymd(sat)) === i ? "OFF" : "M";
        } else if (dow === 1) {
          // Monday: OFF if yesterday (Sunday) was this nurse's MWC block.
          const sun = new Date(date);
          sun.setDate(sun.getDate() - 1);
          shift = mwcByDate.get(ymd(sun)) === i ? "OFF" : "M";
        } else if (dow === 0 || dow === 6) {
          shift = "OFF"; // ordinary (non-MWC) weekend
        } else {
          shift = "M"; // ordinary Tue-Thu
        }
        out.push({
          nurse_id: group[i].id,
          ward: null,
          shift_date: dateStr,
          shift: onLeave ? "LEAVE" : shift,
          ...(onLeave ? { pre_leave_shift: shift } : {}),
        });
        continue;
      }

      // Find the most recently started NC block at or before day d.
      // A nurse may have multiple NC blocks if all candidates were exhausted for a slot.
      const nurseNcStarts = ncStartDays.get(i) ?? [];
      const pastNcStarts = nurseNcStarts.filter((s) => s <= d);
      const relevantNcStart = pastNcStarts.length > 0 ? Math.max(...pastNcStarts) : undefined;
      const inNcBlock = relevantNcStart !== undefined && d < relevantNcStart + 4;
      const inPostNcOff = relevantNcStart !== undefined && !inNcBlock && d < relevantNcStart + 8;
      const afterNcOff = relevantNcStart !== undefined && !inNcBlock && !inPostNcOff;

      let shift: ShiftCode;
      if (inNcBlock) {
        // NC always lands at the nurse's natural N-block position, so the 4 OFFs
        // before (cycle positions 4-7) and after (cycle positions 12-15) are
        // already in place — no separate pre-NC OFF injection needed.
        shift = "NC";
      } else if (ncPersonalOff.get(i)?.has(d)) {
        // This nurse's own personal M/OFF/N/OFF cycle would otherwise have
        // put them on real M or N duty here, immediately before an NC block
        // the fair round-robin assigned them (see ncPersonalOff above) — the
        // block itself is not moved (that would break the fixed, gapless
        // coverage grid), so the rest requirement is met by overriding just
        // these lead-in days to OFF instead.
        shift = "OFF";
      } else if (mwcByDate.get(dateStr) === i) {
        shift = "MWC";
      } else if (mwcForcedM.get(dateStr)?.has(i)) {
        // Forced M shifts Mon/Tue after MWC when nurse was deep in 1st OFF block (pos 6-7).
        shift = "M";
      } else if (mwcForcedOff.get(dateStr)?.has(i)) {
        // Forced OFFs around MWC weekend (see pre-pass for exact days per case).
        shift = "OFF";
      } else if (inPostNcOff) {
        // Mandatory 4-day rest after the NC block.
        shift = "OFF";
      } else if (afterNcOff) {
        // If MWC occurred after NC, MWC resume overrides the NC-resumed cycle.
        // Otherwise resume NURSE_CYCLE from position 0 (M → …) after NC + rest.
        let mwcResumeAt: number | undefined;
        let mwcCycleOffset = 0;
        const ncMwcEntries = mwcNurseResumeDays.get(i);
        if (ncMwcEntries) {
          for (const entry of ncMwcEntries) {
            // Only apply MWC resume if it falls after the NC+rest period; a MWC that
            // happened before or during NC was overridden by the NC block and is stale.
            if (d >= entry.resumeAt && entry.resumeAt > relevantNcStart! + 8) {
              mwcResumeAt = entry.resumeAt;
              mwcCycleOffset = entry.cycleOffset;
            }
          }
        }
        shift =
          mwcResumeAt !== undefined
            ? NURSE_CYCLE[(d - mwcResumeAt + mwcCycleOffset) % CL]
            : NURSE_CYCLE[(d - (relevantNcStart! + 8)) % CL];
      } else {
        // Compute base shift: post-MWC resumed cycle or the regular staggered cycle.
        // cycleOffset 8 → resume N (M-block MWC); cycleOffset 0 → resume M (other).
        let mwcResumeAt: number | undefined;
        let mwcCycleOffset = 0;
        const resumeEntries = mwcNurseResumeDays.get(i);
        if (resumeEntries) {
          for (const entry of resumeEntries) {
            if (d >= entry.resumeAt) {
              mwcResumeAt = entry.resumeAt;
              mwcCycleOffset = entry.cycleOffset;
            }
          }
        }
        shift =
          mwcResumeAt !== undefined
            ? NURSE_CYCLE[(d - mwcResumeAt + mwcCycleOffset) % CL]
            : NURSE_CYCLE[(nurseEffectiveBase(i) + d) % CL];
      }

      out.push({
        nurse_id: group[i].id,
        ward: null,
        shift_date: dateStr,
        shift: onLeave ? "LEAVE" : shift,
        ...(onLeave ? { pre_leave_shift: shift } : {}),
      });
    }
  }
}

/**
 * Generate a 28-day draft schedule and return both the assignments and any
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
        ...(onLeave ? { pre_leave_shift: baseShift } : {}),
      });
    }
  }
  matrons.forEach((n) => scheduled.add(n.id));

  // 1. Coverage Nurses (global, not ward-bound)
  // Uses scheduleCoverageNurses: weekends → MWC, first weekday N → NC, rest stay N.
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
      out.push({
        nurse_id: nurse.id,
        ward: nurse.ward,
        shift_date: dateStr,
        shift: inLeave(leave, nurse.id, dateStr) ? "LEAVE" : "OFF",
      });
    }
  }

  return { assignments: out, violations: allViolations, extraShifts: allExtraShifts };
}
