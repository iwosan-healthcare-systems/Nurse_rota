import { useState, type ReactNode } from "react";
import { ChevronDown, Info } from "lucide-react";
import { cn } from "@/lib/utils";

export const inputClass =
  "w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60";
export const cardClass = "rounded-xl border bg-card p-4 md:p-5 space-y-4";

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("grid content-start gap-1.5 text-sm", className)}>
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** What a tab is for, shown at its top. */
export function TabIntro({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 rounded-xl border bg-muted/40 p-4 text-sm">
      <Info className="mt-0.5 size-4 shrink-0 text-primary" />
      <div>
        <p className="font-medium">{title}</p>
        <div className="mt-1 space-y-1 text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

export function Pill({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "primary" | "amber" | "green";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        tone === "muted" && "bg-muted text-muted-foreground",
        tone === "primary" && "bg-primary/10 text-primary",
        tone === "amber" && "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
        tone === "green" && "bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200",
      )}
    >
      {children}
    </span>
  );
}

/** A card that shows a one-line summary and expands to its settings. */
export function ExpandableCard({
  title,
  summary,
  badges,
  actions,
  open,
  onOpenChange,
  children,
  attention = false,
}: {
  title: ReactNode;
  summary?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  attention?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border bg-card transition-colors",
        attention && "border-amber-400 dark:border-amber-700",
        open && "shadow-sm",
      )}
    >
      <div className="flex items-start gap-3 p-4">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-3 text-left"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
        >
          <ChevronDown
            className={cn(
              "mt-1 size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{title}</span>
              {badges}
            </span>
            {summary && (
              <span className="mt-0.5 block text-sm text-muted-foreground">{summary}</span>
            )}
          </span>
        </button>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      {open && <div className="space-y-4 border-t p-4 md:p-5">{children}</div>}
    </div>
  );
}

/** Open/closed state for a list of expandable cards. */
export function useExpanded(initial: string[] = []) {
  const [open, setOpen] = useState<Set<string>>(new Set(initial));
  return {
    isOpen: (id: string) => open.has(id),
    set: (id: string, value: boolean) =>
      setOpen((prev) => {
        const next = new Set(prev);
        if (value) next.add(id);
        else next.delete(id);
        return next;
      }),
    setAll: (ids: string[]) => setOpen(new Set(ids)),
  };
}

/** A group of choices shown as buttons, for short option lists. */
export function ChoiceButtons<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; description?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            "rounded-lg border p-3 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-60",
            value === o.value
              ? "border-primary bg-primary/5 ring-1 ring-primary"
              : "hover:border-primary/50",
          )}
        >
          <span className="block font-medium">{o.label}</span>
          {o.description && (
            <span className="mt-0.5 block text-xs text-muted-foreground">{o.description}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export const list = (items: string[]) =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
