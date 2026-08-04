import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useState, useMemo, useEffect } from "react";
import {
  Download,
  FileSpreadsheet,
  FileDown,
  BarChart3,
  Clock,
  Users,
  Archive,
  PlaneTakeoff,
  CheckCircle2,
  XCircle,
  CalendarDays,
  Printer,
  List,
  Building2,
  CalendarRange,
  Stethoscope,
  ArrowLeftRight,
  ChevronRight,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { xlsWorkbook, xlsAddJsonSheet, xlsAddAoaSheet, xlsDownload } from "@/lib/excel-export";
import { useAuth } from "@/lib/auth-context";
import { isGlobalHead, isMatron, isPorterType, isInternType, isNADayType } from "@/lib/auto-schedule";
import { Pagination, usePagination } from "@/components/Pagination";
import { FacilityChips } from "@/components/FacilityChips";
import { CategoryChartCard, type CategoryDatum } from "@/components/CategoryChartCard";
import { colorForLeaveType, colorForKey } from "@/lib/chart-colors";
import { DateRangeFilter, type DateRangeFilterValue } from "@/components/DateRangeFilter";

type ReportsTab =
  | "overview"
  | "hours"
  | "locum"
  | "locum-requests"
  | "periods"
  | "leave"
  | "missed"
  | "staff-dir"
  | "schedules";

const REPORTS_TABS: readonly ReportsTab[] = [
  "overview",
  "hours",
  "locum",
  "locum-requests",
  "periods",
  "leave",
  "missed",
  "staff-dir",
  "schedules",
];

export const Route = createFileRoute("/_app/reports")({
  validateSearch: (search: Record<string, unknown>) => ({
    tab: REPORTS_TABS.includes(search.tab as ReportsTab) ? (search.tab as ReportsTab) : undefined,
  }),
  component: ReportsPage,
});

const FACILITIES = ["Ikeja", "Ikoyi", "Ligali"] as const;

// Display decimal hours as plain English — e.g. 0.2333 → "0 hours 14 minutes", 1.5 → "1 hour 30 minutes".
function fmtHoursLog(decHours: number): string {
  const h = Math.floor(decHours);
  const m = Math.round((decHours - h) * 60);
  const hStr = `${h} ${h === 1 ? "hour" : "hours"}`;
  if (m === 0) return hStr;
  const mStr = `${m} ${m === 1 ? "minute" : "minutes"}`;
  return `${hStr} ${mStr}`;
}

type Nurse = {
  id: string;
  name: string;
  role: string;
  ward: string | null;
  facility: string | null;
  hours_this_month: number;
  target_hours: number;
};
type ShiftLog = {
  nurse_id: string;
  shift_date: string;
  shift_type: string;
  started_at: string;
  ended_at: string | null;
  hours_logged: number | null;
  period_start: string;
  is_late: boolean | null;
  late_minutes: number | null;
  late_reason: string | null;
  is_locum: boolean;
  is_swap: boolean;
  swap_note: string | null;
  is_leave: boolean;
  is_missed: boolean;
};
type LocumFilledRequest = {
  id: string;
  shift_date: string;
  shift: string;
  facility: string;
  ward: string;
  accepted_by_nurse_id: string | null;
  accepted_by_nurse_name: string | null;
  accepted_at: string | null;
};
type LocumRequestStatus =
  | "pending"
  | "approved"
  | "declined"
  | "invites_sent"
  | "filled"
  | "expired";
type LocumRequestFull = {
  id: string;
  shift_date: string;
  shift: string;
  facility: string;
  ward: string;
  nurses_needed: number;
  role_needed: string | null;
  status: LocumRequestStatus;
  requested_by_name: string;
  reviewed_by_name: string | null;
  decline_reason: string | null;
  accepted_by_nurse_name: string | null;
  accepted_at: string | null;
  created_at: string;
};
type PeriodHours = {
  nurse_id: string;
  period_start: string;
  period_end: string;
  total_hours: number;
  total_shifts: number;
};
type LeaveRequest = {
  id: string;
  nurse_id: string | null;
  from_date: string;
  to_date: string;
  status: "Pending" | "Approved" | "Rejected";
  type: "Sick" | "Annual" | "Emergency" | "Public Holiday" | "Swap" | "Study Leave" | "Compassionate Leave" | "Leave of Absence";
  reason: string | null;
  created_at: string;
  rota_stage_at_request: "no_rota" | "draft" | "published" | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
};
type ArchiveAssignment = {
  nurse_id: string;
  shift_date: string;
  ward: string | null;
  shift: string;
  // Role captured when the row was first generated — null on rows written
  // before this column existed. Always prefer this over a live nurse-role
  // lookup for archive/history display, so a later role change doesn't
  // rewrite what was actually published at the time.
  nurse_role: string | null;
};
type FacilityWideGroup = "matron" | "head" | "porter" | "intern" | "naday";
const FW_LABELS: Record<FacilityWideGroup, string> = {
  matron: "Matron",
  head: "Coverage Nurse",
  porter: "Porter",
  intern: "Nurse Intern",
  naday: "Nursing Assistant - Day",
};

function roleGroupOf(role: string): FacilityWideGroup | null {
  if (isMatron(role)) return "matron";
  if (isGlobalHead(role)) return "head";
  if (isPorterType(role)) return "porter";
  if (isInternType(role)) return "intern";
  if (isNADayType(role)) return "naday";
  return null;
}

type ArchiveWindow = {
  startDate: string;
  endDate: string;
  ward: string | null;
  facility: string | null;
  nurseCount: number;
  assignmentCount: number;
  roleGroup: FacilityWideGroup | null;
};

// ── Date helpers ─────────────────────────────────────────────────────────────

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function todayYmd() {
  return ymd(new Date());
}

// Same 28-day lookback used for "current period" shift-log queries.
function periodLookbackYmd() {
  const d = new Date();
  d.setDate(d.getDate() - 27);
  return ymd(d);
}

// Shift switch requests are stored as leave_requests with type="Swap" and a reason
// field starting with this sentinel — mirrors parseSwitch in leave.tsx.
const SWITCH_PREFIX = "SHIFT_SWITCH|";
function parseSwitchReason(reason: string | null): {
  nurseBName: string;
  shiftA: string;
  shiftB: string;
  interWard: boolean;
  note: string;
} | null {
  if (!reason?.startsWith(SWITCH_PREFIX)) return null;
  const parts = reason.slice(SWITCH_PREFIX.length).split("|");
  const nurseBName = parts[1] ?? "";
  const shiftA = parts[2] ?? "";
  const shiftB = parts[3] ?? "";
  let interWard = false;
  let note = "";
  for (let i = 4; i < parts.length; i++) {
    if (parts[i] === "INTER_WARD") interWard = true;
    else if (parts[i].startsWith("NOTE:")) note = parts.slice(i).join("|").slice(5);
  }
  return { nurseBName, shiftA, shiftB, interWard, note };
}

function fmtDate(d: string) {
  return new Date(d.slice(0, 10) + "T00:00:00").toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  const cur = new Date(start.slice(0, 10) + "T00:00:00");
  const endDt = new Date(end.slice(0, 10) + "T00:00:00");
  while (cur <= endDt) {
    out.push(
      `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`,
    );
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function scheduleEndDate(startDate: string): string {
  const d = new Date(startDate.slice(0, 10) + "T00:00:00");
  d.setDate(d.getDate() + 27);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── Archive grouping (mirrors approvals.tsx groupIntoWindows) ────────────────

function groupArchiveWindows(
  rows: ArchiveAssignment[],
  nurseToFacility: Map<string, string | null>,
  nurseToRole: Map<string, string>,
): ArchiveWindow[] {
  if (!rows.length) return [];
  const byKey = new Map<string, ArchiveAssignment[]>();
  const keyMeta = new Map<string, { ward: string | null; facility: string | null; roleGroup: FacilityWideGroup | null }>();

  for (const row of rows) {
    const fac = nurseToFacility.get(row.nurse_id) ?? null;
    let key: string;
    let ward: string | null;
    let roleGroup: FacilityWideGroup | null = null;

    if (row.ward !== null) {
      ward = row.ward;
      key = `${fac ?? "__NONE__"}|ward|${row.ward}`;
    } else {
      ward = null;
      const role = row.nurse_role ?? nurseToRole.get(row.nurse_id) ?? "";
      roleGroup = roleGroupOf(role);
      key = `${fac ?? "__NONE__"}|fw|${roleGroup ?? "other"}`;
    }

    if (!byKey.has(key)) {
      byKey.set(key, []);
      keyMeta.set(key, { ward, facility: fac, roleGroup });
    }
    byKey.get(key)!.push(row);
  }

  const windows: ArchiveWindow[] = [];
  for (const [key, keyRows] of byKey) {
    const { ward, facility, roleGroup } = keyMeta.get(key)!;
    const sorted = [...keyRows].sort((a, b) => a.shift_date.localeCompare(b.shift_date));
    let cluster: ArchiveAssignment[] = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const prev = cluster[cluster.length - 1];
      const diff = Math.round(
        (new Date(sorted[i].shift_date).getTime() - new Date(prev.shift_date).getTime()) / 86400000,
      );
      const spanDays = Math.round(
        (new Date(sorted[i].shift_date).getTime() - new Date(cluster[0].shift_date).getTime()) / 86400000,
      );
      if (diff > 14 || spanDays >= 28) {
        windows.push(makeArchiveWindow(cluster, ward, facility, roleGroup));
        cluster = [];
      }
      cluster.push(sorted[i]);
    }
    if (cluster.length) windows.push(makeArchiveWindow(cluster, ward, facility, roleGroup));
  }
  return windows.sort(
    (a, b) =>
      b.startDate.localeCompare(a.startDate) ||
      (a.facility ?? "").localeCompare(b.facility ?? "") ||
      (a.ward ?? a.roleGroup ?? "").localeCompare(b.ward ?? b.roleGroup ?? ""),
  );
}

function makeArchiveWindow(
  rows: ArchiveAssignment[],
  ward: string | null,
  facility: string | null,
  roleGroup: FacilityWideGroup | null,
): ArchiveWindow {
  const dates = rows.map((r) => r.shift_date).sort();
  return {
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    ward,
    facility,
    nurseCount: new Set(rows.map((r) => r.nurse_id)).size,
    assignmentCount: rows.length,
    roleGroup,
  };
}

// ── PDF generation helpers (shared between staff and schedule) ───────────────

function openPrintWindow(html: string) {
  const pw = window.open("", "_blank");
  if (!pw) {
    toast.error("Pop-up blocked — allow pop-ups to print");
    return;
  }
  pw.document.write(html);
  pw.document.close();
}

function ReportsPage() {
  const { canViewReports } = useAuth();
  if (!canViewReports) {
    return (
      <div className="py-20 text-center text-sm text-muted-foreground">
        You do not have permission to view reports.
      </div>
    );
  }
  return <ReportsContent />;
}

function ReportsContent() {
  const qc = useQueryClient();
  const { canPrintStaff, canPrintSchedule, nurseFacility, isAdmin, activeRole } = useAuth();

  // Admin, CNO and HR/Admin see all facilities; other roles are locked to their own.
  const canFilterReportFacility = isAdmin || activeRole === "cno" || activeRole === "hr_admin";
  const lockedReportFacility: string | null = canFilterReportFacility ? null : (nurseFacility ?? null);
  const [selectedReportFacility, setSelectedReportFacility] = useState("");
  const reportFacility: string | null = lockedReportFacility ?? (selectedReportFacility || null);

  const { tab: tabParam } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [tab, setTabState] = useState<ReportsTab>(tabParam ?? "overview");
  function setTab(next: ReportsTab) {
    setTabState(next);
    navigate({ search: (prev) => ({ ...prev, tab: next }), replace: true });
  }
  const [closingPeriod, setClosingPeriod] = useState(false);
  // Pagination state per heavy table tab
  const [hoursPage, setHoursPage] = useState(1);
  const [hoursPageSize, setHoursPageSize] = useState(20);
  const [locumPage, setLocumPage] = useState(1);
  const [locumPageSize, setLocumPageSize] = useState(20);
  const [locumReqPage, setLocumReqPage] = useState(1);
  const [locumReqPageSize, setLocumReqPageSize] = useState(20);
  const [leavePage, setLeavePage] = useState(1);
  const [leavePageSize, setLeavePageSize] = useState(20);
  const [leaveSubTab, setLeaveSubTab] = useState<"leave" | "switches">("leave");
  const [switchPage, setSwitchPage] = useState(1);
  const [switchPageSize, setSwitchPageSize] = useState(20);
  const [missedPage, setMissedPage] = useState(1);
  const [missedPageSize, setMissedPageSize] = useState(20);
  // Date range filters per tab (Today / Yesterday / Last Week / custom range)
  const [hoursRange, setHoursRange] = useState<DateRangeFilterValue>({ from: "", to: "" });
  const [hoursStatusFilter, setHoursStatusFilter] = useState<"all" | "running" | "ended">("all");
  const [hoursShiftTypeFilter, setHoursShiftTypeFilter] = useState<"all" | "M" | "N">("all");
  const [hoursCategoryFilter, setHoursCategoryFilter] = useState<
    "all" | "regular" | "swap" | "leave"
  >("all");
  const [locumRange, setLocumRange] = useState<DateRangeFilterValue>({ from: "", to: "" });
  const [locumReqRange, setLocumReqRange] = useState<DateRangeFilterValue>({ from: "", to: "" });
  const [locumReqStatusFilter, setLocumReqStatusFilter] = useState<"all" | LocumRequestStatus>(
    "all",
  );
  const [locumReqShiftFilter, setLocumReqShiftFilter] = useState<"all" | "M" | "N">("all");
  const [leaveRange, setLeaveRange] = useState<DateRangeFilterValue>({ from: "", to: "" });
  const [missedRange, setMissedRange] = useState<DateRangeFilterValue>({ from: "", to: "" });
  const [periodsRange, setPeriodsRange] = useState<DateRangeFilterValue>({ from: "", to: "" });
  const [dirFacility, setDirFacility] = useState<string>(reportFacility ?? FACILITIES[0]);
  const [archiveFacility, setArchiveFacility] = useState<string>(reportFacility ?? "");
  const [archiveDownloading, setArchiveDownloading] = useState<string | null>(null);

  const { data: nurses = [] } = useQuery<Nurse[]>({
    queryKey: ["nurses"],
    queryFn: () => api.get<Nurse[]>("/nurses"),
  });
  const { data: wards = [] } = useQuery({
    queryKey: ["wards"],
    queryFn: () => api.get<{ id: string; name: string; facility: string | null }[]>("/wards"),
  });
  const { data: leave = [] } = useQuery({
    queryKey: ["leave"],
    queryFn: () => api.get<LeaveRequest[]>("/leave-requests"),
  });

  // Current period regular shift logs (last 28 days) — locum and missed excluded
  const { data: shiftLogs = [] } = useQuery<ShiftLog[]>({
    queryKey: ["shift-logs-current"],
    queryFn: () => {
      const lookback = new Date();
      lookback.setDate(lookback.getDate() - 27);
      const lb = `${lookback.getFullYear()}-${String(lookback.getMonth() + 1).padStart(2, "0")}-${String(lookback.getDate()).padStart(2, "0")}`;
      return api.get<ShiftLog[]>(`/shift-logs?is_locum=false&is_missed=false&from=${lb}`);
    },
  });

  // Missed shift logs — all time, facility-scoped (also needed for the Overview chart)
  const { data: missedShiftLogs = [] } = useQuery<ShiftLog[]>({
    queryKey: ["missed-shift-logs", reportFacility],
    enabled: tab === "missed" || tab === "overview",
    queryFn: () => api.get<ShiftLog[]>("/shift-logs?is_missed=true"),
  });

  // Locum shift logs — separate from regular hours
  const { data: locumShiftLogs = [] } = useQuery<ShiftLog[]>({
    queryKey: ["locum-shift-logs-report"],
    queryFn: () => api.get<ShiftLog[]>("/shift-logs?is_locum=true"),
  });

  // Filled locum requests — provides ward / facility context for each locum log
  const { data: locumFilledRequests = [] } = useQuery<LocumFilledRequest[]>({
    queryKey: ["locum-filled-report"],
    queryFn: () => api.get<LocumFilledRequest[]>("/locum/requests?status=filled"),
  });

  // All locum requests regardless of status — for the Locum Requests report tab
  const { data: locumRequestsAll = [] } = useQuery<LocumRequestFull[]>({
    queryKey: ["locum-requests-all-report"],
    enabled: tab === "locum-requests",
    queryFn: () => api.get<LocumRequestFull[]>("/locum/requests"),
  });

  // All saved period summaries
  const { data: periodSummaries = [] } = useQuery<PeriodHours[]>({
    queryKey: ["period-hours-all"],
    staleTime: 30 * 60 * 1000,
    queryFn: () => api.get<PeriodHours[]>("/nurse-period-hours"),
  });

  // Published schedule assignments (for archive tab)
  const { data: archiveAssignments = [], isLoading: archiveLoading } = useQuery<
    ArchiveAssignment[]
  >({
    queryKey: ["archive-assignments"],
    staleTime: 30 * 60 * 1000,
    queryFn: () => {
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      const cutoff = `${sixMonthsAgo.getFullYear()}-${String(sixMonthsAgo.getMonth() + 1).padStart(2, "0")}-${String(sixMonthsAgo.getDate()).padStart(2, "0")}`;
      return api.get<ArchiveAssignment[]>(
        `/shift-assignments?status=published&from=${cutoff}`,
      );
    },
    enabled: tab === "schedules",
  });

  // Nurses and requests scoped to reportFacility (null = all facilities visible).
  const scopedNurses = useMemo(
    () => (reportFacility ? nurses.filter((n) => n.facility === reportFacility) : nurses),
    [nurses, reportFacility],
  );
  const scopedNurseIds = useMemo(() => new Set(scopedNurses.map((n) => n.id)), [scopedNurses]);
  const scopedLocumRequests = useMemo(
    () =>
      reportFacility
        ? locumFilledRequests.filter((r) => r.facility === reportFacility)
        : locumFilledRequests,
    [locumFilledRequests, reportFacility],
  );
  const scopedLocumRequestsAll = useMemo(
    () =>
      reportFacility
        ? locumRequestsAll.filter((r) => r.facility === reportFacility)
        : locumRequestsAll,
    [locumRequestsAll, reportFacility],
  );
  // Leave requests scoped to the same facility set — CNO/admin see all, others see their own.
  const scopedLeave = useMemo(
    () =>
      reportFacility
        ? leave.filter((l) => l.nurse_id && scopedNurseIds.has(l.nurse_id))
        : leave,
    [leave, scopedNurseIds, reportFacility],
  );
  const reportLeaveOnly = useMemo(
    () => scopedLeave.filter((l) => l.type !== "Swap"),
    [scopedLeave],
  );
  const scopedShiftLogs = useMemo(
    () => shiftLogs.filter((l) => scopedNurseIds.has(l.nurse_id)),
    [shiftLogs, scopedNurseIds],
  );
  const scopedPeriodSummaries = useMemo(
    () => periodSummaries.filter((p) => scopedNurseIds.has(p.nurse_id)),
    [periodSummaries, scopedNurseIds],
  );

  const scopedMissedLogs = useMemo(
    () => missedShiftLogs.filter((l) => scopedNurseIds.has(l.nurse_id)),
    [missedShiftLogs, scopedNurseIds],
  );

  // Date-filtered views for the heavy-table tabs
  const filteredShiftLogs = useMemo(() => {
    let data = scopedShiftLogs;
    if (hoursRange.from) data = data.filter((l) => l.shift_date >= hoursRange.from);
    if (hoursRange.to) data = data.filter((l) => l.shift_date <= hoursRange.to);
    if (hoursStatusFilter === "running") data = data.filter((l) => !l.ended_at);
    if (hoursStatusFilter === "ended") data = data.filter((l) => !!l.ended_at);
    if (hoursShiftTypeFilter !== "all") {
      data = data.filter((l) => l.shift_type === hoursShiftTypeFilter);
    }
    if (hoursCategoryFilter === "swap") data = data.filter((l) => l.is_swap);
    else if (hoursCategoryFilter === "leave") data = data.filter((l) => l.is_leave);
    else if (hoursCategoryFilter === "regular") {
      data = data.filter((l) => !l.is_swap && !l.is_leave);
    }
    return data;
  }, [
    scopedShiftLogs,
    hoursRange,
    hoursStatusFilter,
    hoursShiftTypeFilter,
    hoursCategoryFilter,
  ]);

  const filteredLocumRequests = useMemo(() => {
    let data = scopedLocumRequests;
    if (locumRange.from) data = data.filter((r) => r.shift_date.slice(0, 10) >= locumRange.from);
    if (locumRange.to) data = data.filter((r) => r.shift_date.slice(0, 10) <= locumRange.to);
    return data;
  }, [scopedLocumRequests, locumRange]);

  const filteredLocumRequestsAll = useMemo(() => {
    let data = scopedLocumRequestsAll;
    if (locumReqRange.from)
      data = data.filter((r) => r.shift_date.slice(0, 10) >= locumReqRange.from);
    if (locumReqRange.to) data = data.filter((r) => r.shift_date.slice(0, 10) <= locumReqRange.to);
    if (locumReqStatusFilter !== "all") data = data.filter((r) => r.status === locumReqStatusFilter);
    if (locumReqShiftFilter !== "all") data = data.filter((r) => r.shift === locumReqShiftFilter);
    return data;
  }, [scopedLocumRequestsAll, locumReqRange, locumReqStatusFilter, locumReqShiftFilter]);

  const filteredScopeLeave = useMemo(() => {
    let data = scopedLeave;
    if (leaveRange.from) data = data.filter((l) => l.to_date >= leaveRange.from);
    if (leaveRange.to) data = data.filter((l) => l.from_date <= leaveRange.to);
    return data;
  }, [scopedLeave, leaveRange]);

  const filteredLeaveOnly = useMemo(
    () => filteredScopeLeave.filter((l) => l.type !== "Swap"),
    [filteredScopeLeave],
  );

  const filteredSwitches = useMemo(
    () => filteredScopeLeave.filter((l) => l.type === "Swap"),
    [filteredScopeLeave],
  );

  const filteredMissedLogs = useMemo(() => {
    let data = scopedMissedLogs;
    if (missedRange.from) data = data.filter((l) => l.shift_date >= missedRange.from);
    if (missedRange.to) data = data.filter((l) => l.shift_date <= missedRange.to);
    return data;
  }, [scopedMissedLogs, missedRange]);

  // Period summaries overlapping the selected range (a period counts if any part
  // of it falls within [from, to], same overlap semantics as the leave filter above).
  const filteredPeriodSummaries = useMemo(() => {
    let data = scopedPeriodSummaries;
    if (periodsRange.from) data = data.filter((p) => p.period_end >= periodsRange.from);
    if (periodsRange.to) data = data.filter((p) => p.period_start <= periodsRange.to);
    return data;
  }, [scopedPeriodSummaries, periodsRange]);

  // Reset all paginated tables to page 1 when the facility filter or date filters change
  useEffect(() => {
    setHoursPage(1);
    setLocumPage(1);
    setLocumReqPage(1);
    setLeavePage(1);
    setSwitchPage(1);
    setMissedPage(1);
  }, [
    reportFacility,
    hoursRange,
    locumRange,
    locumReqRange,
    locumReqStatusFilter,
    locumReqShiftFilter,
    leaveRange,
    missedRange,
  ]);

  // Paginate the four heavy tables (hooks must be unconditional)
  const { pageItems: pagedShiftLogs, totalPages: hoursTotalPages } = usePagination(
    filteredShiftLogs,
    hoursPageSize,
    hoursPage,
  );
  const { pageItems: pagedLocumRequests, totalPages: locumTotalPages } = usePagination(
    filteredLocumRequests,
    locumPageSize,
    locumPage,
  );
  const { pageItems: pagedLocumRequestsAll, totalPages: locumReqTotalPages } = usePagination(
    filteredLocumRequestsAll,
    locumReqPageSize,
    locumReqPage,
  );
  const { pageItems: pagedLeaveOnly, totalPages: leaveTotalPages } = usePagination(
    filteredLeaveOnly,
    leavePageSize,
    leavePage,
  );
  const { pageItems: pagedSwitches, totalPages: switchTotalPages } = usePagination(
    filteredSwitches,
    switchPageSize,
    switchPage,
  );
  const { pageItems: pagedMissedLogs, totalPages: missedTotalPages } = usePagination(
    filteredMissedLogs,
    missedPageSize,
    missedPage,
  );

  // Build per-nurse hours for current period (locum and swap-coverage excluded from regular total).
  // swapHoursMap tracks additional shift hours separately for breakdown display.
  const { nurseHoursMap, nurseShiftCountMap, swapHoursMap, leaveHoursMap } = useMemo(() => {
    const hours = new Map<string, number>();
    const shifts = new Map<string, number>();
    const swap = new Map<string, number>();
    const leave = new Map<string, number>();
    for (const log of shiftLogs.filter((l) => scopedNurseIds.has(l.nurse_id))) {
      if (log.hours_logged != null) {
        if (log.is_swap) {
          swap.set(log.nurse_id, (swap.get(log.nurse_id) ?? 0) + Number(log.hours_logged));
        } else {
          hours.set(log.nurse_id, (hours.get(log.nurse_id) ?? 0) + Number(log.hours_logged));
          shifts.set(log.nurse_id, (shifts.get(log.nurse_id) ?? 0) + 1);
        }
        if (log.is_leave)
          leave.set(log.nurse_id, (leave.get(log.nurse_id) ?? 0) + Number(log.hours_logged));
      }
    }
    return {
      nurseHoursMap: hours,
      nurseShiftCountMap: shifts,
      swapHoursMap: swap,
      leaveHoursMap: leave,
    };
  }, [shiftLogs, scopedNurseIds]);

  const totalLoggedHours = useMemo(
    () => [...nurseHoursMap.values()].reduce((s, h) => s + h, 0),
    [nurseHoursMap],
  );
  const activeNurses = useMemo(
    () => scopedNurses.filter((n) => nurseHoursMap.has(n.id)),
    [scopedNurses, nurseHoursMap],
  );

  // Locum derived data
  const locumLogMap = useMemo(() => {
    const m = new Map<string, ShiftLog>();
    for (const log of locumShiftLogs) m.set(`${log.nurse_id}|${log.shift_date.slice(0, 10)}`, log);
    return m;
  }, [locumShiftLogs]);

  // Filtered locum stats (driven by filteredLocumRequests so stats match the date filter)
  const filteredLocumHoursMap = useMemo(() => {
    const hours = new Map<string, number>();
    for (const r of filteredLocumRequests) {
      if (!r.accepted_by_nurse_id) continue;
      const log = locumLogMap.get(`${r.accepted_by_nurse_id}|${r.shift_date.slice(0, 10)}`);
      if (log?.hours_logged != null)
        hours.set(
          r.accepted_by_nurse_id,
          (hours.get(r.accepted_by_nurse_id) ?? 0) + Number(log.hours_logged),
        );
    }
    return hours;
  }, [filteredLocumRequests, locumLogMap]);

  const filteredLocumShiftCountMap = useMemo(() => {
    const shifts = new Map<string, number>();
    for (const r of filteredLocumRequests) {
      if (r.accepted_by_nurse_id)
        shifts.set(r.accepted_by_nurse_id, (shifts.get(r.accepted_by_nurse_id) ?? 0) + 1);
    }
    return shifts;
  }, [filteredLocumRequests]);

  const filteredLocumTotalHours = useMemo(
    () => [...filteredLocumHoursMap.values()].reduce((s, h) => s + h, 0),
    [filteredLocumHoursMap],
  );

  const { locumHoursMap, locumShiftCountMap } = useMemo(() => {
    const hours = new Map<string, number>();
    const shifts = new Map<string, number>();
    for (const log of locumShiftLogs.filter((l) => scopedNurseIds.has(l.nurse_id))) {
      if (log.hours_logged != null) {
        hours.set(log.nurse_id, (hours.get(log.nurse_id) ?? 0) + Number(log.hours_logged));
      }
      shifts.set(log.nurse_id, (shifts.get(log.nurse_id) ?? 0) + 1);
    }
    return { locumHoursMap: hours, locumShiftCountMap: shifts };
  }, [locumShiftLogs, scopedNurseIds]);

  const totalLocumHours = useMemo(
    () => [...locumHoursMap.values()].reduce((s, h) => s + h, 0),
    [locumHoursMap],
  );

  // ── Overview charts ──────────────────────────────────────────────────────
  // Hours by category (current period, non-overlapping): worked hours already
  // include leave-credited hours (see nurseHoursMap above), so leave is
  // subtracted back out to keep the four slices additive.
  const hoursByCategoryData: CategoryDatum[] = useMemo(() => {
    const leaveTotal = [...leaveHoursMap.values()].reduce((s, h) => s + h, 0);
    const regularTotal = Math.max(totalLoggedHours - leaveTotal, 0);
    const swapTotal = [...swapHoursMap.values()].reduce((s, h) => s + h, 0);
    const lookback = periodLookbackYmd();
    const locumPeriodTotal = locumShiftLogs
      .filter((l) => scopedNurseIds.has(l.nurse_id) && l.shift_date.slice(0, 10) >= lookback)
      .reduce((s, l) => s + (l.hours_logged != null ? Number(l.hours_logged) : 0), 0);
    const order = ["Regular", "Locum", "Additional (Swap)", "Leave Credited"];
    return [
      { key: "Regular", label: "Regular", value: regularTotal },
      { key: "Locum", label: "Locum", value: locumPeriodTotal },
      { key: "Additional (Swap)", label: "Additional (Swap)", value: swapTotal },
      { key: "Leave Credited", label: "Leave Credited", value: leaveTotal },
    ]
      .filter((d) => d.value > 0)
      .map((d) => ({ ...d, color: colorForKey(d.key, order) }));
  }, [totalLoggedHours, leaveHoursMap, swapHoursMap, locumShiftLogs, scopedNurseIds]);

  // Missed shifts by type (current period), Roster vs Locum
  const missedByTypeData: CategoryDatum[] = useMemo(() => {
    const lookback = periodLookbackYmd();
    let roster = 0;
    let locum = 0;
    for (const l of scopedMissedLogs) {
      if (l.shift_date.slice(0, 10) < lookback) continue;
      if (l.is_locum) locum++;
      else roster++;
    }
    const order = ["Roster", "Locum"];
    return [
      { key: "Roster", label: "Roster", value: roster },
      { key: "Locum", label: "Locum", value: locum },
    ]
      .filter((d) => d.value > 0)
      .map((d) => ({ ...d, color: colorForKey(d.key, order) }));
  }, [scopedMissedLogs]);

  // Approved leave by type, all time within current facility scope
  const leaveByTypeData: CategoryDatum[] = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of reportLeaveOnly) {
      if (l.status !== "Approved") continue;
      counts.set(l.type, (counts.get(l.type) ?? 0) + 1);
    }
    return [...counts.entries()].map(([type, count]) => ({
      key: type,
      label: type,
      value: count,
      color: colorForLeaveType(type),
    }));
  }, [reportLeaveOnly]);

  // Staff distribution — by facility when viewing all facilities, else by ward
  const staffByGroupData: CategoryDatum[] = useMemo(() => {
    if (!reportFacility) {
      const counts = new Map<string, number>();
      for (const n of scopedNurses) {
        const f = n.facility ?? "Unassigned";
        counts.set(f, (counts.get(f) ?? 0) + 1);
      }
      const order = [...FACILITIES, "Unassigned"];
      return [...counts.entries()]
        .map(([facility, count]) => ({
          key: facility,
          label: facility,
          value: count,
          color: colorForKey(facility, order),
        }))
        .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    }
    const counts = new Map<string, number>();
    for (const n of scopedNurses) {
      const wardNames = n.ward
        ? n.ward
            .split("|")
            .map((w) => w.trim())
            .filter(Boolean)
        : ["Unassigned"];
      for (const w of wardNames) counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    const order = [...counts.keys()].sort();
    return [...counts.entries()]
      .map(([ward, count]) => ({ key: ward, label: ward, value: count, color: colorForKey(ward, order) }))
      .sort((a, b) => b.value - a.value);
  }, [scopedNurses, reportFacility]);

  // Staff directory: nurses by selected facility, grouped by ward.
  // When a top-level facility chip is active, it takes priority over the tab's own sub-chip.
  const effectiveDirFacility = reportFacility || dirFacility;
  const facilityNurses = useMemo(
    () => scopedNurses.filter((n) => n.facility === effectiveDirFacility),
    [scopedNurses, effectiveDirFacility],
  );
  const nursesByWard = useMemo(() => {
    const map = new Map<string, Nurse[]>();
    for (const n of facilityNurses) {
      const wardNames = n.ward
        ? n.ward
            .split("|")
            .map((w) => w.trim())
            .filter(Boolean)
        : ["Unassigned"];
      for (const w of wardNames) {
        const arr = map.get(w) ?? [];
        if (!arr.find((x) => x.id === n.id)) arr.push(n);
        map.set(w, arr);
      }
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [facilityNurses]);

  // nurse_id → facility / role lookups for archive grouping
  const archiveNurseToFacility = useMemo(
    () => new Map(nurses.map((n) => [n.id, n.facility])),
    [nurses],
  );
  const archiveNurseToRole = useMemo(
    () => new Map(nurses.map((n) => [n.id, n.role])),
    [nurses],
  );

  // Archive: group published assignments into facility+ward/roleGroup windows
  const allArchiveWindows = useMemo(
    () => groupArchiveWindows(archiveAssignments, archiveNurseToFacility, archiveNurseToRole),
    [archiveAssignments, archiveNurseToFacility, archiveNurseToRole],
  );

  // Filter archive windows by selected facility.
  // Top-level chip (reportFacility) takes priority over the tab's own sub-chip (archiveFacility).
  const effectiveArchiveFacility = reportFacility || archiveFacility;
  const archiveWindows = useMemo(
    () =>
      effectiveArchiveFacility
        ? allArchiveWindows.filter((w) => w.facility === effectiveArchiveFacility)
        : allArchiveWindows,
    [allArchiveWindows, effectiveArchiveFacility],
  );

  // Group archive windows by period start date
  const archiveByPeriod = useMemo(() => {
    const map = new Map<string, ArchiveWindow[]>();
    for (const win of archiveWindows) {
      const arr = map.get(win.startDate) ?? [];
      arr.push(win);
      map.set(win.startDate, arr);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [archiveWindows]);

  // Precompute roles per archive window (key = startDate|facility|ward-or-roleGroup)
  const archiveWindowRoles = useMemo(() => {
    const nurseRoleMap = new Map(nurses.map((n) => [n.id, n.role]));
    const facilityNurseIds = new Map(nurses.map((n) => [n.id, n.facility]));
    const result = new Map<string, string[]>();
    for (const win of allArchiveWindows) {
      const key = `${win.startDate}|${win.facility ?? ""}|${win.ward ?? win.roleGroup ?? ""}`;
      // Use each row's own role snapshot (role at generation time), falling back to
      // the live nurse role only for rows written before the snapshot column existed.
      const matchingRows = archiveAssignments.filter(
        (a) =>
          a.shift_date >= win.startDate &&
          a.shift_date <= win.endDate &&
          a.ward === win.ward &&
          facilityNurseIds.get(a.nurse_id) === win.facility,
      );
      const roles = [
        ...new Set(
          matchingRows
            .map((a) => a.nurse_role ?? nurseRoleMap.get(a.nurse_id))
            .filter(Boolean) as string[],
        ),
      ].sort();
      result.set(key, roles);
    }
    return result;
  }, [allArchiveWindows, archiveAssignments, nurses]);

  // ── Close Period ──────────────────────────────────────────────────────────
  async function closePeriod() {
    if (
      !confirm(
        "Close the current period? This will save all nurses' hours to the period archive and reset their monthly hour counter to 0.",
      )
    )
      return;
    setClosingPeriod(true);
    try {
      const today = todayYmd();
      const lookback = new Date();
      lookback.setDate(lookback.getDate() - 27);
      const lb = `${lookback.getFullYear()}-${String(lookback.getMonth() + 1).padStart(2, "0")}-${String(lookback.getDate()).padStart(2, "0")}`;

      const winArr = await api.get<{ shift_date: string }[]>(
        `/shift-assignments?from=${lb}&limit=1`,
      );
      const periodStart = winArr[0]?.shift_date ?? lb;

      const upsertRows = nurses
        .map((nurse) => ({
          nurse_id: nurse.id,
          period_start: periodStart,
          period_end: today,
          total_hours: nurseHoursMap.get(nurse.id) ?? 0,
          total_shifts: nurseShiftCountMap.get(nurse.id) ?? 0,
        }))
        .filter((r) => r.total_hours > 0);

      if (upsertRows.length) {
        await api.post("/nurse-period-hours/upsert", upsertRows);
        await api.patch("/nurses/reset-hours", {
          nurse_ids: upsertRows.map((r) => r.nurse_id),
        });
      }

      toast.success("Period closed — hours archived and counters reset");
      qc.invalidateQueries({ queryKey: ["nurses"] });
      qc.invalidateQueries({ queryKey: ["period-hours-all"] });
      qc.invalidateQueries({ queryKey: ["shift-logs-current"] });
    } catch {
      toast.error("Failed to close period");
    } finally {
      setClosingPeriod(false);
    }
  }

  // ── Exports ───────────────────────────────────────────────────────────────
  async function exportCurrentHours() {
    if (activeNurses.length === 0) return toast.error("No hours logged yet");
    try {
      const rows = scopedNurses.map((n) => ({
        Name: n.name,
        Role: n.role,
        Ward: n.ward ?? "",
        Facility: n.facility ?? "",
        "Shifts Completed": nurseShiftCountMap.get(n.id) ?? 0,
        "Hours Logged": (nurseHoursMap.get(n.id) ?? 0).toFixed(2),
        "Target Hours": n.target_hours,
      }));
      const wb = xlsWorkbook();
      xlsAddJsonSheet(wb, rows, "Current Period");
      await xlsDownload(wb, `shift-hours-${todayYmd()}.xlsx`);
      toast.success("Exported");
    } catch {
      toast.error("Export failed");
    }
  }

  async function exportDetailedLogs() {
    if (filteredShiftLogs.length === 0) return toast.error("No shift logs to export");
    try {
      const nurseMap = new Map(nurses.map((n) => [n.id, n]));
      const rows = filteredShiftLogs.map((l) => {
        const nurse = nurseMap.get(l.nurse_id);
        return {
          Name: nurse?.name ?? "Unknown",
          Role: nurse?.role ?? "",
          Ward: nurse?.ward ?? "",
          Date: fmtDate(l.shift_date),
          "Shift Type": l.shift_type === "M" ? "Morning" : "Night",
          "Started At": l.started_at ? new Date(l.started_at).toLocaleString("en-GB") : "",
          "Ended At": l.ended_at ? new Date(l.ended_at).toLocaleString("en-GB") : "In Progress",
          "Hours Logged": l.hours_logged != null ? Number(l.hours_logged).toFixed(2) : "",
          Late: l.is_late ? "Yes" : "No",
          "Late (mins)": l.late_minutes ?? "",
          "Late Reason": l.late_reason ?? "",
          "Period Start": fmtDate(l.period_start),
        };
      });
      const wb = xlsWorkbook();
      xlsAddJsonSheet(wb, rows, "Shift Logs");
      await xlsDownload(wb, `shift-logs-${todayYmd()}.xlsx`);
      toast.success("Exported");
    } catch {
      toast.error("Export failed");
    }
  }

  async function exportPeriodArchive() {
    if (filteredPeriodSummaries.length === 0) return toast.error("No archived periods to export");
    try {
      const nurseMap = new Map(nurses.map((n) => [n.id, n]));
      const rows = filteredPeriodSummaries.map((p) => {
        const nurse = nurseMap.get(p.nurse_id);
        return {
          Name: nurse?.name ?? "Unknown",
          Role: nurse?.role ?? "",
          Ward: nurse?.ward ?? "",
          Facility: nurse?.facility ?? "",
          "Period Start": fmtDate(p.period_start),
          "Period End": fmtDate(p.period_end),
          "Total Hours": Number(p.total_hours).toFixed(2),
          "Total Shifts": p.total_shifts,
        };
      });
      const wb = xlsWorkbook();
      xlsAddJsonSheet(wb, rows, "Period Archive");
      await xlsDownload(wb, `period-archive-${todayYmd()}.xlsx`);
      toast.success("Exported");
    } catch {
      toast.error("Export failed");
    }
  }

  async function exportLocumReport() {
    if (filteredLocumRequests.length === 0) return toast.error("No locum shifts to export");
    try {
      const rows = filteredLocumRequests.map((r) => {
        const log = r.accepted_by_nurse_id
          ? locumLogMap.get(`${r.accepted_by_nurse_id}|${r.shift_date.slice(0, 10)}`)
          : undefined;
        const missed = !!log?.is_missed;
        return {
          Date: fmtDate(r.shift_date),
          Nurse: r.accepted_by_nurse_name ?? "Unknown",
          Ward: r.ward,
          Facility: r.facility,
          "Shift Type": r.shift === "M" ? "Morning" : "Night",
          "Started At":
            !missed && log?.started_at ? new Date(log.started_at).toLocaleString("en-GB") : "",
          "Ended At": missed
            ? ""
            : log?.ended_at
              ? new Date(log.ended_at).toLocaleString("en-GB")
              : log
                ? "In Progress"
                : "Not Started",
          "Hours Logged": missed || log?.hours_logged == null ? "" : Number(log.hours_logged).toFixed(2),
          Late: log?.is_late ? "Yes" : "No",
          "Late (mins)": log?.late_minutes ?? "",
          "Late Reason": log?.late_reason ?? "",
          "Accepted At": r.accepted_at ? new Date(r.accepted_at).toLocaleString("en-GB") : "",
          Missed: missed ? "Yes" : "No",
        };
      });
      const wb = xlsWorkbook();
      xlsAddJsonSheet(wb, rows, "Locum Hours", [12, 26, 14, 10, 10, 20, 20, 12, 20]);
      await xlsDownload(wb, `locum-hours-${todayYmd()}.xlsx`);
      toast.success("Exported");
    } catch {
      toast.error("Export failed");
    }
  }

  async function exportLocumRequestsReport() {
    if (filteredLocumRequestsAll.length === 0) return toast.error("No locum requests to export");
    try {
      const statusLabel: Record<LocumRequestStatus, string> = {
        pending: "Awaiting CNO Review",
        approved: "Approved — Send Invites",
        declined: "Declined by CNO",
        invites_sent: "Invites Sent",
        filled: "Shift Filled",
        expired: "Time Elapsed",
      };
      const rows = filteredLocumRequestsAll.map((r) => ({
        Date: fmtDate(r.shift_date),
        "Shift Type": r.shift === "M" ? "Morning" : "Night",
        Facility: r.facility,
        Ward: r.ward,
        "Nurses Needed": r.nurses_needed,
        "Role Needed": r.role_needed ?? "",
        Status: statusLabel[r.status] ?? r.status,
        "Requested By": r.requested_by_name,
        "Reviewed By": r.reviewed_by_name ?? "",
        "Decline Reason": r.decline_reason ?? "",
        "Accepted By": r.accepted_by_nurse_name ?? "",
        "Accepted At": r.accepted_at ? new Date(r.accepted_at).toLocaleString("en-GB") : "",
        "Requested At": new Date(r.created_at).toLocaleString("en-GB"),
      }));
      const wb = xlsWorkbook();
      xlsAddJsonSheet(wb, rows, "Locum Requests", [12, 10, 10, 16, 12, 16, 20, 20, 20, 26, 20, 20, 20]);
      await xlsDownload(wb, `locum-requests-${todayYmd()}.xlsx`);
      toast.success("Exported");
    } catch {
      toast.error("Export failed");
    }
  }

  async function exportLeaveRequests() {
    const leaveOnly = filteredScopeLeave.filter((l) => l.type !== "Swap");
    const switches = filteredScopeLeave.filter((l) => l.type === "Swap");
    if (filteredScopeLeave.length === 0) return toast.error("No leave requests to export");
    try {
      const nurseMap = new Map(nurses.map((n) => [n.id, n]));

      const rotaStageLabel = (s: LeaveRequest["rota_stage_at_request"]) =>
        s === "published" ? "After publish" : s === "draft" ? "Before submission" : s === "no_rota" ? "No rota yet" : "–";

      const leaveRows = leaveOnly.map((l) => ({
        Nurse: nurseMap.get(l.nurse_id ?? "")?.name ?? "Unknown",
        Facility: nurseMap.get(l.nurse_id ?? "")?.facility ?? "",
        Ward: nurseMap.get(l.nurse_id ?? "")?.ward?.split("|")[0] ?? "",
        Type: l.type,
        From: fmtDate(l.from_date),
        To: fmtDate(l.to_date),
        Status: l.status,
        "Rota Stage": rotaStageLabel(l.rota_stage_at_request),
        "Requested Date": fmtDate(l.created_at),
        "Reviewed By": l.reviewed_by_name ?? "",
        "Reviewed On": l.reviewed_at ? fmtDate(l.reviewed_at) : "",
        Reason: l.reason ?? "",
      }));

      const switchRows = switches.map((s) => ({
        Nurse: nurseMap.get(s.nurse_id ?? "")?.name ?? "Unknown",
        Facility: nurseMap.get(s.nurse_id ?? "")?.facility ?? "",
        Ward: nurseMap.get(s.nurse_id ?? "")?.ward?.split("|")[0] ?? "",
        Type: "Swap",
        From: fmtDate(s.from_date),
        To: fmtDate(s.to_date),
        Status: s.status,
        "Requested Date": fmtDate(s.created_at),
        "Reviewed By": s.reviewed_by_name ?? "",
        "Reviewed On": s.reviewed_at ? fmtDate(s.reviewed_at) : "",
        Note: s.reason ?? "",
      }));

      const wb = xlsWorkbook();
      xlsAddJsonSheet(
        wb,
        leaveRows.length ? leaveRows : [{ Note: "No leave requests" }],
        "Leave Requests",
        [26, 10, 16, 14, 12, 12, 10, 16, 14, 18, 14, 32],
      );
      xlsAddJsonSheet(
        wb,
        switchRows.length ? switchRows : [{ Note: "No switch requests" }],
        "Shift Switches",
        [26, 10, 16, 10, 12, 12, 10, 14, 18, 14, 32],
      );
      await xlsDownload(wb, `leave-requests-${todayYmd()}.xlsx`);
      toast.success("Exported");
    } catch {
      toast.error("Export failed");
    }
  }

  async function exportMissedShifts() {
    if (filteredMissedLogs.length === 0) return toast.error("No missed shifts to export");
    try {
      const nurseMap = new Map(nurses.map((n) => [n.id, n]));
      const rows = filteredMissedLogs.map((l) => {
        const nurse = nurseMap.get(l.nurse_id);
        return {
          Date: fmtDate(l.shift_date),
          Nurse: nurse?.name ?? "Unknown",
          Facility: nurse?.facility ?? "",
          Ward: nurse?.ward?.split("|")[0] ?? "",
          Shift: l.shift_type === "M" ? "Morning" : l.shift_type === "N" ? "Night" : l.shift_type,
          Type: l.is_locum ? "Locum" : "Roster",
        };
      });
      const wb = xlsWorkbook();
      xlsAddJsonSheet(wb, rows, "Missed Shifts");
      await xlsDownload(wb, `missed-shifts-${todayYmd()}.xlsx`);
      toast.success("Exported");
    } catch {
      toast.error("Export failed");
    }
  }

  function escHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ── Staff directory print ─────────────────────────────────────────────────
  function printStaffList(ward?: string) {
    const staffToPrint = ward
      ? facilityNurses.filter((n) =>
          n.ward
            ?.split("|")
            .map((w) => w.trim())
            .includes(ward),
        )
      : facilityNurses;
    const wardLabel = ward ? ` — ${ward}` : "";
    const today = new Date().toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>Staff Directory — ${effectiveDirFacility}${wardLabel}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;font-size:10pt;padding:1.5cm}
h1{font-size:13pt;margin-bottom:3px}
p{font-size:8pt;color:#555;margin-bottom:10px}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ccc;padding:5px 8px;text-align:left}
th{background:#e5e7eb;font-weight:600;font-size:8pt;text-transform:uppercase;letter-spacing:.04em}
tr:nth-child(even){background:#f9fafb}
@media print{@page{size:A4;margin:1.5cm}body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>
<h1>Staff Directory — ${effectiveDirFacility}${wardLabel}</h1>
<p>Generated: ${today} &nbsp;·&nbsp; ${staffToPrint.length} staff</p>
<table>
<thead><tr><th>#</th><th>Name</th><th>Role</th><th>Ward</th></tr></thead>
<tbody>
${staffToPrint
  .sort((a, b) => a.name.localeCompare(b.name))
  .map(
    (n, i) =>
      `<tr><td>${i + 1}</td><td>${escHtml(n.name)}</td><td>${escHtml(n.role)}</td><td>${n.ward ? escHtml(n.ward.split("|")[0]) : "—"}</td></tr>`,
  )
  .join("")}
</tbody>
</table>
<script>window.onload=()=>{window.print()}</script>
</body></html>`;
    openPrintWindow(html);
  }

  async function exportStaffListExcel(ward?: string) {
    try {
      const staffToExport = ward
        ? facilityNurses.filter((n) =>
            n.ward
              ?.split("|")
              .map((w) => w.trim())
              .includes(ward),
          )
        : facilityNurses;
      const rows = staffToExport
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((n, i) => ({
          "#": i + 1,
          Name: n.name,
          Role: n.role,
          Ward: n.ward?.split("|")[0] ?? "",
          Facility: n.facility ?? "",
        }));
      const wb = xlsWorkbook();
      xlsAddJsonSheet(wb, rows, "Staff", [4, 28, 22, 18, 10]);
      const slug = ward ? `-${ward.replace(/\s+/g, "-").toLowerCase()}` : "";
      await xlsDownload(wb, `staff-${effectiveDirFacility.toLowerCase()}${slug}-${todayYmd()}.xlsx`);
      toast.success("Exported");
    } catch {
      toast.error("Export failed");
    }
  }

  // ── Schedule archive download ─────────────────────────────────────────────
  async function fetchScheduleData(win: ArchiveWindow) {
    // Scope to the right set of nurses for this window's facility. Deliberately
    // NOT filtered by current role here — a nurse's role today may differ from
    // her role when this rota was published, and a role change must not make
    // her vanish from her own history. Facility-wide (roleGroup) windows are
    // filtered below using each row's own nurse_role snapshot instead.
    const facilityNurses = win.facility ? nurses.filter((n) => n.facility === win.facility) : nurses;
    const facilityNurseIds = facilityNurses.map((n) => n.id);

    const wardParam =
      win.ward !== null ? `&ward=${encodeURIComponent(win.ward)}` : "&ward_null=true";
    let allAssignments = facilityNurseIds.length
      ? await api.get<{ nurse_id: string; shift_date: string; shift: string; nurse_role: string | null }[]>(
          `/shift-assignments?nurse_ids=${facilityNurseIds.join(",")}&from=${win.startDate}&to=${win.endDate}&status=published${wardParam}`,
        )
      : [];

    if (win.ward === null && win.roleGroup) {
      const nurseRoleMap = new Map(nurses.map((n) => [n.id, n.role]));
      allAssignments = allAssignments.filter(
        (a) => roleGroupOf(a.nurse_role ?? nurseRoleMap.get(a.nurse_id) ?? "") === win.roleGroup,
      );
    }

    const assignMap = new Map(
      allAssignments.map((a) => [`${a.nurse_id}|${a.shift_date.slice(0, 10)}`, a.shift]),
    );
    const activeIds = new Set(allAssignments.map((a) => a.nurse_id));
    const activeNurses = nurses.filter((n) => activeIds.has(n.id));
    return { activeNurses, assignMap };
  }

  async function downloadSchedulePdf(win: ArchiveWindow) {
    const key = `${win.startDate}|${win.facility ?? ""}|${win.ward ?? win.roleGroup ?? ""}`;
    setArchiveDownloading(key + "-pdf");
    try {
      const { activeNurses, assignMap } = await fetchScheduleData(win);
      const dates = dateRange(win.startDate, win.endDate);
      const wardLabel = win.ward ? ` — ${win.ward}` : ` — ${win.roleGroup ? FW_LABELS[win.roleGroup] : "Facility-Wide Staff"}`;
      const facilityLabel = win.facility ? ` · ${win.facility}` : "";
      const shiftBg: Record<string, string> = {
        M: "#fef3c7",
        N: "#e0e7ff",
        OFF: "#f3f4f6",
        LEAVE: "#fee2e2",
      };
      const dateHeaders = dates
        .map((d) => {
          const dt = new Date(d + "T00:00:00");
          return `<th>${dt.toLocaleDateString("en-GB", { weekday: "short" })}<br/>${dt.getDate()}/${dt.getMonth() + 1}</th>`;
        })
        .join("");
      const bodyRows = activeNurses
        .map((n) => {
          const cells = dates
            .map((d) => {
              const s = assignMap.get(`${n.id}|${d}`) ?? "";
              return `<td style="background:${shiftBg[s] ?? "#fff"}">${s || "—"}</td>`;
            })
            .join("");
          return `<tr><td class="nm">${escHtml(n.name)}</td><td class="sm">${escHtml(n.role)}</td><td class="sm">${n.ward ? escHtml(n.ward.split("|")[0]) : "—"}</td>${cells}</tr>`;
        })
        .join("");
      const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>Nurse Rota ${win.startDate.slice(0, 10)} — ${win.endDate.slice(0, 10)}${facilityLabel}${wardLabel}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;font-size:7pt;padding:1cm}
h1{font-size:11pt;margin-bottom:4px}
p{font-size:8pt;color:#555;margin-bottom:8px}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ccc;padding:2px 3px;text-align:center;white-space:nowrap}
th{background:#e5e7eb;font-size:6pt;font-weight:600}
td.nm{text-align:left;font-weight:500;min-width:80px}
td.sm{text-align:left;color:#444;min-width:55px}
.legend{display:flex;gap:12px;margin-top:8px;font-size:7pt}
.lb{display:inline-block;width:10px;height:10px;border:1px solid #aaa;margin-right:2px;vertical-align:middle}
@media print{@page{size:A3 landscape;margin:1cm}body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>
<h1>Nurse Rota${facilityLabel}${wardLabel}</h1>
<p>${fmtDate(win.startDate)} — ${fmtDate(win.endDate)} &nbsp;·&nbsp; ${activeNurses.length} staff</p>
<table>
<thead><tr><th>Nurse</th><th>Role</th><th>Ward</th>${dateHeaders}</tr></thead>
<tbody>${bodyRows}</tbody>
</table>
<div class="legend">
<span><span class="lb" style="background:#fef3c7"></span>M Morning</span>
<span><span class="lb" style="background:#e0e7ff"></span>N Night</span>
<span><span class="lb" style="background:#f3f4f6"></span>OFF</span>
<span><span class="lb" style="background:#fee2e2"></span>LEAVE</span>
</div>
<script>window.onload=()=>{window.print()}</script>
</body></html>`;
      openPrintWindow(html);
    } catch {
      toast.error("Failed to generate PDF");
    } finally {
      setArchiveDownloading(null);
    }
  }

  async function downloadScheduleExcel(win: ArchiveWindow) {
    const key = `${win.startDate}|${win.facility ?? ""}|${win.ward ?? win.roleGroup ?? ""}`;
    setArchiveDownloading(key + "-xlsx");
    try {
      const { activeNurses, assignMap } = await fetchScheduleData(win);
      const dates = dateRange(win.startDate, win.endDate);
      const wardLabel = win.ward ? ` — ${win.ward}` : ` — ${win.roleGroup ? FW_LABELS[win.roleGroup] : "Facility-Wide Staff"}`;
      const facilityLabel = win.facility ? ` · ${win.facility}` : "";
      const title = `Nurse Rota: ${fmtDate(win.startDate)} — ${fmtDate(win.endDate)}${facilityLabel}${wardLabel}`;
      const headers = [
        "Nurse",
        "Role",
        "Ward",
        ...dates.map((d) => {
          const dt = new Date(d + "T00:00:00");
          return `${dt.toLocaleDateString("en-GB", { weekday: "short" })} ${dt.getDate()}/${dt.getMonth() + 1}`;
        }),
      ];
      const rowData = activeNurses.map((n) => [
        n.name,
        n.role,
        n.ward ? n.ward.split("|")[0] : "",
        ...dates.map((d) => assignMap.get(`${n.id}|${d}`) ?? ""),
      ]);
      const wb = xlsWorkbook();
      xlsAddAoaSheet(wb, [[title], [], headers, ...rowData], "Rota", [22, 18, 14, ...dates.map(() => 5)]);
      const slug = win.ward ? `-${win.ward.replace(/\s+/g, "-").toLowerCase()}` : "-coverage";
      await xlsDownload(wb, `rota-archive-${win.startDate.slice(0, 10)}-to-${win.endDate.slice(0, 10)}${slug}.xlsx`);
    } catch {
      toast.error("Failed to generate Excel file");
    } finally {
      setArchiveDownloading(null);
    }
  }

  // ── Unified facility report (all wards + role groups in one PDF) ─────────
  async function downloadUnifiedPdf(periodStart: string, periodWins: ArchiveWindow[]) {
    const uKey = `unified-${periodStart}`;
    setArchiveDownloading(uKey + "-pdf");
    try {
      const allData = await Promise.all(
        periodWins.map(async (win) => {
          const { activeNurses, assignMap } = await fetchScheduleData(win);
          const label = win.ward ?? (win.roleGroup ? FW_LABELS[win.roleGroup] : "Facility-Wide Staff");
          return { label, activeNurses, assignMap };
        }),
      );
      const endDate = scheduleEndDate(periodStart);
      const dates = dateRange(periodStart, endDate);
      const shiftBg: Record<string, string> = {
        M: "#fef3c7",
        N: "#e0e7ff",
        OFF: "#f3f4f6",
        LEAVE: "#fee2e2",
      };
      const dateHeaders = dates
        .map((d) => {
          const dt = new Date(d + "T00:00:00");
          return `<th>${dt.toLocaleDateString("en-GB", { weekday: "short" })}<br/>${dt.getDate()}/${dt.getMonth() + 1}</th>`;
        })
        .join("");
      const facility = periodWins[0]?.facility ?? "";
      const sections = allData
        .filter(({ activeNurses }) => activeNurses.length > 0)
        .map(({ label, activeNurses, assignMap }) => {
          const bodyRows = activeNurses
            .map((n) => {
              const cells = dates
                .map((d) => {
                  const s = assignMap.get(`${n.id}|${d}`) ?? "";
                  return `<td style="background:${shiftBg[s] ?? "#fff"}">${s || "—"}</td>`;
                })
                .join("");
              return `<tr><td class="nm">${escHtml(n.name)}</td><td class="sm">${escHtml(n.role)}</td><td class="sm">${n.ward ? escHtml(n.ward.split("|")[0]) : "—"}</td>${cells}</tr>`;
            })
            .join("");
          return `<h2>${label}</h2><table><thead><tr><th>Nurse</th><th>Role</th><th>Ward</th>${dateHeaders}</tr></thead><tbody>${bodyRows}</tbody></table>`;
        })
        .join("<br/>");
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Unified Rota — ${facility} — ${fmtDate(periodStart)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;font-size:7pt;padding:1cm}
h1{font-size:11pt;margin-bottom:4px}
h2{font-size:9pt;font-weight:600;margin:14px 0 4px;color:#374151;border-bottom:1px solid #e5e7eb;padding-bottom:2px;page-break-before:auto}
p{font-size:8pt;color:#555;margin-bottom:8px}
table{border-collapse:collapse;width:100%;margin-bottom:6px}
th,td{border:1px solid #ccc;padding:2px 3px;text-align:center;white-space:nowrap}
th{background:#e5e7eb;font-size:6pt;font-weight:600}
td.nm{text-align:left;font-weight:500;min-width:80px}
td.sm{text-align:left;color:#444;min-width:55px}
.legend{display:flex;gap:12px;margin-top:8px;font-size:7pt}
.lb{display:inline-block;width:10px;height:10px;border:1px solid #aaa;margin-right:2px;vertical-align:middle}
@media print{@page{size:A3 landscape;margin:1cm}body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>
<h1>Unified Rota — ${facility}</h1>
<p>${fmtDate(periodStart)} — ${fmtDate(endDate)}</p>
${sections}
<div class="legend">
<span><span class="lb" style="background:#fef3c7"></span>M Morning</span>
<span><span class="lb" style="background:#e0e7ff"></span>N Night</span>
<span><span class="lb" style="background:#f3f4f6"></span>OFF</span>
<span><span class="lb" style="background:#fee2e2"></span>LEAVE</span>
</div>
<script>window.onload=()=>{window.print()}</script>
</body></html>`;
      openPrintWindow(html);
    } catch {
      toast.error("Failed to generate unified report");
    } finally {
      setArchiveDownloading(null);
    }
  }

  // ── Tab styles ────────────────────────────────────────────────────────────

  const tabCls = (t: typeof tab) =>
    `px-4 py-2 text-sm font-medium rounded-md transition ${tab === t ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`;

  return (
    <div>
      <PageHeader
        title="Reports & Analytics"
        subtitle="Coverage, hours and shift insights"
        actions={
          <button
            type="button"
            disabled={closingPeriod}
            onClick={closePeriod}
            title="Periods close automatically at 8 am the day after the last shift. Use this only to close manually."
            className="inline-flex items-center gap-2 h-10 px-4 rounded-md border bg-card text-sm hover:bg-amber-50 hover:border-amber-400 hover:text-amber-700 disabled:opacity-50"
          >
            <Archive className="h-4 w-4" />
            {closingPeriod ? "Closing…" : "Force Close Period"}
          </button>
        }
      />

      {/* Facility chip strip */}
      <div className="mb-4">
        <FacilityChips
          value={lockedReportFacility ?? selectedReportFacility}
          onChange={(f) => { setSelectedReportFacility(f); }}
          locked={!!lockedReportFacility}
          showAll={canFilterReportFacility}
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-muted/50 rounded-lg p-1 mb-6 w-fit flex-wrap">
        <button type="button" className={tabCls("overview")} onClick={() => setTab("overview")}>
          Overview
        </button>
        <button type="button" className={tabCls("hours")} onClick={() => setTab("hours")}>
          Shift Hours
        </button>
        <button type="button" className={tabCls("locum")} onClick={() => setTab("locum")}>
          Locum Hours
        </button>
        <button
          type="button"
          className={tabCls("locum-requests")}
          onClick={() => setTab("locum-requests")}
        >
          Locum Requests
        </button>
        <button type="button" className={tabCls("periods")} onClick={() => setTab("periods")}>
          Period Archive
        </button>
        <button type="button" className={tabCls("leave")} onClick={() => setTab("leave")}>
          Leave & Requests
        </button>
        <button type="button" className={tabCls("missed")} onClick={() => setTab("missed")}>
          Missed Shifts
        </button>
        {canPrintStaff && (
          <button type="button" className={tabCls("staff-dir")} onClick={() => setTab("staff-dir")}>
            Staff Directory
          </button>
        )}
        {canPrintSchedule && (
          <button type="button" className={tabCls("schedules")} onClick={() => setTab("schedules")}>
            Schedule Archive
          </button>
        )}
      </div>

      {/* ── Overview ─────────────────────────────────────────────────────── */}
      {tab === "overview" && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6">
            <Stat icon={Users} label="Staff" value={scopedNurses.length} />
            <Stat
              icon={BarChart3}
              label="Wards"
              value={
                reportFacility
                  ? wards.filter((w) => w.facility === reportFacility).length
                  : wards.length
              }
            />
            <Stat icon={Clock} label="Shift Hours (period)" value={totalLoggedHours.toFixed(1)} />
            <Stat
              icon={Stethoscope}
              label="Locum Hours (all time)"
              value={totalLocumHours.toFixed(1)}
            />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <CategoryChartCard
              title="Hours by Category"
              subtitle="Current period — regular, locum, additional and leave-credited hours"
              data={hoursByCategoryData}
              emptyMessage="No hours logged yet."
              valueLabel="hours"
              formatValue={(v) => v.toFixed(1)}
            />
            <CategoryChartCard
              title="Leave by Type"
              subtitle="Approved leave requests"
              data={leaveByTypeData}
              emptyMessage="No approved leave in this scope yet."
              valueLabel="request(s)"
            />
            <CategoryChartCard
              title={reportFacility ? "Staff by Ward" : "Staff by Facility"}
              subtitle={reportFacility ? `${reportFacility} — nurses per ward` : "Nurses per facility"}
              data={staffByGroupData}
              emptyMessage="No staff in this scope yet."
              valueLabel="staff"
              defaultView="bar"
            />
            <CategoryChartCard
              title="Missed Shifts by Type"
              subtitle="Current period — roster vs locum"
              data={missedByTypeData}
              emptyMessage="No missed shifts in the current period."
              valueLabel="shift(s)"
            />
          </div>
        </>
      )}

      {/* ── Shift Hours ──────────────────────────────────────────────────── */}
      {tab === "hours" && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <DateRangeFilter
              value={hoursRange}
              onChange={(v) => { setHoursRange(v); setHoursPage(1); }}
            />
            <select
              value={hoursStatusFilter}
              onChange={(e) => {
                setHoursStatusFilter(e.target.value as typeof hoursStatusFilter);
                setHoursPage(1);
              }}
              className="h-9 rounded-md border border-input bg-card px-3 text-sm"
            >
              <option value="all">Running &amp; ended</option>
              <option value="running">Running</option>
              <option value="ended">Ended</option>
            </select>
            <select
              value={hoursShiftTypeFilter}
              onChange={(e) => {
                setHoursShiftTypeFilter(e.target.value as typeof hoursShiftTypeFilter);
                setHoursPage(1);
              }}
              className="h-9 rounded-md border border-input bg-card px-3 text-sm"
            >
              <option value="all">All shifts</option>
              <option value="M">Morning</option>
              <option value="N">Night</option>
            </select>
            <select
              value={hoursCategoryFilter}
              onChange={(e) => {
                setHoursCategoryFilter(e.target.value as typeof hoursCategoryFilter);
                setHoursPage(1);
              }}
              className="h-9 rounded-md border border-input bg-card px-3 text-sm"
            >
              <option value="all">All types</option>
              <option value="regular">Regular</option>
              <option value="swap">Additional Shift</option>
              <option value="leave">Leave</option>
            </select>
            {(hoursStatusFilter !== "all" ||
              hoursShiftTypeFilter !== "all" ||
              hoursCategoryFilter !== "all") && (
              <button
                type="button"
                onClick={() => {
                  setHoursStatusFilter("all");
                  setHoursShiftTypeFilter("all");
                  setHoursCategoryFilter("all");
                }}
                className="text-xs text-muted-foreground hover:text-foreground underline"
              >
                Clear filters
              </button>
            )}
            <div className="ml-auto flex gap-2">
              <button
                type="button"
                onClick={exportCurrentHours}
                className="inline-flex items-center gap-2 h-9 px-3 rounded-md border bg-card text-sm hover:bg-muted"
              >
                <FileSpreadsheet className="h-4 w-4 text-emerald-600" /> Summary Excel
              </button>
              <button
                type="button"
                onClick={exportDetailedLogs}
                className="inline-flex items-center gap-2 h-9 px-3 rounded-md border bg-card text-sm hover:bg-muted"
              >
                <Download className="h-4 w-4" /> Detailed Logs
              </button>
            </div>
          </div>

          {filteredShiftLogs.length === 0 ? (
            scopedShiftLogs.length === 0 ? (
              <EmptyState
                icon={<Clock className="h-6 w-6" />}
                title="No shift logs"
                description="Shift logs appear here once nurses start tracking their shifts."
              />
            ) : (
              <div className="py-16 text-center text-sm text-muted-foreground">
                No shift logs found for the selected date range.
              </div>
            )
          ) : (
            <div className="bg-card border rounded-xl shadow-soft overflow-hidden">
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="text-left px-4 py-3 font-semibold">Nurse</th>
                    <th className="text-left px-4 py-3 font-semibold">Date</th>
                    <th className="text-left px-4 py-3 font-semibold">Shift</th>
                    <th className="text-left px-4 py-3 font-semibold">Type</th>
                    <th className="text-left px-4 py-3 font-semibold">Started</th>
                    <th className="text-left px-4 py-3 font-semibold">Ended</th>
                    <th className="text-left px-4 py-3 font-semibold">Late</th>
                    <th className="text-right px-4 py-3 font-semibold">Hours</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedShiftLogs.map((log) => {
                    const nurse = nurses.find((n) => n.id === log.nurse_id);
                    return (
                      <tr
                        key={`${log.nurse_id}-${log.shift_date}`}
                        className="border-t hover:bg-muted/30"
                      >
                        <td className="px-4 py-3 font-medium">{nurse?.name ?? "—"}</td>
                        <td className="px-4 py-3 text-muted-foreground">{fmtDate(log.shift_date)}</td>
                        <td className="px-4 py-3">
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full font-semibold ${log.shift_type === "M" ? "bg-amber-100 text-amber-700" : "bg-indigo-100 text-indigo-700"}`}
                          >
                            {log.shift_type === "M" ? "Morning" : "Night"}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {log.is_swap ? (
                            <span
                              title={log.swap_note ?? undefined}
                              className="inline-flex items-center gap-1 text-[11px] font-semibold text-sky-700 bg-sky-50 border border-sky-200 px-2 py-0.5 rounded-full"
                            >
                              Additional Shift
                            </span>
                          ) : log.is_leave ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                              Leave
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">Regular</span>
                          )}
                        </td>
                        <td className="px-4 py-3 tabular-nums text-muted-foreground">
                          {log.started_at
                            ? new Date(log.started_at).toLocaleTimeString("en-GB", {
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            : "—"}
                        </td>
                        <td className="px-4 py-3 tabular-nums text-muted-foreground">
                          {log.ended_at ? (
                            new Date(log.ended_at).toLocaleTimeString("en-GB", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          ) : (
                            <span className="text-emerald-600 text-xs font-medium">Running</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {log.is_late ? (
                            <span
                              className="inline-flex items-center gap-1 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full"
                              title={log.late_reason ?? undefined}
                            >
                              <Clock className="h-3 w-3" />
                              {log.late_minutes}m late
                              {log.late_reason && (
                                <span className="hidden sm:inline text-amber-600 max-w-30 truncate">
                                  — {log.late_reason}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums font-medium">
                          {log.hours_logged != null ? fmtHoursLog(Number(log.hours_logged)) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
              <Pagination
                page={hoursPage}
                totalPages={hoursTotalPages}
                pageSize={hoursPageSize}
                totalItems={filteredShiftLogs.length}
                onPage={setHoursPage}
                onPageSize={(s) => {
                  setHoursPageSize(s);
                  setHoursPage(1);
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* ── Locum Hours ──────────────────────────────────────────────────── */}
      {tab === "locum" && (
        <div className="space-y-4">
          {/* Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
            <Stat icon={Stethoscope} label="Shifts Filled" value={filteredLocumRequests.length} />
            <Stat icon={Clock} label="Total Hours" value={filteredLocumTotalHours.toFixed(1)} />
            <Stat
              icon={Users}
              label="Nurses Used"
              value={new Set(filteredLocumRequests.map((r) => r.accepted_by_nurse_id)).size}
            />
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <DateRangeFilter
              value={locumRange}
              onChange={(v) => { setLocumRange(v); setLocumPage(1); }}
            />
            <div className="ml-auto">
              <button
                type="button"
                onClick={exportLocumReport}
                className="inline-flex items-center gap-2 h-9 px-3 rounded-md border bg-card text-sm hover:bg-muted"
              >
                <FileSpreadsheet className="h-4 w-4 text-emerald-600" /> Export Locum Report
              </button>
            </div>
          </div>

          {filteredLocumRequests.length === 0 ? (
            scopedLocumRequests.length === 0 ? (
              <EmptyState
                icon={<Stethoscope className="h-6 w-6" />}
                title="No locum shifts filled yet"
                description="Hours appear here once nurses accept locum invitations and complete their shifts."
              />
            ) : (
              <div className="py-16 text-center text-sm text-muted-foreground">
                No locum shifts found for the selected date range.
              </div>
            )
          ) : (
            <>
              {/* Per-nurse summary */}
              <div className="bg-card border rounded-xl p-5 shadow-soft">
                <h2 className="font-semibold mb-4">Per-Nurse Summary</h2>
                <div className="space-y-2">
                  {[...filteredLocumHoursMap.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([nurseId, hrs]) => {
                      const name =
                        filteredLocumRequests.find((r) => r.accepted_by_nurse_id === nurseId)
                          ?.accepted_by_nurse_name ?? "Unknown";
                      const shifts = filteredLocumShiftCountMap.get(nurseId) ?? 0;
                      return (
                        <div key={nurseId} className="flex items-center gap-3 text-sm">
                          <div className="w-40 truncate font-medium">{name}</div>
                          <div className="flex-1 h-5 rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full rounded-full bg-violet-400"
                              style={{
                                width: `${Math.min(Math.round((hrs / Math.max(filteredLocumTotalHours, 1)) * 100), 100)}%`,
                              }}
                            />
                          </div>
                          <div className="w-36 text-right tabular-nums text-muted-foreground text-xs">
                            {hrs.toFixed(1)} h · {shifts} shift{shifts !== 1 ? "s" : ""}
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>

              {/* Detailed log */}
              <div className="bg-card border rounded-xl shadow-soft overflow-hidden">
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="text-left px-4 py-3 font-semibold">Date</th>
                      <th className="text-left px-4 py-3 font-semibold">Nurse</th>
                      <th className="text-left px-4 py-3 font-semibold">Ward</th>
                      <th className="text-left px-4 py-3 font-semibold">Facility</th>
                      <th className="text-left px-4 py-3 font-semibold">Shift</th>
                      <th className="text-left px-4 py-3 font-semibold">Started</th>
                      <th className="text-left px-4 py-3 font-semibold">Ended</th>
                      <th className="text-right px-4 py-3 font-semibold">Hours</th>
                      <th className="text-left px-4 py-3 font-semibold">Late</th>
                      <th className="text-left px-4 py-3 font-semibold">Missed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedLocumRequests.map((r) => {
                      const log = r.accepted_by_nurse_id
                        ? locumLogMap.get(`${r.accepted_by_nurse_id}|${r.shift_date.slice(0, 10)}`)
                        : undefined;
                      const missed = !!log?.is_missed;
                      return (
                        <tr key={r.id} className="border-t hover:bg-muted/30">
                          <td className="px-4 py-3 tabular-nums text-muted-foreground">
                            {fmtDate(r.shift_date)}
                          </td>
                          <td className="px-4 py-3 font-medium">
                            {r.accepted_by_nurse_name ?? "—"}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">{r.ward}</td>
                          <td className="px-4 py-3 text-muted-foreground">{r.facility}</td>
                          <td className="px-4 py-3">
                            <span
                              className={`text-xs px-2 py-0.5 rounded-full font-semibold ${r.shift === "M" ? "bg-amber-100 text-amber-700" : "bg-indigo-100 text-indigo-700"}`}
                            >
                              {r.shift === "M" ? "Morning" : "Night"}
                            </span>
                          </td>
                          <td className="px-4 py-3 tabular-nums text-muted-foreground">
                            {missed ? (
                              <span className="text-muted-foreground text-xs">—</span>
                            ) : log?.started_at ? (
                              new Date(log.started_at).toLocaleTimeString("en-GB", {
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="px-4 py-3 tabular-nums text-muted-foreground">
                            {missed ? (
                              <span className="text-muted-foreground text-xs">—</span>
                            ) : log?.ended_at ? (
                              new Date(log.ended_at).toLocaleTimeString("en-GB", {
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            ) : log ? (
                              <span className="text-emerald-600 text-xs font-medium">Running</span>
                            ) : (
                              <span className="text-muted-foreground text-xs">Not started</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums font-medium">
                            {missed
                              ? "—"
                              : log?.hours_logged != null
                                ? fmtHoursLog(Number(log.hours_logged))
                                : "—"}
                          </td>
                          <td className="px-4 py-3">
                            {log?.is_late ? (
                              <span
                                className="inline-flex items-center gap-1 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full"
                                title={log.late_reason ?? undefined}
                              >
                                <Clock className="h-3 w-3" />
                                {log.late_minutes}m late
                                {log.late_reason && (
                                  <span className="hidden sm:inline text-amber-600 max-w-30 truncate">
                                    — {log.late_reason}
                                  </span>
                                )}
                              </span>
                            ) : (
                              <span className="text-muted-foreground text-xs">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {missed ? (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-rose-100 text-rose-700">
                                Missed
                              </span>
                            ) : (
                              <span className="text-muted-foreground text-xs">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
                <Pagination
                  page={locumPage}
                  totalPages={locumTotalPages}
                  pageSize={locumPageSize}
                  totalItems={filteredLocumRequests.length}
                  onPage={setLocumPage}
                  onPageSize={(s) => {
                    setLocumPageSize(s);
                    setLocumPage(1);
                  }}
                />
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Locum Requests ───────────────────────────────────────────────── */}
      {tab === "locum-requests" && (() => {
        const LOCUM_REQ_STATUS_LABEL: Record<LocumRequestStatus, string> = {
          pending: "Awaiting CNO Review",
          approved: "Approved — Send Invites",
          declined: "Declined by CNO",
          invites_sent: "Invites Sent",
          filled: "Shift Filled",
          expired: "Time Elapsed",
        };
        const LOCUM_REQ_STATUS_COLOR: Record<LocumRequestStatus, string> = {
          pending: "bg-amber-100 text-amber-700",
          approved: "bg-blue-100 text-blue-700",
          declined: "bg-red-100 text-red-700",
          invites_sent: "bg-purple-100 text-purple-700",
          filled: "bg-emerald-100 text-emerald-700",
          expired: "bg-gray-100 text-gray-500",
        };
        const pendingCount = filteredLocumRequestsAll.filter((r) => r.status === "pending").length;
        const filledCount = filteredLocumRequestsAll.filter((r) => r.status === "filled").length;
        const expiredCount = filteredLocumRequestsAll.filter((r) => r.status === "expired").length;

        return (
          <div className="space-y-4">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
              <Stat icon={Stethoscope} label="Total Requests" value={filteredLocumRequestsAll.length} />
              <Stat icon={Clock} label="Awaiting CNO Review" value={pendingCount} />
              <Stat icon={CheckCircle2} label="Filled" value={filledCount} />
              <Stat icon={XCircle} label="Time Elapsed" value={expiredCount} />
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <DateRangeFilter
                value={locumReqRange}
                onChange={(v) => { setLocumReqRange(v); setLocumReqPage(1); }}
              />
              <select
                value={locumReqStatusFilter}
                onChange={(e) => {
                  setLocumReqStatusFilter(e.target.value as typeof locumReqStatusFilter);
                  setLocumReqPage(1);
                }}
                className="h-9 rounded-md border border-input bg-card px-3 text-sm"
              >
                <option value="all">All statuses</option>
                <option value="pending">Awaiting CNO Review</option>
                <option value="approved">Approved — Send Invites</option>
                <option value="declined">Declined by CNO</option>
                <option value="invites_sent">Invites Sent</option>
                <option value="filled">Shift Filled</option>
                <option value="expired">Time Elapsed</option>
              </select>
              <select
                value={locumReqShiftFilter}
                onChange={(e) => {
                  setLocumReqShiftFilter(e.target.value as typeof locumReqShiftFilter);
                  setLocumReqPage(1);
                }}
                className="h-9 rounded-md border border-input bg-card px-3 text-sm"
              >
                <option value="all">All shifts</option>
                <option value="M">Morning</option>
                <option value="N">Night</option>
              </select>
              {(locumReqStatusFilter !== "all" || locumReqShiftFilter !== "all") && (
                <button
                  type="button"
                  onClick={() => {
                    setLocumReqStatusFilter("all");
                    setLocumReqShiftFilter("all");
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground underline"
                >
                  Clear filters
                </button>
              )}
              <div className="ml-auto">
                <button
                  type="button"
                  onClick={exportLocumRequestsReport}
                  className="inline-flex items-center gap-2 h-9 px-3 rounded-md border bg-card text-sm hover:bg-muted"
                >
                  <FileSpreadsheet className="h-4 w-4 text-emerald-600" /> Export
                </button>
              </div>
            </div>

            {filteredLocumRequestsAll.length === 0 ? (
              scopedLocumRequestsAll.length === 0 ? (
                <EmptyState
                  icon={<Stethoscope className="h-6 w-6" />}
                  title="No locum requests"
                  description="Locum requests appear here once a matron raises one for an understaffed ward."
                />
              ) : (
                <div className="py-16 text-center text-sm text-muted-foreground">
                  No locum requests found for the selected filters.
                </div>
              )
            ) : (
              <div className="bg-card border rounded-xl shadow-soft overflow-hidden">
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="text-left px-4 py-3 font-semibold">Date</th>
                      <th className="text-left px-4 py-3 font-semibold">Shift</th>
                      <th className="text-left px-4 py-3 font-semibold">Facility</th>
                      <th className="text-left px-4 py-3 font-semibold">Ward</th>
                      <th className="text-right px-4 py-3 font-semibold">Needed</th>
                      <th className="text-left px-4 py-3 font-semibold">Status</th>
                      <th className="text-left px-4 py-3 font-semibold">Requested By</th>
                      <th className="text-left px-4 py-3 font-semibold">Reviewed By</th>
                      <th className="text-left px-4 py-3 font-semibold">Accepted By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedLocumRequestsAll.map((r) => (
                      <tr key={r.id} className="border-t hover:bg-muted/30">
                        <td className="px-4 py-3 tabular-nums text-muted-foreground">
                          {fmtDate(r.shift_date)}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full font-semibold ${r.shift === "M" ? "bg-amber-100 text-amber-700" : "bg-indigo-100 text-indigo-700"}`}
                          >
                            {r.shift === "M" ? "Morning" : "Night"}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{r.facility}</td>
                        <td className="px-4 py-3 text-muted-foreground">{r.ward}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{r.nurses_needed}</td>
                        <td className="px-4 py-3">
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full font-semibold ${LOCUM_REQ_STATUS_COLOR[r.status]}`}
                          >
                            {LOCUM_REQ_STATUS_LABEL[r.status]}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{r.requested_by_name}</td>
                        <td className="px-4 py-3 text-muted-foreground">{r.reviewed_by_name ?? "—"}</td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {r.accepted_by_nurse_name ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
                <Pagination
                  page={locumReqPage}
                  totalPages={locumReqTotalPages}
                  pageSize={locumReqPageSize}
                  totalItems={filteredLocumRequestsAll.length}
                  onPage={setLocumReqPage}
                  onPageSize={(s) => {
                    setLocumReqPageSize(s);
                    setLocumReqPage(1);
                  }}
                />
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Leave & Requests ─────────────────────────────────────────────── */}
      {tab === "leave" &&
        (() => {
          // Use filteredLeaveOnly so pagination and stats respect the date filter
          const leaveOnly = filteredLeaveOnly;
          const switches = scopedLeave.filter((l: { type: string }) => l.type === "Swap");
          const pending = leaveOnly.filter((l: { status: string }) => l.status === "Pending");
          const approved = leaveOnly.filter((l: { status: string }) => l.status === "Approved");
          const rejected = leaveOnly.filter((l: { status: string }) => l.status === "Rejected");

          const byType: Record<string, number> = {};
          for (const l of leaveOnly) {
            byType[l.type] = (byType[l.type] ?? 0) + 1;
          }

          return (
            <>
              <div className="flex items-center gap-2 flex-wrap mb-4">
                <DateRangeFilter
                  value={leaveRange}
                  onChange={(v) => { setLeaveRange(v); setLeavePage(1); }}
                />
                <div className="ml-auto">
                  <button
                    type="button"
                    onClick={exportLeaveRequests}
                    className="inline-flex items-center gap-2 h-9 px-3 rounded-md border bg-card text-sm hover:bg-muted"
                  >
                    <FileSpreadsheet className="h-4 w-4 text-emerald-600" /> Export
                  </button>
                </div>
              </div>

              {/* Sub-tabs — mirrors the Leave Requests / Shift Switches split on the
                  main Leave & Requests page, so switches have somewhere to be seen in
                  full instead of just the 6-item preview card below. */}
              <div className="flex border-b mb-6">
                <button
                  type="button"
                  onClick={() => setLeaveSubTab("leave")}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    leaveSubTab === "leave"
                      ? "border-primary text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Leave Requests
                </button>
                <button
                  type="button"
                  onClick={() => setLeaveSubTab("switches")}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    leaveSubTab === "switches"
                      ? "border-primary text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Shift Switches
                  {switches.length > 0 && (
                    <span className="ml-1.5 inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-muted text-muted-foreground text-[10px] font-bold">
                      {switches.length}
                    </span>
                  )}
                </button>
              </div>

              {leaveSubTab === "leave" ? (
              <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6">
                <Stat icon={PlaneTakeoff} label="Total Leave Requests" value={leaveOnly.length} />
                <Stat icon={Clock} label="Pending" value={pending.length} />
                <Stat icon={CheckCircle2} label="Approved" value={approved.length} />
                <Stat icon={XCircle} label="Rejected" value={rejected.length} />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
                <div className="bg-card border rounded-xl p-5 shadow-soft">
                  <h2 className="font-semibold mb-4">Leave by Type</h2>
                  {Object.keys(byType).length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No leave requests
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {Object.entries(byType)
                        .sort((a, b) => b[1] - a[1])
                        .map(([type, count]) => (
                          <div key={type} className="flex items-center gap-3 text-sm">
                            <span className="w-36 truncate font-medium">{type}</span>
                            <div className="flex-1 h-4 rounded-full bg-muted overflow-hidden">
                              <Progress
                                value={Math.round((count / leaveOnly.length) * 100)}
                                className="h-full rounded-full bg-primary/70"
                              />
                            </div>
                            <span className="w-8 text-right tabular-nums text-muted-foreground text-xs">
                              {count}
                            </span>
                          </div>
                        ))}
                    </div>
                  )}
                </div>

                <div className="bg-card border rounded-xl p-5 shadow-soft">
                  <div className="flex items-center gap-2 mb-4">
                    <CalendarDays className="h-4 w-4 text-muted-foreground" />
                    <h2 className="font-semibold">Shift Switch Requests</h2>
                    <span className="ml-auto text-sm font-bold">{switches.length}</span>
                  </div>
                  {switches.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No switch requests
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {switches.slice(0, 6).map((s) => (
                        <div
                          key={s.id}
                          className="flex items-center justify-between text-sm border rounded-lg px-3 py-2"
                        >
                          <div>
                            <p className="font-medium">
                              {nurses.find((n) => n.id === s.nurse_id)?.name ?? "Unknown"}
                            </p>
                            <p className="text-xs text-muted-foreground">{fmtDate(s.from_date)}</p>
                          </div>
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                              s.status === "Approved"
                                ? "bg-emerald-100 text-emerald-700"
                                : s.status === "Rejected"
                                  ? "bg-rose-100 text-rose-700"
                                  : "bg-amber-100 text-amber-700"
                            }`}
                          >
                            {s.status}
                          </span>
                        </div>
                      ))}
                      {switches.length > 6 && (
                        <button
                          type="button"
                          onClick={() => setLeaveSubTab("switches")}
                          className="cursor-pointer flex items-center justify-center gap-1 w-full text-sm font-semibold text-primary hover:bg-primary/5 py-2 mt-1 rounded-md transition-colors"
                        >
                          View all ({switches.length - 6} more)
                          <ChevronRight className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="bg-card border rounded-xl shadow-soft overflow-hidden">
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="text-left px-4 py-3 font-semibold">Nurse</th>
                      <th className="text-left px-4 py-3 font-semibold">Type</th>
                      <th className="text-left px-4 py-3 font-semibold">Reason</th>
                      <th className="text-left px-4 py-3 font-semibold">From</th>
                      <th className="text-left px-4 py-3 font-semibold">To</th>
                      <th className="text-left px-4 py-3 font-semibold">Status</th>
                      <th className="text-left px-4 py-3 font-semibold">Rota Stage</th>
                      <th className="text-left px-4 py-3 font-semibold">Requested Date</th>
                      <th className="text-left px-4 py-3 font-semibold">Reviewed By</th>
                      <th className="text-left px-4 py-3 font-semibold">Reviewed On</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const nurseMap = new Map(nurses.map((n) => [n.id, n]));
                      const renderLeaveRow = (l: (typeof pagedLeaveOnly)[0]) => (
                        <tr key={l.id} className="border-t hover:bg-muted/30">
                          <td className="px-4 py-3 font-medium">
                            {(l.nurse_id ? nurseMap.get(l.nurse_id) : undefined)?.name ?? "Unknown"}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">{l.type}</td>
                          <td className="px-4 py-3 text-muted-foreground max-w-50">
                            {l.reason ? (
                              <span className="block truncate" title={l.reason}>
                                {l.reason}
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="px-4 py-3 tabular-nums text-muted-foreground">
                            {fmtDate(l.from_date)}
                          </td>
                          <td className="px-4 py-3 tabular-nums text-muted-foreground">
                            {fmtDate(l.to_date)}
                          </td>
                          <td className="px-4 py-3">
                            {/* A "Rejected" row with no reviewer was auto-declined by the
                                deadline cron, not actively rejected by a person — show that
                                distinctly rather than implying someone reviewed and declined it. */}
                            {l.status === "Rejected" && !l.reviewed_by_name ? (
                              <span className="text-xs px-2 py-0.5 rounded-full font-semibold bg-muted text-muted-foreground">
                                Time Elapsed
                              </span>
                            ) : (
                              <span
                                className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                                  l.status === "Approved"
                                    ? "bg-emerald-100 text-emerald-700"
                                    : l.status === "Rejected"
                                      ? "bg-rose-100 text-rose-700"
                                      : "bg-amber-100 text-amber-700"
                                }`}
                              >
                                {l.status}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {l.rota_stage_at_request === "published" ? (
                              <span className="text-xs px-2 py-0.5 rounded-full font-semibold bg-sky-100 text-sky-700">After publish</span>
                            ) : l.rota_stage_at_request === "draft" ? (
                              <span className="text-xs px-2 py-0.5 rounded-full font-semibold bg-amber-100 text-amber-700">Before submission</span>
                            ) : l.rota_stage_at_request === "no_rota" ? (
                              <span className="text-xs px-2 py-0.5 rounded-full font-semibold bg-muted text-muted-foreground">No rota yet</span>
                            ) : (
                              <span className="text-xs text-muted-foreground">–</span>
                            )}
                          </td>
                          <td className="px-4 py-3 tabular-nums text-muted-foreground">
                            {fmtDate(l.created_at)}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {l.reviewed_by_name ?? "—"}
                          </td>
                          <td className="px-4 py-3 tabular-nums text-muted-foreground">
                            {l.reviewed_at ? fmtDate(l.reviewed_at) : "—"}
                          </td>
                        </tr>
                      );

                      if (!reportFacility) {
                        // Group by facility for admin/cno/hr_admin (applied to current page slice)
                        const grouped = new Map<string, typeof pagedLeaveOnly>();
                        for (const l of pagedLeaveOnly) {
                          const f = (l.nurse_id ? nurseMap.get(l.nurse_id) : undefined)?.facility ?? "Unknown";
                          if (!grouped.has(f)) grouped.set(f, []);
                          grouped.get(f)!.push(l);
                        }
                        return [...grouped.entries()]
                          .sort(([a], [b]) => a.localeCompare(b))
                          .flatMap(([facility, fRows]) => [
                            <tr key={`hdr-${facility}`}>
                              <td
                                colSpan={10}
                                className="px-4 py-2 bg-muted/40 text-[10px] font-bold uppercase tracking-widest text-muted-foreground border-t"
                              >
                                {facility}
                              </td>
                            </tr>,
                            ...fRows.map(renderLeaveRow),
                          ]);
                      }

                      return pagedLeaveOnly.map(renderLeaveRow);
                    })()}
                  </tbody>
                </table>
                </div>
                <Pagination
                  page={leavePage}
                  totalPages={leaveTotalPages}
                  pageSize={leavePageSize}
                  totalItems={leaveOnly.length}
                  onPage={setLeavePage}
                  onPageSize={(s) => {
                    setLeavePageSize(s);
                    setLeavePage(1);
                  }}
                />
              </div>
              </>
              ) : (() => {
                const switchesFiltered = filteredSwitches;
                const switchPending = switchesFiltered.filter((s) => s.status === "Pending");
                const switchApproved = switchesFiltered.filter((s) => s.status === "Approved");
                const switchRejected = switchesFiltered.filter((s) => s.status === "Rejected");
                const nurseMap = new Map(nurses.map((n) => [n.id, n]));

                const renderSwitchRow = (s: (typeof pagedSwitches)[0]) => {
                  const sw = parseSwitchReason(s.reason);
                  return (
                    <tr key={s.id} className="border-t hover:bg-muted/30">
                      <td className="px-4 py-3 font-medium">
                        {(s.nurse_id ? nurseMap.get(s.nurse_id) : undefined)?.name ?? "Unknown"}
                      </td>
                      <td className="px-4 py-3 font-medium">{sw?.nurseBName ?? "—"}</td>
                      <td className="px-4 py-3 tabular-nums text-muted-foreground whitespace-nowrap">
                        {fmtDate(s.from_date)}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                        {sw ? (
                          <span className="inline-flex items-center gap-1">
                            {sw.interWard && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-100 text-purple-800 border border-purple-200">
                                Inter-Ward
                              </span>
                            )}
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200">
                              {sw.shiftA || "—"}
                            </span>
                            <ArrowLeftRight className="h-3 w-3" />
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-indigo-100 text-indigo-800 border border-indigo-200">
                              {sw.shiftB || "—"}
                            </span>
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground max-w-45">
                        {sw?.note ? (
                          <span className="block truncate" title={sw.note}>
                            {sw.note}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-muted-foreground whitespace-nowrap">
                        {fmtDate(s.created_at)}
                      </td>
                      <td className="px-4 py-3">
                        {s.status === "Rejected" && !s.reviewed_by_name ? (
                          <span className="text-xs px-2 py-0.5 rounded-full font-semibold bg-muted text-muted-foreground">
                            Time Elapsed
                          </span>
                        ) : (
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                              s.status === "Approved"
                                ? "bg-emerald-100 text-emerald-700"
                                : s.status === "Rejected"
                                  ? "bg-rose-100 text-rose-700"
                                  : "bg-amber-100 text-amber-700"
                            }`}
                          >
                            {s.status}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{s.reviewed_by_name ?? "—"}</td>
                      <td className="px-4 py-3 tabular-nums text-muted-foreground">
                        {s.reviewed_at ? fmtDate(s.reviewed_at) : "—"}
                      </td>
                    </tr>
                  );
                };

                return (
                  <>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6">
                      <Stat
                        icon={CalendarDays}
                        label="Total Shift Switches"
                        value={switchesFiltered.length}
                      />
                      <Stat icon={Clock} label="Pending" value={switchPending.length} />
                      <Stat icon={CheckCircle2} label="Approved" value={switchApproved.length} />
                      <Stat icon={XCircle} label="Rejected" value={switchRejected.length} />
                    </div>

                    <div className="bg-card border rounded-xl shadow-soft overflow-hidden">
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                            <tr>
                              <th className="text-left px-4 py-3 font-semibold">Nurse A</th>
                              <th className="text-left px-4 py-3 font-semibold">Nurse B</th>
                              <th className="text-left px-4 py-3 font-semibold">Date</th>
                              <th className="text-left px-4 py-3 font-semibold">Shifts</th>
                              <th className="text-left px-4 py-3 font-semibold">Reason / Note</th>
                              <th className="text-left px-4 py-3 font-semibold">Requested Date</th>
                              <th className="text-left px-4 py-3 font-semibold">Status</th>
                              <th className="text-left px-4 py-3 font-semibold">Reviewed By</th>
                              <th className="text-left px-4 py-3 font-semibold">Reviewed On</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pagedSwitches.length === 0 ? (
                              <tr>
                                <td
                                  colSpan={9}
                                  className="px-4 py-8 text-center text-sm text-muted-foreground"
                                >
                                  No switch requests match the current filter.
                                </td>
                              </tr>
                            ) : !reportFacility ? (
                              (() => {
                                const grouped = new Map<string, typeof pagedSwitches>();
                                for (const s of pagedSwitches) {
                                  const f =
                                    (s.nurse_id ? nurseMap.get(s.nurse_id) : undefined)?.facility ??
                                    "Unknown";
                                  if (!grouped.has(f)) grouped.set(f, []);
                                  grouped.get(f)!.push(s);
                                }
                                return [...grouped.entries()]
                                  .sort(([a], [b]) => a.localeCompare(b))
                                  .flatMap(([facility, fRows]) => [
                                    <tr key={`hdr-${facility}`}>
                                      <td
                                        colSpan={9}
                                        className="px-4 py-2 bg-muted/40 text-[10px] font-bold uppercase tracking-widest text-muted-foreground border-t"
                                      >
                                        {facility}
                                      </td>
                                    </tr>,
                                    ...fRows.map(renderSwitchRow),
                                  ]);
                              })()
                            ) : (
                              pagedSwitches.map(renderSwitchRow)
                            )}
                          </tbody>
                        </table>
                      </div>
                      <Pagination
                        page={switchPage}
                        totalPages={switchTotalPages}
                        pageSize={switchPageSize}
                        totalItems={switchesFiltered.length}
                        onPage={setSwitchPage}
                        onPageSize={(s) => {
                          setSwitchPageSize(s);
                          setSwitchPage(1);
                        }}
                      />
                    </div>
                  </>
                );
              })()}
            </>
          );
        })()}

      {/* ── Period Archive ────────────────────────────────────────────────── */}
      {tab === "periods" && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <DateRangeFilter value={periodsRange} onChange={setPeriodsRange} />
            <div className="ml-auto">
              <button
                type="button"
                onClick={exportPeriodArchive}
                className="inline-flex items-center gap-2 h-9 px-3 rounded-md border bg-card text-sm hover:bg-muted"
              >
                <FileSpreadsheet className="h-4 w-4 text-emerald-600" /> Export Archive
              </button>
            </div>
          </div>

          {filteredPeriodSummaries.length === 0 ? (
            scopedPeriodSummaries.length === 0 ? (
              <EmptyState
                icon={<Archive className="h-6 w-6" />}
                title="No archived periods"
                description="Periods close automatically at 8 am the day after the last published shift. Archived periods appear here."
              />
            ) : (
              <div className="py-16 text-center text-sm text-muted-foreground">
                No archived periods found for the selected date range.
              </div>
            )
          ) : (
            <div className="bg-card border rounded-xl shadow-soft overflow-hidden">
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="text-left px-4 py-3 font-semibold">Nurse</th>
                    <th className="text-left px-4 py-3 font-semibold">Period</th>
                    <th className="text-right px-4 py-3 font-semibold">Shifts</th>
                    <th className="text-right px-4 py-3 font-semibold">Total Hours</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPeriodSummaries.map((p) => {
                    const nurse = nurses.find((n) => n.id === p.nurse_id);
                    return (
                      <tr key={p.nurse_id + p.period_start} className="border-t hover:bg-muted/30">
                        <td className="px-4 py-3 font-medium">{nurse?.name ?? "—"}</td>
                        <td className="px-4 py-3 text-muted-foreground tabular-nums">
                          {fmtDate(p.period_start)} → {fmtDate(p.period_end)}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">{p.total_shifts}</td>
                        <td className="px-4 py-3 text-right tabular-nums font-semibold">
                          {fmtHoursLog(Number(p.total_hours))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Missed Shifts ────────────────────────────────────────────────── */}
      {tab === "missed" && (() => {
        const nurseMap = new Map(nurses.map((n) => [n.id, n]));
        const fmtDate = (d: string) =>
          new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
        return (
          <div className="space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
              <DateRangeFilter
                value={missedRange}
                onChange={(v) => { setMissedRange(v); setMissedPage(1); }}
              />
              {filteredMissedLogs.length > 0 && (
                <button
                  type="button"
                  onClick={exportMissedShifts}
                  className="inline-flex items-center gap-2 h-9 px-3 rounded-md border bg-card text-sm hover:bg-muted ml-auto"
                >
                  <Download className="h-4 w-4" /> Export Excel
                </button>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              Shifts where no clock-in was recorded.{" "}
              <span className="font-medium text-foreground">{filteredMissedLogs.length}</span> missed{" "}
              {reportFacility ? `in ${reportFacility}` : "across all facilities"}
              {(missedRange.from || missedRange.to) && (
                <span>
                  {" "}(filtered
                  {missedRange.from ? ` from ${fmtDate(missedRange.from)}` : ""}
                  {missedRange.to ? ` to ${fmtDate(missedRange.to)}` : ""})
                </span>
              )}.
            </p>
            {filteredMissedLogs.length === 0 ? (
              <div className="py-16 text-center text-sm text-muted-foreground">
                {scopedMissedLogs.length === 0
                  ? "No missed shifts recorded."
                  : "No missed shifts found for the selected date range."}
              </div>
            ) : (
              <div className="bg-card border rounded-xl shadow-soft overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        <th className="px-4 py-3 text-left">Date</th>
                        <th className="px-4 py-3 text-left">Nurse</th>
                        <th className="px-4 py-3 text-left hidden sm:table-cell">Facility</th>
                        <th className="px-4 py-3 text-left hidden md:table-cell">Ward</th>
                        <th className="px-4 py-3 text-left">Shift</th>
                        <th className="px-4 py-3 text-left">Type</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {pagedMissedLogs.map((l, i) => {
                        const nurse = nurseMap.get(l.nurse_id);
                        return (
                          <tr key={i} className="hover:bg-muted/30">
                            <td className="px-4 py-3 font-medium">{fmtDate(l.shift_date)}</td>
                            <td className="px-4 py-3">{nurse?.name ?? "Unknown"}</td>
                            <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">
                              {nurse?.facility ?? "—"}
                            </td>
                            <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">
                              {nurse?.ward?.split("|")[0] ?? "—"}
                            </td>
                            <td className="px-4 py-3">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                                l.shift_type === "M"
                                  ? "bg-amber-100 text-amber-800"
                                  : "bg-indigo-100 text-indigo-800"
                              }`}>
                                {l.shift_type === "M" ? "Morning" : l.shift_type === "N" ? "Night" : l.shift_type}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              {l.is_locum ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-black text-white">
                                  Locum
                                </span>
                              ) : (
                                <span className="text-xs text-muted-foreground">Roster</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <Pagination
                  page={missedPage}
                  totalPages={missedTotalPages}
                  pageSize={missedPageSize}
                  totalItems={filteredMissedLogs.length}
                  onPage={setMissedPage}
                  onPageSize={(s) => { setMissedPageSize(s); setMissedPage(1); }}
                />
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Staff Directory ───────────────────────────────────────────────── */}
      {tab === "staff-dir" && (
        <div className="space-y-5">
          {/* Facility selector — hidden when role is locked to a single facility */}
          <div className="flex items-center gap-2 flex-wrap">
            <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
            {reportFacility ? (
              <span className="px-4 py-1.5 rounded-full text-sm font-medium border bg-primary text-primary-foreground border-primary">
                {reportFacility}
              </span>
            ) : (
              FACILITIES.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setDirFacility(f)}
                  className={`px-4 py-1.5 rounded-full text-sm font-medium border transition ${
                    effectiveDirFacility === f
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-card hover:bg-muted border-border"
                  }`}
                >
                  {f}
                </button>
              ))
            )}
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => exportStaffListExcel()}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border bg-card text-xs hover:bg-muted"
              >
                <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-600" /> Excel
              </button>
              <button
                type="button"
                onClick={() => printStaffList()}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border bg-card text-xs hover:bg-muted"
              >
                <Printer className="h-3.5 w-3.5" /> Print All
              </button>
            </div>
          </div>

          {facilityNurses.length === 0 ? (
            <EmptyState
              icon={<Users className="h-6 w-6" />}
              title={`No staff in ${effectiveDirFacility}`}
              description="Assign nurses to this facility from the Staff page."
            />
          ) : (
            <div className="space-y-4">
              {nursesByWard.map(([ward, wardNurses]) => (
                <div key={ward} className="bg-card border rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b bg-muted/30 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <List className="h-4 w-4 text-muted-foreground" />
                      <h3 className="text-sm font-semibold">{ward}</h3>
                      <span className="text-xs text-muted-foreground">
                        · {wardNurses.length} staff
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => exportStaffListExcel(ward)}
                        className="inline-flex items-center gap-1 h-7 px-2 rounded border bg-card text-xs hover:bg-muted"
                      >
                        <FileSpreadsheet className="h-3 w-3 text-emerald-600" /> Excel
                      </button>
                      <button
                        type="button"
                        onClick={() => printStaffList(ward)}
                        className="inline-flex items-center gap-1 h-7 px-2 rounded border bg-card text-xs hover:bg-muted"
                      >
                        <Printer className="h-3 w-3" /> Print
                      </button>
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/20 text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="text-left px-4 py-2.5 font-medium w-10">#</th>
                        <th className="text-left px-4 py-2.5 font-medium">Name</th>
                        <th className="text-left px-4 py-2.5 font-medium">Role</th>
                        <th className="text-left px-4 py-2.5 font-medium">Ward(s)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {wardNurses
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((n, i) => (
                          <tr key={n.id} className="border-t hover:bg-muted/20">
                            <td className="px-4 py-2.5 text-muted-foreground tabular-nums">
                              {i + 1}
                            </td>
                            <td className="px-4 py-2.5 font-medium">{n.name}</td>
                            <td className="px-4 py-2.5 text-muted-foreground">{n.role}</td>
                            <td className="px-4 py-2.5 text-muted-foreground">{n.ward ?? "—"}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Schedule Archive ──────────────────────────────────────────────── */}
      {tab === "schedules" && (
        <div className="space-y-5">
          {/* Facility filter — locked pill for facility-scoped roles */}
          <div className="flex items-center gap-2 flex-wrap">
            <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
            {reportFacility ? (
              <span className="px-4 py-1.5 rounded-full text-sm font-medium border bg-primary text-primary-foreground border-primary">
                {reportFacility}
              </span>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setArchiveFacility("")}
                  className={`px-4 py-1.5 rounded-full text-sm font-medium border transition ${
                    archiveFacility === ""
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-card hover:bg-muted border-border"
                  }`}
                >
                  All Facilities
                </button>
                {FACILITIES.map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setArchiveFacility(f)}
                    className={`px-4 py-1.5 rounded-full text-sm font-medium border transition ${
                      archiveFacility === f
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-card hover:bg-muted border-border"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </>
            )}
          </div>

          {archiveLoading ? (
            <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>
          ) : archiveByPeriod.length === 0 ? (
            <EmptyState
              icon={<CalendarRange className="h-6 w-6" />}
              title="No published schedules"
              description="Published rotas appear here for reference and download."
            />
          ) : (
            <div className="space-y-8">
              {archiveByPeriod.map(([periodStart, periodWins]) => {
                const periodEnd = scheduleEndDate(periodStart);
                const wardNames = periodWins.filter((w) => w.ward !== null).map((w) => w.ward!);
                const allPeriodRoles = [
                  ...new Set(
                    periodWins.flatMap(
                      (w) =>
                        archiveWindowRoles.get(
                          `${w.startDate}|${w.facility ?? ""}|${w.ward ?? w.roleGroup ?? ""}`,
                        ) ?? [],
                    ),
                  ),
                ].sort();
                return (
                  <div key={periodStart}>
                    {/* Period header */}
                    <div className="flex items-center gap-2 mb-3">
                      <CalendarRange className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="min-w-0 flex-1">
                        <h2 className="text-sm font-semibold">
                          {fmtDate(periodStart)} — {fmtDate(periodEnd)}
                        </h2>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {wardNames.length > 0 && (
                            <>
                              {wardNames.join(", ")}
                              {allPeriodRoles.length > 0 ? " · " : ""}
                            </>
                          )}
                          {allPeriodRoles.join(", ")}
                        </p>
                      </div>
                      {canPrintSchedule && (
                        <button
                          type="button"
                          disabled={!!archiveDownloading?.startsWith(`unified-${periodStart}`)}
                          onClick={() => downloadUnifiedPdf(periodStart, periodWins)}
                          className="shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border bg-card text-xs font-medium hover:bg-muted disabled:opacity-50"
                          title="Download a single PDF with all wards for this period"
                        >
                          <Printer className="h-3.5 w-3.5" />
                          Print All
                        </button>
                      )}
                      <div className="h-px bg-border w-6 shrink-0" />
                    </div>

                    {/* Ward cards */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                      {periodWins.map((win) => {
                        const key = `${win.startDate}|${win.facility ?? ""}|${win.ward ?? win.roleGroup ?? ""}`;
                        const isDownloading = archiveDownloading?.startsWith(key);
                        const winRoles = archiveWindowRoles.get(key) ?? [];
                        return (
                          <div
                            key={key}
                            className="bg-card border rounded-xl p-4 flex flex-col gap-3"
                          >
                            <div>
                              <p className="text-sm font-semibold">
                                {win.ward ?? (win.roleGroup ? FW_LABELS[win.roleGroup] : "Facility-Wide Staff")}
                              </p>
                              {win.facility && (
                                <p className="text-xs font-medium text-primary/80 mt-0.5">
                                  {win.facility}
                                </p>
                              )}
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {win.nurseCount} nurses · {win.assignmentCount} assignments
                              </p>
                              {winRoles.length > 0 && (
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  {winRoles.join(", ")}
                                </p>
                              )}
                            </div>
                            <div className="flex gap-2 mt-auto">
                              <button
                                type="button"
                                disabled={!!isDownloading}
                                onClick={() => downloadScheduleExcel(win)}
                                className="flex-1 inline-flex items-center justify-center gap-1.5 h-8 rounded-md border bg-card text-xs hover:bg-muted disabled:opacity-50"
                              >
                                <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-600" />
                                {archiveDownloading === `${key}-xlsx` ? "…" : "Excel"}
                              </button>
                              <button
                                type="button"
                                disabled={!!isDownloading}
                                onClick={() => downloadSchedulePdf(win)}
                                className="flex-1 inline-flex items-center justify-center gap-1.5 h-8 rounded-md border bg-card text-xs hover:bg-muted disabled:opacity-50"
                              >
                                <FileDown className="h-3.5 w-3.5 text-red-500" />
                                {archiveDownloading === `${key}-pdf` ? "…" : "PDF"}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
}) {
  return (
    <div className="bg-card border rounded-xl p-5 shadow-soft">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
            {label}
          </p>
          <p className="text-3xl font-bold mt-2">{value}</p>
        </div>
        <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary grid place-items-center shrink-0">
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </div>
  );
}
