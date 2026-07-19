import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import {
  FileCheck2,
  CheckCircle2,
  XCircle,
  Clock,
  Send,
  BookOpen,
  FileSpreadsheet,
  FileDown,
  Undo2,
  CalendarRange,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { toast } from "sonner";
import { useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import { isGlobalHead, isInternType, isMatron, isPorterType, isNADayType } from "@/lib/auto-schedule";
import { FacilityChips } from "@/components/FacilityChips";
import { xlsWorkbook, xlsAddAoaSheet, xlsDownload } from "@/lib/excel-export";

export const Route = createFileRoute("/_app/approvals")({
  head: () => ({
    meta: [
      { title: "Approvals — Nurses Rota" },
      {
        name: "description",
        content: "Rota approval workflow: Draft → Chief Matron → CNO → Published.",
      },
    ],
  }),
  component: ApprovalsPage,
});

type PendingRow = {
  id: string;
  shift_date: string;
  status: string;
  nurse_id: string;
  ward: string | null;
  shift: string | null;
};

type WindowStatus = "draft" | "submitted" | "approved_chief" | "approved_cno" | "published";
type FacilityWideGroup = "matron" | "head" | "porter" | "intern" | "naday";

type RotaWindow = {
  startDate: string;
  endDate: string;
  status: WindowStatus;
  assignmentCount: number;
  nurseCount: number;
  ward: string | null;
  facility: string | null;
  roleGroup: FacilityWideGroup | null;
};

type ApprovalStep = { key: string; label: string; status: string };

const STEPS: ApprovalStep[] = [
  { key: "draft", label: "Draft", status: "draft" },
  { key: "submitted", label: "Submitted", status: "submitted" },
  { key: "approved_chief", label: "Chief Matron", status: "approved_chief" },
  { key: "approved_cno", label: "CNO", status: "approved_cno" },
  { key: "published", label: "Published", status: "published" },
];

function dominantStatus(statuses: string[]): WindowStatus {
  if (statuses.includes("published")) return "published";
  if (statuses.includes("approved_cno")) return "approved_cno";
  if (statuses.includes("approved_chief")) return "approved_chief";
  if (statuses.includes("submitted")) return "submitted";
  return "draft";
}

function roleGroupOf(role: string): FacilityWideGroup | null {
  if (isMatron(role)) return "matron";
  if (isGlobalHead(role)) return "head";
  if (isPorterType(role)) return "porter";
  if (isInternType(role)) return "intern";
  if (isNADayType(role)) return "naday";
  return null;
}

function groupIntoWindows(
  rows: PendingRow[],
  nurseToFacility: Map<string, string | null>,
  nurseToRole: Map<string, string>,
): RotaWindow[] {
  if (!rows.length) return [];

  // Group by facility + ward (for ward nurses) or facility + roleGroup (for facility-wide nurses).
  const byKey = new Map<string, PendingRow[]>();
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
      const role = nurseToRole.get(row.nurse_id) ?? "";
      roleGroup = roleGroupOf(role);
      key = `${fac ?? "__NONE__"}|fw|${roleGroup ?? "other"}`;
    }

    if (!byKey.has(key)) {
      byKey.set(key, []);
      keyMeta.set(key, { ward, facility: fac, roleGroup });
    }
    byKey.get(key)!.push(row);
  }

  const windows: RotaWindow[] = [];
  for (const [key, keyRows] of byKey) {
    const { ward, facility, roleGroup } = keyMeta.get(key)!;
    const sorted = [...keyRows].sort((a, b) => a.shift_date.localeCompare(b.shift_date));
    let cluster: PendingRow[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const prev = cluster[cluster.length - 1];
      const diff = Math.round(
        (new Date(sorted[i].shift_date).getTime() - new Date(prev.shift_date).getTime()) /
          86400000,
      );
      // Split at an actual data gap OR when the span from the cluster's first date
      // hits 28 days — consecutive periods share no date gap so diff alone won't split them.
      const spanDays = Math.round(
        (new Date(sorted[i].shift_date).getTime() - new Date(cluster[0].shift_date).getTime()) /
          86400000,
      );
      if (diff > 14 || spanDays >= 28) {
        windows.push(makeWindow(cluster, ward, facility, roleGroup));
        cluster = [];
      }
      cluster.push(sorted[i]);
    }
    if (cluster.length) windows.push(makeWindow(cluster, ward, facility, roleGroup));
  }

  return windows.sort(
    (a, b) =>
      b.startDate.localeCompare(a.startDate) ||
      (a.facility ?? "").localeCompare(b.facility ?? "") ||
      (a.ward ?? a.roleGroup ?? "").localeCompare(b.ward ?? b.roleGroup ?? ""),
  );
}

