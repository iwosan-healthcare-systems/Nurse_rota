import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import type { RotaPreview } from "@/lib/scheduling-configuration";

export function SchedulingActivation({
  base,
  startDate,
  result,
  wards,
  busy,
  dirty,
  onBusyChange,
}: {
  base: string;
  startDate: string;
  result: RotaPreview | null;
  wards: { id: string; name: string }[];
  busy: boolean;
  dirty: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const [unit, setUnit] = useState("all");
  const [joiner, setJoiner] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const client = useQueryClient();
  const policy = useQuery({
    queryKey: ["scheduling-policy", base, startDate],
    enabled: !!startDate,
    queryFn: () =>
      api.get<{
        policy: null | {
          state: "active" | "paused";
          effective_from: string;
          source_run_id: string;
        };
      }>(`${base}/active?startDate=${encodeURIComponent(startDate)}`),
  });
  const active = policy.data?.policy?.state === "active";
  const candidates = useQuery({
    queryKey: ["scheduling-add-staff", base, startDate],
    enabled: !!startDate && active,
    queryFn: () =>
      api.get<{ staff: { id: string; name: string; role: string; ward: string | null }[] }>(
        `${base}/add-staff-candidates?startDate=${encodeURIComponent(startDate)}`,
      ),
  });
  async function addStaff() {
    const name = candidates.data?.staff.find((n) => n.id === joiner)?.name ?? "this staff member";
    if (
      !window.confirm(
        `Schedule ${name} from ${fromDate} to the end of this period using the active rules? Draft cells are created for review; other staff are unchanged.`,
      )
    )
      return;
    onBusyChange(true);
    setError("");
    setMessage("");
    try {
      const response = await api.post<{ written: number }>(`${base}/add-staff`, {
        startDate,
        nurseId: joiner,
        fromDate,
      });
      setMessage(
        `${response.written} draft cells created for ${name}. Review and submit them in Rota.`,
      );
      setJoiner("");
      void client.invalidateQueries({ queryKey: ["scheduling-add-staff", base] });
      void client.invalidateQueries({ queryKey: ["scheduling-runs", base] });
      void client.invalidateQueries({ queryKey: ["assignments"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add this staff member");
    } finally {
      onBusyChange(false);
    }
  }
  async function act(action: "activate" | "pause" | "generate-active") {
    const confirmation =
      action === "activate"
        ? `Activate the reviewed rules from ${result?.startDate}? Recurring generation will use this frozen configuration for future drafts. Existing schedules are not replaced.`
        : action === "pause"
          ? "Pause configured generation for this facility? Existing schedules will remain. Legacy generation will not take over."
          : "Generate this unit using the active configuration? Its existing draft cells will be replaced; submitted, approved and published shifts are protected.";
    if (!window.confirm(confirmation)) return;
    onBusyChange(true);
    setError("");
    setMessage("");
    try {
      const response = await api.post<{ written?: number }>(
        action === "activate" ? `${base}/runs/${result?.runId}/activate` : `${base}/${action}`,
        action === "generate-active" ? { startDate, unit } : {},
      );
      setMessage(
        action === "activate"
          ? `Rules activated from ${result?.startDate}. Later draft edits require a new activation.`
          : action === "pause"
            ? "Configured generation paused. Existing schedules are unchanged."
            : `${response.written} draft cells created using the active rules. Review and submit them in Rota.`,
      );
      void client.invalidateQueries({ queryKey: ["scheduling-policy", base] });
      void client.invalidateQueries({ queryKey: ["scheduling-runs", base] });
      if (action === "generate-active")
        void client.invalidateQueries({ queryKey: ["assignments"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scheduling action failed");
    } finally {
      onBusyChange(false);
    }
  }
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <h3 className="font-semibold">Active scheduling rules</h3>
      <p className="text-sm text-muted-foreground">
        Administrator access is required. Activate a fresh, reviewed run for a clean future 28-day
        period. Activated shift definitions and role groups drive attendance, hours, leave credits
        and approval grouping for that period onward.
      </p>
      <p className="text-sm">
        {!startDate
          ? "Choose a period start to check its rules."
          : policy.isPending
            ? "Checking scheduling policy…"
            : policy.isError
              ? "Could not load scheduling policy."
              : policy.data?.policy
                ? policy.data.policy.state === "paused"
                  ? "Configured generation is paused for this period."
                  : `Active for this period, effective from ${policy.data.policy.effective_from}.`
                : "No configuration is activated for this period."}
      </p>
      <div className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          disabled={busy || dirty || !result?.runId || result.hasBlockingIssues}
          onClick={() => void act("activate")}
        >
          Activate reviewed run
        </Button>
        <Button
          variant="outline"
          disabled={busy || !policy.data?.policy || policy.data.policy.state === "paused"}
          onClick={() => void act("pause")}
        >
          Pause configured generation
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm">
          Scheduling unit
          <select
            className="rounded-md border bg-background p-2"
            value={unit}
            disabled={busy}
            onChange={(e) => setUnit(e.target.value)}
          >
            <option value="all">Whole facility</option>
            {wards.map((w) => (
              <option key={w.id} value={`ward:${w.id}`}>
                {w.name}
              </option>
            ))}
            <option value="group:head">Coverage nurses</option>
            <option value="group:matron">Matrons</option>
            <option value="group:porter">Porters</option>
            <option value="group:intern">Nurse interns</option>
          </select>
        </label>
        <Button
          disabled={
            busy ||
            dirty ||
            policy.isFetching ||
            policy.isError ||
            policy.data?.policy?.state !== "active"
          }
          onClick={() => void act("generate-active")}
        >
          Generate with active rules
        </Button>
      </div>
      {active && (
        <div className="space-y-2 border-t pt-3">
          <h4 className="text-sm font-semibold">Add a new staff member to this period</h4>
          <p className="text-sm text-muted-foreground">
            For staff who join after the period was generated. Only active staff with no shifts in
            this period are listed.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm">
              Staff member
              <select
                className="rounded-md border bg-background p-2"
                value={joiner}
                disabled={busy || candidates.isPending}
                onChange={(e) => setJoiner(e.target.value)}
              >
                <option value="">
                  {candidates.isPending
                    ? "Loading…"
                    : candidates.data?.staff.length
                      ? "Choose staff…"
                      : "No unscheduled staff"}
                </option>
                {candidates.data?.staff.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name} · {n.role}
                    {n.ward ? ` · ${n.ward}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              First date
              <input
                type="date"
                className="rounded-md border bg-background p-2"
                value={fromDate}
                min={startDate}
                disabled={busy}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </label>
            <Button
              variant="outline"
              disabled={busy || dirty || !joiner || !fromDate}
              onClick={() => void addStaff()}
            >
              Add to period
            </Button>
          </div>
        </div>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
