import type { RotaPreview } from "@/lib/scheduling-configuration";

type Issue = RotaPreview["diagnostics"][number];
export type IssueGroup = { label: string; dates: string[] };

const shortDate = (d: string) =>
  new Date(d.slice(0, 10) + "T00:00:00").toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });

/** "7 Dec, 14 Dec, 21 Dec" (all of them, in date order). */
export function issueDates(dates: string[]) {
  return [...new Set(dates)].sort().map(shortDate).join(", ");
}

/**
 * One line per problem instead of one per day: ward shortfalls by ward, shift
 * and staff category; coverage gaps by shift; anything else by its message.
 */
export function groupScheduleIssues(issues: Issue[], wardName: (id?: string) => string) {
  const groups = new Map<string, IssueGroup>();
  for (const issue of issues) {
    const people = issue.category === "na" ? "nursing assistants" : "nurses";
    let label: string;
    if (issue.code === "STAFFING_SHORTFALL")
      label = `${wardName(issue.wardId)} · ${issue.shift} ${people}: fewer than the minimum of ${issue.minimum}`;
    else if (issue.code === "STAFFING_EXCESS")
      label = `${wardName(issue.wardId)} · ${issue.shift} ${people}: more than the maximum of ${issue.maximum}`;
    else if (issue.code === "COVERAGE_GAP" || issue.code === "CONFIGURED_COVERAGE_GAP")
      label = `${issue.shift} coverage: nobody available`;
    else label = issue.message.replace(/\s*(on )?\b\d{4}-\d{2}-\d{2}\b\.?/g, "").trim();
    const group = groups.get(label) ?? { label, dates: [] };
    if (issue.date) group.dates.push(issue.date);
    groups.set(label, group);
  }
  return [...groups.values()];
}
