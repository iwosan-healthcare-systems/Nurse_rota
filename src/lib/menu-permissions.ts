import type { AppRole } from "./auth-context";

export const MENU_PERMISSIONS_KEY = "nurse_rota_menu_permissions";

// Mirrors the nav array in AppShell — one source of truth for labels / defaults.
// Icons live in AppShell; this module only cares about access control.
const ALL: AppRole[] = [
  "admin",
  "cno",
  "chief_matron",
  "head_nurse",
  "hr_admin",
  "service_support",
  "nurse",
  "surgical_nurse",
  "porter",
  "nursing_assistant",
];
const MANAGERS: AppRole[] = ["admin", "cno", "chief_matron", "head_nurse", "hr_admin", "service_support"];
const APPROVERS: AppRole[] = ["admin", "cno", "chief_matron", "head_nurse", "hr_admin"];

export type NavDef = { key: string; label: string; defaultRoles: AppRole[] };

export const NAV_DEFINITIONS: NavDef[] = [
  { key: "/", label: "Dashboard", defaultRoles: ALL },
  { key: "/rota", label: "Rota", defaultRoles: ALL },
  { key: "/shift", label: "Shift", defaultRoles: ALL },
  { key: "/staff", label: "Staff", defaultRoles: MANAGERS },
  { key: "/wards", label: "Wards", defaultRoles: MANAGERS },
  { key: "/leave", label: "Leave & Requests", defaultRoles: ALL },
  { key: "/locum", label: "Bank Shift (Locum)", defaultRoles: ALL },
  { key: "/approvals", label: "Approvals", defaultRoles: APPROVERS },
  {
    key: "/reports",
    label: "Reports",
    defaultRoles: ["admin", "cno", "chief_matron", "head_nurse", "hr_admin"],
  },
  { key: "/audit", label: "Audit Log", defaultRoles: ["admin", "cno", "service_support"] },
  { key: "/users", label: "User Profiles", defaultRoles: ["admin", "service_support"] },
  { key: "/permissions", label: "Permissions", defaultRoles: ["admin"] },
  { key: "/menu-permissions", label: "Menu Access", defaultRoles: ["admin"] },
];

// These routes are always visible to admins and cannot be hidden.
export const ADMIN_LOCKED_KEYS = new Set([
  "/users",
  "/permissions",
  "/menu-permissions",
  "/audit",
]);

export function loadMenuPermissions(): Record<string, AppRole[]> {
  return {};
}

export function saveMenuPermissions(_overrides: Record<string, AppRole[]>): void {
  window.dispatchEvent(new Event("menu-permissions-changed"));
}

/** Returns the effective roles for a nav key, merging stored overrides over defaults. */
export function getEffectiveRoles(key: string, overrides: Record<string, AppRole[]>): AppRole[] {
  return overrides[key] ?? NAV_DEFINITIONS.find((d) => d.key === key)?.defaultRoles ?? [];
}
