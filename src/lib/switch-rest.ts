import type { AssignmentDefinition } from "./assignment-shift-definition";

// Return a user-facing reason; null means the available saved intervals permit rest.
export function switchRestIssue(
  proposed: AssignmentDefinition,
  neighbors: AssignmentDefinition[],
): string | null {
  if (["OFF", "LEAVE"].includes(proposed.shift)) return null;
  const interval = (row: AssignmentDefinition): [number, number] | null => {
    if (row.shift_definition_error || !row.scheduled_shift) return null;
    const start = Date.parse(row.scheduled_shift.startsAt);
    const end = Date.parse(row.scheduled_shift.endsAt);
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? [start, end] : null;
  };
  const duty = interval(proposed);
  if (!duty) return "Shift times are unavailable. Reload before requesting this switch.";
  for (const row of neighbors) {
    if (["OFF", "LEAVE"].includes(row.shift)) continue;
    const other = interval(row);
    if (!other)
      return "A neighboring shift's times are unavailable. Reload before requesting this switch.";
    if (duty[0] <= other[1] && other[0] <= duty[1])
      return "This switch would leave overlapping duties or no rest between shifts.";
  }
  return null;
}
