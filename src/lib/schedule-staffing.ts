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
const dayLabel = (d: string) =>
  new Date(d.slice(0, 10) + "T00:00:00").toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
const shortDay = (d: string) =>
  new Date(d.slice(0, 10) + "T00:00:00").toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });

/** One shortfall (or excess) line: a shift and staff category short on some days. */
export type StaffingShortfall = {
  shift: string;
  category: string;
  required: string;
  kind: "Shortfall" | "Excess";
  days: { date: string; actual: number }[];
};
const categoryName = (c: string) => (c === "na" ? "Nursing assistants" : "Nurses");
export const shortfallSummary = (s: StaffingShortfall) =>
  `${s.kind === "Shortfall" ? "Short" : "Over"}: ${s.shift} ${categoryName(s.category).toLowerCase()} (required ${s.required}) on ${s.days.map((d) => `${shortDay(d.date)} (${d.actual})`).join(", ")}`;

export function assessScheduleStaffing(assignments: StaffingAssignment[], dates: string[]) {
  if (
    !assignments.some(
      (a) => a.shift_definition_run_id || a.scheduling_run_id || a.scheduled_staffing,
    )
  )
    return null;
  const unavailable = (reason: string) => ({
    rows: [{ Status: reason }] as Record<string, string | number>[],
    shortfalls: [] as StaffingShortfall[],
    html: `<p>${esc(reason)}</p>`,
  });
  if (assignments.some((a) => !a.scheduled_staffing || a.scheduled_staffing.error))
    return unavailable(
      "Staffing assessment unavailable: missing saved definitions or mixed legacy assignments.",
    );
  const rows: Record<string, string | number>[] = [];
  const shortfalls = new Map<string, StaffingShortfall>();
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
      const status =
        actual < r.minimum
          ? "Shortfall"
          : r.maximum != null && actual > r.maximum
            ? "Excess"
            : "Met";
      rows.push({
        Date: dayLabel(date),
        Shift: r.shift,
        Category: r.category,
        Minimum: r.minimum,
        Maximum: r.maximum ?? "",
        Actual: actual,
        Status: status,
      });
      if (status !== "Met") {
        const required = r.maximum == null ? `${r.minimum}+` : `${r.minimum}–${r.maximum}`;
        const key = JSON.stringify([status, r.shift, r.category, required]);
        const entry = shortfalls.get(key) ?? {
          shift: r.shift,
          category: r.category,
          required,
          kind: status,
          days: [],
        };
        entry.days.push({ date, actual });
        shortfalls.set(key, entry);
      }
    }
  }
  if (!rows.length)
    return unavailable("No saved staffing requirements apply to this exported period.");
  // Printouts list only the shortfalls, one line per shift and staff category;
  // the full day-by-day assessment stays in the Excel sheet.
  const list = [...shortfalls.values()];
  const html = list.length
    ? `<h2>Staffing shortfalls — saved requirements</h2><table><thead><tr><th>Shift</th><th>Staff</th><th>Required</th><th>Issue</th><th style="text-align:left">Days (staff on duty)</th></tr></thead><tbody>${list
        .map(
          (s) =>
            `<tr><td>${esc(s.shift)}</td><td>${esc(categoryName(s.category))}</td><td>${esc(s.required)}</td><td>${s.kind === "Shortfall" ? "Short" : "Over"}</td><td style="text-align:left;white-space:normal;">${esc(s.days.map((d) => `${shortDay(d.date)} (${d.actual})`).join(", "))}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<h2>Staffing — saved requirements</h2><p>Every day met the saved staffing requirements.</p>`;
  return { rows, shortfalls: list, html };
}

/**
 * Coverage duties for a facility-wide coverage group: nights without anyone on
 * NC, and weekend days without MWC. A duty the group never works in the period
 * is treated as not used there.
 */
export function assessCoverageGaps(
  cells: { shift: string; shift_date: string }[],
  dates: string[],
) {
  const onDuty = (date: string, shift: string) =>
    cells.some((c) => c.shift === shift && c.shift_date.slice(0, 10) === date);
  const used = (shift: string) => cells.some((c) => c.shift === shift);
  const gaps: { shift: string; dates: string[] }[] = [];
  if (used("NC")) gaps.push({ shift: "NC", dates: dates.filter((d) => !onDuty(d, "NC")) });
  if (used("MWC"))
    gaps.push({
      shift: "MWC",
      dates: dates.filter(
        (d) => [0, 6].includes(new Date(d + "T00:00:00Z").getUTCDay()) && !onDuty(d, "MWC"),
      ),
    });
  const missing = gaps.filter((g) => g.dates.length);
  if (!gaps.length) return null;
  const html = missing.length
    ? `<h2>Coverage gaps</h2><table><thead><tr><th>Duty</th><th style="text-align:left">Days with nobody on duty</th></tr></thead><tbody>${missing
        .map(
          (g) =>
            `<tr><td>${esc(g.shift)}</td><td style="text-align:left;white-space:normal;">${esc(g.dates.map(shortDay).join(", "))}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<h2>Coverage</h2><p>Coverage duties were filled every day.</p>`;
  return {
    html,
    rows: missing.map((g) => ({
      Duty: g.shift,
      "Days with nobody on duty": g.dates.map(shortDay).join(", "),
    })),
  };
}
