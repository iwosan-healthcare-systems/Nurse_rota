import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useState, useMemo } from "react";
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
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { useAuth } from "@/lib/auth-context";

export const Route = createFileRoute("/_app/reports")({
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
  type: "Sick" | "Annual" | "Emergency" | "Public Holiday" | "Swap";
  reason: string | null;
};
type ArchiveAssignment = {
  nurse_id: string;
  shift_date: string;
  ward: string | null;
  shift: string;
};
type ArchiveWindow = {
  startDate: string;
  endDate: string;
  ward: string | null;
  facility: string | null;
  nurseCount: number;
  assignmentCount: number;
};

// ── Date helpers ─────────────────────────────────────────────────────────────

function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
): ArchiveWindow[] {
  if (!rows.length) return [];
  const byKey = new Map<string, ArchiveAssignment[]>();
  for (const row of rows) {
    const fac = nurseToFacility.get(row.nurse_id) ?? null;
    const key = `${fac ?? "__NONE__"}||${row.ward ?? "__NONE__"}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(row);
  }
  const windows: ArchiveWindow[] = [];
  for (const [key, keyRows] of byKey) {
    const [facPart, wardPart] = key.split("||");
    const facility = facPart === "__NONE__" ? null : facPart;
    const ward = wardPart === "__NONE__" ? null : wardPart;
    const sorted = [...keyRows].sort((a, b) => a.shift_date.localeCompare(b.shift_date));
    let cluster: ArchiveAssignment[] = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const prev = cluster[cluster.length - 1];
      const diff = Math.round(
        (new Date(sorted[i].shift_date).getTime() - new Date(prev.shift_date).getTime()) / 86400000,
      );
      if (diff > 14) {
        windows.push(makeArchiveWindow(cluster, ward, facility));
        cluster = [];
      }
      cluster.push(sorted[i]);
    }
    if (cluster.length) windows.push(makeArchiveWindow(cluster, ward, facility));
  }
  return windows.sort(
    (a, b) =>
      b.startDate.localeCompare(a.startDate) ||
      (a.facility ?? "").localeCompare(b.facility ?? "") ||
      (a.ward ?? "").localeCompare(b.ward ?? ""),
  );
}

function makeArchiveWindow(
  rows: ArchiveAssignment[],
  ward: string | null,
  facility: string | null,
): ArchiveWindow {
  const dates = rows.map((r) => r.shift_date).sort();
  return {
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    ward,
    facility,
    nurseCount: new Set(rows.map((r) => r.nurse_id)).size,
    assignmentCount: rows.length,
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
  const reportFacility: string | null =
    isAdmin || activeRole === "cno" || activeRole === "hr_admin" ? null : (nurseFacility ?? null);

  const [tab, setTab] = useState<
    "overview" | "hours" | "locum" | "periods" | "leave" | "staff-dir" | "schedules"
  >("overview");
  const [closingPeriod, setClosingPeriod] = useState(false);
  const [dirFacility, setDirFacility] = useState<string>(reportFacility ?? FACILITIES[0]);
  const [archiveFacility, setArchiveFacility] = useState<string>(reportFacility ?? "");
  const [archiveDownloading, setArchiveDownloading] = useState<string | null>(null);

  const { data: nurses = [] } = useQuery<Nurse[]>({
    queryKey: ["nurses"],
    staleTime: 10 * 60 * 1000,
    queryFn: () => api.get<Nurse[]>("/nurses"),
  });
  const { data: wards = [] } = useQuery({
    queryKey: ["wards"],
    staleTime: 30 * 60 * 1000,
    queryFn: () => api.get<{ id: string; name: string; facility: string | null }[]>("/wards"),
  });
  const { data: leave = [] } = useQuery({
    queryKey: ["leave"],
    staleTime: 5 * 60 * 1000,
    queryFn: () => api.get<LeaveRequest[]>("/leave-requests"),
  });

  // Current period regular shift logs (last 28 days) — locum excluded
  const { data: shiftLogs = [] } = useQuery<ShiftLog[]>({
    queryKey: ["shift-logs-current"],
    staleTime: 2 * 60 * 1000,
    queryFn: () => {
      const lookback = new Date();
      lookback.setDate(lookback.getDate() - 27);
      const lb = `${lookback.getFullYear()}-${String(lookback.getMonth() + 1).padStart(2, "0")}-${String(lookback.getDate()).padStart(2, "0")}`;
      return api.get<ShiftLog[]>(`/shift-logs?is_locum=false&from=${lb}`);
    },
  });

  // Locum shift logs — separate from regular hours
  const { data: locumShiftLogs = [] } = useQuery<ShiftLog[]>({
    queryKey: ["locum-shift-logs-report"],
    staleTime: 2 * 60 * 1000,
    queryFn: () => api.get<ShiftLog[]>("/shift-logs?is_locum=true"),
  });

  // Filled locum requests — provides ward / facility context for each locum log
  const { data: locumFilledRequests = [] } = useQuery<LocumFilledRequest[]>({
    queryKey: ["locum-filled-report"],
    staleTime: 2 * 60 * 1000,
    queryFn: () => api.get<LocumFilledRequest[]>("/locum/requests?status=filled"),
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

  // Build per-nurse hours for current period (regular + swap + leave; locum excluded).
  // swapHoursMap and leaveHoursMap allow breakdown display without excluding from total.
  const { nurseHoursMap, nurseShiftCountMap, swapHoursMap, leaveHoursMap } = useMemo(() => {
    const hours = new Map<string, number>();
    const shifts = new Map<string, number>();
    const swap = new Map<string, number>();
    const leave = new Map<string, number>();
    for (const log of shiftLogs.filter((l) => scopedNurseIds.has(l.nurse_id))) {
      if (log.hours_logged != null) {
        hours.set(log.nurse_id, (hours.get(log.nurse_id) ?? 0) + log.hours_logged);
        shifts.set(log.nurse_id, (shifts.get(log.nurse_id) ?? 0) + 1);
        if (log.is_swap) swap.set(log.nurse_id, (swap.get(log.nurse_id) ?? 0) + log.hours_logged);
        if (log.is_leave)
          leave.set(log.nurse_id, (leave.get(log.nurse_id) ?? 0) + log.hours_logged);
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
    for (const log of locumShiftLogs) m.set(`${log.nurse_id}|${log.shift_date}`, log);
    return m;
  }, [locumShiftLogs]);

  const { locumHoursMap, locumShiftCountMap } = useMemo(() => {
    const hours = new Map<string, number>();
    const shifts = new Map<string, number>();
    for (const log of locumShiftLogs.filter((l) => scopedNurseIds.has(l.nurse_id))) {
      if (log.hours_logged != null) {
        hours.set(log.nurse_id, (hours.get(log.nurse_id) ?? 0) + log.hours_logged);
      }
      shifts.set(log.nurse_id, (shifts.get(log.nurse_id) ?? 0) + 1);
    }
    return { locumHoursMap: hours, locumShiftCountMap: shifts };
  }, [locumShiftLogs, scopedNurseIds]);

  const totalLocumHours = useMemo(
    () => [...locumHoursMap.values()].reduce((s, h) => s + h, 0),
    [locumHoursMap],
  );

  // Staff directory: nurses by selected facility, grouped by ward
  const facilityNurses = useMemo(
    () => scopedNurses.filter((n) => n.facility === dirFacility),
    [scopedNurses, dirFacility],
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

  // nurse_id → facility lookup for archive grouping
  const archiveNurseToFacility = useMemo(
    () => new Map(nurses.map((n) => [n.id, n.facility])),
    [nurses],
  );

  // Archive: group published assignments into facility+ward windows
  const allArchiveWindows = useMemo(
    () => groupArchiveWindows(archiveAssignments, archiveNurseToFacility),
    [archiveAssignments, archiveNurseToFacility],
  );

  // Filter archive windows by selected facility tab
  const archiveWindows = useMemo(
    () =>
      archiveFacility
        ? allArchiveWindows.filter((w) => w.facility === archiveFacility)
        : allArchiveWindows,
    [allArchiveWindows, archiveFacility],
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

  // Precompute roles per archive window key (startDate|facility|ward)
  const archiveWindowRoles = useMemo(() => {
    const nurseRoleMap = new Map(nurses.map((n) => [n.id, n.role]));
    const facilityNurseIds = new Map(nurses.map((n) => [n.id, n.facility]));
    const result = new Map<string, string[]>();
    for (const win of allArchiveWindows) {
      const key = `${win.startDate}|${win.facility ?? ""}|${win.ward ?? ""}`;
      const nurseIds = new Set(
        archiveAssignments
          .filter(
            (a) =>
              a.shift_date >= win.startDate &&
              a.shift_date <= win.endDate &&
              a.ward === win.ward &&
              facilityNurseIds.get(a.nurse_id) === win.facility,
          )
          .map((a) => a.nurse_id),
      );
      const roles = [
        ...new Set([...nurseIds].map((id) => nurseRoleMap.get(id)).filter(Boolean) as string[]),
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
  function exportCurrentHours() {
    if (activeNurses.length === 0) return toast.error("No hours logged yet");
    const rows = nurses.map((n) => ({
      Name: n.name,
      Role: n.role,
      Ward: n.ward ?? "",
      Facility: n.facility ?? "",
      "Shifts Completed": nurseShiftCountMap.get(n.id) ?? 0,
      "Hours Logged": (nurseHoursMap.get(n.id) ?? 0).toFixed(2),
      "Target Hours": n.target_hours,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Current Period");
    XLSX.writeFile(wb, `shift-hours-${todayYmd()}.xlsx`);
    toast.success("Exported");
  }

  function exportDetailedLogs() {
    if (shiftLogs.length === 0) return toast.error("No shift logs to export");
    const nurseMap = new Map(nurses.map((n) => [n.id, n]));
    const rows = shiftLogs.map((l) => {
      const nurse = nurseMap.get(l.nurse_id);
      return {
        Name: nurse?.name ?? "Unknown",
        Role: nurse?.role ?? "",
        Ward: nurse?.ward ?? "",
        Date: l.shift_date,
        "Shift Type": l.shift_type === "M" ? "Morning" : "Night",
        "Started At": l.started_at ? new Date(l.started_at).toLocaleString("en-GB") : "",
        "Ended At": l.ended_at ? new Date(l.ended_at).toLocaleString("en-GB") : "In Progress",
        "Hours Logged": l.hours_logged != null ? Number(l.hours_logged).toFixed(2) : "",
        Late: l.is_late ? "Yes" : "No",
        "Late (mins)": l.late_minutes ?? "",
        "Late Reason": l.late_reason ?? "",
        "Period Start": l.period_start,
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Shift Logs");
    XLSX.writeFile(wb, `shift-logs-${todayYmd()}.xlsx`);
    toast.success("Exported");
  }

  function exportPeriodArchive() {
    if (periodSummaries.length === 0) return toast.error("No archived periods yet");
    const nurseMap = new Map(nurses.map((n) => [n.id, n]));
    const rows = periodSummaries.map((p) => {
      const nurse = nurseMap.get(p.nurse_id);
      return {
        Name: nurse?.name ?? "Unknown",
        Role: nurse?.role ?? "",
        Ward: nurse?.ward ?? "",
        Facility: nurse?.facility ?? "",
        "Period Start": p.period_start,
        "Period End": p.period_end,
        "Total Hours": Number(p.total_hours).toFixed(2),
        "Total Shifts": p.total_shifts,
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Period Archive");
    XLSX.writeFile(wb, `period-archive-${todayYmd()}.xlsx`);
    toast.success("Exported");
  }

  function exportLocumReport() {
    if (scopedLocumRequests.length === 0) return toast.error("No locum shifts to export");
    const rows = scopedLocumRequests.map((r) => {
      const log = r.accepted_by_nurse_id
        ? locumLogMap.get(`${r.accepted_by_nurse_id}|${r.shift_date}`)
        : undefined;
      return {
        Date: r.shift_date,
        Nurse: r.accepted_by_nurse_name ?? "Unknown",
        Ward: r.ward,
        Facility: r.facility,
        "Shift Type": r.shift === "M" ? "Morning" : "Night",
        "Started At": log?.started_at ? new Date(log.started_at).toLocaleString("en-GB") : "",
        "Ended At": log?.ended_at
          ? new Date(log.ended_at).toLocaleString("en-GB")
          : log
            ? "In Progress"
            : "Not Started",
        "Hours Logged": log?.hours_logged != null ? Number(log.hours_logged).toFixed(2) : "",
        Late: log?.is_late ? "Yes" : "No",
        "Late (mins)": log?.late_minutes ?? "",
        "Late Reason": log?.late_reason ?? "",
        "Accepted At": r.accepted_at ? new Date(r.accepted_at).toLocaleString("en-GB") : "",
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [
      { wch: 12 },
      { wch: 26 },
      { wch: 14 },
      { wch: 10 },
      { wch: 10 },
      { wch: 20 },
      { wch: 20 },
      { wch: 12 },
      { wch: 20 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Locum Hours");
    XLSX.writeFile(wb, `locum-hours-${todayYmd()}.xlsx`);
    toast.success("Exported");
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
<title>Staff Directory — ${dirFacility}${wardLabel}</title>
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
<h1>Staff Directory — ${dirFacility}${wardLabel}</h1>
<p>Generated: ${today} &nbsp;·&nbsp; ${staffToPrint.length} staff</p>
<table>
<thead><tr><th>#</th><th>Name</th><th>Role</th><th>Ward</th></tr></thead>
<tbody>
${staffToPrint
  .sort((a, b) => a.name.localeCompare(b.name))
  .map(
    (n, i) =>
      `<tr><td>${i + 1}</td><td>${n.name}</td><td>${n.role}</td><td>${n.ward?.split("|")[0] ?? "—"}</td></tr>`,
  )
  .join("")}
</tbody>
</table>
<script>window.onload=()=>{window.print()}</script>
</body></html>`;
    openPrintWindow(html);
  }

  function exportStaffListExcel(ward?: string) {
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
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 4 }, { wch: 28 }, { wch: 22 }, { wch: 18 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Staff");
    const slug = ward ? `-${ward.replace(/\s+/g, "-").toLowerCase()}` : "";
    XLSX.writeFile(wb, `staff-${dirFacility.toLowerCase()}${slug}-${todayYmd()}.xlsx`);
    toast.success("Exported");
  }

  // ── Schedule archive download ─────────────────────────────────────────────
  async function fetchScheduleData(win: ArchiveWindow) {
    const facilityNurseIds = win.facility
      ? nurses.filter((n) => n.facility === win.facility).map((n) => n.id)
      : nurses.map((n) => n.id);

    const wardParam =
      win.ward !== null ? `&ward=${encodeURIComponent(win.ward)}` : "&ward_null=true";
    const allAssignments = facilityNurseIds.length
      ? await api.get<{ nurse_id: string; shift_date: string; shift: string }[]>(
          `/shift-assignments?nurse_ids=${facilityNurseIds.join(",")}&from=${win.startDate}&to=${win.endDate}&status=published${wardParam}`,
        )
      : [];

    const assignMap = new Map(
      allAssignments.map((a) => [`${a.nurse_id}|${a.shift_date}`, a.shift]),
    );
    const activeIds = new Set(allAssignments.map((a) => a.nurse_id));
    const activeNurses = nurses.filter((n) => activeIds.has(n.id));
    return { activeNurses, assignMap };
  }

  async function downloadSchedulePdf(win: ArchiveWindow) {
    const key = `${win.startDate}|${win.facility ?? ""}|${win.ward ?? ""}`;
    setArchiveDownloading(key + "-pdf");
    try {
      const { activeNurses, assignMap } = await fetchScheduleData(win);
      const dates = dateRange(win.startDate, win.endDate);
      const wardLabel = win.ward ? ` — ${win.ward}` : " — Matron / Coverage / Interns / Porter-Day / NA-Day";
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
          return `<tr><td class="nm">${n.name}</td><td class="sm">${n.role}</td><td class="sm">${n.ward ? n.ward.split("|")[0] : "—"}</td>${cells}</tr>`;
        })
        .join("");
      const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>Nurse Rota ${win.startDate} — ${win.endDate}${facilityLabel}${wardLabel}</title>
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
    const key = `${win.startDate}|${win.facility ?? ""}|${win.ward ?? ""}`;
    setArchiveDownloading(key + "-xlsx");
    try {
      const { activeNurses, assignMap } = await fetchScheduleData(win);
      const dates = dateRange(win.startDate, win.endDate);
      const wardLabel = win.ward ? ` — ${win.ward}` : " — Matron / Coverage / Interns / Porter-Day / NA-Day";
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
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([[title], [], headers, ...rowData]);
      ws["!cols"] = [{ wch: 22 }, { wch: 18 }, { wch: 14 }, ...dates.map(() => ({ wch: 5 }))];
      XLSX.utils.book_append_sheet(wb, ws, "Rota");
      const slug = win.ward ? `-${win.ward.replace(/\s+/g, "-").toLowerCase()}` : "-coverage";
      XLSX.writeFile(wb, `rota-archive-${win.startDate}-to-${win.endDate}${slug}.xlsx`);
    } catch {
      toast.error("Failed to generate Excel file");
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
        <button type="button" className={tabCls("periods")} onClick={() => setTab("periods")}>
          Period Archive
        </button>
        <button type="button" className={tabCls("leave")} onClick={() => setTab("leave")}>
          Leave & Requests
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
          <div className="bg-card border rounded-xl p-5 shadow-soft">
            <h2 className="font-semibold mb-4">Staff Hours — Current Period</h2>
            {activeNurses.length === 0 ? (
              <EmptyState
                icon={<Clock className="h-6 w-6" />}
                title="No hours logged yet"
                description="Hours appear here as nurses start and complete their shifts."
              />
            ) : (
              <div className="space-y-2">
                {nurses
                  .filter((n) => nurseHoursMap.has(n.id))
                  .map((n) => {
                    const hrs = nurseHoursMap.get(n.id) ?? 0;
                    const swapH = swapHoursMap.get(n.id) ?? 0;
                    const leaveH = leaveHoursMap.get(n.id) ?? 0;
                    const pct = Math.round((hrs / Math.max(n.target_hours, 1)) * 100);
                    return (
                      <div key={n.id} className="space-y-0.5">
                        <div className="flex items-center gap-3 text-sm">
                          <div className="w-36 truncate font-medium">{n.name}</div>
                          <div className="flex-1 h-5 rounded-full bg-muted overflow-hidden">
                            <Progress
                              value={Math.min(pct, 100)}
                              className="h-full rounded-full bg-primary/70"
                            />
                          </div>
                          <div className="w-20 text-right tabular-nums text-muted-foreground text-xs">
                            {hrs.toFixed(1)} / {n.target_hours} h
                          </div>
                        </div>
                        {(swapH > 0 || leaveH > 0) && (
                          <div className="pl-39 flex gap-2">
                            {swapH > 0 && (
                              <span className="text-[10px] font-semibold text-sky-700 bg-sky-50 border border-sky-200 px-1.5 py-0.5 rounded-full">
                                {swapH.toFixed(1)}h swap
                              </span>
                            )}
                            {leaveH > 0 && (
                              <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-full">
                                {leaveH.toFixed(1)}h leave
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Shift Hours ──────────────────────────────────────────────────── */}
      {tab === "hours" && (
        <div className="space-y-4">
          <div className="flex justify-end gap-2">
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

          {shiftLogs.length === 0 ? (
            <EmptyState
              icon={<Clock className="h-6 w-6" />}
              title="No shift logs"
              description="Shift logs appear here once nurses start tracking their shifts."
            />
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
                  {shiftLogs.map((log) => {
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
                              Swap
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
            </div>
          )}
        </div>
      )}

      {/* ── Locum Hours ──────────────────────────────────────────────────── */}
      {tab === "locum" && (
        <div className="space-y-4">
          {/* Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
            <Stat icon={Stethoscope} label="Shifts Filled" value={scopedLocumRequests.length} />
            <Stat icon={Clock} label="Total Hours" value={totalLocumHours.toFixed(1)} />
            <Stat
              icon={Users}
              label="Nurses Used"
              value={new Set(scopedLocumRequests.map((r) => r.accepted_by_nurse_id)).size}
            />
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={exportLocumReport}
              className="inline-flex items-center gap-2 h-9 px-3 rounded-md border bg-card text-sm hover:bg-muted"
            >
              <FileSpreadsheet className="h-4 w-4 text-emerald-600" /> Export Locum Report
            </button>
          </div>

          {scopedLocumRequests.length === 0 ? (
            <EmptyState
              icon={<Stethoscope className="h-6 w-6" />}
              title="No locum shifts filled yet"
              description="Hours appear here once nurses accept locum invitations and complete their shifts."
            />
          ) : (
            <>
              {/* Per-nurse summary */}
              <div className="bg-card border rounded-xl p-5 shadow-soft">
                <h2 className="font-semibold mb-4">Per-Nurse Summary</h2>
                <div className="space-y-2">
                  {[...locumHoursMap.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([nurseId, hrs]) => {
                      const name =
                        scopedLocumRequests.find((r) => r.accepted_by_nurse_id === nurseId)
                          ?.accepted_by_nurse_name ?? "Unknown";
                      const shifts = locumShiftCountMap.get(nurseId) ?? 0;
                      return (
                        <div key={nurseId} className="flex items-center gap-3 text-sm">
                          <div className="w-40 truncate font-medium">{name}</div>
                          <div className="flex-1 h-5 rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full rounded-full bg-violet-400"
                              style={{
                                width: `${Math.min(Math.round((hrs / Math.max(totalLocumHours, 1)) * 100), 100)}%`,
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
                    </tr>
                  </thead>
                  <tbody>
                    {scopedLocumRequests.map((r) => {
                      const log = r.accepted_by_nurse_id
                        ? locumLogMap.get(`${r.accepted_by_nurse_id}|${r.shift_date}`)
                        : undefined;
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
                            {log?.started_at
                              ? new Date(log.started_at).toLocaleTimeString("en-GB", {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })
                              : "—"}
                          </td>
                          <td className="px-4 py-3 tabular-nums text-muted-foreground">
                            {log?.ended_at ? (
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
                            {log?.hours_logged != null
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
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Leave & Requests ─────────────────────────────────────────────── */}
      {tab === "leave" &&
        (() => {
          const leaveOnly = leave.filter((l: { type: string }) => l.type !== "Swap");
          const switches = leave.filter((l: { type: string }) => l.type === "Swap");
          const pending = leaveOnly.filter((l: { status: string }) => l.status === "Pending");
          const approved = leaveOnly.filter((l: { status: string }) => l.status === "Approved");
          const rejected = leaveOnly.filter((l: { status: string }) => l.status === "Rejected");

          const byType: Record<string, number> = {};
          for (const l of leaveOnly) {
            byType[l.type] = (byType[l.type] ?? 0) + 1;
          }

          return (
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
                      <th className="text-left px-4 py-3 font-semibold">From</th>
                      <th className="text-left px-4 py-3 font-semibold">To</th>
                      <th className="text-left px-4 py-3 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leaveOnly.map((l) => (
                      <tr key={l.id} className="border-t hover:bg-muted/30">
                        <td className="px-4 py-3 font-medium">
                          {nurses.find((n) => n.id === l.nurse_id)?.name ?? "Unknown"}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{l.type}</td>
                        <td className="px-4 py-3 tabular-nums text-muted-foreground">
                          {fmtDate(l.from_date)}
                        </td>
                        <td className="px-4 py-3 tabular-nums text-muted-foreground">
                          {fmtDate(l.to_date)}
                        </td>
                        <td className="px-4 py-3">
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
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            </>
          );
        })()}

      {/* ── Period Archive ────────────────────────────────────────────────── */}
      {tab === "periods" && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={exportPeriodArchive}
              className="inline-flex items-center gap-2 h-9 px-3 rounded-md border bg-card text-sm hover:bg-muted"
            >
              <FileSpreadsheet className="h-4 w-4 text-emerald-600" /> Export Archive
            </button>
          </div>

          {periodSummaries.length === 0 ? (
            <EmptyState
              icon={<Archive className="h-6 w-6" />}
              title="No archived periods"
              description="Periods close automatically at 8 am the day after the last published shift. Archived periods appear here."
            />
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
                  {periodSummaries.map((p) => {
                    const nurse = nurses.find((n) => n.id === p.nurse_id);
                    return (
                      <tr key={p.nurse_id + p.period_start} className="border-t hover:bg-muted/30">
                        <td className="px-4 py-3 font-medium">{nurse?.name ?? "—"}</td>
                        <td className="px-4 py-3 text-muted-foreground tabular-nums">
                          {p.period_start} → {p.period_end}
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
                    dirFacility === f
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
              title={`No staff in ${dirFacility}`}
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
                          `${w.startDate}|${w.facility ?? ""}|${w.ward ?? ""}`,
                        ) ?? [],
                    ),
                  ),
                ].sort();
                return (
                  <div key={periodStart}>
                    {/* Period header */}
                    <div className="flex items-start gap-2 mb-3">
                      <CalendarRange className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                      <div className="min-w-0">
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
                      <div className="flex-1 h-px bg-border ml-1 mt-2.5" />
                    </div>

                    {/* Ward cards */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                      {periodWins.map((win) => {
                        const key = `${win.startDate}|${win.facility ?? ""}|${win.ward ?? ""}`;
                        const isDownloading = archiveDownloading?.startsWith(key);
                        const winRoles = archiveWindowRoles.get(key) ?? [];
                        return (
                          <div
                            key={key}
                            className="bg-card border rounded-xl p-4 flex flex-col gap-3"
                          >
                            <div>
                              <p className="text-sm font-semibold">
                                {win.ward ?? "Matron / Coverage / Interns / Porter-Day / NA-Day"}
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
