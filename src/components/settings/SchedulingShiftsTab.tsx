import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  hoursLabel,
  renameShift,
  shiftDurationMinutes,
  shiftUsage,
  type SchedulingConfiguration,
  type WorkShift,
} from "@/lib/scheduling-configuration";
import {
  ExpandableCard,
  Field,
  Pill,
  TabIntro,
  cardClass,
  inputClass,
  list,
  useExpanded,
} from "./scheduling-ui";

const TIMEZONES = ["Africa/Lagos"];

export function SchedulingShiftsTab({
  config,
  onChange,
}: {
  config: SchedulingConfiguration;
  onChange: (config: SchedulingConfiguration) => void;
}) {
  const expanded = useExpanded();
  const setShift = (i: number, patch: Partial<WorkShift>) =>
    onChange({
      ...config,
      shifts: config.shifts.map((v, j) => (j === i ? { ...v, ...patch } : v)),
    });
  // A shift whose end time is not after its start time finishes the next day.
  const setTime = (i: number, key: "start" | "end", value: string) => {
    const s = { ...config.shifts[i], [key]: value };
    setShift(i, { [key]: value, endDayOffset: s.end <= s.start ? 1 : 0 });
  };
  const timezones = TIMEZONES.includes(config.timezone)
    ? TIMEZONES
    : [config.timezone, ...TIMEZONES];

  return (
    <div className="space-y-4">
      <TabIntro title="Step 1 · Shifts">
        <p>
          The shifts staff can work, with their times and the hours they earn. Each shift has a
          short code shown on the rota (for example M for Morning). OFF and LEAVE are built in.
        </p>
      </TabIntro>
      <div className={cardClass}>
        <Field
          label="Hospital timezone"
          hint="Shift times and rota months follow this timezone."
          className="max-w-sm"
        >
          <select
            className={inputClass}
            value={config.timezone}
            onChange={(e) => onChange({ ...config, timezone: e.target.value })}
          >
            {timezones.map((tz) => (
              <option key={tz} value={tz}>
                {tz === "Africa/Lagos" ? "Africa/Lagos (West Africa Time)" : tz}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => expanded.setAll(config.shifts.map((s) => s.code))}
        >
          Expand all
        </Button>
        <Button variant="ghost" size="sm" onClick={() => expanded.setAll([])}>
          Collapse all
        </Button>
      </div>
      {config.shifts.map((s, i) => {
        const usage = shiftUsage(config, s.code);
        const used =
          usage.roles.length + usage.patterns.length + usage.coverageRules.length > 0 ||
          usage.requirements > 0;
        const duration = shiftDurationMinutes(s);
        const usedBy = [
          ...(usage.roles.length ? [`roles: ${list(usage.roles)}`] : []),
          ...(usage.patterns.length ? [`patterns: ${list(usage.patterns)}`] : []),
          ...(usage.coverageRules.length ? [`coverage: ${list(usage.coverageRules)}`] : []),
        ];
        return (
          <ExpandableCard
            key={i}
            open={expanded.isOpen(s.code)}
            onOpenChange={(open) => expanded.set(s.code, open)}
            title={
              <span className="flex items-center gap-2">
                <span className="size-3 rounded-full" style={{ backgroundColor: s.color }} />
                {s.name || "New shift"}
              </span>
            }
            badges={
              <>
                <Pill tone="primary">{s.code}</Pill>
                {!used && <Pill>Not used</Pill>}
              </>
            }
            summary={`${s.start} – ${s.end}${s.endDayOffset ? " (next day)" : ""} · ${hoursLabel(
              s.creditedMinutes,
            )} credited${s.breakMinutes ? ` · ${s.breakMinutes} min break` : ""}`}
            actions={
              <Button
                variant="ghost"
                size="sm"
                disabled={used}
                title={
                  used
                    ? "Remove this shift from roles, patterns, coverage and ward requirements first"
                    : "Remove shift"
                }
                onClick={() => {
                  if (window.confirm(`Remove the ${s.name} shift?`))
                    onChange({ ...config, shifts: config.shifts.filter((_, j) => j !== i) });
                }}
              >
                <Trash2 />
                <span className="hidden sm:inline">Remove</span>
              </Button>
            }
          >
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Shift name">
                <input
                  className={inputClass}
                  value={s.name}
                  maxLength={120}
                  onChange={(e) => setShift(i, { name: e.target.value })}
                />
              </Field>
              <Field label="Code on the rota" hint="Capital letters, e.g. M, N, EVE.">
                <input
                  className={inputClass}
                  value={s.code}
                  maxLength={16}
                  onChange={(e) => {
                    const code = e.target.value.toUpperCase();
                    if (["OFF", "LEAVE"].includes(code)) {
                      toast.error("OFF and LEAVE are built in and cannot be used as codes");
                      return;
                    }
                    if (config.shifts.some((v, j) => j !== i && v.code === code)) {
                      toast.error("Another shift already uses that code");
                      return;
                    }
                    const wasOpen = expanded.isOpen(s.code);
                    onChange(renameShift(config, s.code, code));
                    if (wasOpen) expanded.set(code, true);
                  }}
                />
              </Field>
              <Field label="Starts">
                <input
                  type="time"
                  className={inputClass}
                  value={s.start}
                  onChange={(e) => setTime(i, "start", e.target.value)}
                />
              </Field>
              <Field
                label="Ends"
                hint={
                  s.endDayOffset
                    ? `Next day · ${hoursLabel(duration)} long`
                    : `Same day · ${hoursLabel(duration)} long`
                }
              >
                <input
                  type="time"
                  className={inputClass}
                  value={s.end}
                  onChange={(e) => setTime(i, "end", e.target.value)}
                />
              </Field>
              <Field label="Unpaid break (minutes)">
                <input
                  type="number"
                  min={0}
                  max={1439}
                  className={inputClass}
                  value={s.breakMinutes}
                  onChange={(e) => setShift(i, { breakMinutes: Number(e.target.value) })}
                />
              </Field>
              <Field
                label="Hours credited"
                hint={`${s.creditedMinutes} minutes count towards staff hours.`}
              >
                <input
                  type="number"
                  min={0.25}
                  max={24}
                  step={0.25}
                  className={inputClass}
                  value={Math.round((s.creditedMinutes / 60) * 100) / 100}
                  onChange={(e) =>
                    setShift(i, { creditedMinutes: Math.round(Number(e.target.value) * 60) })
                  }
                />
              </Field>
              <Field label="Colour on the rota">
                <input
                  type="color"
                  className={`${inputClass} h-10`}
                  value={s.color}
                  onChange={(e) => setShift(i, { color: e.target.value })}
                />
              </Field>
              {duration > 0 && s.creditedMinutes > duration && (
                <p className="self-end text-xs text-amber-800 dark:text-amber-300 sm:col-span-2 lg:col-span-1">
                  Credited hours are longer than the shift ({hoursLabel(duration)}).
                </p>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {usedBy.length
                ? `Used by ${usedBy.join("; ")}${
                    usage.requirements ? `; ward minimums on ${usage.requirements} days` : ""
                  }.`
                : "Not used by any role, pattern or rule yet."}
            </p>
          </ExpandableCard>
        );
      })}
      <Button
        variant="outline"
        disabled={config.shifts.length >= 32}
        onClick={() => {
          let n = 1;
          while (config.shifts.some((s) => s.code === `S${n}`)) n++;
          onChange({
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
          expanded.set(`S${n}`, true);
        }}
      >
        <Plus />
        Add shift
      </Button>
    </div>
  );
}
