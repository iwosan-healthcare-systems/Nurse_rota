/* eslint-disable prettier/prettier */
import { Link, Outlet, useRouterState, useNavigate, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  LayoutDashboard,
  CalendarDays,
  Users,
  Building2,
  FileCheck2,
  PlaneTakeoff,
  BarChart3,
  ShieldCheck,
  Bell,
  Menu,
  X,
  LogOut,
  KeyRound,
  UserCog,
  LogIn,
  Timer,
  LayoutGrid,
  Loader2,
  ShieldAlert,
  AlertCircle,
  Info,
  CheckCircle2,
  Stethoscope,
  Lock,
  ClipboardCheck,
  CalendarX,
  ArrowRightLeft,
  Shield,
} from "lucide-react";
import logo from "@/assets/logo.jpeg";
import { cn } from "@/lib/utils";
import { useAuth, type AppRole, type SystemRole } from "@/lib/auth-context";
import { api, getToken } from "@/lib/api";
import { getEffectiveRoles } from "@/lib/menu-permissions";

const ALL: SystemRole[] = [
  "admin",
  "cno",
  "chief_matron",
  "head_nurse",
  "hr_admin",
  "nurse",
  "porter",
  "nursing_assistant",
];
const MANAGERS: SystemRole[] = ["admin", "cno", "chief_matron", "head_nurse", "hr_admin"];
// Chief Matron's rota-approval step is retired (HR approves, CNO publishes) —
// left out here on purpose, unlike MANAGERS above where chief_matron still
// has other duties (leave/locum). See auth-context.tsx's canApproveRota etc.
const APPROVERS: SystemRole[] = ["admin", "cno", "head_nurse", "hr_admin"];

const nav = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, roles: ALL },
  { to: "/rota", label: "Rota", icon: CalendarDays, roles: ALL },
  { to: "/shift", label: "Shift", icon: Timer, roles: ALL },
  { to: "/staff", label: "Staff", icon: Users, roles: MANAGERS },
  { to: "/wards", label: "Wards", icon: Building2, roles: MANAGERS },
  { to: "/leave", label: "Leave & Requests", icon: PlaneTakeoff, roles: ALL },
  { to: "/approvals", label: "Approvals", icon: FileCheck2, roles: APPROVERS },
  { to: "/locum", label: "Bank Shift (Locum)", icon: Stethoscope, roles: ALL },
  {
    to: "/reports",
    label: "Reports",
    icon: BarChart3,
    roles: ["admin", "cno", "chief_matron", "head_nurse", "hr_admin"] as AppRole[],
  },
  { to: "/audit", label: "Audit Log", icon: ShieldCheck, roles: ["admin", "cno"] as AppRole[] },
  { to: "/users", label: "User Profiles", icon: UserCog, roles: ["admin"] as AppRole[] },
  { to: "/permissions", label: "Permissions", icon: KeyRound, roles: ["admin"] as AppRole[] },
  {
    to: "/menu-permissions",
    label: "Menu Access",
    icon: LayoutGrid,
    roles: ["admin"] as AppRole[],
  },
  { to: "/roles", label: "System Roles", icon: Shield, roles: ["admin"] as AppRole[] },
] as const;

// eslint-disable-next-line react-refresh/only-export-components
export async function appBeforeLoad() {
  if (!getToken()) throw redirect({ to: "/login" });
}

export function AppShell() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const {
    user,
    fullName,
    roles,
    activeRole,
    nurseId,
    nurseFacility,
    needsRoleSelection,
    mustChangePassword,
    clearMustChangePassword,
    passwordExpiresInDays,
    clearPasswordExpiry,
    selectRole,
    signOut,
    loading,
  } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [showExpiryModal, setShowExpiryModal] = useState(false);
  const [menuPermissions, setMenuPermissions] = useState<Record<string, AppRole[]>>({});

  // Auto sign-out when an active session reaches password expiry.
  // The login route already blocks expired passwords, but this handles the edge
  // case where the clock ticks over while the user is already logged in.
  useEffect(() => {
    if (passwordExpiresInDays !== null && passwordExpiresInDays <= 0) {
      toast.error(
        "Your password has expired. You have been signed out — contact your administrator.",
      );
      signOut();
    }
  }, [passwordExpiresInDays, signOut]);

  useEffect(() => {
    api
      .post<{ closed: boolean; period_start?: string; period_end?: string }>(
        "/rpc/auto-close-period",
      )
      .then((result) => {
        if (!result?.closed || !result.period_end) return;
        // Only show the toast once per completed period — skip if already shown this session.
        const seenKey = "lastClosedPeriod";
        if (localStorage.getItem(seenKey) === result.period_end) return;
        localStorage.setItem(seenKey, result.period_end);
        const fmt = (d: string) =>
          new Date(d.slice(0, 10) + "T12:00:00").toLocaleDateString("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
          });
        toast.success(
          `Period ${fmt(result.period_start!)} — ${fmt(result.period_end)} has been automatically closed and archived.`,
          { duration: 8000 },
        );
      })
      .catch(() => {
        /* non-critical */
      });
  }, []);

  // Load menu permissions from DB on mount, and re-fetch whenever an admin saves changes.
  useEffect(() => {
    const fetchMenuPerms = () => {
      api
        .get<{ key: string; value: Record<string, AppRole[]> }>("/portal-settings/menu_permissions")
        .then(({ value }) => {
          if (value) setMenuPermissions(value);
        })
        .catch(() => {
          /* non-critical */
        });
    };
    fetchMenuPerms();
    window.addEventListener("menu-permissions-changed", fetchMenuPerms);
    window.addEventListener("storage", fetchMenuPerms);
    return () => {
      window.removeEventListener("menu-permissions-changed", fetchMenuPerms);
      window.removeEventListener("storage", fetchMenuPerms);
    };
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [path]);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [user, loading, navigate]);

  if (needsRoleSelection) {
    return (
      <RoleSelectionScreen
        fullName={fullName}
        roles={roles}
        selectRole={selectRole}
        signOut={signOut}
      />
    );
  }

  if (mustChangePassword) {
    return (
      <ForcePasswordChangeScreen
        fullName={fullName}
        onChanged={clearMustChangePassword}
        signOut={signOut}
      />
    );
  }

  const visibleNav = nav.filter((n) => {
    if (activeRole === "admin") return true;
    const effectiveRoles = getEffectiveRoles(n.to, menuPermissions);
    return activeRole ? effectiveRoles.includes(activeRole) : roles.length === 0;
  });

  const currentNavItem = nav.find((n) => (n.to === "/" ? path === "/" : path.startsWith(n.to)));
  const isPathPermitted =
    loading ||
    !activeRole ||
    !currentNavItem ||
    activeRole === "admin" ||
    getEffectiveRoles(currentNavItem.to, menuPermissions).includes(activeRole);
  const primaryRole = activeRole ?? roles[0];
  const initials = (fullName ?? user?.email ?? "?")
    .split(/[\s@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("");

  return (
    <div className="h-screen flex overflow-hidden bg-background text-foreground">
      <aside className="hidden lg:flex w-64 shrink-0 bg-sidebar text-sidebar-foreground flex-col h-screen">
        <SidebarContent path={path} items={visibleNav} />
        <UserBlock fullName={fullName} role={primaryRole} signOut={signOut} />
      </aside>

      {open && (
        <div className="lg:hidden fixed inset-0 z-40">
          <button
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/50"
          />
          <aside className="absolute left-0 top-0 bottom-0 w-72 bg-sidebar text-sidebar-foreground flex flex-col">
            <SidebarContent path={path} items={visibleNav} onClose={() => setOpen(false)} />
            <UserBlock fullName={fullName} role={primaryRole} signOut={signOut} />
          </aside>
        </div>
      )}

      <div id="main-scroll" className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <header className="h-16 border-b bg-card flex items-center px-3 sm:px-6 gap-2 sm:gap-4 sticky top-0 z-30">
          <button
            onClick={() => setOpen(true)}
            className="lg:hidden h-10 w-10 grid place-items-center rounded-md hover:bg-muted"
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate">{currentTitle(path)}</p>
          </div>
          <RotaReminderBell
            activeRole={activeRole}
            nurseId={nurseId}
            nurseFacility={nurseFacility}
            userId={user?.id ?? null}
          />
          <div className="h-9 w-9 rounded-full bg-primary/15 text-primary grid place-items-center text-sm font-semibold shrink-0">
            {initials || "U"}
          </div>
        </header>
        <main className="flex-1 p-4 sm:p-6">
          {/* Password expiry warning banner: shown 1–5 days before expiry */}
          {passwordExpiresInDays !== null &&
            passwordExpiresInDays >= 1 &&
            passwordExpiresInDays <= 5 && (
              <div className="mb-4 flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-950/20 dark:text-amber-300 dark:border-amber-700">
                <ShieldAlert className="h-4 w-4 shrink-0" />
                <p className="flex-1">
                  Your password expires in{" "}
                  <strong>
                    {passwordExpiresInDays} {passwordExpiresInDays === 1 ? "day" : "days"}
                  </strong>
                  . Update it before it expires to avoid being locked out.
                </p>
                <button
                  type="button"
                  onClick={() => setShowExpiryModal(true)}
                  className="shrink-0 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 transition-colors"
                >
                  Change password
                </button>
              </div>
            )}
          <PasswordExpiryModal
            open={showExpiryModal}
            onClose={() => setShowExpiryModal(false)}
            onChanged={() => {
              setShowExpiryModal(false);
              clearPasswordExpiry();
            }}
          />
          {isPathPermitted ? (
            <Outlet />
          ) : (
            <div className="flex flex-col items-center justify-center h-full py-24 gap-5 text-center">
              <div className="h-16 w-16 rounded-full bg-destructive/10 text-destructive grid place-items-center">
                <ShieldAlert className="h-8 w-8" />
              </div>
              <div>
                <p className="text-lg font-semibold">Access denied</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  You don&apos;t have permission to view this page.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void navigate({ to: "/" })}
                className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium"
              >
                <LayoutDashboard className="h-4 w-4" />
                Back to Dashboard
              </button>
            </div>
          )}
        </main>
        <footer className="border-t px-4 sm:px-6 py-4 text-center text-xs text-muted-foreground">
          Powered by Iwosan Healthcare Systems. <br />© {new Date().getFullYear()}. All rights reserved.
        </footer>
      </div>
    </div>
  );
}

