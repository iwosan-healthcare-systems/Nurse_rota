import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useEffect, useMemo, useState } from "react";
import {
  Plus,
  Check,
  X,
  PlaneTakeoff,
  ArrowLeftRight,
  Loader2,
  Lock,
  Pencil,
  Search,
  Undo2,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { EmptyState } from "@/components/EmptyState";
import { Modal } from "./staff";
import { toast } from "sonner";
import { logAudit } from "@/lib/audit";
import { Pagination, usePagination } from "@/components/Pagination";
import { FacilityChips } from "@/components/FacilityChips";

export const Route = createFileRoute("/_app/leave")({
  component: LeavePage,
});

type LeaveRow = {
  id: string;
  nurse_id: string | null;
  nurse_name: string;
  nurse_role: string | null;
  requested_by: string | null;
  requested_by_name: string | null;
  type: string;
  from_date: string;
  to_date: string;
  status: "Pending" | "Approved" | "Rejected" | "Expired" | "Reverted";
  reason: string | null;
  review_note: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  revert_reason: string | null;
  created_at: string;
};

// Shift switch requests are stored as leave_requests with type="Swap" and
// a reason field that starts with the SWITCH_PREFIX sentinel.
const SWITCH_PREFIX = "SHIFT_SWITCH|";

function parseSwitch(row: LeaveRow) {
  if (!row.reason?.startsWith(SWITCH_PREFIX)) return null;
  const parts = row.reason.slice(SWITCH_PREFIX.length).split("|");
  const nurseBId = parts[0] ?? "";
  const nurseBName = parts[1] ?? "";
  const shiftA = parts[2] ?? "";
  const shiftB = parts[3] ?? "";
  let interWard = false;
  let isDirect = false;
  let note = "";
  for (let i = 4; i < parts.length; i++) {
    if (parts[i] === "INTER_WARD") interWard = true;
    else if (parts[i] === "DIRECT") isDirect = true;
    else if (parts[i].startsWith("NOTE:")) note = parts.slice(i).join("|").slice(5);
  }
  return { nurseBId, nurseBName, shiftA, shiftB, date: row.from_date, interWard, isDirect, note };
}

function isShiftSwitch(row: LeaveRow) {
  return row.type === "Swap" && row.reason?.startsWith(SWITCH_PREFIX);
}

function isMorningType(shift: string) {
  return shift === "M" || shift === "MWC";
}
function isNightType(shift: string) {
  return shift === "N" || shift === "NC";
}

// A Night shift runs 17:00 day D -> 08:00 day D+1; a Morning shift runs 08:00 -> 17:00
// the same day. Either ordering back-to-back leaves zero rest: a Night the day before
// ending 08:00 immediately followed by a Morning starting 08:00 that same day, or a
// Morning ending 17:00 immediately followed by a Night starting 17:00 that same day.
function hasRestConflict(
  prevDayShift: string | null | undefined,
  newShift: string,
  nextDayShift: string | null | undefined,
) {
  if (isNightType(prevDayShift ?? "") && isMorningType(newShift)) return true;
  if (isNightType(newShift) && isMorningType(nextDayShift ?? "")) return true;
  return false;
}

// A nurse's published shift the day before and the day after `date` — used to check a
// proposed new shift for that nurse on `date` won't create a zero-rest back-to-back
// with a shift she's already published for on an adjacent day.
async function fetchAdjacentShifts(nurseId: string, date: string) {
  const d = new Date(date.slice(0, 10) + "T00:00:00");
  const prev = new Date(d);
  prev.setDate(prev.getDate() - 1);
  const next = new Date(d);
  next.setDate(next.getDate() + 1);
  const fmt = (x: Date) =>
    `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  const [prevArr, nextArr] = await Promise.all([
    api.get<{ shift: string }[]>(
      `/shift-assignments?nurse_id=${nurseId}&shift_date=${fmt(prev)}&status=published&limit=1`,
    ),
    api.get<{ shift: string }[]>(
      `/shift-assignments?nurse_id=${nurseId}&shift_date=${fmt(next)}&status=published&limit=1`,
    ),
  ]);
  return { prevShift: prevArr[0]?.shift ?? null, nextShift: nextArr[0]?.shift ?? null };
}

const statusStyle: Record<string, string> = {
  Pending: "bg-warning/20 text-warning-foreground",
  Approved: "bg-success/15 text-success",
  Rejected: "bg-destructive/15 text-destructive",
  Reverted: "bg-violet-100 text-violet-700",
};

// A "Rejected" row with no reviewer was auto-declined by the deadline cron
// (jobs/auto-decline-requests.js never sets reviewed_by) rather than actively
// rejected by a person — show that distinctly so it doesn't read as someone
// having reviewed and turned it down. "Expired" (auto-generate-rota.js, when
// generation reaches a request nobody decided on) is the same "system closed
// this out, not a person" situation, so it gets the same treatment.
function statusDisplay(l: LeaveRow): { label: string; className: string } {
  if ((l.status === "Rejected" && !l.reviewed_by_name) || l.status === "Expired") {
    return { label: "Time Elapsed", className: "bg-muted text-muted-foreground" };
  }
  return { label: l.status, className: statusStyle[l.status] };
}

type StatusFilter = "All" | "Pending" | "Approved" | "Rejected" | "Reverted";
type ActiveTab = "leave" | "switches";

type WorkflowStatus = {
  firstRotaPublished: boolean;
  nextPeriodStart?: string;
  leaveClosureDate?: string;
  publishDeadline?: string;
  leaveIsClosed?: boolean;
  nextRotaStage?: string;
};

type EntitlementInfo = {
  cap: number;
  used: number;
  remaining: number;
  exhausted: boolean;
  // Set on "Annual" when it's hidden not because the day cap is used up, but
  // because this nurse has a Pending/Approved Maternity leave request this
  // year — Annual is blocked for the rest of that year either way.
  blockedReason?: "maternity" | null;
  period: "year" | "month";
  windowStart: string;
  windowEnd: string;
};
type EntitlementUsage = Record<string, EntitlementInfo>;

function fmtDateLeave(d: string) {
  return new Date(d.slice(0, 10) + "T00:00:00").toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function addDaysLeaveYmd(dateStr: string, n: number) {
  const d = new Date(dateStr.slice(0, 10) + "T00:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Local calendar date, not UTC — new Date().toISOString().slice(0,10) reads the UTC date,
// which lags the real local date by one day during the ~00:00–01:00 WAT window (UTC+1).
function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function LeavePage() {
  const {
    user,
    nurseId,
    canApproveLeave,
    canApproveMatronLeave,
    canViewAllLeaveRequests,
    canRequestLeave,
    canRequestShiftSwitch,
    canApproveShiftSwitch,
    nurseFacility,
    isAdmin,
    activeRole,
  } = useAuth();
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [showSwitch, setShowSwitch] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");
  const [activeTab, setActiveTab] = useState<ActiveTab>("leave");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");

  const { data: workflowStatus } = useQuery<WorkflowStatus>({
    queryKey: ["workflow-status"],
    staleTime: 5 * 60 * 1000,
    queryFn: () => api.get<WorkflowStatus>("/rpc/workflow-status"),
  });

  // CNO and admin see all facilities; every other approver is scoped to their own facility.
  const isCnoOrAdmin = isAdmin || activeRole === "cno";
  const canFilterFacility = isCnoOrAdmin || activeRole === "hr_admin";
  const lockedFacility: string | null = canFilterFacility ? null : (nurseFacility ?? null);
  const [selectedFacility, setSelectedFacility] = useState("");
  // When locked to a facility, ignore the chip selection.
  const facilityScope: string | null = lockedFacility ?? (selectedFacility || null);

  // Fetch nurses to build facility + role maps (used for column badges and matron-leave gating).
  const { data: nurses = [] } = useQuery<{ id: string; name: string; facility: string | null; role: string | null }[]>({
    queryKey: ["nurses"],
    staleTime: 10 * 60 * 1000,
    queryFn: () => api.get("/nurses"),
  });
  const nurseToFacility = useMemo(
    () => new Map(nurses.map((n) => [n.id, n.facility])),
    [nurses],
  );

  // Any approval role (leave OR shift-switch OR matron-leave) gets the full list for their scope —
  // as does a pure view-only role (e.g. hr_admin, service_support) via canViewAllLeaveRequests.
  const canSeeAll =
    canApproveLeave || canApproveShiftSwitch || canApproveMatronLeave || canViewAllLeaveRequests;

  // Per-row approval info: determines both whether the user can approve AND what label to show.
  // nurse_role comes directly from the API (LEFT JOIN nurses), so it's always current.
  function rowApprovalInfo(row: LeaveRow): { canApprove: boolean; blockedLabel: string } {
    const isMatronLeave = row.nurse_role === "chief_matron";
    return {
      canApprove: isMatronLeave ? canApproveMatronLeave : canApproveLeave,
      blockedLabel: isMatronLeave ? "CNO approval required" : "Chief Matron approval required",
    };
  }

  // True if this user can approve ANY kind of leave (drives column visibility).
  const isAnyLeaveApprover = canApproveLeave || canApproveMatronLeave;

  const { data: rows = [], isLoading } = useQuery({
    queryKey: canSeeAll ? ["leave", facilityScope] : ["leave", "mine", user?.id, nurseId, facilityScope],
    refetchInterval: 30 * 1000,
    queryFn: async () => {
      if (canSeeAll) {
        const qs = facilityScope ? `?facility=${encodeURIComponent(facilityScope)}` : "";
        return api.get<LeaveRow[]>(`/leave-requests${qs}`);
      }

      // Three queries for non-approvers:
      // 1. Own submissions (self-submitted leave/switches).
      // 2. Switches where this nurse is Nurse B (target).
      // 3. Anything where this nurse is the beneficiary (nurse_id) — covers both
      //    switches submitted on their behalf AND regular leave a Chief Matron or
      //    Admin submitted for them (requested_by won't match their own user id).
      const [ownRows, nurseBSwitchRows, beneficiaryRows] = await Promise.all([
        api.get<LeaveRow[]>(`/leave-requests?requested_by=${user!.id}`),
        nurseId
          ? api.get<LeaveRow[]>(`/leave-requests?switch_nurse_b=${nurseId}`).catch(() => [] as LeaveRow[])
          : Promise.resolve([] as LeaveRow[]),
        nurseId
          ? api.get<LeaveRow[]>(`/leave-requests?nurse_id=${nurseId}`)
          : Promise.resolve([] as LeaveRow[]),
      ]);

      // Merge and deduplicate
      const seen = new Set<string>();
      const merged: LeaveRow[] = [];
      for (const row of [...ownRows, ...nurseBSwitchRows, ...beneficiaryRows]) {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          merged.push(row);
        }
      }
      return merged.sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
  });

  // Split into leave requests and shift switch requests
  const leaveRows = rows.filter((r) => !isShiftSwitch(r));
  const switchRows = rows.filter((r) => isShiftSwitch(r));
  const activeRows = activeTab === "leave" ? leaveRows : switchRows;

  // Standard credited hours per shift type (matches official shift windows).
  const LEAVE_SHIFT_HOURS: Record<"M" | "N" | "MWC" | "NC", number> = { M: 9, N: 15, MWC: 9, NC: 15 };

  function buildLeaveShiftLog(
    nurseId: string,
    leaveId: string,
    shiftDate: string,
    shift: "M" | "N" | "MWC" | "NC",
  ) {
    const isMorningType = shift === "M" || shift === "MWC";
    // Africa/Lagos is a fixed UTC+1 offset (no DST) — build the instant
    // explicitly with that offset rather than via setHours()/toISOString(),
    // which are wrong whenever the approving admin's browser/OS clock isn't
    // itself set to WAT (this previously caused leave credits to show 1 hour
    // late, e.g. 09:00/18:00 instead of 08:00/17:00).
    const startedAt = new Date(`${shiftDate}T${isMorningType ? "08" : "17"}:00:00+01:00`);
    const endedAt = isMorningType
      ? new Date(`${shiftDate}T17:00:00+01:00`)
      : new Date(new Date(`${shiftDate}T08:00:00+01:00`).getTime() + 24 * 60 * 60 * 1000);
    return {
      nurse_id: nurseId,
      shift_date: shiftDate,
      shift_type: shift,
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      expected_end_at: endedAt.toISOString(),
      hours_logged: LEAVE_SHIFT_HOURS[shift],
      period_start: shiftDate,
      is_late: false,
      is_leave: true,
      leave_request_id: leaveId,
    };
  }

  // Notify the beneficiary nurse directly by profile lookup — separate from the
  // `requested_by` notification, since a Chief Matron/Admin submitting on a staff
  // member's behalf means `requested_by` is the submitter, not the beneficiary.
  async function notifyBeneficiary(l: LeaveRow, status: "Approved" | "Rejected") {
    if (!l.nurse_name) return;
    const profiles = await api
      .get<{ id: string }[]>(`/profiles?full_name=${encodeURIComponent(l.nurse_name)}`)
      .catch(() => [] as { id: string }[]);
    const profileId = profiles[0]?.id;
    if (!profileId || profileId === l.requested_by) return;
    await api
      .post("/notifications/upsert", [
        { user_id: profileId, notif_key: `leave_${status.toLowerCase()}_${l.id}_staff`, is_read: false },
      ])
      .catch(() => {});
  }

  async function reviewLeave(l: LeaveRow, status: "Approved" | "Rejected", note = "") {
    try {
      if (status === "Approved" && l.nurse_id) {
        const publishedShifts = await api.get<{ id: string; shift_date: string; shift: string }[]>(
          `/shift-assignments?nurse_id=${l.nurse_id}&from=${l.from_date}&to=${l.to_date}&status=published&shift_in=M,N,MWC,NC`,
        );

        if (publishedShifts.length > 0) {
          // The backend flips shifts to LEAVE atomically inside the leave-request
          // PATCH transaction below — no need to PATCH each assignment individually here.

          const existingLogs = await api.get<{ shift_date: string }[]>(
            `/shift-logs?nurse_id=${l.nurse_id}&shift_date_in=${publishedShifts.map((s) => s.shift_date).join(",")}`,
          );
          const alreadyLogged = new Set(existingLogs.map((e) => e.shift_date));
          const today = todayYmd();
          const shiftsToCredit = publishedShifts.filter(
            (s) =>
              !alreadyLogged.has(s.shift_date) &&
              (s.shift === "M" || s.shift === "N" || s.shift === "MWC" || s.shift === "NC") &&
              s.shift_date <= today,
          );

          if (shiftsToCredit.length > 0) {
            await api
              .post(
                "/shift-logs/bulk",
                shiftsToCredit.map((s) =>
                  buildLeaveShiftLog(l.nurse_id!, l.id, s.shift_date, s.shift as "M" | "N" | "MWC" | "NC"),
                ),
              )
              .catch(() => {});
            const totalHours = shiftsToCredit.reduce(
              (sum, s) => sum + (LEAVE_SHIFT_HOURS[s.shift as "M" | "N" | "MWC" | "NC"] ?? 0),
              0,
            );
            await api
              .post("/rpc/increment-nurse-hours", { p_nurse_id: l.nurse_id, p_hours: totalHours })
              .catch(() => {});
          }

          await api.patch(`/leave-requests/${l.id}`, {
            status: "Approved",
            reviewed_by: user?.id,
            reviewed_at: new Date().toISOString(),
            review_note: note || null,
          });

          const mDates = publishedShifts.filter((s) => s.shift === "M" || s.shift === "MWC").map((s) => s.shift_date);
          const nDates = publishedShifts.filter((s) => s.shift === "N" || s.shift === "NC").map((s) => s.shift_date);
          const parts: string[] = [];
          if (mDates.length > 0) parts.push(`${mDates.length} Morning (${mDates.join(", ")})`);
          if (nDates.length > 0) parts.push(`${nDates.length} Night (${nDates.join(", ")})`);
          toast.success(
            `Leave approved — rota updated. Chief Matron: arrange cover for ${parts.join("; ")}.`,
            { duration: 8000 },
          );
          logAudit(
            `Approved leave (post-publish): ${publishedShifts.length} shift(s) marked LEAVE`,
            l.nurse_name,
          );
          if (l.requested_by) {
            await api
              .post("/notifications/upsert", [
                { user_id: l.requested_by, notif_key: `leave_approved_${l.id}`, is_read: false },
              ])
              .catch(() => {});
          }
          await notifyBeneficiary(l, "Approved");
          // Notify the approver to consider arranging shift cover.
          if (user?.id && (l.type === "Sick" || l.type === "Emergency")) {
            await api
              .post("/notifications/upsert", [
                { user_id: user.id, notif_key: `leave_cover_needed_${l.id}`, is_read: false },
              ])
              .catch(() => {});
          }
          qc.invalidateQueries({ queryKey: ["leave"] });
          qc.invalidateQueries({ queryKey: ["assignments"] });
          return;
        }
      }

      // No locked working shifts in this window (draft rota or Rejected) — standard path.
      await api.patch(`/leave-requests/${l.id}`, {
        status,
        reviewed_by: user?.id,
        reviewed_at: new Date().toISOString(),
        review_note: note || null,
      });
      toast.success(`Leave ${status.toLowerCase()}`);
      logAudit(`${status} leave request`, l.nurse_name);
      if (l.requested_by) {
        await api
          .post("/notifications/upsert", [
            {
              user_id: l.requested_by,
              notif_key: `leave_${status.toLowerCase()}_${l.id}`,
              is_read: false,
            },
          ])
          .catch(() => {});
      }
      await notifyBeneficiary(l, status);
      if (status === "Approved" && user?.id && (l.type === "Sick" || l.type === "Emergency")) {
        await api
          .post("/notifications/upsert", [
            { user_id: user.id, notif_key: `leave_cover_needed_${l.id}`, is_read: false },
          ])
          .catch(() => {});
      }
      qc.invalidateQueries({ queryKey: ["leave"] });
      // When approved, the backend now flips shift_assignments to LEAVE.
      // Invalidate all caches that show shift data so the nurse's dashboard
      // and shift page reflect the change without a manual refresh.
      if (status === "Approved") {
        qc.invalidateQueries({ queryKey: ["assignments"] });
        qc.invalidateQueries({ queryKey: ["my-assignment"] });
        qc.invalidateQueries({ queryKey: ["my-today-assignment"] });
        qc.invalidateQueries({ queryKey: ["my-upcoming"] });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update leave request");
    }
  }

  async function reviewSwitch(l: LeaveRow, status: "Approved" | "Rejected", note = "") {
    try {
      if (status === "Approved") {
        const sw = parseSwitch(l);
        if (!sw) return toast.error("Invalid shift switch data");

        const [arrA, arrB] = await Promise.all([
          api.get<{ id: string; shift: string }[]>(
            `/shift-assignments?nurse_id=${l.nurse_id ?? ""}&shift_date=${sw.date.slice(0, 10)}&status=published&limit=1`,
          ),
          api.get<{ id: string; shift: string }[]>(
            `/shift-assignments?nurse_id=${sw.nurseBId}&shift_date=${sw.date.slice(0, 10)}&status=published&limit=1`,
          ),
        ]);
        const assignA = arrA[0] ?? null;
        const assignB = arrB[0] ?? null;

        if (!assignA || !assignB) {
          return toast.error(
            "Cannot apply switch — one or both nurses have no published shift on that date.",
          );
        }

        if (assignA.shift === "LEAVE") {
          const targetShift = sw.shiftA === "M" || sw.shiftA === "N" ? sw.shiftA : null;
          if (!targetShift) {
            return toast.error(
              "Cannot apply — no valid working shift (M/N) was recorded for Nurse A at request time. Please re-submit the switch request.",
            );
          }
          // Re-validate the rest conflict at approval time too — the day-before/after
          // assignments may have changed since this was submitted.
          const { prevShift, nextShift } = await fetchAdjacentShifts(sw.nurseBId, sw.date);
          if (hasRestConflict(prevShift, targetShift, nextShift)) {
            return toast.error(
              `Cannot approve — this would leave ${sw.nurseBName} with no rest between shifts on ${sw.date} (check the day before/after). Reject this request instead.`,
            );
          }
          // Idempotent: skip if nurse B already has the target shift (retry-safe).
          if (assignB.shift !== targetShift) {
            await api.patch(`/shift-assignments/${assignB.id}`, { shift: targetShift });
            qc.invalidateQueries({ queryKey: ["assignments"] });
          }
          logAudit(
            `Leave coverage applied: ${sw.nurseBName} covers ${l.nurse_name}'s ${targetShift} shift`,
            sw.date,
          );
        } else {
          // Re-validate rest conflicts at approval time for BOTH nurses — each one
          // takes on the other's current shift, and either side could create a
          // zero-rest back-to-back against their own already-published adjacent days.
          const [adjA, adjB] = await Promise.all([
            fetchAdjacentShifts(l.nurse_id ?? "", sw.date),
            fetchAdjacentShifts(sw.nurseBId, sw.date),
          ]);
          if (hasRestConflict(adjA.prevShift, assignB.shift, adjA.nextShift)) {
            return toast.error(
              `Cannot approve — this would leave ${l.nurse_name} with no rest between shifts on ${sw.date} (check the day before/after). Reject this request instead.`,
            );
          }
          if (hasRestConflict(adjB.prevShift, assignA.shift, adjB.nextShift)) {
            return toast.error(
              `Cannot approve — this would leave ${sw.nurseBName} with no rest between shifts on ${sw.date} (check the day before/after). Reject this request instead.`,
            );
          }
          // Idempotent: skip if shifts are already in the swapped state (retry-safe).
          const alreadySwapped = assignA.shift === sw.shiftB && assignB.shift === sw.shiftA;
          if (!alreadySwapped) {
            await Promise.all([
              api.patch(`/shift-assignments/${assignA.id}`, { shift: assignB.shift }),
              api.patch(`/shift-assignments/${assignB.id}`, { shift: assignA.shift }),
            ]);
            qc.invalidateQueries({ queryKey: ["assignments"] });
          }
          logAudit(
            `Applied shift switch on published rota: ${l.nurse_name} ↔ ${sw.nurseBName}`,
            sw.date,
          );
        }
      }

      await api.patch(`/leave-requests/${l.id}`, {
        status,
        reviewed_by: user?.id,
        reviewed_at: new Date().toISOString(),
        review_note: note || null,
      });
      toast.success(
        status === "Approved" ? "Switch approved and applied to published rota" : "Switch rejected",
      );

      // Notify the initiator (matron/CNO who submitted the request).
      if (l.requested_by) {
        await api
          .post("/notifications/upsert", [
            {
              user_id: l.requested_by,
              notif_key: `switch_${status.toLowerCase()}_${l.id}_initiator`,
              is_read: false,
            },
          ])
          .catch(() => {});
      }
      const swInfo = parseSwitch(l);
      // Notify Nurse A by profile lookup (they are the subject, not necessarily the submitter).
      if (l.nurse_name) {
        const profilesA = await api
          .get<{ id: string }[]>(`/profiles?full_name=${encodeURIComponent(l.nurse_name)}`)
          .catch(() => [] as { id: string }[]);
        const profileAId = profilesA[0]?.id;
        if (profileAId) {
          await api
            .post("/notifications/upsert", [
              {
                user_id: profileAId,
                notif_key: `switch_${status.toLowerCase()}_${l.id}`,
                is_read: false,
              },
            ])
            .catch(() => {});
        }
      }
      // Notify Nurse B.
      if (swInfo?.nurseBName) {
        const profilesB = await api
          .get<{ id: string }[]>(`/profiles?full_name=${encodeURIComponent(swInfo.nurseBName)}`)
          .catch(() => [] as { id: string }[]);
        const profileBId = profilesB[0]?.id;
        if (profileBId) {
          await api
            .post("/notifications/upsert", [
              {
                user_id: profileBId,
                notif_key: `switch_${status.toLowerCase()}_${l.id}_b`,
                is_read: false,
              },
            ])
            .catch(() => {});
        }
      }
      qc.invalidateQueries({ queryKey: ["leave"] });
    } catch {
      toast.error("Failed to update switch request");
    }
  }

  const counts = {
    Pending: activeRows.filter((r) => r.status === "Pending").length,
    Approved: activeRows.filter((r) => r.status === "Approved").length,
    Rejected: activeRows.filter((r) => r.status === "Rejected").length,
    Reverted: activeRows.filter((r) => r.status === "Reverted").length,
  };

  const visibleRows = (statusFilter === "All" ? activeRows : activeRows.filter((r) => r.status === statusFilter))
    .filter((r) => {
      if (search.trim() && !r.nurse_name.toLowerCase().includes(search.trim().toLowerCase())) return false;
      if (typeFilter && r.type !== typeFilter) return false;
      return true;
    });

  const filterActiveStyle = "ring-2 ring-primary";
  const cardStyle = (s: StatusFilter) =>
    `bg-card border rounded-xl p-4 shadow-soft cursor-pointer transition hover:shadow-md ${statusFilter === s ? filterActiveStyle : ""}`;

  const tabCls = (t: ActiveTab) =>
    `px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
      activeTab === t
        ? "border-primary text-primary"
        : "border-transparent text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div>
      <PageHeader
        title="Leave & Requests"
        subtitle="Self-service requests from nursing staff"
        actions={
          <div className="flex flex-wrap gap-2">
            {canRequestShiftSwitch && (
              <button
                type="button"
                onClick={() => setShowSwitch(true)}
                className="inline-flex items-center gap-2 h-10 px-4 rounded-md border bg-card text-sm font-medium hover:bg-muted"
              >
                <ArrowLeftRight className="h-4 w-4" /> Shift Switch
              </button>
            )}
            {canRequestLeave && (
              <button
                type="button"
                onClick={() => setShowAdd(true)}
                className="inline-flex items-center gap-2 h-10 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
              >
                <Plus className="h-4 w-4" /> New request
              </button>
            )}
          </div>
        }
      />

      {/* Leave closure banner */}
      {workflowStatus?.firstRotaPublished && workflowStatus.leaveIsClosed && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-700 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
          <Lock className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Leave window is closed</p>
            <p className="mt-0.5 text-amber-700 dark:text-amber-400">
              The schedule period starting{" "}
              <strong>{fmtDateLeave(workflowStatus.nextPeriodStart!)}</strong> begins soon. Only{" "}
              <strong>Sick</strong> and <strong>Emergency</strong> requests can be submitted until
              then.
            </p>
          </div>
        </div>
      )}

      {/* Facility chip strip */}
      <div className="mb-4">
        <FacilityChips
          value={lockedFacility ?? selectedFacility}
          onChange={(f) => { setSelectedFacility(f); setStatusFilter("All"); setSearch(""); setTypeFilter(""); }}
          locked={!!lockedFacility}
          showAll={canFilterFacility}
        />
      </div>

      {/* Tabs */}
      <div className="flex border-b mb-4">
        <button
          type="button"
          className={tabCls("leave")}
          onClick={() => {
            setActiveTab("leave");
            setStatusFilter("All");
            setSearch("");
            setTypeFilter("");
          }}
        >
          Leave Requests
          {leaveRows.filter((r) => r.status === "Pending").length > 0 && (
            <span className="ml-1.5 inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-bold">
              {leaveRows.filter((r) => r.status === "Pending").length}
            </span>
          )}
        </button>
        <button
          type="button"
          className={tabCls("switches")}
          onClick={() => {
            setActiveTab("switches");
            setStatusFilter("All");
            setSearch("");
            setTypeFilter("");
          }}
        >
          Shift Switches
          {switchRows.filter((r) => r.status === "Pending").length > 0 && (
            <span className="ml-1.5 inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-bold">
              {switchRows.filter((r) => r.status === "Pending").length}
            </span>
          )}
        </button>
      </div>

      {/* Status filter cards — Reverted only shown once at least one exists, so the
          common case (nobody's ever reverted anything) stays a clean 3-card row. */}
      <div className={`grid gap-3 sm:gap-4 mb-6 ${counts.Reverted > 0 ? "grid-cols-4" : "grid-cols-3"}`}>
        {(counts.Reverted > 0
          ? (["Pending", "Approved", "Rejected", "Reverted"] as const)
          : (["Pending", "Approved", "Rejected"] as const)
        ).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter((f) => (f === s ? "All" : s))}
            className={cardStyle(s)}
          >
            <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium text-left">
              {s}
            </p>
            <p className="text-2xl font-bold mt-1 text-left">{counts[s]}</p>
            {statusFilter === s && (
              <p className="text-[10px] text-primary font-medium mt-0.5 text-left">Filtering ↑</p>
            )}
          </button>
        ))}
      </div>

      {/* Search + type filter */}
      <div className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="Search by name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-9 pl-9 pr-3 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        {activeTab === "leave" && (
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="h-9 px-3 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring text-muted-foreground"
          >
            <option value="">All types</option>
            {["Sick", "Annual", "Emergency", "Maternity", "Public Holiday", "Study Leave", "Compassionate Leave", "Leave of Absence"].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground py-12 text-center">Loading…</p>
      ) : activeRows.length === 0 ? (
        <EmptyState
          icon={
            activeTab === "switches" ? (
              <ArrowLeftRight className="h-6 w-6" />
            ) : (
              <PlaneTakeoff className="h-6 w-6" />
            )
          }
          title={activeTab === "switches" ? "No shift switch requests" : "No leave requests yet"}
          description={
            activeTab === "switches"
              ? "Chief Matron can request a shift switch on a published rota."
              : "Submit a new request to get started."
          }
          action={
            activeTab === "leave" && canRequestLeave ? (
              <button
                type="button"
                onClick={() => setShowAdd(true)}
                className="inline-flex items-center gap-2 h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm"
              >
                <Plus className="h-4 w-4" /> New request
              </button>
            ) : canRequestShiftSwitch ? (
              <button
                type="button"
                onClick={() => setShowSwitch(true)}
                className="inline-flex items-center gap-2 h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm"
              >
                <ArrowLeftRight className="h-4 w-4" /> Request switch
              </button>
            ) : null
          }
        />
      ) : activeTab === "leave" ? (
        <LeaveTable
          rows={visibleRows}
          showApproverCols={isAnyLeaveApprover}
          rowApprovalInfo={rowApprovalInfo}
          onReview={reviewLeave}
          nurseToFacility={nurseToFacility}
          showFacility={isCnoOrAdmin}
        />
      ) : (
        <SwitchTable
          rows={visibleRows}
          canApprove={canApproveShiftSwitch}
          onReview={reviewSwitch}
          nurseToFacility={nurseToFacility}
          showFacility={isCnoOrAdmin}
        />
      )}

      {showAdd && <NewLeaveModal onClose={() => setShowAdd(false)} />}
      {showSwitch && <ShiftSwitchModal onClose={() => setShowSwitch(false)} />}
    </div>
  );
}

// ── Leave table ──────────────────────────────────────────────────────────────

function LeaveTable({
  rows,
  showApproverCols,
  rowApprovalInfo,
  onReview,
  nurseToFacility,
  showFacility,
}: {
  rows: LeaveRow[];
  showApproverCols: boolean;
  rowApprovalInfo: (row: LeaveRow) => { canApprove: boolean; blockedLabel: string };
  onReview: (l: LeaveRow, s: "Approved" | "Rejected", note: string) => void;
  nurseToFacility?: Map<string, string | null>;
  showFacility?: boolean;
}) {
  const { nurseId, user, isAdmin } = useAuth();
  const qc = useQueryClient();
  const [reviewing, setReviewing] = useState<{
    row: LeaveRow;
    status: "Approved" | "Rejected";
  } | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [editing, setEditing] = useState<LeaveRow | null>(null);
  const [reverting, setReverting] = useState<LeaveRow | null>(null);
  const [revertReason, setRevertReason] = useState("");
  const [revertRange, setRevertRange] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [revertBusy, setRevertBusy] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const { pageItems: pagedRows, totalPages } = usePagination(rows, pageSize, page);

  function submitReview() {
    if (!reviewing) return;
    onReview(reviewing.row, reviewing.status, reviewNote);
    setReviewing(null);
    setReviewNote("");
  }

  // A partial revert must touch the start or end of the approved range — a
  // gap reverted in the middle can't be represented by a single from/to pair
  // (mirrors the backend's own check, so the button disables before the round
  // trip instead of just surfacing the server's rejection after the fact).
  const revertIsFullRange =
    !!reverting &&
    revertRange.from === reverting.from_date.slice(0, 10) &&
    revertRange.to === reverting.to_date.slice(0, 10);
  const revertIsValidRange =
    !!reverting &&
    !!revertRange.from &&
    !!revertRange.to &&
    revertRange.from <= revertRange.to &&
    (revertIsFullRange ||
      revertRange.from === reverting.from_date.slice(0, 10) ||
      revertRange.to === reverting.to_date.slice(0, 10));

  async function submitRevert() {
    if (!reverting || !revertReason.trim() || !revertIsValidRange) return;
    setRevertBusy(true);
    try {
      await api.post(`/leave-requests/${reverting.id}/revert`, {
        reason: revertReason.trim(),
        from_date: revertRange.from,
        to_date: revertRange.to,
      });
      toast.success(
        revertIsFullRange
          ? "Leave reverted — original shift assignment restored"
          : "Leave partially reverted — those days are restored to the original shift assignment",
      );
      logAudit(
        `${revertIsFullRange ? "Reverted" : "Partially reverted"} approved leave for ${reverting.nurse_name} (${revertRange.from} – ${revertRange.to}): ${revertReason.trim()}`,
        reverting.from_date,
      );
      qc.invalidateQueries({ queryKey: ["leave"] });
      qc.invalidateQueries({ queryKey: ["assignments"] });
      setReverting(null);
      setRevertReason("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to revert leave");
    } finally {
      setRevertBusy(false);
    }
  }

  return (
    <>
      <div className="bg-card border rounded-xl shadow-soft overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                {showApproverCols && <th className="text-left font-semibold px-4 py-3">Nurse</th>}
                <th className="text-left font-semibold px-4 py-3">Type</th>
                <th className="text-left font-semibold px-4 py-3">Reason</th>
                <th className="text-left font-semibold px-4 py-3">Period</th>
                <th className="text-left font-semibold px-4 py-3">Requested Date</th>
                <th className="text-left font-semibold px-4 py-3">Status</th>
                <th className="text-left font-semibold px-4 py-3">Reviewed By</th>
                <th className="text-left font-semibold px-4 py-3">Reviewed On</th>
                {showApproverCols && <th className="text-right font-semibold px-4 py-3">Action</th>}
              </tr>
            </thead>
            <tbody>
              {pagedRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={showApproverCols ? 9 : 7}
                    className="px-4 py-8 text-center text-sm text-muted-foreground"
                  >
                    No requests match the current filter.
                  </td>
                </tr>
              ) : (() => {
                // When showing all facilities, group rows by facility with a divider header.
                const cols = showApproverCols ? 9 : 7;
                const renderRow = (l: LeaveRow) => {
                  const { canApprove: rowApprovable, blockedLabel } = rowApprovalInfo(l);
                  return (
                    <tr key={l.id} className="border-t hover:bg-muted/30">
                      {showApproverCols && (
                        <td className="px-4 py-3">
                          <p className="font-medium">{l.nurse_name}</p>
                          {l.requested_by_name && l.requested_by_name !== l.nurse_name && (
                            <p className="text-xs text-muted-foreground/70 mt-0.5">
                              Initiated by {l.requested_by_name}
                            </p>
                          )}
                        </td>
                      )}
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
                      <td className="px-4 py-3 text-muted-foreground tabular-nums whitespace-nowrap">
                        {l.from_date.slice(0, 10) === l.to_date.slice(0, 10)
                          ? fmtDateLeave(l.from_date)
                          : `${fmtDateLeave(l.from_date)} – ${fmtDateLeave(l.to_date)}`}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground tabular-nums whitespace-nowrap">
                        {fmtDateLeave(l.created_at)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`text-[10px] px-2 py-1 rounded-full font-semibold ${statusDisplay(l).className}`}
                          >
                            {statusDisplay(l).label}
                          </span>
                          {l.status === "Pending" &&
                            !isShiftSwitch(l) &&
                            (l.requested_by === user?.id || isAdmin) && (
                              <button
                                type="button"
                                aria-label="Edit leave request"
                                onClick={() => setEditing(l)}
                                className="h-5 w-5 grid place-items-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                            )}
                        </div>
                        {l.review_note && (
                          <p
                            className="text-xs text-muted-foreground/70 mt-0.5 italic truncate max-w-50"
                            title={l.review_note}
                          >
                            {l.review_note}
                          </p>
                        )}
                        {l.status === "Reverted" && l.revert_reason && (
                          <p
                            className="text-xs text-violet-700/80 mt-0.5 italic truncate max-w-50"
                            title={l.revert_reason}
                          >
                            Reverted: {l.revert_reason}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {l.reviewed_by_name ?? "—"}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-muted-foreground whitespace-nowrap">
                        {l.reviewed_at ? fmtDateLeave(l.reviewed_at) : "—"}
                      </td>
                      {showApproverCols && (
                        <td className="px-4 py-3">
                          <div className="flex gap-1 justify-end items-center">
                            {l.status === "Approved" && isAdmin && (
                              <button
                                type="button"
                                aria-label="Revert approved leave"
                                title="Revert — restore original shift assignment"
                                onClick={() => {
                                  setReverting(l);
                                  setRevertReason("");
                                  setRevertRange({
                                    from: l.from_date.slice(0, 10),
                                    to: l.to_date.slice(0, 10),
                                  });
                                }}
                                className="h-8 w-8 grid place-items-center rounded-md hover:bg-violet-100 text-violet-700"
                              >
                                <Undo2 className="h-4 w-4" />
                              </button>
                            )}
                            {!rowApprovable ? (
                              <p className="text-xs text-muted-foreground text-right italic">
                                {blockedLabel}
                              </p>
                            ) : l.nurse_id && l.nurse_id === nurseId ? (
                              <p className="text-xs text-muted-foreground text-right italic">
                                Own request
                              </p>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  aria-label="Approve leave request"
                                  onClick={() => {
                                    setReviewing({ row: l, status: "Approved" });
                                    setReviewNote("");
                                  }}
                                  disabled={l.status !== "Pending"}
                                  className="h-8 w-8 grid place-items-center rounded-md hover:bg-success/15 text-success disabled:opacity-30"
                                >
                                  <Check className="h-4 w-4" />
                                </button>
                                <button
                                  type="button"
                                  aria-label="Reject leave request"
                                  onClick={() => {
                                    setReviewing({ row: l, status: "Rejected" });
                                    setReviewNote("");
                                  }}
                                  disabled={l.status !== "Pending"}
                                  className="h-8 w-8 grid place-items-center rounded-md hover:bg-destructive/15 text-destructive disabled:opacity-30"
                                >
                                  <X className="h-4 w-4" />
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                };

                if (showFacility && nurseToFacility) {
                  // Group by facility, sort facility names, then render with divider rows.
                  const grouped = new Map<string, LeaveRow[]>();
                  for (const l of pagedRows) {
                    const f = (l.nurse_id && nurseToFacility.get(l.nurse_id)) || "Unknown";
                    if (!grouped.has(f)) grouped.set(f, []);
                    grouped.get(f)!.push(l);
                  }
                  return [...grouped.entries()]
                    .sort(([a], [b]) => a.localeCompare(b))
                    .flatMap(([facility, fRows]) => [
                      <tr key={`hdr-${facility}`}>
                        <td
                          colSpan={cols}
                          className="px-4 py-2 bg-muted/40 text-[10px] font-bold uppercase tracking-widest text-muted-foreground border-t"
                        >
                          {facility}
                        </td>
                      </tr>,
                      ...fRows.map(renderRow),
                    ]);
                }

                return pagedRows.map(renderRow);
              })()}
            </tbody>
          </table>
        </div>
        <Pagination
          page={page}
          totalPages={totalPages}
          pageSize={pageSize}
          totalItems={rows.length}
          onPage={(p) => setPage(p)}
          onPageSize={(s) => {
            setPageSize(s);
            setPage(1);
          }}
        />
      </div>

      {reviewing && (
        <Modal
          title={reviewing.status === "Approved" ? "Approve leave" : "Reject leave"}
          onClose={() => setReviewing(null)}
        >
          <p className="text-sm text-muted-foreground mb-4">
            {reviewing.status === "Approved"
              ? "Add a response note before approving (optional)."
              : "Provide a reason for rejecting this leave request."}
          </p>
          <textarea
            autoFocus
            value={reviewNote}
            onChange={(e) => setReviewNote(e.target.value)}
            rows={3}
            placeholder={
              reviewing.status === "Approved" ? "Approval note…" : "Reason for rejection…"
            }
            className="w-full px-3 py-2 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={() => setReviewing(null)}
              className="h-9 px-4 rounded-md border bg-card text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={reviewing.status === "Rejected" && !reviewNote.trim()}
              onClick={submitReview}
              className={`h-9 px-4 rounded-md text-sm font-medium disabled:opacity-40 ${
                reviewing.status === "Approved"
                  ? "bg-success text-white hover:bg-success/90"
                  : "bg-destructive text-destructive-foreground hover:bg-destructive/90"
              }`}
            >
              {reviewing.status === "Approved" ? "Confirm approval" : "Confirm rejection"}
            </button>
          </div>
        </Modal>
      )}
      {editing && <EditLeaveModal row={editing} onClose={() => setEditing(null)} />}
      {reverting && (
        <Modal title="Revert approved leave" onClose={() => setReverting(null)}>
          <p className="text-sm text-muted-foreground mb-4">
            Restores <strong>{reverting.nurse_name}</strong>&apos;s original shift assignment for
            the selected date{reverting.from_date !== reverting.to_date ? "s" : ""} and removes any
            hours already credited for them. This is logged on the audit log and can&apos;t be
            undone from here.
          </p>

          {reverting.from_date.slice(0, 10) !== reverting.to_date.slice(0, 10) && (
            <div className="mb-4">
              <label className="text-sm font-medium block mb-1.5">
                Days to revert{" "}
                <span className="text-muted-foreground font-normal">
                  (approved {fmtDateLeave(reverting.from_date)} – {fmtDateLeave(reverting.to_date)})
                </span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={revertRange.from}
                  min={reverting.from_date.slice(0, 10)}
                  max={reverting.to_date.slice(0, 10)}
                  onChange={(e) => setRevertRange((r) => ({ ...r, from: e.target.value }))}
                  className="h-9 rounded-md border border-input bg-card px-3 text-sm"
                />
                <span className="text-sm text-muted-foreground">–</span>
                <input
                  type="date"
                  value={revertRange.to}
                  min={reverting.from_date.slice(0, 10)}
                  max={reverting.to_date.slice(0, 10)}
                  onChange={(e) => setRevertRange((r) => ({ ...r, to: e.target.value }))}
                  className="h-9 rounded-md border border-input bg-card px-3 text-sm"
                />
              </div>
              {!revertIsValidRange ? (
                <p className="text-xs text-destructive mt-1.5">
                  Must start from the beginning or end of the approved leave — reverting a gap in
                  the middle isn't supported.
                </p>
              ) : !revertIsFullRange ? (
                <p className="text-xs text-muted-foreground mt-1.5">
                  The rest of the leave ({fmtDateLeave(
                    revertRange.from === reverting.from_date.slice(0, 10)
                      ? addDaysLeaveYmd(revertRange.to, 1)
                      : reverting.from_date,
                  )}{" "}
                  –{" "}
                  {fmtDateLeave(
                    revertRange.from === reverting.from_date.slice(0, 10)
                      ? reverting.to_date
                      : addDaysLeaveYmd(revertRange.from, -1),
                  )}
                  ) stays approved and leave-credited exactly as it is.
                </p>
              ) : null}
            </div>
          )}

          <textarea
            autoFocus
            value={revertReason}
            onChange={(e) => setRevertReason(e.target.value)}
            rows={3}
            placeholder="Reason for reverting…"
            className="w-full px-3 py-2 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={() => setReverting(null)}
              className="h-9 px-4 rounded-md border bg-card text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!revertReason.trim() || !revertIsValidRange || revertBusy}
              onClick={submitRevert}
              className="h-9 px-4 rounded-md text-sm font-medium disabled:opacity-40 bg-violet-600 text-white hover:bg-violet-700"
            >
              {revertBusy ? "Reverting…" : revertIsFullRange ? "Confirm revert" : "Confirm partial revert"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ── Shift switch table ───────────────────────────────────────────────────────

function SwitchTable({
  rows,
  canApprove,
  onReview,
  nurseToFacility,
  showFacility,
}: {
  rows: LeaveRow[];
  canApprove: boolean;
  onReview: (l: LeaveRow, s: "Approved" | "Rejected", note: string) => void;
  nurseToFacility?: Map<string, string | null>;
  showFacility?: boolean;
}) {
  const [reviewing, setReviewing] = useState<{
    row: LeaveRow;
    status: "Approved" | "Rejected";
  } | null>(null);
  const [reviewNote, setReviewNote] = useState("");

  function submitReview() {
    if (!reviewing) return;
    onReview(reviewing.row, reviewing.status, reviewNote);
    setReviewing(null);
    setReviewNote("");
  }

  return (
    <>
      <div className="bg-card border rounded-xl shadow-soft overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="text-left font-semibold px-4 py-3">Nurse A</th>
                <th className="text-left font-semibold px-4 py-3">Nurse B</th>
                <th className="text-left font-semibold px-4 py-3">Date</th>
                <th className="text-left font-semibold px-4 py-3">Shifts</th>
                <th className="text-left font-semibold px-4 py-3">Reason / Note</th>
                <th className="text-left font-semibold px-4 py-3">Requested Date</th>
                <th className="text-left font-semibold px-4 py-3">Status</th>
                {canApprove && <th className="text-right font-semibold px-4 py-3">Action</th>}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={canApprove ? 8 : 7}
                    className="px-4 py-8 text-center text-sm text-muted-foreground"
                  >
                    No switch requests match the current filter.
                  </td>
                </tr>
              ) : null}
              {rows.map((l) => {
                const sw = parseSwitch(l);
                return (
                  <tr key={l.id} className="border-t hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <p className="font-medium">{l.nurse_name}</p>
                      {showFacility && l.nurse_id && nurseToFacility?.get(l.nurse_id) && (
                        <p className="text-[10px] font-semibold text-primary/70 mt-0.5">
                          {nurseToFacility.get(l.nurse_id)}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 font-medium">{sw?.nurseBName ?? "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground tabular-nums whitespace-nowrap">
                      {fmtDateLeave(sw?.date ?? l.from_date)}
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
                    <td className="px-4 py-3 max-w-45">
                      {sw?.note && (
                        <p className="text-xs text-muted-foreground truncate" title={sw.note}>
                          {sw.note}
                        </p>
                      )}
                      {l.review_note && (
                        <p
                          className="text-xs text-muted-foreground/70 truncate mt-0.5 italic"
                          title={`Review note: ${l.review_note}`}
                        >
                          Review: {l.review_note}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground tabular-nums whitespace-nowrap">
                      {fmtDateLeave(l.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`text-[10px] px-2 py-1 rounded-full font-semibold ${statusDisplay(l).className}`}
                      >
                        {statusDisplay(l).label}
                      </span>
                    </td>
                    {canApprove && (
                      <td className="px-4 py-3">
                        <div className="flex gap-1 justify-end">
                          <button
                            type="button"
                            aria-label="Approve shift switch"
                            onClick={() => {
                              setReviewing({ row: l, status: "Approved" });
                              setReviewNote("");
                            }}
                            disabled={l.status !== "Pending"}
                            className="h-8 w-8 grid place-items-center rounded-md hover:bg-success/15 text-success disabled:opacity-30"
                            title="Approve and apply to published rota"
                          >
                            <Check className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            aria-label="Reject shift switch"
                            onClick={() => {
                              setReviewing({ row: l, status: "Rejected" });
                              setReviewNote("");
                            }}
                            disabled={l.status !== "Pending"}
                            className="h-8 w-8 grid place-items-center rounded-md hover:bg-destructive/15 text-destructive disabled:opacity-30"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Review note dialog */}
      {reviewing && (
        <Modal
          title={reviewing.status === "Approved" ? "Approve switch" : "Reject switch"}
          onClose={() => setReviewing(null)}
        >
          <p className="text-sm text-muted-foreground mb-4">
            {reviewing.status === "Approved"
              ? "Add a note before approving this shift switch (optional)."
              : "Provide a reason for rejecting this shift switch."}
          </p>
          <textarea
            autoFocus
            value={reviewNote}
            onChange={(e) => setReviewNote(e.target.value)}
            rows={3}
            placeholder={
              reviewing.status === "Approved" ? "Approval note…" : "Reason for rejection…"
            }
            className="w-full px-3 py-2 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={() => setReviewing(null)}
              className="h-9 px-4 rounded-md border bg-card text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={reviewing.status === "Rejected" && !reviewNote.trim()}
              onClick={submitReview}
              className={`h-9 px-4 rounded-md text-sm font-medium disabled:opacity-40 ${
                reviewing.status === "Approved"
                  ? "bg-success text-white hover:bg-success/90"
                  : "bg-destructive text-destructive-foreground hover:bg-destructive/90"
              }`}
            >
              {reviewing.status === "Approved" ? "Confirm approval" : "Confirm rejection"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ── Edit pending leave modal ─────────────────────────────────────────────────

function EditLeaveModal({ row, onClose }: { row: LeaveRow; onClose: () => void }) {
  const qc = useQueryClient();
  const today = todayYmd();
  const [type, setType] = useState(row.type);
  const [from, setFrom] = useState(row.from_date.slice(0, 10));
  const [to, setTo] = useState(row.to_date.slice(0, 10));
  const [busy, setBusy] = useState(false);

  const inputCls =
    "w-full h-9 px-3 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";
  const leaveTypes = [
    "Sick",
    "Annual",
    "Emergency",
    "Maternity",
    "Public Holiday",
    "Study Leave",
    "Compassionate Leave",
    "Leave of Absence",
  ];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!from || !to) { toast.error("Please fill in all dates"); return; }
    if (from < today) { toast.error("Cannot use a past start date"); return; }
    if (to < from) { toast.error("End date must be on or after start date"); return; }
    setBusy(true);
    try {
      await api.patch(`/leave-requests/${row.id}`, { type, from_date: from, to_date: to });
      toast.success("Leave request updated");
      qc.invalidateQueries({ queryKey: ["leave-requests"] });
      onClose();
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to update leave request");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Edit Leave Request" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Leave Type</label>
          <select value={type} onChange={(e) => setType(e.target.value)} className={inputCls}>
            {leaveTypes.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">From</label>
            <input
              type="date"
              value={from}
              min={today}
              onChange={(e) => { setFrom(e.target.value); if (to && e.target.value > to) setTo(e.target.value); }}
              className={inputCls}
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">To</label>
            <input
              type="date"
              value={to}
              min={from || today}
              onChange={(e) => setTo(e.target.value)}
              className={inputCls}
              required
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="h-9 px-4 rounded-md border bg-card text-sm">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-40 flex items-center gap-1.5"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save changes
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── New leave request modal ──────────────────────────────────────────────────

function NewLeaveModal({ onClose }: { onClose: () => void }) {
  const { user, fullName, nurseId, isAdmin, activeRole, nurseFacility } = useAuth();
  const qc = useQueryClient();
  const { data: nurses = [] } = useQuery({
    queryKey: ["nurses-min"],
    queryFn: () =>
      api.get<{ id: string; name: string; facility: string | null }[]>("/nurses"),
  });

  const today = todayYmd();
  const [type, setType] = useState("Annual");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  // Admin always submits on behalf of a staff member. Chief Matron chooses — herself,
  // or a staff member in her own facility who is unable to submit it themselves.
  const [staffNurseId, setStaffNurseId] = useState("");
  const isChiefMatron = activeRole === "chief_matron";
  const [requestFor, setRequestFor] = useState<"self" | "staff">("self");
  const staffMode = isAdmin || (isChiefMatron && requestFor === "staff");

  // Resolve the nurse's own ID: prefer the one from auth context, fall back to name match.
  const resolvedNurseId = nurseId ?? nurses.find((n) => n.name === fullName)?.id ?? null;

  const staffNurse = nurses.find((n) => n.id === staffNurseId);
  const targetNurseId = staffMode ? staffNurseId || null : resolvedNurseId;
  const targetNurseName = staffMode ? (staffNurse?.name ?? "") : (fullName ?? "");

  // Admin picks from every facility; Chief Matron is limited to her own staff (not herself).
  const nursesByFacility = useMemo(() => {
    const map = new Map<string, typeof nurses>();
    for (const n of nurses) {
      const key = n.facility ?? "Unassigned";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(n);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([facility, group]) => [facility, [...group].sort((a, b) => a.name.localeCompare(b.name))] as const);
  }, [nurses]);

  const chiefMatronStaffOptions = useMemo(
    () =>
      nurses
        .filter((n) => n.facility === nurseFacility && n.id !== resolvedNurseId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [nurses, nurseFacility, resolvedNurseId],
  );

  const datesReady = !!from && !!to;

  // Check if the selected date range overlaps the target nurse's own published assignments.
  // Scoped to the requesting nurse so nurses in unpublished wards are not incorrectly
  // restricted when another ward happens to have a published rota in the same period.
  const { data: datesInPublishedRota = false, isFetching: checkingDates } = useQuery({
    queryKey: ["leave-dates-published", from, to, targetNurseId],
    enabled: datesReady && !!targetNurseId,
    queryFn: () =>
      api
        .get<{ id: string }[]>(
          `/shift-assignments?nurse_id=${targetNurseId}&status=published&from=${from}&to=${to}&limit=1`,
        )
        .then((arr) => arr.length > 0),
  });

  // Block ALL leave types when the nurse's rota for these dates is in the approval chain.
  const { data: datesInApprovalRota = false } = useQuery({
    queryKey: ["leave-dates-in-approval", from, to, targetNurseId],
    enabled: datesReady && !!targetNurseId,
    queryFn: () =>
      api
        .get<{ id: string }[]>(
          `/shift-assignments?nurse_id=${targetNurseId}&status_in=submitted,hr_approved&from=${from}&to=${to}&limit=1`,
        )
        .then((arr) => arr.length > 0),
  });

  // Check the leave closure window — shared cache with LeavePage so no extra network call.
  const { data: workflowStatus } = useQuery<WorkflowStatus>({
    queryKey: ["workflow-status"],
    staleTime: 5 * 60 * 1000,
    queryFn: () => api.get<WorkflowStatus>("/rpc/workflow-status"),
  });
  // The closure window only applies to the period being closed (next period ≤ nextPeriodStart + 27 days).
  // Leave for dates beyond that period has its own future closure window and must not be blocked now.
  const nextPeriodStart = workflowStatus?.nextPeriodStart;
  const nextPeriodEnd = nextPeriodStart
    ? new Date(new Date(nextPeriodStart + "T00:00:00").getTime() + 27 * 86400000)
        .toISOString()
        .slice(0, 10)
    : null;
  // Only actually restrict once we KNOW the picked date falls in the closing
  // window — before the user has chosen a from date (or before workflowStatus
  // has loaded), there's nothing to evaluate yet, so this must default to
  // "not closed," not "closed." The previous `!nextPeriodEnd || !from` fallback
  // did the opposite: it treated "don't know yet" as "yes, blocked," which
  // silently forced the type to Sick/Emergency and clamped the date picker's
  // max to 3 days out the instant the modal opened — before the user had
  // touched anything — making unrelated future dates look unselectable with
  // no visible cause.
  const leaveWindowClosed =
    !!workflowStatus?.firstRotaPublished &&
    !!workflowStatus.leaveIsClosed &&
    !!from &&
    !!nextPeriodEnd &&
    from <= nextPeriodEnd;

  // Remaining entitlement for the target nurse — Annual 15/yr, Study/
  // Compassionate 5/yr, Maternity 12wk/yr, Sick 12/month. Admin can still
  // submit past the limit (matches the backend's own admin bypass), so the
  // dropdown isn't narrowed for them — everyone else has exhausted types
  // removed from what they can even select.
  const { data: entitlementUsage } = useQuery<EntitlementUsage>({
    queryKey: ["leave-entitlements", targetNurseId],
    enabled: !!targetNurseId,
    staleTime: 60 * 1000,
    queryFn: () => api.get<EntitlementUsage>(`/leave-entitlements/${targetNurseId}`),
  });

  // Admin-configurable via System Settings (default 3) — how many days,
  // inclusive of the start date, a Sick/Emergency request can span.
  const { data: sickEmergencyMaxDays = 3 } = useQuery({
    queryKey: ["sick-emergency-max-days"],
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      api
        .get<{ value: number }>("/portal-settings/sick_emergency_max_days")
        .then(({ value }) => (typeof value === "number" && value > 0 ? value : 3))
        .catch(() => 3),
  });
  const sickEmergencyMaxOffset = sickEmergencyMaxDays - 1;
  const exhaustedTypes = new Set(
    isAdmin
      ? []
      : Object.entries(entitlementUsage ?? {})
          .filter(([, v]) => v.exhausted)
          .map(([t]) => t),
  );

  // In-approval rota: all leave blocked for those dates.
  // Published / closure window: only 3 exempt types allowed.
  // Exhausted-entitlement types are then dropped from whatever's left.
  const allowedTypes = (
    datesInApprovalRota
      ? []
      : datesInPublishedRota || leaveWindowClosed
        ? ["Sick", "Emergency"]
        : ["Sick", "Annual", "Emergency", "Maternity", "Public Holiday", "Study Leave", "Compassionate Leave", "Leave of Absence"]
  ).filter((t) => !exhaustedTypes.has(t));

  // Keep the selected type valid when the allowed list narrows.
  const effectiveType = allowedTypes.includes(type) ? type : allowedTypes[0];

  // Type must be picked LAST — which types are even allowed depends on who the
  // request is for and which dates are chosen, so those have to be locked in
  // first (staff member, if this is being submitted on someone else's behalf,
  // then the date range) or the user could pick a type that then silently
  // changes out from under them once the real constraints are known.
  const typeSelectionBlocked = (staffMode && !targetNurseId) || !datesReady || checkingDates;

  // Sick/Emergency: `to` auto-defaults to the configured max span (see the
  // From/Type onChange handlers below), but the user can still pick
  // something further out — this flags that case for an inline error
  // instead of the picker silently refusing the date (submit() below
  // re-checks this as the final guard).
  const isSickEmergencyRangeExceeded =
    (effectiveType === "Sick" || effectiveType === "Emergency") &&
    !!from &&
    !!to &&
    to > addDaysLeaveYmd(from, sickEmergencyMaxOffset);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (staffMode && !targetNurseId) {
      toast.error("Please select which staff member this request is for");
      return;
    }
    if (from < today) {
      toast.error("Leave requests cannot be submitted for past dates");
      return;
    }
    if (to < from) {
      toast.error("End date cannot be before the start date");
      return;
    }
    if (effectiveType === "Sick" || effectiveType === "Emergency") {
      if (to > addDaysLeaveYmd(from, sickEmergencyMaxOffset)) {
        toast.error(
          `${effectiveType} leave can only be requested for up to ${sickEmergencyMaxDays} day(s) from the start date.`,
        );
        return;
      }
    }
    if (datesInApprovalRota) {
      toast.error("The rota for this period is under review. Leave requests are blocked until it is published.");
      return;
    }

    // Frontend overlap guard: check cached leave rows before hitting the API.
    const cached = qc.getQueryData<LeaveRow[]>(["leave"]) ?? [];
    const conflict = cached.find(
      (l) =>
        !isShiftSwitch(l) &&
        l.status !== "Rejected" &&
        (l.nurse_id === targetNurseId || l.nurse_name === targetNurseName) &&
        l.from_date.slice(0, 10) <= to &&
        l.to_date.slice(0, 10) >= from,
    );
    if (conflict) {
      toast.error(
        `A ${conflict.type} leave request already exists for those dates. Please cancel or update the existing request first.`,
      );
      return;
    }

    setBusy(true);
    try {
      await api.post("/leave-requests", {
        nurse_id: targetNurseId,
        nurse_name: targetNurseName,
        requested_by: user?.id,
        type: effectiveType,
        from_date: from,
        to_date: to,
        reason: reason || null,
      });
      toast.success("Request submitted");
      logAudit("Submitted leave request", targetNurseName);
      qc.invalidateQueries({ queryKey: ["leave"] });
      onClose();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to submit request");
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "w-full h-10 px-3 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring";

  return (
    <Modal title="New leave request" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {isChiefMatron && (
          <div>
            <p className="text-sm font-medium mb-1.5">Who is this for?</p>
            <div className="flex gap-2">
              {(["self", "staff"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => {
                    setRequestFor(f);
                    if (f === "self") setStaffNurseId("");
                  }}
                  className={`h-9 px-4 rounded-md text-sm font-medium border transition-colors ${
                    requestFor === f
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-card border-border hover:bg-muted text-muted-foreground"
                  }`}
                >
                  {f === "self" ? "Myself" : "A staff member"}
                </button>
              ))}
            </div>
            {requestFor === "staff" && (
              <p className="text-xs text-muted-foreground mt-1.5">
                For when a staff member is unable to submit their own request — e.g. Sick or
                Emergency after the rota is published.
              </p>
            )}
          </div>
        )}

        {staffMode && (
          <div>
            <label htmlFor="leave-staff" className="text-sm font-medium">
              Staff member
            </label>
            <select
              id="leave-staff"
              required
              value={staffNurseId}
              onChange={(e) => setStaffNurseId(e.target.value)}
              className={inputCls}
            >
              <option value="">Select staff member…</option>
              {isAdmin
                ? nursesByFacility.map(([facility, group]) => (
                    <optgroup key={facility} label={facility}>
                      {group.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.name}
                        </option>
                      ))}
                    </optgroup>
                  ))
                : chiefMatronStaffOptions.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name}
                    </option>
                  ))}
            </select>
            <p className="text-xs text-muted-foreground mt-1">
              {isChiefMatron
                ? "Submitted on their behalf — it's not your own leave, so you can still approve it yourself once it's in your Pending queue."
                : "This request is submitted on their behalf and still goes to the Chief Matron for approval."}
            </p>
          </div>
        )}

        {/* Dates first — the type options depend on whether these fall in a published rota */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="leave-from" className="text-sm font-medium">
              From
            </label>
            <input
              id="leave-from"
              required
              type="date"
              min={today}
              value={from}
              onChange={(e) => {
                const v = e.target.value;
                setFrom(v);
                // Sick/Emergency: default `to` straight to the configured max
                // span every time `from` moves — the user can still pick a
                // different `to` afterwards (isSickEmergencyRangeExceeded
                // below flags it with an inline error rather than the picker
                // silently refusing it).
                if (effectiveType === "Sick" || effectiveType === "Emergency") {
                  setTo(addDaysLeaveYmd(v, sickEmergencyMaxOffset));
                } else if (!to || to < v) {
                  setTo(v);
                }
              }}
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="leave-to" className="text-sm font-medium">
              To
            </label>
            <input
              id="leave-to"
              required
              type="date"
              min={from || today}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className={inputCls}
            />
            {(effectiveType === "Sick" || effectiveType === "Emergency") &&
              (isSickEmergencyRangeExceeded ? (
                <p className="text-xs text-destructive mt-1">
                  {effectiveType} leave can't be more than {sickEmergencyMaxDays} day(s) from the
                  start date.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground mt-1">
                  {effectiveType} leave is capped at {sickEmergencyMaxDays} day(s) from the start
                  date.
                </p>
              ))}
          </div>
        </div>

        {datesReady && datesInApprovalRota && (
          <div className="flex items-start gap-2 p-3 rounded-md bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-800 text-xs text-rose-700 dark:text-rose-400">
            <Lock className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>
              The rota for these dates is currently <strong>under review</strong>. Leave requests are blocked until the rota is published.
            </span>
          </div>
        )}

        {datesReady && datesInPublishedRota && !datesInApprovalRota && (
          <div className="p-3 rounded-md bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 text-xs text-amber-700 dark:text-amber-400">
            These dates fall within a <strong>published schedule</strong>. Only{" "}
            <strong>Sick</strong> and <strong>Emergency</strong> can be requested.
          </div>
        )}

        {!datesInPublishedRota && leaveWindowClosed && (
          <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 text-xs text-amber-700 dark:text-amber-400">
            <Lock className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>
              Leave window is closed — the next schedule starts{" "}
              <strong>{fmtDateLeave(workflowStatus!.nextPeriodStart!)}</strong>. Only{" "}
              <strong>Sick</strong> and <strong>Emergency</strong> can be requested.
            </span>
          </div>
        )}

        <div>
          <label htmlFor="leave-type" className="text-sm font-medium">
            Type
          </label>
          <select
            id="leave-type"
            value={effectiveType}
            onChange={(e) => {
              const v = e.target.value;
              setType(v);
              // Switching TO Sick/Emergency (e.g. from Annual) — default `to`
              // straight to the configured max span, same as picking `from`
              // does. The user can still widen it afterwards;
              // isSickEmergencyRangeExceeded catches that with an inline
              // error instead of silently blocking.
              if ((v === "Sick" || v === "Emergency") && from) {
                setTo(addDaysLeaveYmd(from, sickEmergencyMaxOffset));
              }
            }}
            disabled={typeSelectionBlocked}
            className={inputCls}
          >
            {allowedTypes.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          {checkingDates ? (
            <p className="text-xs text-muted-foreground mt-1">Checking schedule…</p>
          ) : staffMode && !targetNurseId ? (
            <p className="text-xs text-muted-foreground mt-1">
              Select a staff member and date range first — which types are allowed depends on both.
            </p>
          ) : !datesReady ? (
            <p className="text-xs text-muted-foreground mt-1">
              Select a date range first — which types are allowed depends on it.
            </p>
          ) : null}
          {(() => {
            const maternityBlocked = [...exhaustedTypes].filter(
              (t) => entitlementUsage?.[t]?.blockedReason === "maternity",
            );
            const capExhausted = [...exhaustedTypes].filter(
              (t) => entitlementUsage?.[t]?.blockedReason !== "maternity",
            );
            return (
              <>
                {maternityBlocked.length > 0 && (
                  <p className="text-xs text-rose-600 dark:text-rose-400 mt-1">
                    {maternityBlocked.join(", ")} hidden — an active Maternity leave request this
                    year blocks Annual leave until next year.
                  </p>
                )}
                {capExhausted.length > 0 && (
                  <p className="text-xs text-rose-600 dark:text-rose-400 mt-1">
                    {capExhausted.join(", ")} {capExhausted.length === 1 ? "is" : "are"} hidden —
                    entitlement already used up for{" "}
                    {capExhausted.some((t) => entitlementUsage?.[t]?.period === "month")
                      ? "this period"
                      : "this year"}
                    .
                  </p>
                )}
              </>
            );
          })()}
          {entitlementUsage?.[effectiveType] && (
            <p className="text-xs text-muted-foreground mt-1">
              {effectiveType}: {entitlementUsage[effectiveType].used} of{" "}
              {entitlementUsage[effectiveType].cap} day(s) used{" "}
              {entitlementUsage[effectiveType].period === "month" ? "this month" : "this year"} ·{" "}
              {entitlementUsage[effectiveType].remaining} remaining
            </p>
          )}
        </div>

        <div>
          <label htmlFor="leave-reason" className="text-sm font-medium">
            Reason (optional)
          </label>
          <textarea
            id="leave-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-4 rounded-md border bg-card text-sm"
          >
            Cancel
          </button>
          <button
            disabled={busy || checkingDates || datesInApprovalRota || isSickEmergencyRangeExceeded}
            type="submit"
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm inline-flex items-center gap-2 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />} Submit
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Shift switch request modal ───────────────────────────────────────────────

const SWITCH_FACILITIES = ["Ikeja", "Ikoyi", "Ligali"] as const;

function splitWards(ward: string | null | undefined): string[] {
  if (!ward) return [];
  return ward
    .split("|")
    .map((w) => w.trim())
    .filter(Boolean);
}

// Normalise a job-role string to a stable category so that role matching
// in shift-switch is robust against capitalisation variants and the fact
// that "Coverage Nurse" and "Head Nurse" are the same functional category.
function roleCategory(role: string | null | undefined): string {
  if (!role) return "nurse";
  const r = role.trim().toLowerCase();
  if (r === "cno" || r.includes("chief nursing officer")) return "cno";
  if (r.includes("chief matron") || r === "matron") return "chief_matron";
  if (r.includes("coverage nurse") || r.includes("head nurse") || r.includes("night coordinator")) return "head_nurse";
  if (/^hr/.test(r)) return "hr_admin";
  if (/^porter/.test(r)) return "porter";
  if (/nurs(?:e|ing)\s*assistant/i.test(r)) return "nursing_assistant";
  if (/surgical\s*nurse/i.test(r)) return "surgical_nurse";
  return "nurse";
}

function ShiftSwitchModal({ onClose }: { onClose: () => void }) {
  const { user, fullName, nurseFacility, isAdmin } = useAuth();
  const qc = useQueryClient();

  // Admin sees all facilities; all other roles are locked to their own.
  const lockedFacility: string | null = isAdmin ? null : (nurseFacility ?? null);

  const { data: nurses = [] } = useQuery({
    queryKey: ["nurses-switch"],
    queryFn: () =>
      api.get<{ id: string; name: string; ward: string | null; facility: string | null; role: string }[]>(
        "/nurses",
      ),
  });

  const [switchType, setSwitchType] = useState<"same-ward" | "inter-ward">("same-ward");
  const [exchangeMode, setExchangeMode] = useState<"leave" | "direct">("leave");
  const [facility, setFacility] = useState(lockedFacility ?? "");
  const [nurseAId, setNurseAId] = useState("");
  const today = todayYmd();
  const [nurseBId, setNurseBId] = useState("");
  const [wardB, setWardB] = useState("");
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [shiftA, setShiftA] = useState("");
  const [shiftB, setShiftB] = useState("");
  const [coverShift, setCoverShift] = useState<"M" | "N" | "">("");
  const [busy, setBusy] = useState(false);

  const facilityKey = facility.trim().toLowerCase();
  const facilityNurses = nurses.filter(
    (n) => (n.facility ?? "").trim().toLowerCase() === facilityKey,
  );
  // Matrons (clinical role) never participate in shift switches.
  const switchableNurses = facilityNurses.filter((n) => !/matron/i.test(n.role ?? ""));
  const nurseA = nurses.find((n) => n.id === nurseAId);
  const nurseAWards = splitWards(nurseA?.ward);
  // Case-insensitive dedup: "ICU & CathLab" and "ICU & Cathlab" collapse to one entry.
  const allFacilityWards = (() => {
    const seen = new Map<string, string>();
    facilityNurses.flatMap((n) => splitWards(n.ward)).forEach((w) => {
      const key = w.trim().toLowerCase();
      if (!seen.has(key)) seen.set(key, w.trim());
    });
    return [...seen.values()].sort();
  })();
  const wardBOptions = allFacilityWards.filter((w) => !nurseAWards.includes(w));

  const facilityNurseIds = useMemo(() => facilityNurses.map((n) => n.id), [facilityNurses]);

  // Fetch all published shift assignments for facility nurses on the selected date.
  // Both modes (leave and direct) use this to populate Nurse B list and show shifts in dropdown.
  const { data: dateAssignments = [], isLoading: loadingAssignments } = useQuery({
    queryKey: ["date-assignments", date, facility],
    enabled: !!date && facilityNurseIds.length > 0,
    queryFn: () =>
      api.get<{ nurse_id: string; shift: string }[]>(
        `/shift-assignments?shift_date=${date}&status=published&nurse_ids=${facilityNurseIds.join(",")}`,
      ),
  });
  const assignmentMap = useMemo(
    () => new Map(dateAssignments.map((a) => [a.nurse_id, a.shift])),
    [dateAssignments],
  );

  const nurseBList = useMemo(() => {
    if (!nurseAId || !date) return [];

    const nurseARole = nurseA?.role ?? "";
    const nurseACategory = roleCategory(nurseARole);
    // Mirror the rota's own grouping: Coverage Nurse, Head Nurse, and Coverage
    // Nurse - Day are all interchangeable (same facility-wide "head" group).
    const isGlobalHeadRole = (r: string | null | undefined) =>
      !!r && /^(head|coverage)\s*nurse$|^coverage\s*nurse\s*-\s*day$/i.test(r.trim());
    const nurseAIsGlobalHead = isGlobalHeadRole(nurseARole);
    const notNurseA = (n: (typeof switchableNurses)[number]) => n.id !== nurseAId;
    const sameRole = (n: (typeof switchableNurses)[number]) => {
      if (nurseAIsGlobalHead) return isGlobalHeadRole(n.role);
      return roleCategory(n.role) === nurseACategory;
    };
    // Exclude nurses on approved leave — swapping with a leave nurse makes no sense.
    const notOnLeave = (n: (typeof switchableNurses)[number]) =>
      assignmentMap.get(n.id) !== "LEAVE";
    const isNoWardNurse = (n: (typeof switchableNurses)[number]) =>
      splitWards(n.ward).length === 0;

    // Direct switch with Nurse A on OFF: Nurse B must be actively on duty.
    // An OFF↔OFF swap is meaningless — nothing changes for either nurse.
    const workShifts = new Set(["M", "N", "MWC", "NC"]);
    const passesDirectOffRule = (n: (typeof switchableNurses)[number]) => {
      if (exchangeMode !== "direct" || shiftA !== "OFF") return true;
      const s = assignmentMap.get(n.id);
      return !!s && workShifts.has(s);
    };

    // Both modes show all nurses (on & off duty), same role, ward-scoped.
    const base = (n: (typeof switchableNurses)[number]) =>
      notNurseA(n) && sameRole(n) && notOnLeave(n) && passesDirectOffRule(n);

    if (switchType === "inter-ward") {
      if (!wardB) return [];
      if (exchangeMode === "leave") {
        // Leave cover: any nurse in Ward B can cover (no role restriction),
        // plus same-role no-ward nurses (e.g. other Coverage Nurses).
        const wardBNurses = switchableNurses.filter(
          (n) => notNurseA(n) && notOnLeave(n) && splitWards(n.ward).includes(wardB),
        );
        const sameRoleNoWard = switchableNurses.filter(
          (n) => notNurseA(n) && notOnLeave(n) && sameRole(n) && isNoWardNurse(n),
        );
        const seen = new Set(wardBNurses.map((n) => n.id));
        return [...wardBNurses, ...sameRoleNoWard.filter((n) => !seen.has(n.id))];
      }
      // Direct switch: Nurse B must be same role as Nurse A (equivalent shift swap).
      const wardNurses = switchableNurses.filter(
        (n) => base(n) && splitWards(n.ward).includes(wardB),
      );
      const noWardSameRole = switchableNurses.filter((n) => base(n) && isNoWardNurse(n));
      const seen = new Set(wardNurses.map((n) => n.id));
      return [...wardNurses, ...noWardSameRole.filter((n) => !seen.has(n.id))];
    }

    // Same-ward (both leave and direct modes)
    if (nurseAWards.length === 0) {
      // No-ward Nurse A: all same-role nurses in facility
      return switchableNurses.filter(base);
    }
    const wardNurses = switchableNurses.filter(
      (n) => base(n) && splitWards(n.ward).some((w) => nurseAWards.includes(w)),
    );
    const noWardSameRole = switchableNurses.filter((n) => base(n) && isNoWardNurse(n));
    const seen = new Set(wardNurses.map((n) => n.id));
    return [...wardNurses, ...noWardSameRole.filter((n) => !seen.has(n.id))];
  }, [nurseAId, date, switchType, wardB, switchableNurses, nurseA, nurseAWards, assignmentMap, exchangeMode, shiftA]);

  // In leave mode, Nurse A must be a nurse who is actually on approved leave on that date.
  const nurseAList = useMemo(() => {
    if (exchangeMode === "leave" && date) {
      return switchableNurses.filter((n) => assignmentMap.get(n.id) === "LEAVE");
    }
    return switchableNurses;
  }, [exchangeMode, date, switchableNurses, assignmentMap]);

  // Reactively sync shift displays from the assignment map.
  // Fires when the map changes (date/facility refetch) so shifts never lag behind.
  useEffect(() => {
    setShiftA(nurseAId ? (assignmentMap.get(nurseAId) ?? "") : "");
  }, [assignmentMap, nurseAId]);

  useEffect(() => {
    setShiftB(nurseBId ? (assignmentMap.get(nurseBId) ?? "") : "");
  }, [assignmentMap, nurseBId]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (nurseAId === nurseBId) return toast.error("Please select two different nurses");
    if (!shiftA) return toast.error("Could not find published shift for Nurse A on that date");
    if (!shiftB) return toast.error("Could not find published shift for Nurse B on that date");
    if (shiftA === "LEAVE" && !coverShift)
      return toast.error("Nurse A is on leave — please select the shift type that needs covering");
    if (!reason.trim()) return toast.error("Please provide a reason for this shift switch");

    // 24-hour rule: the shift must start more than 24 hours from now — waived when
    // covering an approved Sick/Emergency Leave that was itself requested AFTER
    // the rota was already published (rota_stage_at_request === "published") —
    // that's the only case where the leave could legitimately land with no lead
    // time at all, so a switch to arrange cover has to be allowed just as late.
    // A Sick/Emergency leave requested *before* publish had normal lead time to
    // arrange cover through, so the standard 24-hour rule still applies to it.
    let waive24hRule = false;
    if (shiftA === "LEAVE") {
      const coveredLeave = await api
        .get<{ type: string; rota_stage_at_request: string | null }[]>(
          `/leave-requests?nurse_id=${nurseAId}&status=Approved&from_date_lte=${date}&to_date_gte=${date}&limit=1`,
        )
        .catch(() => [] as { type: string; rota_stage_at_request: string | null }[]);
      const covered = coveredLeave[0];
      waive24hRule =
        !!covered &&
        ["Sick", "Emergency"].includes(covered.type) &&
        covered.rota_stage_at_request === "published";
    }

    // Use the actual shift start time: Morning = 08:00, Night = 17:00.
    const effectiveShift = shiftA === "LEAVE" ? coverShift : shiftA;
    const shiftHour = effectiveShift === "N" ? 17 : 8;
    const shiftStart = new Date(`${date}T${String(shiftHour).padStart(2, "0")}:00:00`);
    const hoursUntil = (shiftStart.getTime() - Date.now()) / 3_600_000;
    if (!waive24hRule && hoursUntil < 24) {
      return toast.error(
        `Shift switch cannot be requested less than 24 hours before the shift (${Math.max(0, Math.floor(hoursUntil))}h remaining). Please contact the CNO directly.`,
      );
    }

    if (exchangeMode === "leave" && shiftA !== "LEAVE") {
      return toast.error(
        "Leave mode requires Nurse A to have an approved leave assignment on this date. Use Direct Switch for shift swaps.",
      );
    }
    if (exchangeMode === "direct" && shiftA === "LEAVE") {
      return toast.error(
        "Nurse A is on approved leave — please select the Leave switch type instead.",
      );
    }

    // Block a swap that would leave either nurse with zero rest between shifts —
    // e.g. a Night shift ending 08:00 immediately followed by a Morning shift
    // starting that same morning. Checks each nurse's NEW shift on this date
    // against their own already-published shift the day before and after.
    // Re-validated again at approval time in reviewSwitch (defense in depth).
    const nurseBForCheck = nurses.find((n) => n.id === nurseBId);
    if (shiftA === "LEAVE") {
      const { prevShift, nextShift } = await fetchAdjacentShifts(nurseBId, date);
      if (hasRestConflict(prevShift, coverShift, nextShift)) {
        return toast.error(
          `This would leave ${nurseBForCheck?.name ?? "Nurse B"} with no rest between shifts — check their shift the day before/after ${date}.`,
        );
      }
    } else {
      const [adjA, adjB] = await Promise.all([
        fetchAdjacentShifts(nurseAId, date),
        fetchAdjacentShifts(nurseBId, date),
      ]);
      if (hasRestConflict(adjA.prevShift, shiftB, adjA.nextShift)) {
        return toast.error(
          `This would leave ${nurseA?.name ?? "Nurse A"} with no rest between shifts — check their shift the day before/after ${date}.`,
        );
      }
      if (hasRestConflict(adjB.prevShift, effectiveShift, adjB.nextShift)) {
        return toast.error(
          `This would leave ${nurseBForCheck?.name ?? "Nurse B"} with no rest between shifts — check their shift the day before/after ${date}.`,
        );
      }
    }

    setBusy(true);
    try {
      const nurseB = nurses.find((n) => n.id === nurseBId);
      const effectiveShiftA = shiftA === "LEAVE" ? coverShift : shiftA;
      const flagParts: string[] = [];
      if (switchType === "inter-ward") flagParts.push("INTER_WARD");
      if (exchangeMode === "direct") flagParts.push("DIRECT");
      if (exchangeMode === "leave") flagParts.push("LEAVE_COVER");
      const flags = flagParts.length ? `|${flagParts.join("|")}` : "";
      const reasonEncoded = `${SWITCH_PREFIX}${nurseBId}|${nurseB?.name ?? ""}|${effectiveShiftA}|${shiftB}${flags}|NOTE:${reason.trim()}`;

      await api.post("/leave-requests", {
        nurse_id: nurseAId,
        nurse_name: nurseA?.name ?? fullName ?? "",
        requested_by: user?.id,
        switch_nurse_b: nurseBId,
        type: "Swap",
        from_date: date,
        to_date: date,
        reason: reasonEncoded,
      });
      toast.success("Shift switch request submitted for approval");
      logAudit(`Shift switch request submitted: ${nurseA?.name} ↔ ${nurseB?.name}`, date);
      qc.invalidateQueries({ queryKey: ["leave"] });
      onClose();
    } catch {
      toast.error("Failed to submit shift switch request");
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "w-full h-10 px-3 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring";

  return (
    <Modal title="Request shift switch" onClose={onClose}>
      <p className="text-xs text-muted-foreground mb-4">
        Switches are applied to the <strong>published rota</strong> only after CNO approval.
        Requests must be submitted at least <strong>24 hours</strong> before the shift — except
        to cover an approved <strong>Sick</strong> or <strong>Emergency</strong> Leave, which can
        be requested up to the shift itself.
      </p>
      <form onSubmit={submit} className="space-y-4">
        {/* Exchange mode */}
        <div>
          <p className="text-sm font-medium mb-1.5">Switch type</p>
          <div className="flex gap-2 flex-wrap">
            {(["leave", "direct"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setExchangeMode(m);
                  setNurseAId("");
                  setNurseBId("");
                  setShiftA("");
                  setShiftB("");
                  setCoverShift("");
                }}
                className={`h-9 px-4 rounded-md text-sm font-medium border transition-colors ${
                  exchangeMode === m
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-card border-border hover:bg-muted text-muted-foreground"
                }`}
              >
                {m === "leave" ? "Leave" : "Direct Switch"}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {exchangeMode === "leave"
              ? "Nurse A is on approved leave. Nurse B covers the shift — counts as additional hours for Nurse B."
              : "Nurse A and Nurse B swap assigned shifts directly. Additional hours apply only when Nurse A has an OFF day and Nurse B does not."}
          </p>
        </div>

        {/* Switch type */}
        <div>
          <p className="text-sm font-medium mb-1.5">Ward scope</p>
          <div className="flex gap-2">
            {(["same-ward", "inter-ward"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setSwitchType(t);
                  setNurseBId("");
                  setWardB("");
                  setShiftB("");
                }}
                className={`h-9 px-4 rounded-md text-sm font-medium border transition-colors ${
                  switchType === t
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-card border-border hover:bg-muted text-muted-foreground"
                }`}
              >
                {t === "same-ward" ? "Same Ward" : "Inter Ward"}
              </button>
            ))}
          </div>
        </div>

        {/* Facility */}
        <div>
          <label htmlFor="sw-facility" className="text-sm font-medium">
            Facility <span className="text-destructive">*</span>
          </label>
          {lockedFacility ? (
            <div
              className={`${inputCls} flex items-center bg-muted text-muted-foreground cursor-not-allowed`}
            >
              {lockedFacility}
            </div>
          ) : (
            <select
              id="sw-facility"
              required
              value={facility}
              onChange={(e) => {
                setFacility(e.target.value);
                setNurseAId("");
                setNurseBId("");
                setWardB("");
                setShiftA("");
                setShiftB("");
              }}
              className={inputCls}
            >
              <option value="">Select facility…</option>
              {SWITCH_FACILITIES.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Date */}
        <div>
          <label htmlFor="sw-date" className="text-sm font-medium">
            Switch date <span className="text-destructive">*</span>
          </label>
          <input
            id="sw-date"
            required
            type="date"
            min={today}
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setShiftA("");
              setShiftB("");
              setCoverShift("");
              // assignmentMap refetches for the new date → the useEffects above re-sync shifts.
            }}
            className={inputCls}
          />
        </div>

        {/* Nurse A — filtered by facility */}
        <div>
          <label htmlFor="sw-nurse-a" className="text-sm font-medium">
            Nurse A <span className="text-destructive">*</span>
          </label>
          <select
            id="sw-nurse-a"
            required
            disabled={!facility || (exchangeMode === "leave" && !!date && loadingAssignments)}
            value={nurseAId}
            onChange={(e) => {
              const id = e.target.value;
              setNurseAId(id);
              setNurseBId("");
              setShiftA(id ? (assignmentMap.get(id) ?? "") : "");
              setShiftB("");
              setCoverShift("");
            }}
            className={inputCls}
          >
            <option value="">
              {!facility
                ? "Select facility first…"
                : exchangeMode === "leave" && date && !loadingAssignments && nurseAList.length === 0
                  ? "No nurses on leave for this date"
                  : "Select nurse…"}
            </option>
            {nurseAList.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
          {exchangeMode === "leave" && date && !loadingAssignments && nurseAList.length === 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              No nurses have an approved leave assignment on this date.
            </p>
          )}
          {shiftA && shiftA !== "LEAVE" && (
            <p className="mt-1 text-xs text-muted-foreground">
              Published shift: <span className="font-semibold text-foreground">{shiftA}</span>
            </p>
          )}
          {shiftA === "LEAVE" && (
            <div className="mt-2 p-2 rounded-md bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800">
              <p className="text-xs text-amber-700 dark:text-amber-400 mb-2">
                Nurse A is on approved leave. Select the shift type that needs covering:
              </p>
              <div className="flex gap-2">
                {(["M", "N"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setCoverShift(s)}
                    className={`h-8 px-4 rounded-md text-sm font-medium border transition-colors ${
                      coverShift === s
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-card border-border hover:bg-muted"
                    }`}
                  >
                    {s === "M" ? "Morning (M)" : "Night (N)"}
                  </button>
                ))}
              </div>
            </div>
          )}
          {nurseAId && date && !shiftA && (
            <p className="mt-1 text-xs text-destructive">No published shift found for this date.</p>
          )}
        </div>

        {/* Ward B selector — inter-ward only */}
        {switchType === "inter-ward" && (
          <div>
            <label htmlFor="sw-ward-b" className="text-sm font-medium">
              Ward B (destination) <span className="text-destructive">*</span>
            </label>
            <select
              id="sw-ward-b"
              required
              disabled={!nurseAId}
              value={wardB}
              onChange={(e) => {
                setWardB(e.target.value);
                setNurseBId("");
                setShiftB("");
              }}
              className={inputCls}
            >
              <option value="">{nurseAId ? "Select ward…" : "Select Nurse A first…"}</option>
              {wardBOptions.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Nurse B */}
        <div>
          <label htmlFor="sw-nurse-b" className="text-sm font-medium">
            Nurse B <span className="text-destructive">*</span>
          </label>
          <select
            id="sw-nurse-b"
            required
            disabled={
              loadingAssignments ||
              (switchType === "inter-ward" ? !wardB : !nurseAId) ||
              !date
            }
            value={nurseBId}
            onChange={(e) => {
              const id = e.target.value;
              setNurseBId(id);
              setShiftB(id ? (assignmentMap.get(id) ?? "") : "");
            }}
            className={inputCls}
          >
            <option value="">
              {loadingAssignments
                ? "Loading available nurses…"
                : switchType === "inter-ward"
                  ? wardB
                    ? "Select nurse…"
                    : "Select Ward B first…"
                  : nurseAId
                    ? "Select nurse…"
                    : "Select Nurse A first…"}
            </option>
            {nurseBList.map((n) => {
              const shift = assignmentMap.get(n.id);
              return (
                <option key={n.id} value={n.id}>
                  {n.name}
                  {shift ? ` — ${shift} shift` : " — no shift"}
                </option>
              );
            })}
          </select>
          {nurseAId && date && !loadingAssignments && nurseBList.length === 0 && (switchType === "same-ward" || wardB) && (
            <p className="mt-1 text-xs text-muted-foreground">
              {switchType === "inter-ward"
                ? `No ${nurseA?.role ?? "matching"} nurses found in the selected ward.`
                : nurseAWards.length === 0
                  ? `No other ${nurseA?.role ?? "matching"} nurses found in this facility.`
                  : `No ${nurseA?.role ?? "matching"} nurses found in the same ward.`}
            </p>
          )}
          {shiftB && (
            <p className="mt-1 text-xs text-muted-foreground">
              Published shift: <span className="font-semibold text-foreground">{shiftB}</span>
            </p>
          )}
          {nurseBId && date && !shiftB && (
            <p className="mt-1 text-xs text-destructive">No published shift found for this date.</p>
          )}
        </div>

        {/* Reason — required */}
        <div>
          <label htmlFor="sw-reason" className="text-sm font-medium">
            Reason <span className="text-destructive">*</span>
          </label>
          <textarea
            id="sw-reason"
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Provide a reason for this shift switch…"
            className="w-full px-3 py-2 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-4 rounded-md border bg-card text-sm"
          >
            Cancel
          </button>
          <button
            disabled={
              busy ||
              !facility ||
              !nurseAId ||
              !nurseBId ||
              !date ||
              !reason.trim() ||
              (switchType === "inter-ward" && !wardB) ||
              (shiftA === "LEAVE" && !coverShift) ||
              // Block if no published shift was found for either nurse on this date.
              // shiftA/shiftB = "" means the fetch returned nothing (not a real shift value).
              // "LEAVE" is handled by the coverShift check above; "OFF", "M", "N" are valid.
              (!!nurseAId && !!date && shiftA !== "LEAVE" && !shiftA) ||
              (!!nurseBId && !!date && !shiftB)
            }
            type="submit"
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm inline-flex items-center gap-2 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />} Submit for approval
          </button>
        </div>
      </form>
    </Modal>
  );
}
