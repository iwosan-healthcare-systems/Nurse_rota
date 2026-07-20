import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { useAuth, ROLE_LABELS, type AppRole } from "@/lib/auth-context";
import {
  NAV_DEFINITIONS,
  ADMIN_LOCKED_KEYS,
  loadMenuPermissions,
  saveMenuPermissions,
  getEffectiveRoles,
} from "@/lib/menu-permissions";
import {
  FACILITY_LOCATIONS,
  GEO_FENCE_RADIUS_M,
  type FacilityLocation,
  type GpsSettings,
} from "@/lib/geo-fence";
import { api } from "@/lib/api";
import { Check, X, Pencil, RotateCcw, ShieldAlert, Lock, MapPin, Plus, Trash2, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/menu-permissions")({
  head: () => ({
    meta: [
      { title: "Menu Access — Nurses Rota" },
      {
        name: "description",
        content: "Control which sidebar menu items each role can see.",
      },
    ],
  }),
  component: MenuPermissionsPage,
});

const ROLES: AppRole[] = [
  "admin",
  "cno",
  "chief_matron",
  "head_nurse",
  "hr_admin",
  "nurse",
  "surgical_nurse",
  "porter",
  "nursing_assistant",
];

function MenuPermissionsPage() {
  const navigate = useNavigate();
  const { isAdmin, loading } = useAuth();

  const [overrides, setOverrides] = useState<Record<string, AppRole[]>>(loadMenuPermissions);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, AppRole[]>>({});
  const [saving, setSaving] = useState(false);

  // GPS fence settings
  const defaultGps: GpsSettings = {
    radius_m: GEO_FENCE_RADIUS_M,
    facilities: Object.fromEntries(
      Object.entries(FACILITY_LOCATIONS).map(([k, locs]) => [k, locs.map((l) => ({ ...l }))]),
    ),
  };
  const [gpsSettings, setGpsSettings] = useState<GpsSettings>(defaultGps);
  const [gpsEditing, setGpsEditing] = useState(false);
  const [gpsDraft, setGpsDraft] = useState<GpsSettings | null>(null);
  const [gpsSaving, setGpsSaving] = useState(false);
  const [newFacilityName, setNewFacilityName] = useState("");

  // Password expiry settings
  const [pwExpiryDays, setPwExpiryDays] = useState(30);
  const [pwExpiryEditing, setPwExpiryEditing] = useState(false);
  const [pwExpiryDraft, setPwExpiryDraft] = useState(30);
  const [pwExpirySaving, setPwExpirySaving] = useState(false);

  useEffect(() => {
    if (!loading && !isAdmin) navigate({ to: "/" });
  }, [loading, isAdmin, navigate]);

  // Load the authoritative value from DB on mount
  useEffect(() => {
    api
      .get<{ key: string; value: Record<string, AppRole[]> }>("/portal-settings/menu_permissions")
      .then(({ value }) => {
        if (value) setOverrides(value);
      })
      .catch(() => {});
    api
      .get<{ value: GpsSettings }>("/portal-settings/gps_settings")
      .then(({ value }) => {
        if (value) setGpsSettings(value);
      })
      .catch(() => {});
    api
      .get<{ value: number }>("/portal-settings/password_expiry_days")
      .then(({ value }) => {
        if (typeof value === "number") setPwExpiryDays(value);
      })
      .catch(() => {});
  }, []);

  function startEdit() {
    // Snapshot the full effective state (defaults + overrides) into draft
    const snapshot: Record<string, AppRole[]> = {};
    for (const def of NAV_DEFINITIONS) {
      snapshot[def.key] = [...getEffectiveRoles(def.key, overrides)];
    }
    setDraft(snapshot);
    setEditing(true);
  }

  function cancelEdit() {
    setDraft({});
    setEditing(false);
  }

  async function saveEdit() {
    const toStore: Record<string, AppRole[]> = {};
    for (const def of NAV_DEFINITIONS) {
      let roles = draft[def.key] ?? def.defaultRoles;
      if (!roles.includes("admin")) roles = ["admin", ...roles];
      const defaultSorted = [...def.defaultRoles].sort().join(",");
      const draftSorted = [...roles].sort().join(",");
      if (defaultSorted !== draftSorted) toStore[def.key] = roles;
    }
    setSaving(true);
    try {
      await api.put("/portal-settings/menu_permissions", { value: toStore });
      saveMenuPermissions(toStore);
      setOverrides(toStore);
      setEditing(false);
      toast.success("Menu permissions saved");
    } catch (e) {
      toast.error("Failed to save: " + (e instanceof Error ? e.message : "Unknown error"));
    } finally {
      setSaving(false);
    }
  }

  async function resetDefaults() {
    if (!confirm("Reset menu visibility to system defaults for all roles?")) return;
    setSaving(true);
    try {
      await api.put("/portal-settings/menu_permissions", { value: {} });
      saveMenuPermissions({});
      setOverrides({});
      setDraft({});
      setEditing(false);
      toast.success("Menu permissions reset to defaults");
    } catch (e) {
      toast.error("Failed to reset: " + (e instanceof Error ? e.message : "Unknown error"));
    } finally {
      setSaving(false);
    }
  }

  function toggleRole(navKey: string, role: AppRole) {
    // Admin always has access to every page — never allow unchecking admin.
    if (role === "admin") return;
    setDraft((prev) => {
      const current = prev[navKey] ?? getEffectiveRoles(navKey, overrides);
      const has = current.includes(role);
      return {
        ...prev,
        [navKey]: has ? current.filter((r) => r !== role) : [...current, role],
      };
    });
  }

  // ── GPS helpers ──────────────────────────────────────────────────────────────

  function startGpsEdit() {
    setGpsDraft(structuredClone(gpsSettings));
    setGpsEditing(true);
  }

  function cancelGpsEdit() {
    setGpsDraft(null);
    setGpsEditing(false);
    setNewFacilityName("");
  }

  async function saveGpsSettings() {
    if (!gpsDraft) return;
    setGpsSaving(true);
    try {
      await api.put("/portal-settings/gps_settings", { value: gpsDraft });
      setGpsSettings(gpsDraft);
      setGpsEditing(false);
      setGpsDraft(null);
      setNewFacilityName("");
      toast.success("GPS settings saved");
    } catch (e) {
      toast.error("Failed to save: " + (e instanceof Error ? e.message : "Unknown error"));
    } finally {
      setGpsSaving(false);
    }
  }

  async function savePwExpiry() {
    if (pwExpiryDraft < 1 || pwExpiryDraft > 365) {
      toast.error("Expiry must be between 1 and 365 days");
      return;
    }
    setPwExpirySaving(true);
    try {
      await api.put("/portal-settings/password_expiry_days", { value: pwExpiryDraft });
      setPwExpiryDays(pwExpiryDraft);
      setPwExpiryEditing(false);
      toast.success("Password expiry updated");
    } catch (e) {
      toast.error("Failed to save: " + (e instanceof Error ? e.message : "Unknown error"));
    } finally {
      setPwExpirySaving(false);
    }
  }

  function updateGpsRadius(val: number) {
    setGpsDraft((d) => (d ? { ...d, radius_m: val } : d));
  }

  function updateGpsLocation(
    facility: string,
    idx: number,
    field: keyof FacilityLocation,
    val: string,
  ) {
    setGpsDraft((d) => {
      if (!d) return d;
      const locs = [...(d.facilities[facility] ?? [])];
      locs[idx] = { ...locs[idx], [field]: field === "label" ? val : parseFloat(val) || 0 };
      return { ...d, facilities: { ...d.facilities, [facility]: locs } };
    });
  }

  function addGpsLocation(facility: string) {
    setGpsDraft((d) => {
      if (!d) return d;
      const locs = [
        ...(d.facilities[facility] ?? []),
        { lat: 0, lng: 0, label: `${facility} — New campus` },
      ];
      return { ...d, facilities: { ...d.facilities, [facility]: locs } };
    });
  }

  function removeGpsLocation(facility: string, idx: number) {
    setGpsDraft((d) => {
      if (!d) return d;
      const locs = (d.facilities[facility] ?? []).filter((_, i) => i !== idx);
      const facs = { ...d.facilities };
      if (!locs.length) delete facs[facility];
      else facs[facility] = locs;
      return { ...d, facilities: facs };
    });
  }

  function addGpsFacility() {
    const name = newFacilityName.trim();
    if (!name) return;
    if (gpsDraft?.facilities[name]) {
      toast.error(`Facility "${name}" already exists`);
      return;
    }
    setGpsDraft((d) => {
      if (!d) return d;
      return {
        ...d,
        facilities: {
          ...d.facilities,
          [name]: [{ lat: 0, lng: 0, label: `${name} — Main entrance` }],
        },
      };
    });
    setNewFacilityName("");
  }

  if (!isAdmin) {
    return (
      <div className="py-20 text-center">
        <ShieldAlert className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
        <p className="text-sm text-muted-foreground">Administrator access required.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Menu Access" subtitle="Control which sidebar items each role can see" />

      <section className="rounded-xl border bg-card overflow-hidden">
        {/* Section header */}
        <div className="px-5 py-4 border-b flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold">Menu visibility matrix</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              A checked cell means that role will see the page in the sidebar. Changes take effect
              immediately on next navigation.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {editing ? (
              <>
                <button
                  type="button"
                  onClick={cancelEdit}
                  disabled={saving}
                  className="h-8 px-3 rounded-md border bg-card text-xs hover:bg-muted disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveEdit}
                  disabled={saving}
                  className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save changes"}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={resetDefaults}
                  disabled={saving}
                  title="Reset to defaults"
                  className="h-8 w-8 grid place-items-center rounded-md border bg-card hover:bg-muted text-muted-foreground disabled:opacity-50"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={startEdit}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border bg-card text-xs hover:bg-muted"
                >
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </button>
              </>
            )}
          </div>
        </div>

        {/* Matrix table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Page</th>
                {ROLES.map((r) => (
                  <th key={r} className="px-3 py-3 font-medium text-center whitespace-nowrap">
                    {ROLE_LABELS[r]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {NAV_DEFINITIONS.map((def) => {
                const isLocked = ADMIN_LOCKED_KEYS.has(def.key);
                const effectiveRoles = editing
                  ? (draft[def.key] ?? getEffectiveRoles(def.key, overrides))
                  : getEffectiveRoles(def.key, overrides);

                return (
                  <tr key={def.key} className="border-t">
                    <td className="px-4 py-2.5">
                      <span className="font-medium">{def.label}</span>
                      {isLocked && (
                        <span className="ml-2 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                          <Lock className="h-3 w-3" /> admin-locked
                        </span>
                      )}
                    </td>
                    {ROLES.map((role) => {
                      const checked = effectiveRoles.includes(role);
                      // Admin column is always locked on every row.
                      const cellLocked = role === "admin";

                      return (
                        <td key={role} className="px-3 py-2.5 text-center">
                          {editing ? (
                            <input
                              type="checkbox"
                              aria-label={`${def.label} — ${ROLE_LABELS[role]}`}
                              checked={checked}
                              disabled={cellLocked}
                              onChange={() => toggleRole(def.key, role)}
                              className={cn(
                                "h-4 w-4 accent-primary",
                                cellLocked ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                              )}
                            />
                          ) : checked ? (
                            <Check
                              className={cn(
                                "h-4 w-4 inline",
                                cellLocked ? "text-muted-foreground" : "text-emerald-600",
                              )}
                            />
                          ) : (
                            <X className="h-4 w-4 text-muted-foreground/40 inline" />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Footer note */}
        {editing ? (
          <p className="px-5 py-3 border-t text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/20">
            Editing mode — check or uncheck pages per role. The Admin column is always locked;
            admins see every page regardless of this matrix.
          </p>
        ) : (
          <p className="px-5 py-3 border-t text-xs text-muted-foreground">
            Hiding a page removes it from the sidebar for that role. Admins always see every page.
            Users who navigate directly to the URL will still be redirected if they lack the
            underlying capability.
          </p>
        )}
      </section>
      {/* GPS Fence Settings */}
      <section className="rounded-xl border bg-card overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold">GPS Fence Settings</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Set the clock-in radius and facility coordinates used when nurses start a shift.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {gpsEditing ? (
              <>
                <button
                  type="button"
                  onClick={cancelGpsEdit}
                  disabled={gpsSaving}
                  className="h-8 px-3 rounded-md border bg-card text-xs hover:bg-muted disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveGpsSettings}
                  disabled={gpsSaving}
                  className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
                >
                  {gpsSaving ? "Saving…" : "Save changes"}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={startGpsEdit}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border bg-card text-xs hover:bg-muted"
              >
                <Pencil className="h-3.5 w-3.5" /> Edit
              </button>
            )}
          </div>
        </div>

        {/* Radius row */}
        <div className="px-5 py-4 border-b flex items-center gap-4">
          <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium">Clock-in radius</p>
            <p className="text-xs text-muted-foreground">
              Nurses must be within this distance of their facility to start a shift.
            </p>
          </div>
          {gpsEditing ? (
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={50}
                max={10000}
                step={50}
                value={gpsDraft?.radius_m ?? 1000}
                onChange={(e) => updateGpsRadius(Number(e.target.value))}
                className="w-24 h-8 px-2 rounded-md border text-sm text-right focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <span className="text-xs text-muted-foreground">metres</span>
            </div>
          ) : (
            <span className="text-sm font-semibold tabular-nums">{gpsSettings.radius_m} m</span>
          )}
        </div>

        {/* Facility locations */}
        <div>
          {Object.entries(gpsEditing ? (gpsDraft?.facilities ?? {}) : gpsSettings.facilities).map(
            ([facility, locs]) => (
              <div key={facility} className="border-b last:border-b-0">
                <div className="px-5 py-2 bg-muted/30 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {facility}
                  </p>
                  {gpsEditing && (
                    <button
                      type="button"
                      onClick={() => addGpsLocation(facility)}
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      <Plus className="h-3 w-3" /> Add campus
                    </button>
                  )}
                </div>
                <div className="divide-y">
                  {locs.map((loc, idx) =>
                    gpsEditing ? (
                      <div key={idx} className="px-5 py-2.5 flex items-center gap-2">
                        <input
                          value={loc.label}
                          onChange={(e) =>
                            updateGpsLocation(facility, idx, "label", e.target.value)
                          }
                          placeholder="Label"
                          className="flex-1 h-7 px-2 rounded-md border text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                        <input
                          type="number"
                          step="0.000001"
                          value={loc.lat}
                          onChange={(e) => updateGpsLocation(facility, idx, "lat", e.target.value)}
                          placeholder="Latitude"
                          className="w-28 h-7 px-2 rounded-md border text-xs text-right font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                        <input
                          type="number"
                          step="0.000001"
                          value={loc.lng}
                          onChange={(e) => updateGpsLocation(facility, idx, "lng", e.target.value)}
                          placeholder="Longitude"
                          className="w-28 h-7 px-2 rounded-md border text-xs text-right font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                        <button
                          type="button"
                          onClick={() => removeGpsLocation(facility, idx)}
                          title="Remove this campus"
                          className="h-7 w-7 grid place-items-center rounded-md text-destructive hover:bg-destructive/10 transition"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <div key={idx} className="px-5 py-2.5 flex items-center gap-3">
                        <p className="flex-1 text-sm">{loc.label}</p>
                        <span className="text-xs text-muted-foreground font-mono">
                          {loc.lat.toFixed(6)}, {loc.lng.toFixed(6)}
                        </span>
                      </div>
                    ),
                  )}
                </div>
              </div>
            ),
          )}
        </div>

        {/* Add new facility (edit mode only) */}
        {gpsEditing && (
          <div className="px-5 py-3 border-t flex items-center gap-2">
            <input
              value={newFacilityName}
              onChange={(e) => setNewFacilityName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addGpsFacility()}
              placeholder="New facility name (must match nurse records)"
              className="flex-1 h-8 px-3 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              type="button"
              onClick={addGpsFacility}
              disabled={!newFacilityName.trim()}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border bg-card text-xs hover:bg-muted disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" /> Add facility
            </button>
          </div>
        )}

        <p className="px-5 py-3 border-t text-xs text-muted-foreground">
          Use Google Maps to find accurate coordinates — right-click any location and copy the
          lat/lng. Changes take effect immediately.
        </p>
      </section>

      {/* Password Security Settings */}
      <section className="rounded-xl border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold">Password Security</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Set how long non-admin users can keep the same password. Admins are exempt.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {pwExpiryEditing ? (
              <>
                <button
                  type="button"
                  onClick={() => setPwExpiryEditing(false)}
                  disabled={pwExpirySaving}
                  className="h-8 px-3 rounded-md border bg-card text-xs hover:bg-muted disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={savePwExpiry}
                  disabled={pwExpirySaving}
                  className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
                >
                  {pwExpirySaving ? "Saving…" : "Save changes"}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setPwExpiryDraft(pwExpiryDays);
                  setPwExpiryEditing(true);
                }}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border bg-card text-xs hover:bg-muted"
              >
                <Pencil className="h-3.5 w-3.5" /> Edit
              </button>
            )}
          </div>
        </div>

        <div className="px-5 py-4 flex items-center gap-4">
          <KeyRound className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium">Password expiry period</p>
            <p className="text-xs text-muted-foreground">
              Users are warned 5 days before expiry and must reset on or after the expiry date.
            </p>
          </div>
          {pwExpiryEditing ? (
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={365}
                step={1}
                value={pwExpiryDraft}
                onChange={(e) => setPwExpiryDraft(Number(e.target.value))}
                className="w-20 h-8 px-2 rounded-md border text-sm text-right focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <span className="text-xs text-muted-foreground">days</span>
            </div>
          ) : (
            <span className="text-sm font-semibold tabular-nums">{pwExpiryDays} days</span>
          )}
        </div>

        <p className="px-5 py-3 border-t text-xs text-muted-foreground">
          A warning banner appears from 5 days before expiry until 1 day before. On the expiry date,
          users must change their password before accessing the system.
        </p>
      </section>
    </div>
  );
}