function makeWindow(
  rows: PendingRow[],
  ward: string | null,
  facility: string | null,
  roleGroup: FacilityWideGroup | null,
): RotaWindow {
  const dates = rows.map((r) => r.shift_date).sort();
  return {
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    status: dominantStatus(rows.map((r) => r.status)),
    assignmentCount: rows.length,
    nurseCount: new Set(rows.map((r) => r.nurse_id)).size,
    ward,
    facility,
    roleGroup,
  };
}

function winKey(win: RotaWindow): string {
  return `${win.startDate}|${win.facility ?? ""}|${win.ward ?? win.roleGroup ?? ""}`;
}

function fmtDate(d: string) {
  return new Date(d.slice(0, 10) + "T00:00:00").toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function scheduleEndDate(startDate: string): string {
  const d = new Date(startDate.slice(0, 10) + "T00:00:00");
  d.setDate(d.getDate() + 27);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  const cur = new Date(start.slice(0, 10) + "T00:00:00");
  const endDt = new Date(end.slice(0, 10) + "T00:00:00");
  while (cur <= endDt) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, "0");
    const d = String(cur.getDate()).padStart(2, "0");
    out.push(`${y}-${m}-${d}`);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

const FW_LABELS: Record<FacilityWideGroup, string> = {
  matron: "Matron",
  head: "Coverage Nurse",
  porter: "Porter",
  intern: "Nurse Intern",
  naday: "Nursing Assistant - Day",
};

const STATUS_LABELS: Record<WindowStatus, string> = {
  draft: "Draft",
  submitted: "Awaiting Chief Matron",
  approved_chief: "Awaiting CNO",
  approved_cno: "Awaiting Publication",
  published: "Published",
};

const STATUS_COLORS: Record<WindowStatus, string> = {
  draft: "bg-muted text-muted-foreground border-border",
  submitted: "bg-amber-100 text-amber-800 border-amber-200",
  approved_chief: "bg-blue-100 text-blue-800 border-blue-200",
  approved_cno: "bg-violet-100 text-violet-800 border-violet-200",
  published: "bg-emerald-100 text-emerald-800 border-emerald-200",
};

function parseWards(ward: string | null): string[] {
  if (!ward) return [];
  return ward.split("|").filter(Boolean);
}

function ApprovalsPage() {
  const {
    user,
    isAdmin,
    activeRole,
    nurseFacility,
    canApproveChiefMatron,
    canApproveCno,
    canPublishRota,
    canSubmitApproval,
    canRevertPublished,
  } = useAuth();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [showAllPeriods, setShowAllPeriods] = useState(false);
  // windowKey → pending leave count that blocked the last submission attempt
  const [pendingLeaveBlocked, setPendingLeaveBlocked] = useState<Record<string, number>>({});

  // Admin, CNO and HR/Admin see all facilities; other roles are locked to their own.
  const lockedFacility =
    isAdmin || activeRole === "cno" || activeRole === "hr_admin"
      ? null
      : (nurseFacility ?? null);
  const [selectedFacility, setSelectedFacility] = useState<string>(lockedFacility ?? "");

  const canApproveChief = canApproveChiefMatron;
  const canApproveCNO = canApproveCno;
  const canPublish = canPublishRota;
  const canSubmit = canSubmitApproval;

  const { data: allNurses = [] } = useQuery({
    queryKey: ["nurses"],
    queryFn: () =>
      api.get<{ id: string; name: string; role: string; ward: string | null; facility: string | null }[]>(
        "/nurses",
      ),
  });

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["approvals"],
    queryFn: async () => {
      const sixAgo = new Date();
      sixAgo.setMonth(sixAgo.getMonth() - 3);
      const threeAhead = new Date();
      threeAhead.setMonth(threeAhead.getMonth() + 3);
      const ymd = (d: Date) => {
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${d.getFullYear()}-${m}-${day}`;
      };
      return api.get<PendingRow[]>(
        `/shift-assignments?from=${ymd(sixAgo)}&to=${ymd(threeAhead)}&limit=50000`,
      );
    },
  });

  // nurse_id → facility / role maps (built once from allNurses).
  const nurseToFacility = useMemo(
    () => new Map(allNurses.map((n) => [n.id, n.facility])),
    [allNurses],
  );
  const nurseToRole = useMemo(
    () => new Map(allNurses.map((n) => [n.id, n.role])),
    [allNurses],
  );

  const windows = useMemo(
    () => groupIntoWindows(rows, nurseToFacility, nurseToRole),
    [rows, nurseToFacility, nurseToRole],
  );

  // Precompute per-window metadata (extraStaff). Facility is now on the window itself.
  const windowMeta = useMemo(() => {
    return new Map(
      windows.map((win) => {
        // For facility-wide cards, scope to only the nurses in that role group.
        let facilityNurses = allNurses.filter((n) => n.facility === win.facility);
        if (win.ward === null && win.roleGroup) {
          facilityNurses = facilityNurses.filter((n) => roleGroupOf(n.role) === win.roleGroup);
        }
        const facilityIdSet = new Set(facilityNurses.map((n) => n.id));
        const winRows = rows.filter(
          (r) =>
            r.shift_date >= win.startDate &&
            r.shift_date <= win.endDate &&
            facilityIdSet.has(r.nurse_id) &&
            (win.ward !== null ? r.ward === win.ward : r.ward === null),
        );
        const winNurseIds = new Set(winRows.map((r) => r.nurse_id));
        const winNurses = allNurses.filter((n) => winNurseIds.has(n.id));

        const winShiftCounts = new Map<string, number>();
        for (const r of winRows) {
          if (r.shift === "M" || r.shift === "N")
            winShiftCounts.set(r.nurse_id, (winShiftCounts.get(r.nurse_id) ?? 0) + 1);
        }
        const byRole = new Map<string, string[]>();
        for (const n of winNurses) {
          const g = byRole.get(n.role) ?? [];
          g.push(n.id);
          byRole.set(n.role, g);
        }
        const extraStaff: { name: string; extra: number }[] = [];
        for (const ids of byRole.values()) {
          const counts = ids.map((id) => winShiftCounts.get(id) ?? 0);
          const baseline = Math.min(...counts);
          for (const id of ids) {
            const diff = (winShiftCounts.get(id) ?? 0) - baseline;
            if (diff > 0) {
              const nurse = winNurses.find((n) => n.id === id);
              if (nurse) extraStaff.push({ name: nurse.name, extra: diff });
            }
          }
        }

        return [winKey(win), { extraStaff }] as const;
      }),
    );
  }, [windows, rows, allNurses]);

  // Facilities that have at least one window — derived directly from window objects.
  const availableFacilities = useMemo(
    () => [...new Set(windows.map((w) => w.facility).filter((f): f is string => !!f))].sort(),
    [windows],
  );

  // Auto-select first available facility when data loads (admin only — non-admins are locked).
  const effectiveFacility =
    selectedFacility ||
    (lockedFacility ?? (availableFacilities.length > 0 ? availableFacilities[0] : ""));

  // Windows that belong to the selected facility.
  const facilityWindows = useMemo(() => {
    if (!effectiveFacility) return windows;
    return windows.filter((win) => win.facility === effectiveFacility);
  }, [windows, effectiveFacility]);

  // For each ward, only the most recent period belongs in approvals.
  // Older fully-published periods are archived in Reports.
  // A fully-published window whose last shift date is more than 14 days ago
  // moves to archive-only — the approvals page shows only active/upcoming work.
  const currentPeriodWindows = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 14);
    const cutoffYmd = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;

    const latestByWard = new Map<string, RotaWindow>();
    for (const win of facilityWindows) {
      if (win.status === "published" && win.endDate < cutoffYmd) continue;
      const wardKey = `${win.facility ?? ""}|${win.ward ?? win.roleGroup ?? "__COVERAGE__"}`;
      const existing = latestByWard.get(wardKey);
      if (!existing || win.startDate > existing.startDate) {
        latestByWard.set(wardKey, win);
      }
    }
    return [...latestByWard.values()];
  }, [facilityWindows]);

  // Group current-period windows by period start, newest first.
  const windowsByPeriod = useMemo(() => {
    const map = new Map<string, RotaWindow[]>();
    for (const win of currentPeriodWindows) {
      const arr = map.get(win.startDate) ?? [];
      arr.push(win);
      map.set(win.startDate, arr);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [currentPeriodWindows]);

  // ── DB actions ─────────────────────────────────────────────────────────────

  type AssignStatus = "draft" | "submitted" | "approved_chief" | "approved_cno" | "published";

  // Scope a status update to nurses who belong to win.facility (+ ward filter).
  async function scopedStatusUpdate(
    win: RotaWindow,
    toStatus: AssignStatus,
    fromStatus?: AssignStatus,
    neqStatus?: AssignStatus,
  ): Promise<string | null> {
    let candidates = allNurses.filter((n) => n.facility === win.facility);
    // For facility-wide role group cards, narrow to just that group's nurses.
    if (win.ward === null && win.roleGroup) {
      candidates = candidates.filter((n) => roleGroupOf(n.role) === win.roleGroup);
    }
    const facilityIds = candidates.map((n) => n.id);
    if (!facilityIds.length) return null;
    try {
      const qs = new URLSearchParams({
        nurse_ids: facilityIds.join(","),
        shift_date_from: win.startDate,
        shift_date_to: win.endDate,
      });
      if (win.ward !== null) qs.set("ward", win.ward);
      else qs.set("ward_null", "true");
      if (fromStatus) qs.set("status", fromStatus);
      if (neqStatus) qs.set("neq_status", neqStatus);
      await api.patch(`/shift-assignments?${qs}`, { status: toStatus });
    } catch (e) {
      return e instanceof Error ? e.message : "Update failed";
    }
    return null;
  }

  async function submitDraft(win: RotaWindow) {
    const wk = winKey(win);
    setBusy(wk);
    try {
      await api.patch(
        `/shift-assignments?${(() => {
          let candidates = allNurses.filter((n) => n.facility === win.facility);
          if (win.ward === null && win.roleGroup)
            candidates = candidates.filter((n) => roleGroupOf(n.role) === win.roleGroup);
          const qs = new URLSearchParams({
            nurse_ids: candidates.map((n) => n.id).join(","),
            shift_date_from: win.startDate,
            shift_date_to: win.endDate,
            status: "draft",
          });
          if (win.ward !== null) qs.set("ward", win.ward);
          else qs.set("ward_null", "true");
          return qs.toString();
        })()}`,
        { status: "submitted" },
      );
      setPendingLeaveBlocked((prev) => { const n = { ...prev }; delete n[wk]; return n; });
      const targetLabel = win.ward ?? (win.roleGroup ? FW_LABELS[win.roleGroup] : "Facility-Wide Staff");
      await api
        .post("/audit-logs", {
          actor_id: user?.id,
          actor_name: user?.email ?? null,
          action: "Submitted rota for approval",
          target: `${targetLabel} · ${fmtDate(win.startDate)} → ${fmtDate(win.endDate)}`,
        })
        .catch(() => {});
      toast.success("Submitted to Chief Matron");
      qc.invalidateQueries({ queryKey: ["approvals"] });
      qc.invalidateQueries({ queryKey: ["assignments"] });
    } catch (e) {
      if (e instanceof ApiError && e.code === "PENDING_LEAVES_EXIST") {
        const count = (e.data.pendingCount as number) ?? 1;
        setPendingLeaveBlocked((prev) => ({ ...prev, [wk]: count }));
        toast.error(e.message, { duration: 8000 });
      } else {
        toast.error(e instanceof Error ? e.message : "Submission failed");
      }
    } finally {
      setBusy(null);
    }
  }

  async function regenerateLeave(win: RotaWindow) {
    const wk = winKey(win);
    setBusy(`regen-${wk}`);
    try {
      let candidates = allNurses.filter((n) => n.facility === win.facility);
      if (win.ward === null && win.roleGroup)
        candidates = candidates.filter((n) => roleGroupOf(n.role) === win.roleGroup);
      await api.post("/shift-assignments/reapply-leave", {
        nurse_ids: candidates.map((n) => n.id),
        from_date: win.startDate,
        to_date: win.endDate,
      });
      // Re-check pending leaves — clear blocked state so Submit is usable again
      setPendingLeaveBlocked((prev) => { const n = { ...prev }; delete n[wk]; return n; });
      toast.success("Leave re-applied to draft. Review the rota, then submit.");
      qc.invalidateQueries({ queryKey: ["approvals"] });
      qc.invalidateQueries({ queryKey: ["assignments"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Regenerate failed");
    } finally {
      setBusy(null);
    }
  }

  type AssignmentStatus = "draft" | "submitted" | "approved_chief" | "approved_cno" | "published";

  async function advance(win: RotaWindow, nextStatus: AssignmentStatus) {
    setBusy(winKey(win));
    const err = await (nextStatus === "published"
      ? scopedStatusUpdate(win, nextStatus, undefined, "published")
      : scopedStatusUpdate(win, nextStatus, win.status));
    setBusy(null);
    if (err) return toast.error(err);
    const targetLabel = win.ward ?? (win.roleGroup ? FW_LABELS[win.roleGroup] : "Facility-Wide Staff");
    await api
      .post("/audit-logs", {
        actor_id: user?.id,
        actor_name: user?.email ?? null,
        action:
          nextStatus === "published"
            ? "Rota published"
            : `Rota approved (${nextStatus.replace(/_/g, " ")})`,
        target: `${targetLabel} · ${fmtDate(win.startDate)} → ${fmtDate(win.endDate)}`,
      })
      .catch(() => {});
    if (nextStatus === "published") {
      const nextStart = scheduleEndDate(win.startDate);
      const nextStartDt = new Date(nextStart + "T00:00:00");
      nextStartDt.setDate(nextStartDt.getDate() + 1);
      const deadlineDt = new Date(nextStartDt);
      deadlineDt.setDate(deadlineDt.getDate() - 14);
      toast.success(
        `Rota published! Next rota (from ${fmtDate(nextStartDt.toISOString().slice(0, 10))}) must be approved by ${fmtDate(deadlineDt.toISOString().slice(0, 10))}.`,
        { duration: 8000 },
      );
    } else {
      toast.success("Approved — moving to next step");
    }
    qc.invalidateQueries({ queryKey: ["approvals"] });
    qc.invalidateQueries({ queryKey: ["assignments"] });
    qc.invalidateQueries({ queryKey: ["rota-reminder"] });
  }

  async function reject(win: RotaWindow) {
    if (!confirm("Return this rota to draft? The submitter will need to resubmit.")) return;
    setBusy(winKey(win));
    const err = await scopedStatusUpdate(win, "draft", win.status);
    setBusy(null);
    if (err) return toast.error(err);
    const rejectLabel = win.ward ?? (win.roleGroup ? FW_LABELS[win.roleGroup] : "Facility-Wide Staff");
    await api
      .post("/audit-logs", {
        actor_id: user?.id,
        actor_name: user?.email ?? null,
        action: "Rota returned to draft",
        target: `${rejectLabel} · ${fmtDate(win.startDate)} → ${fmtDate(win.endDate)}`,
      })
      .catch(() => {});
    toast.success("Returned to draft");
    qc.invalidateQueries({ queryKey: ["approvals"] });
    qc.invalidateQueries({ queryKey: ["assignments"] });
  }

  async function revertPublished(win: RotaWindow) {
    if (
      !confirm(
        "Unpublish this rota and return it to Draft?\n\nThe schedule data is kept exactly as published. You can edit it or auto-generate a new schedule from the Rota page.",
      )
    )
      return;
    setBusy(winKey(win));
    const err = await scopedStatusUpdate(win, "draft", "published");
    setBusy(null);
    if (err) return toast.error(err);
    const revertLabel = win.ward ?? (win.roleGroup ? FW_LABELS[win.roleGroup] : "Facility-Wide Staff");
    await api
      .post("/audit-logs", {
        actor_id: user?.id,
        actor_name: user?.email ?? null,
        action: "Unpublished rota — returned to Draft",
        target: `${revertLabel} · ${fmtDate(win.startDate)} → ${fmtDate(win.endDate)}`,
      })
      .catch(() => {});
    toast.success("Rota unpublished — schedule is unchanged and now editable");
    qc.invalidateQueries({ queryKey: ["approvals"] });
    qc.invalidateQueries({ queryKey: ["assignments"] });
  }

  async function fetchWindowData(win: RotaWindow) {
    const endDate = scheduleEndDate(win.startDate);
    type NurseRow = { id: string; name: string; role: string; ward: string | null; facility: string | null };
    let scopedNurses: NurseRow[] = (allNurses as NurseRow[]).filter(
      (n) => n.facility === win.facility,
    );
    if (win.ward !== null) {
      // Mirror the wardNurses filter in rota.tsx: exclude all facility-level roles
      // (matron, coverage/head, intern, porter, NA-day) even if their nurse profile
      // happens to list this ward — their assignments are stored with ward = null
      // and belong in the coverage card, not the ward card.
      scopedNurses = scopedNurses.filter(
        (n) =>
          !isGlobalHead(n.role) &&
          !isMatron(n.role) &&
          !isInternType(n.role) &&
          !isPorterType(n.role) &&
          !isNADayType(n.role) &&
          parseWards(n.ward).includes(win.ward!),
      );
    } else if (win.roleGroup) {
      // Facility-wide role group card: show only nurses in that specific group.
      scopedNurses = scopedNurses.filter((n) => roleGroupOf(n.role) === win.roleGroup);
    } else {
      // Fallback: all facility-wide roles (shouldn't occur with current grouping).
      scopedNurses = scopedNurses.filter(
        (n) =>
          isGlobalHead(n.role) ||
          isInternType(n.role) ||
          isMatron(n.role) ||
          isPorterType(n.role) ||
          isNADayType(n.role),
      );
    }
    const nurseIds = scopedNurses.map((n) => n.id);
    const allAssignments = nurseIds.length
      ? await api.get<{ nurse_id: string; shift_date: string; shift: string }[]>(
          `/shift-assignments?nurse_ids=${nurseIds.join(",")}&from=${win.startDate}&to=${endDate}&status=published`,
        )
      : [];
    const assignMap = new Map<string, string>();
    allAssignments.forEach((a) => assignMap.set(`${a.nurse_id}|${a.shift_date.slice(0, 10)}`, a.shift));
    const activeIds = new Set(allAssignments.map((a) => a.nurse_id));
    const activeNurses = scopedNurses.filter((n) => activeIds.has(n.id));
    return { activeNurses, assignMap };
  }

  async function handleDownloadExcel(win: RotaWindow) {
    const key = winKey(win);
    setDownloading(key + "-xlsx");
    try {
      const { activeNurses, assignMap } = await fetchWindowData(win);
      const endDate = scheduleEndDate(win.startDate);
      const dates = dateRange(win.startDate, endDate);
      const facilityLabel = win.facility ? ` · ${win.facility}` : "";
      const wardLabel =
        win.ward !== null
          ? ` — ${win.ward}`
          : ` — ${win.roleGroup ? FW_LABELS[win.roleGroup] : "Facility-Wide Staff"}`;
      const title = `Nurse Rota: ${fmtDate(win.startDate)} — ${fmtDate(endDate)}${facilityLabel}${wardLabel}`;
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
      const facilitySlug = win.facility ? `-${win.facility.replace(/\s+/g, "-").toLowerCase()}` : "";
      const fileSuffix =
        win.ward === null
          ? "-coverage-nurses"
          : `-${win.ward.replace(/\s+/g, "-").toLowerCase()}`;
      await xlsDownload(wb, `rota-${win.startDate.slice(0, 10)}-to-${win.endDate.slice(0, 10)}${facilitySlug}${fileSuffix}.xlsx`);
    } catch {
      toast.error("Failed to generate Excel file");
    } finally {
      setDownloading(null);
    }
  }

  function escHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  async function handleDownloadPdf(win: RotaWindow) {
    const key = winKey(win);
    setDownloading(key + "-pdf");
    try {
      const { activeNurses, assignMap } = await fetchWindowData(win);
      const endDate = scheduleEndDate(win.startDate);
      const dates = dateRange(win.startDate, endDate);
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
      const pdfFacilityLabel = win.facility ? ` · ${win.facility}` : "";
      const pdfWardLabel =
        win.ward !== null
          ? ` — ${win.ward}`
          : ` — ${win.roleGroup ? FW_LABELS[win.roleGroup] : "Facility-Wide Staff"}`;
      const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>Nurse Rota ${win.startDate.slice(0, 10)} — ${endDate}${pdfFacilityLabel}${pdfWardLabel}</title>
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
<h1>Nurse Rota${pdfFacilityLabel}${pdfWardLabel}</h1>
<p>${fmtDate(win.startDate)} — ${fmtDate(endDate)} &nbsp;·&nbsp; ${activeNurses.length} staff</p>
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
      const pw = window.open("", "_blank");
      if (!pw) {
        toast.error("Pop-up blocked — allow pop-ups to download the PDF");
        return;
      }
      pw.document.write(html);
      pw.document.close();
    } catch {
      toast.error("Failed to generate PDF");
    } finally {
      setDownloading(null);
    }
  }

  // ── Render a single approval card ──────────────────────────────────────────
  function renderCard(win: RotaWindow) {
    const key = winKey(win);
    const isBusy = busy === key;
    const isDownloadingCard = downloading?.startsWith(key);
    const stepIndex =
      win.status === "published"
        ? STEPS.length
        : STEPS.findIndex((s) => s.status === win.status);

    const meta = windowMeta.get(key);
    const extraStaff = meta?.extraStaff ?? [];

    let canApprove = false;
    let nextStatus: AssignmentStatus = "draft";
    let approveLabel = "";
    if (win.status === "submitted" && canApproveChief) {
      canApprove = true;
      nextStatus = "approved_chief";
      approveLabel = "Approve (Chief Matron)";
    } else if (win.status === "approved_chief" && canApproveCNO) {
      canApprove = true;
      nextStatus = "approved_cno";
      approveLabel = "Approve (CNO)";
    } else if (win.status === "approved_cno" && canPublish) {
      canApprove = true;
      nextStatus = "published";
      approveLabel = "Publish Rota";
    }

    const canReject =
      win.status !== "draft" &&
      win.status !== "published" &&
      ((win.status === "submitted" && canApproveChief) ||
        (win.status === "approved_chief" && canApproveCNO) ||
        (win.status === "approved_cno" && canPublish));

    const showActions =
      (win.status === "draft" && canSubmit) ||
      canApprove ||
      canReject ||
      win.status === "published";
    const pendingLeaveCount = pendingLeaveBlocked[winKey(win)] ?? 0;
    const isRegenBusy = busy === `regen-${winKey(win)}`;

    return (
      <div key={key} className="rounded-xl border bg-card overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-4 py-3.5 border-b flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-snug">
              {win.ward ?? (win.roleGroup ? FW_LABELS[win.roleGroup] : "Facility-Wide Staff")}
            </p>
            {win.facility && (
              <p className="text-xs font-medium text-primary/80 mt-0.5">{win.facility}</p>
            )}
            <p className="text-xs font-medium text-foreground/70 mt-0.5">
              {fmtDate(win.startDate)} — {fmtDate(scheduleEndDate(win.startDate))}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {win.nurseCount} nurses · {win.assignmentCount} assignments
            </p>
            {extraStaff.length > 0 && (
              <p className="text-xs text-orange-600 dark:text-orange-400 mt-1">
                Extra shifts:{" "}
                {extraStaff.map((e) => `${e.name} +${e.extra} extra shift${e.extra > 1 ? "s" : ""}`).join(", ")}
              </p>
            )}
          </div>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full border shrink-0",
              STATUS_COLORS[win.status],
            )}
          >
            {win.status === "published" ? (
              <CheckCircle2 className="h-3 w-3" />
            ) : (
              <Clock className="h-3 w-3" />
            )}
            {STATUS_LABELS[win.status]}
          </span>
        </div>

        {/* Step tracker */}
        <div className="px-4 py-3">
          <ol className="flex items-center gap-0">
            {STEPS.map((step, idx) => {
              const done = idx < stepIndex;
              const active = idx === stepIndex;
              const last = idx === STEPS.length - 1;
              return (
                <li key={step.key} className="flex items-center">
                  <div className="flex flex-col items-center gap-1">
                    <div
                      className={cn(
                        "h-6 w-6 rounded-full border-2 flex items-center justify-center text-xs font-bold",
                        done
                          ? "bg-emerald-500 border-emerald-500 text-white"
                          : active
                            ? "bg-primary border-primary text-primary-foreground"
                            : "bg-muted border-border text-muted-foreground",
                      )}
                    >
                      {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : <span>{idx + 1}</span>}
                    </div>
                    <span
                      className={cn(
                        "text-[9px] whitespace-nowrap",
                        active ? "font-semibold text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {step.label}
                    </span>
                  </div>
                  {!last && (
                    <div
                      className={cn(
                        "h-0.5 w-6 sm:w-10 mx-1 mb-4",
                        done ? "bg-emerald-500" : "bg-border",
                      )}
                    />
                  )}
                </li>
              );
            })}
          </ol>
        </div>

        {/* Actions */}
        {showActions && (
          <div className="border-t bg-muted/30 mt-auto">
            {/* Pending-leave warning banner */}
            {win.status === "draft" && canSubmit && pendingLeaveCount > 0 && (
              <div className="px-4 py-2.5 flex items-start gap-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <p className="text-xs leading-snug">
                  <span className="font-semibold">
                    {pendingLeaveCount} pending leave request{pendingLeaveCount > 1 ? "s" : ""}
                  </span>{" "}
                  must be approved or rejected by the matron before this rota can be submitted.{" "}
                  <a href="/leave" className="underline font-medium">
                    Go to Leave page
                  </a>
                  . After the matron acts, click <strong>Regenerate</strong> to apply the changes, then submit.
                </p>
              </div>
            )}
            <div className="px-4 py-2.5 flex items-center justify-end gap-2 flex-wrap">
            {win.status === "draft" && canSubmit && pendingLeaveCount > 0 && (
              <button
                type="button"
                disabled={isBusy || isRegenBusy}
                onClick={() => regenerateLeave(win)}
                className="h-8 px-3 rounded-md bg-amber-600 text-white text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-50 hover:bg-amber-700"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isRegenBusy ? "animate-spin" : ""}`} />
                {isRegenBusy ? "Regenerating…" : "Regenerate"}
              </button>
            )}
            {win.status === "draft" && canSubmit && pendingLeaveCount === 0 && (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => submitDraft(win)}
                className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <Send className="h-3.5 w-3.5" /> Submit
              </button>
            )}
            {canReject && (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => reject(win)}
                className="h-8 px-3 rounded-md border bg-card text-xs inline-flex items-center gap-1.5 hover:bg-destructive/10 hover:border-destructive hover:text-destructive disabled:opacity-50"
              >
                <XCircle className="h-3.5 w-3.5" /> Return
              </button>
            )}
            {canApprove && (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => advance(win, nextStatus)}
                className={cn(
                  "h-8 px-3 rounded-md text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-50",
                  nextStatus === "published"
                    ? "bg-emerald-600 text-white hover:bg-emerald-700"
                    : "bg-primary text-primary-foreground hover:opacity-90",
                )}
              >
                {nextStatus === "published" ? (
                  <BookOpen className="h-3.5 w-3.5" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                {approveLabel}
              </button>
            )}
            {win.status === "published" && (
              <>
                {canRevertPublished && (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => revertPublished(win)}
                    className="h-8 px-3 rounded-md border bg-card text-xs inline-flex items-center gap-1.5 hover:bg-amber-50 hover:border-amber-400 hover:text-amber-700 disabled:opacity-50"
                    title="Admin only — returns schedule to Draft (data unchanged)"
                  >
                    <Undo2 className="h-3.5 w-3.5" /> Unpublish
                  </button>
                )}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button
                    type="button"
                    disabled={!!isDownloadingCard}
                    onClick={() => handleDownloadExcel(win)}
                    className="h-8 px-3 rounded-md border bg-card text-xs inline-flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
                  >
                    <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-600" />
                    {downloading === key + "-xlsx" ? "…" : "Excel"}
                  </button>
                  <button
                    type="button"
                    disabled={!!isDownloadingCard}
                    onClick={() => handleDownloadPdf(win)}
                    className="h-8 px-3 rounded-md border bg-card text-xs inline-flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
                  >
                    <FileDown className="h-3.5 w-3.5 text-red-500" />
                    {downloading === key + "-pdf" ? "…" : "PDF"}
                  </button>
                </div>
              </>
            )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Page render ────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      <PageHeader title="Approval Workflow" subtitle="Draft → Chief Matron → CNO → Published" />

      {isLoading ? (
        <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>
      ) : windows.length === 0 ? (
        <EmptyState
          icon={<FileCheck2 className="h-6 w-6" />}
          title="No rotas found"
          description="Generate a rota from the Rota page — it will appear here once created."
        />
      ) : (
        <>
          {/* Facility chip strip */}
          <FacilityChips
            value={effectiveFacility}
            onChange={setSelectedFacility}
            locked={!!lockedFacility}
            showAll={false}
          />

          {/* Periods for the selected facility */}
          {windowsByPeriod.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No active schedules for {effectiveFacility}. Published rotas older than 14 days are
              in{" "}
              <span className="font-medium text-foreground">Reports → Schedule Archive</span>.
              Generate a new rota from the{" "}
              <span className="font-medium text-foreground">Rota</span> page.
            </p>
          ) : (
            <div className="space-y-8">
              {(showAllPeriods ? windowsByPeriod : windowsByPeriod.slice(0, 1)).map(
                ([periodStart, periodWins]) => {
                  const periodEnd = scheduleEndDate(periodStart);
                  const coverageWins = periodWins.filter((w) => w.ward === null);
                  const wardWins = periodWins.filter((w) => w.ward !== null);
                  return (
                    <div key={periodStart}>
                      {/* Period header */}
                      <div className="flex items-center gap-2 mb-4">
                        <CalendarRange className="h-4 w-4 text-muted-foreground shrink-0" />
                        <h2 className="text-sm font-semibold text-foreground">
                          {fmtDate(periodStart)} — {fmtDate(periodEnd)}
                        </h2>
                        <span className="text-xs text-muted-foreground">
                          · {periodWins.length} schedule{periodWins.length !== 1 ? "s" : ""}
                        </span>
                        <div className="flex-1 h-px bg-border ml-1" />
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                        {[...coverageWins, ...wardWins].map((win) => renderCard(win))}
                      </div>
                    </div>
                  );
                },
              )}

              {windowsByPeriod.length > 1 && (
                <div className="flex justify-center pt-2">
                  <button
                    type="button"
                    onClick={() => setShowAllPeriods((v) => !v)}
                    className="text-xs text-muted-foreground hover:text-foreground underline"
                  >
                    {showAllPeriods
                      ? "Show fewer periods"
                      : `Show ${windowsByPeriod.length - 1} older period${windowsByPeriod.length - 1 !== 1 ? "s" : ""}`}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
