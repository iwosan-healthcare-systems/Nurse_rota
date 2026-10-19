// Explicit, anchored coverage rotation for preview. Does not read or write a database.
const DAY = 86400000;
const day = (value) => Date.parse(`${value}T00:00:00Z`) / DAY;
const date = (value) => new Date(value * DAY).toISOString().slice(0, 10);
const mod = (n, d) => ((n % d) + d) % d;

function validateCoverageRules(config, add) {
  if (config.coverageRules === undefined) return;
  if (!Array.isArray(config.coverageRules) || config.coverageRules.length > 32) {
    add("coverageRules", "Use up to 32 coverage rules");
    return;
  }
  const ids = new Set();
  config.coverageRules.forEach((r, i) => {
    const p = `coverageRules[${i}]`;
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      add(p, "Must be an object");
      return;
    }
    const keys = [
      "id",
      "name",
      "shift",
      "roleIds",
      "anchorDate",
      "blockDays",
      "repeatDays",
      "staffPerBlock",
      "restBefore",
      "restAfter",
    ];
    for (const key of Object.keys(r)) if (!keys.includes(key)) add(`${p}.${key}`, "Unknown field");
    if (typeof r.id !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(r.id) || ids.has(r.id))
      add(`${p}.id`, "Use a unique rule identifier");
    ids.add(r.id);
    if (
      typeof r.name !== "string" ||
      !r.name.trim() ||
      r.name !== r.name.trim() ||
      r.name.length > 120
    )
      add(`${p}.name`, "Use a name of 1-120 characters");
    if (!(Array.isArray(config.shifts) ? config.shifts : []).some((s) => s?.code === r.shift))
      add(`${p}.shift`, "Choose a working shift");
    const instant =
      typeof r.anchorDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.anchorDate)
        ? Date.parse(`${r.anchorDate}T00:00:00Z`)
        : NaN;
    if (
      !Number.isFinite(instant) ||
      new Date(instant).toISOString().slice(0, 10) !== r.anchorDate ||
      r.anchorDate < "1900-01-01" ||
      r.anchorDate > "9998-12-31"
    )
      add(`${p}.anchorDate`, "Choose a valid first block date from 1900 through 9998");
    for (const [key, min, max] of [
      ["blockDays", 1, 28],
      ["repeatDays", 1, 56],
      ["staffPerBlock", 1, 100],
      ["restBefore", 0, 28],
      ["restAfter", 0, 28],
    ])
      if (!Number.isInteger(r[key]) || r[key] < min || r[key] > max)
        add(`${p}.${key}`, `Use a whole number from ${min} to ${max}`);
    if (r.repeatDays < r.blockDays)
      add(`${p}.repeatDays`, "Repeat interval cannot be shorter than the duty block");
    if (
      !Array.isArray(r.roleIds) ||
      !r.roleIds.length ||
      r.roleIds.length > 100 ||
      new Set(r.roleIds).size !== r.roleIds.length
    ) {
      add(`${p}.roleIds`, "Choose one or more distinct roles");
      return;
    }
    for (const id of r.roleIds) {
      const role = (Array.isArray(config.roles) ? config.roles : []).find(
        (role) => role?.id === id,
      );
      if (!role || role.scope !== "facility" || role.specialRule !== "none")
        add(
          `${p}.roleIds`,
          "Eligible roles must use facility scope and configured patterns, without retained legacy rules",
        );
      else if (!Array.isArray(role.allowedShifts) || !role.allowedShifts.includes(r.shift))
        add(`${p}.roleIds`, `${role.name} must allow the coverage shift`);
    }
  });
}

