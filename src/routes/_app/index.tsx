import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  Users,
  Building2,
  Clock,
  PlaneTakeoff,
  ChevronRight,
  CheckCircle2,
  Timer,
  CalendarDays,
  MapPin,
  PlayCircle,
  TrendingUp,
  ArrowLeftRight,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { type ComponentType, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";

export const Route = createFileRoute("/_app/")({
  head: () => ({
    meta: [
      { title: "Dashboard — Nurses Rota" },
      {
        name: "description",
        content: "Live overview of nursing staff, ward coverage and rota status.",
      },
    ],
  }),
  component: Dashboard,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtHours(dec: number) {
  const h = Math.floor(dec);
  const m = Math.round((dec - h) * 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function fmtHoursDetailed(dec: number) {
  const h = Math.floor(dec);
  const m = Math.round((dec - h) * 60);
  const totalMinutes = Math.round(dec * 60);
  if (h === 0) return `${m}m (${totalMinutes}m)`;
  if (m === 0) return `${h}h (${totalMinutes}m)`;
  return `${h}h ${m}m (${totalMinutes}m)`;
}

type NurseRecord = {
  id: string;
  name: string;
  role: string;
  ward: string | null;
  facility: string | null;
  hours_this_month: number;
  target_hours: number;
};

// Roles that are facility-wide: no ward is managed on the Staff page for them.
// Mirrors isNoWardRole in staff.tsx (coverage/head nurses, porters).
// Interns are excluded — they DO get a ward via rotation.
function isFacilityWideRole(role: string | undefined) {
  if (!role) return false;
  return /^(head|coverage)\s*nurse$|^matron$|^porter(\s*-\s*day)?$/i.test(role);
}

type Assignment = {
  shift: "M" | "N" | "OFF" | "LEAVE";
  shift_date: string;
  ward: string | null;
  status: string;
};

type ShiftLog = {
  id: string;
  nurse_id: string;
  shift_date: string;
  shift_type: "M" | "N";
  started_at: string;
  expected_end_at: string;
  ended_at: string | null;
  hours_logged: number | null;
  is_swap: boolean;
  swap_note: string | null;
  is_missed: boolean;
};

type WardRecord = {
  id: string;
  name: string;
  facility?: string | null;
  min_morning_nurses: number;
  min_morning_na: number;
  min_night_nurses: number;
  min_night_na: number;
};

type LeaveRequest = {
  id: string;
  nurse_name: string;
  type: string;
  from_date: string;
  to_date: string;
  status: string;
  created_at: string;
};

function fmtD(d: string): string {
  return new Date(d.slice(0, 10) + "T00:00:00").toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function fmtDateRange(from: string, to: string): string {
  return from.slice(0, 10) === to.slice(0, 10) ? fmtD(from) : `${fmtD(from)} – ${fmtD(to)}`;
}

// ── Shared stat card ──────────────────────────────────────────────────────────

interface StatProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "default" | "warn" | "danger" | "success";
}

function Stat({ icon: Icon, label, value, hint, tone = "default" }: StatProps) {
  const toneCls: Record<string, string> = {
    default: "bg-primary/10 text-primary",
    warn: "bg-amber-100 text-amber-700",
    danger: "bg-destructive/10 text-destructive",
    success: "bg-emerald-100 text-emerald-700",
  };
  return (
    <div className="bg-card border rounded-xl p-5 shadow-soft">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
            {label}
          </p>
          <p className="text-3xl font-bold mt-2">{value}</p>
          {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
        </div>
        <div className={`h-10 w-10 rounded-lg grid place-items-center shrink-0 ${toneCls[tone]}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

// ── Nurse personal dashboard ──────────────────────────────────────────────────

function NurseDashboard() {
  const { nurseId, fullName, nurseFacility } = useAuth();
  const today = todayYmd();

  const { data: nurseRecord } = useQuery<NurseRecord | null>({
    queryKey: ["my-nurse-record", nurseId],
    enabled: !!nurseId,
    queryFn: () => api.get<NurseRecord | null>(`/nurses/${nurseId}`),
  });

  const { data: todayAssignment } = useQuery<Assignment | null>({
    queryKey: ["my-today-assignment", nurseId, today],
    enabled: !!nurseId,
    queryFn: () =>
      api
        .get<
          Assignment[]
        >(`/shift-assignments?nurse_id=${nurseId}&shift_date=${today}&status=published&limit=1`)
        .then((arr) => arr[0] ?? null),
  });

  const next7 = ymd(new Date(Date.now() + 86400000));
  const end7 = ymd(new Date(Date.now() + 7 * 86400000));
  const { data: upcomingAssignments = [] } = useQuery<Assignment[]>({
    queryKey: ["my-upcoming", nurseId, next7],
    enabled: !!nurseId,
    queryFn: () =>
      api.get<Assignment[]>(
        `/shift-assignments?nurse_id=${nurseId}&from=${next7}&to=${end7}&status=published`,
      ),
  });

  type LocumInviteForDash = {
    id: string;
    status: string;
    locum_request: {
      id: string;
      shift: "M" | "N";
      ward: string;
      facility: string;
      shift_date: string;
    } | null;
  };

  const { data: acceptedLocumInvites = [] } = useQuery<LocumInviteForDash[]>({
    queryKey: ["my-accepted-locums", nurseId],
    enabled: !!nurseId,
    queryFn: () =>
      api
        .get<LocumInviteForDash[]>(`/locum/invites?nurse_id=${nurseId}&status=accepted`)
        .catch(() => []),
  });

  const { data: activeLog } = useQuery<ShiftLog | null>({
    queryKey: ["my-active-log", nurseId, today],
    enabled: !!nurseId,
    queryFn: () =>
      api.get<ShiftLog | null>(`/shift-logs/current?nurse_id=${nurseId}&shift_date=${today}`),
    refetchInterval: 60000,
  });

  const { data: periodLogs = [] } = useQuery<ShiftLog[]>({
    queryKey: ["my-period-logs-dash", nurseId],
    enabled: !!nurseId,
    queryFn: () => {
      const lookback = new Date();
      lookback.setDate(lookback.getDate() - 27);
      const lb = ymd(lookback);
      return api.get<ShiftLog[]>(`/shift-logs?nurse_id=${nurseId}&from=${lb}&hours_not_null=true`);
    },
  });

  const { data: myLeave = [] } = useQuery<LeaveRequest[]>({
    queryKey: ["my-leave", nurseId],
    enabled: !!nurseId,
    queryFn: () => api.get<LeaveRequest[]>(`/leave-requests?nurse_id=${nurseId}&limit=5`),
  });

  const todayLocumInvite = acceptedLocumInvites.find(
    (inv) => inv.locum_request?.shift_date?.slice(0, 10) === today,
  );
  const todayLocum = todayLocumInvite?.locum_request ?? null;

  const locumAssignment: Assignment | null = todayLocum
    ? {
        shift: todayLocum.shift,
        shift_date: today,
        ward: `${todayLocum.ward} · ${todayLocum.facility}`,
        status: "published",
      }
    : null;

  const effectiveAssignment = locumAssignment ?? todayAssignment;

  // Map of upcoming locum dates (next 7 days) → locum info, for "Next 7 days" bank badge
  const upcomingLocumMap = new Map<string, { shift: "M" | "N"; ward: string; facility: string }>(
    acceptedLocumInvites
      .filter((inv) => {
        const d = inv.locum_request?.shift_date?.slice(0, 10);
        return d && d > today && d <= end7;
      })
      .map((inv) => [
        inv.locum_request!.shift_date.slice(0, 10),
        { shift: inv.locum_request!.shift, ward: inv.locum_request!.ward, facility: inv.locum_request!.facility },
      ]),
  );

  // Days with a locum but no published shift_assignment (e.g. nurse not in that facility's rota)
  const locumOnlyUpcoming: Assignment[] = Array.from(upcomingLocumMap.entries())
    .filter(([d]) => !upcomingAssignments.some((a) => a.shift_date.slice(0, 10) === d))
    .map(([d, lr]) => ({
      shift: lr.shift,
      shift_date: d,
      ward: `${lr.ward} · ${lr.facility}`,
      status: "published" as const,
    }));

  const mergedUpcoming = [...upcomingAssignments, ...locumOnlyUpcoming].sort((a, b) =>
    a.shift_date.localeCompare(b.shift_date),
  );

  const regularLogs = periodLogs.filter((l) => !l.is_swap);
  const additionalLogs = periodLogs.filter((l) => l.is_swap && l.hours_logged != null);
  const periodHours = regularLogs.reduce((s, l) => s + (l.hours_logged ?? 0), 0);
  const additionalHours = additionalLogs.reduce((s, l) => s + (l.hours_logged ?? 0), 0);
  const totalMinutes = Math.round(periodHours * 60);
  const targetHours = nurseRecord?.target_hours ?? 185;
  const pct = Math.min(Math.round((periodHours / targetHours) * 100), 100);
  const completedShiftCount = regularLogs.filter(
    (l) => l.hours_logged !== null && !l.is_missed,
  ).length;
  const missedShiftCount = regularLogs.filter((l) => l.is_missed).length;

  const shiftLabel: Record<string, string> = {
    M: "Morning",
    N: "Night",
    OFF: "Day Off",
    LEAVE: "On Leave",
  };
  const shiftColor: Record<string, string> = {
    M: "bg-amber-100 text-amber-800 border-amber-200",
    N: "bg-indigo-100 text-indigo-800 border-indigo-300",
    OFF: "bg-muted text-muted-foreground border-transparent",
    LEAVE: "bg-rose-100 text-rose-800 border-rose-200",
  };
  const shiftTime: Record<string, string> = { M: "08:00 – 17:00", N: "17:00 – 08:00" };

  const isShiftActive = activeLog?.ended_at == null;
  const elapsedMs =
    activeLog && activeLog.ended_at == null
      ? Date.now() - new Date(activeLog.started_at).getTime()
      : 0;
  const elapsedH = Math.floor(elapsedMs / 3600000);
  const elapsedM = Math.floor((elapsedMs % 3600000) / 60000);
  const elapsedTotalMinutes = elapsedH * 60 + elapsedM;

  const leaveStatusColor: Record<string, string> = {
    Pending: "bg-amber-100 text-amber-700",
    Approved: "bg-emerald-100 text-emerald-700",
    Rejected: "bg-rose-100 text-rose-700",
  };

  return (
    <div className="space-y-6">
      <ManagementAlerts />
      <PageHeader
        title={`Welcome, ${fullName?.split(" ")[0] ?? "Nurse"}`}
        subtitle={[
          nurseRecord?.role,
          nurseFacility,
          !isFacilityWideRole(nurseRecord?.role) && nurseRecord?.ward?.split("|")[0],
        ]
          .filter(Boolean)
          .join(" · ")}
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="bg-card border rounded-xl p-5 shadow-soft">
          <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
            Facility
          </p>
          <p className="mt-2 text-lg font-semibold">
            {nurseRecord?.facility ?? nurseFacility ?? "Not assigned"}
          </p>
        </div>
        <div className="bg-card border rounded-xl p-5 shadow-soft">
          <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Ward</p>
          <p className="mt-2 text-lg font-semibold">
            {isFacilityWideRole(nurseRecord?.role)
              ? "Facility-wide"
              : (nurseRecord?.ward?.split("|")[0] ?? "Not assigned")}
          </p>
        </div>
        <div className="bg-card border rounded-xl p-5 shadow-soft">
          <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
            28-day hours
          </p>
          <p className="mt-2 text-lg font-semibold">{fmtHours(periodHours)}</p>
          <p className="text-xs text-muted-foreground mt-1">{totalMinutes}m total</p>
          {additionalHours > 0 && (
            <p className="text-xs text-sky-600 mt-0.5">+{fmtHours(additionalHours)} additional</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4">
        <Stat
          icon={Timer}
          label="Hours this period"
          value={fmtHours(periodHours)}
          hint={`Target: ${fmtHours(targetHours)}`}
          tone={pct >= 100 ? "success" : "default"}
        />
        <Stat
          icon={TrendingUp}
          label="Shifts completed"
          value={completedShiftCount}
          hint="This 28-day cycle"
        />
        <Stat
          icon={AlertTriangle}
          label="Missed shifts"
          value={missedShiftCount}
          hint="This 28-day cycle"
          tone={missedShiftCount > 0 ? "danger" : "default"}
        />
        <Stat
          icon={PlaneTakeoff}
          label="Approved leave"
          value={myLeave.filter((l) => l.status === "Approved").length}
          hint="Approved requests"
          tone="success"
        />
        <Stat
          icon={CheckCircle2}
          label="Pending leave"
          value={myLeave.filter((l) => l.status === "Pending").length}
          tone={myLeave.some((l) => l.status === "Pending") ? "warn" : "default"}
        />
      </div>

      <div className="bg-card border rounded-xl p-5 shadow-soft">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-semibold">Hours progress — current 28-day period</p>
          <span className="text-xs text-muted-foreground tabular-nums">
            {fmtHours(periodHours)} / {fmtHours(targetHours)}
            {additionalHours > 0 && (
              <span className="ml-1.5 text-sky-600">+{fmtHours(additionalHours)} additional</span>
            )}
          </span>
        </div>
        <div className="h-3 rounded-full bg-muted overflow-hidden">
          <Progress value={pct} className="h-full rounded-full" />
        </div>
        <p className="text-xs text-muted-foreground mt-1.5">{pct}% of target hours reached</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-card border rounded-xl p-5 shadow-soft">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">Today's shift</h2>
            <Link
              to="/shift"
              className="text-xs text-primary inline-flex items-center gap-1 hover:underline"
            >
              Track <ChevronRight className="h-3 w-3" />
            </Link>
          </div>
          {effectiveAssignment ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={cn(
                    "inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold border",
                    shiftColor[effectiveAssignment.shift] ?? shiftColor.OFF,
                  )}
                >
                  {shiftLabel[effectiveAssignment.shift] ?? effectiveAssignment.shift}
                </span>
                {locumAssignment && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-purple-100 text-purple-700 border border-purple-200">
                    Bank Shift (Locum)
                  </span>
                )}
              </div>
              {shiftTime[effectiveAssignment.shift] && (
                <p className="text-sm text-muted-foreground">
                  <Clock className="h-3.5 w-3.5 inline mr-1" />
                  {shiftTime[effectiveAssignment.shift]}
                </p>
              )}
              {effectiveAssignment.ward && (
                <p className="text-sm text-muted-foreground">
                  <MapPin className="h-3.5 w-3.5 inline mr-1" />
                  {effectiveAssignment.ward}
                </p>
              )}
              {isShiftActive && (
                <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700">
                  <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                  Active — {elapsedH}h {elapsedM}m elapsed ({elapsedTotalMinutes}m)
                </div>
              )}
              {!activeLog &&
                effectiveAssignment.status === "published" &&
                (effectiveAssignment.shift === "M" || effectiveAssignment.shift === "N") && (
                  <Link
                    to="/shift"
                    className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700"
                  >
                    <PlayCircle className="h-4 w-4" /> Start Shift
                  </Link>
                )}
              {activeLog?.ended_at && (
                <p className="text-sm text-muted-foreground">
                  Completed · {fmtHoursDetailed(activeLog.hours_logged ?? 0)} logged
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No assignment for today
            </p>
          )}

        </div>

        <div className="bg-card border rounded-xl p-5 shadow-soft">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">Next 7 days</h2>
            <Link
              to="/rota"
              search={{ myOnly: true }}
              className="text-xs text-primary inline-flex items-center gap-1 hover:underline"
            >
              View rota <ChevronRight className="h-3 w-3" />
            </Link>
          </div>
          {mergedUpcoming.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No upcoming shifts found
            </p>
          ) : (
            <div className="space-y-2">
              {mergedUpcoming.map((a) => {
                const d = a.shift_date.slice(0, 10);
                const isLocum = upcomingLocumMap.has(d);
                const dt = new Date(d + "T00:00:00");
                return (
                  <div key={d} className="flex items-center justify-between text-sm">
                    <span className="w-24 text-muted-foreground">
                      {dt.toLocaleDateString("en-GB", {
                        weekday: "short",
                        day: "numeric",
                        month: "short",
                      })}
                    </span>
                    <div className="flex items-center gap-1.5">
                      {isLocum && (
                        <span className="text-xs px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 border border-purple-200 font-semibold dark:bg-purple-950/30 dark:text-purple-300 dark:border-purple-800">
                          Bank
                        </span>
                      )}
                      <span
                        className={cn(
                          "text-xs px-2 py-0.5 rounded-full font-semibold border",
                          shiftColor[a.shift] ?? shiftColor.OFF,
                        )}
                      >
                        {shiftLabel[a.shift] ?? a.shift}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-card border rounded-xl p-5 shadow-soft">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">My leave requests</h2>
            <Link
              to="/leave"
              className="text-xs text-primary inline-flex items-center gap-1 hover:underline"
            >
              Manage <ChevronRight className="h-3 w-3" />
            </Link>
          </div>
          {myLeave.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No leave requests yet</p>
          ) : (
            <div className="space-y-2.5">
              {myLeave.map((l) => (
                <div
                  key={l.id}
                  className="flex items-center justify-between text-sm border rounded-lg px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="font-medium truncate">{l.type}</p>
                    <p className="text-xs text-muted-foreground">
                      {fmtDateRange(l.from_date, l.to_date)}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "text-xs px-2 py-0.5 rounded-full font-semibold shrink-0 ml-2",
                      leaveStatusColor[l.status],
                    )}
                  >
                    {l.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {additionalLogs.length > 0 && (
        <div className="bg-card border rounded-xl shadow-soft overflow-hidden">
          <div className="px-5 py-4 border-b flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ArrowLeftRight className="h-4 w-4 text-sky-600" />
              <h2 className="font-semibold text-sm">Additional Shift Hours</h2>
            </div>
            <span className="text-xs text-muted-foreground">{fmtHours(additionalHours)} total</span>
          </div>
          <p className="px-5 pt-3 text-xs text-muted-foreground">
            Hours worked as shift-switch cover — tracked separately, not included in your period
            total.
          </p>
          <div className="divide-y mt-2">
            {additionalLogs.map((log) => (
              <div key={log.id} className="px-5 py-3 flex items-center justify-between text-sm">
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      "h-7 w-7 rounded-full grid place-items-center text-xs font-bold",
                      log.shift_type === "M"
                        ? "bg-amber-100 text-amber-700"
                        : "bg-indigo-100 text-indigo-700",
                    )}
                  >
                    {log.shift_type}
                  </span>
                  <div>
                    <p className="font-medium">
                      {new Date(log.shift_date.slice(0, 10) + "T00:00:00").toLocaleDateString(
                        "en-GB",
                        {
                          weekday: "short",
                          day: "numeric",
                          month: "short",
                        },
                      )}
                    </p>
                    {log.swap_note && (
                      <p className="text-xs text-sky-700 mt-0.5 italic">{log.swap_note}</p>
                    )}
                  </div>
                </div>
                <span className="font-semibold tabular-nums text-sky-700">
                  {fmtHours(Number(log.hours_logged))}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Management alerts (shared by NurseDashboard and ManagementDashboard) ─────

const FW_GROUP_LABELS: Record<string, string> = {
  matron: "Matron",
  head: "Coverage Nurses",
  porter: "Porter",
  intern: "Nurse Interns",
  facility_wide: "Facility-Wide Staff",
};

function parseRegenKey(key: string) {
  const prefix = "rota_regenerate_needed_";
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const dateMatch = rest.match(/(\d{4}-\d{2}-\d{2})/);
  if (!dateMatch) return null;
  const periodStart = dateMatch[1];
  const halves = rest.split(periodStart);
  const fSlug = halves[0].replace(/_$/, "");
  const wSlug = (halves[1] ?? "").replace(/^_/, "");
  const facilityDisplay = fSlug.charAt(0).toUpperCase() + fSlug.slice(1).replace(/_/g, " ");
  const wardDisplay = wSlug
    ? (FW_GROUP_LABELS[wSlug] ?? wSlug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()))
    : null;
  const pStart = new Date(periodStart + "T00:00:00");
  const pEnd = new Date(pStart);
  pEnd.setDate(pEnd.getDate() + 27);
  const fmtOpts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  const periodDisplay = `${pStart.toLocaleDateString("en-GB", fmtOpts)} – ${pEnd.toLocaleDateString("en-GB", { ...fmtOpts, year: "numeric" })}`;
  return { facilityDisplay, wardDisplay, periodDisplay };
}

// Renders leave-blocking and regen alerts. Included in both NurseDashboard (for
// head_nurse and chief_matron) and ManagementDashboard. Queries are deduplicated
// by TanStack Query when both components mount simultaneously.
function ManagementAlerts() {
  const { isAdmin, nurseFacility, canApproveLeave, activeRole, user } = useAuth();

  const canSeeRegen = activeRole === "head_nurse" || isAdmin;
  const canSeePlc = canApproveLeave;
  const canSeeAll = isAdmin || activeRole === "cno" || activeRole === "hr_admin";
  const facilityFilter: string | null = canSeeAll ? null : (nurseFacility ?? null);
  const facilitySlug = nurseFacility ? nurseFacility.toLowerCase().replace(/\s+/g, "_") : null;

  const { data: allNurses = [] } = useQuery({
    queryKey: ["nurses"],
    queryFn: () => api.get<Record<string, unknown>[]>("/nurses"),
  });
  const { data: leave = [] } = useQuery({
    queryKey: ["leave"],
    queryFn: () => api.get<LeaveRequest[]>("/leave-requests"),
  });
  const { data: allNotifs } = useQuery({
    queryKey: ["notif-state", user?.id],
    enabled: !!user?.id,
    staleTime: 0,
    refetchInterval: 30 * 1000,
    queryFn: () => api.get<{ notif_key: string; is_read: boolean }[]>("/notifications"),
  });
  const { data: facilityRegenKeys = [] } = useQuery<string[]>({
    queryKey: ["regen-needed", facilitySlug],
    enabled: canSeeRegen,
    staleTime: 0,
    refetchInterval: 30 * 1000,
    queryFn: () =>
      api.get<string[]>(
        facilitySlug
          ? `/notifications/regen-needed?facility=${facilitySlug}`
          : "/notifications/regen-needed",
      ),
  });
  const { data: facilityPlcKeys = [] } = useQuery<string[]>({
    queryKey: ["plc-needed", facilitySlug],
    enabled: canSeePlc,
    staleTime: 0,
    refetchInterval: 30 * 1000,
    queryFn: () =>
      api.get<string[]>(
        facilitySlug
          ? `/notifications/plc-needed?facility=${facilitySlug}`
          : "/notifications/plc-needed",
      ),
  });

  const nurses = facilityFilter
    ? allNurses.filter((n) => n.facility === facilityFilter)
    : allNurses;
  const facilityNurseNames = new Set(nurses.map((n) => n.name));
  const visibleLeave = facilityFilter
    ? leave.filter((l) => facilityNurseNames.has(l.nurse_name))
    : leave;
  const pendingLeave = visibleLeave.filter((l) => l.status === "Pending");

  const regenPrefix = facilitySlug
    ? `rota_regenerate_needed_${facilitySlug}_`
    : "rota_regenerate_needed_";
  const userRegenKeys =
    allNotifs
      ?.filter((r) => !r.is_read && r.notif_key.startsWith(regenPrefix))
      .map((r) => r.notif_key) ?? [];
  const regenNotifKeys = [...new Set([...facilityRegenKeys, ...userRegenKeys])];

  const plcPrefix = facilitySlug ? `pending_leave_check_${facilitySlug}_` : "pending_leave_check_";
  const userPlcKeys =
    allNotifs
      ?.filter((r) => !r.is_read && r.notif_key.startsWith(plcPrefix))
      .map((r) => r.notif_key) ?? [];
  const pendingLeaveNotifKeys = [...new Set([...facilityPlcKeys, ...userPlcKeys])];

  const { data: workflowStatus } = useQuery<{
    firstRotaPublished: boolean;
    nextPeriodStart?: string;
    leaveIsClosed?: boolean;
    nextRotaStage?: string;
  }>({
    queryKey: ["workflow-status"],
    staleTime: 5 * 60 * 1000,
    queryFn: () => api.get("/rpc/workflow-status"),
  });

  const fmtWD = (d?: string) =>
    d
      ? new Date(d.slice(0, 10) + "T00:00:00").toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : "";

  const wfReady = !!workflowStatus?.firstRotaPublished;
  const stage = workflowStatus?.nextRotaStage;
  const canWfGenPub = activeRole === "head_nurse" || isAdmin;
  const canWfA1 = activeRole === "chief_matron" || isAdmin;
  const canWfA2 = activeRole === "cno" || isAdmin;
  const showWfGenerate =
    wfReady &&
    workflowStatus?.leaveIsClosed &&
    canWfGenPub &&
    (stage === "none" || stage === "draft");
  const showWfApprove1 = wfReady && stage === "submitted" && canWfA1;
  const showWfApprove2 = wfReady && stage === "approved_chief" && canWfA2;
  const showWfPublish = wfReady && stage === "approved_cno" && canWfGenPub;
  const showWorkflowBanner = showWfGenerate || showWfApprove1 || showWfApprove2 || showWfPublish;

  const showRegenAlert = canSeeRegen && regenNotifKeys.length > 0;
  const showPendingLeaveMatron = canApproveLeave && !isAdmin && pendingLeaveNotifKeys.length > 0;
  const generalPendingCount = pendingLeave.filter((l) => l.type !== "Swap").length;
  const showGeneralPendingForMatron = canApproveLeave && !isAdmin && generalPendingCount > 0;
  const showPendingLeaveInfo =
    (activeRole === "head_nurse" || isAdmin) && pendingLeaveNotifKeys.length > 0 && !showRegenAlert;

  if (
    !showRegenAlert &&
    !showPendingLeaveMatron &&
    !showGeneralPendingForMatron &&
    !showPendingLeaveInfo &&
    !showWorkflowBanner
  )
    return null;

  const wfPeriodStr = fmtWD(workflowStatus?.nextPeriodStart);

  return (
    <div className="space-y-3">
      {showWfGenerate && (
        <div
          className={`rounded-xl border-2 p-4 flex items-start gap-3 ${
            stage === "draft"
              ? "border-amber-400 bg-amber-50 dark:bg-amber-950/30"
              : "border-blue-400 bg-blue-50 dark:bg-blue-950/30"
          }`}
        >
          <Clock
            className={`h-5 w-5 shrink-0 mt-0.5 ${stage === "draft" ? "text-amber-600" : "text-blue-600"}`}
          />
          <div className="flex-1 min-w-0">
            <p
              className={`font-bold ${stage === "draft" ? "text-amber-800 dark:text-amber-300" : "text-blue-800 dark:text-blue-300"}`}
            >
              {stage === "draft"
                ? "Draft rota ready — submit for approval"
                : "Time to generate the next rota"}
            </p>
            <p
              className={`text-sm mt-1 ${stage === "draft" ? "text-amber-700 dark:text-amber-400" : "text-blue-700 dark:text-blue-400"}`}
            >
              {stage === "draft"
                ? `The draft schedule for ${wfPeriodStr} is ready. Go to the Rota page to review and submit it.`
                : `Leave window for ${wfPeriodStr} is closed. Go to the Rota page to generate the schedule.`}
            </p>
          </div>
        </div>
      )}
      {showWfApprove1 && (
        <div className="rounded-xl border-2 border-amber-400 bg-amber-50 dark:bg-amber-950/30 p-4 flex items-start gap-3">
          <Clock className="h-5 w-5 shrink-0 text-amber-600 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="font-bold text-amber-800 dark:text-amber-300">
              Draft rota awaiting Chief Matron approval
            </p>
            <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
              The rota for {wfPeriodStr} has been submitted. Go to Approvals to review and approve.
            </p>
          </div>
        </div>
      )}
      {showWfApprove2 && (
        <div className="rounded-xl border-2 border-amber-400 bg-amber-50 dark:bg-amber-950/30 p-4 flex items-start gap-3">
          <Clock className="h-5 w-5 shrink-0 text-amber-600 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="font-bold text-amber-800 dark:text-amber-300">
              Rota awaiting CNO final approval
            </p>
            <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
              Chief Matron approved the rota for {wfPeriodStr}. Go to Approvals for CNO sign-off.
            </p>
          </div>
        </div>
      )}
      {showWfPublish && (
        <div className="rounded-xl border-2 border-amber-400 bg-amber-50 dark:bg-amber-950/30 p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="font-bold text-amber-800 dark:text-amber-300">
              Rota approved — ready to publish
            </p>
            <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
              CNO has approved the rota for {wfPeriodStr}. Go to Approvals to publish it.
            </p>
          </div>
        </div>
      )}
      {showPendingLeaveInfo && (
        <div className="rounded-xl border-2 border-orange-400 bg-orange-50 dark:bg-orange-950/30 p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 shrink-0 text-orange-600 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="font-bold text-orange-800 dark:text-orange-300">
              Pending leave requests are blocking rota submission
            </p>
            <p className="text-sm text-orange-700 dark:text-orange-400 mt-1">
              One or more leave requests were submitted after the rota draft was created. The matron
              needs to approve or reject them before the rota can be submitted. You will be notified
              here once the matron has acted and the rota is ready to regenerate.
            </p>
          </div>
        </div>
      )}
      {showRegenAlert && (
        <div className="rounded-xl border-2 border-amber-400 bg-amber-50 dark:bg-amber-950/30 p-4 flex items-start gap-3">
          <RefreshCw className="h-5 w-5 shrink-0 text-amber-600 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="font-bold text-amber-800 dark:text-amber-300">
              Action required: Regenerate the following draft rota
              {regenNotifKeys.length > 1 ? "s" : ""}
            </p>
            <ul className="mt-1 space-y-0.5">
              {regenNotifKeys.map((key) => {
                const parsed = parseRegenKey(key);
                if (!parsed) return null;
                return (
                  <li key={key} className="text-sm text-amber-700 dark:text-amber-400">
                    <strong>{parsed.wardDisplay ?? parsed.facilityDisplay}</strong>
                    {parsed.wardDisplay && (
                      <span className="text-amber-600 dark:text-amber-500">
                        {" "}
                        · {parsed.facilityDisplay}
                      </span>
                    )}
                    <span className="text-amber-600 dark:text-amber-500">
                      {" "}
                      · {parsed.periodDisplay}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="text-sm text-amber-700 dark:text-amber-400 mt-2">
              Go to the <strong>Rota page</strong>, select the ward above, and click{" "}
              <strong>Regenerate</strong> to apply the latest leave before submitting.
            </p>
          </div>
          <Link
            to="/rota"
            className="shrink-0 h-9 px-4 rounded-md bg-amber-600 text-white text-sm font-semibold inline-flex items-center gap-1.5 hover:bg-amber-700"
          >
            Go to Rota
          </Link>
        </div>
      )}
      {showPendingLeaveMatron && (
        <div className="rounded-xl border-2 border-red-400 bg-red-50 dark:bg-red-950/30 p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 shrink-0 text-red-600 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="font-bold text-red-800 dark:text-red-300">
              Urgent: A rota submission is being blocked
            </p>
            <p className="text-sm text-red-700 dark:text-red-400 mt-1">
              The head nurse attempted to submit a rota but pending leave requests are blocking it.
              Please approve or reject the outstanding leave requests so the rota can be submitted.
            </p>
          </div>
          <Link
            to="/leave"
            className="shrink-0 h-9 px-4 rounded-md bg-red-600 text-white text-sm font-semibold inline-flex items-center gap-1.5 hover:bg-red-700"
          >
            Review Leave
          </Link>
        </div>
      )}
      {showGeneralPendingForMatron && (
        <div className="rounded-xl border-2 border-amber-400 bg-amber-50 dark:bg-amber-950/30 p-4 flex items-start gap-3">
          <Clock className="h-5 w-5 shrink-0 text-amber-600 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="font-bold text-amber-800 dark:text-amber-300">
              {generalPendingCount} pending leave request
              {generalPendingCount > 1 ? "s" : ""} awaiting your review
            </p>
            <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
              These have not yet blocked a rota submission, but should be reviewed and approved or
              rejected in good time.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Management dashboard ──────────────────────────────────────────────────────

function ManagementDashboard() {
  const { fullName, isAdmin, nurseFacility, activeRole } = useAuth();

  // Admin, CNO, and HR are not tied to a facility — they see data across all facilities.
  const canSeeAll = isAdmin || activeRole === "cno" || activeRole === "hr_admin";
  const facilityFilter: string | null = canSeeAll ? null : (nurseFacility ?? null);

  const { data: allNurses = [] } = useQuery({
    queryKey: ["nurses"],
    queryFn: () => api.get<Record<string, unknown>[]>("/nurses"),
  });
  const { data: wards = [] } = useQuery({
    queryKey: ["wards"],
    queryFn: () => api.get<WardRecord[]>("/wards"),
  });
  const { data: leave = [] } = useQuery({
    queryKey: ["leave"],
    queryFn: () => api.get<LeaveRequest[]>("/leave-requests"),
  });

  const nurses = facilityFilter
    ? allNurses.filter((n) => n.facility === facilityFilter)
    : allNurses;
  const facilityNurseNames = new Set(nurses.map((n) => n.name));
  const visibleWards = facilityFilter ? wards.filter((w) => w.facility === facilityFilter) : wards;
  const visibleLeave = facilityFilter
    ? leave.filter((l) => facilityNurseNames.has(l.nurse_name))
    : leave;
  const pendingLeave = visibleLeave.filter((l) => l.status === "Pending");

  const subtitle = facilityFilter
    ? `Live staffing and rota health · ${facilityFilter}`
    : "Live staffing, approvals and rota health across all facilities";

  return (
    <div className="space-y-6">
      <PageHeader
        title={fullName ? `Welcome, ${fullName.split(" ")[0]}` : "Operations Dashboard"}
        subtitle={subtitle}
      />

      <ManagementAlerts />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <Stat
          icon={Users}
          label="Staff"
          value={nurses.length}
          hint={facilityFilter ?? "All facilities"}
        />
        <Stat icon={Building2} label="Wards" value={visibleWards.length} hint="Configured wards" />
        <Stat
          icon={PlaneTakeoff}
          label="Pending Leave"
          value={pendingLeave.length}
          tone={pendingLeave.length ? "warn" : "default"}
        />
        <Stat
          icon={CheckCircle2}
          label="Approved Leave"
          value={visibleLeave.filter((l) => l.status === "Approved").length}
          tone="success"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-card border rounded-xl p-5 shadow-soft">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-semibold">Ward Safety Snapshot</h2>
              <p className="text-xs text-muted-foreground">Minimum-staffing rules per ward</p>
            </div>
            <Link
              to="/wards"
              className="text-xs text-primary inline-flex items-center gap-1 hover:underline"
            >
              View all <ChevronRight className="h-3 w-3" />
            </Link>
          </div>
          {visibleWards.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No wards configured yet.{" "}
              <Link to="/wards" className="text-primary hover:underline">
                Add one →
              </Link>
            </p>
          ) : (
            <div className="space-y-2">
              {visibleWards.slice(0, 8).map((w) => (
                <div key={w.id} className="flex items-center justify-between gap-3 text-sm py-1">
                  <span className="truncate font-medium w-32 sm:w-40">{w.name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                    AM: {w.min_morning_nurses}N+I · {w.min_morning_na}NA &nbsp;·&nbsp; PM:{" "}
                    {w.min_night_nurses}N+I · {w.min_night_na}NA
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-card border rounded-xl p-5 shadow-soft">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">Pending Leave</h2>
            <Link
              to="/leave"
              className="text-xs text-primary inline-flex items-center gap-1 hover:underline"
            >
              Review <ChevronRight className="h-3 w-3" />
            </Link>
          </div>
          {pendingLeave.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No pending requests</p>
          ) : (
            <div className="space-y-2.5">
              {pendingLeave.slice(0, 6).map((l) => (
                <div
                  key={l.id}
                  className="flex items-center justify-between border rounded-lg px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{l.nurse_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {l.type} · {fmtDateRange(l.from_date, l.to_date)}
                    </p>
                  </div>
                  <Clock className="h-4 w-4 text-amber-500 shrink-0" />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Quick links for management */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {[
          { to: "/rota", icon: CalendarDays, label: "View Rota" },
          { to: "/staff", icon: Users, label: "Manage Staff" },
          { to: "/reports", icon: TrendingUp, label: "Reports" },
        ].map(({ to, icon: Icon, label }) => (
          <Link
            key={to}
            to={to}
            className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-soft hover:bg-muted/50 transition text-sm font-medium"
          >
            <Icon className="h-4 w-4 text-primary shrink-0" />
            {label}
          </Link>
        ))}
      </div>
    </div>
  );
}

// ── Root dashboard ────────────────────────────────────────────────────────────

function Dashboard() {
  const { activeRole, nurseId } = useAuth();

  // Shift-working roles get the personal nurse dashboard. ManagementAlerts is
  // rendered inside NurseDashboard so head_nurse and chief_matron still see
  // leave-blocking and regen alerts alongside their personal schedule.
  const shiftWorkerRoles = [
    "nurse",
    "chief_matron",
    "head_nurse",
    "porter",
    "nursing_assistant",
    "surgical_nurse",
  ];
  if (activeRole && shiftWorkerRoles.includes(activeRole) && nurseId) {
    return <NurseDashboard />;
  }

  return <ManagementDashboard />;
}
