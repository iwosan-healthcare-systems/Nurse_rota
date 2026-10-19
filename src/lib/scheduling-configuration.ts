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
