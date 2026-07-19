import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ShieldCheck } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { formatDistanceToNow } from "date-fns";
import { useAuth } from "@/lib/auth-context";
import { useState } from "react";
import { Pagination, usePagination } from "@/components/Pagination";

export const Route = createFileRoute("/_app/audit")({
  component: AuditPage,
});

type Log = {
  id: string;
  actor_name: string | null;
  actor_role: string | null;
  action: string;
  target: string | null;
  created_at: string;
};

function AuditPage() {
  const { canViewAudit } = useAuth();
  if (!canViewAudit) {
    return (
      <div className="py-20 text-center text-sm text-muted-foreground">
        You do not have permission to view the audit log.
      </div>
    );
  }
  return <AuditContent />;
}

function AuditContent() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const { data: logs = [], isLoading } = useQuery({
    queryKey: ["audit"],
    queryFn: () => api.get<Log[]>("/audit-logs"),
  });

  const { pageItems, totalPages } = usePagination(logs, pageSize, page);

  return (
    <div>
      <PageHeader title="Audit Log" subtitle="Immutable record of edits, approvals & overrides" />

      {isLoading ? (
        <p className="text-sm text-muted-foreground py-12 text-center">Loading…</p>
      ) : logs.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck className="h-6 w-6" />}
          title="No activity yet"
          description="Actions like adding nurses, approving leave or modifying wards will appear here."
        />
      ) : (
        <div className="bg-card border rounded-xl shadow-soft p-2">
          <div className="divide-y">
            {pageItems.map((e) => (
              <div key={e.id} className="flex items-start gap-4 p-4">
                <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary grid place-items-center shrink-0">
                  <ShieldCheck className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm">
                    <span className="font-semibold">{e.actor_name ?? "Unknown"}</span>
                    {e.actor_role && (
                      <span className="text-muted-foreground"> · {e.actor_role}</span>
                    )}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {e.action}
                    {e.target ? ` — ${e.target}` : ""}
                  </p>
                </div>
                <div className="text-right text-xs text-muted-foreground tabular-nums shrink-0">
                  {formatDistanceToNow(new Date(e.created_at), { addSuffix: true })}
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
