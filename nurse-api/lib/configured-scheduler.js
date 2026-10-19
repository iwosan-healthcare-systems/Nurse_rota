// Pure, preview-only engine. All database access and authorization live in the service.
const legacy = require("./auto-schedule.generated");
const { applyCoverageRules } = require("./coverage-rules");
const { seedConfiguration, validateConfiguration } = require("./scheduling-configuration");
const DAY = 86400000;
const mod = (value, divisor) => ((value % divisor) + divisor) % divisor;
const addDays = (date, days) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
function validDate(date) {
  return (
    typeof date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(`${date}T00:00:00Z`)) &&
    addDays(date, 0) === date
  );
}
class PreviewError extends Error {
  constructor(errors) {
    super("Configuration cannot be previewed");
    this.errors = errors;
  }
}

// Resolve a wall-clock time without using the server's timezone. Ambiguous and
// nonexistent DST times require a policy decision, so never silently choose one.
function zonedInstant(date, time, timezone) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const nominal = Date.parse(`${date}T${time}:00Z`);
  const wall = (instant) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(instant).map((p) => [p.type, p.value]),
    );
    return Date.parse(
      `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`,
    );
  };
  const offsets = new Set();
  for (let hour = -36; hour <= 36; hour += 6) {
    const sample = nominal + hour * 3600000;
    offsets.add(wall(sample) - sample);
  }
  const candidates = [...offsets]
    .map((offset) => nominal - offset)
    .filter((instant) => wall(instant) === nominal);
  if (candidates.length !== 1)
    throw new Error(
      `${date} ${time} is ${candidates.length ? "ambiguous" : "nonexistent"} in ${timezone}`,
    );
  return new Date(candidates[0]).toISOString();
}

function historyPhase(rows, cycle, startDate) {
  const byDate = new Map(
    rows.map((row) => [row.shift_date, row.shift === "LEAVE" ? row.pre_leave_shift : row.shift]),
  );
  const tail = [];
  for (let back = 1; back <= cycle.length; back++) {
    const code = byDate.get(addDays(startDate, -back));
    if (!code) break;
    tail.unshift(code);
  }
  // Compare each phase once. Re-scanning every shorter window would be cubic
  // for long all-OFF histories, while the longest unique suffix is sufficient.
  let longest = 0;
  let candidates = [];
  for (let next = 0; next < cycle.length; next++) {
    let length = 0;
    while (
      length < tail.length &&
      cycle[mod(next - length - 1, cycle.length)] === tail[tail.length - length - 1]
    )
      length++;
    if (length > longest) {
      longest = length;
      candidates = [next];
    } else if (length === longest) candidates.push(next);
  }
  return longest >= 2 && candidates.length === 1 ? candidates[0] : null;
}

