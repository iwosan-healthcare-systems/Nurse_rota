import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useState } from "react";
import {
  Users,
  Search,
  Plus,
  Trash2,
  Shield,
  UserCog,
  Loader2,
  X,
  Clock,
  AlertTriangle,
  UserX,
  UserCheck,
  CheckCircle2,
  Zap,
} from "lucide-react";
import { useAuth, ROLE_LABELS, type AppRole } from "@/lib/auth-context";
import { EmptyState } from "@/components/EmptyState";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/users")({
  head: () => ({
    meta: [
      { title: "User Profiles — Nurses Rota" },
      { name: "description", content: "Manage user accounts and role assignments." },
    ],
  }),
  component: UsersPage,
});

const ALL_ROLES: AppRole[] = ["admin", "cno", "chief_matron", "head_nurse", "hr_admin", "nurse"];

const ROLE_BADGE_COLORS: Record<AppRole, string> = {
  admin: "bg-red-100 text-red-700 border-red-200",
  cno: "bg-violet-100 text-violet-700 border-violet-200",
  chief_matron: "bg-blue-100 text-blue-700 border-blue-200",
  head_nurse: "bg-amber-100 text-amber-700 border-amber-200",
  hr_admin: "bg-teal-100 text-teal-700 border-teal-200",
  nurse: "bg-muted text-muted-foreground border-border",
};

type ProfileRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  is_active: boolean;
  must_change_password: boolean;
};

type RoleRow = { user_id: string; role: string };

type UserRow = ProfileRow & {
  roles: AppRole[];
  last_sign_in_at: string | null;
};

