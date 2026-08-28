import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useState } from "react";
import { AlertTriangle, Pencil, PlaneTakeoff, History, Search } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { Modal } from "./staff";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { FacilityChips } from "@/components/FacilityChips";

export const Route = createFileRoute("/_app/leave-entitlements")({
  head: () => ({
    meta: [
      { title: "Leave Entitlements — Nurses Rota" },
      {
        name: "description",
        content: "Track and manage each staff member's leave entitlement balances.",
      },
    ],
  }),
  component: LeaveEntitlementsPage,
});

const ENTITLEMENT_TYPES = [
  "Annual",
  "Sick",
  "Study Leave",
  "Compassionate Leave",
  "Maternity",
] as const;

type EntitlementInfo = {
  cap: number;
  used: number;
  usedFromRequests: number;
  usedFromAdjustments: number;
  remaining: number;
  exhausted: boolean;
  period: "year" | "month";
  windowStart: string;
  windowEnd: string;
};
type EntitlementUsage = Record<string, EntitlementInfo>;
type EntitlementRow = {
  nurse_id: string;
  name: string;
  role: string;
  ward: string | null;
  facility: string | null;
  entitlements: EntitlementUsage;
};
type Adjustment = {
  id: string;
  nurse_id: string;
  type: string;
  days: string | number;
  period_year: number;
  period_month: number | null;
  reason: string;
  created_by_name: string | null;
  created_at: string;
};

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function LeaveEntitlementsPage() {
  const { isAdmin, activeRole, nurseId, fullName, canManageLeaveEntitlements } = useAuth();
  // Viewing the admin-wide table is a plain role check, matching the
  // backend's bulk-listing route (GET /leave-entitlements) — unchanged by
  // the Permissions matrix, since that only governs who can ADJUST a
  // balance (canManageLeaveEntitlements, passed down below), not who can see
  // the table at all. If admin later revokes HR's adjust capability, HR
  // should still see the table read-only rather than losing the page.
  const canManage = isAdmin || activeRole === "hr_admin";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Leave Entitlements"
        subtitle={
          canManage
            ? "Track and manage every staff member's leave entitlement balances."
            : "Your leave entitlement balances for this period."
        }
      />
      {canManage ? (
        <ManageEntitlements canAdjust={canManageLeaveEntitlements} />
      ) : (
        <OwnEntitlements nurseId={nurseId} fullName={fullName} />
      )}
    </div>
  );
}

// ── Staff self-view — read-only, own record only ────────────────────────────

function OwnEntitlements({
  nurseId,
  fullName,
}: {
  nurseId: string | null;
  fullName: string | null;
}) {
  const { data: usage, isLoading } = useQuery<EntitlementUsage>({
    queryKey: ["leave-entitlements", nurseId],
    enabled: !!nurseId,
    queryFn: () => api.get<EntitlementUsage>(`/leave-entitlements/${nurseId}`),
  });

  if (!nurseId) {
    return (
      <EmptyState
        icon={<PlaneTakeoff className="h-6 w-6" />}
        title="No staff record linked to your account"
        description="Contact an admin if you believe this is a mistake."
      />
    );
  }
  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading your entitlements…</p>;
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {ENTITLEMENT_TYPES.map((t) => {
        const e = usage?.[t];
        if (!e) return null;
        const cls = e.exhausted
          ? "border-rose-300 bg-rose-50 dark:bg-rose-950/20"
          : e.remaining <= Math.max(1, Math.ceil(e.cap * 0.2))
            ? "border-amber-300 bg-amber-50 dark:bg-amber-950/20"
            : "border-border bg-card";
        return (
          <div key={t} className={`rounded-xl border p-5 shadow-soft ${cls}`}>
            <p className="text-sm font-semibold">{t}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Resets {e.period === "month" ? "every calendar month" : "each leave year (Apr 1)"}
            </p>
            <p className="text-3xl font-bold mt-3 tabular-nums">
              {e.remaining}{" "}
              <span className="text-base font-normal text-muted-foreground">left</span>
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {e.used} of {e.cap} day(s) used {e.period === "month" ? "this month" : "this leave year"}
            </p>
            {e.exhausted && (
              <p className="text-xs font-medium text-rose-700 dark:text-rose-400 mt-2 flex items-center gap-1">
                <AlertTriangle className="h-3.5 w-3.5" /> Exhausted for this period
              </p>
            )}
          </div>
        );
      })}
      <p className="col-span-full text-xs text-muted-foreground mt-1">
        {fullName ?? "You"} · Pending requests count toward usage the same as Approved ones, so
        what's shown here is what's actually still available to request.
      </p>
    </div>
  );
}

