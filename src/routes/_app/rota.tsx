import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { logAudit } from "@/lib/audit";
import { NURSE_TIER_ROLES } from "@/lib/auth-context";
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
  Building2,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import {
  generateSchedule,
  isInternType,
  isGlobalHead,
  isMatron,
  isPorterType,
  isNADayType,
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
    nurseId,
    activeRole,
  } = useAuth();
  const { myOnly } = Route.useSearch();
  const isNurseTier = activeRole !== null && NURSE_TIER_ROLES.includes(activeRole);
  const canEdit = canEditRota;
  const canGenerate = canAutoGenerate;
  const canSubmit = canSubmitApproval;
  const qc = useQueryClient();

  // Only admin, CNO, and HR can switch facilities; everyone else is locked to their own.
  const canFilterFacility =
    activeRole === "admin" || activeRole === "cno" || activeRole === "hr_admin";
  const lockedFacility = !canFilterFacility && nurseFacility ? nurseFacility : null;

  // View state
  const [busy, setBusy] = useState(false);
  const [startOffset, setStartOffset] = useState(0);
  const [selectedFacility, setSelectedFacility] = useState(lockedFacility ?? "");
  const [selectedWard, setSelectedWard] = useState("");
  const [selectedFacilityWide, setSelectedFacilityWide] = useState("");
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
  // Pending leave warning — populated by the pre-flight check in handleGenerate.
  const [genPendingLeaves, setGenPendingLeaves] = useState<
    { name: string; from: string; to: string }[]
  >([]);

  // Extra shifts added by safety enforcement during the last auto-generate run.
  const [extraShifts, setExtraShifts] = useState<ExtraShift[]>([]);

  // Drag — ref for event handlers (synchronous), state only for visual ring
  const draggingRef = useRef<Assignment | null>(null);
  const [dragging, setDragging] = useState<Assignment | null>(null);

  // Shift picker popover — opened by clicking a draft cell
  type ShiftPicker = { nurseId: string; dateStr: string; ward: string | null; existingId: string | null; x: number; y: number; above: boolean };
  const [shiftPicker, setShiftPicker] = useState<ShiftPicker | null>(null);

  // ── Auto-detect the active schedule window start ──────────────────────────
  // Strategy: a 28-day window started at most 27 days ago still contains today.
  // Search backwards 27 days for the earliest assignment — that is the window start.
  // If none found in that range, fall forward to the next upcoming window.
  // Scoped to the effective facility (via nurse IDs) so admin users switching between
  // facilities with different schedule start dates see the correct period anchor.
  const { data: scheduleWindowStart, isLoading: windowLoading } = useQuery({
    queryKey: ["schedule-window-start", activeRole, effectiveFacility],
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayStr = ymd(today);

      const lookback = new Date(today);
      lookback.setDate(lookback.getDate() - 27);
      const lookbackStr = ymd(lookback);

      // When a specific facility is selected, scope the anchor to that facility's
      // nurses only — prevents Ikeja's schedule start from bleeding into Ligali's view.
      const cachedNurses = qc.getQueryData<NurseInput[]>(["nurses"]) ?? [];
      const facilityIds = effectiveFacility
        ? cachedNurses.filter((n) => n.facility === effectiveFacility).map((n) => n.id)
        : [];
      const nurseFilter =
        facilityIds.length > 0 ? `&nurse_ids=${facilityIds.join(",")}` : "";

      // Run both window checks in parallel: current (last 27 days) and future (tomorrow+).
      // If a current window is found, we use it; otherwise fall back to the future one.
      // Parallel fetch halves the waterfall when no current window exists.
      const statusParam = isNurseTier ? "&status=published" : "";
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const [current, future] = await Promise.all([
        api
          .get<{ shift_date: string }[]>(
            `/shift-assignments?from=${lookbackStr}&limit=1${statusParam}${nurseFilter}`,
          )
          .catch(() => [] as { shift_date: string }[]),
        api
          .get<{ shift_date: string }[]>(
            `/shift-assignments?from=${ymd(tomorrow)}&limit=1${statusParam}${nurseFilter}`,
          )
          .catch(() => [] as { shift_date: string }[]),
      ]);
      if (current[0]?.shift_date) return current[0].shift_date.slice(0, 10);
      return (future[0]?.shift_date ?? todayStr).slice(0, 10);
    },
  });

  // ── Computed dates ────────────────────────────────────────────────────────
  // Anchor to the detected schedule window; fall back to tomorrow.
  // Navigation moves in full 28-day blocks.
  const anchor = useMemo(() => {
    if (scheduleWindowStart) {
      // Slice to 10 chars ("YYYY-MM-DD") before parsing — the DB can return a full
      // ISO timestamp (e.g. "2024-01-15T00:00:00+00:00") and appending "T00:00:00"
      // to that produces an unparseable string → Invalid Date → NaN-NaN-NaN.
      const d = new Date(scheduleWindowStart.slice(0, 10) + "T00:00:00");
      d.setHours(0, 0, 0, 0);
      if (!isNaN(d.getTime())) return d;
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

  // When a specific facility is selected, scope the query to that facility's nurses.
  // When "All Facilities" is selected (effectiveFacility = ""), omit the nurse_ids
  // filter entirely — passing every UUID in the URL can exceed nginx's header-size
  // limit and the server returns [] with no error.  Our Express API has no row cap,
  // so querying by date range alone is safe.
  const displayNurseIds = useMemo(
    () =>
      effectiveFacility
        ? nurses.filter((n) => n.facility === effectiveFacility).map((n) => n.id)
        : null, // null = no nurse filter (all facilities)
    [nurses, effectiveFacility],
  );

  const { data: assignments = [], isLoading: assignmentsLoading } = useQuery({
    // Key on effectiveFacility instead of nurseIds.length so a facility-switch
    // always triggers a fresh fetch even when both facilities have the same nurse count.
    queryKey: ["assignments", ymd(startDate), ymd(endDate), effectiveFacility, isNurseTier],
    // Wait until the window start is known so we don't fetch for the wrong date range,
    // flash an empty state, then refetch — causing the visible flicker on page load.
    enabled: nurses.length > 0 && !windowLoading,
    staleTime: 2 * 60 * 1000,
    queryFn: async () => {
      const statusParam = isNurseTier ? "&status=published" : "";
      const nurseParam =
        displayNurseIds && displayNurseIds.length > 0
          ? `&nurse_ids=${displayNurseIds.join(",")}`
          : "";
      return api.get<Assignment[]>(
        `/shift-assignments?from=${ymd(startDate)}&to=${ymd(endDate)}${nurseParam}${statusParam}`,
      );
    },
  });

  // Combined: true while the window start OR the assignments are still loading.
  const isLoading = windowLoading || assignmentsLoading;

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
    assignments.forEach((a) => m.set(`${a.nurse_id}|${a.shift_date.slice(0, 10)}`, a));
    return m;
  }, [assignments]);

  // "nurseId|date" keys for every filled locum shift in this window.
  const locumCellSet = useMemo(() => {
    const s = new Set<string>();
    locumFilled.forEach((lr) => {
      if (lr.accepted_by_nurse_id) s.add(`${lr.accepted_by_nurse_id}|${lr.shift_date.slice(0, 10)}`);
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

  // True once interns have been scheduled for the period BEING GENERATED (first ward run done).
  // Scoped to the generated period's date range so viewing period 1 doesn't lock the
  // checkbox when the user is actually generating period 2.
  const internsAreScheduled = useMemo(() => {
    const facilityInternIds = new Set(
      nurses
        .filter((n) => isInternType(n.role) && n.facility === genForm.facility)
        .map((n) => n.id),
    );
    const genEndObj = new Date(genForm.startDate + "T00:00:00");
    genEndObj.setDate(genEndObj.getDate() + DAYS - 1);
    const genEndStr = ymd(genEndObj);
    return assignments.some(
      (a) =>
        facilityInternIds.has(a.nurse_id) &&
        a.shift_date.slice(0, 10) >= genForm.startDate &&
        a.shift_date.slice(0, 10) <= genEndStr &&
        a.status !== "draft",
    );
  }, [assignments, nurses, genForm.facility, genForm.startDate]);

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

    if (lockedWard) {
      // Nurse viewing their own ward: include facility-wide roles so they see
      // matrons, coverage nurses and porters that appear in their ward's schedule.
      list = list.filter(
        (n) =>
          isGlobalHead(n.role) ||
          isMatron(n.role) ||
          isPorterType(n.role) ||
          parseWards(n.ward).includes(lockedWard),
      );
    } else if (selectedWard) {
      // Manager clicked a ward chip: strict ward-only. Explicitly exclude facility-wide
      // roles (coverage nurses, matrons, porters) even if their profile has a ward set.
      list = list.filter(
        (n) =>
          !isGlobalHead(n.role) &&
          !isMatron(n.role) &&
          !isPorterType(n.role) &&
          parseWards(n.ward).includes(selectedWard),
      );
    } else if (selectedFacilityWide) {
      // Manager clicked a facility-wide role chip: show only that role group.
      list = list.filter((n) => n.role === selectedFacilityWide);
    }
    // else: no selection → all nurses in facility (separated visually in the grid)

    if (selectedRole) list = list.filter((n) => n.role === selectedRole);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((n) => n.name.toLowerCase().includes(q));
    }
    if (myOnly && nurseId) list = list.filter((n) => n.id === nurseId);
    return list;
  }, [
    nurses,
    effectiveFacility,
    lockedWard,
    selectedWard,
    selectedFacilityWide,
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
        ? `/wards?facility_or_null=${encodeURIComponent(effectiveFacility)}`
        : "/wards";
      const rows = await api.get<WardInput[]>(url);
      const seen = new Set<string>();
      // Prefer facility-specific records over null-facility fallbacks when names collide.
      return [...rows]
        .sort((a, b) => (a.facility && !b.facility ? -1 : !a.facility && b.facility ? 1 : 0))
        .filter((w) => (seen.has(w.name) ? false : seen.add(w.name) && true));
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
      // Prefer facility-specific records over null-facility fallbacks when names collide.
      return [...rows]
        .sort((a, b) => (a.facility && !b.facility ? -1 : !a.facility && b.facility ? 1 : 0))
        .filter((w) => (seen.has(w.name) ? false : seen.add(w.name) && true));
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
  const {
    data: wardScheduleData = { fullyLocked: [], hasDraft: [] },
    isFetching: isFetchingScheduledWards,
  } = useQuery<{ fullyLocked: string[]; hasDraft: string[] }>({
    queryKey: [
      "gen-scheduled-wards",
      genForm.facility,
      genForm.startDate,
      facilityNurseIds,
      facilityWardNames,
    ],
    queryFn: async () => {
      if (facilityNurseIds.length === 0 || facilityWardNames.length === 0)
        return { fullyLocked: [], hasDraft: [] };
      const genEndDate = new Date(genForm.startDate + "T00:00:00");
      genEndDate.setDate(genEndDate.getDate() + 27);
      const nurseIdsParam = facilityNurseIds.join(",");
      const wardNamesParam = encodeURIComponent(facilityWardNames.join(","));
      const from = genForm.startDate;
      const to = ymd(genEndDate);
      const [anyData, draftData] = await Promise.all([
        api.get<{ ward: string }[]>(
          `/shift-assignments?nurse_ids=${nurseIdsParam}&from=${from}&to=${to}&ward_in=${wardNamesParam}`,
        ),
        api.get<{ ward: string }[]>(
          `/shift-assignments?nurse_ids=${nurseIdsParam}&from=${from}&to=${to}&ward_in=${wardNamesParam}&status=draft`,
        ),
      ]);
      const withAny = new Set(anyData.map((a) => a.ward));
      const withDraft = new Set(draftData.map((a) => a.ward));
      return {
        // Fully locked = has assignments but none are draft (all approved/published).
        // These are completely hidden from the dropdown.
        fullyLocked: [...withAny].filter((w) => !withDraft.has(w)),
        // Has draft = at least one draft assignment exists; shown as disabled option.
        hasDraft: [...withDraft],
      };
    },
    enabled:
      !!genForm.startDate &&
      !!genForm.facility &&
      facilityNurseIds.length > 0 &&
      facilityWardNames.length > 0,
  });
  const scheduledWardNames = wardScheduleData.fullyLocked;
  const draftScheduledWards = wardScheduleData.hasDraft;

  // Wards available for generation = those without fully-locked existing assignments.
  // Wards with draft schedules remain in the list but are shown as disabled options.
  const availableGenWards = useMemo(
    () => genWards.filter((w) => !scheduledWardNames.includes(w.name)),
    [genWards, scheduledWardNames],
  );

  // If the currently selected ward gets excluded (date changed or schedule exists), clear it.
  useEffect(() => {
    if (
      genForm.ward &&
      (scheduledWardNames.includes(genForm.ward) || draftScheduledWards.includes(genForm.ward))
    ) {
      setGenForm((f) => ({ ...f, ward: "" }));
    }
  }, [scheduledWardNames, draftScheduledWards, genForm.ward]);

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

  // Per-ward dominant status — used by the ward chip strip.
  // Only ward-specific nurses contribute (global heads, matrons, porters have ward = null
  // and would otherwise pollute every ward's status reading).
  const wardStatusMap = useMemo(() => {
    const nurseWardMap = new Map<string, string>();
    for (const n of nurses) {
      if (effectiveFacility && n.facility !== effectiveFacility) continue;
      const primaryWard = n.ward?.split("|")[0];
      if (primaryWard && !isGlobalHead(n.role) && !isMatron(n.role) && !isPorterType(n.role) && !isInternType(n.role)) {
        nurseWardMap.set(n.id, primaryWard);
      }
    }
    const wardStatuses = new Map<string, string[]>();
    for (const a of assignments) {
      const ward = nurseWardMap.get(a.nurse_id);
      if (ward) {
        if (!wardStatuses.has(ward)) wardStatuses.set(ward, []);
        wardStatuses.get(ward)!.push(a.status);
      }
    }
    const map = new Map<string, string>();
    for (const w of facilityFilteredWards) {
      const statuses = wardStatuses.get(w.name) ?? [];
      if (statuses.length === 0) map.set(w.name, "none");
      else if (statuses.includes("published")) map.set(w.name, "published");
      else if (statuses.includes("approved_cno")) map.set(w.name, "approved_cno");
      else if (statuses.includes("approved_chief")) map.set(w.name, "approved_chief");
      else if (statuses.includes("submitted")) map.set(w.name, "submitted");
      else map.set(w.name, "draft");
    }
    return map;
  }, [facilityFilteredWards, assignments, nurses, effectiveFacility]);

  // Non-ward role groups for the facility-wide chip strip.
  const facilityWideGroups = useMemo(() => {
    const seen = new Map<string, number>();
    for (const n of nurses) {
      if (effectiveFacility && n.facility !== effectiveFacility) continue;
      if (isGlobalHead(n.role) || isMatron(n.role) || isPorterType(n.role) || isNADayType(n.role)) {
        seen.set(n.role, (seen.get(n.role) ?? 0) + 1);
      }
    }
    const order = (role: string) => {
      if (isMatron(role)) return 0;
      if (isGlobalHead(role)) return 1;
      if (isNADayType(role)) return 2;
      if (isPorterType(role)) return 3;
      return 4;
    };
    return [...seen.entries()]
      .sort((a, b) => order(a[0]) - order(b[0]))
      .map(([role, count]) => ({ role, count }));
  }, [nurses, effectiveFacility]);

  // ── Actions ───────────────────────────────────────────────────────────────
  function openGenDialog() {
    // Facility and ward are pre-filled from the chip selections; only date is user-editable here.
    setGenForm({
      startDate: ymd(startDate),
      facility: effectiveFacility,
      ward: selectedWard,
      rotateInterns: true,
    });
    setGenPendingLeaves([]); // reset so re-opening always re-checks
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

    // Force-refresh nurse and ward data before building any scheduling inputs.
    // The nurses query caches for 10 minutes, so without this a ward reassignment
    // or role change made on the Staff page would be silently ignored.
    await Promise.all([
      qc.refetchQueries({ queryKey: ["nurses"] }),
      qc.refetchQueries({ queryKey: ["gen-wards", genForm.facility] }),
    ]);
    const nurses = qc.getQueryData<NurseInput[]>(["nurses"]) ?? [];
    const genWards = qc.getQueryData<WardInput[]>(["gen-wards", genForm.facility]) ?? [];

    // Pre-flight: block generation when any nurse in this facility has a Pending
    // leave request that overlaps the period. They must be Approved or Rejected first
    // so the schedule knows whether to mark those days as LEAVE.
    const facilityIds = nurses
      .filter((n) => n.facility === genForm.facility)
      .map((n) => n.id)
      .filter(Boolean);
    if (facilityIds.length > 0) {
      const pending = await api
        .get<{ nurse_name: string; from_date: string; to_date: string }[]>(
          `/leave-requests?status=Pending&nurse_ids=${facilityIds.join(",")}&from_date_lte=${ymd(genEnd)}&to_date_gte=${ymd(genStart)}`,
        )
        .catch(() => []);
      if (pending.length > 0) {
        setGenPendingLeaves(
          pending.map((l) => ({ name: l.nurse_name, from: l.from_date, to: l.to_date })),
        );
        setBusy(false);
        return; // Block until resolved
      }
    }

    setGenPendingLeaves([]);

    const isWardRun = !!genForm.ward;
    const facilityNurses = nurses.filter((n) => n.facility === genForm.facility);
    const facilityHeads = facilityNurses.filter((n) => isGlobalHead(n.role));
    const facilityMatrons = facilityNurses.filter((n) => isMatron(n.role));
    const facilityInterns = facilityNurses.filter((n) => isInternType(n.role));
    const facilityPorters = facilityNurses.filter((n) => isPorterType(n.role));
    const facilityNADay = facilityNurses.filter((n) => isNADayType(n.role));
    // For ward runs, only schedule NA-Day nurses whose assigned ward matches the selected ward.
    // Other wards' NA-Day nurses will be scheduled when their own ward is generated.
    const wardNADay = isWardRun
      ? facilityNADay.filter((n) => parseWards(n.ward)[0] === genForm.ward)
      : facilityNADay;

    // Ward nurses: regular nurses + NAs + senior nurses for the selected ward (or all wards).
    // Matrons, porters, and NA-Day are excluded here and handled separately since they are
    // facility-wide (ward = null) and would otherwise be filtered out of ward runs.
    let wardNurses = facilityNurses.filter(
      (n) =>
        !isGlobalHead(n.role) &&
        !isMatron(n.role) &&
        !isInternType(n.role) &&
        !isPorterType(n.role) &&
        !isNADayType(n.role),
    );
    if (isWardRun) {
      wardNurses = wardNurses.filter((n) => parseWards(n.ward)[0] === genForm.ward);
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

    // For ward runs: include matrons, head nurses, interns, and porters only if they
    // have no existing assignments for this period (first ward run of the 28-day cycle).
    // Subsequent ward runs keep their schedules untouched.
    let includeMatrons = !isWardRun;
    let includeHeads = !isWardRun;
    let includeInterns = !isWardRun;
    let includePorters = !isWardRun;
    let includeNADay = !isWardRun;
    let internsHaveSubmittedAssignments = false;

    if (isWardRun) {
      const [matronsRows, headsRows, internsRows, portersRows, naDayRows] = await Promise.all([
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
                { id: string; status: string }[]
              >(`/shift-assignments?nurse_ids=${facilityInterns.map((n) => n.id).join(",")}&from=${ymd(genStart)}&to=${ymd(genEnd)}&limit=1`)
              .catch(() => [])
          : Promise.resolve([] as { id: string; status: string }[]),
        facilityPorters.length > 0
          ? api
              .get<
                { id: string }[]
              >(`/shift-assignments?nurse_ids=${facilityPorters.map((n) => n.id).join(",")}&from=${ymd(genStart)}&to=${ymd(genEnd)}&limit=1`)
              .catch(() => [])
          : Promise.resolve([] as { id: string }[]),
        wardNADay.length > 0
          ? api
              .get<
                { id: string }[]
              >(`/shift-assignments?nurse_ids=${wardNADay.map((n) => n.id).join(",")}&from=${ymd(genStart)}&to=${ymd(genEnd)}&limit=1`)
              .catch(() => [])
          : Promise.resolve([] as { id: string }[]),
      ]);
      includeMatrons = matronsRows.length === 0 && facilityMatrons.length > 0;
      includeHeads = headsRows.length === 0 && facilityHeads.length > 0;
      includeInterns = internsRows.length === 0 && facilityInterns.length > 0;
      includePorters = portersRows.length === 0 && facilityPorters.length > 0;
      includeNADay = naDayRows.length === 0 && wardNADay.length > 0;
      internsHaveSubmittedAssignments = internsRows.some((r) => r.status !== "draft");
    }

    // ── Period offset (epoch) ────────────────────────────────────────────────
    // Compute how many days have elapsed since the facility's very first scheduled
    // day. This is used both for cycle-phase continuity in generateSchedule AND for
    // the intern rotation base index so the rotation is deterministic by period
    // number rather than depending on the ward currently stored in the nurse's DB
    // profile (which may be stale).
    let periodOffset = 0;
    {
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
          // Slice to 10 chars — the DB can return a full ISO timestamp and
          // appending "T00:00:00" to that produces an unparseable string →
          // Invalid Date → periodOffset = NaN → crash inside scheduleCoverageNurses.
          const epochDate = new Date(epochRows[0].shift_date.slice(0, 10) + "T00:00:00");
          periodOffset = Math.round(
            (genStart.getTime() - epochDate.getTime()) / (24 * 60 * 60 * 1000),
          );
        }
      }
    }

    // Fetch the last 4 days of the previous period so the generator can detect
    // each nurse's actual cycle position and continue from there rather than
    // relying purely on the mathematical periodOffset.
    let previousAssignments: { nurse_id: string; shift_date: string; shift: ShiftCode }[] = [];
    if (periodOffset > 0) {
      const facilityIds = facilityNurses.map((n) => n.id);
      if (facilityIds.length > 0) {
        const prevTo = new Date(genStart);
        prevTo.setDate(prevTo.getDate() - 1);
        const prevFrom = new Date(genStart);
        prevFrom.setDate(prevFrom.getDate() - 5);
        previousAssignments = await api
          .get<{ nurse_id: string; shift_date: string; shift: ShiftCode }[]>(
            `/shift-assignments?nurse_ids=${facilityIds.join(",")}&from=${ymd(prevFrom)}&to=${ymd(prevTo)}`,
          )
          .catch(() => []);
      }
    }

    // Rotate intern ward profiles for this period.
    // Uses the epoch-based period number as the sole rotation signal so the result
    // is identical on any re-generation within the same 28-day period (idempotent).
    // Profile-ward was previously the primary signal but caused interns to step
    // forward once per ward run within a period instead of once per period.
    let internsToSchedule = facilityInterns;
    const shouldRotateInternWards =
      genForm.rotateInterns && facilityInterns.length > 0 && !internsHaveSubmittedAssignments;
    if (shouldRotateInternWards) {
      const facilityWardNames = genWards.map((w) => w.name);

      if (facilityWardNames.length > 0) {
        const sortedInterns = [...facilityInterns].sort((a, b) => a.name.localeCompare(b.name));
        // periodNumber = 0 for period 1, 1 for period 2, 2 for period 3, …
        // Math.round absorbs an off-by-one-day epoch error.
        const periodNumber = Math.round(periodOffset / DAYS);
        const nextBase = periodNumber % facilityWardNames.length;
        internsToSchedule = sortedInterns.map((n, idx) => ({
          ...n,
          ward: facilityWardNames[(nextBase + idx) % facilityWardNames.length],
        }));

        try {
          await Promise.all(
            internsToSchedule.map((n) => api.patch(`/nurses/${n.id}`, { ward: n.ward })),
          );
        } catch (e: unknown) {
          toast.error(e instanceof Error ? e.message : "Failed to rotate intern ward assignments");
          return;
        }
      }
    }

    const schedulingNurses = [
      ...wardNurses,
      ...(includeMatrons ? facilityMatrons : []),
      ...(includeHeads ? facilityHeads : []),
      ...(includeInterns ? internsToSchedule : []),
      ...(includePorters ? facilityPorters : []),
      ...(includeNADay ? wardNADay : []),
    ];

    const facilityOnlyFirst =
      includeMatrons || includeHeads || includeInterns || includePorters || includeNADay;
    const statusNote =
      isWardRun && !facilityOnlyFirst
        ? " (Matron / Coverage Nurses / Nurse Intern / Porter-Day / NA-Day kept from previous run)"
        : isWardRun && facilityOnlyFirst
          ? " (incl. Matron / Coverage Nurses / Nurse Intern / Porter-Day / NA-Day — first run)"
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

      // periodOffset was computed before the rotation block above and is
      // already in scope — no need to re-query the epoch here.

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
        previousAssignments,
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
        toast.warning(
          `Schedule saved — some ward minimums could not be fully met (not enough available staff):\n${lines.join("\n")}`,
          { duration: 8000 },
        );
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
      // Query by date range only — nurse_ids removed to avoid nginx URL-length limit on large
      // rosters. Published keys from other facilities never match draft rows (which are already
      // scoped to this facility's schedulingNurses), so the cross-facility over-fetch is harmless.
      const pubRows = await api
        .get<
          { nurse_id: string; shift_date: string }[]
        >(`/shift-assignments?from=${ymd(genStart)}&to=${ymd(genEnd)}&status=published`)
        .catch(() => []);
      pubRows.forEach((r) => publishedKeys.add(`${r.nurse_id}|${r.shift_date.slice(0, 10)}`));

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
          const existingKeys = new Set(existingRows.map((r) => `${r.nurse_id}|${r.shift_date.slice(0, 10)}`));
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
                  l.from_date.slice(0, 10) <= ds &&
                  l.to_date.slice(0, 10) >= ds,
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
      // 1. Only snap the anchor when generating the CURRENT period (startOffset=0).
      //    Generating a future period (startOffset=1) must not shift the anchor forward —
      //    period 1 stays "Current" until it naturally elapses; period 2 stays "Next".
      if (startOffset === 0) {
        qc.setQueryData(["schedule-window-start", activeRole, genForm.facility], genForm.startDate);
        // Also update the display's anchor key — it's keyed by effectiveFacility (the toolbar
        // filter), which can differ from genForm.facility when the admin has no facility selected.
        // Without this the anchor stays stale and the prefetched data lands in the wrong cache key.
        qc.setQueryData(["schedule-window-start", activeRole, effectiveFacility], genForm.startDate);
      }

      // 2. Force-refresh assignments and wait for the data to land before lifting
      //    the busy overlay.  Three reasons this is the right tool:
      //    • prefetchQuery skips the fetch when data is already in cache (even
      //      stale data from a pre-generation empty fetch within the staleTime window)
      //    • invalidateQueries fires the refetch but doesn't await it, so setBusy(false)
      //      runs before the data arrives and the grid flickers empty
      //    • refetchQueries + await keeps the overlay on-screen until the API responds,
      //      then the grid renders fully populated on the first visible frame
      //    Concurrent users are safe: each browser has its own independent cache;
      //    per-row DB upserts mean simultaneous writes to different wards never conflict.
      await qc.refetchQueries({ queryKey: ["assignments"] });

      // 3. Refresh nurse list (intern ward reassignments).
      qc.invalidateQueries({ queryKey: ["nurses"] });
      setBusy(false);
    }
  }

  async function handleClear() {
    if (isNaN(startDate.getTime())) {
      toast.error("Date range not yet loaded — please wait a moment and try again.");
      return;
    }
    const wardLabel = selectedWard || "all wards";
    if (
      !confirm(
        `Clear draft shifts for ${wardLabel} in this 28-day window?\n\n` +
          (selectedWard
            ? "Matrons, Coverage Nurses, Porters, and Nurse Interns will also be cleared if no other ward has been generated.\n\n"
            : "") +
          "Shifts already submitted for approval, approved, or published will NOT be affected.",
      )
    )
      return;
    setBusy(true);
    try {
      const facilityNurseList = nurses.filter((n) => n.facility === effectiveFacility);

      // Ward-specific nurses (excludes facility-wide roles)
      const wardNurseIds = selectedWard
        ? facilityNurseList
            .filter(
              (n) =>
                !isGlobalHead(n.role) &&
                !isMatron(n.role) &&
                !isPorterType(n.role) &&
                !isInternType(n.role) &&
                !isNADayType(n.role) &&
                parseWards(n.ward)[0] === selectedWard,
            )
            .map((n) => n.id)
        : filteredNurses.map((n) => n.id);

      // NA-Day assigned to this ward specifically (always cleared with the ward)
      const wardNADayIds = selectedWard
        ? facilityNurseList
            .filter((n) => isNADayType(n.role) && parseWards(n.ward)[0] === selectedWard)
            .map((n) => n.id)
        : [];

      // Facility-wide staff (matrons, coverage nurses, porters, interns) are cleared only
      // when no other ward has draft assignments — they were generated on the first ward run.
      let facilityWideIds: string[] = [];
      if (selectedWard) {
        const otherWardNurseIds = facilityNurseList
          .filter(
            (n) =>
              !isGlobalHead(n.role) &&
              !isMatron(n.role) &&
              !isPorterType(n.role) &&
              !isInternType(n.role) &&
              !isNADayType(n.role) &&
              parseWards(n.ward)[0] !== selectedWard,
          )
          .map((n) => n.id);
        let otherWardHasAssignments = false;
        if (otherWardNurseIds.length > 0) {
          const check = await api
            .get<{ id: string }[]>(
              `/shift-assignments?nurse_ids=${otherWardNurseIds.slice(0, 200).join(",")}&from=${ymd(startDate)}&to=${ymd(endDate)}&limit=1`,
            )
            .catch(() => []);
          otherWardHasAssignments = check.length > 0;
        }
        if (!otherWardHasAssignments) {
          facilityWideIds = facilityNurseList
            .filter(
              (n) =>
                isGlobalHead(n.role) ||
                isMatron(n.role) ||
                isPorterType(n.role) ||
                isInternType(n.role),
            )
            .map((n) => n.id);
        }
      }

      const allIdsToClear = [...new Set([...wardNurseIds, ...wardNADayIds, ...facilityWideIds])];
      const BATCH = 200;
      for (let i = 0; i < allIdsToClear.length; i += BATCH) {
        await api.del(
          `/shift-assignments?nurse_ids=${allIdsToClear.slice(i, i + BATCH).join(",")}&from=${ymd(startDate)}&to=${ymd(endDate)}&status=draft`,
        );
      }
      setExtraShifts([]);
      toast.success(`Draft shifts cleared for ${wardLabel}`);
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
    qc.invalidateQueries({ queryKey: ["approvals"] });
  }

  function openShiftPicker(
    e: React.MouseEvent<HTMLButtonElement>,
    nurseId: string,
    dateStr: string,
    ward: string | null,
  ) {
    if (!canEdit) return;
    const existing = cellMap.get(`${nurseId}|${dateStr}`);
    if (existing && existing.status !== "draft") return;
    const rect = e.currentTarget.getBoundingClientRect();
    // Picker is ~220px wide, 40px tall. Clamp so it stays inside the viewport.
    const pickerW = 220;
    const x = Math.min(rect.left, window.innerWidth - pickerW - 8);
    const spaceBelow = window.innerHeight - rect.bottom;
    const above = spaceBelow < 60;
    setShiftPicker({
      nurseId,
      dateStr,
      ward,
      existingId: existing?.id ?? null,
      x,
      y: above ? rect.top - 44 : rect.bottom + 4,
      above,
    });
  }

  async function applyShift(shift: ShiftCode) {
    if (!shiftPicker) return;
    const { nurseId, dateStr, ward, existingId } = shiftPicker;
    setShiftPicker(null);

    if (existingId) {
      // Optimistic: update the cache immediately so the cell reflects the change at once.
      qc.setQueriesData<Assignment[]>({ queryKey: ["assignments"] }, (old) =>
        old?.map((a) => (a.id === existingId ? { ...a, shift } : a)),
      );
      try {
        await api.patch(`/shift-assignments/${existingId}`, { shift });
      } catch (e: unknown) {
        qc.invalidateQueries({ queryKey: ["assignments"] }); // rollback
        toast.error(e instanceof Error ? e.message : "Failed to update");
        return;
      }
    } else {
      // New assignment — no ID yet, so post first then refresh.
      try {
        await api.post("/shift-assignments", {
          nurse_id: nurseId,
          ward,
          shift_date: dateStr,
          shift,
          status: "draft",
          created_by: user?.id ?? null,
        });
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : "Failed to add");
        return;
      }
    }
    qc.invalidateQueries({ queryKey: ["assignments"] });
  }

  async function swapCells(a: Assignment, b: Assignment) {
    if (!canEdit) return;
    // Only swap cells that are both still in draft status.
    if (a.status !== "draft" || b.status !== "draft") return;

    // Optimistic: swap both shifts in the cache immediately.
    qc.setQueriesData<Assignment[]>({ queryKey: ["assignments"] }, (old) =>
      old?.map((x) => {
        if (x.id === a.id) return { ...x, shift: b.shift };
        if (x.id === b.id) return { ...x, shift: a.shift };
        return x;
      }),
    );

    try {
      await Promise.all([
        api.patch(`/shift-assignments/${a.id}`, { shift: b.shift }),
        api.patch(`/shift-assignments/${b.id}`, { shift: a.shift }),
      ]);
      const dateNote =
        a.shift_date.slice(0, 10) === b.shift_date.slice(0, 10) ? a.shift_date.slice(0, 10) : `${a.shift_date.slice(0, 10)} ↔ ${b.shift_date.slice(0, 10)}`;
      await logAudit("Swapped shifts", dateNote);
    } catch (e: unknown) {
      qc.invalidateQueries({ queryKey: ["assignments"] }); // rollback
      toast.error(e instanceof Error ? e.message : "Swap failed");
      return;
    }
    qc.invalidateQueries({ queryKey: ["assignments"] });
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div>
      <PageHeader
        title="Rota"
        subtitle={
          isLoading
            ? "Loading schedule…"
            : hasSchedule
              ? `28-day view · ${days[0].toLocaleDateString()} → ${days[DAYS - 1].toLocaleDateString()}`
              : "Generate a schedule to view the rota"
        }
      />

      {/* Toolbar row 1 */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        {/* Period nav — shown once the window is determined, even on empty next period */}
        {!windowLoading && (
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

        {/* Facility and ward filters moved to card strips below the toolbar */}

        {/* Ward filter — locked for nurse role; otherwise handled by ward chips below */}
        {lockedWard && (
          <span className="h-9 px-3 rounded-md border bg-muted text-sm flex items-center font-medium text-muted-foreground">
            {lockedWard}
          </span>
        )}

        {/* Role filter — hidden for nurse role */}
        {!isNurseTier && (
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
        {!myOnly && !isNurseTier && (
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

      </div>

      {/* Facility card strip — admin/CNO/HR see clickable cards; locked-facility users see a static selected card */}
      {!isNurseTier && !lockedWard && (
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
          {canFilterFacility ? (
            <>
              <button
                type="button"
                onClick={() => { setSelectedFacility(""); setSelectedWard(""); setSelectedRole(""); }}
                className={cn(
                  "shrink-0 inline-flex items-center gap-1.5 h-9 px-4 rounded-xl border text-sm font-medium transition-all",
                  effectiveFacility === ""
                    ? "bg-primary text-primary-foreground border-primary shadow-sm"
                    : "bg-card text-muted-foreground border hover:bg-muted",
                )}
              >
                All facilities
              </button>
              {FACILITIES.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => { setSelectedFacility(f); setSelectedWard(""); setSelectedRole(""); }}
                  className={cn(
                    "shrink-0 inline-flex items-center gap-2 h-9 px-4 rounded-xl border text-sm font-medium transition-all",
                    effectiveFacility === f
                      ? "bg-primary text-primary-foreground border-primary shadow-sm"
                      : "bg-card text-muted-foreground border hover:bg-muted",
                  )}
                >
                  <Building2 className="h-3.5 w-3.5 shrink-0" />
                  {f}
                </button>
              ))}
            </>
          ) : lockedFacility ? (
            <span className="shrink-0 inline-flex items-center gap-2 h-9 px-4 rounded-xl border text-sm font-medium bg-primary/10 text-primary border-primary/30">
              <Building2 className="h-3.5 w-3.5 shrink-0" />
              {lockedFacility}
            </span>
          ) : null}
        </div>
      )}

      {/* Ward chip strip — visible once a specific facility is selected */}
      {!lockedWard && !isNurseTier && effectiveFacility && facilityFilteredWards.length > 0 && (
        <div className="border-t pt-3 pb-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Wards</p>
          <div className="flex gap-2.5 overflow-x-auto pb-2 scrollbar-thin">
          <button
            type="button"
            onClick={() => { setSelectedWard(""); setSelectedFacilityWide(""); }}
            className={cn(
              "shrink-0 inline-flex items-center gap-1.5 h-9 px-4 rounded-full border text-xs font-medium transition-all",
              selectedWard === "" && selectedFacilityWide === ""
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-card text-muted-foreground border hover:bg-muted",
            )}
          >
            All wards
          </button>
          {facilityFilteredWards.map((w) => {
            const status = wardStatusMap.get(w.name) ?? "none";
            const isSelected = selectedWard === w.name;
            const chipCls: Record<string, string> = {
              none: "border-border bg-muted/50 text-muted-foreground",
              draft: "border-amber-200 bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:border-amber-700 dark:text-amber-300",
              submitted: "border-sky-200 bg-sky-50 text-sky-800 dark:bg-sky-950/30 dark:border-sky-700 dark:text-sky-300",
              approved_chief: "border-blue-200 bg-blue-50 text-blue-800 dark:bg-blue-950/30 dark:border-blue-700 dark:text-blue-300",
              approved_cno: "border-violet-200 bg-violet-50 text-violet-800 dark:bg-violet-950/30 dark:border-violet-700 dark:text-violet-300",
              published: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:border-emerald-700 dark:text-emerald-300",
            };
            const dotCls: Record<string, string> = {
              none: "bg-muted-foreground/30",
              draft: "bg-amber-400",
              submitted: "bg-sky-400",
              approved_chief: "bg-blue-400",
              approved_cno: "bg-violet-400",
              published: "bg-emerald-500",
            };
            const statusLabel: Record<string, string> = {
              none: "No draft",
              draft: "Draft",
              submitted: "Submitted",
              approved_chief: "Chief ✓",
              approved_cno: "CNO ✓",
              published: "Published",
            };
            return (
              <button
                key={w.name}
                type="button"
                onClick={() => { setSelectedWard(isSelected ? "" : w.name); setSelectedFacilityWide(""); }}
                className={cn(
                  "shrink-0 inline-flex items-center gap-1.5 h-9 px-4 rounded-full border text-xs font-medium transition-all",
                  chipCls[status] ?? chipCls.none,
                  isSelected && "ring-2 ring-offset-1 ring-primary shadow-sm",
                )}
              >
                <span className={cn("h-2 w-2 rounded-full shrink-0", dotCls[status] ?? dotCls.none)} />
                {w.name}
                <span className="opacity-60 text-[11px]">{statusLabel[status] ?? ""}</span>
              </button>
            );
          })}
          </div>
          {selectedWard && (
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              {isWindowLocked ? (
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 h-9 px-3 rounded-md border text-xs font-medium",
                    windowLockStatus === "published"
                      ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"
                      : windowLockStatus === "approved_cno"
                        ? "border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-700 dark:bg-violet-950/30 dark:text-violet-300"
                        : windowLockStatus === "approved_chief"
                          ? "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950/30 dark:text-blue-300"
                          : "border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-700 dark:bg-sky-950/30 dark:text-sky-300",
                  )}
                >
                  {windowLockStatus === "published" ? (
                    <Lock className="h-3.5 w-3.5" />
                  ) : (
                    <Clock className="h-3.5 w-3.5" />
                  )}
                  {windowLockStatus === "published" && "Published — read only"}
                  {windowLockStatus === "approved_cno" && "CNO Approved — awaiting publication"}
                  {windowLockStatus === "approved_chief" && "Chief Matron Approved — awaiting CNO"}
                  {windowLockStatus === "submitted" && "Submitted — awaiting approval"}
                </span>
              ) : (
                <>
                  {canEdit && wardStatusMap.get(selectedWard) === "draft" && (
                    <button
                      type="button"
                      onClick={handleClear}
                      disabled={busy}
                      className="h-9 px-3 rounded-md border text-sm inline-flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
                    >
                      <Trash2 className="h-4 w-4" /> Clear draft
                    </button>
                  )}
                  {canSubmit && wardStatusMap.get(selectedWard) === "draft" && (
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
          )}
        </div>
      )}

      {/* Facility-wide role chips — non-ward staff (matrons, coverage nurses, porters) */}
      {!lockedWard && !isNurseTier && effectiveFacility && facilityWideGroups.length > 0 && (
        <div className="border-t pt-3 pb-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Facility-wide staff</p>
          <div className="flex gap-2.5 overflow-x-auto pb-1 scrollbar-thin">
          {facilityWideGroups.map(({ role, count }) => {
            const isSelected = selectedFacilityWide === role;
            return (
              <button
                key={role}
                type="button"
                onClick={() => { setSelectedFacilityWide(isSelected ? "" : role); setSelectedWard(""); }}
                className={cn(
                  "shrink-0 inline-flex items-center gap-1.5 h-9 px-4 rounded-full border text-xs font-medium transition-all",
                  isSelected
                    ? "bg-primary text-primary-foreground border-primary ring-2 ring-offset-1 ring-primary shadow-sm"
                    : "bg-card text-muted-foreground border hover:bg-muted",
                )}
              >
                {role}
                <span className="opacity-60 text-[11px]">({count})</span>
              </button>
            );
          })}
          </div>
        </div>
      )}

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
        <div className="bg-card border rounded-xl shadow-soft overflow-hidden p-4 space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
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
          title={isNurseTier ? "Schedule not yet published" : "No schedule for this period"}
          description={
            isNurseTier
              ? "Your schedule for this period has not been published yet. Check back later."
              : "Auto-generate a rota to see the 28-day view. The schedule will appear here once generated."
          }
          action={
            canGenerate && effectiveFacility && selectedWard ? (
              <button
                type="button"
                onClick={openGenDialog}
                className="inline-flex items-center gap-2 h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm"
              >
                <CalendarDays className="h-4 w-4" /> Auto-generate
              </button>
            ) : canGenerate ? (
              <p className="text-xs text-muted-foreground">Select a facility and ward to generate a schedule.</p>
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
                {filteredNurses.flatMap((n, idx) => {
                  const isNonWard =
                    isGlobalHead(n.role) || isMatron(n.role) || isPorterType(n.role) || isNADayType(n.role);
                  const prevIsNonWard =
                    idx > 0 &&
                    (isGlobalHead(filteredNurses[idx - 1].role) ||
                      isMatron(filteredNurses[idx - 1].role) ||
                      isPorterType(filteredNurses[idx - 1].role) ||
                      isNADayType(filteredNurses[idx - 1].role));
                  const showDivider =
                    !selectedWard && !selectedFacilityWide && !lockedWard && isNonWard && !prevIsNonWard;
                  const rows = [];
                  if (showDivider) {
                    rows.push(
                      <tr key="divider-facility-wide" className="border-t-2 border-border/60">
                        <td
                          colSpan={3 + days.length}
                          className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground bg-muted/40"
                        >
                          Facility-wide staff
                        </td>
                      </tr>,
                    );
                  }
                  rows.push(
                  <tr key={n.id} className="border-t hover:bg-muted/30">
                    <td className="px-3 py-2 sticky left-0 bg-card z-10">
                      <div className="font-medium">{n.name}</div>
                      <div className="text-[11px] text-muted-foreground">{n.role}</div>
                    </td>
                    <td className="px-2 py-2 text-muted-foreground text-xs">
                      {(() => {
                        if (isGlobalHead(n.role) || isMatron(n.role) || isPorterType(n.role))
                          return "—";
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
                        cell &&
                        dragging.id !== cell.id &&
                        cell.status === "draft";
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
                            draggable={!!cell && canEdit && cell.status === "draft"}
                            onClick={(e) => openShiftPicker(e, n.id, dateStr, n.ward)}
                            onDragStart={(e) => {
                              if (!cell || !canEdit || cell.status !== "draft") return;
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
                              // Use ref — guaranteed current even before React re-renders.
                              // Allow dropping on any OTHER draft cell (any date, any nurse row).
                              const src = draggingRef.current;
                              if (src && cell && src.id !== cell.id && cell.status === "draft") {
                                e.preventDefault();
                                e.dataTransfer.dropEffect = "move";
                              }
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
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
                              isDragOver && cell?.status === "draft" && "ring-2 ring-primary scale-105",
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
                  </tr>,
                  );
                  return rows;
                })}
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

      {/* Shift picker — appears when a draft cell is clicked */}
      {shiftPicker && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShiftPicker(null)} />
          <div
            className="fixed z-50 flex gap-1 rounded-lg border bg-card p-1.5 shadow-lg"
            style={{ left: shiftPicker.x, top: shiftPicker.y }}
          >
            {(["M", "N", "NC", "MWC", "OFF"] as ShiftCode[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => applyShift(s)}
                className={cn(
                  "min-w-[38px] rounded border px-2 py-1 text-[11px] font-bold transition hover:opacity-75",
                  shiftStyles[s],
                )}
              >
                {s}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Auto-generate dialog */}
      <Dialog
        open={genOpen}
        onOpenChange={(open) => {
          setGenOpen(open);
          if (!open) {
            setGenPendingLeaves([]);
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Generate 28-day schedule</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Facility + ward summary — pre-selected from chips, not editable here */}
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/60 border text-sm">
              <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="font-medium">{genForm.facility}</span>
              <span className="text-muted-foreground">·</span>
              <span>{genForm.ward}</span>
            </div>

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

          {/* Pending leave warning — hard block, no bypass */}
          {genPendingLeaves.length > 0 && (
            <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-950/20 dark:border-red-700 p-3 text-xs space-y-2">
              <p className="font-semibold text-red-800 dark:text-red-300 flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                Cannot generate — {genPendingLeaves.length} pending leave request
                {genPendingLeaves.length > 1 ? "s" : ""} in this period
              </p>
              <ul className="space-y-0.5 text-red-700 dark:text-red-400">
                {genPendingLeaves.map((l, i) => (
                  <li key={i}>
                    • {l.name} — {l.from} → {l.to}
                  </li>
                ))}
              </ul>
              <p className="text-red-600 dark:text-red-500">
                Each pending request must be <strong>Approved</strong> or <strong>Rejected</strong>{" "}
                before the schedule can be generated, so the system knows whether to mark those
                days as leave or keep the nurse on shift.
              </p>
              <Link
                to="/leave"
                onClick={() => { setGenOpen(false); setGenPendingLeaves([]); }}
                className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-red-600 hover:bg-red-700 text-white text-xs font-medium"
              >
                Go to Leave requests
              </Link>
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
              disabled={!genForm.startDate || busy || genPendingLeaves.length > 0}
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
