import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { SchedulingActivation } from "./SchedulingActivation";
import type {
  ConfigurationVersion,
  RotaPreview,
  SchedulingConfiguration,
} from "@/lib/scheduling-configuration";

export function SchedulingRotaPreview({
  base,
  version,
  config,
  dirty,
  busy,
  canManage,
  wards,
  onBusyChange,
}: {
  base: string;
  version: ConfigurationVersion | null;
  config: SchedulingConfiguration;
  dirty: boolean;
  busy: boolean;
  canManage: boolean;
  wards: { id: string; name: string }[];
  onBusyChange: (busy: boolean) => void;
}) {
  const [startDate, setStartDate] = useState("");
  const [anchorDate, setAnchorDate] = useState("");
  const [result, setResult] = useState<RotaPreview | null>(null);
  const [error, setError] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [filter, setFilter] = useState("all");
  const [staffPage, setStaffPage] = useState(0);
  const [diagnosticPage, setDiagnosticPage] = useState(0);
  const [severity, setSeverity] = useState("all");
  const [draftMessage, setDraftMessage] = useState("");
  const queryClient = useQueryClient();
  const [selectedRun, setSelectedRun] = useState("");
  const runsQuery = useQuery({
    queryKey: ["scheduling-runs", base],
    enabled: canManage,
    queryFn: () =>
      api.get<{
        runs: {
          id: string;
          configuration_version: number;
          configuration_revision: number;
          start_date: string;
          created_at: string;
        }[];
      }>(`${base}/runs`),
  });
  const displayWards = result?.wardDefinitions ?? wards;
  const assignments = useMemo(
    () => new Map(result?.assignments.map((a) => [`${a.nurseId}:${a.date}`, a]) ?? []),
    [result],
  );
  const filteredStaff =
    result?.staff.filter(
      (n) => filter === "all" || (filter === "facility" ? n.wardId === null : n.wardId === filter),
    ) ?? [];
  const diagnostics =
    result?.diagnostics.filter((d) => severity === "all" || d.severity === severity) ?? [];
  async function generate(save = false) {
    if (!version || !startDate) return;
    onBusyChange(true);
    setDraftMessage("");
    setError("");
    setErrors([]);
    setResult(null);
    try {
      const preview = await api.post<RotaPreview>(
        `${base}/versions/${version.id}/${save ? "runs" : "preview"}`,
        {
          revision: version.revision,
          startDate,
          ...(anchorDate ? { anchorDate } : {}),
        },
      );
      setResult(preview);
      setSelectedRun(preview.runId ?? "");
      if (save) void queryClient.invalidateQueries({ queryKey: ["scheduling-runs", base] });
      setStaffPage(0);
      setDiagnosticPage(0);
      setFilter("all");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not generate preview");
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
  async function openRun() {
    if (!selectedRun) return;
    onBusyChange(true);
    setDraftMessage("");
    setError("");
    setErrors([]);
    setResult(null);
    try {
      const saved = await api.get<RotaPreview>(`${base}/runs/${selectedRun}`);
      setResult(saved);
      setStartDate(saved.startDate);
      setAnchorDate(saved.anchorDate);
      setFilter("all");
      setStaffPage(0);
      setDiagnosticPage(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load saved run");
    } finally {
      onBusyChange(false);
    }
  }
  async function createDraft() {
    if (
      !result?.runId ||
      !window.confirm(
        "Create a draft rota for every staff member in this saved run? Existing drafts for these staff and dates will be replaced. Submitted, approved and published shifts cannot be replaced.",
      )
    )
      return;
    onBusyChange(true);
    setError("");
    setErrors([]);
    setDraftMessage("");
    try {
      const saved = await api.post<{ written: number }>(`${base}/runs/${result.runId}/draft`, {});
      setDraftMessage(
        `${saved.written} draft cells created. Open Rota to review and submit them through the usual approval process.`,
      );
      void queryClient.invalidateQueries({ queryKey: ["assignments"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create draft");
    } finally {
      onBusyChange(false);
    }
  }
  return (
    <section className="space-y-4">
      <div className="space-y-4 rounded-xl border bg-card p-5">
        <h3 className="font-semibold">Preview a 28-day rota</h3>
        <p className="text-sm text-muted-foreground">
          Uses active staff, approved leave and published shift history for this facility. Nothing
          is saved to the live rota.
        </p>
        {(!version || dirty) && (
          <p className="text-sm text-amber-800">
            Save your configuration before generating a preview.
          </p>
        )}
        {!canManage && (
          <p className="text-sm text-muted-foreground">
            Generating a preview requires permission to manage scheduling configuration.
          </p>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1.5 text-sm font-medium">
            Period starts
            <input
              type="date"
              className="rounded-md border bg-background p-2"
              value={startDate}
              disabled={busy}
              onChange={(e) => {
                setStartDate(e.target.value);
                setResult(null);
              }}
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Cycle anchor (optional)
            <input
              type="date"
              max={startDate || undefined}
              className="rounded-md border bg-background p-2"
              value={anchorDate}
              disabled={busy}
              onChange={(e) => {
                setAnchorDate(e.target.value);
                setResult(null);
              }}
            />
          </label>
          <Button
            disabled={!version || dirty || busy || !canManage || !startDate}
            onClick={() => void generate()}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}Generate rota preview
          </Button>
          <Button
            variant="outline"
            disabled={!version || dirty || busy || !canManage || !startDate}
            onClick={() => void generate(true)}
          >
            Generate and save review run
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          The anchor defines day one of repeating cycles. Leave it blank to use the earliest
          published shift, or the preview start if there is no history. Unambiguous recent history
          takes precedence.
        </p>
      </div>
      {canManage && (
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
          <p className="text-sm">
            Saved review runs preserve the settings and results at generation time. They do not
            publish shifts. Saving generates a fresh run from current staff and leave; it does not
            save an earlier on-screen preview.
          </p>
          <label className="grid gap-1 text-sm">
            Saved review run
            <select
              className="rounded-md border bg-background p-2"
              value={selectedRun}
              disabled={busy}
              onChange={(e) => setSelectedRun(e.target.value)}
            >
              <option value="">Choose a saved run (latest 100)</option>
              {runsQuery.data?.runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.start_date} · v{run.configuration_version} r{run.configuration_revision} ·{" "}
                  {new Date(run.created_at).toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          {runsQuery.isError && (
            <p role="alert" className="text-sm">
              Saved runs could not be loaded.
            </p>
          )}
          <Button
            variant="outline"
            disabled={!selectedRun || busy || dirty}
            onClick={() => void openRun()}
          >
            Open saved run
          </Button>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"
        >
          <strong>{error}</strong>
          <ul className="mt-2 list-disc pl-5">
            {errors.map((message, i) => (
              <li key={i}>{message}</li>
            ))}
          </ul>
        </div>
      )}
      {draftMessage && (
        <p role="status" className="rounded-md border p-3 text-sm">
          {draftMessage}
        </p>
      )}
      {result && !dirty && (
        <>
          <div
            role="status"
            className={`rounded-xl border p-4 text-sm ${result.hasBlockingIssues ? "border-amber-300 bg-amber-50 text-amber-950" : "bg-card"}`}
          >
            <strong>
              {result.hasBlockingIssues ? "Preview has issues to resolve" : "Preview generated"}
            </strong>
            <p>
              Version {result.configurationVersion}, revision {result.configurationRevision} ·{" "}
              {result.startDate} to {result.endDate} · {result.timezone}
            </p>
            <p>Cycle anchor: {result.anchorDate}.</p>
            {result.runId && (
              <p>
                Saved review run · {result.savedAt && new Date(result.savedAt).toLocaleString()}.
                This historical snapshot may differ from current staff, leave and settings.
              </p>
            )}
            {result.runId && canManage && (
              <div className="mt-3 space-y-2">
                <p>
                  Creating a draft requires administrator access, shift editing permission and a
                  fresh run with no blocking issues. Only existing shift definitions and approval
                  groups are supported.
                </p>
                <Button
                  variant="outline"
                  disabled={busy || dirty || result.hasBlockingIssues}
                  onClick={() => void createDraft()}
                >
                  Create rota draft from this run
                </Button>
              </div>
            )}
          </div>
          <div className="space-y-3 rounded-xl border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-semibold">Staff rota ({filteredStaff.length})</h3>
              <label className="flex items-center gap-2 text-sm">
                Show
                <select
                  className="rounded-md border bg-background p-2"
                  value={filter}
                  onChange={(e) => {
                    setFilter(e.target.value);
                    setStaffPage(0);
                  }}
                >
                  <option value="all">All staff</option>
                  <option value="facility">Facility-wide staff</option>
                  {displayWards.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {!filteredStaff.length ? (
              <p className="text-sm text-muted-foreground">
                No active staff match this view. Staffing requirements are still checked for empty
                wards.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1500px] text-center text-xs">
                  <thead>
                    <tr className="border-b">
                      <th className="sticky left-0 z-10 min-w-44 bg-card p-2 text-left">
                        Staff / role
                      </th>
                      {result.dates.map((date) => (
                        <th key={date} className="p-2" title={date}>
                          {date.slice(5)}
                        </th>
                      ))}
                      <th className="p-2">Work hours</th>
                      <th className="p-2">Leave planned hours</th>
                      <th className="p-2">Target hours</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredStaff.slice(staffPage * 25, (staffPage + 1) * 25).map((n) => (
                      <tr key={n.id} className="border-b">
                        <th className="sticky left-0 z-10 bg-card p-2 text-left font-normal">
                          <strong className="block">{n.name}</strong>
                          <span>{n.role}</span>
                          <span className="block text-muted-foreground">
                            Position: {n.phaseSource}
                          </span>
                        </th>
                        {result.dates.map((date) => {
                          const a = assignments.get(`${n.id}:${date}`);
                          const shift = (result.shiftDefinitions ?? config.shifts).find(
                            (s) => s.code === a?.shift,
                          );
                          return (
                            <td
                              key={date}
                              className="p-1"
                              title={
                                a
                                  ? `${a.leaveType ?? a.shift}${a.shift === "LEAVE" ? ` (planned ${a.plannedShift})` : ""}${a.start ? ` · ${a.start} to ${a.end}` : ""}`
                                  : ""
                              }
                            >
                              <span
                                className="block rounded border px-1 py-2 font-semibold"
                                style={{ borderColor: shift?.color }}
                              >
                                {a?.shift ?? "—"}
                              </span>
                            </td>
                          );
                        })}
                        <td>{(n.workingMinutes / 60).toFixed(1)}</td>
                        <td>{(n.plannedLeaveMinutes / 60).toFixed(1)}</td>
                        <td>{(n.targetMinutes / 60).toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {filteredStaff.length > 25 && (
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  disabled={staffPage === 0}
                  onClick={() => setStaffPage((p) => p - 1)}
                >
                  Previous staff
                </Button>
                <span className="text-sm">
                  Page {staffPage + 1} of {Math.ceil(filteredStaff.length / 25)}
                </span>
                <Button
                  variant="outline"
                  disabled={(staffPage + 1) * 25 >= filteredStaff.length}
                  onClick={() => setStaffPage((p) => p + 1)}
                >
                  Next staff
                </Button>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Leave planned hours show the working shifts replaced by approved leave; they are not a
              leave entitlement or payroll calculation. Targets are shown for comparison, not
              guaranteed by the pattern.
            </p>
          </div>
          <div className="space-y-3 rounded-xl border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-semibold">Checks ({diagnostics.length})</h3>
              <label className="flex items-center gap-2 text-sm">
                Severity
                <select
                  className="rounded-md border bg-background p-2"
                  value={severity}
                  onChange={(e) => {
                    setSeverity(e.target.value);
                    setDiagnosticPage(0);
                  }}
                >
                  <option value="all">All</option>
                  <option value="error">Issues</option>
                  <option value="warning">Warnings</option>
                  <option value="info">Information</option>
                </select>
              </label>
            </div>
            {!diagnostics.length ? (
              <p className="text-sm">No matching issues found.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {diagnostics.slice(diagnosticPage * 50, (diagnosticPage + 1) * 50).map((d, i) => (
                  <li key={i} className="rounded border p-3">
                    <strong>
                      {d.severity === "error"
                        ? "Issue"
                        : d.severity === "warning"
                          ? "Warning"
                          : "Info"}
                      :{" "}
                    </strong>
                    {d.message}
                  </li>
                ))}
              </ul>
            )}
            {diagnostics.length > 50 && (
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  disabled={diagnosticPage === 0}
                  onClick={() => setDiagnosticPage((p) => p - 1)}
                >
                  Previous checks
                </Button>
                <span className="text-sm">
                  Page {diagnosticPage + 1} of {Math.ceil(diagnostics.length / 50)}
                </span>
                <Button
                  variant="outline"
                  disabled={(diagnosticPage + 1) * 50 >= diagnostics.length}
                  onClick={() => setDiagnosticPage((p) => p + 1)}
                >
                  Next checks
                </Button>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Checks include configured staffing counts, ambiguous clock changes, overlaps and
              shifts with no break between them. Hospital-specific minimum rest hours and maximum
              consecutive days are not configured in this release.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
