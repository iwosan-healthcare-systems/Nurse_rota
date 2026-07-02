/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, getToken, clearToken } from "@/lib/api";

export type AppRole = "admin" | "cno" | "chief_matron" | "head_nurse" | "hr_admin" | "nurse" | "porter";

export interface ApiUser {
  id: string;
  email: string;
  full_name: string | null;
  roles: AppRole[];
  must_change_password: boolean;
  nurse_id: string | null;
  nurse_facility: string | null;
}

const CAPABILITIES_KEY = "nurse_rota_capabilities";

function capabilityRoles(key: string, defaults: AppRole[]): AppRole[] {
  try {
    const raw = localStorage.getItem(CAPABILITIES_KEY);
    if (!raw) return defaults;
    const saved = JSON.parse(raw) as { key: string; roles: AppRole[] }[];
    return saved.find((s) => s.key === key)?.roles ?? defaults;
  } catch {
    return defaults;
  }
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
  selectRole: (role: AppRole) => void;
  hasRole: (r: AppRole) => boolean;
  hasAnyRole: (rs: AppRole[]) => boolean;
  isAdmin: boolean;
  // ── Capability flags (all read from the permissions matrix) ───────────────
  canManageRoles: boolean;
  canDelete: boolean;
  canManageStaff: boolean;
  canManageWards: boolean;
  canEditRota: boolean;
  canAutoGenerate: boolean;
  canSubmitApproval: boolean;
  canApproveChiefMatron: boolean;
  canApproveCno: boolean;
  canPublishRota: boolean;
  canRevertPublished: boolean;
  canApproveLeave: boolean;
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
  const [capabilitiesVersion, setCapabilitiesVersion] = useState(0);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [activeRole, setActiveRole] = useState<AppRole | null>(null);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api.get<ApiUser>('/auth/me')
      .then((me) => {
        applyUser(me);
      })
      .catch(() => {
        clearToken();
      })
      .finally(() => setLoading(false));
  }, []);

  // Pull capability overrides from API once on mount.
  useEffect(() => {
    if (!getToken()) return;
    api
      .get<{ key: string; value: { key: string; roles: AppRole[] }[] }>("/portal-settings/capabilities")
      .then(({ value }) => {
        if (value && Array.isArray(value)) {
          localStorage.setItem(CAPABILITIES_KEY, JSON.stringify(value));
          setCapabilitiesVersion((v) => v + 1);
        }
      })
      .catch(() => {
        /* non-critical */
      });
  }, []);

  // Re-read capabilities from localStorage when permissions page saves.
  useEffect(() => {
    const handler = () => setCapabilitiesVersion((v) => v + 1);
    window.addEventListener("capabilities-changed", handler);
    return () => window.removeEventListener("capabilities-changed", handler);
  }, []);

  function applyUser(me: ApiUser) {
    setUser(me);
    setRoles(me.roles);
    setMustChangePassword(me.must_change_password);

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

  function signOut() {
    if (user) sessionStorage.removeItem(selectedRoleStorageKey(user.id));
    clearToken();
    setUser(null);
    setRoles([]);
    setActiveRole(null);
    setMustChangePassword(false);
  }

  const ar = activeRole;
  void capabilitiesVersion;
  const hasRole = (r: AppRole) => ar === r;
  const hasAnyRole = (rs: AppRole[]) => ar !== null && rs.includes(ar);
  const cap = (key: string, defaults: AppRole[]) =>
    ar !== null && capabilityRoles(key, defaults).includes(ar);

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
    selectRole,
    hasRole,
    hasAnyRole,
    isAdmin: ar === "admin",
    canManageRoles: cap("manage_roles", ["admin"]),
    canDelete: cap("delete_staff", ["admin"]),
    canManageStaff: cap("manage_staff", ["admin", "cno", "chief_matron", "head_nurse", "hr_admin"]),
    canManageWards: cap("manage_wards", ["admin", "cno", "chief_matron", "head_nurse", "hr_admin"]),
    canEditRota: cap("edit_rota", ["admin", "cno", "chief_matron", "head_nurse", "hr_admin"]),
    canAutoGenerate: cap("auto_generate", ["admin", "cno", "chief_matron"]),
    canSubmitApproval: cap("submit_approval", ["admin", "cno", "chief_matron", "head_nurse", "hr_admin"]),
    canApproveChiefMatron: cap("approve_chief_matron", ["admin", "chief_matron"]),
    canApproveCno: cap("approve_cno", ["admin", "cno"]),
    canPublishRota: cap("publish_rota", ["admin", "cno"]),
    canRevertPublished: cap("revert_published", ["admin"]),
    canApproveLeave: cap("approve_leave", ["admin", "cno", "chief_matron", "head_nurse", "hr_admin"]),
    canRequestLeave: cap("request_leave", ["admin", "cno", "chief_matron", "head_nurse", "hr_admin", "nurse", "porter"]),
    canRequestShiftSwitch: cap("request_shift_switch", ["admin", "chief_matron"]),
    canApproveShiftSwitch: cap("approve_shift_switch", ["admin", "cno"]),
    canCreateLogin: ar === "admin",
    canEditTargetHours: cap("edit_target_hours", ["admin"]),
    canPrintStaff: cap("print_staff_list", ["admin", "cno", "chief_matron", "head_nurse", "hr_admin"]),
    canPrintSchedule: cap("print_schedule", ["admin", "cno", "chief_matron", "head_nurse", "hr_admin"]),
    canRequestLocum: cap("request_locum", ["admin", "chief_matron"]),
    canApproveLocum: cap("approve_locum", ["admin", "cno"]),
    canSendLocumInvites: cap("send_locum_invites", ["admin", "chief_matron"]),
    canViewLocumHours: cap("view_locum_hours", ["admin", "cno", "chief_matron"]),
    canViewReports: cap("view_reports", ["admin", "cno", "chief_matron", "hr_admin"]),
    canViewAudit: cap("view_audit", ["admin", "cno"]),
    signOut,
  };

  return (
    <Ctx.Provider value={{ ...value, setLoggedInUser } as AuthCtx & { setLoggedInUser: (u: ApiUser) => void }}>
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

export const ROLE_LABELS: Record<AppRole, string> = {
  admin: "System Administrator",
  cno: "Chief Nursing Officer",
  chief_matron: "Chief Matron",
  head_nurse: "Head Nurse",
  hr_admin: "HR / Admin",
  nurse: "Nurse",
  porter: "Porter",
};

export const ROLE_DESCRIPTIONS: Record<AppRole, string> = {
  admin: "Full system access — manage staff, wards, users and all settings",
  cno: "Approve rotas, manage shift switches and oversee all facilities",
  chief_matron: "Review and approve rotas, manage leave and ward staffing",
  head_nurse: "Provide coverage across wards, manage schedules and approve leave",
  hr_admin: "Manage staff records, leave requests and HR administration",
  nurse: "View your schedule, submit leave requests and access rota",
  porter: "View your schedule, submit leave requests and access rota",
};
