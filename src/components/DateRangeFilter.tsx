import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { cn } from "@/lib/utils";

export type DateRangeFilterValue = { from: string; to: string };

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(d: Date, n: number) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

// Previous calendar week (Monday → Sunday), not a trailing 7-day window.
function lastWeekRange(): DateRangeFilterValue {
  const today = new Date();
  const day = today.getDay(); // 0 = Sun .. 6 = Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const thisMonday = addDays(today, diffToMonday);
  const lastMonday = addDays(thisMonday, -7);
  const lastSunday = addDays(thisMonday, -1);
  return { from: ymd(lastMonday), to: ymd(lastSunday) };
}

const PRESETS: { key: string; label: string; range: () => DateRangeFilterValue }[] = [
  {
    key: "today",
    label: "Today",
    range: () => {
      const t = ymd(new Date());
      return { from: t, to: t };
    },
  },
  {
    key: "yesterday",
    label: "Yesterday",
    range: () => {
      const y = ymd(addDays(new Date(), -1));
      return { from: y, to: y };
    },
  },
  { key: "lastWeek", label: "Last Week", range: lastWeekRange },
];

const chipCls = (active: boolean) =>
  cn(
    "h-9 px-3 rounded-md border text-sm font-medium transition-colors shrink-0",
    active
      ? "bg-primary text-primary-foreground border-primary"
      : "bg-card text-muted-foreground hover:bg-muted border-input",
  );

// Preset date-range picker (Today / Yesterday / Last Week / custom Date Range).
// No preset selected + empty from/to means "no filter" (all time) — callers
// treat blank strings as unbounded, matching the plain date-input filters this
// replaces, so switching to presets never changes default (unfiltered) behavior.
export function DateRangeFilter({
  value,
  onChange,
}: {
  value: DateRangeFilterValue;
  onChange: (v: DateRangeFilterValue) => void;
}) {
  const activePreset = PRESETS.find((p) => {
    const r = p.range();
    return r.from === value.from && r.to === value.to;
  })?.key;
  const [customOpen, setCustomOpen] = useState(!activePreset && !!(value.from || value.to));
  const showCustomInputs = customOpen || (!activePreset && !!(value.from || value.to));

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <CalendarDays className="h-4 w-4 text-muted-foreground shrink-0" />
      {PRESETS.map((p) => (
        <button
          key={p.key}
          type="button"
          onClick={() => {
            setCustomOpen(false);
            onChange(p.range());
          }}
          className={chipCls(activePreset === p.key)}
        >
          {p.label}
        </button>
      ))}
      <button
        type="button"
        onClick={() => {
          setCustomOpen(true);
          if (!value.from && !value.to) {
            const t = ymd(new Date());
            onChange({ from: t, to: t });
          }
        }}
        className={chipCls(showCustomInputs)}
      >
        Date Range
      </button>
      {showCustomInputs && (
        <>
          <input
            type="date"
            value={value.from}
            onChange={(e) => onChange({ from: e.target.value, to: value.to })}
            className="h-9 rounded-md border border-input bg-card px-3 text-sm"
          />
          <span className="text-sm text-muted-foreground">–</span>
          <input
            type="date"
            value={value.to}
            onChange={(e) => onChange({ from: value.from, to: e.target.value })}
            className="h-9 rounded-md border border-input bg-card px-3 text-sm"
          />
        </>
      )}
      {(value.from || value.to) && (
        <button
          type="button"
          onClick={() => {
            setCustomOpen(false);
            onChange({ from: "", to: "" });
          }}
          className="text-xs text-muted-foreground hover:text-foreground underline"
        >
          Clear
        </button>
      )}
    </div>
  );
}
