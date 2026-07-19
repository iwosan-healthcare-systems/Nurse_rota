import { Building2 } from "lucide-react";
import { cn } from "@/lib/utils";

export const FACILITIES = ["Ikeja", "Ikoyi", "Ligali"] as const;
export type FacilityName = (typeof FACILITIES)[number];

interface FacilityChipsProps {
  /** Currently selected facility, or "" for "All Facilities" */
  value: string;
  onChange: (f: string) => void;
  /** When true, render a single non-interactive chip showing the locked facility */
  locked?: boolean;
  /** Show the "All Facilities" option (only for admin / CNO / HR) */
  showAll?: boolean;
  className?: string;
}

export function FacilityChips({
  value,
  onChange,
  locked = false,
  showAll = false,
  className,
}: FacilityChipsProps) {
  const chipBase =
    "shrink-0 inline-flex items-center gap-2 h-9 px-4 rounded-xl border text-sm font-medium transition-all";

  if (locked) {
    return (
      <div className={cn("flex items-center gap-2 flex-wrap", className)}>
        <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
        <span
          className={cn(chipBase, "bg-primary/10 text-primary border-primary/30 cursor-default")}
        >
          <Building2 className="h-3.5 w-3.5 shrink-0" />
          {value}
        </span>
      </div>
    );
  }

  return (
    <div className={cn("flex items-center gap-2 flex-wrap", className)}>
      <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
      {showAll && (
        <button
          type="button"
          onClick={() => onChange("")}
          className={cn(
            chipBase,
            value === ""
              ? "bg-primary text-primary-foreground border-primary shadow-sm"
              : "bg-card text-muted-foreground border hover:bg-muted",
          )}
        >
          All Facilities
        </button>
      )}
      {FACILITIES.map((f) => (
        <button
          key={f}
          type="button"
          onClick={() => onChange(f)}
          className={cn(
            chipBase,
            value === f
              ? "bg-primary text-primary-foreground border-primary shadow-sm"
              : "bg-card text-muted-foreground border hover:bg-muted",
          )}
        >
          <Building2 className="h-3.5 w-3.5 shrink-0" />
          {f}
        </button>
      ))}
    </div>
  );
}
