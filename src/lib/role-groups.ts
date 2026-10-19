// Facility-wide scheduling groups for staff roles. A facility's latest activated
// configuration assigns each role an approval group; roles it does not list,
// and facilities without one, keep the legacy role-name matching.
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  isGlobalHead as legacyIsGlobalHead,
  isInternType as legacyIsInternType,
  isMatron as legacyIsMatron,
  isPorterType as legacyIsPorterType,
} from "@/lib/auto-schedule";

export type RoleGroup = "matron" | "head" | "porter" | "intern";
type FacilityRoleGroups = Record<string, Record<string, RoleGroup | null>>;

// Loaded once by AppShell before any page renders, so page memos never see an
// empty mapping. Configuration activations are rare; a reload picks them up.
let configured: FacilityRoleGroups = {};

export function useConfiguredRoleGroups(enabled: boolean) {
  return useQuery({
    queryKey: ["scheduling-role-groups"],
    enabled,
    staleTime: Infinity,
    queryFn: async () => {
      const result = await api
        .get<{ facilities: FacilityRoleGroups }>("/scheduling/role-groups?date=9999-12-31")
        .catch(() => ({ facilities: {} }));
      configured = result.facilities;
      return result.facilities;
    },
  });
}

function legacyRoleGroup(role: string): RoleGroup | null {
  if (legacyIsMatron(role)) return "matron";
  if (legacyIsGlobalHead(role)) return "head";
  if (legacyIsPorterType(role)) return "porter";
  if (legacyIsInternType(role)) return "intern";
  return null;
}

export function roleGroupOf(
  role: string | null | undefined,
  facility?: string | null,
): RoleGroup | null {
  const name = (role ?? "").trim();
  const key = name.toLowerCase();
  if (facility) {
    const groups = configured[facility];
    if (groups && Object.hasOwn(groups, key)) return groups[key];
  } else {
    // Without a facility, use a configured group only when every facility listing the role agrees.
    const listed = Object.values(configured).filter((groups) => Object.hasOwn(groups, key));
    if (listed.length && listed.every((groups) => groups[key] === listed[0][key]))
      return listed[0][key];
  }
  return legacyRoleGroup(name);
}

export const isMatron = (role: string, facility?: string | null) =>
  roleGroupOf(role, facility) === "matron";
export const isGlobalHead = (role: string, facility?: string | null) =>
  roleGroupOf(role, facility) === "head";
export const isPorterType = (role: string, facility?: string | null) =>
  roleGroupOf(role, facility) === "porter";
export const isInternType = (role: string, facility?: string | null) =>
  roleGroupOf(role, facility) === "intern";
