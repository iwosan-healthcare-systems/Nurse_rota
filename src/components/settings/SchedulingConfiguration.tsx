import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, ArrowUp, ArrowDown, Save, CheckCircle2, Loader2, Copy } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { SchedulingRotaPreview } from "./SchedulingRotaPreview";
import { SchedulingCoverageRules } from "./SchedulingCoverageRules";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  WEEKDAYS,
  renameShift,
  shiftIsUsed,
  patternIsUsed,
  patternPreview,
  setRequirement,
  configurationErrorLabel,
  type SchedulingConfiguration as Configuration,
  type SchedulingFacility,
  type ConfigurationDefaults,
  type ConfigurationVersion,
  type ConfigurationValidation,
  type VersionSummary,
  type SchedulePattern,
  type SchedulingRole,
  type StaffingRequirement,
} from "@/lib/scheduling-configuration";

const inputClass = "w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60";
const cardClass = "rounded-xl border bg-card p-4 md:p-5 space-y-4";
const newId = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm font-medium">
      {label}
      {children}
    </label>
  );
}
function PatternSelect({
  value,
  config,
  onChange,
  label,
}: {
  value: string;
  config: Configuration;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <Field label={label}>
      <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
        {config.patterns.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </Field>
  );
}
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
  const [wardId, setWardId] = useState("");
  const [weekday, setWeekday] = useState(1);
  const [tab, setTab] = useState("shifts");
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
  const editable = canManage && version?.status !== "archived" && !busy;
  const wards = defaults.data?.wards ?? [];
  const selectedWard = wardId || wards[0]?.id || "";
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
    if (!confirmDiscard()) return;
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
  async function save(asNew = false) {
    if (!config) return;
    setBusy(true);
    setProblem("");
    try {
      const row =
        version && !asNew
          ? await api.put<ConfigurationVersion>(`${base}/versions/${version.id}`, {
              revision: version.revision,
              configuration: config,
            })
          : await api.post<ConfigurationVersion>(`${base}/versions`, { configuration: config });
      load(row, row.configuration);
      await qc.invalidateQueries({ queryKey: ["scheduling-versions", facility.id] });
      toast.success(`Draft version ${row.version} saved`);
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
  function editPattern(index: number, next: SchedulePattern) {
    if (config)
      edit({ ...config, patterns: config.patterns.map((p, i) => (i === index ? next : p)) });
  }
  function editRole(index: number, next: SchedulingRole) {
    if (config) edit({ ...config, roles: config.roles.map((r, i) => (i === index ? next : r)) });
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

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-950">
        <strong>Draft configuration</strong>
        <p className="mt-1">
          Prepare your hospital’s scheduling rules here. Saved drafts do not change current or
          published rotas. Administrators can activate a reviewed run from the Rota preview tab.
        </p>
      </div>
      <div className={cardClass}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-52 flex-1">
            <Field label="Saved version">
              <select
                className={inputClass}
                disabled={busy}
                value={version?.id ?? ""}
                onChange={(e) => {
                  if (e.target.value) void openVersion(e.target.value);
                }}
              >
                <option value="" disabled>
                  Select a version
                </option>
                {versions.data?.versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    Version {v.version} · revision {v.revision} · {v.status}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Button
            variant="outline"
            disabled={busy || !defaults.data}
            onClick={() => {
              if (defaults.data && confirmDiscard()) load(null, defaults.data.configuration);
            }}
          >
            {canManage ? "Start from current rules" : "View current rules"}
          </Button>
        </div>
        {!versions.data?.versions.length && (
          <p className="text-sm text-muted-foreground">
            No saved drafts yet. Start from current rules to review the existing setup.
          </p>
        )}
      </div>
      {problem && (
        <Problem>
          <p>{problem}</p>
          {conflict && (
            <p className="mt-2">
              Your edits are still here. Reload the saved version to discard them, or save them as a
              new draft.
            </p>
          )}
        </Problem>
      )}
      {config && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
            <div>
              <h2 className="font-semibold">
                {version ? `Version ${version.version}` : "New draft"}
                {dirty && <span className="ml-2 text-xs text-amber-700">Unsaved changes</span>}
              </h2>
              <p className="text-sm text-muted-foreground">
                {version?.status === "archived"
                  ? "Archived · create a copy to edit"
                  : !canManage
                    ? "Read-only access"
                    : "Changes are saved only when you choose Save draft."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {version && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void openVersion(version.id)}
                >
                  Reload saved
                </Button>
              )}
              {canManage && (
                <>
                  <Button variant="outline" disabled={busy} onClick={() => void validate()}>
                    <CheckCircle2 />
                    Validate
                  </Button>
                  {version && (
                    <Button variant="outline" disabled={busy} onClick={() => void save(true)}>
                      <Copy />
                      Save as new draft
                    </Button>
                  )}
                  {version?.status !== "archived" && (
                    <Button
                      disabled={busy || conflict || (!!version && !dirty)}
                      onClick={() => void save()}
                    >
                      {busy ? <Loader2 className="animate-spin" /> : <Save />}Save draft
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
          <div aria-live="polite">
            {validation &&
              (validation.valid ? (
                <div className="rounded-lg border border-green-300 bg-green-50 p-4 text-sm text-green-950">
                  Configuration checks passed. This checks settings and references; staffing
                  feasibility will be checked when rota preview is available.
                </div>
              ) : (
                <Problem>
                  <strong>Review these settings</strong>
                  <ul className="mt-2 list-disc pl-5">
                    {validation.errors.map((e, i) => (
                      <li key={i}>
                        {configurationErrorLabel(config, e.path)}: {e.message}
                      </li>
                    ))}
                  </ul>
                </Problem>
              ))}
          </div>
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="h-auto w-full flex-wrap justify-start gap-1">
              <TabsTrigger value="shifts">Shifts</TabsTrigger>
              <TabsTrigger value="patterns">Patterns</TabsTrigger>
              <TabsTrigger value="roles">Staff roles</TabsTrigger>
              <TabsTrigger value="wards">Ward requirements</TabsTrigger>
              <TabsTrigger value="coverage">Coverage rules</TabsTrigger>
              <TabsTrigger value="review">Review</TabsTrigger>
              <TabsTrigger value="preview">Rota preview</TabsTrigger>
            </TabsList>
            {tab === "wards" && wards.length > 0 && (
              <div className={`${cardClass} mt-4 grid gap-4 sm:grid-cols-2`}>
                <Field label="Ward">
                  <select
                    className={inputClass}
                    value={selectedWard}
                    disabled={busy}
                    onChange={(e) => setWardId(e.target.value)}
                  >
                    {wards.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Day of week">
                  <select
                    className={inputClass}
                    value={weekday}
                    disabled={busy}
                    onChange={(e) => setWeekday(Number(e.target.value))}
                  >
                    {WEEKDAYS.map((day, i) => (
                      <option key={day} value={i + 1}>
                        {day}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            )}
            <fieldset disabled={!editable} className="min-w-0 space-y-4">
              <TabsContent value="shifts" className="space-y-4">
                <div className={cardClass}>
                  <Field label="Hospital timezone">
                    <input
                      className={inputClass}
                      value={config.timezone}
                      onChange={(e) => edit({ ...config, timezone: e.target.value })}
                      placeholder="Africa/Lagos"
                    />
                  </Field>
                  <p className="text-sm text-muted-foreground">
                    Shift times use this timezone. Each rota period remains 28 days.
                  </p>
                </div>
                {config.shifts.map((s, i) => (
                  <div className={cardClass} key={i}>
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="flex items-center gap-2 font-semibold">
                        <span
                          className="h-3 w-3 rounded-full"
                          style={{ backgroundColor: s.color }}
                        />
                        {s.name || "New shift"}
                      </h3>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={shiftIsUsed(config, s.code)}
                        title={
                          shiftIsUsed(config, s.code)
                            ? "Remove references from roles, patterns and ward requirements first"
                            : "Remove shift"
                        }
                        onClick={() =>
                          edit({ ...config, shifts: config.shifts.filter((_, j) => j !== i) })
                        }
                      >
                        <Trash2 />
                        Remove shift
                      </Button>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                      <Field label="Shift name">
                        <input
                          className={inputClass}
                          value={s.name}
                          maxLength={120}
                          onChange={(e) =>
                            edit({
                              ...config,
                              shifts: config.shifts.map((v, j) =>
                                j === i ? { ...v, name: e.target.value } : v,
                              ),
                            })
                          }
                        />
                      </Field>
                      <Field label="Shift code">
                        <input
                          className={inputClass}
                          value={s.code}
                          maxLength={16}
                          onChange={(e) => {
                            const code = e.target.value.toUpperCase();
                            if (["OFF", "LEAVE"].includes(code)) {
                              toast.error("OFF and LEAVE are reserved system states");
                              return;
                            }
                            if (config.shifts.some((v, j) => j !== i && v.code === code)) {
                              toast.error("That shift code already exists");
                              return;
                            }
                            edit(renameShift(config, s.code, code));
                          }}
                        />
                      </Field>
                      {(
                        [
                          ["start", "Start time"],
                          ["end", "End time"],
                        ] as const
                      ).map(([key, label]) => (
                        <Field key={key} label={label}>
                          <input
                            type="time"
                            className={inputClass}
                            value={s[key]}
                            onChange={(e) =>
                              edit({
                                ...config,
                                shifts: config.shifts.map((v, j) =>
                                  j === i ? { ...v, [key]: e.target.value } : v,
                                ),
                              })
                            }
                          />
                        </Field>
                      ))}
                      <Field label="Ends">
                        <select
                          className={inputClass}
                          value={s.endDayOffset}
                          onChange={(e) =>
                            edit({
                              ...config,
                              shifts: config.shifts.map((v, j) =>
                                j === i ? { ...v, endDayOffset: Number(e.target.value) } : v,
                              ),
                            })
                          }
                        >
                          <option value={0}>Same day</option>
                          <option value={1}>Next day</option>
                        </select>
                      </Field>
                      {(
                        [
                          ["breakMinutes", "Break minutes"],
                          ["creditedMinutes", "Credited minutes"],
                        ] as const
                      ).map(([key, label]) => (
                        <Field key={key} label={label}>
                          <input
                            type="number"
                            min={key === "creditedMinutes" ? 1 : 0}
                            max={1440}
                            className={inputClass}
                            value={s[key]}
                            onChange={(e) =>
                              edit({
                                ...config,
                                shifts: config.shifts.map((v, j) =>
                                  j === i ? { ...v, [key]: Number(e.target.value) } : v,
                                ),
                              })
                            }
                          />
                        </Field>
                      ))}
                      <Field label="Colour">
                        <input
                          type="color"
                          className={`${inputClass} h-10`}
                          value={s.color}
                          onChange={(e) =>
                            edit({
                              ...config,
                              shifts: config.shifts.map((v, j) =>
                                j === i ? { ...v, color: e.target.value } : v,
                              ),
                            })
                          }
                        />
                      </Field>
                    </div>
                  </div>
                ))}
                <Button
                  variant="outline"
                  disabled={config.shifts.length >= 32}
                  onClick={() => {
                    let n = 1;
                    while (config.shifts.some((s) => s.code === `S${n}`)) n++;
                    edit({
                      ...config,
                      shifts: [
                        ...config.shifts,
                        {
                          code: `S${n}`,
                          name: "New shift",
                          start: "08:00",
                          end: "16:00",
                          endDayOffset: 0,
                          breakMinutes: 0,
                          creditedMinutes: 480,
                          color: "#60a5fa",
                        },
                      ],
                    });
                  }}
                >
                  <Plus />
                  Add shift
                </Button>
              </TabsContent>
              <TabsContent value="patterns" className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Build a repeating sequence, or set a fixed schedule for each weekday. OFF is
                  always available.
                </p>
                {config.patterns.map((p, i) => (
                  <div className={cardClass} key={p.id}>
                    <div className="grid items-end gap-3 sm:grid-cols-[1fr_180px_auto]">
                      <Field label="Pattern name">
                        <input
                          className={inputClass}
                          value={p.name}
                          onChange={(e) => editPattern(i, { ...p, name: e.target.value })}
                        />
                      </Field>
                      <Field label="Pattern type">
                        <select
                          className={inputClass}
                          value={p.kind}
                          onChange={(e) => {
                            const kind = e.target.value as SchedulePattern["kind"];
                            if (
                              window.confirm(
                                "Changing pattern type replaces its current steps. Continue?",
                              )
                            )
                              editPattern(i, {
                                ...p,
                                kind,
                                steps:
                                  kind === "weekly"
                                    ? WEEKDAYS.map(() => ({ shift: "OFF", days: 1 }))
                                    : [{ shift: "OFF", days: 1 }],
                              });
                          }}
                        >
                          <option value="repeating">Repeating cycle</option>
                          <option value="weekly">Weekly schedule</option>
                        </select>
                      </Field>
                      <Button
                        variant="ghost"
                        disabled={patternIsUsed(config, p.id) || config.patterns.length === 1}
                        title="Assign a different pattern to dependent roles and wards before removing"
                        onClick={() =>
                          edit({
                            ...config,
                            patterns: config.patterns.filter((v) => v.id !== p.id),
                          })
                        }
                      >
                        <Trash2 />
                        Remove pattern
                      </Button>
                    </div>
                    <div className="space-y-2">
                      {p.steps.map((step, j) => (
                        <div
                          key={j}
                          className="flex flex-wrap items-end gap-2 rounded-lg bg-muted/40 p-3"
                        >
                          <div className="min-w-40 flex-1">
                            <Field label={p.kind === "weekly" ? WEEKDAYS[j] : `Step ${j + 1}`}>
                              <select
                                className={inputClass}
                                value={step.shift}
                                onChange={(e) =>
                                  editPattern(i, {
                                    ...p,
                                    steps: p.steps.map((v, k) =>
                                      k === j ? { ...v, shift: e.target.value } : v,
                                    ),
                                  })
                                }
                              >
                                <option value="OFF">OFF</option>
                                {config.shifts.map((s) => (
                                  <option key={s.code} value={s.code}>
                                    {s.name} ({s.code})
                                  </option>
                                ))}
                              </select>
                            </Field>
                          </div>
                          {p.kind === "repeating" && (
                            <>
                              <div className="w-24">
                                <Field label="Days">
                                  <input
                                    className={inputClass}
                                    type="number"
                                    min={1}
                                    max={56}
                                    value={step.days}
                                    onChange={(e) =>
                                      editPattern(i, {
                                        ...p,
                                        steps: p.steps.map((v, k) =>
                                          k === j ? { ...v, days: Number(e.target.value) } : v,
                                        ),
                                      })
                                    }
                                  />
                                </Field>
                              </div>
                              {[-1, 1].map((direction) => (
                                <Button
                                  key={direction}
                                  variant="outline"
                                  size="icon"
                                  aria-label={`Move step ${j + 1} ${direction < 0 ? "up" : "down"}`}
                                  disabled={j + direction < 0 || j + direction >= p.steps.length}
                                  onClick={() => {
                                    const steps = [...p.steps];
                                    [steps[j], steps[j + direction]] = [
                                      steps[j + direction],
                                      steps[j],
                                    ];
                                    editPattern(i, { ...p, steps });
                                  }}
                                >
                                  {direction < 0 ? <ArrowUp /> : <ArrowDown />}
                                </Button>
                              ))}
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Remove step ${j + 1}`}
                                disabled={p.steps.length === 1}
                                onClick={() =>
                                  editPattern(i, { ...p, steps: p.steps.filter((_, k) => k !== j) })
                                }
                              >
                                <Trash2 />
                              </Button>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                    {p.kind === "repeating" && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={p.steps.length >= 56}
                        onClick={() =>
                          editPattern(i, { ...p, steps: [...p.steps, { shift: "OFF", days: 1 }] })
                        }
                      >
                        <Plus />
                        Add step
                      </Button>
                    )}
                    <div>
                      <p className="mb-2 text-xs font-medium text-muted-foreground">
                        28-day pattern illustration
                        {p.kind === "weekly" ? " · starts Monday" : " · starts at step 1"} · not a
                        generated rota
                      </p>
                      <div className="grid grid-cols-7 gap-1 sm:grid-cols-14">
                        {patternPreview(p).map((shift, day) => (
                          <div key={day} className="rounded border p-1 text-center text-xs">
                            <span className="block text-[10px] text-muted-foreground">
                              {day + 1}
                            </span>
                            <strong>{shift}</strong>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
                <Button
                  variant="outline"
                  disabled={config.patterns.length >= 100}
                  onClick={() =>
                    edit({
                      ...config,
                      patterns: [
                        ...config.patterns,
                        {
                          id: newId("pattern"),
                          name: "New pattern",
                          kind: "repeating",
                          steps: [{ shift: "OFF", days: 1 }],
                        },
                      ],
                    })
                  }
                >
                  <Plus />
                  Add pattern
                </Button>
              </TabsContent>
              <TabsContent value="roles" className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Clinical staff roles control scheduling. Application permissions are managed
                  separately.
                </p>
                {config.roles.map((r, i) => (
                  <div className={cardClass} key={r.id}>
                    <div className="flex justify-between gap-2">
                      <h3 className="font-semibold">{r.name}</h3>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={
                          config.roles.length === 1 ||
                          config.coverageRules?.some((rule) => rule.roleIds.includes(r.id))
                        }
                        onClick={() => {
                          if (
                            window.confirm(
                              `Remove ${r.name} from this draft? Existing staff records are not changed.`,
                            )
                          )
                            edit({ ...config, roles: config.roles.filter((v) => v.id !== r.id) });
                        }}
                      >
                        <Trash2 />
                        Remove role
                      </Button>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      <Field label="Role name">
                        <input
                          className={inputClass}
                          value={r.name}
                          onChange={(e) => editRole(i, { ...r, name: e.target.value })}
                        />
                      </Field>
                      <PatternSelect
                        config={config}
                        value={r.patternId}
                        label="Default pattern"
                        onChange={(patternId) =>
                          editRole(i, {
                            ...r,
                            patternId,
                            useWardPattern: false,
                            allowedShifts: [
                              ...new Set([
                                ...r.allowedShifts,
                                ...(config.patterns
                                  .find((p) => p.id === patternId)
                                  ?.steps.filter((s) => s.shift !== "OFF")
                                  .map((s) => s.shift) ?? []),
                              ]),
                            ],
                          })
                        }
                      />
                      <Field label="Counts towards">
                        <select
                          className={inputClass}
                          value={r.category}
                          onChange={(e) =>
                            editRole(i, {
                              ...r,
                              category: e.target.value as SchedulingRole["category"],
                            })
                          }
                        >
                          <option value="nurse">Nurse minimum</option>
                          <option value="na">Nursing assistant minimum</option>
                          <option value="none">Neither ward minimum</option>
                        </select>
                      </Field>
                      <Field label="Assignment scope">
                        <select
                          className={inputClass}
                          value={r.scope}
                          onChange={(e) =>
                            editRole(i, { ...r, scope: e.target.value as SchedulingRole["scope"] })
                          }
                        >
                          <option value="ward">Ward</option>
                          <option value="facility">Facility-wide</option>
                        </select>
                      </Field>
                      <Field label="Pattern source">
                        <select
                          className={inputClass}
                          value={
                            r.useWardPattern === undefined
                              ? "legacy"
                              : r.useWardPattern
                                ? "ward"
                                : "role"
                          }
                          onChange={(e) =>
                            editRole(i, { ...r, useWardPattern: e.target.value === "ward" })
                          }
                        >
                          <option value="legacy" disabled>
                            Existing preference
                          </option>
                          <option value="role">Use this role’s default pattern</option>
                          <option value="ward">Use ward override when available</option>
                        </select>
                      </Field>
                      <Field label="Rotation group">
                        <input
                          className={inputClass}
                          value={r.staggerGroup ?? ""}
                          placeholder="Existing group"
                          onChange={(e) =>
                            editRole(i, { ...r, staggerGroup: e.target.value || undefined })
                          }
                        />
                      </Field>
                      <Field label="Approval group">
                        <select
                          className={inputClass}
                          value={r.approvalGroup}
                          onChange={(e) =>
                            editRole(i, {
                              ...r,
                              approvalGroup: e.target.value as SchedulingRole["approvalGroup"],
                            })
                          }
                        >
                          {Object.entries({
                            ward: "Ward",
                            head: "Coverage nurses",
                            matron: "Matrons",
                            porter: "Porters",
                            intern: "Interns",
                          }).map(([v, name]) => (
                            <option key={v} value={v}>
                              {name}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </div>
                    <div>
                      <p className="mb-2 text-sm font-medium">Allowed working shifts</p>
                      <div className="flex flex-wrap gap-4">
                        {config.shifts.map((s) => (
                          <label key={s.code} className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={r.allowedShifts.includes(s.code)}
                              onChange={(e) =>
                                editRole(i, {
                                  ...r,
                                  allowedShifts: e.target.checked
                                    ? [...r.allowedShifts, s.code]
                                    : r.allowedShifts.filter((v) => v !== s.code),
                                })
                              }
                            />
                            {s.name} ({s.code})
                          </label>
                        ))}
                      </div>
                    </div>
                    <Field label="Scheduling method">
                      <select
                        className={inputClass}
                        value={r.specialRule}
                        onChange={(e) =>
                          editRole(i, {
                            ...r,
                            specialRule: e.target.value as SchedulingRole["specialRule"],
                          })
                        }
                      >
                        <option value="none">Configured pattern and coverage rules</option>
                        <option value="legacy_coverage_v1">Retain existing coverage rules</option>
                        <option value="legacy_intern_v1">Retain existing intern rules</option>
                        <option value="legacy_porter_v1">Retain existing porter rules</option>
                      </select>
                    </Field>
                    {r.specialRule !== "none" && (
                      <p className="rounded bg-muted p-3 text-sm">
                        Existing{" "}
                        {r.specialRule === "legacy_coverage_v1"
                          ? "coverage rotation and rest"
                          : r.specialRule === "legacy_intern_v1"
                            ? "intern grouping"
                            : "porter staggering"}{" "}
                        rules are retained. Choose configured patterns to replace them with explicit
                        settings. The new fixed coverage rotation does not reproduce phase-dependent
                        legacy rest rules automatically.
                      </p>
                    )}
                    {r.requiresReview && (
                      <label className="flex items-center gap-2 text-sm text-amber-800">
                        <input
                          type="checkbox"
                          checked={false}
                          onChange={() => editRole(i, { ...r, requiresReview: false })}
                        />
                        I have reviewed this imported role’s scheduling settings.
                      </label>
                    )}
                  </div>
                ))}
                <Button
                  variant="outline"
                  disabled={config.roles.length >= 100}
                  onClick={() =>
                    edit({
                      ...config,
                      roles: [
                        ...config.roles,
                        {
                          id: newId("role"),
                          name: "New role",
                          patternId: config.patterns[0].id,
                          allowedShifts: config.shifts.map((s) => s.code),
                          category: "nurse",
                          scope: "ward",
                          approvalGroup: "ward",
                          specialRule: "none",
                          requiresReview: false,
                          useWardPattern: false,
                          staggerGroup: "regular",
                        },
                      ],
                    })
                  }
                >
                  <Plus />
                  Add staff role
                </Button>
              </TabsContent>
              <TabsContent value="coverage">
                <SchedulingCoverageRules config={config} onChange={edit} />
              </TabsContent>
              <TabsContent value="wards" className="space-y-4">
                {!wards.length ? (
                  <p className={cardClass}>
                    No wards are available for this facility. Create wards before defining their
                    staffing requirements.
                  </p>
                ) : (
                  <>
                    {(() => {
                      const policy = config.wardPolicies.find((w) => w.wardId === selectedWard);
                      return (
                        <div className={cardClass}>
                          <h3 className="font-semibold">Ward pattern overrides</h3>
                          <p className="text-sm text-muted-foreground">
                            These retain the current ward-level patterns. Role-specific exceptions,
                            such as weekday-only surgical nurses, are preserved for engine
                            integration.
                          </p>
                          {policy ? (
                            <>
                              <Field label="Fixed weekly schedule for every ward role">
                                <select
                                  className={inputClass}
                                  value={
                                    policy.fixedWeeklyPatternId === undefined
                                      ? "legacy"
                                      : (policy.fixedWeeklyPatternId ?? "")
                                  }
                                  onChange={(e) =>
                                    edit({
                                      ...config,
                                      wardPolicies: config.wardPolicies.map((w) =>
                                        w.wardId === selectedWard
                                          ? { ...w, fixedWeeklyPatternId: e.target.value || null }
                                          : w,
                                      ),
                                    })
                                  }
                                >
                                  <option value="legacy" disabled>
                                    Existing calendar preference
                                  </option>
                                  <option value="">No fixed calendar override</option>
                                  {config.patterns
                                    .filter((p) => p.kind === "weekly")
                                    .map((p) => (
                                      <option key={p.id} value={p.id}>
                                        {p.name}
                                      </option>
                                    ))}
                                </select>
                              </Field>
                              <p className="text-sm text-muted-foreground">
                                A fixed weekly schedule takes precedence over every ward role’s
                                pattern, including day-only roles.
                              </p>
                              <div className="grid gap-4 sm:grid-cols-2">
                                {(["patternId", "naPatternId"] as const).map((key) => (
                                  <PatternSelect
                                    key={key}
                                    config={config}
                                    value={policy[key]}
                                    label={
                                      key === "patternId"
                                        ? "Ward nurse pattern"
                                        : "Nursing assistant pattern"
                                    }
                                    onChange={(value) =>
                                      edit({
                                        ...config,
                                        wardPolicies: config.wardPolicies.map((w) =>
                                          w.wardId === selectedWard ? { ...w, [key]: value } : w,
                                        ),
                                      })
                                    }
                                  />
                                ))}
                              </div>
                              {policy.specialRule !== "none" && (
                                <p className="text-sm text-muted-foreground">
                                  This ward retains its existing single night-slot rotation.
                                </p>
                              )}
                            </>
                          ) : (
                            <Button
                              variant="outline"
                              onClick={() =>
                                edit({
                                  ...config,
                                  wardPolicies: [
                                    ...config.wardPolicies,
                                    {
                                      wardId: selectedWard,
                                      patternId: config.patterns[0].id,
                                      naPatternId: config.patterns[0].id,
                                      specialRule: "none",
                                    },
                                  ],
                                })
                              }
                            >
                              Add ward pattern overrides
                            </Button>
                          )}
                        </div>
                      );
                    })()}
                    <div className={cardClass}>
                      <h3 className="font-semibold">
                        {WEEKDAYS[weekday - 1]} staffing requirements
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        A blank maximum means no upper limit. Setting minimum and maximum to the
                        same number requests an exact count.
                      </p>
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[580px] text-left text-sm">
                          <thead>
                            <tr className="border-b">
                              <th className="p-2">Shift / staff</th>
                              <th className="p-2">Minimum</th>
                              <th className="p-2">Maximum</th>
                              <th className="p-2">Repeat</th>
                            </tr>
                          </thead>
                          <tbody>
                            {config.shifts.flatMap((s) =>
                              (["nurse", "na"] as const).map((category) => {
                                const r: StaffingRequirement = config.requirements.find(
                                  (v) =>
                                    v.wardId === selectedWard &&
                                    v.shift === s.code &&
                                    v.category === category &&
                                    v.weekday === weekday,
                                ) ?? {
                                  wardId: selectedWard,
                                  shift: s.code,
                                  category,
                                  weekday,
                                  minimum: 0,
                                  maximum: null,
                                };
                                const name = `${s.name} ${category === "nurse" ? "nurses" : "assistants"}`;
                                return (
                                  <tr
                                    key={`${s.code}-${category}`}
                                    className="border-b last:border-0"
                                  >
                                    <th className="p-2 font-normal">{name}</th>
                                    <td className="p-2">
                                      <input
                                        aria-label={`${name} minimum`}
                                        className={`${inputClass} max-w-24`}
                                        type="number"
                                        min={0}
                                        max={1000}
                                        value={r.minimum}
                                        onChange={(e) =>
                                          edit(
                                            setRequirement(config, {
                                              ...r,
                                              minimum: Number(e.target.value),
                                            }),
                                          )
                                        }
                                      />
                                    </td>
                                    <td className="p-2">
                                      <input
                                        aria-label={`${name} maximum`}
                                        className={`${inputClass} max-w-24`}
                                        type="number"
                                        min={0}
                                        max={1000}
                                        placeholder="None"
                                        value={r.maximum ?? ""}
                                        onChange={(e) =>
                                          edit(
                                            setRequirement(config, {
                                              ...r,
                                              maximum:
                                                e.target.value === ""
                                                  ? null
                                                  : Number(e.target.value),
                                            }),
                                          )
                                        }
                                      />
                                    </td>
                                    <td className="p-2">
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        aria-label={`Apply ${name} to all days`}
                                        onClick={() => edit(setRequirement(config, r, true))}
                                      >
                                        All days
                                      </Button>
                                    </td>
                                  </tr>
                                );
                              }),
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </>
                )}
              </TabsContent>
            </fieldset>
            <TabsContent value="preview">
              <SchedulingRotaPreview
                key={`${version?.id ?? "new"}-${version?.revision ?? 0}-${dirty}`}
                base={base}
                version={version}
                config={config}
                dirty={dirty}
                busy={busy}
                canManage={canManage}
                wards={wards}
                onBusyChange={setBusy}
              />
            </TabsContent>
            <TabsContent value="review" className="space-y-4">
              <div className={cardClass}>
                <h3 className="font-semibold">Configuration summary</h3>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  {[
                    [config.shifts.length, "Shift types"],
                    [config.patterns.length, "Patterns"],
                    [config.roles.length, "Staff roles"],
                    [config.wardPolicies.length, "Ward policies"],
                  ].map(([count, label]) => (
                    <div key={label} className="rounded-lg bg-muted/50 p-4">
                      <strong className="text-2xl">{count}</strong>
                      <p className="text-sm text-muted-foreground">{label}</p>
                    </div>
                  ))}
                </div>
                <p className="text-sm">{config.timezone} · 28-day rota periods</p>
              </div>
              <div className={cardClass}>
                <h3 className="font-semibold">Before activation</h3>
                <p className="text-sm text-muted-foreground">
                  Saving a draft does not assign roles to staff or update the current ward settings.
                  Use Rota preview to check a saved version against current staff and approved
                  leave. Activate a reviewed run for a clean future period to use its rules for
                  recurring draft generation, including its custom shifts and role groups.
                </p>
                {config.roles.some((r) => r.requiresReview) && (
                  <p className="text-sm text-amber-800">
                    Some imported staff roles still need review in the Staff roles tab.
                  </p>
                )}
                {validation?.warnings
                  .filter((w) => w.code !== "DRAFT_ONLY")
                  .map((w) => (
                    <p key={w.code} className="text-sm text-muted-foreground">
                      {w.message}
                    </p>
                  ))}
              </div>
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
