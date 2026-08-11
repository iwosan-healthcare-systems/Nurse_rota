import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { useAuth } from "@/lib/auth-context";
import {
  FACILITY_LOCATIONS,
  GEO_FENCE_RADIUS_M,
  type FacilityLocation,
  type GpsSettings,
} from "@/lib/geo-fence";
import { api } from "@/lib/api";
import { Pencil, ShieldAlert, MapPin, Plus, Trash2, KeyRound, Timer, CalendarClock } from "lucide-react";
import { toast } from "sonner";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { LeaveCapsSettings } from "@/components/settings/LeaveCapsSettings";
import { PermissionsSettings } from "@/components/settings/PermissionsSettings";
import { MenuAccessSettings } from "@/components/settings/MenuAccessSettings";
import { SystemRolesSettings } from "@/components/settings/SystemRolesSettings";

type RotaJobsPaused = {
  auto_generate: boolean;
  auto_submit: boolean;
  auto_publish: boolean;
};

const ROTA_JOB_LABELS: Record<keyof RotaJobsPaused, string> = {
  auto_generate: "Auto-Generate (T-19)",
  auto_submit: "Auto-Submit (T-17)",
  auto_publish: "Auto-Publish (T-14)",
};

const ROTA_JOB_DESCRIPTIONS: Record<keyof RotaJobsPaused, string> = {
  auto_generate:
    "Generates each unit's next draft rota 19 days before its period starts, so a head nurse doesn't have to click Generate.",
  auto_submit:
    "Force-submits any unit still sitting in draft 17 days before its period starts, and closes out any still-pending edit-access requests for it.",
  auto_publish:
    "Publishes any CNO-approved unit 14 days before its period starts, and alerts CNO/admin if a unit is still unapproved at that point.",
};

type RotaDeadlines = {
  leave_closure_days: number;
  generate_days: number;
  edit_close_days: number;
  publish_deadline_days: number;
};

const DEFAULT_ROTA_DEADLINES: RotaDeadlines = {
  leave_closure_days: 21,
  generate_days: 19,
  edit_close_days: 17,
  publish_deadline_days: 14,
};

const ROTA_DEADLINE_FIELDS: {
  key: keyof RotaDeadlines;
  label: string;
  description: string;
}[] = [
  {
    key: "leave_closure_days",
    label: "Leave closure",
    description: "Non-exempt leave requests are blocked from this many days before the next period starts.",
  },
  {
    key: "generate_days",
    label: "Auto-generate",
    description: "The draft rota is auto-generated this many days before the next period starts.",
  },
  {
    key: "edit_close_days",
    label: "Edit closes / auto-submit",
    description: "A draft still sitting unsubmitted is force-submitted, and edit-access grants close, this many days before the next period starts.",
  },
  {
    key: "publish_deadline_days",
    label: "Auto-publish",
    description: "An HR-approved rota is auto-published this many days before the next period starts.",
  },
];

export const Route = createFileRoute("/_app/system-settings")({
  head: () => ({
    meta: [
      { title: "System Settings — Nurses Rota" },
      {
        name: "description",
        content: "GPS fence, password security, permissions, and every other system-wide setting.",
      },
    ],
  }),
  component: SystemSettingsPage,
});

