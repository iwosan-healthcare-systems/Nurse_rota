import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { useAuth, type AppRole, type SystemRole } from "@/lib/auth-context";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { FlagTagAssignment, type TagEntity, type TagFlag } from "@/components/FlagTagAssignment";
import { DEFAULT_CAPABILITIES, type Capability } from "@/lib/capability-definitions";

const CAPABILITIES_CHANGED_EVENT = "capabilities-changed";

function humanizeKey(key: string) {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Merges the DB-saved role-lists onto DEFAULT_CAPABILITIES's labels — but any
// DB key that ISN'T in DEFAULT_CAPABILITIES also gets surfaced (with a
// humanized fallback label) instead of silently dropped, so a migration that
// adds a capability before the frontend list is updated stays visible and
// editable instead of quietly lossy the next time anything here is saved.
function mergeCapabilities(saved: { key: string; roles: AppRole[] }[]): Capability[] {
  const known = DEFAULT_CAPABILITIES.map((cap) => {
    const found = saved.find((s) => s.key === cap.key);
    return found ? { ...cap, roles: found.roles } : cap;
  });
  const knownKeys = new Set(DEFAULT_CAPABILITIES.map((c) => c.key));
  const unknown = saved
    .filter((s) => !knownKeys.has(s.key))
    .map((s) => ({ key: s.key, label: humanizeKey(s.key), roles: s.roles }));
  return [...known, ...unknown];
}

export function PermissionsSettings() {
  // Nested sub-tab, one level inside the outer System Settings "permissions"
  // tab — its own search param (permTab) on the same route, kept in sync the
  // same way the outer tab is, so a refresh lands back on this sub-tab too.
  const search = useSearch({ from: "/_app/system-settings" });
  const { permTab } = search;
  const navigate = useNavigate({ from: "/_app/system-settings" });
  const [subTab, setSubTabState] = useState<"by-role" | "by-user">(permTab ?? "by-role");
  useEffect(() => {
    setSubTabState(permTab ?? "by-role");
  }, [permTab]);
  function setSubTab(next: "by-role" | "by-user") {
    setSubTabState(next);
    navigate({
      to: "/system-settings",
      search: (prev: typeof search) => ({ ...prev, tab: "permissions", permTab: next }),
      replace: true,
    });
  }

  return (
    <Tabs value={subTab} onValueChange={(v) => setSubTab(v as "by-role" | "by-user")}>
      <TabsList>
        <TabsTrigger value="by-role">By Role</TabsTrigger>
        <TabsTrigger value="by-user">By User</TabsTrigger>
      </TabsList>
      <TabsContent value="by-role">
        <ByRoleTab />
      </TabsContent>
      <TabsContent value="by-user">
        <ByUserTab />
      </TabsContent>
    </Tabs>
  );
}

// ── By Role ───────────────────────────────────────────────────────────────

function ByRoleTab() {
  const { allRoles, roleLabel } = useAuth();
  const [capabilities, setCapabilities] = useState<Capability[]>(DEFAULT_CAPABILITIES);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .get<{ key: string; value: { key: string; roles: AppRole[] }[] }>(
        "/portal-settings/capabilities",
      )
      .then(({ value }) => {
        if (value) setCapabilities(mergeCapabilities(value));
      })
      .catch(() => {});
  }, []);

  // Admin excluded — it bypasses every capability check unconditionally
  // already, so tagging it would be a no-op.
  const entities: TagEntity[] = allRoles
    .filter((r) => r.key !== "admin")
    .map((r) => ({ key: r.key, label: roleLabel(r.key) }));

  const flagUniverse: TagFlag[] = useMemo(
    () => capabilities.map((c) => ({ key: c.key, label: c.label })),
    [capabilities],
  );

  const getAssignedKeys = useCallback(
    (roleKey: string) =>
      capabilities.filter((c) => c.roles.includes(roleKey as AppRole)).map((c) => c.key),
    [capabilities],
  );

  async function onAssign(roleKey: string, capKeys: string[]) {
    const changes = capKeys.map((key) => {
      const cap = capabilities.find((c) => c.key === key);
      const roles = cap?.roles.includes(roleKey as AppRole)
        ? cap.roles
        : [...(cap?.roles ?? []), roleKey as AppRole];
      return { key, roles };
    });
    await patchCapabilities(changes);
  }

  async function onUnassign(roleKey: string, capKeys: string[]) {
    const changes = capKeys.map((key) => {
      const cap = capabilities.find((c) => c.key === key);
      return { key, roles: (cap?.roles ?? []).filter((r) => r !== roleKey) };
    });
    await patchCapabilities(changes);
  }

  async function patchCapabilities(changes: { key: string; roles: AppRole[] }[]) {
    setSaving(true);
    try {
      const { value } = await api.patch<{ value: { key: string; roles: AppRole[] }[] }>(
        "/portal-settings/capabilities",
        { changes },
      );
      window.dispatchEvent(new Event(CAPABILITIES_CHANGED_EVENT));
      setCapabilities(mergeCapabilities(value));
      toast.success("Permissions saved");
    } catch (e) {
      toast.error("Failed to save: " + (e instanceof Error ? e.message : "Unknown error"));
    } finally {
      setSaving(false);
    }
  }

  async function resetDefaults() {
    if (
      !confirm("Reset ALL capabilities to system defaults for every role? This cannot be undone.")
    )
      return;
    setSaving(true);
    try {
      await api.put("/portal-settings/capabilities", { value: [] });
      window.dispatchEvent(new Event(CAPABILITIES_CHANGED_EVENT));
      setCapabilities(DEFAULT_CAPABILITIES);
      toast.success("Permissions reset to defaults");
    } catch (e) {
      toast.error("Failed to reset: " + (e instanceof Error ? e.message : "Unknown error"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border bg-card p-5 mt-4">
      <div className="flex items-start justify-between gap-4 mb-4">
        <p className="text-xs text-muted-foreground">
          What each role is allowed to do in the system. Capabilities are enforced server-side.
        </p>
        <button
          type="button"
          onClick={resetDefaults}
          disabled={saving}
          title="Reset ALL roles to system defaults"
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border bg-card text-xs hover:bg-muted disabled:opacity-50 shrink-0"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Reset all to defaults
        </button>
      </div>
      <FlagTagAssignment
        entityPickerLabel="Role Tagging With"
        entities={entities}
        flagUniverse={flagUniverse}
        getAssignedKeys={getAssignedKeys}
        onAssign={onAssign}
        onUnassign={onUnassign}
        saving={saving}
        searchPlaceholder="Search Flag name"
      />
    </div>
  );
}

// ── By User ───────────────────────────────────────────────────────────────

type ProfileRow = { id: string; email: string | null; full_name: string | null };
type RoleRow = { user_id: string; role: string };
type OverrideRow = { user_id: string; capability_key: string; user_name: string | null };

function ByUserTab() {
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [capabilities, setCapabilities] = useState<Capability[]>(DEFAULT_CAPABILITIES);
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [profs, rls, capsRes, overridesRes] = await Promise.all([
        api.get<ProfileRow[]>("/auth/admin/users"),
        api.get<RoleRow[]>("/user-roles"),
        api
          .get<{ value: { key: string; roles: AppRole[] }[] }>("/portal-settings/capabilities")
          .catch(() => ({ value: [] as { key: string; roles: AppRole[] }[] })),
        api.get<OverrideRow[]>("/user-capability-overrides").catch(() => [] as OverrideRow[]),
      ]);
      const rolesByUser = new Map<string, string[]>();
      for (const r of rls)
        rolesByUser.set(r.user_id, [...(rolesByUser.get(r.user_id) ?? []), r.role]);
      // Admin users are excluded — they already have every capability, no
      // need to individually grant them anything extra.
      const nonAdmin = profs
        .filter((p) => !(rolesByUser.get(p.id) ?? []).includes("admin"))
        .map((p) => ({ id: p.id, name: p.full_name || p.email || p.id }));
      setUsers(nonAdmin);
      setCapabilities(
        capsRes.value?.length ? mergeCapabilities(capsRes.value) : DEFAULT_CAPABILITIES,
      );
      setOverrides(overridesRes);
    } catch {
      toast.error("Failed to load users/overrides");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const entities: TagEntity[] = users.map((u) => ({ key: u.id, label: u.name }));
  const flagUniverse: TagFlag[] = useMemo(
    () => capabilities.map((c) => ({ key: c.key, label: c.label })),
    [capabilities],
  );

  const getAssignedKeys = useCallback(
    (userId: string) => overrides.filter((o) => o.user_id === userId).map((o) => o.capability_key),
    [overrides],
  );

  async function onAssign(userId: string, keys: string[]) {
    setSaving(true);
    try {
      await api.post("/user-capability-overrides", { user_id: userId, keys });
      await reload();
      toast.success("Capability granted — takes effect on the user's next login");
    } catch (e) {
      toast.error("Failed to grant: " + (e instanceof Error ? e.message : "Unknown error"));
    } finally {
      setSaving(false);
    }
  }

  async function onUnassign(userId: string, keys: string[]) {
    setSaving(true);
    try {
      await api.del("/user-capability-overrides", { user_id: userId, keys });
      await reload();
      toast.success("Capability revoked");
    } catch (e) {
      toast.error("Failed to revoke: " + (e instanceof Error ? e.message : "Unknown error"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border bg-card p-5 mt-4">
      <p className="text-xs text-muted-foreground mb-4">
        Grant one specific staff member an extra capability beyond what their role(s) already give
        them — additive only, never removes anything their role grants. Admin accounts aren't listed
        since they already have every capability. Enforcement is instant server-side, but a granted
        capability only shows up in that user's own interface after their next login.
      </p>
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <FlagTagAssignment
          entityPickerLabel="User Tagging With"
          entities={entities}
          flagUniverse={flagUniverse}
          getAssignedKeys={getAssignedKeys}
          onAssign={onAssign}
          onUnassign={onUnassign}
          saving={saving}
          searchPlaceholder="Search Flag name"
          entityEmptyMessage="No non-admin users found."
        />
      )}
    </div>
  );
}
