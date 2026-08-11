/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, getToken, clearToken } from "@/lib/api";
import { toast } from "sonner";

// The 10 permanent, undeletable roles seeded into the `roles` table
// (nurse-api/migrations/022_dynamic_roles.sql) — many workflow checks
// elsewhere in the app (e.g. the rota approval pipeline) compare activeRole
// against these literal strings, so they must never be renamed or removed.
export type SystemRole =
  | "admin"
  | "cno"
  | "chief_matron"
  | "head_nurse"
  | "hr_admin"
  | "service_support"
  | "nurse"
  | "porter"
  | "nursing_assistant"
  | "surgical_nurse";

// AppRole additionally accepts any admin-created custom role key. The
// `(string & {})` branding keeps IDE autocomplete suggesting the 10 known
// SystemRole literals while still accepting arbitrary custom role strings —
// unlike a plain `string`, which would lose autocomplete entirely.
export type AppRole = SystemRole | (string & {});

export type RoleDef = {
  key: string;
  label: string;
  description: string;
  is_system: boolean;
  usage_count?: number;
};

export interface ApiUser {
  id: string;
  email: string;
  full_name: string | null;
  roles: AppRole[];
  must_change_password: boolean;
  password_expires_in_days: number | null;
  nurse_id: string | null;
  nurse_facility: string | null;
  // Individually-granted capability keys, additive on top of whatever
  // capabilities this user's role(s) already give them — see
  // migrations/035_user_capability_overrides.sql. Enforced instantly
  // server-side; only reflected here after this user's next login/`/me`
  // refetch (same staleness convention already disclosed for role grants
  // in users.tsx: "Role changes take effect on next login").
  capability_overrides: string[];
}

interface AuthCtx {
  user: ApiUser | null;
  roles: AppRole[];
  activeRole: AppRole | null;
  fullName: string | null;
  nurseFacility: string | null;
  nurseId: string | null;
  loading: boolean;
  needsRoleSelection: boolean;
  mustChangePassword: boolean;
  clearMustChangePassword: () => void;
  passwordExpiresInDays: number | null;
  clearPasswordExpiry: () => void;
  selectRole: (role: AppRole) => void;
  hasRole: (r: AppRole) => boolean;
  hasAnyRole: (rs: AppRole[]) => boolean;
  isAdmin: boolean;
  // True when this login is linked to a nurses/roster record AND its active
  // role isn't one of the always-management roles — the general "show the
  // personal/individual view instead of the facility-wide management view"
  // signal, used by Dashboard/Shift/Rota/Locum. Works for custom roles too,
  // since it's driven by the nurse link rather than a hardcoded role list.
  isStaffAccount: boolean;
  // ── Dynamic role registry (system + admin-created custom roles) ───────────
  allRoles: RoleDef[];
  roleLabel: (key: string) => string;
  roleDescription: (key: string) => string;
  // ── Capability flags (all read from the permissions matrix) ───────────────
  canManageRoles: boolean;
  canDelete: boolean;
  canManageStaff: boolean;
  canManageWards: boolean;
  canEditRota: boolean;
  canAutoGenerate: boolean;
  canSubmitApproval: boolean;
  canApproveRota: boolean;
  canPublishRota: boolean;
  canRevertPublished: boolean;
  canRequestRotaEditAccess: boolean;
  canGrantRotaEditAccess: boolean;
  canManageLeaveEntitlements: boolean;
  canManageLeaveEntitlementCaps: boolean;
  canApproveLeave: boolean;
  canApproveMatronLeave: boolean;
  canViewAllLeaveRequests: boolean;
  canRequestLeave: boolean;
  canRequestShiftSwitch: boolean;
  canApproveShiftSwitch: boolean;
  canCreateLogin: boolean;
  canEditTargetHours: boolean;
  canPrintStaff: boolean;
  canPrintSchedule: boolean;
  canRequestLocum: boolean;
  canApproveLocum: boolean;
  canSendLocumInvites: boolean;
  canViewLocumHours: boolean;
  canViewLocumRequests: boolean;
  canViewReports: boolean;
  canViewAudit: boolean;
  signOut: () => void;
}

const Ctx = createContext<AuthCtx | null>(null);

export const selectedRoleStorageKey = (uid: string) => `nurse_rota_role_${uid}`;

