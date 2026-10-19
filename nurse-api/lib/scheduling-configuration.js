const { createHash } = require("node:crypto");
const legacy = require("./auto-schedule.generated");
const { validateCoverageRules } = require("./coverage-rules");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9_]{0,63}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,15}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const BASE_ROLES = [
  "Nurse",
  "Surgical Nurse",
  "Surgical Nurse - Day",
  "Matron",
  "Coverage Nurse",
  "Coverage Nurse - Day",
  "Nurse Intern",
  "Nursing Assistant",
  "Nursing Assistant - Day",
  "Porter",
  "Porter - Day",
];

function validateConfiguration(config, wards = []) {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });
  const obj = (value, path, keys) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      add(path, "Must be an object");
      return false;
    }
    for (const key of Object.keys(value))
      if (!keys.includes(key)) add(`${path}.${key}`, "Unknown field");
    return true;
  };
  const array = (value, path, max, min = 0) => {
    if (!Array.isArray(value) || value.length < min || value.length > max) {
      add(path, `Must contain ${min}-${max} entries`);
      return [];
    }
    return value;
  };
  const label = (value, path) => {
    if (typeof value !== "string" || value.trim() !== value || !value.length || value.length > 120)
      add(path, "Must be 1-120 characters without surrounding whitespace");
  };
  const integer = (value, path, min, max) => {
    if (!Number.isInteger(value) || value < min || value > max)
      add(path, `Must be an integer from ${min} to ${max}`);
  };
  const oneOf = (value, values, path) => {
    if (!values.includes(value)) add(path, `Must be one of: ${values.join(", ")}`);
  };
  const unique = (items, field, path, regex) => {
    const seen = new Set();
    items.forEach((item, i) => {
      const key = item?.[field];
      if (typeof key !== "string" || !regex.test(key))
        add(`${path}[${i}].${field}`, "Invalid identifier");
      else if (seen.has(key)) add(`${path}[${i}].${field}`, "Duplicate identifier");
      else seen.add(key);
    });
    return seen;
  };
  if (
    !obj(config, "configuration", [
      "schemaVersion",
      "timezone",
      "periodDays",
      "shifts",
      "patterns",
      "roles",
      "wardPolicies",
      "requirements",
      "coverageRules",
    ])
  )
    return { valid: false, errors };
  if (config.schemaVersion !== 1) add("schemaVersion", "Only schema version 1 is supported");
  if (typeof config.timezone !== "string") add("timezone", "An IANA timezone is required");
  else {
    try {
      new Intl.DateTimeFormat("en", { timeZone: config.timezone });
    } catch {
      add("timezone", "Invalid IANA timezone");
    }
  }
  // Legacy field kept for stored configurations. Rota periods are calendar
  // months (rota_period_start/rota_period_end), not this setting.
  if (config.periodDays !== 28)
    add("periodDays", "Only 28-day periods are supported in this release");
  const shifts = array(config.shifts, "shifts", 32, 1);
  const shiftCodes = unique(shifts, "code", "shifts", CODE);
  shifts.forEach((s, i) => {
    const p = `shifts[${i}]`;
    if (
      !obj(s, p, [
        "code",
        "name",
        "start",
        "end",
        "endDayOffset",
        "breakMinutes",
        "creditedMinutes",
        "color",
      ])
    )
      return;
    if (["OFF", "LEAVE"].includes(s.code)) add(`${p}.code`, "Reserved system assignment state");
    label(s.name, `${p}.name`);
    const timesValid =
      typeof s.start === "string" &&
      TIME.test(s.start) &&
      typeof s.end === "string" &&
      TIME.test(s.end);
    if (!timesValid) add(p, "Start and end must use HH:mm");
    integer(s.endDayOffset, `${p}.endDayOffset`, 0, 1);
    integer(s.breakMinutes, `${p}.breakMinutes`, 0, 1439);
    integer(s.creditedMinutes, `${p}.creditedMinutes`, 1, 1440);
    if (typeof s.color !== "string" || !/^#[0-9a-f]{6}$/i.test(s.color))
      add(`${p}.color`, "Use a six-digit hex color");
    if (timesValid) {
      const minutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
      const duration = minutes(s.end) + s.endDayOffset * 1440 - minutes(s.start);
      if (!(duration > 0 && duration <= 1440))
        add(p, "Shift duration must be positive and at most 24 hours");
      if (s.breakMinutes >= duration || s.creditedMinutes > duration)
        add(p, "Break and credited minutes must fit within the shift");
    }
  });
  const patterns = array(config.patterns, "patterns", 100, 1);
  const patternIds = unique(patterns, "id", "patterns", KEY);
  const patternShifts = new Map();
  patterns.forEach((pattern, i) => {
    const p = `patterns[${i}]`;
    if (!obj(pattern, p, ["id", "name", "kind", "steps"])) return;
    label(pattern.name, `${p}.name`);
    oneOf(pattern.kind, ["repeating", "weekly"], `${p}.kind`);
    const steps = array(pattern.steps, `${p}.steps`, 56, 1);
    const used = new Set();
    let days = 0;
    steps.forEach((step, j) => {
      const q = `${p}.steps[${j}]`;
      if (!obj(step, q, ["shift", "days"])) return;
      if (step.shift !== "OFF" && !shiftCodes.has(step.shift))
        add(`${q}.shift`, "Unknown work shift (LEAVE cannot be a pattern step)");
      if (step.shift !== "OFF") used.add(step.shift);
      integer(step.days, `${q}.days`, 1, 56);
      days += step.days;
    });
    if (!(days >= 1 && days <= 366)) add(`${p}.steps`, "Total pattern length must be 1-366 days");
    if (pattern.kind === "weekly" && (steps.length !== 7 || steps.some((s) => s?.days !== 1)))
      add(`${p}.steps`, "Weekly patterns require seven one-day steps, Monday first");
    patternShifts.set(pattern.id, used);
  });
  const roles = array(config.roles, "roles", 100, 1);
  unique(roles, "id", "roles", KEY);
  const roleNames = new Set();
  roles.forEach((r, i) => {
    const p = `roles[${i}]`;
    if (
      !obj(r, p, [
        "id",
        "name",
        "patternId",
        "allowedShifts",
        "category",
        "scope",
        "approvalGroup",
        "specialRule",
        "requiresReview",
        "useWardPattern",
        "staggerGroup",
      ])
    )
      return;
    label(r.name, `${p}.name`);
    if (r.useWardPattern !== undefined && typeof r.useWardPattern !== "boolean")
      add(`${p}.useWardPattern`, "Must be a boolean");
    if (
      r.staggerGroup !== undefined &&
      (typeof r.staggerGroup !== "string" || !KEY.test(r.staggerGroup))
    )
      add(`${p}.staggerGroup`, "Invalid scheduling group");
    if (typeof r.name === "string") {
      if (roleNames.has(r.name.toLowerCase())) add(`${p}.name`, "Duplicate role name");
      roleNames.add(r.name.toLowerCase());
    }
    if (!patternIds.has(r.patternId)) add(`${p}.patternId`, "Unknown pattern");
    const allowed = array(r.allowedShifts, `${p}.allowedShifts`, 32, 1);
    if (new Set(allowed).size !== allowed.length) add(`${p}.allowedShifts`, "Duplicate shifts");
    for (const code of allowed)
      if (!shiftCodes.has(code)) add(`${p}.allowedShifts`, "Unknown shift");
    for (const code of patternShifts.get(r.patternId) || [])
      if (!allowed.includes(code))
        add(`${p}.patternId`, "Pattern uses a shift not allowed for this role");
    oneOf(r.category, ["nurse", "na", "none"], `${p}.category`);
    oneOf(r.scope, ["ward", "facility"], `${p}.scope`);
    oneOf(r.approvalGroup, ["ward", "head", "matron", "porter", "intern"], `${p}.approvalGroup`);
    oneOf(
      r.specialRule,
      ["none", "legacy_coverage_v1", "legacy_intern_v1", "legacy_porter_v1"],
      `${p}.specialRule`,
    );
    if (typeof r.requiresReview !== "boolean") add(`${p}.requiresReview`, "Must be a boolean");
  });
  const wardIds = new Set(wards.map((w) => w.id));
  const policies = array(config.wardPolicies, "wardPolicies", 200);
  unique(policies, "wardId", "wardPolicies", UUID);
  policies.forEach((policy, i) => {
    const p = `wardPolicies[${i}]`;
    if (
      !obj(policy, p, ["wardId", "patternId", "naPatternId", "specialRule", "fixedWeeklyPatternId"])
    )
      return;
    if (
      policy.fixedWeeklyPatternId != null &&
      !patterns.some(
        (pattern) => pattern?.id === policy.fixedWeeklyPatternId && pattern.kind === "weekly",
      )
    )
      add(`${p}.fixedWeeklyPatternId`, "Choose a weekly pattern or no fixed calendar");
    if (!wardIds.has(policy.wardId)) add(`${p}.wardId`, "Ward does not belong to this facility");
    for (const field of ["patternId", "naPatternId"])
      if (!patternIds.has(policy[field])) add(`${p}.${field}`, "Unknown pattern");
    oneOf(policy.specialRule, ["none", "legacy_single_night_slot_v1"], `${p}.specialRule`);
  });
  const requirementKeys = new Set();
  array(config.requirements, "requirements", 2000).forEach((r, i) => {
    const p = `requirements[${i}]`;
    if (!obj(r, p, ["wardId", "shift", "category", "weekday", "minimum", "maximum"])) return;
    if (!wardIds.has(r.wardId)) add(`${p}.wardId`, "Ward does not belong to this facility");
    if (!shiftCodes.has(r.shift)) add(`${p}.shift`, "Unknown shift");
    oneOf(r.category, ["nurse", "na"], `${p}.category`);
    integer(r.weekday, `${p}.weekday`, 1, 7);
    integer(r.minimum, `${p}.minimum`, 0, 1000);
    if (r.maximum !== null) {
      integer(r.maximum, `${p}.maximum`, 0, 1000);
      if (r.maximum < r.minimum) add(`${p}.maximum`, "Maximum must be at least minimum");
    }
    const key = JSON.stringify([r.wardId, r.shift, r.category, r.weekday]);
    if (requirementKeys.has(key)) add(p, "Duplicate ward/shift/category/weekday requirement");
    requirementKeys.add(key);
  });
  validateCoverageRules(config, add);
  return { valid: errors.length === 0, errors };
}

