export type StaffingRequirement = {
  wardId: string;
  shift: string;
  category: string;
  weekday: number;
  minimum: number;
  maximum: number | null;
};
export type StaffingAssignment = {
  shift: string;
  shift_date: string;
  nurse_id: string;
  shift_definition_run_id?: string | null;
  scheduling_run_id?: string | null;
  scheduled_staffing?: {
    wardId?: string;
    category?: string;
    requirements?: StaffingRequirement[];
    error: string | null;
  } | null;
};
const esc = (s: unknown) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
export function assessScheduleStaffing(assignments: StaffingAssignment[], dates: string[]) {
  if (
    !assignments.some(
      (a) => a.shift_definition_run_id || a.scheduling_run_id || a.scheduled_staffing,
    )
  )
    return null;
  const unavailable = (reason: string) => ({
    rows: [{ Status: reason }],
    html: `<p>${esc(reason)}</p>`,
  });
  if (assignments.some((a) => !a.scheduled_staffing || a.scheduled_staffing.error))
    return unavailable(
      "Staffing assessment unavailable: missing saved definitions or mixed legacy assignments.",
    );
  const rows: Record<string, string | number>[] = [];
  for (const date of dates) {
    const cells = assignments.filter((a) => a.shift_date.slice(0, 10) === date);
    if (!cells.length)
      return unavailable("Staffing assessment unavailable: the exported period has missing dates.");
    const weekday = ((new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7) + 1;
    const requirements = cells[0].scheduled_staffing!.requirements!;
    const signature = (rules: StaffingRequirement[]) =>
      JSON.stringify(rules.map((r) => JSON.stringify(r)).sort());
    if (
      cells.some((c) => signature(c.scheduled_staffing!.requirements!) !== signature(requirements))
    )
      return unavailable(
        "Staffing assessment unavailable: conflicting saved requirements on the same date.",
      );
    for (const r of requirements.filter((r) => r.weekday === weekday)) {
      const actual = new Set(
        cells
          .filter(
            (c) =>
              c.shift === r.shift &&
              c.scheduled_staffing!.category === r.category &&
              c.scheduled_staffing!.wardId === r.wardId,
          )
          .map((c) => c.nurse_id),
      ).size;
      rows.push({
        Date: date,
        Shift: r.shift,
        Category: r.category,
        Minimum: r.minimum,
        Maximum: r.maximum ?? "",
        Actual: actual,
        Status:
          actual < r.minimum
            ? "Shortfall"
            : r.maximum != null && actual > r.maximum
              ? "Excess"
              : "Met",
      });
    }
  }
  if (!rows.length)
    return unavailable("No saved staffing requirements apply to this exported period.");
  const headings = Object.keys(rows[0]);
  const html = `<h2>Staffing assessment — saved requirements</h2><table><thead><tr>${headings.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${headings.map((h) => `<td>${esc(r[h])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  return { rows, html };
}