function applyCoverageRules({
  config,
  assignments,
  staff,
  diagnostics,
  startDate,
  endDate,
  previousAssignments,
}) {
  const rules = config.coverageRules || [];
  if (!rules.length) return;
  const start = day(startDate),
    end = day(endDate);
  const cells = new Map(assignments.map((a) => [`${a.nurseId}:${a.date}`, a]));
  const prior = new Map(previousAssignments.map((a) => [`${a.nurse_id}:${a.shift_date}`, a.shift]));
  const reservations = new Map();
  const reserve = (person, d, shift, rule) => {
    const key = `${person.id}:${date(d)}`;
    const existing = reservations.get(key);
    if (existing && (existing.shift !== "OFF" || shift !== "OFF")) {
      if (d >= start && d <= end)
        diagnostics.push({
          code: "COVERAGE_CONFLICT",
          severity: "error",
          nurseId: person.id,
          date: date(d),
          message: `${person.name}: ${existing.rule.name} conflicts with ${rule.name} on ${date(d)}. Review coverage and rest settings.`,
        });
      return;
    }
    reservations.set(key, { shift, rule, person, d });
  };
  for (const rule of rules) {
    const pool = [...staff.values()]
      .filter((n) => rule.roleIds.includes(n.roleDefinition.id))
      .sort((a, b) => a.id.localeCompare(b.id));
    const anchor = day(rule.anchorDate);
    // Include neighboring blocks whose protected rest extends into this period.
    const first = Math.max(
      0,
      Math.ceil((start - rule.blockDays + 1 - rule.restAfter - anchor) / rule.repeatDays),
    );
    const last = Math.floor((end + rule.restBefore - anchor) / rule.repeatDays);
    for (let occurrence = first; occurrence <= last; occurrence++) {
      const blockStart = anchor + occurrence * rule.repeatDays;
      const selected = Array.from(
        { length: Math.min(pool.length, rule.staffPerBlock) },
        (_, slot) => pool[mod(occurrence * rule.staffPerBlock + slot, pool.length)],
      );
      for (const n of selected) {
        for (let d = blockStart - rule.restBefore; d < blockStart; d++) reserve(n, d, "OFF", rule);
        for (let d = blockStart; d < blockStart + rule.blockDays; d++)
          reserve(n, d, rule.shift, rule);
        for (
          let d = blockStart + rule.blockDays;
          d < blockStart + rule.blockDays + rule.restAfter;
          d++
        )
          reserve(n, d, "OFF", rule);
      }
      for (
        let d = Math.max(start, blockStart);
        d <= Math.min(end, blockStart + rule.blockDays - 1);
        d++
      ) {
        const actual = selected.filter((n) => {
          const key = `${n.id}:${date(d)}`;
          return (
            cells.get(key)?.shift !== "LEAVE" &&
            reservations.get(key)?.rule.id === rule.id &&
            reservations.get(key)?.shift === rule.shift
          );
        }).length;
        if (actual < rule.staffPerBlock)
          diagnostics.push({
            code: "CONFIGURED_COVERAGE_GAP",
            severity: "error",
            date: date(d),
            shift: rule.shift,
            actual,
            message: `${rule.name}: ${actual} available of ${rule.staffPerBlock} required on ${date(d)}. Rotation is fixed; leave does not automatically reassign the slot.`,
          });
      }
    }
  }
  const missingHistory = new Set();
  for (const [key, reservation] of reservations) {
    const { shift, rule, person, d } = reservation;
    const cell = cells.get(key);
    if (cell) {
      cell.plannedShift = shift;
      if (cell.shift !== "LEAVE") cell.shift = shift;
    } else if (d < start && !prior.has(key)) {
      missingHistory.add(person.id);
    } else if (d < start && prior.has(key)) {
      const actual = prior.get(key);
      if (shift === "OFF" && actual !== "OFF" && actual !== "LEAVE")
        diagnostics.push({
          code: "COVERAGE_BOUNDARY_REST",
          severity: "error",
          nurseId: person.id,
          date: date(d),
          message: `${person.name}: published ${actual} on ${date(d)} conflicts with rest required by ${rule.name}. Published shifts were not changed.`,
        });
      else if (shift !== "OFF" && actual !== shift && actual !== "LEAVE")
        diagnostics.push({
          code: "COVERAGE_HISTORY_MISMATCH",
          severity: "error",
          nurseId: person.id,
          date: date(d),
          message: `${person.name}: published duty on ${date(d)} differs from ${rule.name}. Review the anchor and pool before continuing this rotation.`,
        });
    }
  }
  if (missingHistory.size)
    diagnostics.push({
      code: "COVERAGE_HISTORY_UNKNOWN",
      severity: "warning",
      message: `Coverage boundary duty/rest cannot be verified for ${missingHistory.size} staff because published history is missing. Review the preceding period.`,
    });
  diagnostics.push({
    code: "FIXED_COVERAGE_ROTATION",
    severity: "info",
    message:
      "Coverage uses fixed staff-ID order from each rule’s first block date. Pool membership changes can change future allocation; approved leave stays in place and gaps require review. Base patterns continue by calendar position after coverage/rest.",
  });
}
module.exports = { validateCoverageRules, applyCoverageRules };