function seedConfiguration(facility, wards, staffRoles = []) {
  const step = (shift, days) => ({ shift, days });
  const roleNames = [...new Set([...BASE_ROLES, ...staffRoles])];
  const seen = new Set();
  const roles = roleNames
    .filter((name) => {
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((name) => {
      const coverage = legacy.isGlobalHead(name),
        matron = legacy.isMatron(name);
      const intern = legacy.isInternType(name),
        porter = legacy.isPorterType(name);
      const day = legacy.isNADayType(name) || legacy.isPorterDayType(name);
      const weekday =
        matron || legacy.isSurgicalNurseDayType(name) || legacy.isCoverageNurseDayType(name);
      return {
        id: `role_${createHash("sha256").update(name.toLowerCase()).digest("hex").slice(0, 16)}`,
        name,
        patternId: weekday ? "weekdays" : day ? "day_only" : "standard",
        allowedShifts: coverage
          ? weekday
            ? ["M", "MWC"]
            : ["M", "N", "MWC", "NC"]
          : weekday || day
            ? ["M"]
            : ["M", "N"],
        category: legacy.isNAType(name)
          ? "na"
          : coverage || matron || porter || intern || legacy.isWardSupervisor(name)
            ? "none"
            : "nurse",
        scope: coverage || matron || porter || intern ? "facility" : "ward",
        approvalGroup: coverage
          ? "head"
          : matron
            ? "matron"
            : porter
              ? "porter"
              : intern
                ? "intern"
                : "ward",
        specialRule: coverage
          ? "legacy_coverage_v1"
          : intern
            ? "legacy_intern_v1"
            : porter
              ? "legacy_porter_v1"
              : "none",
        requiresReview: !BASE_ROLES.some((r) => r.toLowerCase() === name.toLowerCase()),
        useWardPattern: !(coverage || matron || porter || intern || day || weekday),
        staggerGroup: legacy.isWardSupervisor(name)
          ? "supervisors"
          : legacy.isSurgicalNurseDayType(name)
            ? "surgical_day"
            : legacy.isNAType(name)
              ? day
                ? "na_day"
                : "na_regular"
              : "regular",
      };
    });
  const wardPolicies = wards.map((w) => {
    const weekdays = ["oncology", "dialysis"].includes(w.name.trim().toLowerCase());
    const dayOnly = w.min_night_nurses === 0 && w.min_night_na === 0;
    return {
      wardId: w.id,
      fixedWeeklyPatternId: weekdays ? "weekdays" : null,
      patternId: weekdays ? "weekdays" : dayOnly ? "day_only" : "standard",
      naPatternId: weekdays
        ? "weekdays"
        : w.min_night_na === 0 || dayOnly
          ? "day_only"
          : "standard",
      specialRule:
        facility.legacy_facility.trim().toLowerCase() === "ikoyi" &&
        w.name.trim().toLowerCase() === "gopd" &&
        w.min_night_nurses === 1
          ? "legacy_single_night_slot_v1"
          : "none",
    };
  });
  const requirements = [];
  for (const w of wards)
    for (let weekday = 1; weekday <= 7; weekday++) {
      for (const [shift, category, field] of [
        ["M", "nurse", "min_morning_nurses"],
        ["M", "na", "min_morning_na"],
        ["N", "nurse", "min_night_nurses"],
        ["N", "na", "min_night_na"],
      ]) {
        requirements.push({
          wardId: w.id,
          shift,
          category,
          weekday,
          minimum: w[field],
          maximum: null,
        });
      }
    }
  return {
    schemaVersion: 1,
    timezone: facility.timezone,
    periodDays: 28,
    shifts: Object.entries(legacy.SHIFT_TIMES).map(([code, s]) => ({
      code,
      name: s.label,
      start: s.start,
      end: s.end,
      endDayOffset: ["N", "NC"].includes(code) ? 1 : 0,
      breakMinutes: 0,
      creditedMinutes: s.hours * 60,
      color: { M: "#fbbf24", N: "#818cf8", MWC: "#22d3ee", NC: "#c084fc" }[code],
    })),
    patterns: [
      {
        id: "standard",
        name: "4 Morning / 4 OFF / 4 Night / 4 OFF",
        kind: "repeating",
        steps: [step("M", 4), step("OFF", 4), step("N", 4), step("OFF", 4)],
      },
      {
        id: "day_only",
        name: "4 Morning / 4 OFF",
        kind: "repeating",
        steps: [step("M", 4), step("OFF", 4)],
      },
      {
        id: "weekdays",
        name: "Weekday mornings",
        kind: "weekly",
        steps: ["M", "M", "M", "M", "M", "OFF", "OFF"].map((s) => step(s, 1)),
      },
    ],
    roles,
    wardPolicies,
    requirements,
  };
}

function configurationWarnings(config) {
  const warnings = [
    {
      code: "DRAFT_ONLY",
      message:
        "Saving does not activate these rules. An administrator must activate a fresh reviewed run for a future period.",
    },
  ];
  if (config.roles.some((r) => r.requiresReview))
    warnings.push({
      code: "ROLE_REVIEW",
      message: "Imported nonstandard role mappings require review.",
    });
  if (
    config.roles.some((r) => r.specialRule !== "none") ||
    config.wardPolicies.some((w) => w.specialRule !== "none")
  )
    warnings.push({
      code: "LEGACY_RULES",
      message:
        "Special coverage and rotation policies retain legacy identifiers pending engine integration.",
    });
  if (
    config.shifts.some(
      (s) =>
        !legacy.SHIFT_TIMES[s.code] ||
        s.start !== legacy.SHIFT_TIMES[s.code].start ||
        s.end !== legacy.SHIFT_TIMES[s.code].end ||
        s.creditedMinutes !== legacy.SHIFT_TIMES[s.code].hours * 60,
    )
  )
    warnings.push({
      code: "CUSTOM_SHIFTS",
      message:
        "Custom shift definitions change attendance windows, credited hours and leave credits once activated. Review them against the preview before activation.",
    });
  return warnings;
}

module.exports = { UUID, validateConfiguration, seedConfiguration, configurationWarnings };