function fmtDate(d: string) {
  return new Date(d.slice(0, 10) + "T00:00:00").toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function clusterDates(rawDates: string[]): string[][] {
  if (!rawDates.length) return [];
  const sorted = [...new Set(rawDates)].sort();
  const clusters: string[][] = [];
  let cur: string[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const diff = Math.round(
      (new Date(sorted[i].slice(0, 10) + "T00:00:00").getTime() -
        new Date(sorted[i - 1].slice(0, 10) + "T00:00:00").getTime()) /
        86400000,
    );
    if (diff > 14) {
      clusters.push(cur);
      cur = [];
    }
    cur.push(sorted[i]);
  }
  if (cur.length) clusters.push(cur);
  return clusters;
}

type NotifState = "unread" | "read";
type NotifRow = { notif_key: string; is_read: boolean };

function getNotifState(
  notifKey: string | null,
  allNotifs: NotifRow[] | undefined,
): NotifState | null {
  if (!notifKey || allNotifs === undefined) return null;
  const row = allNotifs.find((r) => r.notif_key === notifKey);
  return row ? (row.is_read ? "read" : "unread") : "unread";
}

// Pulls a UUID (request/leave/locum row id) out of a notif_key regardless of
// what prefix/suffix surrounds it — e.g. "leave_approved_{id}",
// "leave_approved_{id}_staff", "switch_rejected_{id}_b", "locum_filled_matron_{id}".
function extractUuid(key: string): string | null {
  const m = key.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}

// Facility-wide role-group slug → display label, used when parsing rota
// lifecycle notif_keys (see parseUnitPeriodKey). Mirrors FW_LABELS/
// FW_GROUP_LABELS defined separately in rota.tsx/approvals.tsx/index.tsx —
// kept as its own small copy here, matching this codebase's existing
// convention for small cross-file constants.
const FW_UNIT_LABELS: Record<string, string> = {
  matron: "Matron",
  head: "Coverage Nurses",
  porter: "Porter",
  intern: "Nurse Interns",
};

// Parses a rota lifecycle notif_key of the form
// "{prefix}_{facilitySlug}|{unitSlug}|{periodStart}" (see
// jobs/auto-generate-rota.js's notifyUnit() for why "|" is used instead of
// "_" — facility and ward names can themselves contain "_", making a pure
// underscore join ambiguous to split back apart).
function parseUnitPeriodKey(key: string, prefix: string) {
  if (!key.startsWith(prefix)) return null;
  const [facilitySlug, unitSlug, periodStart] = key.slice(prefix.length).split("|");
  if (!facilitySlug || !unitSlug || !periodStart) return null;
  const facilityDisplay = facilitySlug.charAt(0).toUpperCase() + facilitySlug.slice(1).replace(/_/g, " ");
  const unitDisplay =
    FW_UNIT_LABELS[unitSlug] ?? unitSlug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return { facilityDisplay, unitDisplay, periodStart };
}

type UnitPeriod = ReturnType<typeof parseUnitPeriodKey>;

// One message builder per unit+period-keyed rota lifecycle prefix — checked
// in turn by unitPeriodMessage() below since a notif_key only ever matches
// exactly one of them.
const UNIT_PERIOD_MESSAGES: Record<string, (u: NonNullable<UnitPeriod>) => string> = {
  rota_autogenerated_: (u) =>
    `Draft rota generated for ${u.unitDisplay} · ${u.facilityDisplay} — period starting ${fmtDate(u.periodStart)}.`,
  rota_autosubmitted_: (u) =>
    `${u.unitDisplay} · ${u.facilityDisplay} was auto-submitted for HR review (T-17 deadline).`,
  rota_autosubmit_blocked_: (u) =>
    `Auto-submit blocked for ${u.unitDisplay} · ${u.facilityDisplay} — unresolved leave still needs review.`,
  rota_hr_rejected_: (u) =>
    `HR returned ${u.unitDisplay} · ${u.facilityDisplay} to draft — changes are needed before resubmitting.`,
  rota_autopublished_: (u) =>
    `${u.unitDisplay} · ${u.facilityDisplay} was published automatically (T-14 deadline).`,
  rota_publish_deadline_missed_: (u) =>
    `Publish deadline missed for ${u.unitDisplay} · ${u.facilityDisplay} — HR approval is still outstanding.`,
};

function unitPeriodMessage(key: string): string | null {
  for (const [prefix, build] of Object.entries(UNIT_PERIOD_MESSAGES)) {
    const parsed = parseUnitPeriodKey(key, prefix);
    if (parsed) return build(parsed);
  }
  return null;
}

function upsertNotif(userId: string, notifKey: string, isRead: boolean, refetch: () => void) {
  api
    .post("/notifications/upsert", [{ user_id: userId, notif_key: notifKey, is_read: isRead }])
    .then(() => refetch())
    .catch(() => {});
}

function upsertManyNotifs(userId: string, keys: string[], isRead: boolean, refetch: () => void) {
  if (!keys.length) return;
  api
    .post(
      "/notifications/upsert",
      keys.map((k) => ({ user_id: userId, notif_key: k, is_read: isRead })),
    )
    .then(() => refetch())
    .catch(() => {});
}

function RotaReminderBell({
  activeRole,
  nurseId,
  nurseFacility,
  userId,
}: {
  activeRole: string | null;
  nurseId: string | null;
  nurseFacility: string | null;
  userId: string | null;
}) {
  const canSeeManagement =
    activeRole === "admin" || activeRole === "cno" || activeRole === "chief_matron";
  const [open, setOpen] = useState(false);
  const [showAllNotifs, setShowAllNotifs] = useState(false);
  const today = new Date().toISOString().slice(0, 10);

  const ymd = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  // Shared notification state for this user (polled every 2 min)
  const { data: allNotifs, refetch: refetchNotifs } = useQuery({
    queryKey: ["notif-state", userId],
    enabled: !!userId,
    staleTime: 60 * 1000,
    refetchInterval: 2 * 60 * 1000,
    queryFn: () => api.get<NotifRow[]>("/notifications"),
  });

  // ── Management: next rota deadline ────────────────────────────────────────
  const { data: mgmtNotif } = useQuery({
    queryKey: ["rota-reminder"],
    enabled: canSeeManagement,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

      const data = await api.get<{ shift_date: string }[]>(
        `/shift-assignments?status=published&from=${ymd(threeMonthsAgo)}`,
      );

      if (!data?.length) return null;

      const clusters = clusterDates(data.map((d) => d.shift_date));
      const latest = clusters[clusters.length - 1];
      const periodStart = latest[0];
      const periodEnd = latest[latest.length - 1];

      const nextStartDt = new Date(periodEnd.slice(0, 10) + "T00:00:00");
      nextStartDt.setDate(nextStartDt.getDate() + 1);
      const nextPeriodStart = ymd(nextStartDt);

      const deadlineDt = new Date(nextStartDt);
      deadlineDt.setDate(deadlineDt.getDate() - 14);
      const deadline = ymd(deadlineDt);

      const next = await api.get<{ id: string }[]>(
        `/shift-assignments?from=${nextPeriodStart}&limit=1`,
      );

      return { periodStart, periodEnd, nextPeriodStart, deadline, nextRotaExists: next.length > 0 };
    },
  });

  const mgmtKey =
    canSeeManagement && mgmtNotif && !mgmtNotif.nextRotaExists
      ? `rota_notif_v2_${mgmtNotif.periodStart}`
      : null;
  const mgmtState = getNotifState(mgmtKey, allNotifs);

  // ── Staff: rota published notification ────────────────────────────────────
  const { data: staffNotif } = useQuery({
    queryKey: ["staff-rota-notif", nurseId],
    enabled: !!nurseId,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

      const data = await api.get<{ shift_date: string; ward: string | null }[]>(
        `/shift-assignments?nurse_id=${nurseId}&status=published&from=${ymd(threeMonthsAgo)}`,
      );

      if (!data?.length) return null;

      const clusters = clusterDates(data.map((d) => d.shift_date));
      if (!clusters.length) return null;

      const latest = clusters[clusters.length - 1];
      const periodStart = latest[0];
      const periodEnd = latest[latest.length - 1];

      const ward =
        data.find(
          (d) => d.shift_date >= periodStart && d.shift_date <= periodEnd && d.ward !== null,
        )?.ward ?? null;

      return { periodStart, periodEnd, ward };
    },
  });

  const staffKey =
    nurseId && staffNotif ? `staff_notif_v2_${nurseId}_${staffNotif.periodStart}` : null;
  const staffState = getNotifState(staffKey, allNotifs);

  // ── Rota workflow: stage-specific action notifications ───────────────────
  // Shown per-role once the first rota has ever been published:
  //   head_nurse → submit reminder (draft ready)
  //   hr_admin   → HR approval reminder (rota submitted)
  //   cno        → publish reminder (HR-approved)
  //   admin      → most urgent pending action across all roles, plus the
  //                generate-override reminder (generation is otherwise automatic)
  const canSeeWorkflow =
    activeRole === "admin" ||
    activeRole === "cno" ||
    activeRole === "hr_admin" ||
    activeRole === "head_nurse";

  const { data: workflowStatus } = useQuery<{
    firstRotaPublished: boolean;
    nextPeriodStart?: string;
    leaveClosureDate?: string;
    publishDeadline?: string;
    leaveIsClosed?: boolean;
    publishIsOverdue?: boolean;
    nextRotaStage?: string;
  }>({
    queryKey: ["workflow-status"],
    enabled: canSeeWorkflow && !!userId,
    staleTime: 5 * 60 * 1000,
    queryFn: () => api.get("/rpc/workflow-status"),
  });

  // Derive the single most-actionable workflow notification for this role.
  const workflowItem = (() => {
    if (!workflowStatus?.firstRotaPublished) return null;
    const { nextPeriodStart, leaveIsClosed, nextRotaStage, publishDeadline, publishIsOverdue } =
      workflowStatus;
    if (!nextPeriodStart) return null;

    const isHeadOrAdmin = activeRole === "head_nurse" || activeRole === "admin";
    const isHrOrAdmin = activeRole === "hr_admin" || activeRole === "admin";
    const isCnoOrAdmin = activeRole === "cno" || activeRole === "admin";

    // For admin, evaluate all stages and return the most urgent one.
    // Highest urgency first so admin sees the blocking step.
    if (isCnoOrAdmin && nextRotaStage === "hr_approved") {
      const overdue = !!publishIsOverdue;
      return {
        kind: "publish" as const,
        key: `workflow_pub_${nextPeriodStart}`,
        nextPeriodStart,
        publishDeadline,
        overdue,
      };
    }
    if (isHrOrAdmin && nextRotaStage === "submitted") {
      return { kind: "approve" as const, key: `workflow_approve_${nextPeriodStart}`, nextPeriodStart };
    }
    if (isHeadOrAdmin && leaveIsClosed && nextRotaStage === "draft") {
      return { kind: "submit" as const, key: `workflow_submit_${nextPeriodStart}`, nextPeriodStart };
    }
    // Generation is automatic (T-19) — this is only an admin override reminder.
    if (activeRole === "admin" && leaveIsClosed && nextRotaStage === "none") {
      return {
        kind: "generate" as const,
        key: `workflow_gen_${nextPeriodStart}`,
        nextPeriodStart,
        nextRotaStage,
      };
    }
    return null;
  })();

  const workflowKey = workflowItem?.key ?? null;
  const workflowState = getNotifState(workflowKey, allNotifs);
  const showWorkflow = !!workflowItem;

  // ── Locum: pending-action counts ─────────────────────────────────────────
  const { data: locumCount = 0 } = useQuery({
    queryKey: ["locum-bell", userId, activeRole, nurseId, nurseFacility],
    enabled: !!userId,
    staleTime: 60 * 1000,
    queryFn: async () => {
      let total = 0;

      if (nurseId) {
        const facilityParam = nurseFacility ? `&facility=${encodeURIComponent(nurseFacility)}` : "";
        const invites = await api.get<{ id: string }[]>(
          `/locum/invites?nurse_id=${nurseId}&status=pending${facilityParam}`,
        );
        total += invites.length;
      }

      if (activeRole === "cno" || activeRole === "admin") {
        const requests = await api.get<{ id: string }[]>("/locum/requests?status=pending");
        total += requests.length;
      }

      if ((activeRole === "chief_matron" || activeRole === "admin") && userId) {
        const requests = await api.get<{ id: string }[]>(
          `/locum/requests?requested_by=${userId}&status=approved`,
        );
        total += requests.length;
      }

      return total;
    },
  });

  // Unread "shift filled" notifications — sent to matron and CNO when a nurse accepts
  const locumFilledKeys =
    allNotifs
      ?.filter(
        (r) =>
          !r.is_read &&
          (r.notif_key.startsWith("locum_filled_matron_") ||
            r.notif_key.startsWith("locum_filled_cno_")),
      )
      .map((r) => r.notif_key) ?? [];

  // Unread locum notifications from shared notif state (declined or auto-expired requests)
  const locumUnread =
    allNotifs?.filter(
      (r) =>
        !r.is_read &&
        (r.notif_key.startsWith("locum_declined_") || r.notif_key.startsWith("locum_expired_")),
    ).length ?? 0;

  // Unread locum lifecycle notifications that previously had no bell coverage
  // at all — new request needs CNO review, matron's request was approved (go
  // send invites), a nurse was invited, an invite the nurse missed out on got
  // filled by someone else, or (most important) a nurse accepted an invite
  // but the automatic rota flip failed and needs manual reconciliation.
  const locumReviewKeys =
    allNotifs?.filter((r) => !r.is_read && r.notif_key.startsWith("locum_review_")).map((r) => r.notif_key) ?? [];
  const locumApprovedKeys =
    allNotifs?.filter((r) => !r.is_read && r.notif_key.startsWith("locum_approved_")).map((r) => r.notif_key) ?? [];
  const locumInviteKeys =
    allNotifs?.filter((r) => !r.is_read && r.notif_key.startsWith("locum_invite_")).map((r) => r.notif_key) ?? [];
  const locumFlipFailedKeys =
    allNotifs?.filter((r) => !r.is_read && r.notif_key.startsWith("locum_flip_failed_")).map((r) => r.notif_key) ??
    [];
  const locumFilledNurseKeys =
    allNotifs?.filter((r) => !r.is_read && r.notif_key.startsWith("locum_filled_nurse_")).map((r) => r.notif_key) ??
    [];
  const locumUpdatesKeys = [
    ...locumReviewKeys,
    ...locumApprovedKeys,
    ...locumInviteKeys,
    ...locumFlipFailedKeys,
    ...locumFilledNurseKeys,
  ];
  const locumUpdatesUnread = locumUpdatesKeys.length;

  // Unread leave/switch outcome notifications (shown to the requesting staff member)
  const leaveUpdateKeys =
    allNotifs
      ?.filter(
        (r) =>
          !r.is_read &&
          (r.notif_key.startsWith("leave_approved_") ||
            r.notif_key.startsWith("leave_rejected_") ||
            r.notif_key.startsWith("switch_approved_") ||
            r.notif_key.startsWith("switch_rejected_")),
      )
      .map((r) => r.notif_key) ?? [];
  const leaveUnread = leaveUpdateKeys.length;

  // Unread cover-needed notifications (shown to the matron who approved sick/emergency leave)
  const coverNeededKeys =
    allNotifs
      ?.filter((r) => !r.is_read && r.notif_key.startsWith("leave_cover_needed_"))
      .map((r) => r.notif_key) ?? [];
  const coverUnread = coverNeededKeys.length;

  // Unread rota-lifecycle notifications — edit-access requests/decisions and
  // the T-19/T-17/T-14 automated generate/submit/publish events. One
  // consolidated bell entry rather than a bespoke one per event type; the
  // Rota and Approvals pages are where the actual detail lives.
  const ROTA_LIFECYCLE_PREFIXES = [
    "rota_edit_pending_",
    "rota_edit_approved_",
    "rota_edit_declined_",
    "rota_autogenerated_",
    "rota_autosubmitted_",
    "rota_autosubmit_blocked_",
    "rota_hr_rejected_",
    "rota_autopublished_",
    "rota_publish_deadline_missed_",
  ];
  const rotaLifecycleKeys =
    allNotifs
      ?.filter((r) => !r.is_read && ROTA_LIFECYCLE_PREFIXES.some((p) => r.notif_key.startsWith(p)))
      .map((r) => r.notif_key) ?? [];
  const rotaLifecycleUnread = rotaLifecycleKeys.length;

  // ── Detail lookups for specific bell text ─────────────────────────────────
  // The keys above are enough to bucket/count/dismiss notifications, but not
  // enough to say WHO or WHAT — that data lives on the underlying row. Fetch
  // it in small, id-scoped batches only when there's something unread to
  // resolve.
  const editAccessIds = [
    ...new Set(
      rotaLifecycleKeys
        .filter(
          (k) =>
            k.startsWith("rota_edit_pending_") ||
            k.startsWith("rota_edit_approved_") ||
            k.startsWith("rota_edit_declined_"),
        )
        .map(extractUuid)
        .filter((id): id is string => !!id),
    ),
  ];
  const { data: editAccessDetails = [] } = useQuery({
    queryKey: ["notif-edit-access-details", editAccessIds.join(",")],
    enabled: editAccessIds.length > 0,
    staleTime: 60 * 1000,
    queryFn: () =>
      api.get<
        {
          id: string;
          facility: string;
          ward: string | null;
          role_group: string | null;
          reason: string;
          requested_by_name: string | null;
          review_note: string | null;
        }[]
      >(`/rota-edit-requests?ids=${editAccessIds.join(",")}`),
  });

  const leaveDetailIds = [
    ...new Set([...leaveUpdateKeys, ...coverNeededKeys].map(extractUuid).filter((id): id is string => !!id)),
  ];
  const { data: leaveDetails = [] } = useQuery({
    queryKey: ["notif-leave-details", leaveDetailIds.join(",")],
    enabled: leaveDetailIds.length > 0,
    staleTime: 60 * 1000,
    queryFn: () =>
      api.get<
        {
          id: string;
          nurse_name: string;
          type: string;
          status: string;
          from_date: string;
          to_date: string;
          review_note: string | null;
        }[]
      >(`/leave-requests?ids=${leaveDetailIds.join(",")}`),
  });

  // Covers every locum_* notif type keyed by a locum_requests.id: the
  // existing locum_filled_matron_/cno_ plus the newly-wired locum_review_,
  // locum_approved_, locum_invite_ (which embeds the request id first, then
  // the invited nurse's id — extractUuid grabs the first match) and
  // locum_filled_nurse_.
  const locumRequestIds = [
    ...new Set(
      [...locumFilledKeys, ...locumReviewKeys, ...locumApprovedKeys, ...locumInviteKeys, ...locumFilledNurseKeys]
        .map(extractUuid)
        .filter((id): id is string => !!id),
    ),
  ];
  const { data: locumRequestDetails = [] } = useQuery({
    queryKey: ["notif-locum-request-details", locumRequestIds.join(",")],
    enabled: locumRequestIds.length > 0,
    staleTime: 60 * 1000,
    queryFn: () =>
      api.get<
        {
          id: string;
          ward: string;
          shift: string;
          shift_date: string;
          requested_by_name: string | null;
          accepted_by_nurse_name: string | null;
        }[]
      >(`/locum/requests?ids=${locumRequestIds.join(",")}`),
  });
  // locum_flip_failed_ is keyed by the locum_invites row id, not the request
  // id — separate lookup, includes the accepting nurse's name and the
  // nested locum_request (ward/shift/date).
  const locumInviteIds = [
    ...new Set(locumFlipFailedKeys.map(extractUuid).filter((id): id is string => !!id)),
  ];
  const { data: locumInviteDetails = [] } = useQuery({
    queryKey: ["notif-locum-invite-details", locumInviteIds.join(",")],
    enabled: locumInviteIds.length > 0,
    staleTime: 60 * 1000,
    queryFn: () =>
      api.get<
        {
          id: string;
          nurse_name: string | null;
          locum_request: { ward: string; shift: string; shift_date: string } | null;
        }[]
      >(`/locum/invites?ids=${locumInviteIds.join(",")}`),
  });

  // ── Computed alert counts ─────────────────────────────────────────────────
  const showMgmt = canSeeManagement && !!mgmtNotif && !mgmtNotif.nextRotaExists;
  const showStaff = !!nurseId && !!staffNotif;
  const showLocum = locumCount + locumUnread > 0;
  const showLocumFilled = locumFilledKeys.length > 0;
  const showLocumUpdates = locumUpdatesUnread > 0;

  const mgmtUnread = showMgmt && mgmtState === "unread";
  const staffUnread = showStaff && staffState === "unread";
  const workflowUnread = showWorkflow && workflowState === "unread";
  const unreadCount =
    (mgmtUnread ? 1 : 0) +
    (staffUnread ? 1 : 0) +
    (showLocum ? 1 : 0) +
    (showLocumFilled ? 1 : 0) +
    (showLocumUpdates ? 1 : 0) +
    (workflowUnread ? 1 : 0) +
    (leaveUnread > 0 ? 1 : 0) +
    (coverUnread > 0 ? 1 : 0) +
    (rotaLifecycleUnread > 0 ? 1 : 0);

  const allNotifItems = [
    ...(coverUnread > 0 ? [{ kind: "cover_needed" as const }] : []),
    ...(leaveUnread > 0 ? [{ kind: "leave_updates" as const }] : []),
    ...(rotaLifecycleUnread > 0 ? [{ kind: "rota_lifecycle" as const }] : []),
    ...(showLocumFilled ? [{ kind: "locum_filled" as const }] : []),
    ...(showLocumUpdates ? [{ kind: "locum_updates" as const }] : []),
    ...(showLocum ? [{ kind: "locum" as const }] : []),
    ...(showStaff && staffNotif ? [{ kind: "staff" as const }] : []),
    // Workflow notifications appear before the generic deadline reminder
    ...(showWorkflow && workflowItem ? [{ kind: "workflow" as const }] : []),
    ...(showMgmt && mgmtNotif ? [{ kind: "mgmt" as const }] : []),
  ];
  const notifItems = showAllNotifs ? allNotifItems : allNotifItems.slice(0, 3);
  const hasMore = !showAllNotifs && allNotifItems.length > 3;

  const mgmtOverdue = showMgmt && !!mgmtNotif && today > mgmtNotif.deadline;
  const mgmtUrgent =
    showMgmt &&
    !mgmtOverdue &&
    !!mgmtNotif &&
    (() => {
      const d = new Date(mgmtNotif.deadline + "T00:00:00");
      d.setDate(d.getDate() - 3);
      return today >= d.toISOString().slice(0, 10);
    })();

  const workflowOverdue =
    showWorkflow &&
    workflowItem?.kind === "publish" &&
    !!(workflowItem as { overdue?: boolean }).overdue;
  const hasCritical = mgmtOverdue || workflowOverdue;

  function markNotif(key: string | null, isRead: boolean) {
    if (!key || !userId) return;
    upsertNotif(userId, key, isRead, refetchNotifs);
  }

  function markManyNotifs(keys: string[], isRead: boolean) {
    if (!userId) return;
    upsertManyNotifs(userId, keys, isRead, refetchNotifs);
  }

  return (
    <div className="relative">
      <button
        type="button"
        className="relative h-10 w-10 grid place-items-center rounded-md hover:bg-muted"
        aria-label="Notifications"
        onClick={() => setOpen((v) => !v)}
      >
        <Bell className={cn("h-4 w-4", hasCritical && "text-destructive")} />
        {unreadCount > 0 && (
          <span
            className={cn(
              "absolute top-1 right-1 min-w-4 h-4 px-0.5 rounded-full text-[9px] font-bold text-white grid place-items-center",
              hasCritical ? "bg-destructive" : "bg-amber-500",
            )}
          >
            {unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-12 z-50 w-80 max-w-[calc(100vw-1rem)] rounded-xl border bg-card shadow-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">Notifications</p>
              <button
                type="button"
                aria-label="Close notifications"
                onClick={() => setOpen(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {notifItems.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-4 text-center">
                <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                <p className="text-sm text-muted-foreground">No notifications.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {notifItems.map(({ kind }) =>
                  kind === "cover_needed" ? (
                    <div
                      key="cover_needed"
                      className="rounded-lg border border-amber-400/40 bg-amber-50 dark:bg-amber-950/20 p-3 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <ArrowRightLeft className="h-4 w-4 shrink-0 text-amber-600" />
                          <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                            Shift Cover Needed
                          </p>
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" />
                        </div>
                        <button
                          type="button"
                          onClick={() => markManyNotifs(coverNeededKeys, true)}
                          className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground shrink-0 underline"
                        >
                          Dismiss
                        </button>
                      </div>
                      <div className="text-xs space-y-1.5">
                        {coverNeededKeys.map((key) => {
                          const detail = leaveDetails.find((l) => l.id === extractUuid(key));
                          return (
                            <p key={key}>
                              {detail ? (
                                <>
                                  <span className="font-medium">{detail.nurse_name}</span>'s{" "}
                                  {detail.type.toLowerCase()} leave approved ({fmtDate(detail.from_date)}{" "}
                                  – {fmtDate(detail.to_date)}) — arrange cover.
                                </>
                              ) : (
                                "A sick/emergency leave was approved — consider arranging shift cover."
                              )}
                            </p>
                          );
                        })}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Open the Shift Switches tab on Leave &amp; Requests to arrange cover.
                      </p>
                    </div>
                  ) : kind === "leave_updates" ? (
                    <div
                      key="leave_updates"
                      className="rounded-lg border border-blue-400/40 bg-blue-50 dark:bg-blue-950/20 p-3 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <CalendarX className="h-4 w-4 shrink-0 text-blue-600" />
                          <p className="text-xs font-semibold text-blue-700 dark:text-blue-400">
                            Leave / Switch Update
                          </p>
                          <span className="h-1.5 w-1.5 rounded-full bg-blue-500 shrink-0" />
                        </div>
                        <button
                          type="button"
                          onClick={() => markManyNotifs(leaveUpdateKeys, true)}
                          className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground shrink-0 underline"
                        >
                          Dismiss
                        </button>
                      </div>
                      <div className="text-xs space-y-1.5">
                        {leaveUpdateKeys.map((key) => {
                          const detail = leaveDetails.find((l) => l.id === extractUuid(key));
                          const isSwitch = key.startsWith("switch_");
                          const approved = key.includes("_approved_");
                          return (
                            <p key={key}>
                              {detail ? (
                                <>
                                  <span className="font-medium">{detail.nurse_name}</span>'s{" "}
                                  {isSwitch ? "shift switch" : `${detail.type.toLowerCase()} leave`}{" "}
                                  request was{" "}
                                  <span
                                    className={
                                      approved
                                        ? "text-emerald-600 dark:text-emerald-400 font-medium"
                                        : "text-red-600 dark:text-red-400 font-medium"
                                    }
                                  >
                                    {approved ? "approved" : "rejected"}
                                  </span>
                                  {detail.review_note ? ` — "${detail.review_note}"` : ""}
                                </>
                              ) : (
                                `A leave or shift switch request was ${approved ? "approved" : "rejected"}.`
                              )}
                            </p>
                          );
                        })}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Open Leave &amp; Requests to see the full outcome.
                      </p>
                    </div>
                  ) : kind === "rota_lifecycle" ? (
                    <div
                      key="rota_lifecycle"
                      className="rounded-lg border border-violet-400/40 bg-violet-50 dark:bg-violet-950/20 p-3 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <CalendarDays className="h-4 w-4 shrink-0 text-violet-600" />
                          <p className="text-xs font-semibold text-violet-700 dark:text-violet-400">
                            Rota Update
                          </p>
                          <span className="h-1.5 w-1.5 rounded-full bg-violet-500 shrink-0" />
                        </div>
                        <button
                          type="button"
                          onClick={() => markManyNotifs(rotaLifecycleKeys, true)}
                          className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground shrink-0 underline"
                        >
                          Dismiss
                        </button>
                      </div>
                      <div className="text-xs space-y-1.5">
                        {rotaLifecycleKeys.map((key) => {
                          if (key.startsWith("rota_edit_pending_")) {
                            const d = editAccessDetails.find((r) => r.id === extractUuid(key));
                            const unit =
                              d?.ward ?? (d?.role_group ? (FW_UNIT_LABELS[d.role_group] ?? d.role_group) : "a unit");
                            return (
                              <p key={key}>
                                <span className="font-medium">{d?.requested_by_name ?? "A head nurse"}</span>{" "}
                                requested edit access for {unit}
                                {d?.facility ? ` · ${d.facility}` : ""}
                                {d?.reason ? ` — "${d.reason}"` : ""}
                              </p>
                            );
                          }
                          if (key.startsWith("rota_edit_approved_")) {
                            const d = editAccessDetails.find((r) => r.id === extractUuid(key));
                            const unit =
                              d?.ward ??
                              (d?.role_group ? (FW_UNIT_LABELS[d.role_group] ?? d.role_group) : "your draft");
                            return (
                              <p key={key}>
                                Your edit-access request for <span className="font-medium">{unit}</span>
                                {d?.facility ? ` · ${d.facility}` : ""} was approved.
                              </p>
                            );
                          }
                          if (key.startsWith("rota_edit_declined_")) {
                            const d = editAccessDetails.find((r) => r.id === extractUuid(key));
                            const unit =
                              d?.ward ??
                              (d?.role_group ? (FW_UNIT_LABELS[d.role_group] ?? d.role_group) : "your draft");
                            return (
                              <p key={key}>
                                Your edit-access request for <span className="font-medium">{unit}</span>
                                {d?.facility ? ` · ${d.facility}` : ""} was declined
                                {d?.review_note ? ` — "${d.review_note}"` : ""}. The draft was
                                auto-submitted as-is.
                              </p>
                            );
                          }
                          return <p key={key}>{unitPeriodMessage(key) ?? "A rota lifecycle event occurred."}</p>;
                        })}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Open Rota or Approvals for details.
                      </p>
                    </div>
                  ) : kind === "locum_filled" ? (
                    <div
                      key="locum_filled"
                      className="rounded-lg border border-emerald-400/40 bg-emerald-50 dark:bg-emerald-950/20 p-3 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Stethoscope className="h-4 w-4 shrink-0 text-emerald-600" />
                          <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                            Locum Shift Accepted
                          </p>
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                        </div>
                        <button
                          type="button"
                          onClick={() => markManyNotifs(locumFilledKeys, true)}
                          className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground shrink-0 underline"
                        >
                          Dismiss
                        </button>
                      </div>
                      <div className="text-xs space-y-1.5">
                        {locumFilledKeys.map((key) => {
                          const d = locumRequestDetails.find((r) => r.id === extractUuid(key));
                          return (
                            <p key={key}>
                              {d ? (
                                <>
                                  <span className="font-medium">{d.accepted_by_nurse_name ?? "A nurse"}</span>{" "}
                                  accepted the {d.shift} shift for {d.ward} on {fmtDate(d.shift_date)}.
                                </>
                              ) : (
                                "A nurse has accepted a locum shift invite."
                              )}
                            </p>
                          );
                        })}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Open Bank Shift (Locum) → All Requests to view who accepted.
                      </p>
                    </div>
                  ) : kind === "locum_updates" ? (
                    <div
                      key="locum_updates"
                      className="rounded-lg border border-indigo-400/40 bg-indigo-50 dark:bg-indigo-950/20 p-3 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Stethoscope className="h-4 w-4 shrink-0 text-indigo-600" />
                          <p className="text-xs font-semibold text-indigo-700 dark:text-indigo-400">
                            Locum Updates
                          </p>
                          <span className="h-1.5 w-1.5 rounded-full bg-indigo-500 shrink-0" />
                        </div>
                        <button
                          type="button"
                          onClick={() => markManyNotifs(locumUpdatesKeys, true)}
                          className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground shrink-0 underline"
                        >
                          Dismiss
                        </button>
                      </div>
                      <div className="text-xs space-y-1.5">
                        {locumReviewKeys.map((key) => {
                          const d = locumRequestDetails.find((r) => r.id === extractUuid(key));
                          return (
                            <p key={key}>
                              {d ? (
                                <>
                                  <span className="font-medium">{d.requested_by_name ?? "A matron"}</span>{" "}
                                  requested a {d.shift} shift for {d.ward} on {fmtDate(d.shift_date)} —
                                  needs your review.
                                </>
                              ) : (
                                "A new locum request needs your review."
                              )}
                            </p>
                          );
                        })}
                        {locumApprovedKeys.map((key) => {
                          const d = locumRequestDetails.find((r) => r.id === extractUuid(key));
                          return (
                            <p key={key}>
                              {d ? (
                                <>
                                  Your locum request for <span className="font-medium">{d.ward}</span> ·{" "}
                                  {d.shift} on {fmtDate(d.shift_date)} was approved — send invites to
                                  off-duty nurses.
                                </>
                              ) : (
                                "Your locum request was approved — send invites to off-duty nurses."
                              )}
                            </p>
                          );
                        })}
                        {locumInviteKeys.map((key) => {
                          const d = locumRequestDetails.find((r) => r.id === extractUuid(key));
                          return (
                            <p key={key}>
                              {d ? (
                                <>
                                  You've been invited to cover a {d.shift} shift for{" "}
                                  <span className="font-medium">{d.ward}</span> on{" "}
                                  {fmtDate(d.shift_date)}.
                                </>
                              ) : (
                                "You've been invited to cover a locum shift."
                              )}
                            </p>
                          );
                        })}
                        {locumFlipFailedKeys.map((key) => {
                          const d = locumInviteDetails.find((r) => r.id === extractUuid(key));
                          return (
                            <p key={key} className="text-red-700 dark:text-red-400">
                              {d?.locum_request ? (
                                <>
                                  <span className="font-medium">{d.nurse_name ?? "A nurse"}</span> accepted
                                  the {d.locum_request.shift} shift for {d.locum_request.ward} on{" "}
                                  {fmtDate(d.locum_request.shift_date)}, but the rota didn't update
                                  automatically — check and fix it manually.
                                </>
                              ) : (
                                "A locum acceptance didn't update the rota automatically — check and fix it manually."
                              )}
                            </p>
                          );
                        })}
                        {locumFilledNurseKeys.map((key) => {
                          const d = locumRequestDetails.find((r) => r.id === extractUuid(key));
                          return (
                            <p key={key}>
                              {d ? (
                                <>
                                  The {d.shift} shift for <span className="font-medium">{d.ward}</span> on{" "}
                                  {fmtDate(d.shift_date)} you were invited to has been filled by someone
                                  else.
                                </>
                              ) : (
                                "A locum shift you were invited to has been filled by someone else."
                              )}
                            </p>
                          );
                        })}
                      </div>
                      <p className="text-xs text-muted-foreground">Open Bank Shift (Locum) for details.</p>
                    </div>
                  ) : kind === "locum" ? (
                    <div
                      key="locum"
                      className="rounded-lg border border-violet-400/40 bg-violet-50 dark:bg-violet-950/20 p-3 space-y-2"
                    >
                      <div className="flex items-center gap-2">
                        <Stethoscope className="h-4 w-4 shrink-0 text-violet-600" />
                        <p className="text-xs font-semibold text-violet-700">Bank Shift (Locum)</p>
                        <span className="h-1.5 w-1.5 rounded-full bg-violet-500 shrink-0" />
                      </div>
                      <p className="text-xs">
                        {locumCount + locumUnread} locum item
                        {locumCount + locumUnread !== 1 ? "s" : ""} need
                        {locumCount + locumUnread === 1 ? "s" : ""} your attention.
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Open the Bank Shift (Locum) page to view and respond.
                      </p>
                    </div>
                  ) : kind === "staff" && staffNotif ? (
                    <div
                      key="staff"
                      className={cn(
                        "rounded-lg border p-3 space-y-2 transition-opacity",
                        staffState === "read" && "opacity-60",
                        "border-emerald-400/40 bg-emerald-50 dark:bg-emerald-950/20",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Bell className="h-4 w-4 shrink-0 text-emerald-600" />
                          <p className="text-xs font-semibold text-emerald-700">
                            Your Rota Is Published
                          </p>
                          {staffState === "unread" && (
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                          )}
                        </div>
                        {staffState !== null && (
                          <button
                            type="button"
                            title={staffState === "unread" ? "Mark as read" : "Mark as unread"}
                            onClick={() => markNotif(staffKey, staffState === "unread")}
                            className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground shrink-0 underline"
                          >
                            {staffState === "unread" ? "Mark read" : "Mark unread"}
                          </button>
                        )}
                      </div>
                      <p className="text-xs">
                        {staffNotif.ward ? (
                          <>
                            <span className="font-medium">{staffNotif.ward}</span> schedule for{" "}
                          </>
                        ) : (
                          "Your schedule for "
                        )}
                        <span className="font-medium">
                          {fmtDate(staffNotif.periodStart)} — {fmtDate(staffNotif.periodEnd)}
                        </span>{" "}
                        is now live.
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Open the Rota page to view your shifts.
                      </p>
                    </div>
                  ) : kind === "mgmt" && mgmtNotif ? (
                    <div
                      key="mgmt"
                      className={cn(
                        "rounded-lg border p-3 space-y-2 transition-opacity",
                        mgmtState === "read" && "opacity-60",
                        mgmtOverdue
                          ? "border-destructive/40 bg-destructive/5"
                          : mgmtUrgent
                            ? "border-amber-400/40 bg-amber-50 dark:bg-amber-950/20"
                            : "border-blue-400/40 bg-blue-50 dark:bg-blue-950/20",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          {mgmtOverdue || mgmtUrgent ? (
                            <AlertCircle
                              className={cn(
                                "h-4 w-4 shrink-0",
                                mgmtOverdue ? "text-destructive" : "text-amber-500",
                              )}
                            />
                          ) : (
                            <Info className="h-4 w-4 shrink-0 text-blue-500" />
                          )}
                          <p
                            className={cn(
                              "text-xs font-semibold",
                              mgmtOverdue
                                ? "text-destructive"
                                : mgmtUrgent
                                  ? "text-amber-700"
                                  : "text-blue-700",
                            )}
                          >
                            {mgmtOverdue
                              ? "Next Rota Overdue"
                              : mgmtUrgent
                                ? "Next Rota Due Soon"
                                : "Next Rota Reminder"}
                          </p>
                          {mgmtState === "unread" && (
                            <span
                              className={cn(
                                "h-1.5 w-1.5 rounded-full shrink-0",
                                mgmtOverdue ? "bg-destructive" : "bg-amber-500",
                              )}
                            />
                          )}
                        </div>
                        {mgmtState !== null && (
                          <button
                            type="button"
                            title={mgmtState === "unread" ? "Mark as read" : "Mark as unread"}
                            onClick={() => markNotif(mgmtKey, mgmtState === "unread")}
                            className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground shrink-0 underline"
                          >
                            {mgmtState === "unread" ? "Mark read" : "Mark unread"}
                          </button>
                        )}
                      </div>

                      <p className="text-xs">
                        Current rota:{" "}
                        <span className="font-medium">
                          {fmtDate(mgmtNotif.periodStart)} — {fmtDate(mgmtNotif.periodEnd)}
                        </span>
                      </p>
                      <p className="text-xs">
                        Next period:{" "}
                        <span className="font-medium">{fmtDate(mgmtNotif.nextPeriodStart)}</span>
                      </p>
                      <p className={cn("text-xs font-medium", mgmtOverdue && "text-destructive")}>
                        {mgmtOverdue
                          ? `Deadline passed (${fmtDate(mgmtNotif.deadline)}). Generate and approve the next rota now.`
                          : `Approve next rota by ${fmtDate(mgmtNotif.deadline)} — 2 weeks before the next period starts.`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Nurses need 2 weeks to apply for leave before the next rota is published.
                      </p>
                    </div>
                  ) : kind === "workflow" && workflowItem ? (
                    (() => {
                      const wKind = workflowItem.kind;
                      const isPub = wKind === "publish";
                      const isOverdue = isPub && (workflowItem as { overdue?: boolean }).overdue;
                      const isApprove = wKind === "approve";

                      const title =
                        wKind === "generate"
                          ? "Generate Next Rota (admin override)"
                          : wKind === "submit"
                            ? "Submit Draft Rota"
                            : wKind === "approve"
                              ? "HR Approval Required"
                              : isOverdue
                                ? "Publish Rota — Overdue"
                                : "Publish Rota Now";

                      const bodyText =
                        wKind === "generate"
                          ? `Leave window is closed. The rota for ${fmtDate(workflowItem.nextPeriodStart)} normally auto-generates at T-19 — use this only to trigger it early.`
                          : wKind === "submit"
                            ? `Leave window is closed. The draft rota for ${fmtDate(workflowItem.nextPeriodStart)} is ready — review and submit it for approval (it auto-submits at the T-17 deadline if you don't).`
                            : wKind === "approve"
                              ? `The rota for ${fmtDate(workflowItem.nextPeriodStart)} has been submitted and is awaiting HR approval.`
                              : isOverdue
                                ? `The rota for ${fmtDate(workflowItem.nextPeriodStart)} is HR-approved — publish it now (deadline has passed).`
                                : `The rota for ${fmtDate(workflowItem.nextPeriodStart)} is HR-approved — publish it 14 days before the period starts (or it auto-publishes at the deadline).`;

                      const pageHint =
                        wKind === "generate"
                          ? "Open the Rota page and generate the schedule."
                          : wKind === "submit"
                            ? "Open the Rota page, review the draft, and submit for approval."
                            : wKind === "approve"
                              ? "Open the Approvals page to review and approve."
                              : "Open the Approvals page and publish the rota.";

                      return (
                        <div
                          key="workflow"
                          className={cn(
                            "rounded-lg border p-3 space-y-2 transition-opacity",
                            workflowState === "read" && "opacity-60",
                            isOverdue
                              ? "border-destructive/40 bg-destructive/5"
                              : isApprove || isPub
                                ? "border-amber-400/40 bg-amber-50 dark:bg-amber-950/20"
                                : "border-blue-400/40 bg-blue-50 dark:bg-blue-950/20",
                          )}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              {isOverdue || isApprove || isPub ? (
                                isApprove ? (
                                  <ClipboardCheck className="h-4 w-4 shrink-0 text-amber-500" />
                                ) : (
                                  <AlertCircle
                                    className={cn(
                                      "h-4 w-4 shrink-0",
                                      isOverdue ? "text-destructive" : "text-amber-500",
                                    )}
                                  />
                                )
                              ) : (
                                <Lock className="h-4 w-4 shrink-0 text-blue-500" />
                              )}
                              <p
                                className={cn(
                                  "text-xs font-semibold",
                                  isOverdue
                                    ? "text-destructive"
                                    : isApprove || isPub
                                      ? "text-amber-700 dark:text-amber-400"
                                      : "text-blue-700 dark:text-blue-400",
                                )}
                              >
                                {title}
                              </p>
                              {workflowState === "unread" && (
                                <span
                                  className={cn(
                                    "h-1.5 w-1.5 rounded-full shrink-0",
                                    isOverdue ? "bg-destructive" : "bg-amber-500",
                                  )}
                                />
                              )}
                            </div>
                            {workflowState !== null && (
                              <button
                                type="button"
                                title={
                                  workflowState === "unread" ? "Mark as read" : "Mark as unread"
                                }
                                onClick={() => markNotif(workflowKey, workflowState === "unread")}
                                className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground shrink-0 underline"
                              >
                                {workflowState === "unread" ? "Mark read" : "Mark unread"}
                              </button>
                            )}
                          </div>
                          <p className="text-xs">{bodyText}</p>
                          <p className="text-xs text-muted-foreground">{pageHint}</p>
                        </div>
                      );
                    })()
                  ) : null,
                )}
              </div>
            )}
            {hasMore && (
              <button
                type="button"
                onClick={() => setShowAllNotifs(true)}
                className="cursor-pointer w-full text-center text-xs text-muted-foreground hover:text-foreground py-1 underline"
              >
                See more ({allNotifItems.length - 3} more)
              </button>
            )}
            {showAllNotifs && allNotifItems.length > 3 && (
              <button
                type="button"
                onClick={() => setShowAllNotifs(false)}
                className="cursor-pointer w-full text-center text-xs text-muted-foreground hover:text-foreground py-1 underline"
              >
                Show less
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ForcePasswordChangeScreen({
  fullName,
  onChanged,
  signOut,
}: {
  fullName: string | null;
  onChanged: () => void;
  signOut: () => void;
}) {
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    if (newPassword !== confirm) {
      toast.error("Passwords do not match");
      return;
    }
    setBusy(true);
    try {
      await api.post("/auth/change-password", { new_password: newPassword });
      toast.success("Password updated successfully");
      onChanged();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update password");
    } finally {
      setBusy(false);
    }
  }

  const cls =
    "w-full h-10 px-3 rounded-md border bg-background text-sm outline-none focus:ring-2 focus:ring-ring";

  return (
    <div className="min-h-screen bg-background text-foreground grid place-items-center px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-lg border bg-card p-6 shadow-soft space-y-5"
      >
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-lg bg-amber-100 text-amber-600 grid place-items-center shrink-0">
            <ShieldAlert className="h-6 w-6" />
          </div>
          <div>
            <p className="font-semibold leading-tight">Password change required</p>
            <p className="text-sm text-muted-foreground">
              {fullName ? `Welcome, ${fullName}.` : "Welcome."} Please set a new password to
              continue.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium" htmlFor="new-pw">
              New password
            </label>
            <input
              id="new-pw"
              type="password"
              required
              minLength={8}
              placeholder="Min. 8 characters"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className={cls + " mt-1"}
              autoFocus
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="confirm-pw">
              Confirm password
            </label>
            <input
              id="confirm-pw"
              type="password"
              required
              placeholder="Repeat new password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className={cls + " mt-1"}
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={busy || !newPassword || !confirm}
          className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
          Set new password
        </button>
        <button
          type="button"
          onClick={signOut}
          className="h-9 w-full rounded-md border bg-background text-sm font-medium hover:bg-muted"
        >
          Sign out
        </button>
      </form>
    </div>
  );
}

function RoleSelectionScreen({
  fullName,
  roles,
  selectRole,
  signOut,
}: {
  fullName: string | null;
  roles: AppRole[];
  selectRole: (role: AppRole) => void;
  signOut: () => void;
}) {
  const { roleLabel, roleDescription } = useAuth();
  const [selected, setSelected] = useState<AppRole>(roles[0]);

  useEffect(() => {
    if (!roles.includes(selected)) setSelected(roles[0]);
  }, [roles, selected]);

  return (
    <div className="min-h-screen bg-background text-foreground grid place-items-center px-4">
      <form
        className="w-full max-w-sm rounded-lg border bg-card p-6 shadow-soft"
        onSubmit={(event) => {
          event.preventDefault();
          selectRole(selected);
        }}
      >
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-lg bg-white grid place-items-center overflow-hidden border">
            <img
              src={logo}
              alt="Iwosan Lagoon Hospitals"
              className="h-full w-full object-contain"
            />
          </div>
          <div className="min-w-0">
            <p className="text-lg font-bold leading-tight">Choose your role</p>
            <p className="text-sm text-muted-foreground truncate">
              {fullName ? `Continue as ${fullName}` : "Select how you want to sign in"}
            </p>
          </div>
        </div>

        <label htmlFor="active-role" className="mt-6 block text-sm font-medium">
          Login role
        </label>
        <select
          id="active-role"
          value={selected}
          onChange={(event) => setSelected(event.target.value as AppRole)}
          className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          {roles.map((role) => (
            <option key={role} value={role}>
              {roleLabel(role)}
            </option>
          ))}
        </select>
        <p className="mt-2 min-h-10 text-xs text-muted-foreground">{roleDescription(selected)}</p>

        <button
          type="submit"
          className="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <LogIn className="h-4 w-4" />
          Open dashboard
        </button>
        <button
          type="button"
          onClick={signOut}
          className="mt-3 h-10 w-full rounded-md border bg-background text-sm font-medium hover:bg-muted"
        >
          Sign out
        </button>
      </form>
    </div>
  );
}

function currentTitle(path: string) {
  const n = nav.find((n) => (n.to === "/" ? path === "/" : path.startsWith(n.to)));
  return n?.label ?? "NurseRota";
}

function SidebarContent({
  path,
  items,
  onClose,
}: {
  path: string;
  items: (typeof nav)[number][];
  onClose?: () => void;
}) {
  return (
    <>
      <div className="px-5 py-5 flex items-center justify-between border-b border-sidebar-border">
        <div className="flex items-center gap-2.5">
          <div className="h-10 w-10 rounded-lg bg-white grid place-items-center overflow-hidden border border-sidebar-border">
            <img
              src={logo}
              alt="Iwosan Lagoon Hospitals"
              className="h-full w-full object-contain"
            />
          </div>
          <div>
            <p className="text-sm font-bold leading-tight">Nurses Rota</p>
            <p className="text-[11px] text-sidebar-foreground/60 leading-tight">
              Iwosan Lagoon Hospitals
            </p>
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 grid place-items-center rounded-md hover:bg-sidebar-accent"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {items.map(({ to, label, icon: Icon }) => {
          const active = to === "/" ? path === "/" : path.startsWith(to);
          return (
            <Link
              key={to}
              to={to}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-colors",
                active
                  ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          );
        })}
      </nav>
    </>
  );
}

function UserBlock({
  fullName,
  role,
  signOut,
}: {
  fullName: string | null;
  role: string | undefined;
  signOut: () => void;
}) {
  const { roleLabel } = useAuth();
  return (
    <div className="px-4 py-4 border-t border-sidebar-border flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-sidebar-foreground truncate">{fullName ?? "User"}</p>
        <p className="text-xs text-sidebar-foreground/60 truncate">
          {role ? roleLabel(role) : "Member"}
        </p>
      </div>
      <button
        type="button"
        onClick={signOut}
        className="h-8 w-8 grid place-items-center rounded-md hover:bg-sidebar-accent"
        aria-label="Sign out"
        title="Sign out"
      >
        <LogOut className="h-4 w-4" />
      </button>
    </div>
  );
}

function PasswordExpiryModal({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!currentPassword) {
      toast.error("Current password is required");
      return;
    }
    if (newPassword.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    if (newPassword === currentPassword) {
      toast.error("New password must be different from your current password");
      return;
    }
    if (newPassword !== confirm) {
      toast.error("Passwords do not match");
      return;
    }
    setBusy(true);
    try {
      await api.post("/auth/change-password-expiry", {
        current_password: currentPassword,
        new_password: newPassword,
      });
      toast.success("Password updated successfully");
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
      onChanged();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update password");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  const cls =
    "w-full h-10 px-3 rounded-md border bg-background text-sm outline-none focus:ring-2 focus:ring-ring";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-lg border bg-card p-6 shadow-xl space-y-5"
      >
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-amber-100 text-amber-600 grid place-items-center shrink-0">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <div>
            <p className="font-semibold leading-tight">Update your password</p>
            <p className="text-sm text-muted-foreground">
              Your password is expiring soon. Set a new one below.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium" htmlFor="ep-cur-pw">
              Current password
            </label>
            <input
              id="ep-cur-pw"
              type="password"
              required
              placeholder="Your current password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className={cls}
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="ep-new-pw">
              New password
            </label>
            <input
              id="ep-new-pw"
              type="password"
              required
              minLength={8}
              placeholder="Min. 8 characters"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className={cls}
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="ep-confirm-pw">
              Confirm new password
            </label>
            <input
              id="ep-confirm-pw"
              type="password"
              required
              minLength={8}
              placeholder="Repeat password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className={cls}
            />
          </div>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex-1 h-10 rounded-md border bg-card text-sm hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !currentPassword || !newPassword || !confirm}
            className="flex-1 h-10 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save password"}
          </button>
        </div>
      </form>
    </div>
  );
}
