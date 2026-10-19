import { Button } from "@/components/ui/button";
import type { CoverageRule, SchedulingConfiguration } from "@/lib/scheduling-configuration";

const input = "w-full rounded-md border bg-background px-3 py-2 text-sm";
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
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Set fixed coverage rotations across facility staff. For weekend coverage, choose a Saturday
        first block, two duty days and repeat every seven days. For continuous night coverage, make
        the duty block and repeat interval equal.
      </p>
      <p className="rounded-md border p-3 text-sm">
        Eligible roles must use facility scope and configured patterns in Staff roles. Coverage
        replaces the base duty and reserves OFF days before and after. The base pattern continues by
        calendar position. Staff rotate in stable ID order; leave keeps its slot and produces a gap.
        Conflicts require review. These rules apply only to previews.
      </p>
      {rules.map((rule) => (
        <section key={rule.id} className="space-y-4 rounded-xl border bg-card p-5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-semibold">{rule.name}</h3>
            <Button
              variant="ghost"
              onClick={() =>
                onChange({ ...config, coverageRules: rules.filter((r) => r.id !== rule.id) })
              }
            >
              Remove coverage rule
            </Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label className="grid gap-1 text-sm">
              Rule name
              <input
                className={input}
                value={rule.name}
                onChange={(e) => update(rule.id, { name: e.target.value })}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Coverage shift
              <select
                className={input}
                value={rule.shift}
                onChange={(e) => update(rule.id, { shift: e.target.value })}
              >
                {config.shifts.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name} ({s.code})
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              First block date
              <input
                className={input}
                type="date"
                value={rule.anchorDate}
                onChange={(e) => update(rule.id, { anchorDate: e.target.value })}
              />
            </label>
            {(
              [
                ["blockDays", "Duty days", 1, 28],
                ["repeatDays", "Repeat every (days)", 1, 56],
                ["staffPerBlock", "Staff per block", 1, 100],
                ["restBefore", "OFF days before", 0, 28],
                ["restAfter", "OFF days after", 0, 28],
              ] as const
            ).map(([key, label, min, max]) => (
              <label key={key} className="grid gap-1 text-sm">
                {label}
                <input
                  className={input}
                  type="number"
                  min={min}
                  max={max}
                  value={rule[key]}
                  onChange={(e) => update(rule.id, { [key]: Number(e.target.value) })}
                />
              </label>
            ))}
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Eligible roles</legend>
            {!eligible.length && (
              <p className="text-sm text-amber-800">
                Set a role to facility scope and configured patterns first.
              </p>
            )}
            {eligible.map((role) => (
              <label className="flex items-center gap-2 text-sm" key={role.id}>
                <input
                  type="checkbox"
                  checked={rule.roleIds.includes(role.id)}
                  onChange={(e) =>
                    update(rule.id, {
                      roleIds: e.target.checked
                        ? [...rule.roleIds, role.id]
                        : rule.roleIds.filter((id) => id !== role.id),
                    })
                  }
                />
                {role.name}
                {!role.allowedShifts.includes(rule.shift) && " — allow this shift in Staff roles"}
              </label>
            ))}
            {rule.roleIds.some((id) => !eligible.some((r) => r.id === id)) && (
              <p className="text-sm text-amber-800">
                A selected role is no longer eligible. Restore its settings or remove this rule.
              </p>
            )}
          </fieldset>
        </section>
      ))}
      <Button
        disabled={rules.length >= 32 || !config.shifts.length}
        onClick={() =>
          onChange({
            ...config,
            coverageRules: [
              ...rules,
              {
                id: `coverage_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
                name: "New coverage rule",
                shift: config.shifts.find((s) => s.code === "MWC")?.code ?? config.shifts[0].code,
                roleIds: [],
                anchorDate: "",
                blockDays: 2,
                repeatDays: 7,
                staffPerBlock: 1,
                restBefore: 1,
                restAfter: 1,
              },
            ],
          })
        }
      >
        Add coverage rule
      </Button>
    </div>
  );
}
