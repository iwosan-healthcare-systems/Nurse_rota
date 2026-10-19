import type { AssignmentDefinition } from "./assignment-shift-definition";

type ExportAssignment = AssignmentDefinition & { nurse_id: string; shift_date: string };
const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

export function scheduleExportDefinitions(assignments: ExportAssignment[]) {
  const entries = new Map<
    string,
    {
      code: string;
      name: string;
      start: string;
      end: string;
      timezone: string;
      breakMinutes: number | string;
      creditHours: number | string;
      color: string;
    }
  >();
  const signatures = assignments.map((a) => {
    const d = a.scheduled_shift;
    const system = a.shift === "OFF" || a.shift === "LEAVE";
    const entry = {
      code: a.shift,
      name: system
        ? a.shift
        : a.shift_definition_error
          ? "Definition unavailable"
          : (d?.name ?? a.shift),
      start: system ? "" : (d?.start ?? ""),
      end: system ? "" : d ? `${d.end}${d.endDayOffset ? ` (+${d.endDayOffset} day)` : ""}` : "",
      timezone: system ? "" : (d?.timezone ?? ""),
      breakMinutes: system ? "" : (d?.breakMinutes ?? ""),
      creditHours: system ? "" : d ? d.creditedMinutes / 60 : "",
      color: system
        ? a.shift === "OFF"
          ? "#f3f4f6"
          : "#fee2e2"
        : d?.color && /^#[0-9a-f]{6}$/i.test(d.color)
          ? d.color
          : "#ffffff",
    };
    const key = JSON.stringify(entry);
    entries.set(key, entry);
    return key;
  });
  const counts = new Map<string, number>();
  for (const entry of entries.values()) counts.set(entry.code, (counts.get(entry.code) ?? 0) + 1);
  const seen = new Map<string, number>();
  const aliases = new Map<string, string>();
  const legend = [...entries].map(([key, entry]) => {
    const number = (seen.get(entry.code) ?? 0) + 1;
    seen.set(entry.code, number);
    const label = (counts.get(entry.code) ?? 0) > 1 ? `${entry.code} [${number}]` : entry.code;
    aliases.set(key, label);
    return { ...entry, label };
  });
  const cells = new Map(
    assignments.map((a, index) => [
      `${a.nurse_id}|${a.shift_date.slice(0, 10)}`,
      aliases.get(signatures[index])!,
    ]),
  );
  const colors = new Map(legend.map((entry) => [entry.label, entry.color]));
  const rows = legend.map((e) => ({
    Code: e.label,
    Name: e.name,
    Start: e.start,
    End: e.end,
    Timezone: e.timezone,
    "Break Minutes": e.breakMinutes,
    "Credit Hours": e.creditHours,
  }));
  const html = `<div class="legend" style="flex-wrap:wrap">${legend.map((e) => `<span><span class="lb" style="background:${e.color}"></span>${escapeHtml(e.label)} ${escapeHtml(e.name)}${e.start ? ` · ${escapeHtml(e.start)}–${escapeHtml(e.end)} · ${escapeHtml(e.timezone)} · ${e.creditHours}h credit · ${e.breakMinutes}m break` : ""}</span>`).join("")}</div>`;
  return { cells, colors, rows, html };
}
