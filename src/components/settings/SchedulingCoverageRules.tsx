import { Plus, Trash2, CalendarDays, Users, Repeat, Moon, AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type {
  CoverageRule,
  SchedulingConfiguration,
  SchedulingRole,
} from "@/lib/scheduling-configuration";

const input = "w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60";
const DAY = 86_400_000;
const dayNumber = (ymd: string) => Math.floor(Date.parse(`${ymd}T00:00:00Z`) / DAY);
const fromDayNumber = (n: number) => new Date(n * DAY);
const weekday = (n: number) =>
  fromDayNumber(n).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
const shortDate = (n: number) =>
  fromDayNumber(n).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
const longDate = (n: number) =>
  fromDayNumber(n).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const list = (items: string[]) =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
const validAnchor = (rule: CoverageRule) =>
  /^\d{4}-\d{2}-\d{2}$/.test(rule.anchorDate) && Number.isFinite(dayNumber(rule.anchorDate));

// The next Saturday on or after today, for a new weekend rule.
function nextSaturday() {
  const today = Math.floor(Date.now() / DAY);
  const n = today + ((6 - fromDayNumber(today).getUTCDay() + 7) % 7);
  return fromDayNumber(n).toISOString().slice(0, 10);
}

const PRESETS: {
  key: string;
  title: string;
  description: string;
  rule: () => Omit<CoverageRule, "id" | "roleIds" | "shift">;
}[] = [
  {
    key: "weekend",
    title: "Weekend coverage",
    description:
      "One person each weekend works Saturday and Sunday, off the Friday before and the Monday after.",
    rule: () => ({
      name: "Weekend coverage",
      anchorDate: nextSaturday(),
      blockDays: 2,
      repeatDays: 7,
      staffPerBlock: 1,
      restBefore: 1,
      restAfter: 1,
    }),
  },
  {
    key: "custom",
    title: "Custom rule",
    description: "Choose your own duty days, how often turns come round and the days off.",
    rule: () => ({
      name: "Coverage rule",
      anchorDate: new Date().toISOString().slice(0, 10),
      blockDays: 1,
      repeatDays: 7,
      staffPerBlock: 1,
      restBefore: 0,
      restAfter: 0,
    }),
  },
];

/** "Every week, 1 Coverage Nurse - Day works … on Saturday and Sunday, …" */
export function describeCoverageRule(rule: CoverageRule, config: SchedulingConfiguration) {
  const shift = config.shifts.find((s) => s.code === rule.shift);
  const roles = config.roles.filter((r) => rule.roleIds.includes(r.id)).map((r) => r.name);
  const who = roles.length ? list(roles) : "the chosen roles";
  const anchor = validAnchor(rule) ? dayNumber(rule.anchorDate) : null;
  const continuous = rule.repeatDays === rule.blockDays;
  const often = continuous
    ? "Continuously"
    : rule.repeatDays === 7
      ? "Every week"
      : rule.repeatDays % 7 === 0
        ? `Every ${rule.repeatDays / 7} weeks`
        : `Every ${rule.repeatDays} days`;
  const weekly = rule.repeatDays % 7 === 0 && anchor !== null;
  const dutyDays = weekly
    ? ` on ${list(Array.from({ length: rule.blockDays }, (_, k) => weekday(anchor + k)))}`
    : ` for ${plural(rule.blockDays, "day")} in a row`;
  const rest: string[] = [];
  if (rule.restBefore)
    rest.push(
      weekly && rule.restBefore === 1
        ? `the ${weekday(anchor - 1)} before`
        : `${plural(rule.restBefore, "day")} before`,
    );
  if (rule.restAfter)
    rest.push(
      weekly && rule.restAfter === 1
        ? `the ${weekday(anchor + rule.blockDays)} after`
        : `${plural(rule.restAfter, "day")} after`,
    );
  return `${often}, ${plural(rule.staffPerBlock, "person")} from ${who} ${
    rule.staffPerBlock === 1 ? "works" : "work"
  } ${shift ? shift.name : rule.shift}${dutyDays}${rest.length ? `, off ${list(rest)}` : ""}.`;
}

// The next few turns from today, in plain dates.
function upcomingTurns(rule: CoverageRule, count = 4) {
  if (!validAnchor(rule) || rule.repeatDays < 1 || rule.blockDays < 1) return [];
  const anchor = dayNumber(rule.anchorDate);
  const today = Math.floor(Date.now() / DAY);
  const first = Math.max(0, Math.ceil((today - anchor - rule.blockDays + 1) / rule.repeatDays));
  return Array.from({ length: count }, (_, i) => {
    const start = anchor + (first + i) * rule.repeatDays;
    const end = start + rule.blockDays - 1;
    return {
      duty: start === end ? shortDate(start) : `${shortDate(start)} – ${shortDate(end)}`,
      before: rule.restBefore
        ? rule.restBefore === 1
          ? shortDate(start - 1)
          : `${shortDate(start - rule.restBefore)} – ${shortDate(start - 1)}`
        : null,
      after: rule.restAfter
        ? rule.restAfter === 1
          ? shortDate(end + 1)
          : `${shortDate(end + 1)} – ${shortDate(end + rule.restAfter)}`
        : null,
    };
  });
}

function problems(rule: CoverageRule, config: SchedulingConfiguration, eligible: SchedulingRole[]) {
  const out: string[] = [];
  if (!rule.name.trim()) out.push("Give the rule a name.");
  if (!validAnchor(rule)) out.push("Choose the date the first turn starts.");
  if (!rule.roleIds.length) out.push("Choose at least one role to take turns.");
  if (rule.roleIds.some((id) => !eligible.some((r) => r.id === id)))
    out.push(
      "A chosen role is no longer facility-wide on a configured pattern. Untick it or change it in Staff roles.",
    );
  const noShift = config.roles.filter(
    (r) => rule.roleIds.includes(r.id) && !r.allowedShifts.includes(rule.shift),
  );
  if (noShift.length)
    out.push(
      `${list(noShift.map((r) => r.name))} cannot work this shift yet. Use "Allow" next to the role.`,
    );
  if (rule.repeatDays < rule.blockDays)
    out.push("Turns cannot come round more often than they last. Increase “Repeat every”.");
  if (rule.restBefore + rule.blockDays + rule.restAfter > rule.repeatDays && rule.staffPerBlock > 0)
    out.push(
      "Duty plus days off is longer than the repeat interval, so one person's turns would overlap if they are the only one available.",
    );
  return out;
}

function Section({
  icon,
  title,
  hint,
  children,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-3 rounded-lg border bg-background/60 p-4">
      <div>
        <div className="flex items-center gap-2 text-sm font-semibold">
          {icon}
          {title}
        </div>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function NumberField({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid content-start gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <input
        className={input}
        type="number"
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => {
          const n = Math.round(Number(e.target.value));
          onChange(Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min);
        }}
      />
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

export function SchedulingCoverageRules({
  config,
  onChange,
}: {
  config: SchedulingConfiguration;
  onChange: (config: SchedulingConfiguration) => void;
}) {
  const rules = config.coverageRules ?? [];
  const eligible = config.roles.filter((r) => r.scope === "facility" && r.specialRule === "none");
  const update = (id: string, patch: Partial<CoverageRule>) =>
    onChange({
      ...config,
      coverageRules: rules.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    });
  const allowShift = (roleId: string, shift: string) =>
    onChange({
      ...config,
      roles: config.roles.map((r) =>
        r.id === roleId && !r.allowedShifts.includes(shift)
          ? { ...r, allowedShifts: [...r.allowedShifts, shift] }
          : r,
      ),
    });
  const add = (preset: (typeof PRESETS)[number]) =>
    onChange({
      ...config,
      coverageRules: [
        ...rules,
        {
          id: `coverage_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
          shift: config.shifts.find((s) => s.code === "MWC")?.code ?? config.shifts[0].code,
          roleIds: [],
          ...preset.rule(),
        },
      ],
    });
  const canAdd = rules.length < 32 && config.shifts.length > 0;

  return (
    <div className="space-y-5">
      <div className="rounded-xl border bg-muted/40 p-4 text-sm">
        <p className="font-medium">Step 5 · Coverage rules: how they work</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
          <li>
            Staff in the chosen roles take turns covering a block of duty, for example one day
            coverage nurse each weekend.
          </li>
          <li>
            On their turn the cover shift replaces their usual pattern, with the days off you set
            before and after it. The rest of the time they follow their role's pattern (Staff
            roles).
          </li>
          <li>
            Anyone on approved leave during a turn is skipped and the next person in turn covers. A
            gap is reported only when nobody is available.
          </li>
        </ul>
      </div>

      {rules.map((rule) => {
        const issues = problems(rule, config, eligible);
        const turns = upcomingTurns(rule);
        const anchor = validAnchor(rule) ? dayNumber(rule.anchorDate) : null;
        const facilityLegacy = config.roles.filter(
          (r) => r.scope === "facility" && r.specialRule !== "none",
        );
        return (
          <section key={rule.id} className="space-y-4 rounded-xl border bg-card p-4 md:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <label className="grid min-w-0 flex-1 gap-1 text-sm">
                <span className="font-medium">Rule name</span>
                <input
                  className={`${input} text-base font-semibold`}
                  value={rule.name}
                  onChange={(e) => update(rule.id, { name: e.target.value })}
                />
              </label>
              <Button
                variant="ghost"
                className="mt-5 text-destructive hover:text-destructive"
                onClick={() => {
                  if (window.confirm(`Remove “${rule.name}”?`))
                    onChange({ ...config, coverageRules: rules.filter((r) => r.id !== rule.id) });
                }}
              >
                <Trash2 />
                Remove
              </Button>
            </div>

            <p className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm font-medium">
              {describeCoverageRule(rule, config)}
            </p>

            <div className="grid gap-4 lg:grid-cols-2">
              <Section
                icon={<Users className="size-4" />}
                title="Who takes turns"
                hint="Facility-wide roles on a configured pattern. Staff rotate in a fixed order."
              >
                {!eligible.length ? (
                  <p className="text-sm text-amber-800 dark:text-amber-300">
                    No role can be used yet. In Staff roles, set a role to Facility-wide and
                    “Configured pattern and coverage rules”.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {eligible.map((role) => {
                      const checked = rule.roleIds.includes(role.id);
                      const allowed = role.allowedShifts.includes(rule.shift);
                      return (
                        <div
                          key={role.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
                        >
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="size-4"
                              checked={checked}
                              onChange={(e) =>
                                update(rule.id, {
                                  roleIds: e.target.checked
                                    ? [...rule.roleIds, role.id]
                                    : rule.roleIds.filter((id) => id !== role.id),
                                })
                              }
                            />
                            {role.name}
                          </label>
                          {checked && !allowed && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => allowShift(role.id, rule.shift)}
                            >
                              Allow {rule.shift} for this role
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {facilityLegacy.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Not listed because they keep retained rules:{" "}
                    {list(facilityLegacy.map((r) => r.name))}.
                  </p>
                )}
              </Section>

              <Section
                icon={<CalendarDays className="size-4" />}
                title="Duty on each turn"
                hint="The shift worked, how many days it lasts and how many people cover together."
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid content-start gap-1 text-sm sm:col-span-2">
                    <span className="font-medium">Cover shift</span>
                    <select
                      className={input}
                      value={rule.shift}
                      onChange={(e) => update(rule.id, { shift: e.target.value })}
                    >
                      {config.shifts.map((s) => (
                        <option key={s.code} value={s.code}>
                          {s.name} ({s.code}) · {s.start}–{s.end}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid content-start gap-1 text-sm sm:col-span-2">
                    <span className="font-medium">First turn starts on</span>
                    <input
                      className={input}
                      type="date"
                      value={rule.anchorDate}
                      onChange={(e) => update(rule.id, { anchorDate: e.target.value })}
                    />
                    <span className="text-xs text-muted-foreground">
                      {anchor !== null
                        ? `${longDate(anchor)}. Every turn starts on this weekday when turns repeat weekly.`
                        : "Pick a date. For weekend cover choose a Saturday."}
                    </span>
                  </label>
                  <NumberField
                    label="Duty days in a row"
                    hint={
                      rule.blockDays === 2 && anchor !== null && weekday(anchor) === "Saturday"
                        ? "Saturday and Sunday"
                        : undefined
                    }
                    value={rule.blockDays}
                    min={1}
                    max={28}
                    onChange={(blockDays) => update(rule.id, { blockDays })}
                  />
                  <NumberField
                    label="People per turn"
                    value={rule.staffPerBlock}
                    min={1}
                    max={100}
                    onChange={(staffPerBlock) => update(rule.id, { staffPerBlock })}
                  />
                </div>
              </Section>

              <Section
                icon={<Repeat className="size-4" />}
                title="How often turns come round"
                hint="Days from the start of one turn to the start of the next."
              >
                <div className="flex flex-wrap gap-2">
                  {[
                    [7, "Every week"],
                    [14, "Every 2 weeks"],
                    [rule.blockDays, "Continuously"],
                  ].map(([days, label]) => (
                    <Button
                      key={label}
                      size="sm"
                      variant={rule.repeatDays === days ? "default" : "outline"}
                      onClick={() => update(rule.id, { repeatDays: Number(days) })}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
                <NumberField
                  label="Repeat every (days)"
                  value={rule.repeatDays}
                  min={1}
                  max={56}
                  onChange={(repeatDays) => update(rule.id, { repeatDays })}
                />
              </Section>

              <Section
                icon={<Moon className="size-4" />}
                title="Days off around each turn"
                hint="Given to whoever covers, in place of their usual shifts."
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <NumberField
                    label="Days off before"
                    hint={
                      rule.restBefore === 1 && anchor !== null
                        ? `The ${weekday(anchor - 1)} before`
                        : undefined
                    }
                    value={rule.restBefore}
                    min={0}
                    max={28}
                    onChange={(restBefore) => update(rule.id, { restBefore })}
                  />
                  <NumberField
                    label="Days off after"
                    hint={
                      rule.restAfter === 1 && anchor !== null
                        ? `The ${weekday(anchor + rule.blockDays)} after`
                        : undefined
                    }
                    value={rule.restAfter}
                    min={0}
                    max={28}
                    onChange={(restAfter) => update(rule.id, { restAfter })}
                  />
                </div>
              </Section>
            </div>

            {issues.length > 0 && (
              <div
                role="alert"
                className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
              >
                {issues.map((issue) => (
                  <p key={issue} className="flex gap-2">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    {issue}
                  </p>
                ))}
              </div>
            )}

            {turns.length > 0 && (
              <div>
                <p className="mb-2 text-sm font-medium">Next turns</p>
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  {turns.map((turn, i) => (
                    <div key={i} className="rounded-lg border p-3 text-sm">
                      <p className="text-xs text-muted-foreground">Turn {i + 1}</p>
                      <p className="font-semibold">
                        {rule.shift} · {turn.duty}
                      </p>
                      {(turn.before || turn.after) && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Off {[turn.before, turn.after].filter(Boolean).join(" and ")}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Each turn goes to the next person in the rotation who is not on leave.
                </p>
              </div>
            )}
          </section>
        );
      })}

      {rules.length === 0 && (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          No coverage rules yet. Add one below.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {PRESETS.map((preset) => (
          <button
            key={preset.key}
            type="button"
            disabled={!canAdd}
            onClick={() => add(preset)}
            className="flex items-start gap-3 rounded-xl border bg-card p-4 text-left transition hover:border-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Plus className="mt-0.5 size-4 shrink-0" />
            <span>
              <span className="block text-sm font-semibold">Add {preset.title.toLowerCase()}</span>
              <span className="block text-xs text-muted-foreground">{preset.description}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