// ── Admin/HR management view ─────────────────────────────────────────────────

function ManageEntitlements({ canAdjust }: { canAdjust: boolean }) {
  const qc = useQueryClient();
  const [facility, setFacility] = useState("");
  const [adjustingCell, setAdjustingCell] = useState<{
    nurseId: string;
    nurseName: string;
    type: string;
    period: "year" | "month";
  } | null>(null);

  const { data: rows = [], isLoading } = useQuery<EntitlementRow[]>({
    queryKey: ["leave-entitlements-all", facility],
    queryFn: () =>
      api.get<EntitlementRow[]>(
        `/leave-entitlements${facility ? `?facility=${encodeURIComponent(facility)}` : ""}`,
      ),
  });

  const [search, setSearch] = useState("");
  const visibleRows = search.trim()
    ? rows.filter((r) => r.name.toLowerCase().includes(search.trim().toLowerCase()))
    : rows;
  const exhaustedCount = visibleRows.filter((r) =>
    ENTITLEMENT_TYPES.some((t) => r.entitlements[t]?.exhausted),
  ).length;

  return (
    <>
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <FacilityChips value={facility} onChange={setFacility} showAll />
      </div>

      <div className="relative mb-4 max-w-sm">
        <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <input
          type="search"
          aria-label="Search staff"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full h-9 pl-9 pr-3 rounded-md bg-muted/60 text-sm outline-none focus:ring-2 focus:ring-ring"
          placeholder="Search by name…"
        />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 mb-6">
        <div className="bg-card border rounded-xl p-5 shadow-soft">
          <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
            Staff Tracked
          </p>
          <p className="text-3xl font-bold mt-2">{visibleRows.length}</p>
        </div>
        <div className="bg-card border rounded-xl p-5 shadow-soft">
          <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
            Have Exhausted a Type
          </p>
          <p className="text-3xl font-bold mt-2">{exhaustedCount}</p>
        </div>
        <div className="bg-card border rounded-xl p-5 shadow-soft">
          <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
            Sick Leave Resets
          </p>
          <p className="text-3xl font-bold mt-2">Monthly</p>
        </div>
      </div>

      <p className="text-xs text-muted-foreground mb-4">
        Annual, Study Leave, Compassionate Leave, and Maternity reset each leave year (1 April to
        31 March). Sick leave resets every calendar month. Pending requests count toward usage the
        same as Approved ones. Use the pencil icon to credit leave taken before this system existed
        — it's tracked separately from real requests and always shown as its own number.
      </p>

      <div className="bg-card border rounded-xl shadow-soft overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="text-left px-4 py-3 font-semibold">Nurse</th>
                <th className="text-left px-4 py-3 font-semibold">Facility / Ward</th>
                {ENTITLEMENT_TYPES.map((t) => (
                  <th key={t} className="text-center px-4 py-3 font-semibold">
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td
                    colSpan={2 + ENTITLEMENT_TYPES.length}
                    className="px-4 py-8 text-center text-muted-foreground"
                  >
                    Loading…
                  </td>
                </tr>
              ) : visibleRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={2 + ENTITLEMENT_TYPES.length}
                    className="px-4 py-8 text-center text-muted-foreground"
                  >
                    {search.trim() ? "No staff match your search." : "No staff found."}
                  </td>
                </tr>
              ) : (
                visibleRows.map((r) => (
                  <tr key={r.nurse_id} className="border-t hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium">{r.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {r.facility ?? "—"}
                      {r.ward ? ` · ${r.ward}` : ""}
                    </td>
                    {ENTITLEMENT_TYPES.map((t) => {
                      const e = r.entitlements[t];
                      if (!e)
                        return (
                          <td key={t} className="px-4 py-3 text-center">
                            —
                          </td>
                        );
                      const cls = e.exhausted
                        ? "bg-rose-100 text-rose-700"
                        : e.remaining <= Math.max(1, Math.ceil(e.cap * 0.2))
                          ? "bg-amber-100 text-amber-700"
                          : "bg-emerald-100 text-emerald-700";
                      return (
                        <td key={t} className="px-4 py-3 text-center">
                          <div className="inline-flex items-center gap-1.5">
                            <span
                              className={`inline-flex items-center justify-center px-2 py-0.5 rounded-full text-xs font-semibold tabular-nums ${cls}`}
                              title={`${e.usedFromRequests} day(s) from system requests + ${e.usedFromAdjustments} manually adjusted = ${e.used} of ${e.cap} used ${e.period === "month" ? "this month" : "this leave year"}`}
                            >
                              {e.used}/{e.cap}
                            </span>
                            {canAdjust && (
                              <button
                                type="button"
                                onClick={() =>
                                  setAdjustingCell({
                                    nurseId: r.nurse_id,
                                    nurseName: r.name,
                                    type: t,
                                    period: e.period,
                                  })
                                }
                                title={`Adjust ${t} for ${r.name}`}
                                className="text-muted-foreground hover:text-foreground"
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {adjustingCell && (
        <AdjustEntitlementModal
          nurseId={adjustingCell.nurseId}
          nurseName={adjustingCell.nurseName}
          type={adjustingCell.type}
          period={adjustingCell.period}
          onClose={() => setAdjustingCell(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["leave-entitlements-all"] });
          }}
        />
      )}
    </>
  );
}

function AdjustEntitlementModal({
  nurseId,
  nurseName,
  type,
  period,
  onClose,
  onSaved,
}: {
  nurseId: string;
  nurseName: string;
  type: string;
  period: "year" | "month";
  onClose: () => void;
  onSaved: () => void;
}) {
  const now = new Date();
  const [days, setDays] = useState("");
  const [year, setYear] = useState(
    now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1,
  );
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: history = [] } = useQuery<Adjustment[]>({
    queryKey: ["leave-entitlement-adjustments", nurseId],
    queryFn: () => api.get<Adjustment[]>(`/leave-entitlements/${nurseId}/adjustments`),
  });
  const historyForType = history.filter((a) => a.type === type);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const daysNum = Number(days);
    if (!days || Number.isNaN(daysNum) || daysNum === 0) {
      toast.error("Enter a non-zero number of days (negative to correct a previous entry).");
      return;
    }
    if (!reason.trim()) {
      toast.error("Please provide a reason for this adjustment.");
      return;
    }
    setBusy(true);
    try {
      await api.post(`/leave-entitlements/${nurseId}/adjustments`, {
        type,
        days: daysNum,
        period_year: year,
        period_month: period === "month" ? month : null,
        reason: reason.trim(),
      });
      toast.success("Adjustment recorded");
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to record adjustment");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Adjust ${type} — ${nurseName}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs text-muted-foreground">
          For leave taken before this system existed, or any other case never submitted as a real
          request. This is tracked separately from — and shown alongside, not merged into — actual
          leave requests, so it's always clear which is which.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium block mb-1">Days</label>
            <input
              type="number"
              step="1"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              placeholder="e.g. 3, or -3 to correct"
              className="w-full h-9 px-3 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
              required
            />
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">Leave year start</label>
            <input
              type="number"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="w-full h-9 px-3 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
              required
            />
            {period === "year" && (
              <p className="text-xs text-muted-foreground mt-1">Leave year runs from 1 April to 31 March.</p>
            )}
          </div>
        </div>
        {period === "month" && (
          <div>
            <label className="text-sm font-medium block mb-1">Month</label>
            <select
              value={month}
              onChange={(e) => setMonth(Number(e.target.value))}
              className="w-full h-9 px-3 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {new Date(2000, m - 1, 1).toLocaleDateString("en-GB", { month: "long" })}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className="text-sm font-medium block mb-1">Reason</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            required
            className="w-full px-3 py-2 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {historyForType.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1 mb-2">
              <History className="h-3.5 w-3.5" /> Previous adjustments for {type}
            </p>
            <div className="space-y-1.5 max-h-32 overflow-y-auto">
              {historyForType.map((a) => (
                <div key={a.id} className="text-xs border rounded-md px-2.5 py-1.5 bg-muted/30">
                  <div className="flex items-center justify-between">
                    <span
                      className={`font-semibold ${Number(a.days) < 0 ? "text-rose-600" : "text-emerald-600"}`}
                    >
                      {Number(a.days) > 0 ? "+" : ""}
                      {a.days} day(s)
                    </span>
                    <span className="text-muted-foreground">
                      {a.period_month
                        ? `${new Date(2000, a.period_month - 1, 1).toLocaleDateString("en-GB", { month: "short" })} ${a.period_year}`
                        : `${a.period_year}/${String(a.period_year + 1).slice(-2)}`}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-0.5">{a.reason}</p>
                  <p className="text-muted-foreground/70 mt-0.5">
                    {a.created_by_name ?? "Unknown"} · {fmtDate(a.created_at)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-4 rounded-md border bg-card text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save Adjustment"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
