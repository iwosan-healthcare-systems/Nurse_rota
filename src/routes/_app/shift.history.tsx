import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useState } from "react";
import { ArrowLeft, ArrowLeftRight, AlertTriangle, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { EmptyState } from "@/components/EmptyState";
import { Pagination, usePagination } from "@/components/Pagination";
import { DateRangeFilter, type DateRangeFilterValue } from "@/components/DateRangeFilter";

export const Route = createFileRoute("/_app/shift/history")({
  head: () => ({
    meta: [{ title: "Shift History — Nurses Rota" }],
  }),
  component: ShiftHistoryPage,
});

type ShiftLog = {
  id: string;
  shift_date: string;
  shift_type: "M" | "N";
  started_at: string;
  ended_at: string | null;
  hours_logged: number | null;
  is_late: boolean;
  late_minutes: number | null;
  late_reason: string | null;
  is_leave: boolean;
  is_swap: boolean;
  swap_note: string | null;
  is_missed: boolean;
};

function fmtDate(d: string) {
  return new Date(d.slice(0, 10) + "T00:00:00").toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** Convert decimal hours (e.g. 2.58) to "2h 35m" */
function fmtHours(decHours: number) {
  const h = Math.floor(decHours);
  const m = Math.round((decHours - h) * 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function ShiftHistoryPage() {
  const { nurseId } = useAuth();
  const [range, setRange] = useState<DateRangeFilterValue>({ from: "", to: "" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const { data: logs = [], isLoading } = useQuery<ShiftLog[]>({
    queryKey: ["my-shift-history", nurseId, range.from, range.to],
    enabled: !!nurseId,
    queryFn: () => {
      const params = new URLSearchParams({ nurse_id: nurseId! });
      if (range.from) params.set("from", range.from);
      if (range.to) params.set("to", range.to);
      return api.get<ShiftLog[]>(`/shift-logs?${params.toString()}`);
    },
  });

  const totalHours = logs.reduce((s, l) => s + (l.hours_logged ?? 0), 0);
  const leaveHours = logs
    .filter((l) => l.is_leave)
    .reduce((s, l) => s + (l.hours_logged ?? 0), 0);

  const { pageItems, totalPages } = usePagination(logs, pageSize, page);

  function onRangeChange(v: DateRangeFilterValue) {
    setRange(v);
    setPage(1);
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/shift"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-2"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Shift
        </Link>
        <PageHeader title="Shift History" subtitle="All your logged shift hours" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-card border rounded-xl p-5 shadow-soft">
          <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
            Shifts
          </p>
          <p className="text-3xl font-bold mt-2">{logs.length}</p>
        </div>
        <div className="bg-card border rounded-xl p-5 shadow-soft">
          <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
            Hours logged
          </p>
          <p className="text-3xl font-bold mt-2">{fmtHours(totalHours)}</p>
        </div>
        <div className="bg-card border rounded-xl p-5 shadow-soft">
          <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
            Leave credited
          </p>
          <p className="text-3xl font-bold mt-2">{fmtHours(leaveHours)}</p>
        </div>
      </div>

      <DateRangeFilter value={range} onChange={onRangeChange} />

      {isLoading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>
      ) : logs.length === 0 ? (
        <EmptyState
          icon={<Clock className="h-6 w-6" />}
          title="No shift history"
          description="Shifts you've worked will appear here."
        />
      ) : (
        <div className="bg-card border rounded-xl shadow-soft overflow-hidden">
          <div className="divide-y">
            {pageItems.map((log) => (
              <div key={log.id} className="px-5 py-3 flex items-center justify-between text-sm">
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      "h-7 w-7 rounded-full grid place-items-center text-xs font-bold shrink-0",
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
                <div className="text-right shrink-0">
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
          <Pagination
            page={page}
            totalPages={totalPages}
            pageSize={pageSize}
            totalItems={logs.length}
            onPage={setPage}
            onPageSize={(s) => {
              setPageSize(s);
              setPage(1);
            }}
          />
        </div>
      )}
    </div>
  );
}
