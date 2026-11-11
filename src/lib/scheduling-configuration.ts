export type WorkShift = {
  code: string;
  name: string;
  start: string;
  end: string;
  endDayOffset: number;
  breakMinutes: number;
  creditedMinutes: number;
  color: string;
};
export type SchedulePattern = {
  id: string;
  name: string;
  kind: "repeating" | "weekly";
  steps: { shift: string; days: number }[];
};
export type SchedulingRole = {
  useWardPattern?: boolean;
  staggerGroup?: string;
  id: string;
  name: string;
  patternId: string;
  allowedShifts: string[];
  category: "nurse" | "na" | "none";
  scope: "ward" | "facility";
  approvalGroup: "ward" | "head" | "matron" | "porter" | "intern";
  specialRule: "none" | "legacy_coverage_v1" | "legacy_intern_v1" | "legacy_porter_v1";
  requiresReview: boolean;
};

export type RotaPreview = {
  runId?: string;
  savedAt?: string;
  inputFingerprint?: string;
  shiftDefinitions?: WorkShift[];
  wardDefinitions?: { id: string; name: string }[];
  configurationId: string;
  configurationVersion: number;
  configurationRevision: number;
  engineVersion: string;
  startDate: string;
  endDate: string;
  anchorDate: string;
  timezone: string;
  generatedAt: string;
  dates: string[];
  hasBlockingIssues: boolean;
  staff: {
    id: string;
    name: string;
    role: string;
    wardId: string | null;
    patternId: string;
    phaseSource: string;
    workingMinutes: number;
    plannedLeaveMinutes: number;
    targetMinutes: number;
  }[];
  assignments: {
    nurseId: string;
    date: string;
    wardId: string | null;
    shift: string;
    plannedShift: string;
    leaveType: string | null;
    creditedMinutes: number;
    plannedMinutes: number;
    start: string | null;
    end: string | null;
  }[];
  diagnostics: {
    code: string;
    severity: "error" | "warning" | "info";
    message: string;
    nurseId?: string;
    wardId?: string;
    date?: string;
    shift?: string;
    category?: string;
    actual?: number;
    minimum?: number;
    maximum?: number | null;
  }[];
};
export type WardPolicy = {
  fixedWeeklyPatternId?: string | null;
  wardId: string;
  patternId: string;
  naPatternId: string;
  specialRule: "none" | "legacy_single_night_slot_v1";
};
export type StaffingRequirement = {
  wardId: string;
  shift: string;
  category: "nurse" | "na";
  weekday: number;
  minimum: number;
  maximum: number | null;
};
export type SchedulingConfiguration = {
  coverageRules?: CoverageRule[];
  schemaVersion: 1;
  timezone: string;
  periodDays: 28;
  shifts: WorkShift[];
  patterns: SchedulePattern[];
  roles: SchedulingRole[];
  wardPolicies: WardPolicy[];
  requirements: StaffingRequirement[];
};
export type CoverageRule = {
  id: string;
  name: string;
  shift: string;
  roleIds: string[];
  anchorDate: string;
  blockDays: number;
  repeatDays: number;
  staffPerBlock: number;
  restBefore: number;
  restAfter: number;
};
// Iwosan Lagoon Hospital. Only its facilities offer the retained (legacy)
// intern, porter and coverage rules; other hospitals use configured patterns.
export const LAGOON_HOSPITAL_ID = "00000000-0000-4000-8000-000000000001";

/**
 * Replace the retained coverage rule with the editable coverage settings from
 * the defaults: each coverage role takes the default role's pattern, shifts and
 * group, the defaults' patterns it needs are added, and the defaults' coverage
 * rules are added for the matching roles. Returns null when nothing changes.
 */
