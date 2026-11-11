import { useState } from "react";
import { Lock, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SchedulingConfiguration, SchedulingRole } from "@/lib/scheduling-configuration";
import {
  ChoiceButtons,
  ExpandableCard,
  Field,
  Pill,
  TabIntro,
  inputClass,
  list,
  useExpanded,
} from "./scheduling-ui";

const newId = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

const COUNTS: Record<SchedulingRole["category"], string> = {
  nurse: "Counts as a nurse",
  na: "Counts as a nursing assistant",
  none: "Not counted in ward staffing",
};
const GROUPS: Record<SchedulingRole["approvalGroup"], string> = {
  ward: "Their ward",
  head: "Coverage nurses",
  matron: "Matrons",
  porter: "Porters",
  intern: "Interns",
};
const LEGACY: Record<Exclude<SchedulingRole["specialRule"], "none">, string> = {
  legacy_coverage_v1: "Lagoon's original coverage rotation",
  legacy_intern_v1: "Lagoon's original intern grouping",
  legacy_porter_v1: "Lagoon's original porter staggering",
};

export function SchedulingRolesTab({
  config,
  lagoon,
  editableCoverage,
  onChange,
}: {
  config: SchedulingConfiguration;
  lagoon: boolean;
  editableCoverage: SchedulingConfiguration | null;
  onChange: (config: SchedulingConfiguration) => void;
}) {
  const expanded = useExpanded(config.roles.filter((r) => r.requiresReview).map((r) => r.id));
  const [query, setQuery] = useState("");
  const editRole = (id: string, patch: Partial<SchedulingRole>) =>
    onChange({
      ...config,
      roles: config.roles.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    });
  const patternName = (id: string) => config.patterns.find((p) => p.id === id)?.name ?? "—";
  const shiftsOfPattern = (id: string) =>
    config.patterns
      .find((p) => p.id === id)
      ?.steps.filter((s) => s.shift !== "OFF")
      .map((s) => s.shift) ?? [];
  const needsReview = config.roles.filter((r) => r.requiresReview).length;
  const q = query.trim().toLowerCase();
  const visible = config.roles.filter((r) => !q || r.name.toLowerCase().includes(q));

  const renderRole = (r: SchedulingRole) => {
    const followsWard = r.scope === "ward" && r.useWardPattern !== false;
    const ownPatternShifts = followsWard ? [] : shiftsOfPattern(r.patternId);
    const shiftNames = config.shifts
      .filter((s) => r.allowedShifts.includes(s.code))
      .map((s) => s.code);
    const inCoverage = (config.coverageRules ?? []).filter((rule) => rule.roleIds.includes(r.id));
    const legacy = r.specialRule !== "none";
    return (
      <ExpandableCard
        key={r.id}
        open={expanded.isOpen(r.id)}
        onOpenChange={(open) => expanded.set(r.id, open)}
        attention={r.requiresReview}
        title={r.name || "New role"}
        badges={
          <>
            {r.requiresReview && <Pill tone="amber">Needs review</Pill>}
            {legacy && <Pill>Original Lagoon rule</Pill>}
            {inCoverage.length > 0 && (
              <Pill tone="primary">In {list(inCoverage.map((c) => c.name))}</Pill>
            )}
          </>
        }
        summary={
          legacy
            ? `${r.scope === "ward" ? "Ward staff" : "Facility-wide"} · ${LEGACY[r.specialRule as keyof typeof LEGACY]}`
            : `${r.scope === "ward" ? "Ward staff" : "Facility-wide"} · ${
                followsWard ? "follows the ward's pattern" : patternName(r.patternId)
              } · ${COUNTS[r.category].toLowerCase()} · shifts ${shiftNames.join(", ") || "none"}`
        }
        actions={
          <Button
            variant="ghost"
            size="sm"
            disabled={config.roles.length === 1 || inCoverage.length > 0}
            title={
              inCoverage.length
                ? "Remove this role from its coverage rules first"
                : "Remove role from this configuration"
            }
            onClick={() => {
              if (
                window.confirm(
                  `Remove ${r.name} from this configuration? Staff records are not changed.`,
                )
              )
                onChange({ ...config, roles: config.roles.filter((v) => v.id !== r.id) });
            }}
          >
            <Trash2 />
            <span className="hidden sm:inline">Remove</span>
          </Button>
        }
      >
        {r.requiresReview && (
          <label className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
            <input
              type="checkbox"
              className="size-4"
              checked={false}
              onChange={() => editRole(r.id, { requiresReview: false })}
            />
            This role was found on staff records. Check the settings below, then tick to confirm
            them. Its staff are not scheduled until you do.
          </label>
        )}
        <Field label="Role name" hint="Must match the role on staff records." className="max-w-md">
          <input
            className={inputClass}
            value={r.name}
            onChange={(e) => editRole(r.id, { name: e.target.value })}
          />
        </Field>

        {legacy ? (
          <div className="space-y-3 rounded-lg bg-muted/50 p-4 text-sm">
            <p>
              <strong>{r.name}</strong> is scheduled by{" "}
              {LEGACY[r.specialRule as keyof typeof LEGACY]}, which cannot be edited here. Switch to
              a pattern to edit it like any other role.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => editRole(r.id, { specialRule: "none" })}
            >
              Use a pattern instead
            </Button>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <p className="text-sm font-medium">1. Where do they work?</p>
              <ChoiceButtons
                value={r.scope}
                options={[
                  {
                    value: "ward",
                    label: "In a ward",
                    description: "Belongs to one ward and counts in its staffing.",
                  },
                  {
                    value: "facility",
                    label: "Across the facility",
                    description: "Not tied to a ward, e.g. matrons or coverage nurses.",
                  },
                ]}
                onChange={(scope) =>
                  editRole(r.id, {
                    scope,
                    ...(scope === "facility"
                      ? { useWardPattern: false, category: "none" as const }
                      : {}),
                  })
                }
              />
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">2. Which pattern do they follow?</p>
              {r.scope === "ward" && (
                <ChoiceButtons
                  value={followsWard ? "ward" : "own"}
                  options={[
                    {
                      value: "ward",
                      label: "Their ward's pattern",
                      description: "Set per ward in Ward requirements.",
                    },
                    {
                      value: "own",
                      label: "A pattern for this role",
                      description: "The same for everyone in this role.",
                    },
                  ]}
                  onChange={(v) => editRole(r.id, { useWardPattern: v === "ward" })}
                />
              )}
              {!followsWard && (
                <Field label="Pattern" className="max-w-md">
                  <select
                    className={inputClass}
                    value={r.patternId}
                    onChange={(e) =>
                      editRole(r.id, {
                        patternId: e.target.value,
                        allowedShifts: [
                          ...new Set([...r.allowedShifts, ...shiftsOfPattern(e.target.value)]),
                        ],
                      })
                    }
                  >
                    {config.patterns.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {inCoverage.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  On their turn for {list(inCoverage.map((c) => c.name))} they work that cover
                  instead (Coverage rules).
                </p>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">3. Which shifts can they work?</p>
              <div className="flex flex-wrap gap-2">
                {config.shifts.map((s) => {
                  const required = ownPatternShifts.includes(s.code);
                  const checked = r.allowedShifts.includes(s.code);
                  return (
                    <label
                      key={s.code}
                      title={required ? "Used by this role's pattern" : undefined}
                      className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${
                        checked ? "border-primary bg-primary/5" : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={required}
                        onChange={(e) =>
                          editRole(r.id, {
                            allowedShifts: e.target.checked
                              ? [...r.allowedShifts, s.code]
                              : r.allowedShifts.filter((v) => v !== s.code),
                          })
                        }
                      />
                      {s.name} ({s.code}){required && <Lock className="size-3" />}
                    </label>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                Shifts used by their pattern are always allowed. Others can be given by hand on the
                rota, in swaps and in coverage rules.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="4. In ward staffing they…"
                hint="Used to check each ward's minimum nurses and assistants."
              >
                <select
                  className={inputClass}
                  value={r.category}
                  onChange={(e) =>
                    editRole(r.id, { category: e.target.value as SchedulingRole["category"] })
                  }
                >
                  {Object.entries(COUNTS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Rota and approvals are grouped under"
                hint="Who handles their rota, edit requests and switches."
              >
                <select
                  className={inputClass}
                  value={r.approvalGroup}
                  onChange={(e) =>
                    editRole(r.id, {
                      approvalGroup: e.target.value as SchedulingRole["approvalGroup"],
                    })
                  }
                >
                  {Object.entries(GROUPS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </>
        )}

        <details className="rounded-lg border p-3 text-sm">
          <summary className="cursor-pointer font-medium">Advanced</summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field
              label="Spread group"
              hint="Staff in the same group are spread across the pattern so they don't all work the same days. Roles sharing a name here are spread together."
            >
              <input
                className={inputClass}
                value={r.staggerGroup ?? ""}
                placeholder="regular"
                onChange={(e) =>
                  editRole(r.id, {
                    staggerGroup:
                      e.target.value
                        .trim()
                        .toLowerCase()
                        .replace(/[^a-z0-9_]/g, "_") || undefined,
                  })
                }
              />
            </Field>
            <Field
              label="Scheduling method"
              hint="Original Lagoon rules keep a rotation from before configurable scheduling."
            >
              <select
                className={inputClass}
                value={r.specialRule}
                onChange={(e) =>
                  editRole(r.id, { specialRule: e.target.value as SchedulingRole["specialRule"] })
                }
              >
                <option value="none">Pattern and coverage rules</option>
                {(Object.keys(LEGACY) as (keyof typeof LEGACY)[])
                  .filter((value) => lagoon || r.specialRule === value)
                  .map((value) => (
                    <option key={value} value={value}>
                      {LEGACY[value]}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
        </details>
      </ExpandableCard>
    );
  };

  const wardRoles = visible.filter((r) => r.scope === "ward");
  const facilityRoles = visible.filter((r) => r.scope === "facility");

  return (
    <div className="space-y-4">
      <TabIntro title="Step 3 · Staff roles">
        <p>
          How each job role is scheduled: where they work, which pattern they follow and which
          shifts they can work. Roles match the role on each staff record. App permissions are set
          separately in System Settings.
        </p>
      </TabIntro>
      {editableCoverage && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
          <p className="max-w-2xl">
            Coverage nurses still use Lagoon's original coverage rotation, which cannot be edited
            here. Switch to editable settings: shift coverage nurses get the 4 Morning / 2 OFF / 4
            Night / 4 OFF pattern, and day coverage nurses get weekday mornings with a weekend
            coverage rule. Save to apply.
          </p>
          <Button variant="outline" onClick={() => onChange(editableCoverage)}>
            Use editable coverage settings
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <input
            className={`${inputClass} pl-9`}
            placeholder="Find a role"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {needsReview > 0 && (
          <Pill tone="amber">
            {needsReview} role{needsReview === 1 ? "" : "s"} need review
          </Pill>
        )}
        <Button variant="ghost" size="sm" onClick={() => expanded.setAll(visible.map((r) => r.id))}>
          Expand all
        </Button>
        <Button variant="ghost" size="sm" onClick={() => expanded.setAll([])}>
          Collapse all
        </Button>
      </div>
      {[
        ["Ward staff", wardRoles],
        ["Facility-wide staff", facilityRoles],
      ].map(([heading, roles]) =>
        (roles as SchedulingRole[]).length ? (
          <section key={heading as string} className="space-y-3">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {heading as string}
            </h3>
            {(roles as SchedulingRole[]).map(renderRole)}
          </section>
        ) : null,
      )}
      {!visible.length && (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          No role matches “{query}”.
        </p>
      )}
      <Button
        variant="outline"
        disabled={config.roles.length >= 100}
        onClick={() => {
          const id = newId("role");
          onChange({
            ...config,
            roles: [
              ...config.roles,
              {
                id,
                name: "New role",
                patternId: config.patterns[0].id,
                allowedShifts: [...new Set(shiftsOfPattern(config.patterns[0].id))],
                category: "nurse",
                scope: "ward",
                approvalGroup: "ward",
                specialRule: "none",
                requiresReview: false,
                useWardPattern: true,
                staggerGroup: "regular",
              },
            ],
          });
          setQuery("");
          expanded.set(id, true);
        }}
      >
        <Plus />
        Add staff role
      </Button>
    </div>
  );
}
