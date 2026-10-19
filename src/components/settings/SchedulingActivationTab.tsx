import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApiError, api } from "@/lib/api";
import type { ConfigurationVersion, RotaPreview } from "@/lib/scheduling-configuration";
import { fetchRotaPeriod } from "@/lib/use-current-rota-period";
import { rotaPeriodLabel } from "@/lib/rota-window";
import { SchedulingActivation } from "./SchedulingActivation";

// Server messages name days as YYYY-MM-DD; show them as "14 Dec 2026".
const readableDates = (text: string) =>
  text.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, m, d) =>
    new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }),
  );

// Puts the saved configuration into use. Checking a period saves a review of the
// configuration against current staff and approved leave (required before
// activation); only its issues are listed, not a rota grid.
export function SchedulingActivationTab({
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
  const queryClient = useQueryClient();
  const [month, setMonth] = useState("");
  // The chosen month's rota period start: the 1st, or the day after a hospital's
  // last legacy 28-day period in its transition month.
  const [startDate, setStartDate] = useState("");

  function chooseMonth(value: string) {
    setMonth(value);
    setStartDate("");
    setResult(null);
    if (!value) return;
    const [y, m] = value.split("-").map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    fetchRotaPeriod(lastDay)
      .then((p) => setStartDate(p.start))
      .catch((e) => setError(e instanceof Error ? e.message : "Could not find this rota period"));
  }
  const [result, setResult] = useState<RotaPreview | null>(null);
  const [error, setError] = useState("");
  const [errors, setErrors] = useState<string[]>([]);

  async function check() {
    if (!version || !startDate) return;
    onBusyChange(true);
    setError("");
    setErrors([]);
    setResult(null);
    try {
      setResult(
        await api.post<RotaPreview>(`${base}/versions/${version.id}/runs`, {
          revision: version.revision,
          startDate,
        }),
      );
      void queryClient.invalidateQueries({ queryKey: ["scheduling-runs", base] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not check this period");
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

  const blocking = result?.diagnostics.filter((d) => d.severity === "error") ?? [];
  const warnings = result?.diagnostics.filter((d) => d.severity !== "error") ?? [];

  if (!canManage)
    return (
      <p className="text-sm text-muted-foreground">
        Putting these rules into use requires permission to manage scheduling configuration.
      </p>
    );

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-xl border bg-card p-4">
        <h3 className="font-semibold">Check a period</h3>
        <p className="text-sm text-muted-foreground">
          Choose the month (rota period) these rules should start from, then check them against
          current staff and approved leave. Activation needs a check with no blocking issues.
        </p>
        {!version && <p className="text-sm text-amber-800">Save the configuration first.</p>}
        {dirty && (
          <p className="text-sm text-amber-800">Save your changes before checking a period.</p>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1.5 text-sm font-medium">
            Rota month
            <input
              type="month"
              className="rounded-md border bg-background p-2"
              value={month}
              disabled={busy}
              onChange={(e) => chooseMonth(e.target.value)}
            />
          </label>
          <Button disabled={!version || dirty || busy || !startDate} onClick={() => void check()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}Check this period
          </Button>
        </div>
        {error && (
          <div role="alert" className="text-sm text-destructive">
            <p>{error}</p>
            {errors.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {errors.map((message, i) => (
                  <li key={i}>{readableDates(message)}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {result && (
          <div aria-live="polite" className="space-y-2 text-sm">
            {blocking.length ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                <p className="font-medium text-destructive">
                  {blocking.length} blocking issue{blocking.length === 1 ? "" : "s"} for{" "}
                  {rotaPeriodLabel(result.startDate, result.endDate)} must be resolved before
                  activation
                </p>
                <ul className="mt-1 list-disc pl-5">
                  {blocking.slice(0, 20).map((d, i) => (
                    <li key={i}>{readableDates(d.message)}</li>
                  ))}
                </ul>
                {blocking.length > 20 && (
                  <p className="mt-1 text-xs">…and {blocking.length - 20} more.</p>
                )}
              </div>
            ) : (
              <p className="rounded-lg border border-green-300 bg-green-50 p-3 text-green-950">
                No blocking issues for {rotaPeriodLabel(result.startDate, result.endDate)}
                {warnings.length
                  ? ` · ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`
                  : ""}
                . You can activate these rules from this period.
              </p>
            )}
          </div>
        )}
      </div>
      <div className="space-y-3 rounded-xl border bg-card p-4">
        <SchedulingActivation
          base={base}
          startDate={startDate}
          result={result}
          wards={wards}
          busy={busy}
          dirty={dirty}
          onBusyChange={onBusyChange}
        />
      </div>
    </div>
  );
}