export function withEditableCoverage(
  config: SchedulingConfiguration,
  defaults: SchedulingConfiguration,
): SchedulingConfiguration | null {
  const legacyRoles = config.roles.filter((r) => r.specialRule === "legacy_coverage_v1");
  if (!legacyRoles.length) return null;
  const byName = (name: string) =>
    defaults.roles.find((d) => d.name.toLowerCase() === name.toLowerCase());
  const roleIdFor = new Map<string, string>();
  const roles = config.roles.map((r) => {
    const d = r.specialRule === "legacy_coverage_v1" ? byName(r.name) : undefined;
    if (!d || d.specialRule !== "none") return r;
    roleIdFor.set(d.id, r.id);
    return {
      ...r,
      patternId: d.patternId,
      allowedShifts: d.allowedShifts,
      specialRule: d.specialRule,
      staggerGroup: d.staggerGroup,
      useWardPattern: d.useWardPattern,
    };
  });
  if (!roleIdFor.size) return null;
  const needed = new Set(roles.map((r) => r.patternId));
  const patterns = [
    ...config.patterns,
    ...defaults.patterns.filter(
      (p) => needed.has(p.id) && !config.patterns.some((c) => c.id === p.id),
    ),
  ];
  const rules = (defaults.coverageRules ?? [])
    .filter((rule) => !(config.coverageRules ?? []).some((c) => c.id === rule.id))
    .map((rule) => ({
      ...rule,
      roleIds: rule.roleIds.flatMap((id) => (roleIdFor.has(id) ? [roleIdFor.get(id)!] : [])),
    }))
    .filter((rule) => rule.roleIds.length);
  return {
    ...config,
    patterns,
    roles,
    coverageRules: [...(config.coverageRules ?? []), ...rules],
  };
}

export type SchedulingFacility = {
  id: string;
  organization_id: string;
  name: string;
  timezone: string;
};
export type ConfigurationWarning = { code: string; message: string };
export type ConfigurationValidation = {
  valid: boolean;
  errors: { path: string; message: string }[];
  warnings: ConfigurationWarning[];
};
export type VersionSummary = {
  id: string;
  version: number;
  revision: number;
  status: "draft" | "archived";
  updated_at: string;
};
export type ConfigurationVersion = VersionSummary & {
  configuration: SchedulingConfiguration;
  warnings: ConfigurationWarning[];
  /** First rota period using these saved rules (the next rota draft), if any. */
  appliesFrom?: string | null;
  /** Why saved rules could not be applied, when appliesFrom is null after a save. */
  reason?: string;
};
export type ConfigurationDefaults = {
  configuration: SchedulingConfiguration;
  wards: { id: string; name: string }[];
  warnings: ConfigurationWarning[];
};
export const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

export function configurationErrorLabel(config: SchedulingConfiguration, path: string) {
  const names: Record<string, string> = {
    shifts: "Shifts",
    patterns: "Patterns",
    roles: "Staff roles",
    requirements: "Ward requirements",
    coverageRules: "Coverage rules",
    wardPolicies: "Ward patterns",
    creditedMinutes: "credited minutes",
    breakMinutes: "break minutes",
    patternId: "default pattern",
    naPatternId: "assistant pattern",
    allowedShifts: "allowed shifts",
    endDayOffset: "end day",
    periodDays: "period length",
    wardId: "ward",
    schemaVersion: "configuration version",
  };
  const label = path
    .replace(
      /(shifts|patterns|roles)\[(\d+)\]/g,
      (_, group: "shifts" | "patterns" | "roles", index: string) =>
        `${names[group]}: ${config[group][Number(index)]?.name || Number(index) + 1}`,
    )
    .replace(/steps\[(\d+)\]/g, (_, index: string) => `step ${Number(index) + 1}`)
    .replace(
      /(requirements|wardPolicies)\[(\d+)\]/g,
      (_, group: string, index: string) => `${names[group]}: entry ${Number(index) + 1}`,
    );
  return label
    .split(".")
    .map((part) => names[part] || part)
    .join(" · ");
}

export function renameShift(
  config: SchedulingConfiguration,
  from: string,
  to: string,
): SchedulingConfiguration {
  return {
    ...config,
    shifts: config.shifts.map((s) => (s.code === from ? { ...s, code: to } : s)),
    patterns: config.patterns.map((p) => ({
      ...p,
      steps: p.steps.map((s) => (s.shift === from ? { ...s, shift: to } : s)),
    })),
    roles: config.roles.map((r) => ({
      ...r,
      allowedShifts: r.allowedShifts.map((s) => (s === from ? to : s)),
    })),
    requirements: config.requirements.map((r) => (r.shift === from ? { ...r, shift: to } : r)),
    ...(config.coverageRules
      ? {
          coverageRules: config.coverageRules.map((r) =>
            r.shift === from ? { ...r, shift: to } : r,
          ),
        }
      : {}),
  };
}
export function shiftIsUsed(config: SchedulingConfiguration, code: string) {
  return (
    config.patterns.some((p) => p.steps.some((s) => s.shift === code)) ||
    config.roles.some((r) => r.allowedShifts.includes(code)) ||
    config.requirements.some((r) => r.shift === code) ||
    config.coverageRules?.some((r) => r.shift === code) === true
  );
}
export function patternIsUsed(config: SchedulingConfiguration, id: string) {
  return (
    config.roles.some((r) => r.patternId === id) ||
    config.wardPolicies.some(
      (w) => w.patternId === id || w.naPatternId === id || w.fixedWeeklyPatternId === id,
    )
  );
}
export function patternPreview(pattern: SchedulePattern, days = 28) {
  const cycle = pattern.steps.flatMap((s) =>
    Array.from({ length: Math.min(56, Math.max(0, Math.trunc(s.days) || 0)) }, () => s.shift),
  );
  return cycle.length ? Array.from({ length: days }, (_, i) => cycle[i % cycle.length]) : [];
}
export function setRequirement(
  config: SchedulingConfiguration,
  next: StaffingRequirement,
  allDays = false,
) {
  const days = allDays ? [1, 2, 3, 4, 5, 6, 7] : [next.weekday];
  return {
    ...config,
    requirements: [
      ...config.requirements.filter(
        (r) =>
          !(
            r.wardId === next.wardId &&
            r.shift === next.shift &&
            r.category === next.category &&
            days.includes(r.weekday)
          ),
      ),
      ...days.map((weekday) => ({ ...next, weekday })),
    ],
  };
}

