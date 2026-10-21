import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApiError, api } from "@/lib/api";
import type { ConfigurationVersion, RotaPreview } from "@/lib/scheduling-configuration";
import { fetchRotaPeriod } from "@/lib/use-current-rota-period";
import { rotaPeriodLabel, rotaToday } from "@/lib/rota-window";
import { groupScheduleIssues, issueDates } from "@/lib/schedule-issues";

// This month and the next 12, as "YYYY-MM" values with "December 2026" labels.
function upcomingMonths() {
  const [y, m] = rotaToday().split("-").map(Number);
  return Array.from({ length: 13 }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    return {
      value: d.toISOString().slice(0, 7),
      label: d.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }),
    };
  });
}

// Optional preview of how the saved rules would staff a month with current
// staff and approved leave. Nothing is saved, and issues never stop a rota
// being generated or published; they also show in Approvals and printouts.
export function SchedulingCheckTab({
  base,
  version,
  dirty,
  busy,
  canManage,
  wards,
  onBusyChange,
}: {
  base: string;
  version: ConfigurationVersion | null;
  dirty: boolean;
  busy: boolean;
  canManage: boolean;
  wards: { id: string; name: string }[];
  onBusyChange: (busy: boolean) => void;
}) {
  const [monthOptions] = useState(upcomingMonths);
  const [month, setMonth] = useState("");
  // The chosen month's rota period start: the 1st, or the day after a hospital's
  // last legacy 28-day period in its transition month.
  const [startDate, setStartDate] = useState("");
  const [result, setResult] = useState<RotaPreview | null>(null);
  const [error, setError] = useState("");
  const [errors, setErrors] = useState<string[]>([]);

  function chooseMonth(value: string) {
    setMonth(value);
    setStartDate("");
    setResult(null);
    setError("");
    if (!value) return;
    const [y, m] = value.split("-").map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    fetchRotaPeriod(lastDay)
      .then((p) => setStartDate(p.start))
      .catch((e) => setError(e instanceof Error ? e.message : "Could not find this rota period"));
  }

  async function check() {
    if (!version || !startDate) return;
    onBusyChange(true);
    setError("");
    setErrors([]);
    setResult(null);
    try {
      setResult(
        await api.post<RotaPreview>(`${base}/versions/${version.id}/preview`, {
          revision: version.revision,
          startDate,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not check this month");
      if (e instanceof ApiError && Array.isArray(e.data.errors))
        setErrors(
          e.data.errors.map((item) =>
            String((item as { message?: string }).message ?? "Invalid configuration"),
          ),
        );
    } finally {
      onBusyChange(false);
    }
  }

  const wardName = (id?: string) => wards.find((w) => w.id === id)?.name ?? "Ward";
  const groups = result
    ? groupScheduleIssues(
        result.diagnostics.filter((d) => d.severity === "error"),
        wardName,
      )
    : [];

  if (!canManage)
    return (
      <p className="text-sm text-muted-foreground">
        Checking a month requires permission to manage scheduling configuration.
      </p>
    );

  return (
    <div className="space-y-3 rounded-xl border bg-card p-4">
      <h3 className="font-semibold">Check a month</h3>
      <p className="text-sm text-muted-foreground">
        Optional. See how the saved rules would staff a month with current staff and approved leave.
        Nothing is saved. Shortfalls never stop a rota being generated or published; they are listed
        in Approvals and on schedule printouts.
      </p>
      {!version && <p className="text-sm text-amber-800">Save the configuration first.</p>}
      {dirty && <p className="text-sm text-amber-800">Save your changes before checking.</p>}
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1.5 text-sm font-medium">
          Rota month
          <select
            className="rounded-md border bg-background p-2"
            value={month}
            disabled={busy}
            onChange={(e) => chooseMonth(e.target.value)}
          >
            <option value="">Choose a month…</option>
            {monthOptions.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <Button disabled={!version || dirty || busy || !startDate} onClick={() => void check()}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}Check this month
        </Button>
      </div>
      {error && (
        <div role="alert" className="text-sm text-destructive">
          <p>{error}</p>
          {errors.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {errors.map((message, i) => (
                <li key={i}>{message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {result && (
        <div aria-live="polite" className="text-sm">
          {groups.length ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-950">
              <p className="font-medium">
                {rotaPeriodLabel(result.startDate, result.endDate)}: {groups.length} staffing issue
                {groups.length === 1 ? "" : "s"} with current staff
              </p>
              <ul className="mt-2 space-y-1.5">
                {groups.map((g) => (
                  <li key={g.label}>
                    <span className="font-medium">{g.label}</span>
                    {g.dates.length > 0 && (
                      <span className="block text-xs text-amber-900/80">
                        {g.dates.length} day{g.dates.length === 1 ? "" : "s"}: {issueDates(g.dates)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="rounded-lg border border-green-300 bg-green-50 p-3 text-green-950">
              No staffing issues for {rotaPeriodLabel(result.startDate, result.endDate)} with
              current staff and approved leave.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
