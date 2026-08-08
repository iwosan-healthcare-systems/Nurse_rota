/* eslint-disable prettier/prettier */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { useAuth, type AppRole } from "@/lib/auth-context";
import { NAV_DEFINITIONS, ADMIN_LOCKED_KEYS, getEffectiveRoles } from "@/lib/menu-permissions";
import { api } from "@/lib/api";
import { RotateCcw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { FlagTagAssignment, type TagEntity, type TagFlag } from "@/components/FlagTagAssignment";

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

function MenuPermissionsPage() {
  const navigate = useNavigate();
  const { isAdmin, loading, allRoles, roleLabel } = useAuth();

  // Stored as a diff against NAV_DEFINITIONS' defaults — same shape as
  // before, only entries that differ from the default ever get written.
  const [overrides, setOverrides] = useState<Record<string, AppRole[]>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!loading && !isAdmin) navigate({ to: "/" });
  }, [loading, isAdmin, navigate]);

  useEffect(() => {
    api
      .get<{ key: string; value: Record<string, AppRole[]> }>("/portal-settings/menu_permissions")
      .then(({ value }) => {
        if (value) setOverrides(value);
      })
      .catch(() => {});
  }, []);

  // Admin is excluded from the tagging UI entirely — it bypasses every page
  // guard unconditionally already, so tagging it would be a no-op.
  const entities: TagEntity[] = allRoles
    .filter((r) => r.key !== "admin")
    .map((r) => ({ key: r.key, label: roleLabel(r.key) }));

  const flagUniverse: TagFlag[] = useMemo(
    () => NAV_DEFINITIONS.map((def) => ({ key: def.key, label: def.label })),
    [],
  );

  const getAssignedKeys = useCallback(
    (roleKey: string) =>
      NAV_DEFINITIONS.filter((def) => getEffectiveRoles(def.key, overrides).includes(roleKey)).map(
        (def) => def.key,
      ),
    [overrides],
  );

  // Snapshots the full effective (defaults + overrides) state, applies a
  // mutation, diffs back down to only what differs from defaults (the
  // storage shape this endpoint has always used), persists, and notifies
  // AppShell so the sidebar re-fetches immediately.
  async function persist(mutate: (effective: Record<string, AppRole[]>) => void) {
    const effective: Record<string, AppRole[]> = {};
    for (const def of NAV_DEFINITIONS) effective[def.key] = [...getEffectiveRoles(def.key, overrides)];
    mutate(effective);

    const toStore: Record<string, AppRole[]> = {};
    for (const def of NAV_DEFINITIONS) {
      let roles = effective[def.key] ?? def.defaultRoles;
      if (!roles.includes("admin")) roles = ["admin", ...roles];
      const defaultSorted = [...def.defaultRoles].sort().join(",");
      const roleSorted = [...roles].sort().join(",");
      if (defaultSorted !== roleSorted) toStore[def.key] = roles;
    }

    setSaving(true);
    try {
      await api.put("/portal-settings/menu_permissions", { value: toStore });
      window.dispatchEvent(new Event("menu-permissions-changed"));
      setOverrides(toStore);
    } finally {
      setSaving(false);
    }
  }

  async function onAssign(roleKey: string, navKeys: string[]) {
    try {
      await persist((effective) => {
        for (const navKey of navKeys) {
          if (!effective[navKey].includes(roleKey)) effective[navKey] = [...effective[navKey], roleKey];
        }
      });
      toast.success("Menu access granted");
    } catch (e) {
      toast.error("Failed to save: " + (e instanceof Error ? e.message : "Unknown error"));
    }
  }

  async function onUnassign(roleKey: string, navKeys: string[]) {
    try {
      await persist((effective) => {
        for (const navKey of navKeys) {
          effective[navKey] = effective[navKey].filter((r) => r !== roleKey);
        }
      });
      toast.success("Menu access removed");
    } catch (e) {
      toast.error("Failed to save: " + (e instanceof Error ? e.message : "Unknown error"));
    }
  }

  async function resetDefaults() {
    if (!confirm("Reset menu visibility to system defaults for all roles?")) return;
    setSaving(true);
    try {
      await api.put("/portal-settings/menu_permissions", { value: {} });
      window.dispatchEvent(new Event("menu-permissions-changed"));
      setOverrides({});
      toast.success("Menu permissions reset to defaults");
    } catch (e) {
      toast.error("Failed to reset: " + (e instanceof Error ? e.message : "Unknown error"));
    } finally {
      setSaving(false);
    }
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
        title="Menu Access"
        subtitle="Control which sidebar items each role can see"
        actions={
          <button
            type="button"
            onClick={resetDefaults}
            disabled={saving}
            title="Reset all roles to defaults"
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border bg-card text-xs hover:bg-muted disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset to defaults
          </button>
        }
      />

      <div className="rounded-xl border bg-card p-5">
        <FlagTagAssignment
          entityPickerLabel="Role Tagging With"
          entities={entities}
          flagUniverse={flagUniverse}
          getAssignedKeys={getAssignedKeys}
          onAssign={onAssign}
          onUnassign={onUnassign}
          saving={saving}
          searchPlaceholder="Search page name"
        />
        <p className="text-xs text-muted-foreground mt-4">
          A page assigned to a role appears in that role's sidebar. Admin always sees every page
          ({[...ADMIN_LOCKED_KEYS].length} pages are always admin-only regardless of this list) and
          isn't shown here since tagging it would have no effect.
        </p>
      </div>
    </div>
  );
}
