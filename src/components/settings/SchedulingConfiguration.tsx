import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, CheckCircle2, Loader2, AlertTriangle, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SchedulingCheckTab } from "./SchedulingCheckTab";
import { SchedulingCoverageRules } from "./SchedulingCoverageRules";
import { SchedulingShiftsTab } from "./SchedulingShiftsTab";
import { SchedulingPatternsTab } from "./SchedulingPatternsTab";
import { SchedulingRolesTab } from "./SchedulingRolesTab";
import { SchedulingWardsTab } from "./SchedulingWardsTab";
import { SchedulingReviewTab } from "./SchedulingReviewTab";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  configurationErrorLabel,
  errorTab,
  withEditableCoverage,
  LAGOON_HOSPITAL_ID,
  type SchedulingConfiguration as Configuration,
  type SchedulingFacility,
  type ConfigurationDefaults,
  type ConfigurationVersion,
  type ConfigurationValidation,
  type SchedulingTab,
  type VersionSummary,
} from "@/lib/scheduling-configuration";

// "December 2026" for a period starting on the 1st, otherwise "16 Nov 2026".
const periodName = (start: string) =>
  new Date(start.slice(0, 10) + "T00:00:00").toLocaleDateString(
    "en-GB",
    start.slice(8, 10) === "01"
      ? { month: "long", year: "numeric" }
      : { day: "numeric", month: "short", year: "numeric" },
  );
function Problem({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
    >
      {children}
    </div>
  );
}

type PageTab = SchedulingTab | "review" | "check";
const STEPS: { value: PageTab; label: string; description: string }[] = [
  { value: "shifts", label: "Shifts", description: "Times and hours" },
  { value: "patterns", label: "Patterns", description: "Order of shifts and days off" },
  { value: "roles", label: "Staff roles", description: "Who works which pattern" },
  { value: "wards", label: "Ward requirements", description: "Staff each ward needs" },
  { value: "coverage", label: "Coverage rules", description: "Taking turns, e.g. weekends" },
  { value: "review", label: "Review", description: "Read it back, then save" },
  { value: "check", label: "Check a month", description: "Optional preview" },
];

