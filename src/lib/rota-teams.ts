import type { AssignmentDefinition } from "@/lib/assignment-shift-definition";

/** Nursing assistants (any "Nurse/Nursing Assistant" role, including "- Day"). */
export function isNursingAssistantRole(role: string | null | undefined) {
  return /nurs(?:e|ing)\s*assistant/i.test(role ?? "");
}

export type StaffCategory = "nurse" | "na";
export const CATEGORY_LABELS: Record<StaffCategory, string> = {
  nurse: "Nurses",
  na: "Nursing assistants",
};
export const categoryOf = (role: string | null | undefined): StaffCategory =>
  isNursingAssistantRole(role) ? "na" : "nurse";

/** Nurses first, then nursing assistants; the incoming order is kept within each. */
export function splitByCategory<T extends { role: string }>(staff: T[]) {
  return (["nurse", "na"] as const)
    .map((category) => ({
      category,
      staff: staff.filter((s) => categoryOf(s.role) === category),
    }))
    .filter((group) => group.staff.length > 0);
}

/**
 * Whether a cell is a day or night duty, or not a duty (OFF, LEAVE, empty).
 * Saved shift definitions decide: anything ending the next day or starting from
 * 17:00 is a night duty. Older cells without a definition use the built-in codes.
 */
export function dutyPeriod(
  cell: (Pick<AssignmentDefinition, "shift" | "scheduled_shift"> & { shift: string }) | undefined,
): "day" | "night" | null {
  if (!cell || cell.shift === "OFF" || cell.shift === "LEAVE") return null;
  const definition = cell.scheduled_shift;
  if (definition)
    return definition.endDayOffset > 0 || definition.start >= "17:00" ? "night" : "day";
  if (cell.shift === "N" || cell.shift === "NC") return "night";
  return "day";
}

export type DutyTotals = Record<StaffCategory, { day: number[]; night: number[] }>;

/** Staff on duty per date, by category and day/night. */
export function dutyTotals<C extends Parameters<typeof dutyPeriod>[0]>(
  staff: { id: string; role: string }[],
  dates: string[],
  cellOf: (staffId: string, date: string) => C,
): DutyTotals {
  const totals: DutyTotals = {
    nurse: { day: dates.map(() => 0), night: dates.map(() => 0) },
    na: { day: dates.map(() => 0), night: dates.map(() => 0) },
  };
  for (const person of staff) {
    const category = categoryOf(person.role);
    dates.forEach((date, i) => {
      const period = dutyPeriod(cellOf(person.id, date));
      if (period) totals[category][period][i]++;
    });
  }
  return totals;
}

type DutyCell = Parameters<typeof dutyPeriod>[0];

function totalRows(
  staff: { id: string; role: string }[],
  dates: string[],
  cellOf: (staffId: string, date: string) => DutyCell,
) {
  const totals = dutyTotals(staff, dates, cellOf);
  return splitByCategory(staff).flatMap((group) =>
    (["day", "night"] as const).map((period) => ({
      label: `${CATEGORY_LABELS[group.category]} on duty · ${period === "day" ? "Day" : "Night"}`,
      counts: totals[group.category][period],
    })),
  );
}

/** Printout table rows: nurses, then nursing assistants, then on-duty totals. */
export function printRowsHtml<S extends { id: string; role: string }>(
  staff: S[],
  dates: string[],
  cellOf: (staffId: string, date: string) => DutyCell,
  rowHtml: (person: S) => string,
) {
  const span = 3 + dates.length;
  const sections = splitByCategory(staff)
    .map(
      (group) =>
        `<tr><td colspan="${span}" style="text-align:left;font-weight:700;background:#f3f4f6">${CATEGORY_LABELS[group.category]} · ${group.staff.length}</td></tr>${group.staff.map(rowHtml).join("")}`,
    )
    .join("");
  const totals = totalRows(staff, dates, cellOf)
    .map(
      (row) =>
        `<tr style="background:#f9fafb;font-weight:600"><td colspan="3" style="text-align:left">${row.label}</td>${row.counts.map((c) => `<td>${c}</td>`).join("")}</tr>`,
    )
    .join("");
  return sections + totals;
}

/** Excel rows: a heading row per category, its staff, then on-duty totals. */
export function printRowsAoa<S extends { id: string; role: string }>(
  staff: S[],
  dates: string[],
  cellOf: (staffId: string, date: string) => DutyCell,
  row: (person: S) => (string | number)[],
): (string | number)[][] {
  return [
    ...splitByCategory(staff).flatMap((group) => [
      [`${CATEGORY_LABELS[group.category]} (${group.staff.length})`],
      ...group.staff.map(row),
    ]),
    [],
    ...totalRows(staff, dates, cellOf).map((r) => [r.label, "", "", ...r.counts]),
  ];
}

export type LocationSwitchKind = "shift-for-shift" | "shift-to-off" | "leave-cover";
export const LOCATION_SWITCH_LABELS: Record<LocationSwitchKind, string> = {
  "shift-for-shift": "Swap between locations · shift for shift",
  "shift-to-off": "Swap between locations · shift for an off day",
  "leave-cover": "Swap between locations · leave cover",
};
export const LOCATION_SWITCH_SHORT: Record<LocationSwitchKind, string> = {
  "shift-for-shift": "Shift for shift",
  "shift-to-off": "Shift for off day",
  "leave-cover": "Leave cover",
};

/** What kind of switch between locations a SHIFT_SWITCH request is (null when it isn't one). */
export function locationSwitchKind(reason: string | null | undefined): LocationSwitchKind | null {
  const parts = (reason ?? "").split("|");
  if (parts[0] !== "SHIFT_SWITCH") return null;
  const noteAt = parts.findIndex((p, i) => i > 4 && p.startsWith("NOTE:"));
  const flags = parts.slice(5, noteAt < 0 ? undefined : noteAt);
  if (!flags.includes("INTER_FACILITY")) return null;
  if (flags.includes("LEAVE_COVER")) return "leave-cover";
  const offDuty = (shift: string | undefined) => !shift || shift === "OFF" || shift === "LEAVE";
  return offDuty(parts[3]) || offDuty(parts[4]) ? "shift-to-off" : "shift-for-shift";
}