function generateConfiguredPreview({
  configuration: config,
  facility,
  wards,
  nurses,
  leave = [],
  previousAssignments = [],
  startDate,
  anchorDate = startDate,
  days = 28,
}) {
  const validation = validateConfiguration(config, wards);
  if (!validation.valid) throw new PreviewError(validation.errors);
  if (
    !validDate(startDate) ||
    !validDate(anchorDate) ||
    anchorDate > startDate ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > 31
  )
    throw new PreviewError([
      {
        path: "startDate",
        message: "Use a valid start date, an anchor on/before it, and 1-31 days",
      },
    ]);
  const dates = Array.from({ length: days }, (_, i) => addDays(startDate, i));
  const offset = Math.round((Date.parse(startDate) - Date.parse(anchorDate)) / DAY);
  const scoped = nurses
    .filter((n) => n.facility === facility.legacy_facility && n.is_active !== false)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (scoped.length > 1000)
    throw new PreviewError([
      { path: "staff", message: "Preview supports up to 1,000 active staff per facility" },
    ]);
  const baseline = seedConfiguration(
    facility,
    wards,
    scoped.map((n) => n.role),
  );
  const patterns = new Map(config.patterns.map((p) => [p.id, p]));
  const shifts = new Map(config.shifts.map((s) => [s.code, s]));
  const history = new Map();
  for (const a of previousAssignments)
    if (a.shift_date < startDate) {
      const rows = history.get(a.nurse_id) || [];
      rows.push(a);
      history.set(a.nurse_id, rows);
    }
  const diagnostics = [];
  const issues = [];
  const groups = new Map();
  const staff = new Map();
  const special = [];
  function issue(path, message) {
    issues.push({ path, message });
  }
  for (const n of scoped) {
    const role = config.roles.find((r) => r.name.toLowerCase() === n.role.toLowerCase());
    if (!role) {
      issue("roles", `${n.name}: no configuration matches staff role ${n.role}`);
      continue;
    }
    if (role.requiresReview) {
      issue("roles", `${n.name}: review the imported ${role.name} role before previewing`);
      continue;
    }
    const seedRole = baseline.roles.find((r) => r.name.toLowerCase() === role.name.toLowerCase());
    const firstWard = legacy.parseWards(n.ward)[0];
    const ward = role.scope === "ward" ? wards.find((w) => w.name === firstWard) : null;
    const policy = ward && config.wardPolicies.find((w) => w.wardId === ward.id);
    const useWard = role.useWardPattern ?? seedRole?.useWardPattern ?? false;
    const group = role.staggerGroup ?? seedRole?.staggerGroup ?? role.id;
    // Older draft versions did not have the explicit calendar override field.
    const calendarOverride =
      policy?.fixedWeeklyPatternId === undefined
        ? baseline.wardPolicies.find((p) => p.wardId === ward?.id)?.fixedWeeklyPatternId
        : policy.fixedWeeklyPatternId;
    const patternId =
      calendarOverride ||
      (useWard && policy
        ? role.category === "na"
          ? policy.naPatternId
          : policy.patternId
        : role.patternId);
    const pattern = patterns.get(patternId);
    const isSingleSlot =
      policy?.specialRule === "legacy_single_night_slot_v1" &&
      (group === "regular" || seedRole?.staggerGroup === "regular") &&
      role.category === "nurse";
    if (role.scope === "ward" && !ward) {
      issue("wardPolicies", `${n.name}: assign a ward in this facility before previewing`);
      continue;
    }
    const badShift = pattern.steps.find(
      (s) => s.shift !== "OFF" && !role.allowedShifts.includes(s.shift),
    );
    if (badShift) {
      issue(
        "roles",
        `${role.name}: effective ward pattern uses disallowed shift ${badShift.shift}`,
      );
      continue;
    }
    staff.set(n.id, {
      ...n,
      roleDefinition: role,
      wardId: ward?.id ?? null,
      patternId,
      phaseSource: pattern.kind === "weekly" ? "calendar" : "anchor",
    });
    if (role.specialRule !== "none" || isSingleSlot) {
      const originalPattern = baseline.patterns.find((p) => p.id === patternId);
      const seedPolicy = baseline.wardPolicies.find((p) => p.wardId === ward?.id);
      const sameRole =
        seedRole &&
        ["scope", "category", "approvalGroup", "specialRule", "patternId"].every(
          (k) => role[k] === seedRole[k],
        ) &&
        JSON.stringify(role.allowedShifts) === JSON.stringify(seedRole.allowedShifts);
      const compatible =
        sameRole &&
        group === seedRole.staggerGroup &&
        useWard === seedRole.useWardPattern &&
        originalPattern &&
        pattern.kind === originalPattern.kind &&
        // Compare by value: jsonb storage reorders object keys, so stringified
        // saved steps never match freshly seeded ones.
        pattern.steps.length === originalPattern.steps.length &&
        pattern.steps.every(
          (step, i) =>
            step.shift === originalPattern.steps[i].shift &&
            step.days === originalPattern.steps[i].days,
        ) &&
        config.timezone === "Africa/Lagos" &&
        (!isSingleSlot ||
          (useWard &&
            !calendarOverride &&
            ["wardId", "patternId", "naPatternId", "specialRule"].every(
              (k) => policy[k] === seedPolicy?.[k],
            ))) &&
        role.allowedShifts.every((code) => {
          const s = shifts.get(code),
            base = baseline.shifts.find((v) => v.code === code);
          return (
            s &&
            base &&
            ["start", "end", "endDayOffset", "breakMinutes", "creditedMinutes"].every(
              (k) => s[k] === base[k],
            )
          );
        });
      if (!compatible)
        issue(
          "roles",
          `${role.name}${ward ? ` in ${ward.name}` : ""}: the retained coverage/rotation rule does not support these changes yet. Restore its original pattern, allowed shifts and timing before previewing.`,
        );
      else special.push(n);
      continue;
    }
    const key = JSON.stringify([ward?.id ?? null, group, patternId]);
    const entry = groups.get(key) || { pattern, members: [] };
    entry.members.push(n);
    groups.set(key, entry);
  }
  if (issues.length) throw new PreviewError(issues);
  const assignments = [];
  const leaveByStaff = new Map();
  for (const l of leave.filter((l) => l.status === "Approved")) {
    const list = leaveByStaff.get(l.nurse_id) || [];
    list.push(l);
    leaveByStaff.set(l.nurse_id, list);
  }
  function append(nurseId, date, baseShift) {
    const person = staff.get(nurseId);
    const absences = (leaveByStaff.get(nurseId) || []).filter(
      (l) => l.from_date <= date && l.to_date >= date,
    );
    if (absences.length > 1)
      diagnostics.push({
        code: "OVERLAPPING_LEAVE",
        severity: "error",
        nurseId,
        date,
        message: `${person.name}: overlapping approved leave on ${date}`,
      });
    assignments.push({
      nurseId,
      date,
      wardId: person.wardId,
      shift: absences.length ? "LEAVE" : baseShift,
      plannedShift: baseShift,
      leaveType: absences[0]?.type ?? null,
    });
  }
  for (const { pattern, members } of groups.values()) {
    const cycle = pattern.steps.flatMap((s) => Array(s.days).fill(s.shift));
    const boundaries = [];
    let total = 0;
    for (const s of pattern.steps) {
      boundaries.push(total);
      total += s.days;
    }
    let hash = 5381;
    for (const n of members)
      for (const char of n.id) hash = (((hash << 5) + hash) ^ char.charCodeAt(0)) >>> 0;
    const seed = hash % members.length;
    const ranked = [...members].sort(
      (a, b) => b.target_hours - a.target_hours || a.id.localeCompare(b.id),
    );
    for (const [rank, n] of ranked.entries()) {
      const slot = Math.round((rank * boundaries.length) / members.length) % boundaries.length;
      const initial = mod(offset + boundaries[(slot + seed) % boundaries.length], cycle.length);
      const configuredCoverage = config.coverageRules?.some((rule) =>
        rule.roleIds.includes(staff.get(n.id).roleDefinition.id),
      );
      const phase = configuredCoverage
        ? null
        : historyPhase(history.get(n.id) || [], cycle, startDate);
      if (phase !== null && pattern.kind !== "weekly") staff.get(n.id).phaseSource = "history";
      else if (!configuredCoverage && (history.get(n.id) || []).length && pattern.kind !== "weekly")
        diagnostics.push({
          code: "PHASE_FALLBACK",
          severity: "warning",
          nurseId: n.id,
          message: `${n.name}: prior shifts do not identify a unique pattern position; using the anchor and staggered start.`,
        });
      dates.forEach((date, day) => {
        const weekday = mod(new Date(`${date}T00:00:00Z`).getUTCDay() - 1, 7);
        append(
          n.id,
          date,
          cycle[pattern.kind === "weekly" ? weekday : mod((phase ?? initial) + day, cycle.length)],
        );
      });
    }
  }
  if (special.length) {
    const result = legacy.generateSchedule({
      nurses: special,
      wards: wards.map((w) => ({ ...w, facility: facility.legacy_facility })),
      leave,
      startDate: new Date(`${startDate}T12:00:00`),
      days,
      periodOffset: offset,
      previousAssignments: previousAssignments.filter(
        (a) => a.shift_date >= addDays(startDate, -5) && a.shift_date < startDate,
      ),
      facility: facility.legacy_facility,
    });
    for (const a of result.assignments) {
      staff.get(a.nurse_id).phaseSource = "legacy";
      append(
        a.nurse_id,
        a.shift_date,
        a.shift === "LEAVE" ? (a.pre_leave_shift ?? "OFF") : a.shift,
      );
    }
    diagnostics.push({
      code: "LEGACY_ADAPTER",
      severity: "info",
      message:
        "Existing coverage, intern, porter or single-night-slot rotations were preserved by the compatibility adapter.",
    });
    const coverage = special.filter(
      (n) => staff.get(n.id).roleDefinition.specialRule === "legacy_coverage_v1",
    );
    if (coverage.length)
      for (const date of dates) {
        const codes = [];
        if (coverage.some((n) => staff.get(n.id).roleDefinition.allowedShifts.includes("NC")))
          codes.push("NC");
        if ([0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())) codes.push("MWC");
        for (const code of codes) {
          const actual = assignments.filter(
            (a) => a.date === date && a.shift === code && coverage.some((n) => n.id === a.nurseId),
          ).length;
          if (actual !== 1)
            diagnostics.push({
              code: "COVERAGE_GAP",
              severity: "error",
              date,
              shift: code,
              actual,
              message: `${code} coverage on ${date}: expected one staff member, found ${actual}.`,
            });
        }
      }
  }
  applyCoverageRules({
    config,
    assignments,
    staff,
    diagnostics,
    startDate,
    endDate: dates.at(-1),
    previousAssignments,
  });
  if (previousAssignments.length)
    diagnostics.push({
      code: "HISTORY_TIMING",
      severity: "info",
      message:
        "Boundary rest checks use draft shift times; existing published records do not yet retain versioned shift definitions.",
    });
  const intervalCache = new Map();
  function interval(date, code) {
    const s = shifts.get(code);
    if (!s) return null;
    const key = `${date}:${code}`;
    if (!intervalCache.has(key)) {
      try {
        const start = zonedInstant(date, s.start, config.timezone);
        const end = zonedInstant(addDays(date, s.endDayOffset), s.end, config.timezone);
        if (end <= start)
          throw new Error(`Shift ${code} has no positive elapsed duration on ${date}`);
        intervalCache.set(key, { start, end });
      } catch (error) {
        diagnostics.push({
          code: "TIME_AMBIGUITY",
          severity: "error",
          date,
          message: error.message,
        });
        intervalCache.set(key, null);
      }
    }
    return intervalCache.get(key);
  }
  const counts = new Map();
  for (const a of assignments) {
    a.creditedMinutes = a.shift === "LEAVE" ? 0 : (shifts.get(a.shift)?.creditedMinutes ?? 0);
    a.plannedMinutes = shifts.get(a.plannedShift)?.creditedMinutes ?? 0;
    const times = a.shift === "LEAVE" ? null : interval(a.date, a.shift);
    a.start = times?.start ?? null;
    a.end = times?.end ?? null;
    const category = staff.get(a.nurseId).roleDefinition.category;
    const key = JSON.stringify([a.wardId, a.date, a.shift, category]);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const r of config.requirements)
    for (const date of dates) {
      if (mod(new Date(`${date}T00:00:00Z`).getUTCDay() - 1, 7) + 1 !== r.weekday) continue;
      const actual = counts.get(JSON.stringify([r.wardId, date, r.shift, r.category])) || 0;
      if (actual < r.minimum || (r.maximum !== null && actual > r.maximum))
        diagnostics.push({
          code: actual < r.minimum ? "STAFFING_SHORTFALL" : "STAFFING_EXCESS",
          severity: "error",
          wardId: r.wardId,
          date,
          shift: r.shift,
          category: r.category,
          actual,
          minimum: r.minimum,
          maximum: r.maximum,
          message: `${wards.find((w) => w.id === r.wardId).name}: ${r.shift} ${r.category} staffing ${actual}, required ${r.minimum}${r.maximum === null ? "+" : `–${r.maximum}`} on ${date}`,
        });
    }
  const summaries = scoped.map((n) => {
    const rows = assignments
      .filter((a) => a.nurseId === n.id)
      .sort((a, b) => a.date.localeCompare(b.date));
    const previous = (history.get(n.id) || [])
      .filter((a) => a.shift !== "OFF" && a.shift !== "LEAVE")
      .sort((a, b) => a.shift_date.localeCompare(b.shift_date))
      .at(-1);
    let priorEnd = previous ? interval(previous.shift_date, previous.shift)?.end : null;
    if (previous && !shifts.has(previous.shift))
      diagnostics.push({
        code: "UNKNOWN_PRIOR_SHIFT",
        severity: "warning",
        nurseId: n.id,
        message: `${n.name}: prior shift ${previous.shift} is not defined; boundary rest could not be verified.`,
      });
    for (const a of rows)
      if (a.start && a.end) {
        if (priorEnd && a.start <= priorEnd)
          diagnostics.push({
            code: "NO_REST",
            severity: "error",
            nurseId: n.id,
            date: a.date,
            message: `${n.name}: ${a.shift} on ${a.date} overlaps or immediately follows the previous shift.`,
          });
        priorEnd = !priorEnd || a.end > priorEnd ? a.end : priorEnd;
      }
    const person = staff.get(n.id);
    return {
      id: n.id,
      name: n.name,
      role: person.roleDefinition.name,
      wardId: person.wardId,
      patternId: person.patternId,
      phaseSource: person.phaseSource,
      workingMinutes: rows.reduce((sum, a) => sum + a.creditedMinutes, 0),
      plannedLeaveMinutes: rows
        .filter((a) => a.shift === "LEAVE")
        .reduce((sum, a) => sum + a.plannedMinutes, 0),
      targetMinutes: Math.round((n.target_hours || 0) * 60),
    };
  });
  return {
    engineVersion: "configured-preview-v1",
    startDate,
    endDate: dates.at(-1),
    anchorDate,
    timezone: config.timezone,
    dates,
    assignments: assignments.sort(
      (a, b) => a.nurseId.localeCompare(b.nurseId) || a.date.localeCompare(b.date),
    ),
    staff: summaries,
    diagnostics,
    hasBlockingIssues: diagnostics.some((d) => d.severity === "error"),
    activationAvailable: false,
  };
}

module.exports = { generateConfiguredPreview, zonedInstant, validDate, addDays, PreviewError };