// The single admin-only home for every system-wide setting — GPS, password
// security, leave entitlement caps, permissions, menu access, and system
// roles all live here as tabs, with every future setting added the same
// way. No other role can reach this page (see AppShell's nav array and
// menu-permissions.ts's NAV_DEFINITIONS, which deliberately has no entry for
// "/system-settings" — its visibility is hardcoded to isAdmin below, not
// tag-assignable to any role the way ordinary pages are).
function SystemSettingsPage() {
  const navigate = useNavigate();
  const { isAdmin, loading } = useAuth();

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

  // Rota lifecycle cron job pause switches — read fresh by each job on every
  // tick (see nurse-api/lib/rota-job-pause.js), so this takes effect within
  // one 5-minute tick, no deploy needed either direction.
  const defaultRotaJobsPaused: RotaJobsPaused = {
    auto_generate: false,
    auto_submit: false,
    auto_publish: false,
  };
  const [rotaJobsPaused, setRotaJobsPaused] = useState<RotaJobsPaused>(defaultRotaJobsPaused);
  const [rotaJobSaving, setRotaJobSaving] = useState<keyof RotaJobsPaused | null>(null);

  // Rota lifecycle deadlines (T-21/T-19/T-17/T-14) — single source of truth
  // shared by rpc.js's workflow-status, leave-requests.js's closure check,
  // and all three cron jobs (see nurse-api/lib/rota-deadline-settings.js).
  const [rotaDeadlines, setRotaDeadlines] = useState<RotaDeadlines>(DEFAULT_ROTA_DEADLINES);
  const [rotaDeadlinesEditing, setRotaDeadlinesEditing] = useState(false);
  const [rotaDeadlinesDraft, setRotaDeadlinesDraft] = useState<RotaDeadlines | null>(null);
  const [rotaDeadlinesSaving, setRotaDeadlinesSaving] = useState(false);

  // Sick/Emergency max leave span, and idle-session auto-logout.
  const [sickEmergencyMaxDays, setSickEmergencyMaxDays] = useState(3);
  const [sickEmergencyDraft, setSickEmergencyDraft] = useState(3);
  const [sickEmergencyEditing, setSickEmergencyEditing] = useState(false);
  const [sickEmergencySaving, setSickEmergencySaving] = useState(false);
  const [idleTimeoutMinutes, setIdleTimeoutMinutes] = useState(60);
  const [idleTimeoutDraft, setIdleTimeoutDraft] = useState(60);
  const [idleTimeoutEditing, setIdleTimeoutEditing] = useState(false);
  const [idleTimeoutSaving, setIdleTimeoutSaving] = useState(false);

  useEffect(() => {
    if (!loading && !isAdmin) navigate({ to: "/" });
  }, [loading, isAdmin, navigate]);

  useEffect(() => {
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
    api
      .get<{ value: Partial<RotaJobsPaused> }>("/portal-settings/rota_jobs_paused")
      .then(({ value }) => {
        if (value) setRotaJobsPaused((prev) => ({ ...prev, ...value }));
      })
      .catch(() => {
        /* no row saved yet — defaults (all unpaused) already in state */
      });
    api
      .get<{ value: Partial<RotaDeadlines> }>("/portal-settings/rota_deadlines")
      .then(({ value }) => {
        if (value) setRotaDeadlines((prev) => ({ ...prev, ...value }));
      })
      .catch(() => {
        /* no row saved yet — defaults already in state */
      });
    api
      .get<{ value: number }>("/portal-settings/sick_emergency_max_days")
      .then(({ value }) => {
        if (typeof value === "number" && value > 0) setSickEmergencyMaxDays(value);
      })
      .catch(() => {});
    api
      .get<{ value: number }>("/portal-settings/idle_timeout_minutes")
      .then(({ value }) => {
        if (typeof value === "number" && value > 0) setIdleTimeoutMinutes(value);
      })
      .catch(() => {});
  }, []);

  async function toggleRotaJob(job: keyof RotaJobsPaused, paused: boolean) {
    const next = { ...rotaJobsPaused, [job]: paused };
    setRotaJobSaving(job);
    try {
      await api.put("/portal-settings/rota_jobs_paused", { value: next });
      setRotaJobsPaused(next);
      toast.success(
        `${ROTA_JOB_LABELS[job]} ${paused ? "paused" : "resumed"}${paused ? "" : " — will catch up on anything overdue within 5 minutes"}`,
      );
    } catch (e) {
      toast.error("Failed to save: " + (e instanceof Error ? e.message : "Unknown error"));
    } finally {
      setRotaJobSaving(null);
    }
  }

  // Rota deadlines must stay in descending order — leave closure is furthest
  // out, publish deadline is nearest — or the lifecycle steps would fire out
  // of sequence (e.g. auto-generate running before leave has even closed).
  function rotaDeadlinesOrderError(d: RotaDeadlines): string | null {
    if (
      !Number.isInteger(d.leave_closure_days) ||
      !Number.isInteger(d.generate_days) ||
      !Number.isInteger(d.edit_close_days) ||
      !Number.isInteger(d.publish_deadline_days) ||
      d.publish_deadline_days < 1
    ) {
      return "All four values must be whole numbers, at least 1.";
    }
    if (
      !(
        d.leave_closure_days >= d.generate_days &&
        d.generate_days >= d.edit_close_days &&
        d.edit_close_days >= d.publish_deadline_days
      )
    ) {
      return "Values must stay in descending order: Leave closure ≥ Auto-generate ≥ Edit closes ≥ Auto-publish.";
    }
    return null;
  }

  async function saveRotaDeadlines() {
    if (!rotaDeadlinesDraft) return;
    const error = rotaDeadlinesOrderError(rotaDeadlinesDraft);
    if (error) {
      toast.error(error);
      return;
    }
    setRotaDeadlinesSaving(true);
    try {
      await api.put("/portal-settings/rota_deadlines", { value: rotaDeadlinesDraft });
      setRotaDeadlines(rotaDeadlinesDraft);
      setRotaDeadlinesEditing(false);
      setRotaDeadlinesDraft(null);
      toast.success("Rota deadlines saved");
    } catch (e) {
      toast.error("Failed to save: " + (e instanceof Error ? e.message : "Unknown error"));
    } finally {
      setRotaDeadlinesSaving(false);
    }
  }

  async function saveSickEmergencyMaxDays() {
    if (!Number.isInteger(sickEmergencyDraft) || sickEmergencyDraft < 1 || sickEmergencyDraft > 90) {
      toast.error("Must be a whole number between 1 and 90");
      return;
    }
    setSickEmergencySaving(true);
    try {
      await api.put("/portal-settings/sick_emergency_max_days", { value: sickEmergencyDraft });
      setSickEmergencyMaxDays(sickEmergencyDraft);
      setSickEmergencyEditing(false);
      toast.success("Sick/Emergency max span saved");
    } catch (e) {
      toast.error("Failed to save: " + (e instanceof Error ? e.message : "Unknown error"));
    } finally {
      setSickEmergencySaving(false);
    }
  }

  async function saveIdleTimeout() {
    if (!Number.isInteger(idleTimeoutDraft) || idleTimeoutDraft < 5 || idleTimeoutDraft > 480) {
      toast.error("Must be a whole number between 5 and 480 minutes");
      return;
    }
    setIdleTimeoutSaving(true);
    try {
      await api.put("/portal-settings/idle_timeout_minutes", { value: idleTimeoutDraft });
      setIdleTimeoutMinutes(idleTimeoutDraft);
      setIdleTimeoutEditing(false);
      toast.success("Idle session timeout saved");
    } catch (e) {
      toast.error("Failed to save: " + (e instanceof Error ? e.message : "Unknown error"));
    } finally {
      setIdleTimeoutSaving(false);
    }
  }

  // ── GPS helpers ──────────────────────────────────────────────────────────

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
      <PageHeader
        title="System Settings"
        subtitle="GPS fence, password security, permissions, and every other system-wide setting"
      />

      <Tabs defaultValue="gps">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="gps">GPS Fence</TabsTrigger>
          <TabsTrigger value="password">Password Security</TabsTrigger>
          <TabsTrigger value="leave-caps">Leave Entitlement Caps</TabsTrigger>
          <TabsTrigger value="permissions">Permissions</TabsTrigger>
          <TabsTrigger value="menu-access">Menu Access</TabsTrigger>
          <TabsTrigger value="roles">System Roles</TabsTrigger>
          <TabsTrigger value="rota-jobs">Rota Jobs</TabsTrigger>
          <TabsTrigger value="rota-deadlines">Rota Deadlines</TabsTrigger>
          <TabsTrigger value="leave-session">Leave &amp; Session Rules</TabsTrigger>
        </TabsList>

        <TabsContent value="gps">
          {/* GPS Fence Settings */}
          <section className="rounded-xl border bg-card overflow-hidden mt-4">
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

            <div>
              {Object.entries(
                gpsEditing ? (gpsDraft?.facilities ?? {}) : gpsSettings.facilities,
              ).map(([facility, locs]) => (
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
                            onChange={(e) =>
                              updateGpsLocation(facility, idx, "lat", e.target.value)
                            }
                            placeholder="Latitude"
                            className="w-28 h-7 px-2 rounded-md border text-xs text-right font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                          />
                          <input
                            type="number"
                            step="0.000001"
                            value={loc.lng}
                            onChange={(e) =>
                              updateGpsLocation(facility, idx, "lng", e.target.value)
                            }
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
              ))}
            </div>

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
        </TabsContent>

        <TabsContent value="password">
          {/* Password Security Settings */}
          <section className="rounded-xl border bg-card overflow-hidden mt-4">
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
              A warning banner appears from 5 days before expiry until 1 day before. On the expiry
              date, users must change their password before accessing the system.
            </p>
          </section>
        </TabsContent>

        <TabsContent value="leave-caps">
          <div className="mt-4">
            <LeaveCapsSettings />
          </div>
        </TabsContent>

        <TabsContent value="permissions">
          <PermissionsSettings />
        </TabsContent>

        <TabsContent value="menu-access">
          <MenuAccessSettings />
        </TabsContent>

        <TabsContent value="roles">
          <SystemRolesSettings />
        </TabsContent>

        <TabsContent value="rota-jobs">
          <section className="rounded-xl border bg-card overflow-hidden mt-4">
            <div className="px-5 py-4 border-b">
              <h2 className="text-sm font-semibold">Rota Lifecycle Jobs</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Pause or resume the automatic rota jobs without a deploy. Takes effect within one
                5-minute tick in either direction.
              </p>
            </div>
            <div className="divide-y">
              {(Object.keys(ROTA_JOB_LABELS) as (keyof RotaJobsPaused)[]).map((job) => (
                <div key={job} className="px-5 py-4 flex items-center gap-4">
                  <Timer className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-medium">{ROTA_JOB_LABELS[job]}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {ROTA_JOB_DESCRIPTIONS[job]}
                    </p>
                  </div>
                  <span
                    className={`text-xs font-medium shrink-0 ${rotaJobsPaused[job] ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"}`}
                  >
                    {rotaJobsPaused[job] ? "Paused" : "Running"}
                  </span>
                  <Switch
                    checked={!rotaJobsPaused[job]}
                    disabled={rotaJobSaving === job}
                    onCheckedChange={(checked) => toggleRotaJob(job, !checked)}
                  />
                </div>
              ))}
            </div>
            <p className="px-5 py-3 border-t text-xs text-muted-foreground">
              Resuming a paused job doesn't "pick up where it left off" — the next tick immediately
              processes everything that became overdue while it was paused, all at once.
            </p>
          </section>
        </TabsContent>

        <TabsContent value="rota-deadlines">
          <section className="rounded-xl border bg-card overflow-hidden mt-4">
            <div className="px-5 py-4 border-b flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold">Rota Lifecycle Deadlines</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Day-offsets counted back from the next period's start date. Single source of
                  truth for the dashboard, leave closure, and all three rota jobs.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {rotaDeadlinesEditing ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setRotaDeadlinesEditing(false);
                        setRotaDeadlinesDraft(null);
                      }}
                      disabled={rotaDeadlinesSaving}
                      className="h-8 px-3 rounded-md border bg-card text-xs hover:bg-muted disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={saveRotaDeadlines}
                      disabled={rotaDeadlinesSaving}
                      className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
                    >
                      {rotaDeadlinesSaving ? "Saving…" : "Save changes"}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setRotaDeadlinesDraft({ ...rotaDeadlines });
                      setRotaDeadlinesEditing(true);
                    }}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border bg-card text-xs hover:bg-muted"
                  >
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </button>
                )}
              </div>
            </div>
            <div className="divide-y">
              {ROTA_DEADLINE_FIELDS.map(({ key, label, description }) => (
                <div key={key} className="px-5 py-4 flex items-center gap-4">
                  <CalendarClock className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-medium">{label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
                  </div>
                  {rotaDeadlinesEditing ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        max={90}
                        value={rotaDeadlinesDraft?.[key] ?? rotaDeadlines[key]}
                        onChange={(e) =>
                          setRotaDeadlinesDraft((d) =>
                            d ? { ...d, [key]: Number(e.target.value) } : d,
                          )
                        }
                        className="w-20 h-8 px-2 rounded-md border text-sm text-right focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                      <span className="text-xs text-muted-foreground">days</span>
                    </div>
                  ) : (
                    <span className="text-sm font-semibold tabular-nums">
                      T-{rotaDeadlines[key]}
                    </span>
                  )}
                </div>
              ))}
            </div>
            {rotaDeadlinesEditing && rotaDeadlinesDraft && rotaDeadlinesOrderError(rotaDeadlinesDraft) && (
              <p className="px-5 py-3 border-t text-xs text-destructive">
                {rotaDeadlinesOrderError(rotaDeadlinesDraft)}
              </p>
            )}
            <p className="px-5 py-3 border-t text-xs text-muted-foreground">
              Values must stay in descending order — Leave closure furthest out, Auto-publish
              nearest — since each step depends on the one before it having already happened.
            </p>
          </section>
        </TabsContent>

        <TabsContent value="leave-session">
          <section className="rounded-xl border bg-card overflow-hidden mt-4">
            <div className="px-5 py-4 border-b">
              <h2 className="text-sm font-semibold">Leave &amp; Session Rules</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Other admin-configurable limits that used to be hardcoded.
              </p>
            </div>
            <div className="divide-y">
              <div className="px-5 py-4 flex items-center gap-4">
                <CalendarClock className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium">Sick/Emergency max span</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    How many days (including the start date) a Sick or Emergency leave request can
                    cover — can still be booked any time in advance, this only caps the duration.
                  </p>
                </div>
                {sickEmergencyEditing ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={90}
                      value={sickEmergencyDraft}
                      onChange={(e) => setSickEmergencyDraft(Number(e.target.value))}
                      className="w-20 h-8 px-2 rounded-md border text-sm text-right focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <span className="text-xs text-muted-foreground">days</span>
                    <button
                      type="button"
                      onClick={() => setSickEmergencyEditing(false)}
                      disabled={sickEmergencySaving}
                      className="h-8 px-3 rounded-md border bg-card text-xs hover:bg-muted disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={saveSickEmergencyMaxDays}
                      disabled={sickEmergencySaving}
                      className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
                    >
                      {sickEmergencySaving ? "Saving…" : "Save"}
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold tabular-nums">
                      {sickEmergencyMaxDays} day(s)
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setSickEmergencyDraft(sickEmergencyMaxDays);
                        setSickEmergencyEditing(true);
                      }}
                      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border bg-card text-xs hover:bg-muted"
                    >
                      <Pencil className="h-3.5 w-3.5" /> Edit
                    </button>
                  </div>
                )}
              </div>

              <div className="px-5 py-4 flex items-center gap-4">
                <Timer className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium">Idle session timeout</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Minutes of inactivity before a user is automatically logged out. A warning
                    always shows 5 minutes before.
                  </p>
                </div>
                {idleTimeoutEditing ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={5}
                      max={480}
                      value={idleTimeoutDraft}
                      onChange={(e) => setIdleTimeoutDraft(Number(e.target.value))}
                      className="w-20 h-8 px-2 rounded-md border text-sm text-right focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <span className="text-xs text-muted-foreground">minutes</span>
                    <button
                      type="button"
                      onClick={() => setIdleTimeoutEditing(false)}
                      disabled={idleTimeoutSaving}
                      className="h-8 px-3 rounded-md border bg-card text-xs hover:bg-muted disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={saveIdleTimeout}
                      disabled={idleTimeoutSaving}
                      className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
                    >
                      {idleTimeoutSaving ? "Saving…" : "Save"}
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold tabular-nums">
                      {idleTimeoutMinutes} min
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setIdleTimeoutDraft(idleTimeoutMinutes);
                        setIdleTimeoutEditing(true);
                      }}
                      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border bg-card text-xs hover:bg-muted"
                    >
                      <Pencil className="h-3.5 w-3.5" /> Edit
                    </button>
                  </div>
                )}
              </div>
            </div>
            <p className="px-5 py-3 border-t text-xs text-muted-foreground">
              Both take effect immediately for new checks — the idle timeout applies the next time
              a user's session timer resets (e.g. their next action), not retroactively to an
              already-running countdown.
            </p>
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}
