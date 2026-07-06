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
        .get<Assignment[]>(`/shift-assignments?nurse_id=${nurseId}&shift_date=${today}&status=published&limit=1`)
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

  const { data: activeLog } = useQuery<ShiftLog | null>({
    queryKey: ["my-active-log", nurseId, today],
    enabled: !!nurseId,
    queryFn: () => api.get<ShiftLog | null>(`/shift-logs/current?nurse_id=${nurseId}&shift_date=${today}`),
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

  const periodHours = periodLogs.reduce((s, l) => s + (l.hours_logged ?? 0), 0);
  const totalMinutes = Math.round(periodHours * 60);
  const targetHours = nurseRecord?.target_hours ?? 185;
  const pct = Math.min(Math.round((periodHours / targetHours) * 100), 100);
  const completedShiftCount = periodLogs.filter((l) => l.hours_logged !== null).length;

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
              : nurseRecord?.ward?.split("|")[0] ?? "Not assigned"}
          </p>
        </div>
        <div className="bg-card border rounded-xl p-5 shadow-soft">
          <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
            28-day hours
          </p>
          <p className="mt-2 text-lg font-semibold">{fmtHours(periodHours)}</p>
          <p className="text-xs text-muted-foreground mt-1">{totalMinutes}m total</p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
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
          {todayAssignment ? (
            <div className="space-y-3">
              <span
                className={cn(
                  "inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold border",
                  shiftColor[todayAssignment.shift] ?? shiftColor.OFF,
                )}
              >
                {shiftLabel[todayAssignment.shift] ?? todayAssignment.shift}
              </span>
              {shiftTime[todayAssignment.shift] && (
                <p className="text-sm text-muted-foreground">
                  <Clock className="h-3.5 w-3.5 inline mr-1" />
                  {shiftTime[todayAssignment.shift]}
                </p>
              )}
              {todayAssignment.ward && (
                <p className="text-sm text-muted-foreground">
                  <MapPin className="h-3.5 w-3.5 inline mr-1" />
                  {todayAssignment.ward}
                </p>
              )}
              {isShiftActive && (
                <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700">
                  <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                  Active — {elapsedH}h {elapsedM}m elapsed ({elapsedTotalMinutes}m)
                </div>
              )}
              {!activeLog &&
                todayAssignment.status === "published" &&
                (todayAssignment.shift === "M" || todayAssignment.shift === "N") && (
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
          {upcomingAssignments.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No upcoming shifts found
            </p>
          ) : (
            <div className="space-y-2">
              {upcomingAssignments.map((a) => {
                const dt = new Date(a.shift_date.slice(0, 10) + "T00:00:00");
                return (
                  <div key={a.shift_date} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <span className="w-24 text-muted-foreground">
                        {dt.toLocaleDateString("en-GB", {
                          weekday: "short",
                          day: "numeric",
                          month: "short",
                        })}
                      </span>
                    </div>
                    <span
                      className={cn(
                        "text-xs px-2 py-0.5 rounded-full font-semibold border",
                        shiftColor[a.shift] ?? shiftColor.OFF,
                      )}
                    >
                      {shiftLabel[a.shift] ?? a.shift}
                    </span>
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
    </div>
  );
}

// ── Management dashboard ──────────────────────────────────────────────────────

function ManagementDashboard() {
  const { fullName, isAdmin, nurseFacility, canApproveLeave, activeRole } = useAuth();

  const facilityFilter = !isAdmin && nurseFacility ? nurseFacility : null;

  const { data: allNurses = [] } = useQuery({
    queryKey: ["nurses"],
    queryFn: () => api.get<Record<string, unknown>[]>("/nurses"),
  });
  const { data: wards = [] } = useQuery({
    queryKey: ["wards"],
    queryFn: () => api.get<Record<string, unknown>[]>("/wards"),
  });
  const { data: leave = [] } = useQuery({
    queryKey: ["leave"],
    queryFn: () => api.get<LeaveRequest[]>("/leave-requests"),
  });

  const nurses = facilityFilter
    ? allNurses.filter((n) => n.facility === facilityFilter)
    : allNurses;
  const facilityNurseNames = new Set(nurses.map((n) => n.name));
  const visibleLeave =
    facilityFilter && !canApproveLeave
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

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <Stat
          icon={Users}
          label="Staff"
          value={nurses.length}
          hint={facilityFilter ?? "All facilities"}
        />
        <Stat icon={Building2} label="Wards" value={wards.length} hint="Configured wards" />
        <Stat
          icon={PlaneTakeoff}
          label="Pending Leave"
          value={pendingLeave.length}
          tone={pendingLeave.length ? "warn" : "default"}
        />
        <Stat
          icon={CheckCircle2}
          label="Approved Leave"
          value={leave.filter((l) => l.status === "Approved").length}
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
          {wards.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No wards configured yet.{" "}
              <Link to="/wards" className="text-primary hover:underline">
                Add one →
              </Link>
            </p>
          ) : (
            <div className="space-y-2">
              {wards.slice(0, 8).map((w) => (
                <div key={w.id} className="flex items-center justify-between gap-3 text-sm py-1">
                  <span className="truncate font-medium w-32 sm:w-40">{w.name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                    AM: {w.min_morning_supervisor}S · {w.min_morning_nurses}N+I · {w.min_morning_na}
                    NA &nbsp;·&nbsp; PM: {w.min_night_supervisor}S · {w.min_night_nurses}N+I ·{" "}
                    {w.min_night_na}NA
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

  // Nurses, Chief Matrons and Head Nurses work shifts — give them the personal view.
  // Only CNO, HR/Admin and System Admin get the ops management view.
  if (activeRole && ["nurse", "chief_matron", "head_nurse"].includes(activeRole) && nurseId) {
    return <NurseDashboard />;
  }

  return <ManagementDashboard />;
}
