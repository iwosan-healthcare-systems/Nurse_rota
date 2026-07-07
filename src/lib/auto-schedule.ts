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

function parseWards(ward: string | null): string[] {
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

export function isGlobalHead(role: string) {
  return /^(head|coverage)\s*nurse$/i.test(role);
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

  for (let d = 0; d < days; d++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + d);
    const dateStr = ymd(date);
    for (const nurse of byId) {
      const offset = (nurseBlock.get(nurse.id) ?? 0) * 4;
      out.push({
        nurse_id: nurse.id,
        ward: wardName,
        shift_date: dateStr,
        shift: inLeave(leave, nurse.id, dateStr)
          ? "LEAVE"
          : cycle[(((phase + d + offset) % len) + len) % len],
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
 *   2. NC block    — 4 consecutive NC shifts; PHASE-ALIGNED so NC always lands at the
 *                    nurse's natural N-block position → the 4 OFFs before and after NC
 *                    are already guaranteed by the cycle (M,M,M,M,OFF,OFF,OFF,OFF,
 *                    NC,NC,NC,NC,OFF,OFF,OFF,OFF → resume M)
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

  // First day d ∈ [0, CL) in this period where nurse i's N block begins.
  // Solves: (periodOffset + d + phase) % CL = 8 → d = (8 − (periodOffset + phase) % CL + CL) % CL
  function nBlockStartDay(i: number): number {
    return (8 - ((periodOffset + nursePhase(i)) % CL) + CL) % CL;
  }

  // ── Phase-aligned NC assignment ──────────────────────────────────────────
  // For each NC slot (a day where some nurse's N block starts), collect candidate nurses.
  // Each nurse contributes their first N-block start day and, if it fits within the
  // period, a second occurrence 16 days later.
  const slotCandidates = new Map<number, number[]>();
  for (let i = 0; i < N; i++) {
    const first = nBlockStartDay(i);
    for (const slot of [first, first + CL]) {
      if (slot + 3 >= days) continue; // NC block must finish within the period
      if (!slotCandidates.has(slot)) slotCandidates.set(slot, []);
      slotCandidates.get(slot)!.push(i);
    }
  }

  // Assign ONE nurse per NC slot, rotating each period.
  // First pass: prefer nurses with no NC block yet this period (dedup).
  // Fallback: if all candidates already have NC, allow a second assignment so
  // every NC slot is covered — the nurse doing two NC blocks is the least-recently
  // used candidate to spread the extra load fairly.
  const ncStartDays = new Map<number, number[]>(); // nurseIdx → all NC start days
  const ncAssigned = new Set<number>();
  for (const slot of [...slotCandidates.keys()].sort((a, b) => a - b)) {
    const candidates = slotCandidates.get(slot)!;
    let covered = false;
    for (let attempt = 0; attempt < candidates.length; attempt++) {
      const candidate = candidates[(periodsElapsed + seed + attempt) % candidates.length];
      if (!ncAssigned.has(candidate)) {
        if (!ncStartDays.has(candidate)) ncStartDays.set(candidate, []);
        ncStartDays.get(candidate)!.push(slot);
        ncAssigned.add(candidate);
        covered = true;
        break;
      }
    }
    // All candidates already have NC — allow a second block so the slot isn't empty.
    if (!covered && candidates.length > 0) {
      const candidate = candidates[(periodsElapsed + seed) % candidates.length];
      if (!ncStartDays.has(candidate)) ncStartDays.set(candidate, []);
      ncStartDays.get(candidate)!.push(slot);
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

  for (let d = 0; d < days; d++) {
    const satDate = new Date(startDate);
    satDate.setDate(satDate.getDate() + d);
    if (satDate.getDay() !== 6) continue; // process each Saturday only

    // Exclude nurses whose NC block or post-NC rest covers Saturday (d) or Sunday (d+1),
    // AND nurses whose NC block starts on Monday (d+2) or Tuesday (d+3) — assigning MWC
    // to such a nurse would cause NC (highest-priority check) to override the forced M/OFF
    // assignments that immediately follow MWC, creating 6+ consecutive shift blocks.
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

    let mwcNurse = -1;
    for (let attempt = 0; attempt < N; attempt++) {
      const candidate = (weekendDutyIdx + attempt) % N;
      if (!excluded.has(candidate)) {
        mwcNurse = candidate;
        weekendDutyIdx = (candidate + 1) % N;
        break;
      }
    }
    if (mwcNurse < 0) continue;

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
          : (periodOffset + (d - 1) + nursePhase(mwcNurse)) % CL;

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

  // ── Main scheduling loop ──────────────────────────────────────────────────
  for (let d = 0; d < days; d++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + d);
    const dateStr = ymd(date);

    for (let i = 0; i < N; i++) {
      if (inLeave(leave, group[i].id, dateStr)) {
        out.push({ nurse_id: group[i].id, ward: null, shift_date: dateStr, shift: "LEAVE" });
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
            : NURSE_CYCLE[
                (((periodOffset + d + (nurseBlock.get(group[i].id) ?? 0) * 4) % CL) + CL) % CL
              ];
      }

      out.push({ nurse_id: group[i].id, ward: null, shift_date: dateStr, shift });
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
}): ScheduleResult {
  const { nurses, wards, leave } = opts;
  const days = opts.days ?? 28;
  const periodOffset = opts.periodOffset ?? 0;
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
      out.push({
        nurse_id: matron.id,
        ward: null,
        shift_date: dateStr,
        shift: inLeave(leave, matron.id, dateStr) ? "LEAVE" : isWeekday ? "M" : "OFF",
      });
    }
  }
  matrons.forEach((n) => scheduled.add(n.id));

  // 1. Coverage Nurses (global, not ward-bound)
  // Uses scheduleCoverageNurses: weekends → MWC, first weekday N → NC, rest stay N.
  const headNurses = nurses.filter((n) => isGlobalHead(n.role));
  scheduleCoverageNurses(headNurses, days, opts.startDate, leave, out, periodOffset);
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
  );
  porterDay.forEach((n) => scheduled.add(n.id));
  porterRegular.forEach((n) => scheduled.add(n.id));

  // 4b. Nursing Assistant - Day (facility-level, ward=null — same pattern as porter-day).
  //     Treated as facility-wide regardless of any ward field, so they always get
  //     DAY_ONLY_CYCLE even when a ward is set in their profile.
  //     They are excluded from the per-ward loop below to avoid double-scheduling.
  const naFacilityDay = nurses.filter((n) => isNADayType(n.role));
  scheduleGroup(
    naFacilityDay,
    DAY_ONLY_CYCLE,
    days,
    opts.startDate,
    leave,
    null,
    out,
    periodOffset + stableGroupOffset(naFacilityDay) * 4,
  );
  naFacilityDay.forEach((n) => scheduled.add(n.id));

  // 5. Per-ward scheduling (supervisors, regulars, NAs) + safety rule enforcement
  // All roles use the universal 16-day NURSE_CYCLE (4M→4OFF→4N→4OFF).

  for (const ward of wards) {
    const wardNurses = nurses.filter(
      (n) =>
        parseWards(n.ward)[0] === ward.name &&
        !isGlobalHead(n.role) &&
        !isInternType(n.role) &&
        !isMatron(n.role) &&
        !isPorterType(n.role) &&
        !isNADayType(n.role),
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

    scheduleGroup(
      supervisors,
      wardCycle,
      days,
      opts.startDate,
      leave,
      ward.name,
      out,
      periodOffset + supervisorSeed,
    );
    // Surgical Nurse - Day: always morning-only (4M→4OFF), even in a full-cycle ward.
    scheduleGroup(
      surgicalDay,
      DAY_ONLY_CYCLE,
      days,
      opts.startDate,
      leave,
      ward.name,
      out,
      periodOffset + surgicalDaySeed,
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
    );
    scheduleGroup(
      naRegular,
      wardCycle,
      days,
      opts.startDate,
      leave,
      ward.name,
      out,
      periodOffset + naRegularSeed,
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
    );

    // NA-Day nurses assigned to this ward in their profile still count toward
    // the ward's morning NA minimum even though they're scheduled facility-wide
    // (ward=null). Include them in enforceMinima so their M shifts are counted.
    const naDayForWard = nurses.filter(
      (n) => isNADayType(n.role) && parseWards(n.ward)[0] === ward.name,
    );

    // Only validate safety rules for wards that have staff in this run.
    // If wardNurses is empty (e.g. generating only for IP Ward, so ER has
    // no nurses here), we skip enforcement — it would always report violations
    // of every minimum since there is literally nobody scheduled.
    if (wardNurses.length > 0) {
      const { violations: wardViolations, extraPromos } = enforceMinima(
        out,
        [...wardNurses, ...naDayForWard],
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
