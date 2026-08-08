import type { AppRole, SystemRole } from "./auth-context";

// Mirrors the nav array in AppShell — one source of truth for labels / defaults.
// Icons live in AppShell; this module only cares about access control.
// These are DEFAULT role sets used only when no admin override exists for a
// nav item (see getEffectiveRoles below) — kept as fixed SystemRole lists so a
// newly created custom role starts with NO menu access anywhere until an
// admin explicitly grants it via System Settings' Menu Access tab, rather than
// silently inheriting visibility of every "ALL"/"MANAGERS" page.
const ALL: SystemRole[] = [
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
const MANAGERS: SystemRole[] = [
  "admin",
  "cno",
  "chief_matron",
  "head_nurse",
  "hr_admin",
  "service_support",
];
const APPROVERS: SystemRole[] = ["admin", "cno", "chief_matron", "head_nurse", "hr_admin"];

export type NavDef = { key: string; label: string; defaultRoles: AppRole[] };

export const NAV_DEFINITIONS: NavDef[] = [
  { key: "/", label: "Dashboard", defaultRoles: ALL },
  { key: "/rota", label: "Rota", defaultRoles: ALL },
  { key: "/shift", label: "Shift", defaultRoles: ALL },
  { key: "/staff", label: "Staff", defaultRoles: MANAGERS },
  { key: "/wards", label: "Wards", defaultRoles: MANAGERS },
  { key: "/leave", label: "Leave & Requests", defaultRoles: ALL },
  { key: "/leave-entitlements", label: "Leave Entitlements", defaultRoles: ALL },
  { key: "/locum", label: "Bank Shift (Locum)", defaultRoles: ALL },
  { key: "/approvals", label: "Approvals", defaultRoles: APPROVERS },
  {
    key: "/reports",
    label: "Reports",
    defaultRoles: ["admin", "cno", "chief_matron", "head_nurse", "hr_admin"],
  },
  { key: "/audit", label: "Audit Log", defaultRoles: ["admin", "cno", "service_support"] },
  { key: "/users", label: "User Profiles", defaultRoles: ["admin", "service_support"] },
  // No entry for "/system-settings" on purpose — Permissions, Menu Access,
  // and System Roles all live inside it now, so it can't be a tag-assignable
  // flag here without undermining the point of consolidating them (an admin
  // could otherwise grant another role access to the very page that grants
  // access). Its visibility is hardcoded to isAdmin in AppShell/the route
  // itself instead of going through this override system.
];

// These routes are always visible to admins and cannot be hidden.
export const ADMIN_LOCKED_KEYS = new Set(["/users", "/audit"]);

/** Returns the effective roles for a nav key, merging stored overrides over defaults. */
export function getEffectiveRoles(key: string, overrides: Record<string, AppRole[]>): AppRole[] {
  return overrides[key] ?? NAV_DEFINITIONS.find((d) => d.key === key)?.defaultRoles ?? [];
}