// ── Helpers for the Scheduling page ─────────────────────────────────────────

export type SchedulingTab = "shifts" | "patterns" | "roles" | "wards" | "coverage";
/** The Scheduling page tab that holds the setting a validation error points at. */
export function errorTab(path: string): SchedulingTab | null {
  const head = path.split(/[.[]/)[0];
  if (head === "shifts" || head === "timezone") return "shifts";
  if (head === "patterns") return "patterns";
  if (head === "roles") return "roles";
  if (head === "requirements" || head === "wardPolicies") return "wards";
  if (head === "coverageRules") return "coverage";
  return null;
}

/** "9 h", "7 h 30 min", "45 min". */
export function hoursLabel(minutes: number) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0 h";
  const h = Math.floor(minutes / 60),
    m = Math.round(minutes % 60);
  return h && m ? `${h} h ${m} min` : h ? `${h} h` : `${m} min`;
}

/** Elapsed minutes from start to end, crossing midnight when the shift ends the next day. */
export function shiftDurationMinutes(s: Pick<WorkShift, "start" | "end" | "endDayOffset">) {
  const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  if (!/^\d{2}:\d{2}$/.test(s.start) || !/^\d{2}:\d{2}$/.test(s.end)) return 0;
  return minutes(s.end) + s.endDayOffset * 1440 - minutes(s.start);
}

/** Where a shift code is used, for "Used by" hints and safe removal. */
export function shiftUsage(config: SchedulingConfiguration, code: string) {
  return {
    roles: config.roles.filter((r) => r.allowedShifts.includes(code)).map((r) => r.name),
    patterns: config.patterns
      .filter((p) => p.steps.some((s) => s.shift === code))
      .map((p) => p.name),
    coverageRules: (config.coverageRules ?? []).filter((r) => r.shift === code).map((r) => r.name),
    requirements: config.requirements.filter((r) => r.shift === code && r.minimum > 0).length,
  };
}

/** Roles and wards that use a pattern. */
export function patternUsage(
  config: SchedulingConfiguration,
  id: string,
  wards: { id: string; name: string }[],
) {
  const wardName = (wardId: string) => wards.find((w) => w.id === wardId)?.name ?? "a ward";
  return {
    roles: config.roles.filter((r) => r.patternId === id).map((r) => r.name),
    wards: [
      ...new Set(
        config.wardPolicies
          .filter(
            (w) => w.patternId === id || w.naPatternId === id || w.fixedWeeklyPatternId === id,
          )
          .map((w) => wardName(w.wardId)),
      ),
    ],
  };
}

/** "16-day cycle · 8 working days" or "Weekly · Mon–Fri working". */
export function patternSummary(pattern: SchedulePattern) {
  if (pattern.kind === "weekly") {
    const working = pattern.steps
      .map((s, i) => (s.shift !== "OFF" ? WEEKDAYS[i].slice(0, 3) : null))
      .filter(Boolean);
    return `Same every week · works ${working.length ? working.join(", ") : "no days"}`;
  }
  const total = pattern.steps.reduce((n, s) => n + (Number(s.days) || 0), 0);
  const working = pattern.steps
    .filter((s) => s.shift !== "OFF")
    .reduce((n, s) => n + (Number(s.days) || 0), 0);
  return `Repeats every ${total} day${total === 1 ? "" : "s"} · ${working} working`;
}
