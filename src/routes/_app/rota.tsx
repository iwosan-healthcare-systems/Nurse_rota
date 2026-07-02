import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { logAudit } from "@/lib/audit";
import {
  AlertTriangle,
  CalendarDays,
  Users,
  Wand2,
  Trash2,
  Send,
  ChevronLeft,
  ChevronRight,
  Search,
  X,
  Lock,
  Clock,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import {
  generateSchedule,
  nextInternWard,
  isInternType,
  isGlobalHead,
  isMatron,
  SHIFT_TIMES,
  type ShiftCode,
  type NurseInput,
  type WardInput,
  type LeaveInput,
  type SafetyViolation,
  type ExtraShift,
} from "@/lib/auto-schedule";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/_app/rota")({
  validateSearch: (search: Record<string, unknown>) => ({
    myOnly: search.myOnly === true || search.myOnly === "true",
  }),
  head: () => ({
    meta: [
      { title: "Rota — Nurses Rota" },
      {
        name: "description",
        content: "28-day staff rota with auto-scheduling and drag-and-drop manual edits.",
      },
    ],
  }),
  component: RotaPage,
});

const DAYS = 28;
const SHIFT_CYCLE: ShiftCode[] = ["M", "N", "NC", "MWC", "OFF", "LEAVE"];
const FACILITIES = ["Ikeja", "Ikoyi", "Ligali"];

const shiftStyles: Record<ShiftCode, string> = {
  M: "bg-amber-100 text-amber-900 border-amber-200",
  N: "bg-indigo-200 text-indigo-900 border-indigo-300",
  OFF: "bg-muted text-muted-foreground border-transparent",
  LEAVE: "bg-rose-100 text-rose-900 border-rose-200",
  NC: "bg-purple-200 text-purple-900 border-purple-300",
  MWC: "bg-cyan-100 text-cyan-900 border-cyan-200",
};

function parseWards(ward: string | null): string[] {
  if (!ward) return [];
  return ward.split("|").filter(Boolean);
}

function todayYmd() {
  const t = new Date();
  const m = String(t.getMonth() + 1).padStart(2, "0");
  const d = String(t.getDate()).padStart(2, "0");
  return `${t.getFullYear()}-${m}-${d}`;
}

function ymd(d: Date) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

type Assignment = {
  id: string;
  nurse_id: string;
  ward: string | null;
  shift_date: string;
  shift: ShiftCode;
  status: string;
};

type GenForm = {
  startDate: string;
  facility: string;
  ward: string;
  rotateInterns: boolean;
};

// Collapse per-day violations into a per-ward/shift/role worst-case summary.
function summariseViolations(violations: SafetyViolation[]) {
  const map = new Map<
    string,
    { ward: string; shift: "M" | "N"; role: string; required: number; actual: number }
  >();
  for (const v of violations) {
    const key = `${v.ward}|${v.shift}|${v.role}`;
    const existing = map.get(key);
    if (!existing || v.actual < existing.actual) {
      map.set(key, {
        ward: v.ward,
        shift: v.shift,
        role: v.role,
        required: v.required,
        actual: v.actual,
      });
    }
  }
  return [...map.values()].sort(
    (a, b) => a.ward.localeCompare(b.ward) || a.shift.localeCompare(b.shift),
  );
}

