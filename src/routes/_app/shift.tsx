import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { toast } from "sonner";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  CalendarDays,
  CheckCircle2,
  Clock,
  Lock,
  MapPin,
  PlayCircle,
  StopCircle,
  Timer,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";
import { verifyLocationAndCaptureIp, type GpsSettings } from "@/lib/geo-fence";

function fmtDate(d: string) {
  return new Date(d.slice(0, 10) + "T00:00:00").toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export const Route = createFileRoute("/_app/shift")({
  head: () => ({
    meta: [{ title: "Shift — Nurses Rota" }],
  }),
  component: ShiftPage,
});

type ShiftLog = {
  id: string;
  nurse_id: string;
  shift_date: string;
  shift_type: "M" | "N";
  started_at: string;
  ended_at: string | null;
  expected_end_at: string;
  hours_logged: number | null;
  period_start: string;
  is_late: boolean;
  late_minutes: number | null;
  late_reason: string | null;
  is_locum: boolean;
  is_leave: boolean;
  leave_request_id: string | null;
  is_swap: boolean;
  swap_note: string | null;
};

type Assignment = {
  id: string;
  shift: "M" | "N" | "MWC" | "NC" | "OFF" | "LEAVE";
  shift_date: string;
  ward: string | null;
  status: string;
};

type PeriodHours = {
  period_start: string;
  period_end: string;
  total_hours: number;
  total_shifts: number;
};

function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function fmtDuration(ms: number) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Convert decimal hours (e.g. 2.58) to "2h 35m" */
function fmtHours(decHours: number) {
  const h = Math.floor(decHours);
  const m = Math.round((decHours - h) * 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Calculate the expected end timestamp for a shift started at `startedAt`. */
function calcExpectedEnd(shiftType: "M" | "N", startedAt: Date): Date {
  const d = new Date(startedAt);
  if (shiftType === "M") {
    d.setHours(17, 0, 0, 0);
    // If started after 17:00 (late start) add a day grace
    if (d <= startedAt) d.setDate(d.getDate() + 1);
  } else {
    d.setDate(d.getDate() + 1);
    d.setHours(8, 0, 0, 0);
  }
  return d;
}

function hoursLogged(startedAt: string, endedAt: string) {
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  return Math.round((ms / 3600000) * 100) / 100;
}

function fmtHHMM(d: Date) {
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function isMorningShift(shift: string) {
  return shift === "M" || shift === "MWC";
}
function isNightShift(shift: string) {
  return shift === "N" || shift === "NC";
}
function isWorkShift(shift: string) {
  return isMorningShift(shift) || isNightShift(shift);
}
/** Maps MWC→M and NC→N for shift_log recording (DB only stores M/N). */
function normalizeShiftType(shift: string): "M" | "N" {
  return isMorningShift(shift) ? "M" : "N";
}
function shiftLabel(shift: string) {
  if (shift === "M") return "Morning Shift";
  if (shift === "N") return "Night Shift";
  if (shift === "MWC") return "Morning Coverage";
  if (shift === "NC") return "Night Coverage";
  return "Shift";
}
function shiftTimeLabel(shift: string) {
  return isMorningShift(shift) ? "08:00 – 17:00" : "17:00 – 08:00";
}

function ShiftPage() {
  const { nurseId, fullName, activeRole } = useAuth();

  // All hooks must be called unconditionally (Rules of Hooks).
  // The management-role early return is placed after every hook call below.
  const qc = useQueryClient();
  const today = todayYmd();
  const [now, setNow] = useState(new Date());
  const autoEndingRef = useRef(false);
  const missedRecordedRef = useRef(false);
  const pendingGeoRef = useRef<{ lat: number; lng: number; ip: string | null } | null>(null);
  const [geoChecking, setGeoChecking] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [lateDialog, setLateDialog] = useState<{
    open: boolean;
    reason: string;
    capturedMinutes: number;
  }>({ open: false, reason: "", capturedMinutes: 0 });

  // Live clock tick every minute
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(t);
  }, []);

  // ── Queries ───────────────────────────────────────────────────────────────

  // Today's rota assignment — poll every 30 s so the Start Shift button unlocks
  // automatically once an admin publishes the rota without the nurse needing to reload.
  const { data: queryAssignment } = useQuery<Assignment | null>({
    queryKey: ["my-assignment", nurseId, today],
    enabled: !!nurseId,
    refetchInterval: 30000,
    queryFn: async () => {
      const arr = await api.get<Assignment[]>(
        `/shift-assignments?nurse_id=${nurseId}&shift_date=${today}&status=published&limit=1`,
      );
      return arr[0] ?? null;
    },
  });

  // Fetch the nurse's facility for geo-fencing. Matron detection uses the system role directly.
  const { data: nurseInfo } = useQuery<{ facility: string | null } | null>({
    queryKey: ["nurse-info", nurseId],
    enabled: !!nurseId,
    queryFn: async () => {
      const arr = await api
        .get<{ facility: string | null }[]>(`/nurses?id=${nurseId}`)
        .catch(() => []);
      return arr[0] ? { facility: arr[0].facility ?? null } : null;
    },
  });
  const nurseFacility = nurseInfo?.facility ?? null;
  // Use system role (auth context) rather than nurses.role so matrons with any job-title spelling
  // (matron, chief_matron, Chief Matron, etc.) are correctly detected.
  const isMatronNurse = activeRole === "chief_matron";

  // Matrons have no auto-generated assignments. Synthesise a Mon–Fri morning shift
  // so they can use the tracker without a published rota entry.
  const matronAssignment = useMemo<Assignment | null>(() => {
    if (!isMatronNurse) return null;
    const dow = new Date().getDay();
    const isWeekend = dow === 0 || dow === 6;
    return {
      id: "",
      shift: isWeekend ? "OFF" : "M",
      shift_date: today,
      ward: null,
      status: "published",
    };
  }, [isMatronNurse, today]);

  // Active shift (may span midnight for night shifts) or today's completed shift.
  // Filtering by ended_at IS NULL catches a night shift started yesterday that hasn't
  // auto-ended yet; including shift_date = today catches a completed morning shift.
  const { data: shiftLog } = useQuery<ShiftLog | null>({
    queryKey: ["my-shift-log", nurseId, today],
    enabled: !!nurseId,
    queryFn: () =>
      api.get<ShiftLog | null>(`/shift-logs/current?nurse_id=${nurseId}&shift_date=${today}`),
    refetchInterval: 30000,
  });

  // Detect if today's assignment is a locum (bank) shift.
  // We fetch shift + ward so we can synthesize a correct assignment even when
  // the shift_assignments row still reads "OFF" (e.g. RLS prevented the update).
  const { data: todayLocum } = useQuery<{
    id: string;
    shift: "M" | "N";
    ward: string;
    facility: string;
  } | null>({
    queryKey: ["my-locum-today", nurseId, today],
    enabled: !!nurseId,
    refetchInterval: 30000,
    queryFn: async () => {
      const arr = await api
        .get<
          { id: string; shift: "M" | "N"; ward: string; facility: string }[]
        >(`/locum/requests?accepted_by_nurse_id=${nurseId}&shift_date=${today}&status=filled&limit=1`)
        .catch(() => []);
      return arr[0] ?? null;
    },
  });

  // Detect if today is a swap coverage shift (nurse is Nurse B in an approved swap request).
  // The reason field encodes: SHIFT_SWITCH|{nurseBId}|{nurseBName}|{shiftA}|{shiftB}|...
  const { data: todaySwap } = useQuery<{
    requestId: string;
    nurseAName: string;
    shiftType: "M" | "N";
    isDirect: boolean;
  } | null>({
    queryKey: ["my-swap-today", nurseId, today],
    enabled: !!nurseId,
    queryFn: async () => {
      const rows = await api
        .get<
          { id: string; nurse_name: string; reason: string }[]
        >(`/leave-requests?status=Approved&from_date=${today}&type=Swap&reason_like=${encodeURIComponent(`SHIFT_SWITCH|${nurseId}|`)}&limit=1`)
        .catch(() => []);
      if (!rows.length) return null;
      const row = rows[0];
      const parts = (row.reason ?? "").slice("SHIFT_SWITCH|".length).split("|");
      const shiftA = parts[2] ?? "";
      const isDirect = parts.includes("DIRECT");
      return {
        requestId: row.id,
        nurseAName: row.nurse_name,
        shiftType: (shiftA === "M" ? "M" : "N") as "M" | "N",
        isDirect,
      };
    },
  });

  // GPS fence settings from portal (falls back to hardcoded defaults if not set)
  const { data: gpsSettings } = useQuery<GpsSettings | null>({
    queryKey: ["gps-settings"],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      try {
        const row = await api.get<{ value: GpsSettings }>("/portal-settings/gps_settings");
        return row.value ?? null;
      } catch {
        return null;
      }
    },
  });

  // Current period summary
  const { data: periodHours } = useQuery<PeriodHours | null>({
    queryKey: ["my-period-hours", nurseId],
    enabled: !!nurseId,
    refetchInterval: 60000,
    queryFn: async () => {
      const arr = await api
        .get<PeriodHours[]>(`/nurse-period-hours?nurse_id=${nurseId}&limit=1`)
        .catch(() => []);
      return arr[0] ?? null;
    },
  });

  // Running hours this period from shift_logs (live sum)
  const { data: currentPeriodLogs = [] } = useQuery<ShiftLog[]>({
    queryKey: ["my-period-logs", nurseId],
    enabled: !!nurseId,
    refetchInterval: 60000,
    queryFn: async () => {
      // Find the active period window start (earliest assignment in last 27 days)
      const lookback = new Date();
      lookback.setDate(lookback.getDate() - 27);
      const lb = `${lookback.getFullYear()}-${String(lookback.getMonth() + 1).padStart(2, "0")}-${String(lookback.getDate()).padStart(2, "0")}`;

      const winRow = await api
        .get<
          { shift_date: string }[]
        >(`/shift-assignments?nurse_id=${nurseId}&from=${lb}&status=published&limit=1`)
        .catch(() => []);

      const periodStart = winRow[0]?.shift_date ?? lb;
      const periodEnd = new Date(periodStart.slice(0, 10) + "T00:00:00");
      periodEnd.setDate(periodEnd.getDate() + 27);
      const pe = `${periodEnd.getFullYear()}-${String(periodEnd.getMonth() + 1).padStart(2, "0")}-${String(periodEnd.getDate()).padStart(2, "0")}`;

      return api
        .get<
          ShiftLog[]
        >(`/shift-logs?nurse_id=${nurseId}&is_locum=false&from=${periodStart}&to=${pe}`)
        .catch(() => []);
    },
  });

  const currentPeriodHours = currentPeriodLogs.reduce((s, l) => s + (l.hours_logged ?? 0), 0);
  const swapPeriodHours = currentPeriodLogs
    .filter((l) => l.is_swap)
    .reduce((s, l) => s + (l.hours_logged ?? 0), 0);
  const leavePeriodHours = currentPeriodLogs
    .filter((l) => l.is_leave)
    .reduce((s, l) => s + (l.hours_logged ?? 0), 0);
  const missedPeriodCount = currentPeriodLogs.filter(
    (l) => l.late_reason === "Missed shift",
  ).length;

  // ── Auto-end: check every minute whether the shift's expected end has passed ──
  useEffect(() => {
    if (!shiftLog || shiftLog.ended_at || autoEndingRef.current) return;
    const expectedEnd = new Date(shiftLog.expected_end_at);
    if (now < expectedEnd) return;
    autoEndingRef.current = true;
    void endShift(shiftLog, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);

  // ── Auto-record missed shift (0 hours) once the shift window has closed ─────
  useEffect(() => {
    // Skip management roles and matrons (synthetic assignments)
    if (activeRole && ["admin", "cno", "hr_admin"].includes(activeRole)) return;
    if (isMatronNurse) return;
    if (shiftLog || missedRecordedRef.current || !nurseId) return;

    // Determine the effective shift from locum or published assignment
    const effectiveShift = todayLocum?.shift ?? queryAssignment?.shift ?? null;
    if (!effectiveShift || !isWorkShift(effectiveShift)) return;

    // Schedule is only published when a real query-backed assignment (or locum) exists
    const schedulePublished = !!(todayLocum ?? queryAssignment);
    if (!schedulePublished) return;

    const endHour = isMorningShift(effectiveShift) ? 17 : 8;
    const endTime = new Date();
    if (isNightShift(effectiveShift)) endTime.setDate(endTime.getDate() + 1);
    endTime.setHours(endHour, 0, 0, 0);
    if (now < endTime) return;

    missedRecordedRef.current = true;
    const shiftType = normalizeShiftType(effectiveShift);
    const officialStart = new Date();
    officialStart.setHours(shiftType === "M" ? 8 : 17, 0, 0, 0);

    void (async () => {
      const lookback = new Date();
      lookback.setDate(lookback.getDate() - 27);
      const lb = `${lookback.getFullYear()}-${String(lookback.getMonth() + 1).padStart(2, "0")}-${String(lookback.getDate()).padStart(2, "0")}`;
      const winRows = await api
        .get<{ shift_date: string }[]>(`/shift-assignments?nurse_id=${nurseId}&from=${lb}&status=published&limit=1`)
        .catch(() => []);
      const periodStart = winRows[0]?.shift_date ?? today;
      await api
        .post("/shift-logs", {
          nurse_id: nurseId,
          shift_date: today,
          shift_type: shiftType,
          started_at: officialStart.toISOString(),
          ended_at: officialStart.toISOString(),
          expected_end_at: endTime.toISOString(),
          hours_logged: 0,
          period_start: periodStart,
          is_late: false,
          late_minutes: null,
          late_reason: "Missed shift",
          latitude: null,
          longitude: null,
          ip_address: null,
          is_locum: !!todayLocum,
          locum_request_id: todayLocum?.id ?? null,
          is_swap: false,
          swap_note: null,
        })
        .catch(() => { missedRecordedRef.current = false; });
      qc.invalidateQueries({ queryKey: ["my-shift-log"] });
      qc.invalidateQueries({ queryKey: ["my-period-logs"] });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);

  // Only CNO, HR/Admin and System Admin see the all-nurses management view.
  // Chief Matron and Head Nurse work regular shifts so they get the personal tracker.
  if (activeRole && ["admin", "cno", "hr_admin"].includes(activeRole)) {
    return <AllNursesShiftView />;
  }

  // Matrons (job role "Matron") have no rota assignments — fall back to synthetic.
  // Locum nurses: if todayLocum exists we override regardless of what shift_assignments says
  // (it may still read "OFF" if the RLS update didn't propagate).
  const locumAssignment: Assignment | null = todayLocum
    ? {
        id: queryAssignment?.id ?? "",
        shift: todayLocum.shift,
        shift_date: today,
        ward: `${todayLocum.ward} · ${todayLocum.facility}`,
        status: "published",
      }
    : null;
  const assignment = locumAssignment ?? queryAssignment ?? matronAssignment;

  // ── Actions ───────────────────────────────────────────────────────────────

  async function startShift(lateReason?: string, lateMins?: number) {
    if (!nurseId || !assignment || !isWorkShift(assignment.shift)) return;

    // MWC records as M, NC records as N in shift_logs (DB only stores M/N).
    const shiftType = normalizeShiftType(assignment.shift);
    const actualNow = new Date();
    // Clamp to the official start (8:00 / 17:00) so nurses who arrive during
    // the 15-minute early window don't accumulate hours before the shift begins.
    const officialStart = new Date();
    officialStart.setHours(shiftType === "M" ? 8 : 17, 0, 0, 0);
    const startedAt = actualNow < officialStart ? officialStart : actualNow;
    const expectedEnd = calcExpectedEnd(shiftType, startedAt);
    const geo = pendingGeoRef.current;
    pendingGeoRef.current = null;

    // Find the period start
    const lookback = new Date();
    lookback.setDate(lookback.getDate() - 27);
    const lb = `${lookback.getFullYear()}-${String(lookback.getMonth() + 1).padStart(2, "0")}-${String(lookback.getDate()).padStart(2, "0")}`;
    const winRows = await api.get<{ shift_date: string }[]>(
      `/shift-assignments?nurse_id=${nurseId}&from=${lb}&status=published&limit=1`,
    );
    const periodStart = winRows[0]?.shift_date ?? today;

    const recordedLate = (lateMins ?? 0) > 0;

    try {
      await api.post("/shift-logs", {
        nurse_id: nurseId,
        shift_date: today,
        shift_type: shiftType,
        started_at: startedAt.toISOString(),
        expected_end_at: expectedEnd.toISOString(),
        period_start: periodStart,
        is_late: recordedLate,
        late_minutes: recordedLate ? lateMins : null,
        late_reason: lateReason?.trim() || null,
        latitude: geo?.lat ?? null,
        longitude: geo?.lng ?? null,
        ip_address: geo?.ip ?? null,
        is_locum: !!todayLocum,
        locum_request_id: todayLocum?.id ?? null,
        is_swap: !!todaySwap && !todaySwap.isDirect,
        swap_note: todaySwap && !todaySwap.isDirect
          ? `Swap coverage for ${todaySwap.nurseAName} – ${todaySwap.shiftType === "M" ? "Morning" : "Night"} shift`
          : null,
      });
    } catch (e) {
      return toast.error(e instanceof Error ? e.message : "Failed to start shift");
    }
    setLateDialog({ open: false, reason: "", capturedMinutes: 0 });
    toast.success(
      recordedLate
        ? `Shift started — ${lateMins}m late. Reason recorded.`
        : "Shift started — clock is running",
    );
    qc.invalidateQueries({ queryKey: ["my-shift-log"] });
    qc.invalidateQueries({ queryKey: ["my-period-logs"] });
  }

  async function handleStartClick() {
    setGeoError(null);
    setGeoChecking(true);
    // Locum shifts must be geo-verified against the locum facility, not the nurse's home facility.
    const facilityToCheck = todayLocum?.facility ?? nurseFacility;
    try {
      const geo = await verifyLocationAndCaptureIp(facilityToCheck, gpsSettings);
      pendingGeoRef.current = geo;
      if (isLate) {
        setLateDialog({ open: true, reason: "", capturedMinutes: minutesSinceStart });
      } else {
        void startShift();
      }
    } catch (err) {
      setGeoError(err instanceof Error ? err.message : "Could not verify your location.");
    } finally {
      setGeoChecking(false);
    }
  }

  async function endShift(log: ShiftLog, isAuto = false) {
    const endedAt = isAuto ? new Date(log.expected_end_at) : new Date();
    const hours = hoursLogged(log.started_at, endedAt.toISOString());

    try {
      await api.patch(`/shift-logs/${log.id}`, {
        ended_at: endedAt.toISOString(),
        hours_logged: hours,
      });
    } catch (e) {
      return toast.error(e instanceof Error ? e.message : "Failed to end shift");
    }

    // Locum and swap-coverage hours are tracked separately — do not add to the nurse's regular monthly total.
    if (nurseId && !log.is_locum && !log.is_swap)
      await api
        .post("/rpc/increment-nurse-hours", { p_nurse_id: nurseId, p_hours: hours })
        .catch(() => {});

    if (!isAuto) toast.success(`Shift ended — ${fmtHours(hours)} logged`);
    qc.invalidateQueries({ queryKey: ["my-shift-log"] });
    qc.invalidateQueries({ queryKey: ["my-period-logs"] });
    qc.invalidateQueries({ queryKey: ["nurses"] });
  }

  // ── Timing: when this shift is allowed to start ───────────────────────────

  // The official start time for the nurse's shift today.
  // M / MWC → 08:00; N / NC → 17:00.
  const shiftStartTime = (() => {
    if (!assignment || !isWorkShift(assignment.shift)) return null;
    const t = new Date();
    t.setHours(isMorningShift(assignment.shift) ? 8 : 17, 0, 0, 0);
    return t;
  })();

  // The official end time (used to detect a missed shift).
  // M / MWC → 17:00 today; N / NC → 08:00 tomorrow.
  const shiftEndTime = (() => {
    if (!assignment || !isWorkShift(assignment.shift)) return null;
    const t = new Date();
    if (isNightShift(assignment.shift)) t.setDate(t.getDate() + 1);
    t.setHours(isNightShift(assignment.shift) ? 8 : 17, 0, 0, 0);
    return t;
  })();

  // Minutes elapsed since the scheduled start (negative = before official start).
  const minutesSinceStart = shiftStartTime
    ? Math.floor((now.getTime() - shiftStartTime.getTime()) / 60000)
    : -Infinity;

  // Button is visible from 15 minutes before official start.
  const canStartShift = minutesSinceStart >= -15;
  // Late = any moment after the official start.
  const isLate = minutesSinceStart > 0;

  // ── Derived state ─────────────────────────────────────────────────────────

  // Check published status directly from the DB-backed sources — never the matron fallback,
  // which has status:"published" hardcoded and would otherwise bypass the published gate.
  const isSchedulePublished = !!(locumAssignment ?? queryAssignment);
  const hasShiftToday = !!(assignment && isWorkShift(assignment.shift));
  const isActive = shiftLog && !shiftLog.ended_at;
  const isEnded = shiftLog && !!shiftLog.ended_at;
  // Shift window closed without a log being started → missed
  const isShiftMissed =
    !shiftLog && hasShiftToday && isSchedulePublished && !!shiftEndTime && now >= shiftEndTime;
  // 0-hour log created by auto-record (late_reason sentinel)
  const isMissedLog =
    !!shiftLog && !!shiftLog.ended_at &&
    Number(shiftLog.hours_logged) === 0 &&
    shiftLog.late_reason === "Missed shift";
  const elapsed = isActive
    ? fmtDuration(Math.max(0, now.getTime() - new Date(shiftLog.started_at).getTime()))
    : null;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <PageHeader
        title="My Shift"
        subtitle={fullName ? `Tracking for ${fullName}` : "Shift time tracker"}
      />

      {/* Today's shift card */}
      <div className="bg-card border rounded-xl p-6 shadow-soft">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
              Today ·{" "}
              {new Date().toLocaleDateString("en-GB", {
                weekday: "long",
                day: "numeric",
                month: "long",
              })}
            </p>
            {hasShiftToday ? (
              <p className="text-2xl font-bold mt-1">
                {shiftLabel(assignment.shift)}
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {shiftTimeLabel(assignment.shift)}
                </span>
                {todayLocum && (
                  <span className="ml-2 inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-violet-100 text-violet-700 border border-violet-200">
                    Bank Shift (Locum)
                  </span>
                )}
                {todaySwap && (
                  <span className="ml-2 inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-sky-100 text-sky-700 border border-sky-200">
                    <ArrowLeftRight className="h-3 w-3" /> Swap Coverage
                  </span>
                )}
              </p>
            ) : (
              <p className="text-2xl font-bold mt-1 text-muted-foreground">
                {assignment
                  ? assignment.shift === "LEAVE"
                    ? "On Leave"
                    : "Day Off"
                  : "No assignment"}
              </p>
            )}
            {assignment?.ward && (
              <p className="text-sm text-muted-foreground mt-0.5">Ward: {assignment.ward}</p>
            )}
          </div>

          {/* Status badge */}
          {isActive && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-100 text-emerald-700 text-xs font-semibold border border-emerald-200">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Active
            </span>
          )}
          {isEnded && !isMissedLog && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-muted text-muted-foreground text-xs font-semibold border">
              <CheckCircle2 className="h-3 w-3" />
              Completed
            </span>
          )}
          {(isShiftMissed || isMissedLog) && !isActive && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-red-50 text-red-600 text-xs font-semibold border border-red-200">
              <AlertTriangle className="h-3 w-3" />
              Missed
            </span>
          )}
        </div>

        {/* Active shift info */}
        {isActive && (
          <>
            <div className="grid grid-cols-3 gap-3 mb-3">
              <div className="rounded-lg border bg-muted/30 px-3 py-2.5 text-center">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Started</p>
                <p className="font-semibold mt-0.5">{fmtTime(shiftLog.started_at)}</p>
              </div>
              <div className="rounded-lg border bg-emerald-50 border-emerald-200 px-3 py-2.5 text-center">
                <p className="text-[10px] uppercase tracking-wide text-emerald-600">Elapsed</p>
                <p className="font-semibold text-emerald-700 mt-0.5">{elapsed}</p>
              </div>
              <div className="rounded-lg border bg-muted/30 px-3 py-2.5 text-center">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Ends at</p>
                <p className="font-semibold mt-0.5">{fmtTime(shiftLog.expected_end_at)}</p>
              </div>
            </div>
            {shiftLog.is_late && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 mb-3 text-sm">
                <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                <div>
                  <span className="font-semibold text-amber-800">
                    Late start · {shiftLog.late_minutes}m after scheduled time
                  </span>
                  {shiftLog.late_reason && (
                    <p className="text-amber-700 text-xs mt-0.5">{shiftLog.late_reason}</p>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {/* Missed shift notice (log recorded but 0 hours) */}
        {isMissedLog && (
          <div className="flex items-start gap-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2.5 mb-3 text-sm">
            <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
            <p className="text-red-700">
              Missed shift — this shift was not started before the scheduled end time. No hours have been logged for this shift.
            </p>
          </div>
        )}

        {/* Completed shift info */}
        {isEnded && !isMissedLog && (
          <>
            <div className="grid grid-cols-3 gap-3 mb-3">
              <div className="rounded-lg border bg-muted/30 px-3 py-2.5 text-center">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Started</p>
                <p className="font-semibold mt-0.5">{fmtTime(shiftLog.started_at)}</p>
              </div>
              <div className="rounded-lg border bg-muted/30 px-3 py-2.5 text-center">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Ended</p>
                <p className="font-semibold mt-0.5">{fmtTime(shiftLog.ended_at!)}</p>
              </div>
              <div className="rounded-lg border bg-primary/5 border-primary/20 px-3 py-2.5 text-center">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Hours</p>
                <p className="font-semibold text-primary mt-0.5">
                  {shiftLog.hours_logged != null ? fmtHours(Number(shiftLog.hours_logged)) : "—"}
                </p>
              </div>
            </div>
            {shiftLog.is_late && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 mb-3 text-sm">
                <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                <div>
                  <span className="font-semibold text-amber-800">
                    Late start · {shiftLog.late_minutes}m after scheduled time
                  </span>
                  {shiftLog.late_reason && (
                    <p className="text-amber-700 text-xs mt-0.5">{shiftLog.late_reason}</p>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {/* Missed shift — window closed before shift was started (log recording in progress) */}
        {isShiftMissed && !isMissedLog && (
          <div className="flex items-start gap-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2.5 text-sm">
            <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
            <p className="text-red-700">
              Missed shift — this shift was not started before the scheduled end time. No hours have been logged for this shift.
            </p>
          </div>
        )}

        {/* Action buttons */}
        {hasShiftToday && !isEnded && !isShiftMissed && (
          <div className="space-y-3">
            {/* Late reason prompt — shown when nurse is overdue and clicks Start */}
            {lateDialog.open && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-amber-800">
                      Late start — {lateDialog.capturedMinutes} minutes past scheduled time
                    </p>
                    <p className="text-xs text-amber-700 mt-0.5">
                      A reason is required before the shift can be started.
                    </p>
                  </div>
                </div>
                <textarea
                  value={lateDialog.reason}
                  onChange={(e) => setLateDialog((d) => ({ ...d, reason: e.target.value }))}
                  placeholder="e.g. Traffic delay, ward handover overran, personal emergency…"
                  className="w-full rounded-md border border-amber-200 bg-white px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-amber-400"
                  rows={2}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void startShift(lateDialog.reason, lateDialog.capturedMinutes)}
                    disabled={!lateDialog.reason.trim()}
                    className="flex-1 h-9 rounded-md bg-amber-600 text-white text-sm font-semibold inline-flex items-center justify-center gap-1.5 hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
                  >
                    <PlayCircle className="h-4 w-4" /> Confirm & Start Shift
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      pendingGeoRef.current = null;
                      setLateDialog({ open: false, reason: "", capturedMinutes: 0 });
                    }}
                    className="px-4 h-9 rounded-md border text-sm font-medium hover:bg-muted transition"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Unpublished schedule warning */}
            {!shiftLog && !isSchedulePublished && (
              <div className="flex items-start gap-2 rounded-lg border border-muted bg-muted/40 px-3 py-2.5 text-sm">
                <Lock className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                <p className="text-muted-foreground">
                  The rota schedule has not been published yet.
                </p>
              </div>
            )}

            <div className="flex gap-3">
              {!shiftLog && !lateDialog.open && (
                <button
                  type="button"
                  disabled={!canStartShift || !isSchedulePublished || geoChecking}
                  onClick={() => void handleStartClick()}
                  className={cn(
                    "flex-1 h-11 rounded-lg text-sm font-semibold inline-flex items-center justify-center gap-2 transition",
                    canStartShift && isSchedulePublished && !geoChecking
                      ? "bg-emerald-600 text-white hover:bg-emerald-700"
                      : "bg-muted text-muted-foreground cursor-not-allowed",
                  )}
                >
                  {geoChecking ? (
                    <>
                      <MapPin className="h-5 w-5 animate-pulse" />
                      Checking location…
                    </>
                  ) : (
                    <>
                      <PlayCircle className="h-5 w-5" />
                      {!isSchedulePublished
                        ? "Schedule Not Published"
                        : canStartShift
                          ? "Start Shift"
                          : shiftStartTime
                            ? `Shift begins at ${fmtHHMM(shiftStartTime)}`
                            : "Start Shift"}
                    </>
                  )}
                </button>
              )}
              {isActive && (
                <button
                  type="button"
                  onClick={() => endShift(shiftLog!)}
                  className="flex-1 h-11 rounded-lg border border-destructive/40 text-destructive text-sm font-semibold inline-flex items-center justify-center gap-2 hover:bg-destructive/5 transition"
                >
                  <StopCircle className="h-5 w-5" /> End Shift Early
                </button>
              )}
            </div>

            {/* Geo-fence error */}
            {geoError && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm">
                <MapPin className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                <div>
                  <p className="font-semibold text-destructive">Location check failed</p>
                  <p className="text-destructive/80 text-xs mt-0.5">{geoError}</p>
                </div>
              </div>
            )}

            {/* Help text when button is time-locked */}
            {!shiftLog && isSchedulePublished && !canStartShift && shiftStartTime && (
              <p className="text-xs text-center text-muted-foreground">
                The button unlocks at {fmtHHMM(shiftStartTime)} when your shift begins.
              </p>
            )}
          </div>
        )}

        {!hasShiftToday && !assignment && (
          <p className="text-sm text-muted-foreground text-center py-2">
            No shift assignment found for today.
          </p>
        )}
      </div>

      {/* Period summary */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-card border rounded-xl p-5 shadow-soft">
          <div className="flex items-center gap-2 mb-2 text-muted-foreground">
            <Timer className="h-4 w-4" />
            <p className="text-xs uppercase tracking-wide font-medium">Hours this period</p>
          </div>
          <p className="text-3xl font-bold">{fmtHours(currentPeriodHours - swapPeriodHours)}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {currentPeriodLogs.filter((l) => l.ended_at && !l.is_swap && l.late_reason !== "Missed shift").length} shifts completed
            {missedPeriodCount > 0 && ` · ${missedPeriodCount} missed`}
          </p>
          {(swapPeriodHours > 0 || leavePeriodHours > 0) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {swapPeriodHours > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-sky-700 bg-sky-50 border border-sky-200 px-1.5 py-0.5 rounded-full">
                  <ArrowLeftRight className="h-2.5 w-2.5" />
                  {fmtHours(swapPeriodHours)} additional
                </span>
              )}
              {leavePeriodHours > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-full">
                  {fmtHours(leavePeriodHours)} leave
                </span>
              )}
            </div>
          )}
        </div>
        <div className="bg-card border rounded-xl p-5 shadow-soft">
          <div className="flex items-center gap-2 mb-2 text-muted-foreground">
            <CalendarDays className="h-4 w-4" />
            <p className="text-xs uppercase tracking-wide font-medium">Last period</p>
          </div>
          {periodHours ? (
            <>
              <p className="text-3xl font-bold">{fmtHours(Number(periodHours.total_hours))}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {periodHours.total_shifts} shifts · {periodHours.period_start} →{" "}
                {periodHours.period_end}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No saved period yet</p>
          )}
        </div>
      </div>

      {/* Recent shift history */}
      {currentPeriodLogs.length > 0 && <ShiftHistory logs={currentPeriodLogs} />}
    </div>
  );
}

const HISTORY_PAGE = 5;

function ShiftHistory({ logs }: { logs: ShiftLog[] }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? logs : logs.slice(0, HISTORY_PAGE);

  return (
    <div className="bg-card border rounded-xl shadow-soft overflow-hidden">
      <div className="px-5 py-4 border-b flex items-center justify-between">
        <h2 className="font-semibold text-sm">Shift history — current period</h2>
        <span className="text-xs text-muted-foreground">{logs.length} shifts</span>
      </div>
      <div className="divide-y">
        {visible.map((log) => (
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
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-medium">{fmtDate(log.shift_date)}</p>
                  {log.is_leave && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 bg-emerald-100 border border-emerald-200 px-1.5 py-0.5 rounded-full">
                      Leave (credited)
                    </span>
                  )}
                  {log.is_swap && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-sky-700 bg-sky-100 border border-sky-200 px-1.5 py-0.5 rounded-full">
                      <ArrowLeftRight className="h-2.5 w-2.5" /> Additional Shift
                    </span>
                  )}
                  {log.late_reason === "Missed shift" ? (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-red-600 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded-full">
                      <AlertTriangle className="h-2.5 w-2.5" />
                      Missed
                    </span>
                  ) : log.is_late ? (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-100 border border-amber-200 px-1.5 py-0.5 rounded-full">
                      <AlertTriangle className="h-2.5 w-2.5" />
                      {log.late_minutes}m late
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {log.late_reason === "Missed shift"
                    ? "Not started"
                    : `${fmtTime(log.started_at)} → ${log.ended_at ? fmtTime(log.ended_at) : "in progress"}`}
                </p>
                {log.is_swap && log.swap_note && (
                  <p className="text-xs text-sky-700 mt-0.5 italic">{log.swap_note}</p>
                )}
                {log.is_late && log.late_reason && log.late_reason !== "Missed shift" && (
                  <p className="text-xs text-amber-700 mt-0.5 italic">{log.late_reason}</p>
                )}
              </div>
            </div>
            <div className="text-right">
              {log.late_reason === "Missed shift" ? (
                <span className="text-red-500 text-xs font-medium">0h logged</span>
              ) : log.hours_logged != null ? (
                <span className="font-semibold">{fmtHours(Number(log.hours_logged))}</span>
              ) : (
                <span className="text-emerald-600 text-xs font-medium flex items-center gap-1">
                  <Clock className="h-3 w-3" /> Running
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
      {!showAll && logs.length > HISTORY_PAGE && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="cursor-pointer w-full text-center text-xs text-muted-foreground hover:text-foreground py-3 border-t underline"
        >
          Show all ({logs.length - HISTORY_PAGE} more)
        </button>
      )}
      {showAll && logs.length > HISTORY_PAGE && (
        <button
          type="button"
          onClick={() => setShowAll(false)}
          className="cursor-pointer w-full text-center text-xs text-muted-foreground hover:text-foreground py-3 border-t underline"
        >
          Show less
        </button>
      )}
    </div>
  );
}

// ── All-nurses shift hours view (admin / management roles) ────────────────────

type NurseRow = {
  id: string;
  name: string;
  role: string;
  ward: string | null;
  facility: string | null;
  target_hours: number;
};
type AllShiftLog = {
  id: string;
  nurse_id: string;
  hours_logged: number | null;
  shift_date: string;
  shift_type: string;
  started_at: string;
  ended_at: string | null;
  expected_end_at: string;
  is_late: boolean;
  late_minutes: number | null;
  is_locum: boolean;
};

function AllNursesShiftView() {
  const [search, setSearch] = useState("");
  const [ending, setEnding] = useState<string | null>(null);
  const qc = useQueryClient();

  const lookback = new Date();
  lookback.setDate(lookback.getDate() - 27);
  const lbStr = `${lookback.getFullYear()}-${String(lookback.getMonth() + 1).padStart(2, "0")}-${String(lookback.getDate()).padStart(2, "0")}`;

  const { data: nurses = [] } = useQuery<NurseRow[]>({
    queryKey: ["nurses"],
    queryFn: () => api.get<NurseRow[]>("/nurses"),
  });

  const { data: logs = [] } = useQuery<AllShiftLog[]>({
    queryKey: ["all-shift-logs-current"],
    refetchInterval: 60000,
    queryFn: () => api.get<AllShiftLog[]>(`/shift-logs?from=${lbStr}`),
  });

  // Build per-nurse totals
  const hoursMap = new Map<string, number>();
  const shiftsMap = new Map<string, number>();
  const activeMap = new Map<string, { logId: string; expectedEnd: string; isLocum: boolean }>();
  const lateMap = new Map<string, number>();
  for (const l of logs) {
    if (l.hours_logged != null) {
      hoursMap.set(l.nurse_id, (hoursMap.get(l.nurse_id) ?? 0) + Number(l.hours_logged));
      shiftsMap.set(l.nurse_id, (shiftsMap.get(l.nurse_id) ?? 0) + 1);
    } else if (!l.ended_at) {
      activeMap.set(l.nurse_id, {
        logId: l.id,
        expectedEnd: l.expected_end_at,
        isLocum: l.is_locum,
      });
    }
    if (l.is_late) {
      lateMap.set(l.nurse_id, (lateMap.get(l.nurse_id) ?? 0) + 1);
    }
  }

  async function handleAdminEndShift(nurseId: string) {
    const active = activeMap.get(nurseId);
    if (!active) return;
    setEnding(nurseId);
    try {
      const endedAt = new Date(active.expectedEnd);
      const startedAt = logs.find((l) => l.id === active.logId)?.started_at;
      const hours = startedAt
        ? Math.round(((endedAt.getTime() - new Date(startedAt).getTime()) / 3600000) * 100) / 100
        : null;
      await api.patch(`/shift-logs/${active.logId}`, {
        ended_at: endedAt.toISOString(),
        hours_logged: hours,
      });
      if (!active.isLocum && hours) {
        await api
          .post("/rpc/increment-nurse-hours", { p_nurse_id: nurseId, p_hours: hours })
          .catch(() => {});
      }
      toast.success("Shift ended");
      qc.invalidateQueries({ queryKey: ["all-shift-logs-current"] });
      qc.invalidateQueries({ queryKey: ["nurses"] });
    } catch {
      toast.error("Failed to end shift");
    } finally {
      setEnding(null);
    }
  }

  const filtered = nurses.filter((n) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      n.name.toLowerCase().includes(q) ||
      (n.ward ?? "").toLowerCase().includes(q) ||
      (n.facility ?? "").toLowerCase().includes(q)
    );
  });

  const totalHours = [...hoursMap.values()].reduce((s, h) => s + h, 0);
  const activeCount = activeMap.size;

  return (
    <div className="space-y-6">
      <PageHeader title="Shift Hours" subtitle="All staff · current 28-day period" />

      {/* Summary stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-card border rounded-xl p-5 shadow-soft">
          <div className="flex items-center gap-2 mb-1 text-muted-foreground">
            <Users className="h-4 w-4" />
            <p className="text-xs uppercase tracking-wide font-medium">Total staff</p>
          </div>
          <p className="text-3xl font-bold">{nurses.length}</p>
        </div>
        <div className="bg-card border rounded-xl p-5 shadow-soft">
          <div className="flex items-center gap-2 mb-1 text-muted-foreground">
            <Timer className="h-4 w-4" />
            <p className="text-xs uppercase tracking-wide font-medium">Hours logged</p>
          </div>
          <p className="text-3xl font-bold">{fmtHours(totalHours)}</p>
          <p className="text-xs text-muted-foreground mt-1">this 28-day period</p>
        </div>
        <div className="bg-card border rounded-xl p-5 shadow-soft">
          <div className="flex items-center gap-2 mb-1 text-muted-foreground">
            <Clock className="h-4 w-4" />
            <p className="text-xs uppercase tracking-wide font-medium">Active now</p>
          </div>
          <p className="text-3xl font-bold text-emerald-600">{activeCount}</p>
          <p className="text-xs text-muted-foreground mt-1">shifts in progress</p>
        </div>
      </div>

      {/* Search */}
      <div className="flex items-center gap-3">
        <input
          type="search"
          placeholder="Search by name, ward or facility…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-9 px-3 w-full sm:w-72 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <span className="text-xs text-muted-foreground">{filtered.length} staff</span>
      </div>

      {/* Table */}
      <div className="bg-card border rounded-xl shadow-soft overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="text-left px-4 py-3 font-semibold">Nurse</th>
              <th className="text-left px-4 py-3 font-semibold">Ward</th>
              <th className="text-left px-4 py-3 font-semibold">Facility</th>
              <th className="text-right px-4 py-3 font-semibold">Shifts</th>
              <th className="text-right px-4 py-3 font-semibold">Hours</th>
              <th className="text-left px-4 py-3 font-semibold w-40">Progress</th>
              <th className="text-right px-4 py-3 font-semibold">Late</th>
              <th className="text-left px-4 py-3 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((n) => {
              const hrs = hoursMap.get(n.id) ?? 0;
              const shifts = shiftsMap.get(n.id) ?? 0;
              const lateCount = lateMap.get(n.id) ?? 0;
              const target = n.target_hours || 185;
              const pct = Math.min(Math.round((hrs / target) * 100), 100);
              const activeEntry = activeMap.get(n.id);
              const isActive = !!activeEntry;
              return (
                <tr key={n.id} className="border-t hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <p className="font-medium">{n.name}</p>
                    <p className="text-xs text-muted-foreground">{n.role}</p>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {n.ward?.split("|")[0] ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{n.facility ?? "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{shifts}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-semibold">
                    {fmtHours(hrs)}
                    <span className="text-xs font-normal text-muted-foreground ml-1">
                      / {target}h
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-2 rounded-full bg-muted overflow-hidden w-32">
                      <Progress value={pct} className="h-full rounded-full" />
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{pct}%</p>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {lateCount > 0 ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
                        <AlertTriangle className="h-3 w-3" />
                        {lateCount}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {isActive ? (
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                          Active
                        </span>
                        <button
                          type="button"
                          onClick={() => handleAdminEndShift(n.id)}
                          disabled={ending === n.id}
                          className="text-xs px-2 py-0.5 rounded border border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50 transition-colors"
                        >
                          {ending === n.id ? "Ending…" : "End"}
                        </button>
                      </div>
                    ) : hrs > 0 ? (
                      <span className="text-xs text-muted-foreground">Logged hours</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">No logs yet</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}
