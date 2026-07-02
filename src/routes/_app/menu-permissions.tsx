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
import { api } from "@/lib/api";
import { Check, X, Pencil, RotateCcw, ShieldAlert, Lock } from "lucide-react";
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

const ROLES: AppRole[] = ["admin", "cno", "chief_matron", "head_nurse", "hr_admin", "nurse"];

function MenuPermissionsPage() {
  const navigate = useNavigate();
  const { isAdmin, loading } = useAuth();

  const [overrides, setOverrides] = useState<Record<string, AppRole[]>>(loadMenuPermissions);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, AppRole[]>>({});
  const [saving, setSaving] = useState(false);

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
      />

      <section className="rounded-xl border bg-card overflow-hidden">
        {/* Section header */}
        <div className="px-5 py-4 border-b flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold">Menu visibility matrix</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              A checked cell means that role will see the page in the sidebar. Changes take
              effect immediately on next navigation.
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
    </div>
  );
}