function RotaPage() {
  const {
    canEditRota,
    canAutoGenerate,
    canSubmitApproval,
    user,
    nurseFacility,
    isAdmin,
    nurseId,
    activeRole,
  } = useAuth();
  const { myOnly } = Route.useSearch();
  const canEdit = canEditRota;
  const canGenerate = canAutoGenerate;
  const canSubmit = canSubmitApproval;
  const qc = useQueryClient();

  // Only admin and CNO can switch facilities; everyone else is locked to their own.
  const canFilterFacility = activeRole === "admin" || activeRole === "cno";
  const lockedFacility = !canFilterFacility && nurseFacility ? nurseFacility : null;

  // View state
  const [busy, setBusy] = useState(false);
  const [startOffset, setStartOffset] = useState(0);
  const [selectedFacility, setSelectedFacility] = useState(lockedFacility ?? "");
  const [selectedWard, setSelectedWard] = useState("");
  const [selectedRole, setSelectedRole] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  // Effective facility for filtering: locked value takes priority over the dropdown state.
  // lockedFacility can resolve after mount (auth context loads async), so we can't rely
  // on useState(lockedFacility ?? "") alone — the initial value may have been "" when
  // nurseFacility was still null.
  const effectiveFacility = lockedFacility ?? selectedFacility;

  // Generate dialog
  const [genOpen, setGenOpen] = useState(false);
  const [genForm, setGenForm] = useState<GenForm>({
    startDate: todayYmd(),
    facility: "",
    ward: "",
    rotateInterns: true,
  });
  // Pending leave warning: null = not checked yet, [] = checked + clear, [...] = warning shown
  const [genPendingLeaves, setGenPendingLeaves] = useState<
    { name: string; from: string; to: string }[]
  >([]);
  const [genLeaveChecked, setGenLeaveChecked] = useState(false);

  // Extra shifts added by safety enforcement during the last auto-generate run.
  const [extraShifts, setExtraShifts] = useState<ExtraShift[]>([]);

  // Drag — ref for event handlers (synchronous), state only for visual ring
  const draggingRef = useRef<Assignment | null>(null);
  const [dragging, setDragging] = useState<Assignment | null>(null);

  // ── Auto-detect the active schedule window start ──────────────────────────
  // Strategy: a 28-day window started at most 27 days ago still contains today.
  // Search backwards 27 days for the earliest assignment — that is the window start.
  // If none found in that range, fall forward to the next upcoming window.
  const { data: scheduleWindowStart } = useQuery({
    queryKey: ["schedule-window-start", activeRole],
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayStr = ymd(today);

      const lookback = new Date(today);
      lookback.setDate(lookback.getDate() - 27);
      const lookbackStr = ymd(lookback);

      // Earliest assignment within the past 27 days = start of the active window.
      // Gaps between schedules (days with no assignments) ensure we don't bleed
      // into a previous finished window.
      const statusParam = activeRole === "nurse" ? "&status=published" : "";
      const current = await api
        .get<
          { shift_date: string }[]
        >(`/shift-assignments?from=${lookbackStr}&limit=1${statusParam}`)
        .catch(() => []);
      if (current[0]?.shift_date) return current[0].shift_date;

      // No active window — snap forward to the next upcoming one
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const future = await api
        .get<
          { shift_date: string }[]
        >(`/shift-assignments?from=${ymd(tomorrow)}&limit=1${statusParam}`)
        .catch(() => []);
      return future[0]?.shift_date ?? todayStr;
    },
  });

  // ── Computed dates ────────────────────────────────────────────────────────
  // Anchor to the detected schedule window; fall back to tomorrow.
  // Navigation moves in full 28-day blocks.
  const anchor = useMemo(() => {
    if (scheduleWindowStart) {
      const d = new Date(scheduleWindowStart + "T00:00:00");
      d.setHours(0, 0, 0, 0);
      return d;
    }
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    t.setDate(t.getDate() + 1);
    return t;
  }, [scheduleWindowStart]);

  const startDate = useMemo(() => {
    const d = new Date(anchor);
    d.setDate(d.getDate() + startOffset * DAYS);
    return d;
  }, [anchor, startOffset]);

  const endDate = useMemo(() => {
    const e = new Date(startDate);
    e.setDate(e.getDate() + DAYS - 1);
    return e;
  }, [startDate]);

  const days = useMemo(
    () =>
      Array.from({ length: DAYS }).map((_, d) => {
        const dt = new Date(startDate);
        dt.setDate(dt.getDate() + d);
        return dt;
      }),
    [startDate],
  );

  // ── Data queries ─────────────────────────────────────────────────────────
  const { data: nurses = [] } = useQuery<NurseInput[]>({
    queryKey: ["nurses"],
    staleTime: 10 * 60 * 1000,
    queryFn: () => api.get<NurseInput[]>("/nurses"),
  });

  const { data: leave = [] } = useQuery<LeaveInput[]>({
    queryKey: ["leave"],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      const cutoff = `${sixMonthsAgo.getFullYear()}-${String(sixMonthsAgo.getMonth() + 1).padStart(2, "0")}-${String(sixMonthsAgo.getDate()).padStart(2, "0")}`;
      return api.get<LeaveInput[]>(`/leave-requests?to_date_gte=${cutoff}`);
    },
  });

  // Fetch assignments filtered to only the loaded nurses and date range.
  // Querying without a nurse filter hits PostgREST's 1000-row default limit when
  // a facility has many nurses — later days silently disappear from the grid.
  // Batching by 30 IDs keeps each response well under 1000 rows (30 × 28 = 840).
  const nurseIds = useMemo(() => nurses.map((n) => n.id), [nurses]);
  const { data: assignments = [], isLoading } = useQuery({
    queryKey: [
      "assignments",
      ymd(startDate),
      ymd(endDate),
      nurseIds.length,
      activeRole === "nurse",
    ],
    enabled: nurseIds.length > 0,
    staleTime: 2 * 60 * 1000,
    queryFn: async () => {
      const statusParam = activeRole === "nurse" ? "&status=published" : "";
      return api.get<Assignment[]>(
        `/shift-assignments?nurse_ids=${nurseIds.join(",")}&from=${ymd(startDate)}&to=${ymd(endDate)}${statusParam}`,
      );
    },
  });

  // True once at least one assignment exists for the current window.
  const hasSchedule = !isLoading && assignments.length > 0;

  // Filled locum requests for this window — used to highlight locum cells.
  const { data: locumFilled = [] } = useQuery({
    queryKey: ["locum-filled-rota", ymd(startDate), ymd(endDate)],
    staleTime: 2 * 60 * 1000,
    queryFn: () =>
      api.get<{ accepted_by_nurse_id: string | null; shift_date: string; shift: string }[]>(
        `/locum/requests?status=filled&from=${ymd(startDate)}&to=${ymd(endDate)}`,
      ),
  });

  // ── Derived data ─────────────────────────────────────────────────────────
  const cellMap = useMemo(() => {
    const m = new Map<string, Assignment>();
    assignments.forEach((a) => m.set(`${a.nurse_id}|${a.shift_date}`, a));
    return m;
  }, [assignments]);

  // "nurseId|date" keys for every filled locum shift in this window.
  const locumCellSet = useMemo(() => {
    const s = new Set<string>();
    locumFilled.forEach((lr) => {
      if (lr.accepted_by_nurse_id) s.add(`${lr.accepted_by_nurse_id}|${lr.shift_date}`);
    });
    return s;
  }, [locumFilled]);

  // Total scheduled hours per nurse for the current period.
  const nurseScheduledHours = useMemo(() => {
    const m = new Map<string, number>();
    assignments.forEach((a) => {
      const h =
        a.shift === "M" || a.shift === "MWC"
          ? SHIFT_TIMES.M.hours
          : a.shift === "N" || a.shift === "NC"
            ? SHIFT_TIMES.N.hours
            : 0;
      if (h) m.set(a.nurse_id, (m.get(a.nurse_id) ?? 0) + h);
    });
    return m;
  }, [assignments]);

  const extraShiftIds = useMemo(() => new Set(extraShifts.map((e) => e.nurseId)), [extraShifts]);

  // True once any intern has been scheduled for this period (first ward run done).
  // Used to lock the rotate-interns checkbox and protect intern assignments in Clear.
  const internsAreScheduled = useMemo(() => {
    const facilityInternIds = new Set(
      nurses
        .filter((n) => isInternType(n.role) && n.facility === genForm.facility)
        .map((n) => n.id),
    );
    return assignments.some((a) => facilityInternIds.has(a.nurse_id));
  }, [assignments, nurses, genForm.facility]);

  // Unique role values scoped to the selected facility (for the role filter dropdown).
  const availableRoles = useMemo(() => {
    const scoped = effectiveFacility
      ? nurses.filter((n) => n.facility === effectiveFacility)
      : nurses;
    return [...new Set(scoped.map((n) => n.role).filter(Boolean))].sort();
  }, [nurses, effectiveFacility]);

  // View: nurses filtered by toolbar selects + search
  // For nurse role: derive which ward this user belongs to so we can lock the view.
  const lockedWard =
    activeRole === "nurse" && nurseId
      ? (nurses.find((n) => n.id === nurseId)?.ward?.split("|")[0] ?? null)
      : null;

  const filteredNurses = useMemo(() => {
    let list = nurses;
    if (effectiveFacility) list = list.filter((n) => n.facility === effectiveFacility);
    // Nurse role: always scope to their own ward. Otherwise use the ward dropdown.
    const effectiveWard = lockedWard ?? selectedWard;
    if (effectiveWard)
      list = list.filter(
        (n) =>
          isGlobalHead(n.role) || isMatron(n.role) || parseWards(n.ward).includes(effectiveWard),
      );
    if (selectedRole) list = list.filter((n) => n.role === selectedRole);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((n) => n.name.toLowerCase().includes(q));
    }
    // myOnly: restrict to just the current user's own row
    if (myOnly && nurseId) list = list.filter((n) => n.id === nurseId);
    return list;
  }, [
    nurses,
    effectiveFacility,
    lockedWard,
    selectedWard,
    selectedRole,
    searchQuery,
    myOnly,
    nurseId,
  ]);

  // Wards filtered by facility — shared by both the toolbar and generate dialog.
  // Deduplicated by name since the wards table can have multiple rows per ward name
  // (different shift configurations), and duplicates break the filter dropdown and
  // intern rotation cycle.
  const { data: facilityFilteredWards = [] } = useQuery<WardInput[]>({
    queryKey: ["wards-by-facility", effectiveFacility],
    queryFn: async () => {
      const url = effectiveFacility
        ? `/wards?facility=${encodeURIComponent(effectiveFacility)}`
        : "/wards";
      const rows = await api.get<WardInput[]>(url);
      const seen = new Set<string>();
      return rows.filter((w) => (seen.has(w.name) ? false : seen.add(w.name) && true));
    },
  });

  const { data: genWards = [] } = useQuery<WardInput[]>({
    queryKey: ["gen-wards", genForm.facility],
    queryFn: async () => {
      // Include wards explicitly tagged to this facility AND wards with no facility tag
      // (older records may not have facility set yet).
      const url = genForm.facility
        ? `/wards?facility_or_null=${encodeURIComponent(genForm.facility)}`
        : "/wards";
      const rows = await api.get<WardInput[]>(url);
      const seen = new Set<string>();
      return rows.filter((w) => (seen.has(w.name) ? false : seen.add(w.name) && true));
    },
  });

  // Nurse IDs and ward names scoped to the selected facility — used to prevent
  // cross-facility ward name collisions when checking existing assignments.
  const facilityNurseIds = useMemo(
    () => nurses.filter((n) => n.facility === genForm.facility).map((n) => n.id),
    [nurses, genForm.facility],
  );
  const facilityWardNames = useMemo(() => genWards.map((w) => w.name), [genWards]);

  // Wards that already have assignments in the date window FOR THIS FACILITY ONLY.
  // Filtering by both nurse_id (facility) and ward name prevents same-named wards
  // in other facilities (e.g. "IP Ward" in Ikoyi vs Ligali) from blocking each other.
  const { data: scheduledWardNames = [] } = useQuery<string[]>({
    queryKey: [
      "gen-scheduled-wards",
      genForm.facility,
      genForm.startDate,
      facilityNurseIds,
      facilityWardNames,
    ],
    queryFn: async () => {
      if (facilityNurseIds.length === 0 || facilityWardNames.length === 0) return [];
      const genEndDate = new Date(genForm.startDate + "T00:00:00");
      genEndDate.setDate(genEndDate.getDate() + 27);
      const base = {
        from: genForm.startDate,
        to: ymd(genEndDate),
        nurseIds: facilityNurseIds,
        wardNames: facilityWardNames,
      };
      // Two passes: wards with ANY assignment, and wards with at least one DRAFT.
      // A ward is "fully locked" (hide from dropdown) only when it has assignments
      // but NONE are draft — i.e. everything is submitted/approved/published.
      // A ward with mixed published+draft (e.g. after post-publish leave approval)
      // is shown so the admin can regenerate it.
      const nurseIdsParam = base.nurseIds.join(",");
      const wardNamesParam = encodeURIComponent(base.wardNames.join(","));
      const [anyData, draftData] = await Promise.all([
        api.get<{ ward: string }[]>(
          `/shift-assignments?nurse_ids=${nurseIdsParam}&from=${base.from}&to=${base.to}&ward_in=${wardNamesParam}`,
        ),
        api.get<{ ward: string }[]>(
          `/shift-assignments?nurse_ids=${nurseIdsParam}&from=${base.from}&to=${base.to}&ward_in=${wardNamesParam}&status=draft`,
        ),
      ]);
      const withAny = new Set(anyData.map((a) => a.ward));
      const withDraft = new Set(draftData.map((a) => a.ward));
      // Hide only wards that have assignments AND none of them are draft.
      return [...withAny].filter((w) => !withDraft.has(w));
    },
    enabled:
      !!genForm.startDate &&
      !!genForm.facility &&
      facilityNurseIds.length > 0 &&
      facilityWardNames.length > 0,
  });

  // Wards available for generation = those without fully-locked existing assignments.
  const availableGenWards = useMemo(
    () => genWards.filter((w) => !scheduledWardNames.includes(w.name)),
    [genWards, scheduledWardNames],
  );

  // If the currently selected ward gets excluded (e.g. start date changed), clear it.
  useEffect(() => {
    if (genForm.ward && scheduledWardNames.includes(genForm.ward)) {
      setGenForm((f) => ({ ...f, ward: "" }));
    }
  }, [scheduledWardNames, genForm.ward]);

  // Derive the dominant lock status for the FILTERED view only.
  // If the user has filtered to a specific ward, only that ward's assignments
  // determine the lock — so other wards (still in draft) remain editable.
  const windowLockStatus = useMemo(() => {
    const filteredIds = new Set(filteredNurses.map((n) => n.id));
    const relevant = assignments.filter((a) => filteredIds.has(a.nurse_id));
    if (relevant.some((a) => a.status === "published")) return "published" as const;
    if (relevant.some((a) => a.status === "approved_cno")) return "approved_cno" as const;
    if (relevant.some((a) => a.status === "approved_chief")) return "approved_chief" as const;
    if (relevant.some((a) => a.status === "submitted")) return "submitted" as const;
    return "draft" as const;
  }, [assignments, filteredNurses]);

  const isWindowLocked = windowLockStatus !== "draft";

  // ── Actions ───────────────────────────────────────────────────────────────
  function openGenDialog() {
    setGenForm({
      startDate: ymd(startDate),
      facility: lockedFacility ?? "",
      ward: "",
      rotateInterns: true,
    });
    setGenOpen(true);
  }

  async function handleGenerate() {
    if (!genForm.facility) {
      toast.error("Select a facility");
      return;
    }
    if (!genForm.ward) {
      toast.error("Select a ward");
      return;
    }

    const genStart = new Date(genForm.startDate + "T00:00:00");
    const genEnd = new Date(genStart);
    genEnd.setDate(genEnd.getDate() + DAYS - 1);

    // Pre-flight: check for pending leave requests that overlap this period.
    // Skip if the user already confirmed ("Continue anyway").
    if (!genLeaveChecked) {
      const facilityIds = nurses
        .filter((n) => n.facility === genForm.facility)
        .map((n) => n.id)
        .filter(Boolean);
      if (facilityIds.length > 0) {
        const pending = await api
          .get<
            { nurse_name: string; from_date: string; to_date: string }[]
          >(`/leave-requests?status=Pending&nurse_ids=${facilityIds.join(",")}&from_date_lte=${ymd(genEnd)}&to_date_gte=${ymd(genStart)}`)
          .catch(() => []);
        if (pending.length > 0) {
          setGenPendingLeaves(
            pending.map((l) => ({ name: l.nurse_name, from: l.from_date, to: l.to_date })),
          );
          return; // Wait for user decision in the dialog
        }
      }
    }

    // Reset the leave check state so subsequent opens re-check
    setGenLeaveChecked(false);
    setGenPendingLeaves([]);

    const isWardRun = !!genForm.ward;
    const facilityNurses = nurses.filter((n) => n.facility === genForm.facility);
    const facilityHeads = facilityNurses.filter((n) => isGlobalHead(n.role));
    const facilityMatrons = facilityNurses.filter((n) => isMatron(n.role));
    const facilityInterns = facilityNurses.filter((n) => isInternType(n.role));

    // Ward nurses: regular nurses + NAs + senior nurses for the selected ward (or all wards).
    // Matrons are excluded here and handled separately (like coverage nurses) since they
    // are facility-wide (ward = null) and would otherwise be filtered out of ward runs.
    let wardNurses = facilityNurses.filter(
      (n) => !isGlobalHead(n.role) && !isMatron(n.role) && !isInternType(n.role),
    );
    if (isWardRun) {
      wardNurses = wardNurses.filter((n) => parseWards(n.ward).includes(genForm.ward));
    }

    if (!wardNurses.length) {
      toast.error(
        isWardRun
          ? `No staff assigned to ward "${genForm.ward}"`
          : "No staff found for the selected facility",
      );
      return;
    }

    // Block regeneration if this ward's schedule is already in the approval pipeline.
    // (Published assignments are preserved by the delete step below; only draft is safe to overwrite.)
    if (isWardRun && wardNurses.length > 0) {
      const wardIds = wardNurses.map((n) => n.id);
      const inApprovalRows = await api
        .get<
          { status: string }[]
        >(`/shift-assignments?nurse_ids=${wardIds.join(",")}&from=${ymd(genStart)}&to=${ymd(genEnd)}&status_in=submitted,approved_chief,approved_cno&limit=1`)
        .catch(() => []);
      if (inApprovalRows?.length) {
        toast.error(
          `"${genForm.ward}" is in the approval process. Return it to draft from the Approvals page before regenerating.`,
          { duration: 8000 },
        );
        return;
      }
    }

    // For ward runs: include matrons, head nurses, and interns only if they have no
    // existing assignments for this period (first ward run of the 28-day cycle).
    // Subsequent ward runs keep their schedules untouched.
    let includeMatrons = !isWardRun;
    let includeHeads = !isWardRun;
    let includeInterns = !isWardRun;

    if (isWardRun) {
      const [matronsRows, headsRows, internsRows] = await Promise.all([
        facilityMatrons.length > 0
          ? api
              .get<
                { id: string }[]
              >(`/shift-assignments?nurse_ids=${facilityMatrons.map((n) => n.id).join(",")}&from=${ymd(genStart)}&to=${ymd(genEnd)}&limit=1`)
              .catch(() => [])
          : Promise.resolve([] as { id: string }[]),
        facilityHeads.length > 0
          ? api
              .get<
                { id: string }[]
              >(`/shift-assignments?nurse_ids=${facilityHeads.map((n) => n.id).join(",")}&from=${ymd(genStart)}&to=${ymd(genEnd)}&limit=1`)
              .catch(() => [])
          : Promise.resolve([] as { id: string }[]),
        facilityInterns.length > 0
          ? api
              .get<
                { id: string }[]
              >(`/shift-assignments?nurse_ids=${facilityInterns.map((n) => n.id).join(",")}&from=${ymd(genStart)}&to=${ymd(genEnd)}&limit=1`)
              .catch(() => [])
          : Promise.resolve([] as { id: string }[]),
      ]);
      includeMatrons = matronsRows.length === 0 && facilityMatrons.length > 0;
      includeHeads = headsRows.length === 0 && facilityHeads.length > 0;
      includeInterns = internsRows.length === 0 && facilityInterns.length > 0;
    }

    // Apply intern rotation when generating a full-facility or first ward run.
    // Sort interns by name for determinism, then distribute one per ward so each
    // intern gets a unique ward. The base index advances by 1 each generation,
    // giving a true round-robin rotation across 28-day periods.
    let internsToSchedule = facilityInterns;
    if (includeInterns && genForm.rotateInterns) {
      // Use the same ward list as the generate dialog dropdown: wards that nurses
      // in this facility are actually assigned to. This guarantees every ward
      // (including IP Ward) is in the rotation pool and no cross-facility wards
      // are accidentally included.
      const facilityWardNames = genWards.map((w) => w.name);

      if (facilityWardNames.length > 0) {
        const sortedInterns = [...facilityInterns].sort((a, b) => a.name.localeCompare(b.name));
        const firstWard = parseWards(sortedInterns[0]?.ward ?? null)[0] ?? null;
        const curBase = firstWard
          ? Math.max(0, facilityWardNames.indexOf(firstWard))
          : facilityWardNames.length - 1;
        const nextBase = (curBase + 1) % facilityWardNames.length;
        internsToSchedule = sortedInterns.map((n, idx) => ({
          ...n,
          ward: facilityWardNames[(nextBase + idx) % facilityWardNames.length],
        }));
      } else {
        internsToSchedule = facilityInterns.map((n) => {
          const currentWard = parseWards(n.ward)[0] ?? null;
          const newWard = nextInternWard(
            currentWard,
            genWards.map((w) => w.name),
          );
          return { ...n, ward: newWard };
        });
      }

      await Promise.all(internsToSchedule.map((n) => api.patch(`/nurses/${n.id}`, { ward: n.ward })));
    }

    const schedulingNurses = [
      ...wardNurses,
      ...(includeMatrons ? facilityMatrons : []),
      ...(includeHeads ? facilityHeads : []),
      ...(includeInterns ? internsToSchedule : []),
    ];

    const statusNote =
      isWardRun && !includeMatrons && !includeHeads && !includeInterns
        ? " (Matron / Coverage Nurses / Nurse Intern kept from previous run)"
        : isWardRun && (includeMatrons || includeHeads || includeInterns)
          ? " (incl. Matron / Coverage Nurses / Nurse Intern — first run)"
          : "";

    setGenOpen(false);
    setBusy(true);
    try {
      // Pass only the wards relevant to this run so safety-rule violations are
      // scoped correctly: a ward-specific run (e.g. "IP Ward") should only
      // report violations for IP Ward, not for every other ward in the facility.
      // Prefer facility-tagged records; also accept untagged wards (facility = null)
      // so older records without a facility field still participate in enforcement.
      const facilityWards = genWards.filter(
        (w) =>
          (!genForm.ward || w.name === genForm.ward) &&
          (!w.facility || w.facility === genForm.facility),
      );

      // Find the earliest ever-scheduled day for this facility so the cycle
      // phases continue seamlessly across 28-day periods.
      let periodOffset = 0;
      const facilityIds = facilityNurses.map((n) => n.id);
      if (facilityIds.length > 0) {
        const dayBefore = new Date(genStart);
        dayBefore.setDate(dayBefore.getDate() - 1);
        const epochRows = await api
          .get<
            { shift_date: string }[]
          >(`/shift-assignments?nurse_ids=${facilityIds.join(",")}&to=${ymd(dayBefore)}&limit=1`)
          .catch(() => []);
        if (epochRows[0]?.shift_date) {
          const epochDate = new Date(epochRows[0].shift_date + "T00:00:00");
          periodOffset = Math.round(
            (genStart.getTime() - epochDate.getTime()) / (24 * 60 * 60 * 1000),
          );
        }
      }

      const {
        assignments: draft,
        violations,
        extraShifts: genExtra,
      } = generateSchedule({
        nurses: schedulingNurses,
        wards: facilityWards,
        leave,
        startDate: genStart,
        days: DAYS,
        facility: genForm.facility,
        periodOffset,
      });

      // Safety-rule check: if the ward's minimums cannot be met with the
      // current staff, show a warning but still save the schedule.
      // With the strict 4M→4OFF→4N→4OFF cycle only ¼ of nurses are on M/N
      // at any one time, so high minimums can only be met with a large enough
      // roster — blocking generation entirely would prevent saving the rota.
      if (violations.length > 0) {
        const summary = summariseViolations(violations);
        const lines = summary.map(
          (v) =>
            `• ${v.ward} — ${v.shift === "M" ? "Morning" : "Night"} ${v.role}: need ${v.required}, have ${v.actual}`,
        );
        toast.warning(`Schedule saved with staffing shortfalls:\n${lines.join("\n")}`, {
          duration: 8000,
        });
        // Do NOT return — continue saving the draft
      }

      // Scope the delete to only the nurses being regenerated in this run.
      // Head nurse and intern assignments from a prior ward run are preserved.
      const scheduledIds = schedulingNurses.map((n) => n.id);
      for (let i = 0; i < scheduledIds.length; i += 200) {
        await api.del(
          `/shift-assignments?nurse_ids=${scheduledIds.slice(i, i + 200).join(",")}&from=${ymd(genStart)}&to=${ymd(genEnd)}&neq_status=published`,
        );
      }

      // Find nurse+date pairs that still have a published row after the delete step.
      // We cannot overwrite published rows, so we exclude them from the insert.
      const publishedKeys = new Set<string>();
      const pubRows = await api
        .get<
          { nurse_id: string; shift_date: string }[]
        >(`/shift-assignments?nurse_ids=${scheduledIds.join(",")}&from=${ymd(genStart)}&to=${ymd(genEnd)}&status=published`)
        .catch(() => []);
      pubRows.forEach((r) => publishedKeys.add(`${r.nurse_id}|${r.shift_date}`));

      const rows = draft
        .filter((d) => !publishedKeys.has(`${d.nurse_id}|${d.shift_date}`))
        .map((d) => ({ ...d, created_by: user?.id ?? null, status: "draft" as const }));

      // Upsert in batches of 500 rows.
      for (let i = 0; i < rows.length; i += 500) {
        await api.post("/shift-assignments/upsert", rows.slice(i, i + 500));
      }

      // Gap-fill: give every facility nurse a row for each day.
      // Only runs for full-facility runs — ward-specific runs intentionally leave
      // other wards' nurses without rows so they display as "—" in the grid and
      // are not pulled into this ward's approval window.
      if (!isWardRun) {
        const coveredIds = new Set(scheduledIds);
        const uncoveredNurses = facilityNurses.filter((n) => !coveredIds.has(n.id));
        if (uncoveredNurses.length > 0) {
          const uncoveredIds = uncoveredNurses.map((n) => n.id);
          const existingRows = await api
            .get<
              { nurse_id: string; shift_date: string }[]
            >(`/shift-assignments?nurse_ids=${uncoveredIds.join(",")}&from=${ymd(genStart)}&to=${ymd(genEnd)}`)
            .catch(() => []);
          const existingKeys = new Set(existingRows.map((r) => `${r.nurse_id}|${r.shift_date}`));
          const gapRows: {
            nurse_id: string;
            ward: string | null;
            shift_date: string;
            shift: "OFF" | "LEAVE";
            status: "draft";
            created_by: string | null;
          }[] = [];
          for (const nurse of uncoveredNurses) {
            for (let d = 0; d < DAYS; d++) {
              const dt = new Date(genStart);
              dt.setDate(dt.getDate() + d);
              const ds = ymd(dt);
              if (existingKeys.has(`${nurse.id}|${ds}`)) continue;
              const onLeave = leave.some(
                (l) =>
                  l.nurse_id === nurse.id &&
                  l.status === "Approved" &&
                  l.from_date <= ds &&
                  l.to_date >= ds,
              );
              gapRows.push({
                nurse_id: nurse.id,
                ward: nurse.ward,
                shift_date: ds,
                shift: onLeave ? "LEAVE" : "OFF",
                status: "draft",
                created_by: user?.id ?? null,
              });
            }
          }
          for (let i = 0; i < gapRows.length; i += 500) {
            await api.post("/shift-assignments/upsert", gapRows.slice(i, i + 500));
          }
        }
      }

      await logAudit(
        "Generated 28-day rota draft",
        `${genForm.facility}${genForm.ward ? ` / ${genForm.ward}` : ""} · ${ymd(genStart)} → ${ymd(genEnd)}`,
      );

      setExtraShifts(genExtra);
      toast.success(
        `28-day draft generated for ${genForm.facility}${genForm.ward ? ` / ${genForm.ward}` : ""}${statusNote}`,
      );
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to generate");
    } finally {
      // Refresh assignments, nurse ward assignments (intern rotation), and re-detect
      // the schedule window so the rota view snaps to the generated period automatically.
      qc.invalidateQueries({ queryKey: ["nurses"] });
      qc.invalidateQueries({ queryKey: ["assignments"] });
      qc.invalidateQueries({ queryKey: ["schedule-window-start"] });
      setStartOffset(0);
      setBusy(false);
    }
  }

  async function handleClear() {
    if (
      !confirm(
        "Clear ALL draft shifts in this 28-day window for every ward and job role?\n\n" +
          "Shifts that have already been submitted for approval, approved, or published will NOT be affected.",
      )
    )
      return;
    setBusy(true);
    try {
      // Delete every draft assignment in the period across all nurses / roles / wards.
      // Only status = 'draft' is removed — submitted, approved and published rows are untouched.
      const allIds = nurses.map((n) => n.id);
      const BATCH = 200;
      for (let i = 0; i < allIds.length; i += BATCH) {
        await api.del(
          `/shift-assignments?nurse_ids=${allIds.slice(i, i + BATCH).join(",")}&from=${ymd(startDate)}&to=${ymd(endDate)}&status=draft`,
        );
      }
      setExtraShifts([]);
      toast.success("All draft shifts cleared across all wards and roles");
      await logAudit("Cleared all draft shifts", `${ymd(startDate)} → ${ymd(endDate)}`);
      qc.invalidateQueries({ queryKey: ["assignments"] });
      qc.invalidateQueries({ queryKey: ["schedule-window-start"] });
      window.location.reload();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to clear draft");
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmitRota() {
    setBusy(true);
    // Submit only the currently filtered nurses so that selecting "IP Ward" and
    // clicking Submit does not also submit ICU, NICU, etc. in the same period.
    // Coverage nurses (isGlobalHead) always pass the ward filter and are included.
    const ids = filteredNurses.map((n) => n.id);
    const BATCH = 200;
    for (let i = 0; i < ids.length; i += BATCH) {
      await api
        .patch(
          `/shift-assignments?nurse_ids=${ids.slice(i, i + BATCH).join(",")}&shift_date_from=${ymd(startDate)}&shift_date_to=${ymd(endDate)}&status=draft`,
          { status: "submitted" },
        )
        .catch((e: unknown) => {
          setBusy(false);
          toast.error(e instanceof Error ? e.message : "Failed to submit");
          throw e;
        });
    }

    // When a specific ward is selected, also co-submit interns assigned to other
    // wards. Intern assignments are stored with ward = null (same pool as coverage
    // nurses) so they are independent of any ward's approval pipeline.
    // Coverage nurses are already in filteredNurses via isGlobalHead pass-through;
    // only interns from non-selected wards are missing.
    if (selectedWard) {
      const submittedIdSet = new Set(ids);
      // Resolve the facility from the selected-facility filter or from a ward nurse.
      const facility =
        effectiveFacility ||
        nurses.find(
          (n) =>
            !isGlobalHead(n.role) &&
            !isInternType(n.role) &&
            parseWards(n.ward).includes(selectedWard),
        )?.facility ||
        null;
      const otherInternIds = nurses
        .filter(
          (n) =>
            isInternType(n.role) &&
            !submittedIdSet.has(n.id) &&
            (!facility || n.facility === facility),
        )
        .map((n) => n.id);
      for (let i = 0; i < otherInternIds.length; i += BATCH) {
        await api.patch(
          `/shift-assignments?nurse_ids=${otherInternIds.slice(i, i + BATCH).join(",")}&shift_date_from=${ymd(startDate)}&shift_date_to=${ymd(endDate)}&status=draft`,
          { status: "submitted" },
        );
      }
    }

    setBusy(false);
    const wardLabel = selectedWard || effectiveFacility || "all wards";
    await logAudit(
      "Submitted rota for approval",
      `${ymd(startDate)} → ${ymd(endDate)} (${wardLabel})`,
    );
    toast.success("Submitted to Chief Matron");
    qc.invalidateQueries({ queryKey: ["assignments"] });
  }

  async function cycleCell(nurseId: string, dateStr: string, ward: string | null) {
    if (!canEdit) return;
    const existing = cellMap.get(`${nurseId}|${dateStr}`);
    if (isWindowLocked || existing?.status === "published") return;
    const next = existing
      ? SHIFT_CYCLE[(SHIFT_CYCLE.indexOf(existing.shift) + 1) % SHIFT_CYCLE.length]
      : "M";
    if (existing) {
      await api
        .patch(`/shift-assignments/${existing.id}`, { shift: next })
        .catch((e: unknown) => toast.error(e instanceof Error ? e.message : "Failed to update"));
    } else {
      await api
        .post("/shift-assignments", {
          nurse_id: nurseId,
          ward,
          shift_date: dateStr,
          shift: next,
          status: "draft",
          created_by: user?.id ?? null,
        })
        .catch((e: unknown) => toast.error(e instanceof Error ? e.message : "Failed to add"));
    }
    qc.invalidateQueries({ queryKey: ["assignments"] });
  }

  async function swapCells(a: Assignment, b: Assignment) {
    if (!canEdit) return;
    if (isWindowLocked || a.status === "published" || b.status === "published") return;
    if (a.shift_date !== b.shift_date)
      return toast.error("You can only swap shifts on the same day");
    await Promise.all([
      api.patch(`/shift-assignments/${a.id}`, { shift: b.shift }),
      api.patch(`/shift-assignments/${b.id}`, { shift: a.shift }),
    ]).catch((e: unknown) => {
      toast.error(e instanceof Error ? e.message : "Swap failed");
      throw e;
    });
    await logAudit("Swapped shifts", a.shift_date);
    qc.invalidateQueries({ queryKey: ["assignments"] });
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div>
      <PageHeader
        title="Rota"
        subtitle={
          hasSchedule
            ? `28-day view · ${days[0].toLocaleDateString()} → ${days[DAYS - 1].toLocaleDateString()}`
            : "Generate a schedule to view the rota"
        }
      />

      {/* Toolbar row 1 */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        {/* Period nav — only shown once a schedule exists */}
        {hasSchedule && (
          <div className="inline-flex rounded-md border bg-card">
            <button
              type="button"
              onClick={() => setStartOffset(0)}
              disabled={startOffset === 0}
              className="h-9 w-9 grid place-items-center hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
              title="Current period"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="px-3 text-xs font-medium flex items-center select-none">
              {startOffset === 0 ? "Current" : "Next"}
            </span>
            <button
              type="button"
              onClick={() => setStartOffset(1)}
              disabled={startOffset === 1}
              className="h-9 w-9 grid place-items-center hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
              title="Next period"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Facility filter — locked for non-admin nurses */}
        {lockedFacility ? (
          <span className="h-9 px-3 rounded-md border bg-muted text-sm flex items-center font-medium text-muted-foreground">
            {lockedFacility}
          </span>
        ) : (
          <select
            title="Facility"
            value={selectedFacility}
            onChange={(e) => {
              setSelectedFacility(e.target.value);
              setSelectedWard("");
              setSelectedRole("");
            }}
            className="h-9 px-2 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">All Facilities</option>
            {FACILITIES.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        )}

        {/* Ward filter — locked for nurse role */}
        {lockedWard ? (
          <span className="h-9 px-3 rounded-md border bg-muted text-sm flex items-center font-medium text-muted-foreground">
            {lockedWard}
          </span>
        ) : (
          <select
            title="Ward"
            value={selectedWard}
            onChange={(e) => setSelectedWard(e.target.value)}
            className="h-9 px-2 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">All Wards</option>
            {facilityFilteredWards.map((w) => (
              <option key={w.name} value={w.name}>
                {w.name}
              </option>
            ))}
          </select>
        )}

        {/* Role filter — hidden for nurse role */}
        {activeRole !== "nurse" && (
          <select
            title="Role"
            value={selectedRole}
            onChange={(e) => setSelectedRole(e.target.value)}
            className="h-9 px-2 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">All Roles</option>
            {availableRoles.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        )}

        {/* Search — hidden when viewing own schedule only */}
        {!myOnly && activeRole !== "nurse" && (
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="search"
              placeholder="Search nurse…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-9 pl-8 pr-7 w-44 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}

        <div className="flex-1" />

        {/* Actions — generate is always visible; lock indicator and edit actions depend on ward status */}
        {canGenerate && (
          <button
            type="button"
            onClick={openGenDialog}
            disabled={busy}
            className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <Wand2 className="h-4 w-4" /> Auto-generate
          </button>
        )}
        {isWindowLocked ? (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 h-9 px-3 rounded-md border text-xs font-medium",
              windowLockStatus === "published"
                ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:border-emerald-700 dark:text-emerald-400"
                : windowLockStatus === "approved_cno"
                  ? "border-violet-300 bg-violet-50 text-violet-700 dark:bg-violet-950/30 dark:border-violet-700 dark:text-violet-400"
                  : windowLockStatus === "approved_chief"
                    ? "border-blue-300 bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:border-blue-700 dark:text-blue-400"
                    : "border-amber-300 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:border-amber-700 dark:text-amber-400",
            )}
          >
            {windowLockStatus === "published" ? (
              <Lock className="h-3.5 w-3.5" />
            ) : (
              <Clock className="h-3.5 w-3.5" />
            )}
            {windowLockStatus === "published" && "Published — read only"}
            {windowLockStatus === "approved_cno" && "Approved (CNO) — awaiting publication"}
            {windowLockStatus === "approved_chief" && "Approved (Chief Matron) — awaiting CNO"}
            {windowLockStatus === "submitted" && "Submitted — awaiting approval"}
          </span>
        ) : (
          <>
            {canEdit && (
              <button
                type="button"
                onClick={handleClear}
                disabled={busy}
                className="h-9 px-3 rounded-md border text-sm inline-flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" /> Clear draft
              </button>
            )}
            {canSubmit && (
              <button
                type="button"
                onClick={handleSubmitRota}
                disabled={busy}
                className="h-9 px-3 rounded-md border text-sm inline-flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
              >
                <Send className="h-4 w-4" /> Submit for approval
              </button>
            )}
          </>
        )}
      </div>

      {extraShifts.length > 0 && (
        <div className="mb-3 flex items-start gap-2.5 rounded-lg border border-orange-300 bg-orange-50 px-4 py-3 text-sm dark:border-orange-700 dark:bg-orange-950/30">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-orange-600 dark:text-orange-400" />
          <div>
            <p className="font-semibold text-orange-900 dark:text-orange-200">
              Extra shifts assigned to meet safety requirements
            </p>
            <p className="mt-0.5 text-xs text-orange-800 dark:text-orange-300">
              {extraShifts
                .map(
                  (e) =>
                    `${e.nurseName} (+${e.extraCount} extra shift${e.extraCount > 1 ? "s" : ""})`,
                )
                .join(" · ")}
            </p>
          </div>
        </div>
      )}

      <Legend />

      {/* Personal schedule banner */}
      {myOnly && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg border bg-primary/5 border-primary/20 text-sm text-primary font-medium mb-2">
          <Lock className="h-4 w-4 shrink-0" />
          Showing your schedule only
        </div>
      )}

      {/* Rota table */}
      {isLoading ? (
        <p className="text-sm text-muted-foreground py-12 text-center">Loading…</p>
      ) : filteredNurses.length === 0 ? (
        <EmptyState
          icon={<CalendarDays className="h-6 w-6" />}
          title={searchQuery ? "No nurses match your search" : "No nurses to schedule"}
          description={
            searchQuery ? `No results for "${searchQuery}".` : "Add staff before generating a rota."
          }
          action={
            searchQuery ? (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="inline-flex items-center gap-2 h-9 px-3 rounded-md border text-sm hover:bg-muted"
              >
                <X className="h-4 w-4" /> Clear search
              </button>
            ) : (
              <Link
                to="/staff"
                className="inline-flex items-center gap-2 h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm"
              >
                <Users className="h-4 w-4" /> Manage staff
              </Link>
            )
          }
        />
      ) : !hasSchedule ? (
        <EmptyState
          icon={<CalendarDays className="h-6 w-6" />}
          title={
            activeRole === "nurse" ? "Schedule not yet published" : "No schedule for this period"
          }
          description={
            activeRole === "nurse"
              ? "Your schedule for this period has not been published yet. Check back later."
              : "Auto-generate a rota to see the 28-day view. The schedule will appear here once generated."
          }
          action={
            canGenerate ? (
              <button
                type="button"
                onClick={openGenDialog}
                className="inline-flex items-center gap-2 h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm"
              >
                <CalendarDays className="h-4 w-4" /> Auto-generate
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="bg-card border rounded-xl shadow-soft overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="text-left font-semibold px-3 py-3 sticky left-0 bg-muted/50 z-10 min-w-40">
                    Nurse
                  </th>
                  <th className="text-left font-semibold px-2 py-3 min-w-24">Ward</th>
                  <th className="text-center font-semibold px-2 py-3 min-w-14">Hrs</th>
                  {days.map((dt) => {
                    const isWeekend = dt.getDay() === 0 || dt.getDay() === 6;
                    return (
                      <th
                        key={ymd(dt)}
                        className={cn(
                          "text-center font-semibold px-1 py-3 min-w-11",
                          isWeekend
                            ? "bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400"
                            : "",
                        )}
                      >
                        <div>{dt.toLocaleDateString("en", { weekday: "short" })}</div>
                        <div
                          className={cn(
                            "text-[10px] font-normal",
                            isWeekend ? "text-red-400" : "text-muted-foreground",
                          )}
                        >
                          {dt.getDate()}/{dt.getMonth() + 1}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {filteredNurses.map((n) => (
                  <tr key={n.id} className="border-t hover:bg-muted/30">
                    <td className="px-3 py-2 sticky left-0 bg-card z-10">
                      <div className="font-medium">{n.name}</div>
                      <div className="text-[11px] text-muted-foreground">{n.role}</div>
                    </td>
                    <td className="px-2 py-2 text-muted-foreground text-xs">
                      {(() => {
                        if (isGlobalHead(n.role) || isMatron(n.role)) return "—";
                        const ws = parseWards(n.ward);
                        if (!ws.length) return "—";
                        return (
                          <>
                            {ws[0]}
                            {ws.length > 1 && (
                              <span className="ml-0.5 text-[10px] opacity-60">
                                +{ws.length - 1}
                              </span>
                            )}
                          </>
                        );
                      })()}
                    </td>
                    <td className="px-2 py-2 text-center text-xs font-medium tabular-nums">
                      <span
                        className={cn(
                          extraShiftIds.has(n.id)
                            ? "text-orange-600 dark:text-orange-400"
                            : "text-muted-foreground",
                        )}
                      >
                        {nurseScheduledHours.get(n.id) ?? 0}h
                      </span>
                    </td>
                    {days.map((dt) => {
                      const dateStr = ymd(dt);
                      const isWeekend = dt.getDay() === 0 || dt.getDay() === 6;
                      const cell = cellMap.get(`${n.id}|${dateStr}`);
                      const isLocum = locumCellSet.has(`${n.id}|${dateStr}`);
                      // Visual-only: uses state (safe to lag one render behind)
                      const isDragOver =
                        dragging &&
                        dragging.shift_date === dateStr &&
                        cell &&
                        dragging.id !== cell.id;
                      return (
                        <td
                          key={dateStr}
                          className={cn(
                            "px-0.5 py-1 text-center",
                            isWeekend && "bg-red-50/60 dark:bg-red-950/10",
                          )}
                        >
                          <button
                            type="button"
                            draggable={!!cell && canEdit && !isWindowLocked}
                            onClick={() => cycleCell(n.id, dateStr, n.ward)}
                            onDragStart={(e) => {
                              if (!cell || !canEdit || isWindowLocked) return;
                              // Write to ref immediately — visible to all handlers this frame
                              draggingRef.current = cell;
                              setDragging(cell);
                              e.dataTransfer.effectAllowed = "move";
                              e.dataTransfer.setData("text/plain", cell.id);
                            }}
                            onDragEnd={() => {
                              draggingRef.current = null;
                              setDragging(null);
                            }}
                            onDragOver={(e) => {
                              if (isWindowLocked) return;
                              // Use ref — guaranteed current even before React re-renders
                              const src = draggingRef.current;
                              if (src && cell && src.id !== cell.id && src.shift_date === dateStr) {
                                e.preventDefault();
                                e.dataTransfer.dropEffect = "move";
                              }
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              if (isWindowLocked) return;
                              const src = draggingRef.current;
                              if (src && cell && src.id !== cell.id) {
                                swapCells(src, cell);
                              }
                              draggingRef.current = null;
                              setDragging(null);
                            }}
                            className={cn(
                              "block w-full text-[10px] font-bold py-1.5 rounded border transition",
                              cell
                                ? isLocum
                                  ? "bg-black text-white border-black"
                                  : shiftStyles[cell.shift]
                                : "bg-muted/30 text-muted-foreground/40 border-transparent hover:bg-muted",
                              isDragOver && !isWindowLocked && "ring-2 ring-primary scale-105",
                              dragging && dragging.id === cell?.id && "opacity-40",
                              isWindowLocked
                                ? "cursor-not-allowed opacity-80"
                                : !canEdit
                                  ? "cursor-default"
                                  : "",
                            )}
                            title={
                              isWindowLocked
                                ? windowLockStatus === "published"
                                  ? "Published — this schedule is locked"
                                  : "Submitted for approval — return to draft to edit"
                                : canEdit
                                  ? "Click to cycle · drag to swap with same-day shift"
                                  : "View only"
                            }
                          >
                            {cell ? (isLocum ? "LO" : cell.shift) : "—"}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="p-4 text-xs text-muted-foreground border-t flex items-center justify-between">
            <span>
              {isWindowLocked ? (
                <span
                  className={cn(
                    "inline-flex items-center gap-1",
                    windowLockStatus === "published"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : windowLockStatus === "approved_cno"
                        ? "text-violet-600 dark:text-violet-400"
                        : windowLockStatus === "approved_chief"
                          ? "text-blue-600 dark:text-blue-400"
                          : "text-amber-600 dark:text-amber-400",
                  )}
                >
                  {windowLockStatus === "published" ? (
                    <Lock className="h-3 w-3" />
                  ) : (
                    <Clock className="h-3 w-3" />
                  )}
                  {windowLockStatus === "published" && "Published schedule — read only"}
                  {windowLockStatus === "approved_cno" &&
                    "Approved (CNO) — use Approvals to publish or revert"}
                  {windowLockStatus === "approved_chief" &&
                    "Approved (Chief Matron) — use Approvals to advance or revert"}
                  {windowLockStatus === "submitted" &&
                    "Submitted for approval — use Approvals to return to draft if edits are needed"}
                </span>
              ) : (
                "Click a cell to cycle shifts · Drag a shift onto another nurse's same-day cell to swap."
              )}
            </span>
            <span>
              {filteredNurses.length} staff ·{" "}
              {assignments.filter((a) => filteredNurses.some((n) => n.id === a.nurse_id)).length}{" "}
              assignments
            </span>
          </div>
        </div>
      )}

      {/* Auto-generate dialog */}
      <Dialog
        open={genOpen}
        onOpenChange={(open) => {
          setGenOpen(open);
          if (!open) {
            setGenPendingLeaves([]);
            setGenLeaveChecked(false);
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Generate 28-day schedule</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Start date */}
            <div>
              <label className="block text-sm font-medium mb-1.5">Start date</label>
              <input
                type="date"
                title="Schedule start date"
                value={genForm.startDate}
                onChange={(e) => setGenForm((f) => ({ ...f, startDate: e.target.value }))}
                className="w-full h-9 px-3 rounded-md border bg-background text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Schedule runs {DAYS} days from this date.
              </p>
            </div>

            {/* Facility */}
            <div>
              <label className="block text-sm font-medium mb-1.5">Facility</label>
              {lockedFacility ? (
                <p className="h-9 flex items-center px-3 rounded-md border bg-muted text-sm font-medium text-muted-foreground">
                  {lockedFacility}
                </p>
              ) : (
                <select
                  title="Facility"
                  value={genForm.facility}
                  onChange={(e) =>
                    setGenForm((f) => ({ ...f, facility: e.target.value, ward: "" }))
                  }
                  className="w-full h-9 px-2 rounded-md border bg-background text-sm outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">Select facility…</option>
                  {FACILITIES.map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </select>
              )}
            </div>

            {/* Ward */}
            <div>
              <label className="block text-sm font-medium mb-1.5">
                Ward <span className="text-destructive">*</span>
              </label>
              <select
                title="Ward"
                value={genForm.ward}
                onChange={(e) => setGenForm((f) => ({ ...f, ward: e.target.value }))}
                disabled={!genForm.facility}
                className="w-full h-9 px-2 rounded-md border bg-background text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
              >
                <option value="">Select ward…</option>
                {availableGenWards.map((w) => (
                  <option key={w.name}>{w.name}</option>
                ))}
              </select>
            </div>

            {/* Rotate interns */}
            <label
              className={cn(
                "flex items-start gap-2.5 select-none",
                internsAreScheduled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
              )}
            >
              <input
                type="checkbox"
                checked={genForm.rotateInterns}
                disabled={internsAreScheduled}
                onChange={(e) => setGenForm((f) => ({ ...f, rotateInterns: e.target.checked }))}
                className="mt-0.5 h-4 w-4 rounded border accent-primary disabled:cursor-not-allowed"
              />
              <span className="text-sm">
                <span className="font-medium">Rotate intern departments</span>
                <span className="block text-xs text-muted-foreground mt-0.5">
                  {internsAreScheduled
                    ? "Intern schedule is locked in from the first run of this period — rotation is applied on the next period."
                    : "Automatically move each intern to their next assigned ward for this 28-day cycle."}
                </span>
              </span>
            </label>
          </div>

          {/* Pending leave warning */}
          {genPendingLeaves.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-700 p-3 text-xs space-y-2">
              <p className="font-semibold text-amber-800 dark:text-amber-300">
                {genPendingLeaves.length} pending leave request
                {genPendingLeaves.length > 1 ? "s" : ""} in this period
              </p>
              <ul className="space-y-0.5 text-amber-700 dark:text-amber-400">
                {genPendingLeaves.map((l, i) => (
                  <li key={i}>
                    • {l.name} — {l.from} → {l.to}
                  </li>
                ))}
              </ul>
              <p className="text-amber-600 dark:text-amber-500">
                Approve or reject these leaves before generating so the schedule reflects their
                availability correctly.
              </p>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setGenLeaveChecked(true);
                    setGenPendingLeaves([]);
                    void handleGenerate();
                  }}
                  className="h-7 px-3 rounded-md bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium"
                >
                  Continue anyway
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setGenOpen(false);
                    setGenPendingLeaves([]);
                    setGenLeaveChecked(false);
                  }}
                  className="h-7 px-3 rounded-md border bg-card text-xs hover:bg-muted"
                >
                  Review leaves first
                </button>
              </div>
            </div>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <button type="button" className="h-9 px-4 rounded-md border text-sm hover:bg-muted">
                Cancel
              </button>
            </DialogClose>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!genForm.facility || !genForm.ward || !genForm.startDate || busy}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <Wand2 className="h-4 w-4" />
              Generate
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Legend() {
  const items: { code: ShiftCode; label: string; time: string }[] = [
    { code: "M", label: "Morning", time: "08:00–17:00" },
    { code: "N", label: "Night", time: "17:00–08:00" },
    { code: "NC", label: "Night Coverage", time: "17:00–08:00" },
    { code: "MWC", label: "Morning Weekend Coverage", time: "08:00–17:00" },
    { code: "OFF", label: "Off", time: "" },
    { code: "LEAVE", label: "Leave", time: "" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
      {items.map((i) => (
        <span
          key={i.code}
          className={cn(
            "inline-flex items-center gap-1.5 px-2 py-1 rounded border",
            shiftStyles[i.code],
          )}
        >
          <span className="font-bold">{i.code}</span> {i.label}
          {i.time && <span className="opacity-60">{i.time}</span>}
        </span>
      ))}
    </div>
  );
}
