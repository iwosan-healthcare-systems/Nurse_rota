/* eslint-disable prettier/prettier */
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useEffect, useState } from "react";
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
  RotateCcw,
  Eye,
  EyeOff,
  Copy,
  ShieldAlert,
  KeyRound,
  Pencil,
} from "lucide-react";
import { useAuth, type AppRole, type SystemRole } from "@/lib/auth-context";
import { Modal } from "./staff";
import { EmptyState } from "@/components/EmptyState";
import { Pagination, usePagination } from "@/components/Pagination";
import { toast } from "sonner";
import { logAudit } from "@/lib/audit";
import { usePasswordMinLength } from "@/lib/use-password-min-length";

export const Route = createFileRoute("/_app/users")({
  head: () => ({
    meta: [
      { title: "User Profiles — Nurses Rota" },
      { name: "description", content: "Manage user accounts and role assignments." },
    ],
  }),
  component: UsersPage,
});

function isPasswordExpired(user: { password_changed_at: string | null; roles: string[] }, pwExpiryDays: number): boolean {
  if (!user.password_changed_at) return false;
  if (user.roles.includes("admin")) return false;
  const changedAt = new Date(user.password_changed_at);
  const expiresAt = new Date(changedAt.getTime() + pwExpiryDays * 24 * 60 * 60 * 1000);
  return expiresAt <= new Date();
}

const ROLE_BADGE_COLORS: Record<SystemRole, string> = {
  admin: "bg-red-100 text-red-700 border-red-200",
  cno: "bg-violet-100 text-violet-700 border-violet-200",
  chief_matron: "bg-blue-100 text-blue-700 border-blue-200",
  head_nurse: "bg-amber-100 text-amber-700 border-amber-200",
  hr_admin: "bg-teal-100 text-teal-700 border-teal-200",
  service_support: "bg-cyan-100 text-cyan-700 border-cyan-200",
  nurse: "bg-muted text-muted-foreground border-border",
  porter: "bg-orange-100 text-orange-700 border-orange-200",
  nursing_assistant: "bg-sky-100 text-sky-700 border-sky-200",
  surgical_nurse: "bg-indigo-100 text-indigo-700 border-indigo-200",
};

type ProfileRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  is_active: boolean;
  must_change_password: boolean;
  password_changed_at: string | null;
};

type RoleRow = { user_id: string; role: string };

type UserRow = ProfileRow & {
  roles: AppRole[];
  last_sign_in_at: string | null;
};