export function SchedulingConfigurationEditor({
  facility,
  canManage,
  onDirtyChange,
  onBusyChange,
}: {
  facility: SchedulingFacility;
  canManage: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const base = `/scheduling/facilities/${facility.id}`;
  const qc = useQueryClient();
  const [config, setConfig] = useState<Configuration | null>(null);
  const [saved, setSaved] = useState("");
  const [version, setVersion] = useState<ConfigurationVersion | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [conflict, setConflict] = useState(false);
  const [validation, setValidation] = useState<ConfigurationValidation | null>(null);
  const [tab, setTab] = useState<PageTab>("shifts");
  const dirty = config !== null && JSON.stringify(config) !== saved;
  const defaults = useQuery({
    queryKey: ["scheduling-defaults", facility.id],
    queryFn: () => api.get<ConfigurationDefaults>(`${base}/defaults`),
    retry: false,
  });
  const versions = useQuery({
    queryKey: ["scheduling-versions", facility.id],
    queryFn: () => api.get<{ versions: VersionSummary[] }>(`${base}/versions`),
    retry: false,
  });
  // Each facility keeps one current configuration: open the saved one, or the
  // hospital's existing rules if nothing has been saved yet.
  const current = versions.data?.versions[0] ?? null;
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (opened || !versions.data || !defaults.data) return;
    setOpened(true);
    if (current) void openVersion(current.id);
    else load(null, defaults.data.configuration);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, versions.data, defaults.data]);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  useEffect(
    () => () => {
      onDirtyChange(false);
      onBusyChange(false);
    },
    [onDirtyChange, onBusyChange],
  );
  const editable = canManage && !busy;
  // Retained (legacy) rules are Lagoon's; other hospitals only configure patterns.
  const lagoon = facility.organization_id === LAGOON_HOSPITAL_ID;
  const editableCoverage =
    config && defaults.data ? withEditableCoverage(config, defaults.data.configuration) : null;
  const wards = defaults.data?.wards ?? [];
  const confirmDiscard = () =>
    !dirty || window.confirm("Discard your unsaved configuration changes?");
  function load(row: ConfigurationVersion | null, configuration: Configuration) {
    setVersion(row);
    setConfig(structuredClone(configuration));
    setSaved(JSON.stringify(configuration));
    setValidation(null);
    setProblem("");
    setConflict(false);
  }
  function edit(next: Configuration) {
    setConfig(next);
    setValidation(null);
    setProblem("");
  }
  function showError(error: unknown) {
    setProblem(error instanceof Error ? error.message : "Unable to complete this action.");
    if (error instanceof ApiError) {
      if (error.status === 409) setConflict(true);
      const errors = error.data.errors;
      if (Array.isArray(errors))
        setValidation({
          valid: false,
          errors: errors as ConfigurationValidation["errors"],
          warnings: [],
        });
    }
  }
  async function openVersion(id: string) {
    setBusy(true);
    setProblem("");
    try {
      const row = await api.get<ConfigurationVersion>(`${base}/versions/${id}`);
      load(row, row.configuration);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }
  // Saving updates the current configuration in place (the first save creates it).
  async function save() {
    if (!config) return;
    setBusy(true);
    setProblem("");
    try {
      const row = version
        ? await api.put<ConfigurationVersion>(`${base}/versions/${version.id}`, {
            revision: version.revision,
            configuration: config,
          })
        : await api.post<ConfigurationVersion>(`${base}/versions`, { configuration: config });
      load(row, row.configuration);
      await qc.invalidateQueries({ queryKey: ["scheduling-versions", facility.id] });
      if (row.appliesFrom)
        toast.success(
          `Scheduling configuration saved · used for the next rota draft (${periodName(row.appliesFrom)})`,
        );
      else
        toast.warning(
          `Scheduling configuration saved, but not yet in use${row.reason ? `: ${row.reason}` : ""}`,
        );
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }
  async function validate() {
    if (!config) return;
    setBusy(true);
    setProblem("");
    try {
      setValidation(
        await api.post<ConfigurationValidation>(`${base}/validate`, { configuration: config }),
      );
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }
  if (defaults.isPending || versions.isPending)
    return (
      <p role="status" className="flex items-center gap-2 p-6">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading configuration…
      </p>
    );
  if (defaults.isError || versions.isError)
    return (
      <Problem>
        <p>
          Could not load scheduling configuration.{" "}
          {String((defaults.error || versions.error)?.message ?? "")}
        </p>
        <Button
          className="mt-3"
          variant="outline"
          onClick={() => {
            void defaults.refetch();
            void versions.refetch();
          }}
        >
          Retry
        </Button>
      </Problem>
    );

  const errors = validation && !validation.valid ? validation.errors : [];
  const issuesIn = (t: PageTab) => errors.filter((e) => errorTab(e.path) === t).length;
  const reviewCount = config?.roles.filter((r) => r.requiresReview).length ?? 0;

  return (
    <div className="space-y-5 pb-24">
      {problem && (
        <Problem>
          <p>{problem}</p>
          {conflict && (
            <p className="mt-2">
              Someone else saved this configuration after you opened it. Your edits are still here;
              reload the saved configuration to see their changes.
            </p>
          )}
        </Problem>
      )}
      {config && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
            <div>
              <h2 className="flex flex-wrap items-center gap-2 font-semibold">
                {facility.name} scheduling rules
                {dirty ? (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                    Unsaved changes
                  </span>
                ) : version ? (
                  <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-900 dark:bg-green-950 dark:text-green-200">
                    Saved
                  </span>
                ) : (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    Not saved yet
                  </span>
                )}
              </h2>
              <p className="text-sm text-muted-foreground">
                {version
                  ? `Last saved ${new Date(version.updated_at).toLocaleString("en-GB", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}`
                  : "Showing this facility's starting rules. Save to use them for rotas."}
                {version?.appliesFrom &&
                  ` · Used for rotas from ${periodName(version.appliesFrom)}`}
                {!canManage && " · view only"}
              </p>
            </div>
            {canManage && (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={busy} onClick={() => void validate()}>
                  <CheckCircle2 />
                  Check settings
                </Button>
                <Button
                  disabled={busy || conflict || (!!version && !dirty)}
                  onClick={() => void save()}
                >
                  {busy ? <Loader2 className="animate-spin" /> : <Save />}Save
                </Button>
              </div>
            )}
          </div>
          <div aria-live="polite">
            {validation &&
              (validation.valid ? (
                <div className="flex items-center gap-2 rounded-lg border border-green-300 bg-green-50 p-4 text-sm text-green-950 dark:border-green-800 dark:bg-green-950/40 dark:text-green-100">
                  <CheckCircle2 className="size-4 shrink-0" />
                  All settings fit together. Use “Check a month” to see the staffing they give.
                </div>
              ) : (
                <Problem>
                  <strong>
                    {errors.length} setting{errors.length === 1 ? " needs" : "s need"} fixing
                  </strong>
                  <ul className="mt-2 space-y-1">
                    {errors.map((e, i) => {
                      const t = errorTab(e.path);
                      return (
                        <li key={i} className="flex flex-wrap items-center gap-2">
                          <span>
                            {configurationErrorLabel(config, e.path)}: {e.message}
                          </span>
                          {t && t !== tab && (
                            <button
                              type="button"
                              className="text-xs font-medium underline underline-offset-2"
                              onClick={() => setTab(t)}
                            >
                              Go to {STEPS.find((step) => step.value === t)?.label}
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </Problem>
              ))}
          </div>
          <Tabs value={tab} onValueChange={(v) => setTab(v as PageTab)}>
            <TabsList className="grid h-auto w-full grid-cols-2 gap-1 bg-muted/60 p-1 sm:grid-cols-4 xl:grid-cols-7">
              {STEPS.map((step, i) => {
                const issues = issuesIn(step.value) + (step.value === "roles" ? reviewCount : 0);
                return (
                  <TabsTrigger
                    key={step.value}
                    value={step.value}
                    className="h-auto flex-col items-start gap-0.5 whitespace-normal px-3 py-2 text-left data-[state=active]:shadow-sm"
                  >
                    <span className="flex w-full items-center gap-1.5 text-sm font-semibold">
                      <span
                        className={cn(
                          "flex size-5 shrink-0 items-center justify-center rounded-full text-[11px]",
                          tab === step.value
                            ? "bg-primary text-primary-foreground"
                            : "bg-background text-muted-foreground",
                        )}
                      >
                        {i + 1}
                      </span>
                      {step.label}
                      {issues > 0 && (
                        <span
                          className="ml-auto flex items-center gap-0.5 text-amber-600"
                          title={`${issues} to look at`}
                        >
                          <AlertTriangle className="size-3.5" />
                          <span className="text-xs">{issues}</span>
                        </span>
                      )}
                    </span>
                    <span className="hidden text-[11px] font-normal text-muted-foreground sm:block">
                      {step.description}
                    </span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
            <fieldset disabled={!editable} className="mt-4 min-w-0">
              <TabsContent value="shifts">
                <SchedulingShiftsTab config={config} onChange={edit} />
              </TabsContent>
              <TabsContent value="patterns">
                <SchedulingPatternsTab config={config} wards={wards} onChange={edit} />
              </TabsContent>
              <TabsContent value="roles">
                <SchedulingRolesTab
                  config={config}
                  lagoon={lagoon}
                  editableCoverage={editableCoverage}
                  onChange={edit}
                />
              </TabsContent>
              <TabsContent value="wards">
                <SchedulingWardsTab config={config} wards={wards} onChange={edit} />
              </TabsContent>
              <TabsContent value="coverage">
                <SchedulingCoverageRules config={config} onChange={edit} />
              </TabsContent>
            </fieldset>
            <TabsContent value="review" className="mt-4">
              <SchedulingReviewTab
                config={config}
                wards={wards}
                validation={validation}
                dirty={dirty}
                saved={!!version}
                canManage={canManage}
                busy={busy}
                onValidate={() => void validate()}
                onGoTo={setTab}
              />
            </TabsContent>
            <TabsContent value="check" className="mt-4">
              <SchedulingCheckTab
                key={`${version?.id ?? "new"}-${version?.revision ?? 0}`}
                base={base}
                version={version}
                dirty={dirty}
                busy={busy}
                canManage={canManage}
                wards={wards}
                onBusyChange={setBusy}
              />
            </TabsContent>
          </Tabs>
          {canManage && dirty && (
            <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 px-4 py-3 shadow-lg backdrop-blur lg:left-64">
              <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2">
                <p className="text-sm">
                  <strong>Unsaved changes.</strong>{" "}
                  <span className="text-muted-foreground">
                    Saving uses them from the next rota month that is not generated yet.
                  </span>
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      if (!confirmDiscard()) return;
                      if (version) void openVersion(version.id);
                      else if (defaults.data) load(null, defaults.data.configuration);
                    }}
                  >
                    <Undo2 />
                    Discard
                  </Button>
                  <Button disabled={busy || conflict} onClick={() => void save()}>
                    {busy ? <Loader2 className="animate-spin" /> : <Save />}Save changes
                  </Button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
