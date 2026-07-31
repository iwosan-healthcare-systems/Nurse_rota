import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { api } from "@/lib/api";
import { useAuth, type RoleDef } from "@/lib/auth-context";
import { Modal } from "./staff";
import { toast } from "sonner";
import { logAudit } from "@/lib/audit";
import { Plus, Pencil, Trash2, ShieldAlert, Shield, Lock } from "lucide-react";

export const Route = createFileRoute("/_app/roles")({
  head: () => ({
    meta: [
      { title: "System Roles — Nurses Rota" },
      { name: "description", content: "Create and manage custom system roles." },
    ],
  }),
  component: RolesPage,
});

const KEY_RE = /^[a-z][a-z0-9_]{1,49}$/;

const ROLES_CHANGED_EVENT = "roles-changed";

function RolesPage() {
  const navigate = useNavigate();
  const { canManageRoles, loading } = useAuth();
  const qc = useQueryClient();

  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<RoleDef | null>(null);

  useEffect(() => {
    if (!loading && !canManageRoles) navigate({ to: "/" });
  }, [loading, canManageRoles, navigate]);

  const { data: roles = [], isLoading } = useQuery<RoleDef[]>({
    queryKey: ["roles-admin"],
    enabled: canManageRoles,
    queryFn: () => api.get<RoleDef[]>("/roles"),
  });

  function afterMutate() {
    qc.invalidateQueries({ queryKey: ["roles-admin"] });
    window.dispatchEvent(new Event(ROLES_CHANGED_EVENT));
  }

  async function deleteRole(role: RoleDef) {
    if (!confirm(`Delete the "${role.label}" role? This cannot be undone.`)) return;
    try {
      await api.del(`/roles/${role.key}`);
      void logAudit("Deleted system role", role.label);
      afterMutate();
      toast.success("Role deleted");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to delete role");
    }
  }

  if (!canManageRoles) {
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
        title="System Roles"
        subtitle="Create custom roles, then assign their permissions and menu access"
        actions={
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-2 h-10 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" /> New Role
          </button>
        }
      />

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : roles.length === 0 ? (
        <EmptyState
          icon={<Shield className="h-6 w-6" />}
          title="No roles"
          description="Something's wrong — the system roles should have been seeded by migration."
        />
      ) : (
        <div className="bg-card border rounded-xl shadow-soft overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-3 font-semibold">Key</th>
                  <th className="text-left px-4 py-3 font-semibold">Label</th>
                  <th className="text-left px-4 py-3 font-semibold">Description</th>
                  <th className="text-left px-4 py-3 font-semibold">Users</th>
                  <th className="text-right px-4 py-3 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {roles.map((role) => (
                  <tr key={role.key} className="border-t hover:bg-muted/30">
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{role.key}</td>
                    <td className="px-4 py-3 font-medium">
                      <div className="flex items-center gap-2">
                        {role.label}
                        {role.is_system && (
                          <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold bg-muted text-muted-foreground border">
                            <Lock className="h-2.5 w-2.5" /> System
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground max-w-md">{role.description || "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground tabular-nums">
                      {role.usage_count ?? 0}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setEditTarget(role)}
                          title="Edit label / description"
                          className="h-8 w-8 grid place-items-center rounded-md hover:bg-muted text-muted-foreground"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteRole(role)}
                          disabled={role.is_system || (role.usage_count ?? 0) > 0}
                          title={
                            role.is_system
                              ? "System roles cannot be deleted"
                              : (role.usage_count ?? 0) > 0
                                ? `Assigned to ${role.usage_count} user(s) — remove it from those users first`
                                : "Delete role"
                          }
                          className="h-8 w-8 grid place-items-center rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        After creating a role, grant it capabilities in{" "}
        <a href="/permissions" className="underline hover:text-foreground">
          Permissions
        </a>{" "}
        and pages in{" "}
        <a href="/menu-permissions" className="underline hover:text-foreground">
          Menu Access
        </a>
        . A new role starts with no permissions and no menu access until you grant them.
      </p>

      {showCreate && (
        <RoleFormModal
          title="New Role"
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            afterMutate();
          }}
        />
      )}
      {editTarget && (
        <RoleFormModal
          title="Edit Role"
          existing={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null);
            afterMutate();
          }}
        />
      )}
    </div>
  );
}

function RoleFormModal({
  title,
  existing,
  onClose,
  onSaved,
}: {
  title: string;
  existing?: RoleDef;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [key, setKey] = useState(existing?.key ?? "");
  const [label, setLabel] = useState(existing?.label ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [saving, setSaving] = useState(false);

  const keyValid = existing ? true : KEY_RE.test(key);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim()) return toast.error("Label is required");
    if (!existing && !keyValid) {
      return toast.error("Key must be lowercase snake_case, 2-50 characters (e.g. ward_clerk)");
    }
    setSaving(true);
    try {
      if (existing) {
        await api.patch(`/roles/${existing.key}`, { label: label.trim(), description });
        void logAudit("Edited system role", label.trim());
        toast.success("Role updated");
      } else {
        await api.post("/roles", { key: key.trim(), label: label.trim(), description });
        void logAudit("Created system role", `${label.trim()} (${key.trim()})`);
        toast.success("Role created");
      }
      onSaved();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save role");
    } finally {
      setSaving(false);
    }
  }

  const inputCls =
    "w-full h-10 px-3 rounded-md border bg-background text-sm outline-none focus:ring-2 focus:ring-ring";

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="p-5 space-y-3">
        <div>
          <label className="block text-sm font-medium mb-1">
            Key <span className="text-destructive">*</span>
          </label>
          <input
            type="text"
            required
            disabled={!!existing}
            placeholder="e.g. ward_clerk"
            value={key}
            onChange={(e) => setKey(e.target.value.toLowerCase())}
            className={inputCls + (existing ? " opacity-60 cursor-not-allowed" : "")}
          />
          {!existing && (
            <p className="text-xs text-muted-foreground mt-1">
              Lowercase snake_case, 2-50 characters. Cannot be changed after creation.
            </p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">
            Label <span className="text-destructive">*</span>
          </label>
          <input
            type="text"
            required
            placeholder="e.g. Ward Clerk"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className={inputCls}
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Description</label>
          <textarea
            rows={3}
            placeholder="What this role is for"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={inputCls + " h-auto py-2 resize-none"}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="h-9 px-4 rounded-md border bg-card text-sm hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
