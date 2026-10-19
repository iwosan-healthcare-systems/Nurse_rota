import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { SchedulePattern } from "@/lib/scheduling-configuration";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_MS = 86_400_000;

// Illustrates a pattern on calendar months (Monday-first weeks). Weekly patterns
// follow the weekday; repeating patterns start at step 1 on the 1st of the
// current month and continue across months. Not a generated rota.
export function PatternMonthCalendar({ pattern }: { pattern: SchedulePattern }) {
  const [offset, setOffset] = useState(0);
  const anchor = useMemo(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }, []);
  const month = new Date(anchor.getFullYear(), anchor.getMonth() + offset, 1);
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const leading = (month.getDay() + 6) % 7;
  const cycle = useMemo(
    () =>
      pattern.steps.flatMap((s) =>
        Array.from({ length: Math.min(56, Math.max(0, Math.trunc(s.days) || 0)) }, () => s.shift),
      ),
    [pattern.steps],
  );
  const shiftOn = (date: Date) => {
    if (!cycle.length) return "";
    if (pattern.kind === "weekly") return pattern.steps[(date.getDay() + 6) % 7]?.shift ?? "";
    const index = Math.round((date.getTime() - anchor.getTime()) / DAY_MS);
    return cycle[((index % cycle.length) + cycle.length) % cycle.length];
  };
  const label = month.toLocaleDateString("en-GB", { month: "long", year: "numeric" });

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">
          Pattern on the calendar
          {pattern.kind === "weekly"
            ? " · follows the weekday"
            : ` · step 1 on ${anchor.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`}{" "}
          · not a generated rota
        </p>
        <div className="inline-flex items-center rounded-md border">
          <button
            type="button"
            className="grid h-8 w-8 place-items-center hover:bg-muted"
            aria-label="Previous month"
            onClick={() => setOffset((o) => o - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-28 px-2 text-center text-xs font-medium">{label}</span>
          <button
            type="button"
            className="grid h-8 w-8 place-items-center hover:bg-muted"
            aria-label="Next month"
            onClick={() => setOffset((o) => o + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1" role="grid" aria-label={`${pattern.name}, ${label}`}>
        {WEEKDAYS.map((d) => (
          <div key={d} className="text-center text-[10px] font-medium text-muted-foreground">
            {d}
          </div>
        ))}
        {Array.from({ length: leading }, (_, i) => (
          <div key={`blank-${i}`} />
        ))}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const date = new Date(month.getFullYear(), month.getMonth(), i + 1);
          const shift = shiftOn(date);
          return (
            <div
              key={i}
              className={`rounded border p-1 text-center text-xs ${shift === "OFF" ? "bg-muted/50 text-muted-foreground" : ""}`}
            >
              <span className="block text-[10px] text-muted-foreground">{i + 1}</span>
              <strong>{shift}</strong>
            </div>
          );
        })}
      </div>
    </div>
  );
}
