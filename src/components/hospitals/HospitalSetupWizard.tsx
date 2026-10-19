import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApiError, api } from "@/lib/api";
import { useAuth, type AppRole } from "@/lib/auth-context";
import { DEFAULT_CAPABILITIES } from "@/lib/capability-definitions";
import { NAV_DEFINITIONS, getEffectiveRoles } from "@/lib/menu-permissions";

// Every setting a hospital runs on is entered here. Nothing is copied from
// another hospital and no field is pre-filled; the server validates the same.
const LEAVE_TYPES = [
  "Sick",
  "Annual",
  "Emergency",
  "Maternity",
  "Public Holiday",
  "Study Leave",
  "Compassionate Leave",
  "Leave of Absence",
];
const ENTITLEMENTS: { type: string; period: string }[] = [
  { type: "Annual", period: "days per leave year" },
  { type: "Study Leave", period: "days per leave year" },
  { type: "Compassionate Leave", period: "days per leave year" },
  { type: "Maternity", period: "days per leave year" },
  { type: "Sick", period: "days per month" },
];
const DEADLINES: { key: string; label: string }[] = [
  { key: "leave_closure_days", label: "Leave requests close (days before period)" },
  { key: "generate_days", label: "Draft rota auto-generated (days before)" },
  { key: "edit_close_days", label: "Editing closes / auto-submit (days before)" },
  { key: "publish_deadline_days", label: "Auto-publish (days before)" },
  { key: "revert_grace_days", label: "Grace after a revert to draft (days)" },
];
const JOBS: { key: string; label: string }[] = [
  { key: "auto_generate", label: "Automatically generate draft rotas" },
  { key: "auto_submit", label: "Automatically submit drafts at the edit deadline" },
  { key: "auto_publish", label: "Automatically publish approved rotas" },
];
const STEPS = [
  "Hospital",
  "Sites & GPS",
  "Security",
  "Leave",
  "Rota lifecycle",
  "Reminders",
  "Roles",
  "Permissions",
  "Review",
];
// Roles a new hospital starts with (Matron is the Chief Matron role); each can be removed.
const DEFAULT_HOSPITAL_ROLES = ["nurse", "chief_matron", "nursing_assistant", "porter"];
const ROLE_KEY = /^[a-z][a-z0-9_]{1,49}$/;
type CatalogRole = {
  key: string;
  label: string;
  description: string;
  is_system: boolean;
  hospital_name: string | null;
};
type NewRole = { key: string; label: string; description: string };

type Location = { label: string; lat: string; lng: string };
type Site = { name: string; locations: Location[] };
type Created = {
  id: string;
  name: string;
  administrator: { email: string };
  temporary_password: string;
};

const input = "h-9 w-full rounded-md border bg-background px-3 text-sm";
const blankLocation = (): Location => ({ label: "", lat: "", lng: "" });
const whole = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v) : NaN);
const inRange = (v: string, min: number, max: number) => {
  const n = whole(v);
  return Number.isInteger(n) && n >= min && n <= max;
};
const coordinate = (v: string, limit: number) => {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) && Math.abs(n) <= limit;
};

function NumberField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  min: number;
  max: number;
}) {
  const invalid = value !== "" && !inRange(value, min, max);
  return (
    <label className="grid gap-1 text-sm">
      <span>{label}</span>
      <input
        className={`${input} ${invalid ? "border-destructive" : ""}`}
        inputMode="numeric"
        value={value}
        placeholder={`${min}–${max}`}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      {invalid && (
        <span className="text-xs text-destructive">
          Enter a whole number from {min} to {max}
        </span>
      )}
    </label>
  );
}

