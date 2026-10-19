export type ScheduledShift = {
  code: string;
  name: string;
  start: string;
  end: string;
  endDayOffset: number;
  breakMinutes: number;
  creditedMinutes: number;
  color: string;
  timezone: string;
  startsAt: string;
  endsAt: string;
  source: "saved_run" | "legacy";
  runId: string | null;
};
export type AssignmentDefinition = {
  configured_edit?: { shifts: { code: string; name: string }[]; error: string | null } | null;
  shift: string;
  pre_leave_shift?: string | null;
  scheduled_shift?: ScheduledShift | null;
  shift_definition_error?: string | null;
};

export function assignmentScheduledHours(assignment: AssignmentDefinition): number | null {
  if (assignment.shift_definition_error) return null;
  const code = assignment.shift === "LEAVE" ? assignment.pre_leave_shift : assignment.shift;
  if (!code || code === "OFF" || code === "LEAVE") return 0;
  if (assignment.scheduled_shift) return assignment.scheduled_shift.creditedMinutes / 60;
  // Backward-compatible responses from an API not yet upgraded.
  if (code === "M" || code === "MWC") return 9;
  if (code === "N" || code === "NC") return 15;
  return null;
}

export function assignmentTimeLabel(definition: ScheduledShift): string {
  return `${definition.start} – ${definition.end}${definition.endDayOffset ? ` (+${definition.endDayOffset} day)` : ""} · ${definition.timezone}`;
}

export function assignmentDescription(assignment?: AssignmentDefinition): string {
  if (!assignment) return "";
  if (assignment.shift_definition_error) return "Saved shift definition unavailable";
  if (assignment.shift === "OFF" || assignment.shift === "LEAVE") return assignment.shift;
  const definition = assignment.scheduled_shift;
  return definition
    ? `${definition.name} · ${assignmentTimeLabel(definition)} · ${definition.creditedMinutes / 60}h credit`
    : assignment.shift;
}

export function scheduledHoursByNurse(
  assignments: (AssignmentDefinition & { nurse_id: string })[],
) {
  const totals = new Map<string, { worked: number; leave: number; unavailable: boolean }>();
  for (const assignment of assignments) {
    const total = totals.get(assignment.nurse_id) ?? { worked: 0, leave: 0, unavailable: false };
    const hours = assignmentScheduledHours(assignment);
    if (hours == null) total.unavailable = true;
    else if (assignment.shift === "LEAVE") total.leave += hours;
    else total.worked += hours;
    totals.set(assignment.nurse_id, total);
  }
  return totals;
}
