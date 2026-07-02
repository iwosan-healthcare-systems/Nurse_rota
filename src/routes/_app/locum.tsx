import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useState } from "react";
import {
  Plus,
  Check,
  X,
  Send,
  Loader2,
  BedDouble,
  Users,
  Activity,
  Clock,
  CheckCircle2,
  AlertCircle,
  MessageSquare,
  ClipboardList,
  CalendarDays,
  Stethoscope,
  ChevronRight,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { EmptyState } from "@/components/EmptyState";
import { toast } from "sonner";
import { logAudit } from "@/lib/audit";
import { cn } from "@/lib/utils";
import { Modal } from "./staff";

export const Route = createFileRoute("/_app/locum")({
  component: LocumPage,
});

// Wards eligible for locum across all facilities
const LOCUM_WARDS = ["ICU", "NICU", "SCBU", "HDU", "ICU & CathLab"];

// ── Types ─────────────────────────────────────────────────────────────────────

type LocumStatus = "pending" | "approved" | "declined" | "invites_sent" | "filled";
type InviteStatus = "pending" | "accepted" | "declined" | "unavailable";

type LocumRequest = {
  id: string;
  shift_date: string;
  shift: "M" | "N";
  facility: string;
  ward: string;
  nurses_in_ward: number;
  ventilated_patients: number;
  hdu_nurses: number;
  status: LocumStatus;
  requested_by: string;
  requested_by_name: string;
  reviewed_by: string | null;
  reviewed_by_name: string | null;
  decline_reason: string | null;
  reviewed_at: string | null;
  accepted_by_nurse_id: string | null;
  accepted_by_nurse_name: string | null;
  accepted_at: string | null;
  created_at: string;
};

type LocumInvite = {
  id: string;
  locum_request_id: string;
  nurse_id: string;
  nurse_name: string;
  status: InviteStatus;
  decline_reason: string | null;
  responded_at: string | null;
  created_at: string;
  locum_request: LocumRequest | null;
};

type OffNurse = {
  nurse_id: string;
  nurse_name: string;
  auth_user_id: string | null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d: string) {
  return new Date(d + "T00:00:00").toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const STATUS_LABEL: Record<LocumStatus, string> = {
  pending: "Awaiting CNO Review",
  approved: "Approved — Send Invites",
  declined: "Declined by CNO",
  invites_sent: "Invites Sent",
  filled: "Shift Filled",
};

const STATUS_COLOR: Record<LocumStatus, string> = {
  pending: "bg-amber-100 text-amber-700",
  approved: "bg-blue-100 text-blue-700",
  declined: "bg-red-100 text-red-700",
  invites_sent: "bg-purple-100 text-purple-700",
  filled: "bg-emerald-100 text-emerald-700",
};

const INVITE_COLOR: Record<InviteStatus, string> = {
  pending: "bg-amber-100 text-amber-700",
  accepted: "bg-emerald-100 text-emerald-700",
  declined: "bg-red-100 text-red-700",
  unavailable: "bg-gray-100 text-gray-500",
};

const INVITE_LABEL: Record<InviteStatus, string> = {
  pending: "Pending",
  accepted: "Accepted",
  declined: "Declined",
  unavailable: "No longer available",
};

const inp =
  "h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-50";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-1 block">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

function LocumPage() {
  const {
    activeRole,
    user,
    nurseId,
    fullName,
    nurseFacility,
    canRequestLocum,
    canApproveLocum,
    canSendLocumInvites,
    canViewLocumHours,
  } = useAuth();
  const qc = useQueryClient();

  const isMatron = canRequestLocum;
  const isCNO = canApproveLocum;

  // CNO (and admin, since admin is in approve_locum defaults) see all facilities.
  // Chief Matron is scoped to their own facility.
  const locumFacility: string | null = isCNO ? null : (nurseFacility ?? null);
  const isNurse = activeRole === "nurse";

  type Tab = "my-requests" | "review" | "all" | "invites" | "history";
  const defaultTab: Tab = isNurse ? "invites" : isCNO ? "review" : "my-requests";
  const [tab, setTab] = useState<Tab>(defaultTab);

  // Dialog state
  const [showCreate, setShowCreate] = useState(false);
  const [reviewReq, setReviewReq] = useState<LocumRequest | null>(null);
  const [reviewAction, setReviewAction] = useState<"approve" | "decline" | null>(null);
  const [sendingReq, setSendingReq] = useState<LocumRequest | null>(null);
  const [respondInvite, setRespondInvite] = useState<LocumInvite | null>(null);
  const [respondAction, setRespondAction] = useState<"accept" | "decline" | null>(null);

  // ── Queries ──────────────────────────────────────────────────────────────────

  const { data: myRequests = [], isLoading: myLoading } = useQuery({
    queryKey: ["locum-my", user?.id],
    enabled: isMatron && !!user?.id,
    queryFn: () => api.get<LocumRequest[]>(`/locum/requests?requested_by=${user!.id}`),
  });

  const { data: pendingRequests = [], isLoading: pendingLoading } = useQuery({
    queryKey: ["locum-pending"],
    enabled: isCNO,
    queryFn: () => api.get<LocumRequest[]>("/locum/requests?status=pending"),
  });

  const { data: allRequests = [], isLoading: allLoading } = useQuery({
    queryKey: ["locum-all"],
    enabled: isCNO,
    queryFn: () => api.get<LocumRequest[]>("/locum/requests"),
  });

  const { data: filledRequests = [], isLoading: historyLoading } = useQuery({
    queryKey: ["locum-history", locumFacility],
    enabled: canViewLocumHours,
    queryFn: () =>
      api.get<LocumRequest[]>(
        `/locum/requests?status=filled${locumFacility ? `&facility=${locumFacility}` : ""}`,
      ),
  });

  const { data: locumLogs = [] } = useQuery({
    queryKey: ["locum-shift-logs"],
    enabled: canViewLocumHours,
    queryFn: () =>
      api.get<
        {
          nurse_id: string;
          shift_date: string;
          hours_logged: number | null;
          started_at: string;
          ended_at: string | null;
          is_late: boolean;
          late_minutes: number | null;
          late_reason: string | null;
        }[]
      >("/shift-logs?is_locum=true"),
  });

  const { data: myInvites = [], isLoading: invitesLoading } = useQuery({
    queryKey: ["locum-invites", nurseId],
    enabled: !!nurseId,
    refetchInterval: 30 * 1000,
    queryFn: () => api.get<LocumInvite[]>(`/locum/invites?nurse_id=${nurseId}`),
  });

  const { data: wards = [] } = useQuery({
    queryKey: ["wards-simple"],
    staleTime: 5 * 60 * 1000,
    queryFn: () => api.get<{ name: string; facility: string | null }[]>("/wards"),
  });

  // ── Action handlers ───────────────────────────────────────────────────────────

  async function handleCreate(form: {
    shift_date: string;
    shift: "M" | "N";
    facility: string;
    ward: string;
    nurses_in_ward: number;
    ventilated_patients: number;
    hdu_nurses: number;
  }) {
    const req = await api.post<LocumRequest>("/locum/requests", {
      ...form,
      status: "pending",
      requested_by: user!.id,
      requested_by_name: fullName ?? user!.email ?? "Unknown",
    });

    const cnoUsers = await api.get<{ user_id: string }[]>("/user-roles?role=cno").catch(() => []);
    if (cnoUsers.length) {
      await api
        .post(
          "/notifications/upsert",
          cnoUsers.map((u) => ({
            user_id: u.user_id,
            notif_key: `locum_review_${req.id}`,
            is_read: false,
          })),
        )
        .catch(() => {});
    }

    await logAudit(
      "Locum shift requested",
      `${form.ward} · ${form.shift === "M" ? "Morning" : "Night"} · ${fmtDate(form.shift_date)}`,
    );
    toast.success("Locum request submitted to CNO for review.");
    qc.invalidateQueries({ queryKey: ["locum-my"] });
    qc.invalidateQueries({ queryKey: ["locum-pending"] });
    qc.invalidateQueries({ queryKey: ["locum-bell"] });
    setShowCreate(false);
  }

  async function handleApprove(req: LocumRequest) {
    await api.patch(`/locum/requests/${req.id}`, {
      status: "approved",
      reviewed_by: user!.id,
      reviewed_by_name: fullName ?? user!.email ?? "CNO",
      reviewed_at: new Date().toISOString(),
    });

    await api
      .post("/notifications/upsert", [
        { user_id: req.requested_by, notif_key: `locum_approved_${req.id}`, is_read: false },
        { user_id: user!.id, notif_key: `locum_review_${req.id}`, is_read: true },
      ])
      .catch(() => {});

    await logAudit(
      "Locum request approved",
      `${req.ward} · ${req.shift === "M" ? "Morning" : "Night"} · ${fmtDate(req.shift_date)}`,
    );
    toast.success("Request approved. The matron can now send invites.");
    qc.invalidateQueries({ queryKey: ["locum-pending"] });
    qc.invalidateQueries({ queryKey: ["locum-all"] });
    qc.invalidateQueries({ queryKey: ["locum-my"] });
    qc.invalidateQueries({ queryKey: ["locum-bell"] });
    setReviewReq(null);
    setReviewAction(null);
  }

  async function handleDecline(req: LocumRequest, reason: string) {
    await api.patch(`/locum/requests/${req.id}`, {
      status: "declined",
      reviewed_by: user!.id,
      reviewed_by_name: fullName ?? user!.email ?? "CNO",
      reviewed_at: new Date().toISOString(),
      decline_reason: reason,
    });

    await api
      .post("/notifications/upsert", [
        { user_id: req.requested_by, notif_key: `locum_declined_${req.id}`, is_read: false },
        { user_id: user!.id, notif_key: `locum_review_${req.id}`, is_read: true },
      ])
      .catch(() => {});

    await logAudit(
      "Locum request declined",
      `${req.ward} · ${req.shift === "M" ? "Morning" : "Night"} · ${fmtDate(req.shift_date)}`,
    );
    toast.success("Request declined. The matron has been notified.");
    qc.invalidateQueries({ queryKey: ["locum-pending"] });
    qc.invalidateQueries({ queryKey: ["locum-all"] });
    qc.invalidateQueries({ queryKey: ["locum-my"] });
    qc.invalidateQueries({ queryKey: ["locum-bell"] });
    setReviewReq(null);
    setReviewAction(null);
  }

  async function handleSendInvites(req: LocumRequest, offNurses: OffNurse[]) {
    if (!offNurses.length) {
      toast.error("No nurses are on OFF duty on this date for this facility.");
      return;
    }

    await api.post(
      "/locum/invites",
      offNurses.map((n) => ({
        locum_request_id: req.id,
        nurse_id: n.nurse_id,
        nurse_name: n.nurse_name,
        status: "pending",
      })),
    );

    await api.patch(`/locum/requests/${req.id}`, { status: "invites_sent" });

    const notifRows = offNurses
      .filter((n) => n.auth_user_id)
      .map((n) => ({
        user_id: n.auth_user_id!,
        notif_key: `locum_invite_${req.id}_${n.nurse_id}`,
        is_read: false,
      }));
    if (notifRows.length) {
      await api.post("/notifications/upsert", notifRows).catch(() => {});
    }

    await api
      .post("/notifications/upsert", [
        { user_id: req.requested_by, notif_key: `locum_approved_${req.id}`, is_read: true },
      ])
      .catch(() => {});

    await logAudit(
      "Locum invites sent",
      `${req.ward} · ${req.shift === "M" ? "Morning" : "Night"} · ${fmtDate(req.shift_date)} · ${offNurses.length} nurse${offNurses.length !== 1 ? "s" : ""}`,
    );
    toast.success(
      `Locum invites sent to ${offNurses.length} nurse${offNurses.length !== 1 ? "s" : ""}.`,
    );
    qc.invalidateQueries({ queryKey: ["locum-my"] });
    qc.invalidateQueries({ queryKey: ["locum-bell"] });
    setSendingReq(null);
  }

  async function handleAcceptInvite(invite: LocumInvite) {
    // Atomic: only claim if the request is still open (status=invites_sent)
    const claimed = await api.post<LocumRequest | null>(
      `/locum/requests/${invite.locum_request_id}/claim`,
      { accepted_by_nurse_id: nurseId, accepted_by_nurse_name: fullName ?? "Nurse" },
    );

    if (!claimed) {
      await api
        .patch(`/locum/invites/${invite.id}`, {
          status: "unavailable",
          responded_at: new Date().toISOString(),
        })
        .catch(() => {});
      toast.error("This locum shift was already taken — another nurse accepted first.");
      qc.invalidateQueries({ queryKey: ["locum-invites"] });
      qc.invalidateQueries({ queryKey: ["locum-bell"] });
      setRespondInvite(null);
      setRespondAction(null);
      return;
    }

    await api.patch(`/locum/invites/${invite.id}`, {
      status: "accepted",
      responded_at: new Date().toISOString(),
    });

    // Notify other pending invitees and mark them unavailable
    const otherPending = await api
      .get<
        { nurse_name: string }[]
      >(`/locum/invites?locum_request_id=${invite.locum_request_id}&status=pending`)
      .catch(() => [] as { nurse_name: string }[]);
    if (otherPending.length) {
      const names = otherPending.map((i) => i.nurse_name).join(",");
      const otherProfiles = await api
        .get<{ id: string }[]>(`/profiles?full_names=${encodeURIComponent(names)}`)
        .catch(() => [] as { id: string }[]);
      if (otherProfiles.length) {
        await api
          .post(
            "/notifications/upsert",
            otherProfiles.map((p) => ({
              user_id: p.id,
              notif_key: `locum_filled_nurse_${invite.locum_request_id}`,
              is_read: false,
            })),
          )
          .catch(() => {});
      }
      await api
        .patch(
          `/locum/invites?locum_request_id=${invite.locum_request_id}&status=pending&neq_id=${invite.id}`,
          { status: "unavailable", responded_at: new Date().toISOString() },
        )
        .catch(() => {});
    }

    // Update nurse's shift assignment OFF → locum shift type
    if (nurseId && invite.locum_request) {
      await api
        .patch(
          `/shift-assignments?nurse_ids=${nurseId}&shift_date_from=${invite.locum_request.shift_date}&shift_date_to=${invite.locum_request.shift_date}&shift=OFF`,
          { shift: invite.locum_request.shift },
        )
        .catch(() => {});
    }

    // Notify matron and CNO
    if (invite.locum_request) {
      const req = invite.locum_request;
      const notifRows = [
        { user_id: req.requested_by, notif_key: `locum_filled_matron_${req.id}`, is_read: false },
        ...(req.reviewed_by
          ? [{ user_id: req.reviewed_by, notif_key: `locum_filled_cno_${req.id}`, is_read: false }]
          : []),
      ];
      await api.post("/notifications/upsert", notifRows).catch(() => {});
    }

    await logAudit(
      "Locum shift accepted",
      `${invite.locum_request?.ward} · ${invite.locum_request?.shift === "M" ? "Morning" : "Night"} · ${fmtDate(invite.locum_request?.shift_date ?? "")}`,
    );
    toast.success("Locum shift accepted! Your schedule has been updated.");
    qc.invalidateQueries({ queryKey: ["locum-invites"] });
    qc.invalidateQueries({ queryKey: ["locum-bell"] });
    setRespondInvite(null);
    setRespondAction(null);
  }

  async function handleDeclineInvite(invite: LocumInvite, reason: string) {
    await api.patch(`/locum/invites/${invite.id}`, {
      status: "declined",
      decline_reason: reason,
      responded_at: new Date().toISOString(),
    });

    await logAudit(
      "Locum invite declined",
      `${invite.locum_request?.ward} · ${invite.locum_request?.shift === "M" ? "Morning" : "Night"} · ${fmtDate(invite.locum_request?.shift_date ?? "")}`,
    );
    toast.success("Invite declined.");
    qc.invalidateQueries({ queryKey: ["locum-invites"] });
    qc.invalidateQueries({ queryKey: ["locum-bell"] });
    setRespondInvite(null);
    setRespondAction(null);
  }

  // ── Tabs ─────────────────────────────────────────────────────────────────────

  type TabDef = { id: Tab; label: string; badge?: number };
  const tabs: TabDef[] = [
    ...(isNurse
      ? [
          {
            id: "invites" as Tab,
            label: "My Locum Invites",
            badge: myInvites.filter((i) => i.status === "pending").length,
          },
        ]
      : []),
    ...(isMatron ? [{ id: "my-requests" as Tab, label: "My Requests" }] : []),
    ...(isCNO
      ? [
          { id: "review" as Tab, label: "Pending Review", badge: pendingRequests.length },
          { id: "all" as Tab, label: "All Requests" },
        ]
      : []),
    ...(canViewLocumHours ? [{ id: "history" as Tab, label: "Locum Hours" }] : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bank Shift (Locum)"
        subtitle="Extra shift invitations for nurses on rest days"
        actions={
          isMatron ? (
            <button
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" />
              New Request
            </button>
          ) : undefined
        }
      />

      <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Eligible wards:</span>
        {LOCUM_WARDS.map((w) => (
          <span
            key={w}
            className="px-2 py-0.5 rounded-full bg-violet-100 text-violet-700 font-medium"
          >
            {w}
          </span>
        ))}
      </div>

      {tabs.length > 1 && (
        <div className="flex gap-1 border-b">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors",
                tab === t.id
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
              {!!t.badge && t.badge > 0 && (
                <span className="h-5 min-w-5 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-bold grid place-items-center">
                  {t.badge}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {tab === "invites" && (
        <NurseInvitesView
          invites={myInvites}
          loading={invitesLoading}
          onRespond={(inv, action) => {
            setRespondInvite(inv);
            setRespondAction(action);
          }}
        />
      )}
      {tab === "my-requests" && (
        <MyRequestsView
          requests={myRequests}
          loading={myLoading}
          onSendInvites={(req) => setSendingReq(req)}
        />
      )}
      {tab === "review" && (
        <ReviewView
          requests={pendingRequests}
          loading={pendingLoading}
          onReview={(req, action) => {
            setReviewReq(req);
            setReviewAction(action);
          }}
        />
      )}
      {tab === "all" && <AllRequestsView requests={allRequests} loading={allLoading} />}
      {tab === "history" && (
        <LocumHistoryView requests={filledRequests} logs={locumLogs} loading={historyLoading} />
      )}

      {/* Dialogs */}
      {showCreate && (
        <CreateRequestModal
          lockedFacility={locumFacility}
          wards={wards.filter(
            (w) => LOCUM_WARDS.includes(w.name) && (!locumFacility || w.facility === locumFacility),
          )}
          onClose={() => setShowCreate(false)}
          onSubmit={handleCreate}
        />
      )}
      {reviewReq && reviewAction && (
        <ReviewModal
          request={reviewReq}
          action={reviewAction}
          onClose={() => {
            setReviewReq(null);
            setReviewAction(null);
          }}
          onApprove={handleApprove}
          onDecline={handleDecline}
        />
      )}
      {sendingReq && (
        <SendInvitesModal
          request={sendingReq}
          onClose={() => setSendingReq(null)}
          onSend={handleSendInvites}
        />
      )}
      {respondInvite && respondAction && (
        <RespondInviteModal
          invite={respondInvite}
          action={respondAction}
          onClose={() => {
            setRespondInvite(null);
            setRespondAction(null);
          }}
          onAccept={handleAcceptInvite}
          onDecline={handleDeclineInvite}
        />
      )}
    </div>
  );
}

// ── Nurse invites view ────────────────────────────────────────────────────────

function NurseInvitesView({
  invites,
  loading,
  onRespond,
}: {
  invites: LocumInvite[];
  loading: boolean;
  onRespond: (invite: LocumInvite, action: "accept" | "decline") => void;
}) {
  if (loading) return <Spinner />;
  if (!invites.length)
    return (
      <EmptyState
        icon={<ClipboardList className="h-8 w-8" />}
        title="No locum invites"
        description="You will be notified here when a locum shift becomes available on your off days."
      />
    );

  const pending = invites.filter((i) => i.status === "pending");
  const past = invites.filter((i) => i.status !== "pending");

  return (
    <div className="space-y-6">
      {pending.length > 0 && (
        <section className="space-y-3">
          <p className="text-sm font-semibold text-amber-600 flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            Pending invites — respond soon
          </p>
          {pending.map((inv) => (
            <InviteCard key={inv.id} invite={inv} showActions onRespond={onRespond} />
          ))}
        </section>
      )}
      {past.length > 0 && (
        <section className="space-y-3">
          <p className="text-sm font-semibold text-muted-foreground">Past invites</p>
          {past.map((inv) => (
            <InviteCard key={inv.id} invite={inv} />
          ))}
        </section>
      )}
    </div>
  );
}

function InviteCard({
  invite,
  showActions,
  onRespond,
}: {
  invite: LocumInvite;
  showActions?: boolean;
  onRespond?: (invite: LocumInvite, action: "accept" | "decline") => void;
}) {
  const req = invite.locum_request;
  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <p className="font-medium text-sm">
            {req?.ward ?? "Unknown Ward"} ·{" "}
            <span
              className={cn(
                "text-xs font-semibold",
                req?.shift === "M" ? "text-amber-600" : "text-blue-600",
              )}
            >
              {req?.shift === "M" ? "Morning Shift" : "Night Shift"}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            {req ? fmtDate(req.shift_date) : "—"} · {req?.facility}
          </p>
        </div>
        <span
          className={cn(
            "text-xs px-2 py-0.5 rounded-full font-medium shrink-0",
            INVITE_COLOR[invite.status],
          )}
        >
          {INVITE_LABEL[invite.status]}
        </span>
      </div>

      {invite.status === "unavailable" && (
        <p className="text-xs text-muted-foreground bg-muted rounded-md px-3 py-2">
          Another nurse accepted this locum shift before you responded.
        </p>
      )}
      {invite.status === "declined" && invite.decline_reason && (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium">Your reason:</span> {invite.decline_reason}
        </p>
      )}

      {showActions && invite.status === "pending" && onRespond && (
        <div className="flex gap-2 pt-1">
          <button
            onClick={() => onRespond(invite, "accept")}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700"
          >
            <Check className="h-3.5 w-3.5" />
            Accept
          </button>
          <button
            onClick={() => onRespond(invite, "decline")}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border text-xs font-medium hover:bg-muted"
          >
            <X className="h-3.5 w-3.5" />
            Decline
          </button>
        </div>
      )}
    </div>
  );
}

// ── My requests view (Chief Matron) ───────────────────────────────────────────

function MyRequestsView({
  requests,
  loading,
  onSendInvites,
}: {
  requests: LocumRequest[];
  loading: boolean;
  onSendInvites: (req: LocumRequest) => void;
}) {
  if (loading) return <Spinner />;
  if (!requests.length)
    return (
      <EmptyState
        icon={<CalendarDays className="h-8 w-8" />}
        title="No locum requests yet"
        description="Create a new request to invite nurses on their rest day to cover a shift."
      />
    );

  return (
    <div className="space-y-3">
      {requests.map((req) => (
        <RequestCard key={req.id} request={req} onSendInvites={onSendInvites} showMatronActions />
      ))}
    </div>
  );
}

// ── Review view (CNO) ─────────────────────────────────────────────────────────

function ReviewView({
  requests,
  loading,
  onReview,
}: {
  requests: LocumRequest[];
  loading: boolean;
  onReview: (req: LocumRequest, action: "approve" | "decline") => void;
}) {
  if (loading) return <Spinner />;
  if (!requests.length)
    return (
      <EmptyState
        icon={<CheckCircle2 className="h-8 w-8" />}
        title="No pending requests"
        description="All locum requests have been reviewed."
      />
    );

  return (
    <div className="space-y-3">
      {requests.map((req) => (
        <RequestCard key={req.id} request={req} onReview={onReview} showCNOActions />
      ))}
    </div>
  );
}

// ── All requests view (CNO / Admin) ──────────────────────────────────────────

function AllRequestsView({ requests, loading }: { requests: LocumRequest[]; loading: boolean }) {
  if (loading) return <Spinner />;
  if (!requests.length)
    return (
      <EmptyState
        icon={<ClipboardList className="h-8 w-8" />}
        title="No locum requests"
        description="No locum shift requests have been created yet."
      />
    );

  return (
    <div className="space-y-3">
      {requests.map((req) => (
        <RequestCard key={req.id} request={req} />
      ))}
    </div>
  );
}

// ── Locum hours / history view ────────────────────────────────────────────────

function LocumHistoryView({
  requests,
  logs,
  loading,
}: {
  requests: LocumRequest[];
  logs: {
    nurse_id: string;
    shift_date: string;
    hours_logged: number | null;
    started_at: string;
    ended_at: string | null;
    is_late: boolean;
    late_minutes: number | null;
    late_reason: string | null;
  }[];
  loading: boolean;
}) {
  if (loading) return <Spinner />;
  if (!requests.length)
    return (
      <EmptyState
        icon={<Clock className="h-8 w-8" />}
        title="No locum shifts filled yet"
        description="Completed locum shifts will appear here once a nurse accepts an invitation."
      />
    );

  // Build a lookup: "nurseId|date" → log entry for actual hours
  const logMap = new Map(logs.map((l) => [`${l.nurse_id}|${l.shift_date}`, l]));

  // Per-nurse summary — shifts + total hours worked
  const summary = Object.values(
    requests.reduce<Record<string, { name: string; count: number; hours: number }>>((acc, r) => {
      const key = r.accepted_by_nurse_id ?? "unknown";
      if (!acc[key]) acc[key] = { name: r.accepted_by_nurse_name ?? "Unknown", count: 0, hours: 0 };
      acc[key].count++;
      const log = r.accepted_by_nurse_id
        ? logMap.get(`${r.accepted_by_nurse_id}|${r.shift_date}`)
        : undefined;
      acc[key].hours += log?.hours_logged ?? 0;
      return acc;
    }, {}),
  ).sort((a, b) => b.count - a.count);

  function fmtH(h: number) {
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    if (hh === 0) return `${mm}m`;
    if (mm === 0) return `${hh}h`;
    return `${hh}h ${mm}m`;
  }

  return (
    <div className="space-y-6">
      {/* Per-nurse summary badges */}
      <div className="flex flex-wrap gap-2">
        {summary.map((s) => (
          <div
            key={s.name}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-violet-100 text-violet-800 text-xs font-medium"
          >
            <Stethoscope className="h-3.5 w-3.5" />
            {s.name} · {s.count} shift{s.count !== 1 ? "s" : ""}
            {s.hours > 0 && <> · {fmtH(s.hours)}</>}
          </div>
        ))}
      </div>

      {/* Full log table */}
      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            <tr>
              <th className="text-left px-4 py-2.5">Date</th>
              <th className="text-left px-4 py-2.5">Nurse</th>
              <th className="text-left px-4 py-2.5">Ward</th>
              <th className="text-left px-4 py-2.5">Facility</th>
              <th className="text-center px-4 py-2.5">Shift</th>
              <th className="text-center px-4 py-2.5">Hours</th>
              <th className="text-left px-4 py-2.5">Late</th>
              <th className="text-center px-4 py-2.5">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {requests.map((r) => {
              const log = r.accepted_by_nurse_id
                ? logMap.get(`${r.accepted_by_nurse_id}|${r.shift_date}`)
                : undefined;
              return (
                <tr key={r.id} className="hover:bg-muted/20">
                  <td className="px-4 py-2.5 text-xs">{fmtDate(r.shift_date)}</td>
                  <td className="px-4 py-2.5 font-medium text-sm">
                    {r.accepted_by_nurse_name ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{r.ward}</td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{r.facility}</td>
                  <td className="px-4 py-2.5 text-center">
                    <span
                      className={cn(
                        "text-xs px-2 py-0.5 rounded-full font-semibold",
                        r.shift === "M"
                          ? "bg-amber-100 text-amber-700"
                          : "bg-indigo-100 text-indigo-700",
                      )}
                    >
                      {r.shift === "M" ? "Morning" : "Night"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-center text-xs font-semibold">
                    {log?.hours_logged != null ? fmtH(log.hours_logged) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-xs">
                    {log?.is_late ? (
                      <span
                        className="inline-flex items-center gap-1 text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full"
                        title={log.late_reason ?? undefined}
                      >
                        {log.late_minutes}m late
                        {log.late_reason && (
                          <span className="hidden sm:inline text-amber-600 max-w-35 truncate">
                            — {log.late_reason}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    {!log ? (
                      <span className="text-xs text-muted-foreground">Not started</span>
                    ) : !log.ended_at ? (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-700 font-medium">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        Active
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {new Date(log.ended_at).toLocaleString("en-GB", {
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Request card ──────────────────────────────────────────────────────────────

function RequestCard({
  request: req,
  showMatronActions,
  showCNOActions,
  onSendInvites,
  onReview,
}: {
  request: LocumRequest;
  showMatronActions?: boolean;
  showCNOActions?: boolean;
  onSendInvites?: (req: LocumRequest) => void;
  onReview?: (req: LocumRequest, action: "approve" | "decline") => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <div
        className="flex items-start gap-3 p-4 cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-medium text-sm">{req.ward}</p>
            <span
              className={cn(
                "text-xs px-2 py-0.5 rounded-full font-medium",
                req.shift === "M" ? "bg-amber-50 text-amber-700" : "bg-blue-50 text-blue-700",
              )}
            >
              {req.shift === "M" ? "Morning" : "Night"}
            </span>
            <span
              className={cn(
                "text-xs px-2 py-0.5 rounded-full font-medium",
                STATUS_COLOR[req.status],
              )}
            >
              {STATUS_LABEL[req.status]}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {fmtDate(req.shift_date)} · {req.facility} · Requested by {req.requested_by_name}
          </p>
        </div>
        <ChevronRight
          className={cn(
            "h-4 w-4 text-muted-foreground shrink-0 transition-transform",
            expanded && "rotate-90",
          )}
        />
      </div>

      {expanded && (
        <div className="border-t px-4 py-4 space-y-4">
          {/* Ward assessment questions */}
          <div className="grid grid-cols-3 gap-3">
            <StatBox
              icon={<Users className="h-4 w-4" />}
              label="Nurses in Ward"
              value={req.nurses_in_ward}
            />
            <StatBox
              icon={<Activity className="h-4 w-4" />}
              label="Ventilated Patients"
              value={req.ventilated_patients}
            />
            <StatBox
              icon={<Stethoscope className="h-4 w-4" />}
              label="HDU Nurses"
              value={req.hdu_nurses}
            />
          </div>

          {req.status === "declined" && req.decline_reason && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-md px-3 py-2.5">
              <MessageSquare className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-semibold text-red-700">
                  Decline reason from {req.reviewed_by_name}
                </p>
                <p className="text-xs text-red-600 mt-0.5">{req.decline_reason}</p>
              </div>
            </div>
          )}

          {req.status === "filled" && req.accepted_by_nurse_name && (
            <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2.5">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
              <p className="text-xs text-emerald-700">
                Shift accepted by{" "}
                <span className="font-semibold">{req.accepted_by_nurse_name}</span>
                {req.accepted_at && (
                  <>
                    {" "}
                    ·{" "}
                    {new Date(req.accepted_at).toLocaleString("en-GB", {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </>
                )}
              </p>
            </div>
          )}

          <div className="flex gap-2 flex-wrap">
            {showMatronActions && req.status === "approved" && onSendInvites && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onSendInvites(req);
                }}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90"
              >
                <Send className="h-3.5 w-3.5" />
                Send Locum Invite
              </button>
            )}
            {showCNOActions && req.status === "pending" && onReview && (
              <>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onReview(req, "approve");
                  }}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700"
                >
                  <Check className="h-3.5 w-3.5" />
                  Approve
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onReview(req, "decline");
                  }}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border text-xs font-medium hover:bg-muted"
                >
                  <X className="h-3.5 w-3.5" />
                  Decline
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatBox({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-md border bg-muted/30 p-3 text-center">
      <div className="text-muted-foreground">{icon}</div>
      <p className="text-lg font-bold">{value}</p>
      <p className="text-[10px] text-muted-foreground leading-tight">{label}</p>
    </div>
  );
}

// ── Create request modal ──────────────────────────────────────────────────────

function CreateRequestModal({
  wards,
  lockedFacility,
  onClose,
  onSubmit,
}: {
  wards: { name: string; facility: string | null }[];
  lockedFacility: string | null;
  onClose: () => void;
  onSubmit: (form: {
    shift_date: string;
    shift: "M" | "N";
    facility: string;
    ward: string;
    nurses_in_ward: number;
    ventilated_patients: number;
    hdu_nurses: number;
  }) => Promise<void>;
}) {
  // Derive unique facility list from the filtered wards prop
  const facilities = [...new Set(wards.map((w) => w.facility).filter(Boolean))] as string[];

  const [busy, setBusy] = useState(false);
  const [shiftDate, setShiftDate] = useState(todayYmd());
  const [shift, setShift] = useState<"M" | "N">("M");
  const [facility, setFacility] = useState(lockedFacility ?? facilities[0] ?? "");
  const [ward, setWard] = useState("");
  const [nursesInWard, setNursesInWard] = useState("");
  const [ventPatients, setVentPatients] = useState("");
  const [hduNurses, setHduNurses] = useState("");

  // Wards available for the selected facility
  const facilityWards = wards.filter((w) => w.facility === facility);

  function handleFacilityChange(f: string) {
    setFacility(f);
    setWard(""); // reset ward whenever facility changes
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!shiftDate || !facility) return toast.error("Please select a facility.");
    if (!ward) return toast.error("Please select a ward.");
    if (!nursesInWard || !ventPatients || !hduNurses)
      return toast.error("Please answer all assessment questions.");
    setBusy(true);
    try {
      await onSubmit({
        shift_date: shiftDate,
        shift,
        facility,
        ward,
        nurses_in_ward: parseInt(nursesInWard),
        ventilated_patients: parseInt(ventPatients),
        hdu_nurses: parseInt(hduNurses),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to submit request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New Locum Shift Request" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date *">
            <input
              type="date"
              required
              aria-label="Shift date"
              className={inp}
              value={shiftDate}
              min={todayYmd()}
              onChange={(e) => setShiftDate(e.target.value)}
            />
          </Field>
          <Field label="Shift Type *">
            <select
              aria-label="Shift type"
              className={inp}
              value={shift}
              onChange={(e) => setShift(e.target.value as "M" | "N")}
            >
              <option value="M">Morning (M)</option>
              <option value="N">Night (N)</option>
            </select>
          </Field>
        </div>

        <Field label="Facility *">
          {lockedFacility ? (
            <div
              className={`${inp} flex items-center bg-muted text-muted-foreground cursor-not-allowed`}
            >
              {lockedFacility}
            </div>
          ) : (
            <select
              aria-label="Facility"
              className={inp}
              value={facility}
              onChange={(e) => handleFacilityChange(e.target.value)}
              required
            >
              <option value="">Select facility…</option>
              {facilities.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label="Ward *">
          <select
            aria-label="Ward"
            className={inp}
            value={ward}
            onChange={(e) => setWard(e.target.value)}
            required
            disabled={!facility}
          >
            <option value="">{facility ? "Select ward…" : "Select a facility first"}</option>
            {facilityWards.map((w) => (
              <option key={w.name} value={w.name}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>

        <hr />
        <p className="text-sm font-semibold flex items-center gap-2">
          <BedDouble className="h-4 w-4 text-muted-foreground" />
          Ward Assessment
        </p>

        <Field label="How many nurses are currently in the ward/unit?">
          <input
            type="number"
            min={0}
            required
            className={inp}
            placeholder="e.g. 4"
            value={nursesInWard}
            onChange={(e) => setNursesInWard(e.target.value)}
          />
        </Field>

        <Field label="How many patients are ventilated?">
          <input
            type="number"
            min={0}
            required
            className={inp}
            placeholder="e.g. 2"
            value={ventPatients}
            onChange={(e) => setVentPatients(e.target.value)}
          />
        </Field>

        <Field label="How many HDU nurses are in the unit?">
          <input
            type="number"
            min={0}
            required
            className={inp}
            placeholder="e.g. 1"
            value={hduNurses}
            onChange={(e) => setHduNurses(e.target.value)}
          />
        </Field>

        <div className="flex gap-2 pt-2">
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-2 h-10 flex-1 justify-center rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Submit to CNO
          </button>
          <button
            type="button"
            onClick={onClose}
            className="h-10 px-4 rounded-md border text-sm font-medium hover:bg-muted"
          >
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Review modal (CNO approve / decline) ──────────────────────────────────────

function ReviewModal({
  request,
  action,
  onClose,
  onApprove,
  onDecline,
}: {
  request: LocumRequest;
  action: "approve" | "decline";
  onClose: () => void;
  onApprove: (req: LocumRequest) => Promise<void>;
  onDecline: (req: LocumRequest, reason: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (action === "decline" && !reason.trim())
      return toast.error("Please provide a reason for declining.");
    setBusy(true);
    try {
      if (action === "approve") await onApprove(request);
      else await onDecline(request, reason.trim());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to process review.");
    } finally {
      setBusy(false);
    }
  }

  const isDecline = action === "decline";

  return (
    <Modal title={isDecline ? "Decline Locum Request" : "Approve Locum Request"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-md bg-muted/40 p-4 space-y-2 text-sm">
          <p>
            <span className="font-medium">Ward:</span> {request.ward} · {request.facility}
          </p>
          <p>
            <span className="font-medium">Date:</span> {fmtDate(request.shift_date)}
          </p>
          <p>
            <span className="font-medium">Shift:</span>{" "}
            {request.shift === "M" ? "Morning" : "Night"}
          </p>
          <p>
            <span className="font-medium">Requested by:</span> {request.requested_by_name}
          </p>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <StatBox
            icon={<Users className="h-4 w-4" />}
            label="Nurses in Ward"
            value={request.nurses_in_ward}
          />
          <StatBox
            icon={<Activity className="h-4 w-4" />}
            label="Ventilated"
            value={request.ventilated_patients}
          />
          <StatBox
            icon={<Stethoscope className="h-4 w-4" />}
            label="HDU Nurses"
            value={request.hdu_nurses}
          />
        </div>

        {isDecline && (
          <Field label="Reason for declining *">
            <textarea
              required
              rows={3}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none"
              placeholder="Enter your reason…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        )}

        {!isDecline && (
          <p className="text-sm text-muted-foreground">
            Approving this request will notify the matron to send locum invites to nurses on OFF
            duty on this date.
          </p>
        )}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy}
            className={cn(
              "inline-flex items-center gap-2 h-10 flex-1 justify-center rounded-md text-sm font-medium disabled:opacity-50",
              isDecline
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : "bg-emerald-600 text-white hover:bg-emerald-700",
            )}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isDecline ? (
              <X className="h-4 w-4" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            {isDecline ? "Decline Request" : "Approve Request"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="h-10 px-4 rounded-md border text-sm font-medium hover:bg-muted"
          >
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Send invites modal ────────────────────────────────────────────────────────

function SendInvitesModal({
  request,
  onClose,
  onSend,
}: {
  request: LocumRequest;
  onClose: () => void;
  onSend: (req: LocumRequest, nurses: OffNurse[]) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  // Fetch nurses on OFF duty for this date + facility.
  // We scope to the facility first (small list) then check assignments, rather than
  // fetching all OFF assignments across every facility — the cross-facility approach
  // builds an unbounded nurse_id array that can exceed Supabase's URL length limit
  // and silently return empty results.
  const { data: offNurses, isLoading } = useQuery({
    queryKey: ["locum-off-nurses", request.shift_date, request.facility],
    queryFn: async () => {
      // 1. Get nurses at this facility with ward/role for eligibility filtering
      const facilityNurses = await api
        .get<
          { id: string; name: string; role: string | null; ward: string | null }[]
        >(`/nurses?facility=${encodeURIComponent(request.facility)}`)
        .catch(() => []);

      const facilityIds = facilityNurses.map((n) => n.id);
      if (!facilityIds.length) return [] as OffNurse[];

      // 2. Single query — custom API accepts nurse_ids as comma-sep ANY($1)
      const offAssignments = await api
        .get<
          { nurse_id: string }[]
        >(`/shift-assignments?shift_date=${request.shift_date}&shift=OFF&status=published&nurse_ids=${facilityIds.join(",")}`)
        .catch(() => []);

      const offIds = new Set(offAssignments.map((a) => a.nurse_id));
      const offNursesList = facilityNurses.filter((n) => offIds.has(n.id));
      if (!offNursesList.length) return [] as OffNurse[];

      // 3. Filter to request ward only; exclude matrons, nurse assistants, and interns
      const isExcludedRole = (role: string | null) =>
        /matron/i.test(role ?? "") ||
        /nurse\s*assistant/i.test(role ?? "") ||
        /intern/i.test(role ?? "");
      const eligible = offNursesList.filter(
        (n) =>
          !isExcludedRole(n.role) &&
          (n.ward ?? "")
            .split("|")
            .map((w) => w.trim())
            .includes(request.ward),
      );
      if (!eligible.length) return [] as OffNurse[];

      // 4. Look up auth user IDs by matching name → profiles.full_name
      const names = eligible.map((n) => n.name);
      const profiles = await api
        .get<
          { id: string; full_name: string }[]
        >(`/profiles?full_names=${encodeURIComponent(names.join(","))}`)
        .catch(() => []);

      const profileMap = Object.fromEntries(profiles.map((p) => [p.full_name, p.id]));

      return eligible.map((n) => ({
        nurse_id: n.id,
        nurse_name: n.name,
        auth_user_id: profileMap[n.name] ?? null,
      })) as OffNurse[];
    },
  });

  async function confirm() {
    if (!offNurses) return;
    setBusy(true);
    try {
      await onSend(request, offNurses);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send invites.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Send Locum Invites" onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-md bg-muted/40 p-4 space-y-1 text-sm">
          <p>
            <span className="font-medium">Date:</span> {fmtDate(request.shift_date)}
          </p>
          <p>
            <span className="font-medium">Shift:</span>{" "}
            {request.shift === "M" ? "Morning" : "Night"} · {request.ward} · {request.facility}
          </p>
        </div>

        <p className="text-sm text-muted-foreground">
          The invite will be sent to nurses in the <strong>{request.ward}</strong> ward who are on{" "}
          <strong>OFF</strong> duty on this date at <strong>{request.facility}</strong>, excluding
          matrons, nurse assistants, and interns. The first nurse to accept will be assigned the
          shift.
        </p>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" />
            Finding available nurses…
          </div>
        ) : !offNurses?.length ? (
          <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-md px-3 py-2.5 text-sm text-amber-700">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <p>
              No nurses are on OFF duty on this date for <strong>{request.facility}</strong>. The
              invite cannot be sent.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-medium">
              <span className="text-primary font-bold">{offNurses.length}</span> nurse
              {offNurses.length !== 1 ? "s" : ""} will receive an invite:
            </p>
            <ul className="space-y-1 max-h-40 overflow-y-auto">
              {offNurses.map((n) => (
                <li
                  key={n.nurse_id}
                  className="flex items-center gap-2 text-sm text-muted-foreground"
                >
                  <Clock className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                  {n.nurse_name}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button
            onClick={confirm}
            disabled={busy || isLoading || !offNurses?.length}
            className="inline-flex items-center gap-2 h-10 flex-1 justify-center rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send Invites
          </button>
          <button
            onClick={onClose}
            className="h-10 px-4 rounded-md border text-sm font-medium hover:bg-muted"
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Respond invite modal (Nurse) ──────────────────────────────────────────────

function RespondInviteModal({
  invite,
  action,
  onClose,
  onAccept,
  onDecline,
}: {
  invite: LocumInvite;
  action: "accept" | "decline";
  onClose: () => void;
  onAccept: (invite: LocumInvite) => Promise<void>;
  onDecline: (invite: LocumInvite, reason: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const req = invite.locum_request;
  const isDecline = action === "decline";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (isDecline && !reason.trim()) return toast.error("Please provide a reason for declining.");
    setBusy(true);
    try {
      if (isDecline) await onDecline(invite, reason.trim());
      else await onAccept(invite);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={isDecline ? "Decline Locum Invite" : "Accept Locum Shift"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-md bg-muted/40 p-4 space-y-1 text-sm">
          <p>
            <span className="font-medium">Ward:</span> {req?.ward ?? "—"} · {req?.facility}
          </p>
          <p>
            <span className="font-medium">Date:</span> {req ? fmtDate(req.shift_date) : "—"}
          </p>
          <p>
            <span className="font-medium">Shift:</span>{" "}
            {req?.shift === "M"
              ? "Morning (08:00 – 17:00)"
              : req?.shift === "N"
                ? "Night (17:00 – 08:00)"
                : "—"}
          </p>
        </div>

        {!isDecline && (
          <p className="text-sm text-muted-foreground">
            By accepting, this locum shift will be added to your schedule. You will be the first to
            accept so the shift is yours.
          </p>
        )}

        {isDecline && (
          <Field label="Reason for declining *">
            <textarea
              required
              rows={3}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none"
              placeholder="Why are you declining this shift?"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        )}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy}
            className={cn(
              "inline-flex items-center gap-2 h-10 flex-1 justify-center rounded-md text-sm font-medium disabled:opacity-50",
              isDecline
                ? "border hover:bg-muted"
                : "bg-emerald-600 text-white hover:bg-emerald-700",
            )}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isDecline ? (
              <X className="h-4 w-4" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            {isDecline ? "Decline Shift" : "Accept Shift"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="h-10 px-4 rounded-md border text-sm font-medium hover:bg-muted"
          >
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}