function RoleGrid({
  rows,
  roles,
  value,
  onToggle,
  label,
}: {
  rows: { key: string; label: string }[];
  roles: { key: string; label: string }[];
  value: Record<string, string[]>;
  onToggle: (row: string, role: string) => void;
  label: string;
}) {
  return (
    <div className="max-h-96 overflow-auto rounded-md border">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b text-left text-muted-foreground">
            <th className="p-2 font-medium">{label}</th>
            {roles.map((r) => (
              <th key={r.key} className="p-2 text-center font-medium">
                {r.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b last:border-0">
              <td className="p-2">{row.label}</td>
              {roles.map((r) => (
                <td key={r.key} className="p-2 text-center">
                  <input
                    type="checkbox"
                    aria-label={`${r.label}: ${row.label}`}
                    checked={value[row.key]?.includes(r.key) ?? false}
                    onChange={() => onToggle(row.key, r.key)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function HospitalSetupWizard({
  onCreated,
  onCancel,
}: {
  onCreated: (hospital: Created) => void;
  onCancel: () => void;
}) {
  const { roleLabel } = useAuth();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [serverErrors, setServerErrors] = useState<{ path: string; message: string }[]>([]);

  const [name, setName] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [radius, setRadius] = useState("");
  const [sites, setSites] = useState<Site[]>([{ name: "", locations: [blankLocation()] }]);
  const [security, setSecurity] = useState({ min: "", expiry: "", idle: "" });
  const [leave, setLeave] = useState({ sickMax: "", notice: "" });
  const [grace, setGrace] = useState<string[]>([]);
  const [caps, setCaps] = useState<Record<string, string>>({});
  const [deadlines, setDeadlines] = useState<Record<string, string>>({});
  const [jobs, setJobs] = useState<Record<string, boolean | undefined>>({});
  const [reminders, setReminders] = useState({ missed: "", upcoming: "" });
  // Administrators always keep every permission and page; the grids set other roles.
  const [capabilities, setCapabilities] = useState<Record<string, string[]>>({});
  const [menu, setMenu] = useState<Record<string, string[]>>({});
  const [permissionsReviewed, setPermissionsReviewed] = useState(false);

  // Roles this hospital will use: chosen from the catalogue (built-in roles and
  // other hospitals' roles) or created for it. Administrator is always included.
  const catalog = useQuery({
    queryKey: ["hospital-role-catalog"],
    staleTime: Infinity,
    queryFn: () => api.get<{ roles: CatalogRole[] }>("/hospitals/role-catalog"),
  });
  const catalogRoles = useMemo(
    () => (catalog.data?.roles ?? []).filter((r) => r.key !== "admin"),
    [catalog.data],
  );
  const [enabledRoles, setEnabledRoles] = useState<string[] | null>(null);
  useEffect(() => {
    if (enabledRoles === null && catalog.data)
      setEnabledRoles(
        DEFAULT_HOSPITAL_ROLES.filter((key) => catalogRoles.some((r) => r.key === key)),
      );
  }, [catalog.data, catalogRoles, enabledRoles]);
  const [newRoles, setNewRoles] = useState<NewRole[]>([]);
  const [draftRole, setDraftRole] = useState<NewRole>({ key: "", label: "", description: "" });
  const roles = useMemo(
    () => [
      ...catalogRoles
        .filter((r) => (enabledRoles ?? []).includes(r.key))
        .map((r) => ({ key: r.key, label: r.label || roleLabel(r.key) })),
      ...newRoles.map((r) => ({ key: r.key, label: r.label })),
    ],
    [catalogRoles, enabledRoles, newRoles, roleLabel],
  );
  const roleKeys = useMemo(() => new Set(roles.map((r) => r.key)), [roles]);
  const draftRoleError = (() => {
    const key = draftRole.key.trim();
    if (!key && !draftRole.label.trim()) return null;
    if (!ROLE_KEY.test(key)) return "Key must be lowercase snake_case, 2–50 characters";
    if (
      key === "admin" ||
      catalogRoles.some((r) => r.key === key) ||
      newRoles.some((r) => r.key === key)
    )
      return "This role key is already in use";
    if (!draftRole.label.trim()) return "Enter a label";
    return null;
  })();
  // Permissions and menu access start as a copy of the current hospital's,
  // editable here; afterwards each hospital's are independent.
  const source = useQuery({
    queryKey: ["hospital-setup-permission-source"],
    staleTime: Infinity,
    queryFn: async () => {
      const [caps, menuAccess] = await Promise.all([
        api
          .get<{ value: { key: string; roles: string[] }[] }>("/portal-settings/capabilities")
          .catch(() => ({ value: [] })),
        api
          .get<{ value: Record<string, AppRole[]> }>("/portal-settings/menu_permissions")
          .catch(() => ({ value: {} })),
      ]);
      return { capabilities: caps.value ?? [], menu: menuAccess.value ?? {} };
    },
  });
  function copyCurrentPermissions() {
    if (!source.data) return;
    const keep = (list: readonly string[]) => list.filter((r) => roleKeys.has(r));
    setCapabilities(
      Object.fromEntries(
        DEFAULT_CAPABILITIES.map((c) => [
          c.key,
          keep(source.data.capabilities.find((saved) => saved.key === c.key)?.roles ?? c.roles),
        ]),
      ),
    );
    setMenu(
      Object.fromEntries(
        NAV_DEFINITIONS.map((d) => [d.key, keep(getEffectiveRoles(d.key, source.data.menu))]),
      ),
    );
    setPermissionsReviewed(false);
  }
  const [copied, setCopied] = useState(false);
  // Copy once the roles are chosen, on first reaching the Permissions step.
  useEffect(() => {
    if (!copied && step === 7 && source.data) {
      copyCurrentPermissions();
      setCopied(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copied, step, source.data]);
  const toggle =
    (setter: React.Dispatch<React.SetStateAction<Record<string, string[]>>>) =>
    (row: string, role: string) => {
      setPermissionsReviewed(false);
      setter((prev) => {
        const current = prev[row] ?? [];
        return {
          ...prev,
          [row]: current.includes(role) ? current.filter((r) => r !== role) : [...current, role],
        };
      });
    };

  const stepErrors = (index: number): string[] => {
    const errors: string[] = [];
    if (index === 0) {
      if (!name.trim()) errors.push("Enter the hospital name");
      if (!adminName.trim()) errors.push("Enter the administrator's full name");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail.trim()))
        errors.push("Enter the administrator's email address");
    }
    if (index === 1) {
      if (!inRange(radius, 50, 10000)) errors.push("Enter a fence radius from 50 to 10000 metres");
      const names = sites.map((s) => s.name.trim().toLowerCase());
      if (names.some((n) => !n)) errors.push("Name every site");
      if (new Set(names).size !== names.length) errors.push("Site names must be unique");
      for (const site of sites)
        for (const loc of site.locations)
          if (!loc.label.trim() || !coordinate(loc.lat, 90) || !coordinate(loc.lng, 180))
            errors.push(
              `Complete every location of ${site.name.trim() || "each site"} (label, latitude, longitude)`,
            );
    }
    if (index === 2) {
      if (!inRange(security.min, 4, 64)) errors.push("Minimum password length: 4–64");
      if (!inRange(security.expiry, 1, 365)) errors.push("Password expiry: 1–365 days");
      if (!inRange(security.idle, 5, 480)) errors.push("Idle sign-out: 5–480 minutes");
    }
    if (index === 3) {
      if (!inRange(leave.sickMax, 1, 90)) errors.push("Sick/Emergency maximum: 1–90 days");
      if (!inRange(leave.notice, 0, 720)) errors.push("Shift-switch notice: 0–720 hours");
      if (!grace.length) errors.push("Choose at least one grace leave type");
      for (const { type } of ENTITLEMENTS)
        if (!inRange(caps[type] ?? "", 0, 366)) errors.push(`${type} entitlement: 0–366 days`);
    }
    if (index === 4) {
      for (const d of DEADLINES)
        if (!inRange(deadlines[d.key] ?? "", 1, 90)) errors.push(`${d.label}: 1–90 days`);
      const n = (k: string) => whole(deadlines[k] ?? "");
      if (
        !(
          n("leave_closure_days") >= n("generate_days") &&
          n("generate_days") >= n("edit_close_days") &&
          n("edit_close_days") >= n("publish_deadline_days")
        )
      )
        errors.push("Keep the order: leave closure ≥ generate ≥ edit closes ≥ publish");
      for (const j of JOBS)
        if (jobs[j.key] === undefined) errors.push(`Choose on or off: ${j.label}`);
    }
    if (index === 5) {
      if (!inRange(reminders.missed, 1, 24)) errors.push("Missed-shift alert: 1–24 hours");
      if (!inRange(reminders.upcoming, 1, 120)) errors.push("Shift-start reminder: 1–120 minutes");
    }
    if (index === 6) {
      if (!roles.length) errors.push("Choose at least one role besides Administrator");
      if (draftRole.key.trim() || draftRole.label.trim())
        errors.push("Add or clear the new role you started");
    }
    if (index === 7 && !permissionsReviewed)
      errors.push("Review the permissions and menu access, then confirm");
    return errors;
  };
  const current = stepErrors(step);

  function payload() {
    const own = (list: string[] | undefined) => [
      "admin",
      ...(list ?? []).filter((r) => roleKeys.has(r)),
    ];
    return {
      name: name.trim(),
      roles: { enabled: enabledRoles ?? [], custom: newRoles },
      admin: { full_name: adminName.trim(), email: adminEmail.trim() },
      gps: {
        radius_m: whole(radius),
        sites: sites.map((s) => ({
          name: s.name.trim(),
          locations: s.locations.map((l) => ({
            label: l.label.trim(),
            lat: Number(l.lat),
            lng: Number(l.lng),
          })),
        })),
      },
      security: {
        min_password_length: whole(security.min),
        password_expiry_days: whole(security.expiry),
        idle_timeout_minutes: whole(security.idle),
      },
      leave: {
        sick_emergency_max_days: whole(leave.sickMax),
        shift_switch_min_notice_hours: whole(leave.notice),
        grace_leave_types: grace,
        entitlements: Object.fromEntries(ENTITLEMENTS.map(({ type }) => [type, whole(caps[type])])),
      },
      rota: {
        deadlines: Object.fromEntries(DEADLINES.map((d) => [d.key, whole(deadlines[d.key])])),
        jobs_paused: Object.fromEntries(JOBS.map((j) => [j.key, !jobs[j.key]])),
      },
      reminders: {
        missed_shift_hours: whole(reminders.missed),
        upcoming_shift_minutes: whole(reminders.upcoming),
      },
      permissions: {
        capabilities: DEFAULT_CAPABILITIES.map((c) => ({
          key: c.key,
          roles: own(capabilities[c.key]),
        })),
        menu_permissions: Object.fromEntries(NAV_DEFINITIONS.map((d) => [d.key, own(menu[d.key])])),
      },
    };
  }

  async function create() {
    setBusy(true);
    setServerErrors([]);
    try {
      const created = await api.post<Created>("/hospitals", payload());
      toast.success(`${created.name} created`);
      onCreated(created);
    } catch (e) {
      if (e instanceof ApiError && Array.isArray(e.data.errors))
        setServerErrors(e.data.errors as { path: string; message: string }[]);
      toast.error(e instanceof Error ? e.message : "Could not create the hospital");
    } finally {
      setBusy(false);
    }
  }

  const updateSite = (i: number, next: Site) =>
    setSites((prev) => prev.map((s, j) => (j === i ? next : s)));

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Set up a new hospital</h2>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
      <ol className="flex flex-wrap gap-1 text-xs">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className={`rounded-full px-2.5 py-1 ${
              i === step
                ? "bg-primary text-primary-foreground"
                : i < step
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted-foreground"
            }`}
          >
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm sm:col-span-2">
            Hospital name
            <input
              className={input}
              value={name}
              maxLength={160}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <p className="text-sm text-muted-foreground sm:col-span-2">
            The hospital's first administrator receives an account with a temporary password and
            sets up its wards, staff and scheduling.
          </p>
          <label className="grid gap-1 text-sm">
            Administrator full name
            <input
              className={input}
              value={adminName}
              maxLength={120}
              onChange={(e) => setAdminName(e.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            Administrator email
            <input
              className={input}
              type="email"
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
            />
          </label>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Add each site (facility) of this hospital and where it is. Staff can only start a shift
            within the fence radius of their own site.
          </p>
          <div className="max-w-xs">
            <NumberField
              label="Fence radius (metres)"
              value={radius}
              onChange={setRadius}
              min={50}
              max={10000}
            />
          </div>
          {sites.map((site, i) => (
            <div key={i} className="space-y-2 rounded-md border p-3">
              <div className="flex items-end gap-2">
                <label className="grid flex-1 gap-1 text-sm">
                  Site name
                  <input
                    className={input}
                    value={site.name}
                    maxLength={80}
                    onChange={(e) => updateSite(i, { ...site, name: e.target.value })}
                  />
                </label>
                {sites.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove site ${site.name || i + 1}`}
                    onClick={() => setSites((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
              {site.locations.map((loc, k) => (
                <div key={k} className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end">
                  {(
                    [
                      ["label", "Address or label"],
                      ["lat", "Latitude"],
                      ["lng", "Longitude"],
                    ] as const
                  ).map(([field, label]) => (
                    <label key={field} className="grid gap-1 text-xs">
                      {label}
                      <input
                        className={input}
                        inputMode={field === "label" ? "text" : "decimal"}
                        value={loc[field]}
                        onChange={(e) =>
                          updateSite(i, {
                            ...site,
                            locations: site.locations.map((l, m) =>
                              m === k ? { ...l, [field]: e.target.value } : l,
                            ),
                          })
                        }
                      />
                    </label>
                  ))}
                  {site.locations.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Remove location"
                      onClick={() =>
                        updateSite(i, {
                          ...site,
                          locations: site.locations.filter((_, m) => m !== k),
                        })
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  updateSite(i, { ...site, locations: [...site.locations, blankLocation()] })
                }
              >
                <Plus className="mr-1 h-4 w-4" /> Add another location for this site
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            onClick={() =>
              setSites((prev) => [...prev, { name: "", locations: [blankLocation()] }])
            }
          >
            <Plus className="mr-1 h-4 w-4" /> Add site
          </Button>
        </div>
      )}

      {step === 2 && (
        <div className="grid gap-3 sm:grid-cols-3">
          <NumberField
            label="Minimum password length"
            value={security.min}
            min={4}
            max={64}
            onChange={(v) => setSecurity({ ...security, min: v })}
          />
          <NumberField
            label="Password expires after (days)"
            value={security.expiry}
            min={1}
            max={365}
            onChange={(v) => setSecurity({ ...security, expiry: v })}
          />
          <NumberField
            label="Sign out after inactivity (minutes)"
            value={security.idle}
            min={5}
            max={480}
            onChange={(v) => setSecurity({ ...security, idle: v })}
          />
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField
              label="Longest Sick/Emergency request (days)"
              value={leave.sickMax}
              min={1}
              max={90}
              onChange={(v) => setLeave({ ...leave, sickMax: v })}
            />
            <NumberField
              label="Minimum notice for a shift switch (hours)"
              value={leave.notice}
              min={0}
              max={720}
              onChange={(v) => setLeave({ ...leave, notice: v })}
            />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm">
              Leave types allowed one grace day before auto-decline (filed same day or after the
              fact)
            </legend>
            <div className="flex flex-wrap gap-3 text-sm">
              {LEAVE_TYPES.map((t) => (
                <label key={t} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={grace.includes(t)}
                    onChange={() =>
                      setGrace((prev) =>
                        prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
                      )
                    }
                  />
                  {t}
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <p className="mb-2 text-sm">
              Default leave entitlements (role and individual overrides can be set later)
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              {ENTITLEMENTS.map(({ type, period }) => (
                <NumberField
                  key={type}
                  label={type}
                  hint={period}
                  value={caps[type] ?? ""}
                  min={0}
                  max={366}
                  onChange={(v) => setCaps({ ...caps, [type]: v })}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Rota periods are 28 days. Deadlines count back from the next period's start.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {DEADLINES.map((d) => (
              <NumberField
                key={d.key}
                label={d.label}
                value={deadlines[d.key] ?? ""}
                min={1}
                max={90}
                onChange={(v) => setDeadlines({ ...deadlines, [d.key]: v })}
              />
            ))}
          </div>
          <fieldset className="space-y-2">
            {JOBS.map((j) => (
              <div key={j.key} className="flex flex-wrap items-center gap-3 text-sm">
                <span className="min-w-72">{j.label}</span>
                {([true, false] as const).map((on) => (
                  <label key={String(on)} className="flex items-center gap-1">
                    <input
                      type="radio"
                      name={j.key}
                      checked={jobs[j.key] === on}
                      onChange={() => setJobs({ ...jobs, [j.key]: on })}
                    />
                    {on ? "On" : "Off"}
                  </label>
                ))}
              </div>
            ))}
          </fieldset>
        </div>
      )}

      {step === 5 && (
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField
            label="Alert managers when a shift is missed by (hours)"
            value={reminders.missed}
            min={1}
            max={24}
            onChange={(v) => setReminders({ ...reminders, missed: v })}
          />
          <NumberField
            label="Remind staff before a shift starts (minutes)"
            value={reminders.upcoming}
            min={1}
            max={120}
            onChange={(v) => setReminders({ ...reminders, upcoming: v })}
          />
        </div>
      )}

      {step === 6 && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Choose the roles this hospital uses. Administrator is always included. Nurse, Matron,
            Nursing Assistant and Porter are suggested; untick any the hospital does not need.
          </p>
          {catalog.isPending ? (
            <p className="text-sm text-muted-foreground">Loading roles…</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {catalogRoles.map((r) => (
                <label key={r.key} className="flex items-start gap-2 rounded-md border p-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={(enabledRoles ?? []).includes(r.key)}
                    onChange={() => {
                      setPermissionsReviewed(false);
                      setEnabledRoles((prev) =>
                        (prev ?? []).includes(r.key)
                          ? (prev ?? []).filter((k) => k !== r.key)
                          : [...(prev ?? []), r.key],
                      );
                    }}
                  />
                  <span>
                    <span className="font-medium">{r.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {r.is_system
                        ? "Built-in role"
                        : `Created by ${r.hospital_name ?? "another hospital"}`}
                      {r.description ? ` · ${r.description}` : ""}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
          {newRoles.length > 0 && (
            <ul className="space-y-1 text-sm">
              {newRoles.map((r) => (
                <li
                  key={r.key}
                  className="flex items-center justify-between gap-2 rounded-md border p-2"
                >
                  <span>
                    <span className="font-medium">{r.label}</span>{" "}
                    <span className="text-xs text-muted-foreground">
                      ({r.key}) · new role for this hospital
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove new role ${r.label}`}
                    onClick={() => setNewRoles((prev) => prev.filter((x) => x.key !== r.key))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <fieldset className="space-y-2 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">Create a role for this hospital</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="grid gap-1 text-xs">
                Key
                <input
                  className={input}
                  placeholder="e.g. ward_clerk"
                  value={draftRole.key}
                  onChange={(e) => setDraftRole({ ...draftRole, key: e.target.value })}
                />
              </label>
              <label className="grid gap-1 text-xs">
                Label
                <input
                  className={input}
                  placeholder="e.g. Ward Clerk"
                  value={draftRole.label}
                  maxLength={80}
                  onChange={(e) => setDraftRole({ ...draftRole, label: e.target.value })}
                />
              </label>
              <label className="grid gap-1 text-xs">
                Description (optional)
                <input
                  className={input}
                  value={draftRole.description}
                  maxLength={300}
                  onChange={(e) => setDraftRole({ ...draftRole, description: e.target.value })}
                />
              </label>
            </div>
            {draftRoleError && <p className="text-xs text-destructive">{draftRoleError}</p>}
            <Button
              variant="outline"
              size="sm"
              disabled={!draftRole.key.trim() || !!draftRoleError}
              onClick={() => {
                setNewRoles((prev) => [
                  ...prev,
                  {
                    key: draftRole.key.trim(),
                    label: draftRole.label.trim(),
                    description: draftRole.description.trim(),
                  },
                ]);
                setDraftRole({ key: "", label: "", description: "" });
                setPermissionsReviewed(false);
              }}
            >
              <Plus className="mr-1 h-4 w-4" /> Add role
            </Button>
          </fieldset>
        </div>
      )}

      {step === 7 && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            These start as a copy of the current hospital's permissions and menu access. Changes
            here apply only to the new hospital, and afterwards each hospital manages its own.
            Administrators always have full access.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={!source.data}
            onClick={copyCurrentPermissions}
          >
            Reset to the current hospital's settings
          </Button>
          <RoleGrid
            label="Permission"
            rows={DEFAULT_CAPABILITIES}
            roles={roles}
            value={capabilities}
            onToggle={toggle(setCapabilities)}
          />
          <RoleGrid
            label="Menu page"
            rows={NAV_DEFINITIONS}
            roles={roles}
            value={menu}
            onToggle={toggle(setMenu)}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={permissionsReviewed}
              onChange={(e) => setPermissionsReviewed(e.target.checked)}
            />
            I have reviewed this hospital's permissions and menu access
          </label>
        </div>
      )}

      {step === 8 && (
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {[
            ["Hospital", name],
            ["Roles", ["Administrator", ...roles.map((r) => r.label)].join(", ")],
            ["Administrator", `${adminName} (${adminEmail})`],
            [
              "Sites",
              sites
                .map(
                  (s) =>
                    `${s.name} (${s.locations.length} location${s.locations.length === 1 ? "" : "s"})`,
                )
                .join(", "),
            ],
            ["Fence radius", `${radius} m`],
            ["Password", `${security.min}+ characters, expires after ${security.expiry} days`],
            ["Idle sign-out", `${security.idle} minutes`],
            ["Sick/Emergency maximum", `${leave.sickMax} days`],
            ["Shift-switch notice", `${leave.notice} hours`],
            ["Grace leave types", grace.join(", ")],
            ["Entitlements", ENTITLEMENTS.map(({ type }) => `${type} ${caps[type]}`).join(", ")],
            [
              "Rota deadlines",
              DEADLINES.slice(0, 4)
                .map((d) => `T-${deadlines[d.key]}`)
                .join(" / ") + `, revert grace ${deadlines.revert_grace_days} days`,
            ],
            [
              "Automatic jobs",
              JOBS.map(
                (j) => `${j.label.replace("Automatically ", "")}: ${jobs[j.key] ? "on" : "off"}`,
              ).join("; "),
            ],
            [
              "Reminders",
              `missed after ${reminders.missed} h, start reminder ${reminders.upcoming} min`,
            ],
            [
              "Permissions",
              `${DEFAULT_CAPABILITIES.filter((c) => capabilities[c.key]?.length).length} of ${DEFAULT_CAPABILITIES.length} granted beyond administrators`,
            ],
          ].map(([term, detail]) => (
            <div key={term}>
              <dt className="text-xs text-muted-foreground">{term}</dt>
              <dd>{detail}</dd>
            </div>
          ))}
        </dl>
      )}

      {(step < 8 ? current : serverErrors.map((e) => `${e.path}: ${e.message}`)).length > 0 && (
        <ul role="alert" className="list-disc space-y-0.5 pl-5 text-sm text-destructive">
          {[
            ...new Set(step < 8 ? current : serverErrors.map((e) => `${e.path}: ${e.message}`)),
          ].map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      <div className="flex justify-between gap-2">
        <Button variant="outline" disabled={step === 0 || busy} onClick={() => setStep(step - 1)}>
          Back
        </Button>
        {step < STEPS.length - 1 ? (
          <Button disabled={current.length > 0} onClick={() => setStep(step + 1)}>
            Next
          </Button>
        ) : (
          <Button
            disabled={busy || STEPS.slice(0, -1).some((_, i) => stepErrors(i).length > 0)}
            onClick={() => void create()}
          >
            Create hospital
          </Button>
        )}
      </div>
    </section>
  );
}