export function rememberSelectedRole(uid: string, role: AppRole) {
  sessionStorage.setItem(selectedRoleStorageKey(uid), role);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<ApiUser | null>(null);
  const [capabilities, setCapabilities] = useState<{ key: string; roles: AppRole[] }[]>([]);
  const [allRoles, setAllRoles] = useState<RoleDef[]>([]);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [activeRole, setActiveRole] = useState<AppRole | null>(null);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [passwordExpiresInDays, setPasswordExpiresInDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api
      .get<ApiUser>("/auth/me")
      .then((me) => {
        applyUser(me);
      })
      .catch(() => {
        clearToken();
      })
      .finally(() => setLoading(false));
  }, []);

  // Pull capability overrides from DB once on mount.
  useEffect(() => {
    if (!getToken()) return;
    api
      .get<{ key: string; value: { key: string; roles: AppRole[] }[] }>(
        "/portal-settings/capabilities",
      )
      .then(({ value }) => {
        if (Array.isArray(value)) setCapabilities(value);
      })
      .catch(() => {
        /* non-critical */
      });
  }, []);

  // Re-fetch capabilities from DB when the permissions page saves.
  useEffect(() => {
    const handler = () => {
      api
        .get<{ key: string; value: { key: string; roles: AppRole[] }[] }>(
          "/portal-settings/capabilities",
        )
        .then(({ value }) => {
          if (Array.isArray(value)) setCapabilities(value);
        })
        .catch(() => {});
    };
    window.addEventListener("capabilities-changed", handler);
    return () => window.removeEventListener("capabilities-changed", handler);
  }, []);

  // Pull the dynamic role registry (system + custom roles) once a token
  // exists, and re-fetch whenever the /roles admin page creates/edits/deletes
  // a role. Re-runs on `user` (not just on mount) so a *fresh* login — where
  // no token existed yet at initial mount — still picks this up in time for
  // the login page's role-selection screen to show real custom-role labels
  // instead of falling back to the raw key.
  useEffect(() => {
    if (!getToken()) return;
    const fetchRoles = () => {
      api
        .get<RoleDef[]>("/roles")
        .then((rows) => setAllRoles(rows))
        .catch(() => {
          /* non-critical — roleLabel falls back to ROLE_LABELS/raw key */
        });
    };
    fetchRoles();
    window.addEventListener("roles-changed", fetchRoles);
    return () => window.removeEventListener("roles-changed", fetchRoles);
  }, [user]);

  // Auto-logout after 1 hour of inactivity. Warns at 55 minutes.
  useEffect(() => {
    if (!user) return;

    const IDLE_MS = 60 * 60 * 1000; // 1 hour
    const WARN_MS = 55 * 60 * 1000; // warn at 55 min

    function doLogout() {
      toast.dismiss("idle-warn");
      sessionStorage.removeItem(selectedRoleStorageKey(user!.id));
      clearToken();
      setUser(null);
      setRoles([]);
      setActiveRole(null);
      setMustChangePassword(false);
      toast.info("You have been logged out due to inactivity.");
    }

    function doWarn() {
      toast.warning(
        "You will be logged out in 5 minutes due to inactivity. Move the mouse or press a key to stay logged in.",
        {
          id: "idle-warn",
          duration: 5 * 60 * 1000,
        },
      );
    }

    let logoutTimer = setTimeout(doLogout, IDLE_MS);
    let warnTimer = setTimeout(doWarn, WARN_MS);
    let throttle: ReturnType<typeof setTimeout> | null = null;

    function onActivity() {
      // Reset timers at most once every 10 seconds to avoid overhead from mousemove
      if (throttle) return;
      throttle = setTimeout(() => {
        throttle = null;
        clearTimeout(logoutTimer);
        clearTimeout(warnTimer);
        toast.dismiss("idle-warn");
        warnTimer = setTimeout(doWarn, WARN_MS);
        logoutTimer = setTimeout(doLogout, IDLE_MS);
      }, 10_000);
    }

    const EVENTS = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"] as const;
    EVENTS.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));

    return () => {
      clearTimeout(logoutTimer);
      clearTimeout(warnTimer);
      if (throttle) clearTimeout(throttle);
      EVENTS.forEach((e) => window.removeEventListener(e, onActivity));
      toast.dismiss("idle-warn");
    };
  }, [user]);

  function applyUser(me: ApiUser) {
    setUser(me);
    setRoles(me.roles);
    setMustChangePassword(me.must_change_password);
    setPasswordExpiresInDays(me.password_expires_in_days ?? null);

    if (me.roles.length === 1) {
      setActiveRole(me.roles[0]);
    } else if (me.roles.length > 1) {
      const stored = sessionStorage.getItem(selectedRoleStorageKey(me.id)) as AppRole | null;
      if (stored && me.roles.includes(stored)) {
        setActiveRole(stored);
      } else {
        setActiveRole(null);
      }
    } else {
      setActiveRole(null);
    }
  }

  // Exposed so login.tsx can hydrate the context after a successful login.
  function setLoggedInUser(me: ApiUser) {
    applyUser(me);
  }

  function selectRole(role: AppRole) {
    if (user) rememberSelectedRole(user.id, role);
    setActiveRole(role);
  }

  function clearMustChangePassword() {
    setMustChangePassword(false);
  }

  function clearPasswordExpiry() {
    setPasswordExpiresInDays(null);
  }

  function signOut() {
    if (user) sessionStorage.removeItem(selectedRoleStorageKey(user.id));
    clearToken();
    setUser(null);
    setRoles([]);
    setActiveRole(null);
    setMustChangePassword(false);
    setPasswordExpiresInDays(null);
  }

  const ar = activeRole;
  const hasRole = (r: AppRole) => ar === r;
  const hasAnyRole = (rs: AppRole[]) => ar !== null && rs.includes(ar);
  const cap = (key: string, defaults: AppRole[]) => {
    const roles = capabilities.find((c) => c.key === key)?.roles ?? defaults;
    if (ar !== null && roles.includes(ar)) return true;
    return user?.capability_overrides.includes(key) ?? false;
  };
  // Roles that are never "staff on the roster with their own shifts to track,"
  // even when the login happens to also be linked to a nurses record (e.g. an
  // HR admin created via Staff > Create Login for a real nurse row) — see
  // src/routes/_app/staff.tsx's CreateLoginModal, which explicitly allows
  // assigning admin/cno/hr_admin/chief_matron to a nurse-linked account.
  // chief_matron and head_nurse are deliberately NOT in this list: they work
  // regular shifts and are expected to see their personal schedule alongside
  // their management alerts (see NurseDashboard).
  const ALWAYS_MANAGEMENT_ROLES: readonly string[] = [
    "admin",
    "cno",
    "hr_admin",
    "service_support",
  ];
  const isStaffAccount = !!(user?.nurse_id && ar && !ALWAYS_MANAGEMENT_ROLES.includes(ar));

  const roleLabel = (key: string) =>
    allRoles.find((r) => r.key === key)?.label ?? ROLE_LABELS[key as SystemRole] ?? key;
  const roleDescription = (key: string) =>
    allRoles.find((r) => r.key === key)?.description ?? ROLE_DESCRIPTIONS[key as SystemRole] ?? "";

  const value: AuthCtx = {
    user,
    roles,
    activeRole,
    fullName: user?.full_name ?? null,
    nurseFacility: user?.nurse_facility ?? null,
    nurseId: user?.nurse_id ?? null,
    loading,
    needsRoleSelection: roles.length > 1 && activeRole === null,
    mustChangePassword,
    clearMustChangePassword,
    passwordExpiresInDays,
    clearPasswordExpiry,
    selectRole,
    hasRole,
    hasAnyRole,
    isAdmin: ar === "admin",
    isStaffAccount,
    allRoles,
    roleLabel,
    roleDescription,
    canManageRoles: cap("manage_roles", ["admin", "service_support"]),
    canDelete: cap("delete_staff", ["admin"]),
    canManageStaff: cap("manage_staff", ["admin", "hr_admin"]),
    canManageWards: cap("manage_wards", ["admin", "cno"]),
    canEditRota: cap("edit_rota", ["admin", "chief_matron", "head_nurse"]),
    // Rota generation is now automatic (T-19) — a manual trigger is only ever
    // an admin emergency override, not a normal head_nurse action.
    canAutoGenerate: cap("auto_generate", ["admin"]),
    canSubmitApproval: cap("submit_approval", ["admin", "head_nurse"]),
    canApproveRota: cap("approve_rota", ["admin", "cno"]),
    canPublishRota: cap("publish_rota", ["admin", "cno"]),
    canRevertPublished: cap("revert_published", ["admin"]),
    canRequestRotaEditAccess: cap("request_rota_edit_access", ["admin", "head_nurse"]),
    canGrantRotaEditAccess: cap("grant_rota_edit_access", ["admin", "cno"]),
    canManageLeaveEntitlements: cap("manage_leave_entitlements", ["admin", "hr_admin"]),
    canManageLeaveEntitlementCaps: cap("manage_leave_entitlement_caps", ["admin"]),
    canApproveLeave: cap("approve_leave", ["admin", "chief_matron"]),
    canApproveMatronLeave: cap("approve_matron_leave", ["admin", "cno"]),
    // View-only visibility into ALL leave/shift-switch requests, separate from
    // the power to approve them — lets support-tier roles (hr_admin,
    // service_support) see everything without being able to action it.
    canViewAllLeaveRequests: cap("view_all_leave_requests", [
      "admin",
      "cno",
      "chief_matron",
      "head_nurse",
      "hr_admin",
      "service_support",
    ]),
    canRequestLeave: cap("request_leave", [
      "admin",
      "chief_matron",
      "head_nurse",
      "nurse",
      "surgical_nurse",
      "porter",
      "nursing_assistant",
    ]),
    canRequestShiftSwitch: cap("request_shift_switch", ["admin", "cno", "chief_matron"]),
    canApproveShiftSwitch: cap("approve_shift_switch", ["admin", "cno"]),
    canCreateLogin: ar === "admin",
    canEditTargetHours: cap("edit_target_hours", ["admin", "cno"]),
    canPrintStaff: cap("print_staff_list", [
      "admin",
      "cno",
      "chief_matron",
      "head_nurse",
      "hr_admin",
      "service_support",
    ]),
    canPrintSchedule: cap("print_schedule", [
      "admin",
      "cno",
      "chief_matron",
      "head_nurse",
      "hr_admin",
      "service_support",
    ]),
    canRequestLocum: cap("request_locum", ["admin", "chief_matron"]),
    canApproveLocum: cap("approve_locum", ["admin", "cno"]),
    canSendLocumInvites: cap("send_locum_invites", ["admin", "chief_matron"]),
    canViewLocumHours: cap("view_locum_hours", ["admin", "cno", "chief_matron", "hr_admin"]),
    canViewLocumRequests: cap("view_locum_requests", [
      "admin",
      "cno",
      "chief_matron",
      "head_nurse",
    ]),
    canViewReports: cap("view_reports", [
      "admin",
      "cno",
      "chief_matron",
      "head_nurse",
      "hr_admin",
      "service_support",
    ]),
    canViewAudit: cap("view_audit", ["admin", "service_support"]),
    signOut,
  };

  return (
    <Ctx.Provider
      value={{ ...value, setLoggedInUser } as AuthCtx & { setLoggedInUser: (u: ApiUser) => void }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth must be used within AuthProvider");
  return c;
}

export function useAuthInternal() {
  const c = useContext(Ctx) as (AuthCtx & { setLoggedInUser: (u: ApiUser) => void }) | null;
  if (!c) throw new Error("useAuthInternal must be used within AuthProvider");
  return c;
}

export const NURSE_TIER_ROLES: SystemRole[] = [
  "nurse",
  "porter",
  "nursing_assistant",
  "surgical_nurse",
];

export const ROLE_LABELS: Record<SystemRole, string> = {
  admin: "System Administrator",
  cno: "Chief Nursing Officer",
  chief_matron: "Chief Matron",
  head_nurse: "Head Nurse",
  hr_admin: "HR / Admin",
  service_support: "Service Support",
  nurse: "Nurse",
  porter: "Porter",
  nursing_assistant: "Nursing Assistant",
  surgical_nurse: "Surgical Nurse",
};

export const ROLE_DESCRIPTIONS: Record<SystemRole, string> = {
  admin: "Full system access — manage staff, wards, users and all settings",
  cno: "Publish rotas, manage shift switches and oversee all facilities",
  chief_matron: "Edit rotas, manage leave and ward staffing",
  head_nurse: "Provide coverage across wards, manage schedules and approve leave",
  hr_admin: "Manage staff records, leave requests and HR administration",
  service_support: "Manage user accounts, reset passwords, assign roles and view audit logs",
  nurse: "View your schedule, submit leave requests and access rota",
  porter: "View your schedule, submit leave requests and access rota",
  nursing_assistant: "View your schedule, submit leave requests and access rota",
  surgical_nurse: "Surgical Unit — view your schedule, submit leave requests and access rota",
};