function UsersPage() {
  const { isAdmin, hasRole, allRoles, roleLabel } = useAuth();
  const ALL_ROLES = allRoles.map((r) => r.key);
  const isServiceSupport = hasRole("service_support");
  const canAccessPage = isAdmin || isServiceSupport;
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [showBulkCreate, setShowBulkCreate] = useState(false);
  const [filterStatus, setFilterStatus] = useState<"" | "active" | "inactive">("");
  const [filterRole, setFilterRole] = useState<AppRole | "">("");
  const [resetPasswordTarget, setResetPasswordTarget] = useState<UserRow | null>(null);
  const [editTarget, setEditTarget] = useState<UserRow | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const { data: users = [], isLoading } = useQuery({
    queryKey: ["user-profiles"],
    enabled: canAccessPage,
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

  const { data: pwExpiryDays = 30 } = useQuery<number>({
    queryKey: ["password-expiry-days"],
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      api
        .get<{ value: number }>("/portal-settings/password_expiry_days")
        .then((r) => (typeof r.value === "number" ? r.value : 30))
        .catch(() => 30),
  });

  async function addRole(userId: string, role: AppRole) {
    const target = users.find((u) => u.id === userId);
    const label = target?.full_name ?? target?.email ?? userId;
    try {
      await api.post("/user-roles", { user_id: userId, role });
      toast.success(`Granted: ${roleLabel(role)}`);
      void logAudit("Granted role", `${roleLabel(role)} → ${label}`);
      qc.invalidateQueries({ queryKey: ["user-profiles"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to grant role");
    }
  }

  async function removeRole(userId: string, role: AppRole) {
    const target = users.find((u) => u.id === userId);
    const label = target?.full_name ?? target?.email ?? userId;
    try {
      await api.del(`/user-roles?user_id=${userId}&role=${role}`);
      toast.success(`Revoked: ${roleLabel(role)}`);
      void logAudit("Revoked role", `${roleLabel(role)} → ${label}`);
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
      void logAudit("Deactivated login", user.full_name ?? user.email ?? user.id);
      void qc.invalidateQueries({ queryKey: ["user-profiles"] });
      void qc.invalidateQueries({ queryKey: ["profile-names"] });
      void qc.invalidateQueries({ queryKey: ["nurses"] });
      void qc.invalidateQueries({ queryKey: ["assignments"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to deactivate user");
    }
  }

  async function reactivateUser(user: UserRow) {
    try {
      await api.patch(`/auth/admin/users/${user.id}/unban`);
      toast.success("Login reactivated");
      void logAudit("Reactivated login", user.full_name ?? user.email ?? user.id);
      void qc.invalidateQueries({ queryKey: ["user-profiles"] });
      void qc.invalidateQueries({ queryKey: ["profile-names"] });
      void qc.invalidateQueries({ queryKey: ["nurses"] });
      void qc.invalidateQueries({ queryKey: ["assignments"] });
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
      void logAudit("Deleted user profile", user.full_name ?? user.email ?? user.id);
      qc.invalidateQueries({ queryKey: ["user-profiles"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to delete user");
    }
  }

  const filtered = users.filter((u) => {
    if (search.trim()) {
      const q = search.toLowerCase();
      if (!u.full_name?.toLowerCase().includes(q) && !u.email?.toLowerCase().includes(q))
        return false;
    }
    if (filterStatus === "active" && !u.is_active) return false;
    if (filterStatus === "inactive" && u.is_active) return false;
    if (filterRole && !u.roles.includes(filterRole)) return false;
    return true;
  });

  const activeFilters = [filterStatus, filterRole].filter(Boolean).length;
  const clearFilters = () => {
    setFilterStatus("");
    setFilterRole("");
    setSearch("");
  };

  useEffect(() => {
    setPage(1);
  }, [search, filterStatus, filterRole]);

  const { pageItems: pageUsers, totalPages } = usePagination(filtered, pageSize, page);

  if (!canAccessPage) {
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
        subtitle={`${filtered.length} of ${users.length} user${users.length !== 1 ? "s" : ""} · Manage role assignments`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
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

      {/* Filter bar */}
      <div className="bg-card border rounded-xl shadow-soft mb-4 p-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-44 flex-1">
          <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            type="search"
            placeholder="Search by name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-9 pl-9 pr-3 rounded-md bg-muted/60 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <select
          aria-label="Filter by status"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value as "" | "active" | "inactive")}
          className="h-9 px-2 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        <select
          aria-label="Filter by role"
          value={filterRole}
          onChange={(e) => setFilterRole(e.target.value as AppRole | "")}
          className="h-9 px-2 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">All roles</option>
          {ALL_ROLES.map((r) => (
            <option key={r} value={r}>
              {roleLabel(r)}
            </option>
          ))}
        </select>
        {(activeFilters > 0 || search) && (
          <button
            type="button"
            onClick={clearFilters}
            className="h-9 px-3 rounded-md border text-sm inline-flex items-center gap-1.5 hover:bg-muted text-muted-foreground"
          >
            <X className="h-3.5 w-3.5" /> Clear
            {activeFilters > 0 && (
              <span className="ml-0.5 h-4 w-4 rounded-full bg-primary text-primary-foreground text-[10px] grid place-items-center font-bold">
                {activeFilters}
              </span>
            )}
          </button>
        )}
      </div>

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
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-3 font-semibold sticky left-0 bg-muted/50 z-10">
                    Name
                  </th>
                  <th className="text-left px-4 py-3 font-semibold hidden sm:table-cell">Email</th>
                  <th className="text-left px-4 py-3 font-semibold">Roles</th>
                  <th className="text-left px-4 py-3 font-semibold">Add Role</th>
                  <th className="text-left px-4 py-3 font-semibold">Status</th>
                  <th className="text-right px-4 py-3 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                      No users match the current filters
                    </td>
                  </tr>
                ) : (
                  pageUsers.map((u) => (
                    <UserRowItem
                      key={u.id}
                      user={u}
                      pwExpiryDays={pwExpiryDays}
                      isAdmin={isAdmin}
                      onAdd={addRole}
                      onRemove={removeRole}
                      onDelete={deleteUser}
                      onDeactivate={deactivateUser}
                      onReactivate={reactivateUser}
                      onResetPassword={(u) => setResetPasswordTarget(u)}
                      onEdit={(u) => setEditTarget(u)}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
          <Pagination
            page={page}
            totalPages={totalPages}
            pageSize={pageSize}
            totalItems={filtered.length}
            onPage={setPage}
            onPageSize={(s) => {
              setPageSize(s);
              setPage(1);
            }}
          />
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

      {resetPasswordTarget && (
        <ResetPasswordModal
          name={resetPasswordTarget.full_name ?? resetPasswordTarget.email ?? "User"}
          userId={resetPasswordTarget.id}
          onClose={() => setResetPasswordTarget(null)}
        />
      )}

      {editTarget && (
        <EditProfileModal
          user={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["user-profiles"] });
            qc.invalidateQueries({ queryKey: ["nurses"] });
            setEditTarget(null);
          }}
        />
      )}
    </div>
  );
}

function CreateUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { allRoles, roleLabel } = useAuth();
  const ALL_ROLES = allRoles.map((r) => r.key);
  const [form, setForm] = useState({
    fullName: "",
    email: "",
    password: "",
    role: "nurse" as AppRole,
  });
  const [busy, setBusy] = useState(false);
  const minPasswordLength = usePasswordMinLength();

  async function submit(e: React.SyntheticEvent) {
    e.preventDefault();
    if (form.password.length < minPasswordLength) {
      toast.error(`Password must be at least ${minPasswordLength} characters`);
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
      toast.success(`User created; account email queued for ${form.email}`);
      void logAudit(
        "Created user login",
        `${form.fullName || form.email} (${form.email}) — ${roleLabel(form.role)}`,
      );
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
      <div className="relative bg-card rounded-xl shadow-xl border w-full max-w-sm p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-lg">Create User</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close"
            className="h-8 w-8 grid place-items-center rounded-md hover:bg-muted text-muted-foreground"
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
              minLength={minPasswordLength}
              placeholder={`Min. ${minPasswordLength} characters`}
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              className={inputCls}
            />
            <p className="text-xs text-muted-foreground mt-1">
              The user will receive this password by email after the account is created.
            </p>
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
                  {roleLabel(r)}
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
  const [password, setPassword] = useState("RotaLogin@123");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BulkResult | null>(null);
  const minPasswordLength = usePasswordMinLength();

  const inputCls =
    "w-full h-10 px-3 rounded-md border bg-background text-sm outline-none focus:ring-2 focus:ring-ring";

  async function submit(e: React.SyntheticEvent) {
    e.preventDefault();
    if (password.length < minPasswordLength) {
      toast.error(`Password must be at least ${minPasswordLength} characters`);
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<BulkResult>("/auth/admin/bulk-create-users", {
        default_password: password,
      });
      setResult(res);
      if (res.created.length > 0) {
        toast.success(`${res.created.length} login${res.created.length !== 1 ? "s" : ""} created`);
        void logAudit(
          "Bulk-generated logins",
          `${res.created.length} created, ${res.skipped.length} skipped`,
        );
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
      <div className="relative bg-card rounded-xl shadow-xl border w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-lg flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" /> Generate Logins
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="h-8 w-8 grid place-items-center rounded-md hover:bg-muted text-muted-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {!result ? (
          <>
            <p className="text-sm text-muted-foreground">
              Creates login accounts for all staff in the Staff list who have an email address and
              don&apos;t already have an account (active or deactivated). Each person&apos;s system
              role is derived automatically from their job role. They will be prompted to change
              their password on first login.
            </p>

            <form onSubmit={submit} className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1">
                  Default password <span className="text-destructive">*</span>
                </label>
                <input
                  type="text"
                  required
                  minLength={minPasswordLength}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputCls}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  All new accounts will use this password. Staff will receive it by email and must
                  change it on first login.
                </p>
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

function generatePassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function ResetPasswordModal({
  name,
  userId,
  onClose,
}: {
  name: string;
  userId: string;
  onClose: () => void;
}) {
  const [password, setPassword] = useState(() => generatePassword());
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);
  const minPasswordLength = usePasswordMinLength();

  async function copyToClipboard() {
    await navigator.clipboard.writeText(password);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < minPasswordLength)
      return toast.error(`Password must be at least ${minPasswordLength} characters`);
    setBusy(true);
    try {
      await api.patch(`/auth/admin/users/${userId}/reset-password`, { password });
      void logAudit("Reset user password", name);
      setDone(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reset password");
    } finally {
      setBusy(false);
    }
  }

  const cls =
    "w-full h-10 px-3 rounded-md border bg-background text-sm outline-none focus:ring-2 focus:ring-ring";

  return (
    <Modal title="Reset Password" onClose={onClose}>
      {done ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
            <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-emerald-800">Password reset successfully</p>
              <p className="text-xs text-emerald-700 mt-0.5">
                {name} will be prompted to change their password on next login.
              </p>
            </div>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1.5">
              Temporary password — share securely:
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 h-10 px-3 rounded-md border bg-muted text-sm font-mono flex items-center">
                {password}
              </code>
              <button
                type="button"
                onClick={copyToClipboard}
                className="h-10 px-3 rounded-md border bg-card text-sm hover:bg-muted inline-flex items-center gap-1.5"
              >
                <Copy className="h-3.5 w-3.5" />
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-full h-10 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
          >
            Done
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <ShieldAlert className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-800">
              Resetting <strong>{name}</strong>&apos;s password will require them to set a new
              password on their next login.
            </p>
          </div>
          <div>
            <label className="text-sm font-medium block mb-1.5">New temporary password</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={minPasswordLength}
                  required
                  className={cls + " pr-9"}
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <button
                type="button"
                onClick={() => setPassword(generatePassword())}
                className="h-10 px-3 rounded-md border bg-card text-sm hover:bg-muted inline-flex items-center gap-1.5 shrink-0"
                title="Generate new password"
              >
                <RotateCcw className="h-3.5 w-3.5" /> Generate
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">Minimum {minPasswordLength} characters.</p>
          </div>
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 h-10 rounded-md border bg-background text-sm font-medium hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || password.length < minPasswordLength}
              className="flex-1 h-10 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 inline-flex items-center justify-center gap-2"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <KeyRound className="h-4 w-4" />
              )}
              Reset password
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function EditProfileModal({
  user,
  onClose,
  onSaved,
}: {
  user: UserRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [fullName, setFullName] = useState(user.full_name ?? "");
  const [email, setEmail] = useState(user.email ?? "");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!fullName.trim()) {
      toast.error("Name is required");
      return;
    }
    if (!email.trim()) {
      toast.error("Email is required");
      return;
    }
    setBusy(true);
    try {
      await api.patch(`/auth/admin/users/${user.id}/profile`, {
        full_name: fullName.trim(),
        email: email.trim(),
      });
      toast.success("Profile updated");
      void logAudit(
        "Edited user profile",
        `${user.full_name ?? user.email} → ${fullName.trim()} (${email.trim()})`,
      );
      onSaved();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update profile");
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "w-full h-10 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring";

  return (
    <Modal title="Edit Profile" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Full Name
          </label>
          <input
            className={inputCls}
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Full name"
            required
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Email
          </label>
          <input
            type="email"
            className={inputCls}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="email@example.com"
            required
          />
        </div>
        <p className="text-xs text-muted-foreground">
          If this user has a nurse record, their name and email there will be updated too.
        </p>
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 h-10 rounded-md border bg-background text-sm font-medium hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="flex-1 h-10 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 inline-flex items-center justify-center gap-2"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />}
            Save changes
          </button>
        </div>
      </form>
    </Modal>
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
  pwExpiryDays,
  isAdmin,
  onAdd,
  onRemove,
  onDelete,
  onDeactivate,
  onReactivate,
  onResetPassword,
  onEdit,
}: {
  user: UserRow;
  pwExpiryDays: number;
  isAdmin: boolean;
  onAdd: (id: string, role: AppRole) => void;
  onRemove: (id: string, role: AppRole) => void;
  onDelete: (user: UserRow) => void;
  onDeactivate: (user: UserRow) => void;
  onReactivate: (user: UserRow) => void;
  onResetPassword: (user: UserRow) => void;
  onEdit: (user: UserRow) => void;
}) {
  const { allRoles, roleLabel } = useAuth();
  const ALL_ROLES = allRoles.map((r) => r.key);
  const [adding, setAdding] = useState<AppRole | "">("");
  // Service Support cannot assign or revoke the admin role
  const assignableRoles = isAdmin ? ALL_ROLES : ALL_ROLES.filter((r) => r !== "admin");
  const available = assignableRoles.filter((r) => !user.roles.includes(r));

  return (
    <tr className="border-t hover:bg-muted/30">
      {/* Name */}
      <td className="px-4 py-3 sticky left-0 bg-card z-10">
        <p className="font-medium text-sm">{user.full_name ?? "Unnamed"}</p>
        {user.must_change_password && (
          <span
            className="inline-flex items-center gap-0.5 text-[10px] bg-amber-100 text-amber-700 border border-amber-200 rounded-full px-1.5 py-0.5 font-medium mt-0.5"
            title="User must change password on next login"
          >
            <AlertTriangle className="h-2.5 w-2.5" />
            Needs PW change
          </span>
        )}
        {!user.must_change_password && isPasswordExpired(user, pwExpiryDays) && (
          <span
            className="inline-flex items-center gap-0.5 text-[10px] bg-red-100 text-red-700 border border-red-200 rounded-full px-1.5 py-0.5 font-medium mt-0.5"
            title="Password has expired — user cannot log in until admin resets it"
          >
            <AlertTriangle className="h-2.5 w-2.5" />
            Password expired
          </span>
        )}
      </td>

      {/* Email */}
      <td className="px-4 py-3 text-xs text-muted-foreground hidden sm:table-cell">
        {user.email ?? "—"}
      </td>

      {/* Roles */}
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {user.roles.length === 0 ? (
            <span className="text-xs text-muted-foreground italic">No roles</span>
          ) : (
            user.roles.map((r) => (
              <span
                key={r}
                className={`inline-flex items-center gap-1 rounded-full border text-[11px] px-2 py-0.5 ${ROLE_BADGE_COLORS[r as SystemRole] ?? "bg-slate-100 text-slate-700 border-slate-200"}`}
              >
                {roleLabel(r)}
                {(isAdmin || r !== "admin") && (
                  <button
                    type="button"
                    onClick={() => onRemove(user.id, r)}
                    className="hover:text-destructive -my-1.5 -mr-1 p-1.5 grid place-items-center"
                    title={`Revoke ${roleLabel(r)}`}
                  >
                    <Trash2 className="h-2.5 w-2.5" />
                  </button>
                )}
              </span>
            ))
          )}
        </div>
      </td>

      {/* Add role */}
      <td className="px-4 py-3">
        {available.length > 0 && (
          <div className="flex items-center gap-1.5">
            <select
              aria-label="Add role"
              value={adding}
              onChange={(e) => setAdding(e.target.value as AppRole | "")}
              className="text-xs h-7 rounded-md border bg-background px-2 outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Add role…</option>
              {available.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
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
              className="h-7 px-2 rounded-md bg-primary text-primary-foreground text-xs font-medium inline-flex items-center gap-0.5 disabled:opacity-40"
            >
              <Plus className="h-3 w-3" /> Add
            </button>
          </div>
        )}
      </td>

      {/* Status */}
      <td className="px-4 py-3">
        {user.is_active ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-success font-medium">
            <CheckCircle2 className="h-3.5 w-3.5" /> Active
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] text-destructive font-medium">
            <UserX className="h-3.5 w-3.5" /> Inactive
          </span>
        )}
      </td>

      {/* Actions */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5 justify-end">
          <button
            type="button"
            onClick={() => onEdit(user)}
            title="Edit profile"
            className="h-8 w-8 grid place-items-center rounded-md border border-transparent hover:border-primary/40 hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          {user.is_active ? (
            <>
              <button
                type="button"
                onClick={() => onResetPassword(user)}
                title="Reset password"
                className="h-8 w-8 grid place-items-center rounded-md border border-transparent hover:border-amber-400/40 hover:bg-amber-50 text-muted-foreground hover:text-amber-700 transition-colors"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onDeactivate(user)}
                title="Deactivate login"
                className="h-8 w-8 grid place-items-center rounded-md border border-transparent hover:border-destructive/40 hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
              >
                <UserX className="h-3.5 w-3.5" />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => onReactivate(user)}
              title="Reactivate login"
              className="h-8 w-8 grid place-items-center rounded-md border border-transparent hover:border-success/40 hover:bg-success/10 text-muted-foreground hover:text-success transition-colors"
            >
              <UserCheck className="h-3.5 w-3.5" />
            </button>
          )}
          {isAdmin && (
            <button
              type="button"
              onClick={() => onDelete(user)}
              title="Delete user"
              className="h-8 w-8 grid place-items-center rounded-md border border-transparent hover:border-destructive/40 hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
