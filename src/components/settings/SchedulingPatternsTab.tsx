import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  WEEKDAYS,
  patternSummary,
  patternUsage,
  type SchedulePattern,
  type SchedulingConfiguration,
} from "@/lib/scheduling-configuration";
import { PatternMonthCalendar } from "./PatternMonthCalendar";
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

/** Coloured blocks for each step: "M×4", "OFF×2"… */
function StepStrip({
  pattern,
  config,
}: {
  pattern: SchedulePattern;
  config: SchedulingConfiguration;
}) {
  const color = (code: string) => config.shifts.find((s) => s.code === code)?.color;
  return (
    <span className="flex flex-wrap gap-1">
      {pattern.steps.map((step, i) => (
        <span
          key={i}
          className="rounded px-1.5 py-0.5 text-[11px] font-semibold"
          style={
            step.shift === "OFF"
              ? undefined
              : { backgroundColor: `${color(step.shift) ?? "#94a3b8"}33` }
          }
        >
          {pattern.kind === "weekly"
            ? `${WEEKDAYS[i].slice(0, 2)} ${step.shift}`
            : `${step.shift}×${step.days}`}
        </span>
      ))}
    </span>
  );
}

export function SchedulingPatternsTab({
  config,
  wards,
  onChange,
}: {
  config: SchedulingConfiguration;
  wards: { id: string; name: string }[];
  onChange: (config: SchedulingConfiguration) => void;
}) {
  const expanded = useExpanded();
  const editPattern = (index: number, next: SchedulePattern) =>
    onChange({ ...config, patterns: config.patterns.map((p, i) => (i === index ? next : p)) });
  const shiftOptions = (
    <>
      <option value="OFF">OFF (day off)</option>
      {config.shifts.map((s) => (
        <option key={s.code} value={s.code}>
          {s.name} ({s.code})
        </option>
      ))}
    </>
  );
  const add = (kind: SchedulePattern["kind"]) => {
    const id = newId("pattern");
    onChange({
      ...config,
      patterns: [
        ...config.patterns,
        {
          id,
          name: kind === "weekly" ? "New weekly schedule" : "New repeating pattern",
          kind,
          steps:
            kind === "weekly"
              ? WEEKDAYS.map((_, i) => ({
                  shift: i < 5 ? (config.shifts[0]?.code ?? "OFF") : "OFF",
                  days: 1,
                }))
              : [
                  { shift: config.shifts[0]?.code ?? "OFF", days: 4 },
                  { shift: "OFF", days: 4 },
                ],
        },
      ],
    });
    expanded.set(id, true);
  };

  return (
    <div className="space-y-4">
      <TabIntro title="Step 2 · Patterns">
        <p>
          A pattern is the order of shifts and days off a person works. A <strong>repeating</strong>{" "}
          pattern runs in a cycle (for example 4 mornings, 4 off, 4 nights, 4 off). A{" "}
          <strong>weekly</strong> schedule is the same every week (for example Monday–Friday
          mornings).
        </p>
        <p>You choose which pattern each role or ward uses in the next steps.</p>
      </TabIntro>
      {config.patterns.map((p, i) => {
        const usage = patternUsage(config, p.id, wards);
        const used = usage.roles.length + usage.wards.length > 0;
        return (
          <ExpandableCard
            key={p.id}
            open={expanded.isOpen(p.id)}
            onOpenChange={(open) => expanded.set(p.id, open)}
            title={p.name || "Unnamed pattern"}
            badges={
              <>
                <Pill>{p.kind === "weekly" ? "Weekly" : "Repeating"}</Pill>
                {!used && <Pill>Not used</Pill>}
              </>
            }
            summary={
              <span className="mt-1 flex flex-col gap-1">
                <StepStrip pattern={p} config={config} />
                <span>{patternSummary(p)}</span>
              </span>
            }
            actions={
              <Button
                variant="ghost"
                size="sm"
                disabled={used || config.patterns.length === 1}
                title={
                  used
                    ? "Choose another pattern for the roles and wards using this one first"
                    : "Remove pattern"
                }
                onClick={() => {
                  if (window.confirm(`Remove the pattern “${p.name}”?`))
                    onChange({
                      ...config,
                      patterns: config.patterns.filter((v) => v.id !== p.id),
                    });
                }}
              >
                <Trash2 />
                <span className="hidden sm:inline">Remove</span>
              </Button>
            }
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Pattern name">
                <input
                  className={inputClass}
                  value={p.name}
                  onChange={(e) => editPattern(i, { ...p, name: e.target.value })}
                />
              </Field>
              <div className="grid gap-1.5 text-sm">
                <span className="font-medium">Type</span>
                <ChoiceButtons
                  value={p.kind}
                  options={[
                    { value: "repeating", label: "Repeating cycle" },
                    { value: "weekly", label: "Same every week" },
                  ]}
                  onChange={(kind) => {
                    if (
                      kind !== p.kind &&
                      window.confirm("Changing the type replaces this pattern's steps. Continue?")
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
                />
              </div>
            </div>

            {p.kind === "weekly" ? (
              <div className="grid gap-2 sm:grid-cols-4 lg:grid-cols-7">
                {p.steps.map((step, j) => (
                  <Field key={j} label={WEEKDAYS[j]}>
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
                      {shiftOptions}
                    </select>
                  </Field>
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-sm font-medium">Steps, in order</p>
                {p.steps.map((step, j) => (
                  <div
                    key={j}
                    className="flex flex-wrap items-end gap-2 rounded-lg bg-muted/40 p-3"
                  >
                    <span className="mb-2 w-6 text-sm font-semibold text-muted-foreground">
                      {j + 1}.
                    </span>
                    <Field label="Work" className="min-w-40 flex-1">
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
                        {shiftOptions}
                      </select>
                    </Field>
                    <Field label="For (days)" className="w-28">
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
                    <div className="flex gap-1">
                      {[-1, 1].map((direction) => (
                        <Button
                          key={direction}
                          variant="outline"
                          size="icon"
                          aria-label={`Move step ${j + 1} ${direction < 0 ? "up" : "down"}`}
                          disabled={j + direction < 0 || j + direction >= p.steps.length}
                          onClick={() => {
                            const steps = [...p.steps];
                            [steps[j], steps[j + direction]] = [steps[j + direction], steps[j]];
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
                    </div>
                  </div>
                ))}
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
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {used
                ? `Used by ${[
                    ...(usage.roles.length ? [`roles: ${list(usage.roles)}`] : []),
                    ...(usage.wards.length ? [`wards: ${list(usage.wards)}`] : []),
                  ].join("; ")}.`
                : "Not used by any role or ward yet."}
            </p>
            <PatternMonthCalendar pattern={p} />
          </ExpandableCard>
        );
      })}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={config.patterns.length >= 100}
          onClick={() => add("repeating")}
        >
          <Plus />
          Add repeating pattern
        </Button>
        <Button
          variant="outline"
          disabled={config.patterns.length >= 100}
          onClick={() => add("weekly")}
        >
          <Plus />
          Add weekly schedule
        </Button>
      </div>
    </div>
  );
}
