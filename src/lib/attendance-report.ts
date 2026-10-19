import type { ScheduledShift } from "./assignment-shift-definition";

export type AttendanceDefinition = {
  shift_type: string;
  scheduling_definition?: ScheduledShift | null;
};

export function attendanceShiftLabel(log: AttendanceDefinition): string {
  return (
    log.scheduling_definition?.name ??
    (
      { M: "Morning", MWC: "Morning Weekend Coverage", N: "Night", NC: "Night Coverage" } as Record<
        string,
        string
      >
    )[log.shift_type] ??
    log.shift_type
  );
}

// Include the historical name in the key: the same code may have been renamed
// or used for different duties by two hospitals.
export function attendanceShiftKey(log: AttendanceDefinition): string {
  return JSON.stringify([
    log.scheduling_definition?.code ?? log.shift_type,
    attendanceShiftLabel(log),
  ]);
}

export function attendanceShiftOptions(logs: AttendanceDefinition[]) {
  const options = new Map<string, string>();
  for (const log of logs)
    options.set(
      attendanceShiftKey(log),
      `${attendanceShiftLabel(log)} (${log.scheduling_definition?.code ?? log.shift_type})`,
    );
  return [...options]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function attendanceDefinitionColumns(log: AttendanceDefinition) {
  const definition = log.scheduling_definition;
  return {
    "Shift Code": definition?.code ?? log.shift_type,
    "Scheduled Start (UTC)": definition?.startsAt ?? "",
    "Scheduled End (UTC)": definition?.endsAt ?? "",
    "Shift Timezone": definition?.timezone ?? "",
    "Break Minutes": definition?.breakMinutes ?? "",
    "Scheduled Credit Hours": definition ? definition.creditedMinutes / 60 : "",
  };
}