function UsersPage() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [showBulkCreate, setShowBulkCreate] = useState(false);

  const { data: users = [], isLoading } = useQuery({
    queryKey: ["user-profiles"],
    enabled: isAdmin,
    queryFn: async () => {
      const [profs, rls] = await Promise.all([
        api.get<ProfileRow[]>("/auth/admin/users"),
        api.get<RoleRow[]>("/user-roles"),
      ]);
      const roleMap = new Map<string, AppRole[]>();
      rls.forEach((r) => {
        const arr = roleMap.get(r.user_id) ?? [];
        arr.push(r.role as AppRole);
        roleMap.set(r.user_id, arr);
      });
      return profs.map((p) => ({
        ...p,
        roles: roleMap.get(p.id) ?? [],
        last_sign_in_at: null,
      })) as UserRow[];
    },
  });

  async function addRole(userId: string, role: AppRole) {
    try {
      await api.post("/user-roles", { user_id: userId, role });
      toast.success(`Granted: ${ROLE_LABELS[role]}`);
      qc.invalidateQueries({ queryKey: ["user-profiles"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to grant role");
    }
  }

  async function removeRole(userId: string, role: AppRole) {
    try {
      await api.del(`/user-roles?user_id=${userId}&role=${role}`);
      toast.success(`Revoked: ${ROLE_LABELS[role]}`);
      qc.invalidateQueries({ queryKey: ["user-profiles"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to revoke role");
    }
  }

  async function deactivateUser(user: UserRow) {
    if (
      !confirm(
        `Deactivate "${user.full_name ?? user.email}"? They will not be able to log in until reactivated.`,
      )
    )
      return;
    try {
      await api.patch(`/auth/admin/users/${user.id}/ban`);
      toast.success("Login deactivated");
      void qc.invalidateQueries({ queryKey: ["user-profiles"] });
      void qc.invalidateQueries({ queryKey: ["profile-names"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to deactivate user");
    }
  }

  async function reactivateUser(user: UserRow) {
    try {
      await api.patch(`/auth/admin/users/${user.id}/unban`);
      toast.success("Login reactivated");
      void qc.invalidateQueries({ queryKey: ["user-profiles"] });
      void qc.invalidateQueries({ queryKey: ["profile-names"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to reactivate user");
    }
  }

  async function deleteUser(user: UserRow) {
    if (
      !confirm(
        `Permanently delete "${user.full_name ?? user.email}"?\n\nThis removes their login, roles and profile and cannot be undone.`,
      )
    )
      return;
    try {
      await api.del(`/auth/admin/users/${user.id}`);
      toast.success("User deleted");
      qc.invalidateQueries({ queryKey: ["user-profiles"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to delete user");
    }
  }

  const filtered = search.trim()
    ? users.filter(
        (u) =>
          u.full_name?.toLowerCase().includes(search.toLowerCase()) ||
          u.email?.toLowerCase().includes(search.toLowerCase()),
      )
    : users;

  if (!isAdmin) {
    return (
      <div className="py-20 text-center text-sm text-muted-foreground">
        Administrator access required.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="User Profiles"
        subtitle={`${users.length} user${users.length !== 1 ? "s" : ""} · Manage role assignments`}
        actions={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <input
                type="search"
                placeholder="Search users…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-10 pl-8 pr-3 w-52 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <button
              type="button"
              onClick={() => setShowBulkCreate(true)}
              className="inline-flex items-center gap-2 h-10 px-4 rounded-md border bg-card text-sm font-medium hover:bg-muted"
            >
              <Zap className="h-4 w-4" /> Generate Logins
            </button>
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-2 h-10 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" /> Create User
            </button>
          </div>
        }
      />

      {isLoading ? (
        <p className="text-sm text-muted-foreground py-12 text-center">Loading users…</p>
      ) : users.length === 0 ? (
        <EmptyState
          icon={<UserCog className="h-6 w-6" />}
          title="No user profiles found"
          description="Create logins for nurses from the Staff page — they will appear here."
        />
      ) : (
        <div className="rounded-xl border bg-card overflow-hidden shadow-soft">
          {filtered.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">
              No users match &ldquo;{search}&rdquo;
            </p>
          ) : (
            <div className="divide-y">
              {filtered.map((u) => (
                <UserRowItem
                  key={u.id}
                  user={u}
                  onAdd={addRole}
                  onRemove={removeRole}
                  onDelete={deleteUser}
                  onDeactivate={deactivateUser}
                  onReactivate={reactivateUser}
                />
              ))}
            </div>
          )}

          <div className="px-5 py-3 border-t bg-muted/30 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Shield className="h-3.5 w-3.5" />
            {filtered.length} of {users.length} user{users.length !== 1 ? "s" : ""} shown · Role
            changes take effect on next login
          </div>
        </div>
      )}

      {showCreate && (
        <CreateUserModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            qc.invalidateQueries({ queryKey: ["user-profiles"] });
            setShowCreate(false);
          }}
        />
      )}

      {showBulkCreate && (
        <BulkCreateModal
          onClose={() => {
            setShowBulkCreate(false);
            qc.invalidateQueries({ queryKey: ["user-profiles"] });
          }}
        />
      )}
    </div>
  );
}

function CreateUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    fullName: "",
    email: "",
    password: "",
    role: "nurse" as AppRole,
  });
  const [busy, setBusy] = useState(false);

  async function submit(e: React.SyntheticEvent) {
    e.preventDefault();
    if (form.password.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    setBusy(true);
    try {
      const { id: userId } = await api.post<{ id: string }>("/auth/admin/create-user", {
        email: form.email,
        password: form.password,
        full_name: form.fullName || form.email,
      });
      await api.post("/user-roles", { user_id: userId, role: form.role });
      toast.success(`User created — ${form.email} can log in immediately`);
      onCreated();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create user");
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "w-full h-10 px-3 rounded-md border bg-background text-sm outline-none focus:ring-2 focus:ring-ring";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-card rounded-xl shadow-xl border w-full max-w-sm p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-lg">Create User</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close"
            className="h-7 w-7 grid place-items-center rounded-md hover:bg-muted text-muted-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">Full name</label>
            <input
              type="text"
              placeholder="e.g. Jane Doe"
              value={form.fullName}
              onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
              className={inputCls}
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Email <span className="text-destructive">*</span>
            </label>
            <input
              type="email"
              required
              placeholder="user@example.com"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              className={inputCls}
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Password <span className="text-destructive">*</span>
            </label>
            <input
              type="password"
              required
              minLength={8}
              placeholder="Min. 8 characters"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              className={inputCls}
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Role <span className="text-destructive">*</span>
            </label>
            <select
              required
              title="Role"
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as AppRole }))}
              className={inputCls}
            >
              {ALL_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="h-9 px-4 rounded-md border text-sm hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium inline-flex items-center gap-2 disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {busy ? "Creating…" : "Create User"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

type BulkResult = {
  created: { name: string; email: string }[];
  skipped: { name: string; email: string; reason: string }[];
};

function BulkCreateModal({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState("Welcome@123");
  const [role, setRole] = useState<AppRole>("nurse");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BulkResult | null>(null);

  const inputCls =
    "w-full h-10 px-3 rounded-md border bg-background text-sm outline-none focus:ring-2 focus:ring-ring";

  async function submit(e: React.SyntheticEvent) {
    e.preventDefault();
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<BulkResult>("/auth/admin/bulk-create-users", {
        default_password: password,
        role,
      });
      setResult(res);
      if (res.created.length > 0) {
        toast.success(`${res.created.length} login${res.created.length !== 1 ? "s" : ""} created`);
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to generate logins");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-card rounded-xl shadow-xl border w-full max-w-md p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-lg flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" /> Generate Logins
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="h-7 w-7 grid place-items-center rounded-md hover:bg-muted text-muted-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {!result ? (
          <>
            <p className="text-sm text-muted-foreground">
              Creates login accounts for all nurses in the Staff list who have an email address and
              don&apos;t already have an account. Each nurse will be prompted to change their
              password on first login.
            </p>

            <form onSubmit={submit} className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1">
                  Default password <span className="text-destructive">*</span>
                </label>
                <input
                  type="text"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputCls}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  All new accounts will use this password — nurses must change it on first login.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Default role</label>
                <select
                  title="Default role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as AppRole)}
                  className={inputCls}
                >
                  {ALL_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-9 px-4 rounded-md border text-sm hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium inline-flex items-center gap-2 disabled:opacity-50"
                >
                  {busy ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Generating…
                    </>
                  ) : (
                    <>
                      <Zap className="h-3.5 w-3.5" /> Generate
                    </>
                  )}
                </button>
              </div>
            </form>
          </>
        ) : (
          <div className="space-y-4">
            <div className="flex gap-3">
              <div className="flex-1 rounded-lg bg-green-50 border border-green-200 p-3 text-center">
                <p className="text-2xl font-bold text-green-700">{result.created.length}</p>
                <p className="text-xs text-green-600 font-medium">Created</p>
              </div>
              <div className="flex-1 rounded-lg bg-muted/60 border p-3 text-center">
                <p className="text-2xl font-bold text-muted-foreground">{result.skipped.length}</p>
                <p className="text-xs text-muted-foreground font-medium">Skipped</p>
              </div>
            </div>

            {result.created.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                  Created
                </p>
                <div className="max-h-40 overflow-y-auto rounded-lg border divide-y text-sm">
                  {result.created.map((u) => (
                    <div key={u.email} className="px-3 py-2 flex justify-between gap-2">
                      <span className="font-medium truncate">{u.name}</span>
                      <span className="text-muted-foreground text-xs truncate">{u.email}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {result.skipped.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                  Skipped
                </p>
                <div className="max-h-32 overflow-y-auto rounded-lg border divide-y text-sm">
                  {result.skipped.map((u) => (
                    <div key={u.email} className="px-3 py-2 flex justify-between gap-2">
                      <span className="truncate">{u.name}</span>
                      <span className="text-muted-foreground text-xs italic">{u.reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {result.created.length === 0 && result.skipped.length === 0 && (
              <p className="text-sm text-center text-muted-foreground py-4">
                No nurses with email addresses found in the Staff list.
              </p>
            )}

            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function UserRowItem({
  user,
  onAdd,
  onRemove,
  onDelete,
  onDeactivate,
  onReactivate,
}: {
  user: UserRow;
  onAdd: (id: string, role: AppRole) => void;
  onRemove: (id: string, role: AppRole) => void;
  onDelete: (user: UserRow) => void;
  onDeactivate: (user: UserRow) => void;
  onReactivate: (user: UserRow) => void;
}) {
  const [adding, setAdding] = useState<AppRole | "">("");
  const available = ALL_ROLES.filter((r) => !user.roles.includes(r));
  const initials = (user.full_name ?? user.email ?? "?")
    .split(/[\s@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("");

  return (
    <div className="px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex items-center gap-3 min-w-0 sm:w-64 shrink-0">
        <div className="h-9 w-9 rounded-full bg-primary/10 text-primary grid place-items-center shrink-0 font-semibold text-sm">
          {initials || <Users className="h-4 w-4" />}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="text-sm font-medium truncate">{user.full_name ?? "Unnamed"}</p>
            {user.must_change_password && (
              <span
                className="inline-flex items-center gap-0.5 text-[10px] bg-amber-100 text-amber-700 border border-amber-200 rounded-full px-1.5 py-0.5 font-medium whitespace-nowrap"
                title="User must change password on next login"
              >
                <AlertTriangle className="h-2.5 w-2.5" />
                Needs PW change
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground truncate">{user.email}</p>
          <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
            <Clock className="h-2.5 w-2.5 shrink-0" />
            <span
              title={
                user.last_sign_in_at
                  ? new Date(user.last_sign_in_at).toLocaleString()
                  : "Never signed in"
              }
            >
              {formatRelativeTime(user.last_sign_in_at)}
            </span>
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 flex-1 min-w-0">
        {user.roles.length === 0 && (
          <span className="text-xs text-muted-foreground italic">No roles assigned</span>
        )}
        {user.roles.map((r) => (
          <span
            key={r}
            className={`inline-flex items-center gap-1 rounded-full border text-xs px-2.5 py-0.5 ${ROLE_BADGE_COLORS[r]}`}
          >
            {ROLE_LABELS[r]}
            <button
              type="button"
              onClick={() => onRemove(user.id, r)}
              className="hover:text-destructive ml-0.5"
              title={`Revoke ${ROLE_LABELS[r]}`}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>

      {available.length > 0 && (
        <div className="flex items-center gap-2 shrink-0">
          <select
            aria-label="Add role"
            value={adding}
            onChange={(e) => setAdding(e.target.value as AppRole | "")}
            className="text-xs h-8 rounded-md border bg-background px-2 outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">Add role…</option>
            {available.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!adding}
            onClick={() => {
              if (adding) {
                onAdd(user.id, adding);
                setAdding("");
              }
            }}
            className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium inline-flex items-center gap-1 disabled:opacity-40"
          >
            <Plus className="h-3 w-3" /> Add
          </button>
        </div>
      )}

      <div className="flex items-center gap-1 shrink-0">
        {user.is_active ? (
          <>
            <span
              className="inline-flex items-center gap-1 text-[11px] text-success font-medium"
              title="Login active"
            >
              <CheckCircle2 className="h-3.5 w-3.5" /> Active
            </span>
            <button
              type="button"
              onClick={() => onDeactivate(user)}
              title="Deactivate login"
              className="h-7 w-7 grid place-items-center rounded-md border border-transparent hover:border-amber-400/40 hover:bg-amber-50 text-muted-foreground hover:text-amber-700 shrink-0 transition-colors"
            >
              <UserX className="h-3.5 w-3.5" />
            </button>
          </>
        ) : (
          <>
            <span
              className="inline-flex items-center gap-1 text-[11px] text-destructive font-medium"
              title="Login deactivated"
            >
              <UserX className="h-3.5 w-3.5" /> Inactive
            </span>
            <button
              type="button"
              onClick={() => onReactivate(user)}
              title="Reactivate login"
              className="h-7 w-7 grid place-items-center rounded-md border border-transparent hover:border-success/40 hover:bg-success/10 text-muted-foreground hover:text-success shrink-0 transition-colors"
            >
              <UserCheck className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>

      <button
        type="button"
        onClick={() => onDelete(user)}
        title="Delete user"
        className="h-8 w-8 grid place-items-center rounded-md border border-transparent hover:border-destructive/40 hover:bg-destructive/10 text-muted-foreground hover:text-destructive shrink-0 transition-colors"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
