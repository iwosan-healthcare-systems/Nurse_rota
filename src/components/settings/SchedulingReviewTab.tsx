import { AlertTriangle, CheckCircle2, CircleDashed } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  hoursLabel,
  type ConfigurationValidation,
  type SchedulingConfiguration,
  type SchedulingTab,
} from "@/lib/scheduling-configuration";
import { describeCoverageRule } from "./SchedulingCoverageRules";
import { TabIntro, cardClass, list } from "./scheduling-ui";

function Check({
  state,
  children,
  action,
}: {
  state: "ok" | "warn" | "todo";
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
      <span className="flex items-start gap-2">
        {state === "ok" ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-600" />
        ) : state === "warn" ? (
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
        ) : (
          <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        <span>{children}</span>
      </span>
      {action}
    </li>
  );
}

export function SchedulingReviewTab({
  config,
  wards,
  validation,
  dirty,
  saved,
  canManage,
  busy,
  onValidate,
  onGoTo,
}: {
  config: SchedulingConfiguration;
  wards: { id: string; name: string }[];
  validation: ConfigurationValidation | null;
  dirty: boolean;
  saved: boolean;
  canManage: boolean;
  busy: boolean;
  onValidate: () => void;
  onGoTo: (tab: SchedulingTab | "check") => void;
}) {
  const pattern = (id: string) => config.patterns.find((p) => p.id === id)?.name ?? "—";
  const shiftName = (code: string) => config.shifts.find((s) => s.code === code)?.name ?? code;
  const review = config.roles.filter((r) => r.requiresReview);
  const unusedPatterns = config.patterns.filter(
    (p) =>
      !config.roles.some((r) => r.patternId === p.id) &&
      !config.wardPolicies.some(
        (w) => w.patternId === p.id || w.naPatternId === p.id || w.fixedWeeklyPatternId === p.id,
      ),
  );
  const go = (tab: SchedulingTab | "check", label: string) => (
    <Button variant="outline" size="sm" onClick={() => onGoTo(tab)}>
      {label}
    </Button>
  );

  return (
    <div className="space-y-4">
      <TabIntro title="Step 6 · Review">
        <p>
          Your setup in plain words. Check it reads the way your hospital works, then save. Saved
          rules are used from the next rota month that has not been generated yet; rotas already
          generated keep the rules they were made with.
        </p>
      </TabIntro>

      <div className={cardClass}>
        <h3 className="font-semibold">Before you save</h3>
        <ul className="space-y-2">
          <Check
            state={!validation ? "todo" : validation.valid ? "ok" : "warn"}
            action={
              canManage &&
              (!validation?.valid ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={onValidate}>
                  Check settings
                </Button>
              ) : undefined)
            }
          >
            {!validation
              ? "Settings not checked yet."
              : validation.valid
                ? "All settings fit together."
                : `${validation.errors.length} setting${
                    validation.errors.length === 1 ? " needs" : "s need"
                  } fixing. They are listed at the top of the page.`}
          </Check>
          <Check
            state={review.length ? "warn" : "ok"}
            action={review.length ? go("roles", "Review roles") : undefined}
          >
            {review.length
              ? `${list(review.map((r) => r.name))} ${review.length === 1 ? "needs" : "need"} review. Their staff are not scheduled until confirmed.`
              : "Every staff role is confirmed."}
          </Check>
          {unusedPatterns.length > 0 && (
            <Check state="todo" action={go("patterns", "Open patterns")}>
              Not used by any role or ward: {list(unusedPatterns.map((p) => p.name))}. That is fine;
              remove them if they are not needed.
            </Check>
          )}
          <Check state={dirty ? "warn" : saved ? "ok" : "todo"}>
            {dirty
              ? "You have unsaved changes."
              : saved
                ? "Saved."
                : "Not saved yet. These are the facility's starting rules."}
          </Check>
          <Check state="todo" action={go("check", "Check a month")}>
            Optional: see how the saved rules would staff a month with today's staff and leave.
          </Check>
        </ul>
      </div>

      <div className={cardClass}>
        <h3 className="font-semibold">Shifts</h3>
        <ul className="grid gap-2 text-sm sm:grid-cols-2">
          {config.shifts.map((s) => (
            <li key={s.code} className="flex items-center gap-2">
              <span className="size-2.5 rounded-full" style={{ backgroundColor: s.color }} />
              <span>
                <strong>{s.name}</strong> ({s.code}) · {s.start} – {s.end}
                {s.endDayOffset ? " next day" : ""} · {hoursLabel(s.creditedMinutes)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className={cardClass}>
        <h3 className="font-semibold">Staff roles</h3>
        <ul className="space-y-1.5 text-sm">
          {config.roles.map((r) => (
            <li key={r.id}>
              <strong>{r.name}</strong>
              {": "}
              {r.specialRule !== "none"
                ? "keeps Lagoon's original rotation."
                : `${r.scope === "ward" ? "ward staff" : "facility-wide"}, ${
                    r.scope === "ward" && r.useWardPattern !== false
                      ? "follows their ward's pattern"
                      : `works ${pattern(r.patternId)}`
                  }; can work ${list(r.allowedShifts.map(shiftName)) || "no shifts"}.`}
              {r.requiresReview && <span className="text-amber-700"> Needs review.</span>}
            </li>
          ))}
        </ul>
      </div>

      <div className={cardClass}>
        <h3 className="font-semibold">Coverage rules</h3>
        {(config.coverageRules ?? []).length ? (
          <ul className="space-y-1.5 text-sm">
            {(config.coverageRules ?? []).map((rule) => (
              <li key={rule.id}>
                <strong>{rule.name}:</strong> {describeCoverageRule(rule, config)} Anyone on leave
                is skipped.
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No coverage rules.</p>
        )}
      </div>

      <div className={cardClass}>
        <h3 className="font-semibold">Wards</h3>
        {wards.length ? (
          <ul className="space-y-2 text-sm">
            {wards.map((w) => {
              const policy = config.wardPolicies.find((p) => p.wardId === w.id);
              const monday = config.requirements.filter(
                (r) => r.wardId === w.id && r.weekday === 1 && r.minimum > 0,
              );
              const byShift = config.shifts
                .map((s) => {
                  const n = monday.find((r) => r.shift === s.code && r.category === "nurse");
                  const a = monday.find((r) => r.shift === s.code && r.category === "na");
                  if (!n && !a) return null;
                  return `${s.name.toLowerCase()} ${[
                    n ? `${n.minimum} nurse${n.minimum === 1 ? "" : "s"}` : null,
                    a ? `${a.minimum} assistant${a.minimum === 1 ? "" : "s"}` : null,
                  ]
                    .filter(Boolean)
                    .join(" + ")}`;
                })
                .filter(Boolean) as string[];
              return (
                <li key={w.id}>
                  <strong>{w.name}</strong>
                  {": "}
                  {!policy
                    ? "no ward patterns set"
                    : policy.fixedWeeklyPatternId
                      ? `whole ward works ${pattern(policy.fixedWeeklyPatternId)}`
                      : `nurses ${pattern(policy.patternId)}, assistants ${pattern(policy.naPatternId)}`}
                  {byShift.length ? `; needs ${list(byShift)} (Monday)` : "; no minimum staffing"}.
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No wards in this facility yet.</p>
        )}
      </div>
    </div>
  );
}
