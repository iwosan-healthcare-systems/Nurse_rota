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
  PieChart as PieChartIcon,
  BarChart3,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { type ComponentType, type ReactNode, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import { CHART_SERIES_VARS, LEAVE_TYPE_ORDER, colorForLeaveType } from "@/lib/chart-colors";

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

function addDaysToYmd(dateStr: string, n: number) {
  const d = new Date(dateStr.slice(0, 10) + "T00:00:00");
  d.setDate(d.getDate() + n);
  return ymd(d);
}

/** Hours implied by a published shift_assignments cell (9h M/MWC, 15h N/NC, 0h OFF).
 *  A LEAVE cell is credited using pre_leave_shift — the shift it covered before being
 *  flipped to LEAVE — so approved leave still counts toward the period total. Mirrors
 *  scheduledHoursFor in shift.tsx. */
function scheduledHoursFor(shift: string, preLeaveShift: string | null) {
  const code = shift === "LEAVE" ? (preLeaveShift ?? "") : shift;
  if (code === "M" || code === "MWC") return 9;
  if (code === "N" || code === "NC") return 15;
  return 0;
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

type PeriodHours = {
  period_start: string;
  period_end: string;
  total_hours: number;
  total_shifts: number;
};

// Roles that are facility-wide: no ward is managed on the Staff page for them.
// Mirrors isNoWardRole in staff.tsx (coverage/head nurses incl. the Day
// variant, porters). Interns are excluded — they DO get a ward via rotation.
function isFacilityWideRole(role: string | undefined) {
  if (!role) return false;
  return /^(head|coverage)\s*nurse$|^coverage\s*nurse\s*-\s*day$|^matron$|^porter(\s*-\s*day)?$/i.test(
    role,
  );
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

  const { data: latestArchivedPeriod } = useQuery<PeriodHours | null>({
    queryKey: ["dashboard-latest-archived-period"],
    enabled: !!nurseId,
    refetchInterval: 60000,
    queryFn: async () => {
      const rows = await api.get<PeriodHours[]>("/nurse-period-hours?limit=1").catch(() => []);
      return rows[0] ?? null;
    },
  });

  const { data: periodLogs = [] } = useQuery<ShiftLog[]>({
    queryKey: ["my-period-logs-dash", nurseId, latestArchivedPeriod?.period_end],
    enabled: !!nurseId,
    queryFn: () => {
      const lookback = new Date();
      lookback.setDate(lookback.getDate() - 27);
      const lb = ymd(lookback);
      const periodStart = latestArchivedPeriod
        ? addDaysToYmd(latestArchivedPeriod.period_end, 1)
        : lb;
      const periodEnd = addDaysToYmd(periodStart, 27);
      return api.get<ShiftLog[]>(
        `/shift-logs?nurse_id=${nurseId}&period_start=${periodStart}&from=${periodStart}&to=${periodEnd}&hours_not_null=true`,
      );
    },
  });

  // Total hours this nurse is actually rostered for in the current period, computed
  // from her own published shift_assignments — not the manually-set target_hours
  // field. Same period-boundary approach as shift.tsx: the earliest published
  // assignment within the trailing 27-day window marks the period start, then the
  // full 28-day block is fetched from there.
  const { data: periodData } = useQuery<{
    periodEnd: string;
    rows: { shift: string; pre_leave_shift: string | null }[];
  }>({
    queryKey: ["my-period-assignments-dash", nurseId, latestArchivedPeriod?.period_end],
    enabled: !!nurseId,
    queryFn: async () => {
      const lookback = new Date();
      lookback.setDate(lookback.getDate() - 27);
      const lb = ymd(lookback);
      const winRow = await api
        .get<
          { shift_date: string }[]
        >(`/shift-assignments?nurse_id=${nurseId}&from=${lb}&status=published&limit=1`)
        .catch(() => []);
      const periodStart = latestArchivedPeriod
        ? addDaysToYmd(latestArchivedPeriod.period_end, 1)
        : (winRow[0]?.shift_date ?? lb);
      const periodEnd = addDaysToYmd(periodStart, 27);
      const rows = await api
        .get<
          { shift: string; pre_leave_shift: string | null }[]
        >(`/shift-assignments?nurse_id=${nurseId}&from=${periodStart}&to=${periodEnd}&status=published`)
        .catch(() => []);
      return { periodEnd, rows };
    },
  });
  const periodAssignments = periodData?.rows ?? [];
  // Her own next rota period start date — used both to tell the "ward is
  // changing" banner when it takes effect, and as the date it should stop
  // showing (see wardChanging below, which naturally goes false once today's
  // assignment rolls into that new period).
  const nextPeriodStart = periodData ? addDaysToYmd(periodData.periodEnd, 1) : null;

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

  // The ward shown as "her ward" must reflect the CURRENT rota period's actual
  // assignment, not the live nurses.ward value — an admin may already have
  // updated nurses.ward in preparation for the NEXT period's generation, and
  // that must not retroactively change what she sees while still working the
  // period she's actually on. todayAssignment.ward is snapshotted per-row at
  // generation time (unaffected by later nurses.ward edits), same as her real
  // shifts already are — deliberately NOT effectiveAssignment here, since that
  // folds in one-off locum cover, which is a different ward for today only.
  const currentPeriodWard = todayAssignment?.ward ?? nurseRecord?.ward ?? null;

  // A pending ward change for next period: nurses.ward (the live field, already
  // updated for next period's generation) differs from what she's actually on
  // right now. This banner needs no separate dismiss/expiry logic — the moment
  // "today" rolls into the next period, todayAssignment picks up that period's
  // (new-ward) row and this naturally goes false on its own, same as
  // currentPeriodWard above transitions itself.
  const currentWardToken = !isFacilityWideRole(nurseRecord?.role)
    ? (todayAssignment?.ward?.split("|")[0] ?? null)
    : null;
  const nextWardToken = !isFacilityWideRole(nurseRecord?.role)
    ? (nurseRecord?.ward?.split("|")[0] ?? null)
    : null;
  const wardChanging = !!currentWardToken && !!nextWardToken && currentWardToken !== nextWardToken;

  // Map of upcoming locum dates (next 7 days) → locum info, for "Next 7 days" bank badge
  const upcomingLocumMap = new Map<string, { shift: "M" | "N"; ward: string; facility: string }>(
    acceptedLocumInvites
      .filter((inv) => {
        const d = inv.locum_request?.shift_date?.slice(0, 10);
        return d && d > today && d <= end7;
      })
      .map((inv) => [
        inv.locum_request!.shift_date.slice(0, 10),
        {
          shift: inv.locum_request!.shift,
          ward: inv.locum_request!.ward,
          facility: inv.locum_request!.facility,
        },
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
  const periodHours = regularLogs.reduce((s, l) => s + Number(l.hours_logged ?? 0), 0);
  const additionalHours = additionalLogs.reduce((s, l) => s + Number(l.hours_logged ?? 0), 0);
  const totalMinutes = Math.round(periodHours * 60);
  const scheduledHours = periodAssignments.reduce(
    (s, a) => s + scheduledHoursFor(a.shift, a.pre_leave_shift),
    0,
  );
  const targetHours = scheduledHours || Number(nurseRecord?.target_hours ?? 180);
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
      {wardChanging && nextPeriodStart && (
        <div className="flex items-start gap-3 rounded-lg border border-sky-300 bg-sky-50 dark:bg-sky-950/20 dark:border-sky-700 px-4 py-3 text-sm text-sky-800 dark:text-sky-300">
          <ArrowLeftRight className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Your ward is changing</p>
            <p className="mt-0.5 text-sky-700 dark:text-sky-400">
              <strong>{currentWardToken}</strong> → <strong>{nextWardToken}</strong>. Your shifts
              will be generated in <strong>{nextWardToken}</strong> starting{" "}
              <strong>{fmtD(nextPeriodStart)}</strong>. This takes effect automatically — no action
              needed.
            </p>
          </div>
        </div>
      )}
      <PageHeader
        title={`Welcome, ${fullName?.split(" ")[0] ?? "Nurse"}`}
        subtitle={[
          nurseRecord?.role,
          nurseFacility,
          !isFacilityWideRole(nurseRecord?.role) && currentPeriodWard?.split("|")[0],
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
              : (currentPeriodWard?.split("|")[0] ?? "Not assigned")}
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
                  Completed · {fmtHoursDetailed(Number(activeLog.hours_logged ?? 0))} logged
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
    leaveClosureDate?: string;
    generateDate?: string;
    editCloseDate?: string;
    publishDeadline?: string;
    leaveIsClosed?: boolean;
    editIsClosed?: boolean;
    nextRotaStage?: string;
    stageCounts?: { draft: number; submitted: number; cno_approved: number; published: number };
    totalUnits?: number;
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

  // Every stage above "draft" can be a MIX of units at different stages —
  // nextRotaStage only reports the single most-advanced one present, which
  // was actively misleading on its own (e.g. showing "approved, ready to
  // publish" when only one ward out of many had actually reached that
  // stage). This renders the other counts as a trailing breakdown so the
  // banner is honest about what's actually going on across all units.
  const stageCounts = workflowStatus?.stageCounts;
  const totalUnits = workflowStatus?.totalUnits;
  function unitCountsBreakdown(highlight: "submitted" | "cno_approved" | "published"): string {
    if (!stageCounts || !totalUnits) return "";
    const parts: string[] = [];
    if (stageCounts.draft > 0) parts.push(`${stageCounts.draft} still in draft`);
    if (highlight !== "submitted" && stageCounts.submitted > 0)
      parts.push(`${stageCounts.submitted} submitted, awaiting CNO`);
    if (highlight !== "cno_approved" && stageCounts.cno_approved > 0)
      parts.push(`${stageCounts.cno_approved} approved, not yet published`);
    if (highlight !== "published" && stageCounts.published > 0)
      parts.push(`${stageCounts.published} already published`);
    return parts.length ? ` · ${parts.join(" · ")}` : "";
  }

  const wfReady = !!workflowStatus?.firstRotaPublished;
  const stage = workflowStatus?.nextRotaStage;
  // Generation is now automatic (T-19) — a manual trigger is admin-only, so
  // this banner becomes purely informational for everyone else.
  const canWfGenerate = isAdmin;
  const canWfSubmit = activeRole === "head_nurse" || isAdmin;
  const canWfApproveRota = activeRole === "cno" || isAdmin;
  const canWfPublish = activeRole === "cno" || isAdmin;
  const showWfGenerate =
    wfReady && workflowStatus?.leaveIsClosed && canWfGenerate && stage === "none";
  const showWfSubmit = wfReady && stage === "draft" && canWfSubmit;
  const showWfApproveRota = wfReady && stage === "submitted" && canWfApproveRota;
  const showWfPublish = wfReady && stage === "cno_approved" && canWfPublish;
  const showWorkflowBanner = showWfGenerate || showWfSubmit || showWfApproveRota || showWfPublish;
  const wfPeriodStr = fmtWD(workflowStatus?.nextPeriodStart);

  // Status timeline banner — unlike the role-gated "action needed" banners
  // above, this one is visible to every role (everyone renders ManagementAlerts,
  // see the comment on Dashboard()) so anyone can see where the next rota
  // period stands across T-21/T-19/T-17/T-14, not just whoever's turn it is
  // to act.
  const fmtGenerateDate = fmtWD(workflowStatus?.generateDate);
  const fmtEditCloseDate = fmtWD(workflowStatus?.editCloseDate);
  const fmtLeaveCloseDate = fmtWD(workflowStatus?.leaveClosureDate);
  const fmtPublishDeadline = fmtWD(workflowStatus?.publishDeadline);
  let wfTimelineTitle = "";
  let wfTimelineDetail = "";
  let wfTimelineDone = false;
  if (stage === "none") {
    if (workflowStatus?.leaveIsClosed) {
      wfTimelineTitle = `Leave requests closed for ${wfPeriodStr}`;
      wfTimelineDetail = `The rota for this period auto-generates on ${fmtGenerateDate} (T-19).`;
    } else {
      wfTimelineTitle = `Next rota period: ${wfPeriodStr}`;
      wfTimelineDetail = `Leave requests for this period close ${fmtLeaveCloseDate} (T-21).`;
    }
  } else if (stage === "draft") {
    wfTimelineTitle = `Draft rota generated for ${wfPeriodStr}`;
    wfTimelineDetail = `Open for edits (by request to CNO) until ${fmtEditCloseDate} (T-17), when it's automatically submitted for CNO review.`;
  } else if (stage === "submitted") {
    wfTimelineTitle = totalUnits
      ? `${stageCounts?.submitted ?? 0} of ${totalUnits} unit(s) submitted for CNO review — ${wfPeriodStr}`
      : `Rota for ${wfPeriodStr} submitted for CNO review`;
    wfTimelineDetail = `CNO approval is due by ${fmtPublishDeadline} (T-14).${unitCountsBreakdown("submitted")}`;
  } else if (stage === "cno_approved") {
    wfTimelineTitle = totalUnits
      ? `${stageCounts?.cno_approved ?? 0} of ${totalUnits} unit(s) approved by CNO — ${wfPeriodStr}`
      : `Rota for ${wfPeriodStr} approved by CNO`;
    wfTimelineDetail = `Ready to publish — auto-publishes ${fmtPublishDeadline} (T-14) if not published sooner.${unitCountsBreakdown("cno_approved")}`;
    wfTimelineDone = true;
  } else if (stage === "published") {
    wfTimelineTitle = totalUnits
      ? `${stageCounts?.published ?? 0} of ${totalUnits} unit(s) published — ${wfPeriodStr}`
      : `Rota for ${wfPeriodStr} published`;
    wfTimelineDetail = `This period is confirmed and takes effect ${wfPeriodStr}.${unitCountsBreakdown("published")}`;
    wfTimelineDone = true;
  }
  const showWfTimeline = wfReady && !!wfTimelineTitle;

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
    !showWorkflowBanner &&
    !showWfTimeline
  )
    return null;

  return (
    <div className="space-y-3">
      {showWfTimeline && (
        <div
          className={`rounded-xl border-2 p-4 flex items-start gap-3 ${
            wfTimelineDone
              ? "border-emerald-400 bg-emerald-50 dark:bg-emerald-950/30"
              : "border-sky-400 bg-sky-50 dark:bg-sky-950/30"
          }`}
        >
          {wfTimelineDone ? (
            <CheckCircle2 className="h-5 w-5 shrink-0 mt-0.5 text-emerald-600" />
          ) : (
            <CalendarDays className="h-5 w-5 shrink-0 mt-0.5 text-sky-600" />
          )}
          <div className="flex-1 min-w-0">
            <p
              className={`font-bold ${
                wfTimelineDone
                  ? "text-emerald-800 dark:text-emerald-300"
                  : "text-sky-800 dark:text-sky-300"
              }`}
            >
              {wfTimelineTitle}
            </p>
            <p
              className={`text-sm mt-1 ${
                wfTimelineDone
                  ? "text-emerald-700 dark:text-emerald-400"
                  : "text-sky-700 dark:text-sky-400"
              }`}
            >
              {wfTimelineDetail}
            </p>
          </div>
        </div>
      )}
      {showWfGenerate && (
        <div className="rounded-xl border-2 border-blue-400 bg-blue-50 dark:bg-blue-950/30 p-4 flex items-start gap-3">
          <Clock className="h-5 w-5 shrink-0 mt-0.5 text-blue-600" />
          <div className="flex-1 min-w-0">
            <p className="font-bold text-blue-800 dark:text-blue-300">
              Rota not yet generated (admin override)
            </p>
            <p className="text-sm mt-1 text-blue-700 dark:text-blue-400">
              Leave window for {wfPeriodStr} is closed. The rota auto-generates on schedule (T-19) —
              use the Rota page only to trigger it early.
            </p>
          </div>
        </div>
      )}
      {showWfSubmit && (
        <div className="rounded-xl border-2 border-amber-400 bg-amber-50 dark:bg-amber-950/30 p-4 flex items-start gap-3">
          <Clock className="h-5 w-5 shrink-0 mt-0.5 text-amber-600" />
          <div className="flex-1 min-w-0">
            <p className="font-bold text-amber-800 dark:text-amber-300">
              Draft rota ready — submit for approval
            </p>
            <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
              The draft schedule for {wfPeriodStr} is ready. Go to the Rota page to review and
              submit it (it auto-submits at the T-17 deadline if you don't).
            </p>
          </div>
        </div>
      )}
      {showWfApproveRota && (
        <div className="rounded-xl border-2 border-amber-400 bg-amber-50 dark:bg-amber-950/30 p-4 flex items-start gap-3">
          <Clock className="h-5 w-5 shrink-0 text-amber-600 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="font-bold text-amber-800 dark:text-amber-300">
              {totalUnits
                ? `${stageCounts?.submitted ?? 0} of ${totalUnits} unit(s)`
                : "Draft rota"}{" "}
              awaiting CNO approval
            </p>
            <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
              Submitted for {wfPeriodStr}. Go to Approvals to review and approve.
              {unitCountsBreakdown("submitted")}
            </p>
          </div>
        </div>
      )}
      {showWfPublish && (
        <div className="rounded-xl border-2 border-amber-400 bg-amber-50 dark:bg-amber-950/30 p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="font-bold text-amber-800 dark:text-amber-300">
              {totalUnits ? `${stageCounts?.cno_approved ?? 0} of ${totalUnits} unit(s)` : "Rota"}{" "}
              approved — ready to publish
            </p>
            <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
              CNO-approved for {wfPeriodStr}. Go to Approvals to publish (or it auto-publishes at
              the T-14 deadline).
              {unitCountsBreakdown("cno_approved")}
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

// ── Chart color assignment ──────────────────────────────────────────────────
// Color is assigned by entity identity (leave type / facility name), never by
// rank, so a slice or line keeps the same color no matter what's filtered or
// toggled. Shared with the Reports Overview page — see @/lib/chart-colors.

function fmtDayLabel(day: string) {
  return new Date(day.slice(0, 10) + "T00:00:00").toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

const ALL_FACILITIES = "__ALL__";

// ── Ward safety snapshot (compact, single-column) ───────────────────────────
function WardSafetyCard({ wards }: { wards: WardRecord[] }) {
  return (
    <div className="bg-card border rounded-xl p-4 shadow-soft">
      <div className="flex items-center justify-between mb-2.5 gap-2">
        <div>
          <h2 className="text-sm font-semibold">Ward Safety Snapshot</h2>
          <p className="text-xs text-muted-foreground">Minimum-staffing rules per ward</p>
        </div>
        <Link
          to="/wards"
          className="text-xs text-primary inline-flex items-center gap-1 hover:underline shrink-0"
        >
          View all <ChevronRight className="h-3 w-3" />
        </Link>
      </div>
      {wards.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">
          No wards configured yet.{" "}
          <Link to="/wards" className="text-primary hover:underline">
            Add one →
          </Link>
        </p>
      ) : (
        <div className="space-y-2">
          {wards.slice(0, 4).map((w) => (
            <div key={w.id} className="text-xs pb-1.5 border-b last:border-b-0 last:pb-0">
              <p className="font-medium truncate">{w.name}</p>
              <p className="text-muted-foreground tabular-nums">
                AM: {w.min_morning_nurses}N+I · {w.min_morning_na}NA &nbsp;·&nbsp; PM:{" "}
                {w.min_night_nurses}N+I · {w.min_night_na}NA
              </p>
            </div>
          ))}
          {wards.length > 4 && (
            <p className="text-xs text-muted-foreground pt-1">
              +{wards.length - 4} more ward{wards.length - 4 > 1 ? "s" : ""} ·{" "}
              <Link to="/wards" className="text-primary hover:underline">
                view all
              </Link>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Leave by type (donut/bar toggle, facility-filterable) ──────────────────
function LeaveTypeTooltip({
  active,
  payload,
  total,
}: {
  active?: boolean;
  payload?: { payload: { type: string; count: number } }[];
  total: number;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const pct = Math.round((d.count / total) * 100);
  return (
    <div className="bg-popover border rounded-lg px-3 py-2 shadow-md text-xs">
      <p className="font-medium">{d.type}</p>
      <p className="text-muted-foreground">
        {d.count} request{d.count > 1 ? "s" : ""} · {pct}%
      </p>
    </div>
  );
}

function LeaveByTypeCard({ leave, nurses }: { leave: LeaveRequest[]; nurses: NurseRecord[] }) {
  const [facility, setFacility] = useState<string>(ALL_FACILITIES);
  const [view, setView] = useState<"donut" | "bar">("donut");

  const facilities = useMemo(
    () => [...new Set(nurses.map((n) => n.facility).filter((f): f is string => !!f))].sort(),
    [nurses],
  );
  const nurseNameToFacility = useMemo(
    () => new Map(nurses.map((n) => [n.name, n.facility])),
    [nurses],
  );

  const data = useMemo(() => {
    const scoped = leave.filter((l) => {
      if (l.status !== "Approved" || l.type === "Swap") return false;
      if (facility === ALL_FACILITIES) return true;
      return nurseNameToFacility.get(l.nurse_name) === facility;
    });
    const counts = new Map<string, number>();
    for (const l of scoped) counts.set(l.type, (counts.get(l.type) ?? 0) + 1);
    return [...counts.entries()]
      .map(([type, count]) => ({ type, count, color: colorForLeaveType(type) }))
      .sort((a, b) => LEAVE_TYPE_ORDER.indexOf(a.type) - LEAVE_TYPE_ORDER.indexOf(b.type));
  }, [leave, facility, nurseNameToFacility]);

  const total = data.reduce((sum, d) => sum + d.count, 0);

  return (
    <div className="bg-card border rounded-xl p-5 shadow-soft">
      <div className="flex items-center justify-between mb-4 gap-2">
        <div>
          <h2 className="font-semibold">Leave by Type</h2>
          <p className="text-xs text-muted-foreground">Approved leave, by type</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-md border overflow-hidden shrink-0">
            <button
              type="button"
              onClick={() => setView("donut")}
              title="Donut view"
              aria-label="Donut view"
              className={cn(
                "h-8 w-8 grid place-items-center transition-colors",
                view === "donut"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              <PieChartIcon className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setView("bar")}
              title="Bar view"
              aria-label="Bar view"
              className={cn(
                "h-8 w-8 grid place-items-center transition-colors border-l",
                view === "bar"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              <BarChart3 className="h-3.5 w-3.5" />
            </button>
          </div>
          <select
            value={facility}
            onChange={(e) => setFacility(e.target.value)}
            className="h-8 rounded-md border bg-background px-2 text-xs"
          >
            <option value={ALL_FACILITIES}>All Facilities</option>
            {facilities.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
      </div>

      {total === 0 ? (
        <div className="h-80 flex items-center justify-center">
          <p className="text-sm text-muted-foreground text-center">
            No approved leave in this scope yet.
          </p>
        </div>
      ) : view === "bar" ? (
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              layout="vertical"
              margin={{ top: 4, right: 16, left: 0, bottom: 4 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
              <XAxis
                type="number"
                allowDecimals={false}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                axisLine={{ stroke: "var(--border)" }}
                tickLine={false}
              />
              <YAxis
                type="category"
                dataKey="type"
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                axisLine={false}
                tickLine={false}
                width={118}
              />
              <Tooltip
                content={<LeaveTypeTooltip total={total} />}
                cursor={{ fill: "var(--muted)" }}
              />
              <Bar dataKey="count" radius={[0, 4, 4, 0]} barSize={16}>
                {data.map((d) => (
                  <Cell key={d.type} fill={d.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-4 sm:h-80 sm:justify-center">
          <div className="h-52 w-52 sm:h-64 sm:w-64 shrink-0 mx-auto sm:mx-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  dataKey="count"
                  nameKey="type"
                  innerRadius="60%"
                  outerRadius="90%"
                  paddingAngle={2}
                  stroke="var(--card)"
                  strokeWidth={2}
                >
                  {data.map((d) => (
                    <Cell key={d.type} fill={d.color} />
                  ))}
                </Pie>
                <Tooltip content={<LeaveTypeTooltip total={total} />} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="min-w-0 w-full sm:w-52 space-y-2.5 sm:max-h-64 sm:overflow-y-auto pr-1">
            {data.map((d) => (
              <div key={d.type} className="flex items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2 min-w-0">
                  <span
                    className="h-3 w-3 rounded-full shrink-0"
                    style={{ backgroundColor: d.color }}
                  />
                  <span className="truncate">{d.type}</span>
                </span>
                <span className="text-muted-foreground tabular-nums shrink-0">
                  {d.count} · {Math.round((d.count / total) * 100)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Daily hours worked per facility (multi-line, toggleable legend) ────────
// Rolling 7-day window anchored to CURRENT_DATE (server-side) — refetches
// periodically so the window slides forward as days pass without a reload.
type DailyFacilityHours = { day: string; facility: string; hours: string | number };
const DAILY_HOURS_WINDOW = 7;

function DailyHoursCard() {
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const { data: raw = [], isLoading } = useQuery({
    queryKey: ["daily-hours-by-facility"],
    queryFn: () =>
      api.get<DailyFacilityHours[]>(`/rpc/daily-hours-by-facility?days=${DAILY_HOURS_WINDOW}`),
    refetchInterval: 5 * 60 * 1000,
  });

  const facilities = useMemo(() => [...new Set(raw.map((r) => r.facility))].sort(), [raw]);
  const facilityColor = useMemo(() => {
    const m = new Map<string, string>();
    facilities.forEach((f, i) => m.set(f, CHART_SERIES_VARS[i % CHART_SERIES_VARS.length]));
    return m;
  }, [facilities]);

  const chartData = useMemo(() => {
    const byDay = new Map<string, Record<string, number | string>>();
    for (const r of raw) {
      const row = byDay.get(r.day) ?? { day: r.day };
      row[r.facility] = Number(r.hours);
      byDay.set(r.day, row);
    }
    return [...byDay.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
  }, [raw]);

  function toggle(facility: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(facility)) next.delete(facility);
      else next.add(facility);
      return next;
    });
  }

  return (
    <div className="bg-card border rounded-xl p-5 shadow-soft">
      <div className="flex items-center justify-between mb-4 gap-2">
        <div>
          <h2 className="font-semibold">Hours Worked, Daily</h2>
          <p className="text-xs text-muted-foreground">
            Last {DAILY_HOURS_WINDOW} days, by facility
          </p>
        </div>
        {facilities.length > 0 && (
          <div className="flex items-center gap-3 flex-wrap justify-end">
            {facilities.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => toggle(f)}
                className={cn(
                  "flex items-center gap-1.5 text-xs transition-opacity",
                  hidden.has(f) && "opacity-40",
                )}
              >
                <span
                  className="h-2.5 w-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: facilityColor.get(f) }}
                />
                {f}
              </button>
            ))}
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="h-80 flex items-center justify-center">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      ) : chartData.length === 0 ? (
        <div className="h-80 flex items-center justify-center">
          <p className="text-sm text-muted-foreground text-center">
            No shift hours logged in this window yet.
          </p>
        </div>
      ) : (
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="day"
                tickFormatter={fmtDayLabel}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                axisLine={{ stroke: "var(--border)" }}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                axisLine={false}
                tickLine={false}
                width={40}
              />
              <Tooltip
                labelFormatter={(v) => fmtDayLabel(String(v))}
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  return (
                    <div className="bg-popover border rounded-lg px-3 py-2 shadow-md text-xs space-y-1">
                      <p className="font-medium">{fmtDayLabel(String(label))}</p>
                      {payload
                        .filter((p) => !hidden.has(String(p.dataKey)))
                        .map((p) => (
                          <p key={String(p.dataKey)} className="flex items-center gap-1.5">
                            <span
                              className="h-2 w-2 rounded-full shrink-0"
                              style={{ backgroundColor: p.color }}
                            />
                            <span className="text-muted-foreground">{p.dataKey}:</span>
                            <span className="tabular-nums">{fmtHours(Number(p.value))}</span>
                          </p>
                        ))}
                    </div>
                  );
                }}
              />
              {facilities.map((f) => (
                <Line
                  key={f}
                  type="monotone"
                  dataKey={f}
                  stroke={facilityColor.get(f)}
                  strokeWidth={2}
                  dot={{ r: 3, strokeWidth: 0, fill: facilityColor.get(f) }}
                  activeDot={{ r: 5 }}
                  hide={hidden.has(f)}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
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
    queryFn: () => api.get<NurseRecord[]>("/nurses"),
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
    <div className="space-y-4">
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        <div className="lg:col-span-2 flex flex-col gap-4">
          <LeaveByTypeCard leave={visibleLeave} nurses={nurses} />
          <DailyHoursCard />
        </div>

        <div className="flex flex-col gap-4">
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

          <WardSafetyCard wards={visibleWards} />
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
  const { isStaffAccount } = useAuth();

  // Any login linked to a roster record (and not one of the always-management
  // roles) gets the personal nurse dashboard — role-agnostic, so a custom
  // role works correctly here without needing to be special-cased. ManagementAlerts
  // is rendered inside NurseDashboard so head_nurse and chief_matron still see
  // leave-blocking and regen alerts alongside their personal schedule.
  if (isStaffAccount) {
    return <NurseDashboard />;
  }

  return <ManagementDashboard />;
}
