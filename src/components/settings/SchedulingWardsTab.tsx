import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  WEEKDAYS,
  setRequirement,
  type SchedulingConfiguration,
  type StaffingRequirement,
  type WardPolicy,
} from "@/lib/scheduling-configuration";
import { cn } from "@/lib/utils";
import { ChoiceButtons, Field, TabIntro, cardClass, inputClass } from "./scheduling-ui";

const CATEGORY = { nurse: "Nurses", na: "Nursing assistants" } as const;

export function SchedulingWardsTab({
  config,
  wards,
  onChange,
}: {
  config: SchedulingConfiguration;
  wards: { id: string; name: string }[];
  onChange: (config: SchedulingConfiguration) => void;
}) {
  const [wardId, setWardId] = useState(wards[0]?.id ?? "");
  const [showAllShifts, setShowAllShifts] = useState(false);
  const [showMaximum, setShowMaximum] = useState(
    config.requirements.some((r) => r.maximum !== null),
  );
  if (!wards.length)
    return (
      <div className="space-y-4">
        <TabIntro title="Step 4 · Ward requirements">
          <p>How many staff each ward needs on each shift.</p>
        </TabIntro>
        <p className={cardClass}>
          This facility has no wards yet. Add wards on the Wards page, then set their staffing here.
        </p>
      </div>
    );
  const ward = wards.find((w) => w.id === wardId) ?? wards[0];
  const policy = config.wardPolicies.find((w) => w.wardId === ward.id);
  const weekly = config.patterns.filter((p) => p.kind === "weekly");
  const setPolicy = (patch: Partial<WardPolicy>) =>
    onChange({
      ...config,
      wardPolicies: config.wardPolicies.map((w) => (w.wardId === ward.id ? { ...w, ...patch } : w)),
    });
  const requirement = (
    shift: string,
    category: "nurse" | "na",
    weekday: number,
  ): StaffingRequirement =>
    config.requirements.find(
      (v) =>
        v.wardId === ward.id &&
        v.shift === shift &&
        v.category === category &&
        v.weekday === weekday,
    ) ?? { wardId: ward.id, shift, category, weekday, minimum: 0, maximum: null };
  // Shifts ward staff can work, plus any with a requirement already set.
  const wardShifts = new Set(
    config.roles.filter((r) => r.scope === "ward").flatMap((r) => r.allowedShifts),
  );
  const shifts = config.shifts.filter(
    (s) =>
      showAllShifts ||
      wardShifts.has(s.code) ||
      config.requirements.some((r) => r.wardId === ward.id && r.shift === s.code && r.minimum > 0),
  );
  const hiddenShifts = config.shifts.length - shifts.length;
  const total = (wid: string) =>
    config.requirements
      .filter((r) => r.wardId === wid && r.weekday === 1)
      .reduce((n, r) => n + r.minimum, 0);

  return (
    <div className="space-y-4">
      <TabIntro title="Step 4 · Ward requirements">
        <p>
          For each ward, the pattern its staff follow and how many nurses and nursing assistants it
          needs on each shift. Shortfalls never stop a rota; they are listed in Approvals and on
          printouts.
        </p>
      </TabIntro>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Ward">
        {wards.map((w) => (
          <button
            key={w.id}
            type="button"
            role="tab"
            aria-selected={w.id === ward.id}
            onClick={() => setWardId(w.id)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm transition",
              w.id === ward.id
                ? "border-primary bg-primary text-primary-foreground"
                : "bg-card hover:border-primary/50",
            )}
          >
            {w.name}
            <span className="ml-1.5 text-xs opacity-70">{total(w.id)}</span>
          </button>
        ))}
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">
        The number beside each ward is its Monday minimum, all shifts together.
      </p>

      <div className={cardClass}>
        <h3 className="font-semibold">{ward.name}: patterns</h3>
        {policy ? (
          <>
            <ChoiceButtons
              value={policy.fixedWeeklyPatternId ? "weekly" : "rotating"}
              options={[
                {
                  value: "rotating",
                  label: "Staff rotate through patterns",
                  description: "Nurses and assistants each follow the patterns below.",
                },
                {
                  value: "weekly",
                  label: "The whole ward works a weekly schedule",
                  description: "E.g. Monday–Friday mornings only. Applies to every ward role.",
                },
              ]}
              onChange={(v) =>
                setPolicy({
                  fixedWeeklyPatternId:
                    v === "weekly" ? (policy.fixedWeeklyPatternId ?? weekly[0]?.id ?? null) : null,
                })
              }
            />
            {policy.fixedWeeklyPatternId ? (
              <Field label="Weekly schedule" className="max-w-md">
                <select
                  className={inputClass}
                  value={policy.fixedWeeklyPatternId}
                  onChange={(e) => setPolicy({ fixedWeeklyPatternId: e.target.value })}
                >
                  {weekly.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                {(
                  [
                    ["patternId", "Nurses' pattern"],
                    ["naPatternId", "Nursing assistants' pattern"],
                  ] as const
                ).map(([key, label]) => (
                  <Field key={key} label={label}>
                    <select
                      className={inputClass}
                      value={policy[key]}
                      onChange={(e) => setPolicy({ [key]: e.target.value })}
                    >
                      {config.patterns.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                ))}
              </div>
            )}
            {weekly.length === 0 && !policy.fixedWeeklyPatternId && (
              <p className="text-xs text-muted-foreground">
                Add a weekly schedule in Patterns to make a weekday-only ward.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Roles set to use their own pattern (Staff roles) keep it in this ward.
              {policy.specialRule !== "none" &&
                " This ward also keeps Lagoon's single night-nurse rotation."}
            </p>
          </>
        ) : (
          <Button
            variant="outline"
            onClick={() =>
              onChange({
                ...config,
                wardPolicies: [
                  ...config.wardPolicies,
                  {
                    wardId: ward.id,
                    fixedWeeklyPatternId: null,
                    patternId: config.patterns[0].id,
                    naPatternId: config.patterns[0].id,
                    specialRule: "none",
                  },
                ],
              })
            }
          >
            Set patterns for {ward.name}
          </Button>
        )}
      </div>

      <div className={cardClass}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold">{ward.name}: minimum staff on duty</h3>
            <p className="text-sm text-muted-foreground">
              Type in “Every day” to fill the whole row, then adjust single days.
            </p>
          </div>
          <div className="flex flex-wrap gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={showMaximum}
                onChange={(e) => setShowMaximum(e.target.checked)}
              />
              Set maximums too
            </label>
            {(hiddenShifts > 0 || showAllShifts) && (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={showAllShifts}
                  onChange={(e) => setShowAllShifts(e.target.checked)}
                />
                Show shifts ward staff don't work
              </label>
            )}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="p-2 font-medium">Shift · staff</th>
                <th className="p-2 text-center font-medium text-primary">Every day</th>
                {WEEKDAYS.map((d, i) => (
                  <th
                    key={d}
                    className={cn("p-2 text-center font-medium", i >= 5 && "text-red-600")}
                  >
                    {d.slice(0, 3)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shifts.flatMap((s) =>
                (["nurse", "na"] as const).map((category) => {
                  const days = [1, 2, 3, 4, 5, 6, 7].map((d) => requirement(s.code, category, d));
                  const same = days.every(
                    (r) => r.minimum === days[0].minimum && r.maximum === days[0].maximum,
                  );
                  const name = `${s.name} ${CATEGORY[category].toLowerCase()}`;
                  const numberInput = (
                    r: StaffingRequirement,
                    key: "minimum" | "maximum",
                    allDays: boolean,
                    label: string,
                  ) => (
                    <input
                      aria-label={label}
                      className={cn(inputClass, "mx-auto w-16 px-2 text-center")}
                      type="number"
                      min={0}
                      max={1000}
                      placeholder={key === "maximum" ? "–" : allDays && !same ? "mixed" : "0"}
                      value={
                        allDays && !same ? "" : key === "maximum" ? (r.maximum ?? "") : r.minimum
                      }
                      onChange={(e) => {
                        const raw = e.target.value;
                        const value = raw === "" ? null : Math.max(0, Math.round(Number(raw)));
                        onChange(
                          setRequirement(
                            config,
                            key === "maximum"
                              ? { ...r, maximum: value }
                              : { ...r, minimum: value ?? 0 },
                            allDays,
                          ),
                        );
                      }}
                    />
                  );
                  return (
                    <tr key={`${s.code}-${category}`} className="border-b last:border-0">
                      <th className="p-2 text-left font-normal">
                        <span className="flex items-center gap-2">
                          <span
                            className="size-2.5 rounded-full"
                            style={{ backgroundColor: s.color }}
                          />
                          <span>
                            {s.name} <span className="text-muted-foreground">({s.code})</span>
                            <span className="block text-xs text-muted-foreground">
                              {CATEGORY[category]}
                            </span>
                          </span>
                        </span>
                      </th>
                      <td className="bg-primary/5 p-2 text-center">
                        {numberInput(days[0], "minimum", true, `${name} minimum every day`)}
                        {showMaximum && (
                          <div className="mt-1">
                            {numberInput(days[0], "maximum", true, `${name} maximum every day`)}
                          </div>
                        )}
                      </td>
                      {days.map((r, i) => (
                        <td key={i} className="p-2 text-center">
                          {numberInput(r, "minimum", false, `${name} minimum ${WEEKDAYS[i]}`)}
                          {showMaximum && (
                            <div className="mt-1">
                              {numberInput(r, "maximum", false, `${name} maximum ${WEEKDAYS[i]}`)}
                            </div>
                          )}
                        </td>
                      ))}
                    </tr>
                  );
                }),
              )}
            </tbody>
          </table>
        </div>
        {showMaximum && (
          <p className="text-xs text-muted-foreground">
            Top box: minimum. Bottom box: maximum (leave blank for no limit). The same number in
            both asks for exactly that many.
          </p>
        )}
      </div>
    </div>
  );
}
