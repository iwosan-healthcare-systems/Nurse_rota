import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useEffect, useRef, useState, useMemo, type FormEvent } from "react";
import {
  UserPlus,
  Search,
  Upload,
  Trash2,
  Users,
  FileSpreadsheet,
  X,
  Loader2,
  Pencil,
  KeyRound,
  CheckCircle2,
  Clock,
  UserX,
  UserCheck,
  RotateCcw,
  Eye,
  EyeOff,
  Copy,
  ShieldAlert,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { EmptyState } from "@/components/EmptyState";
import { toast } from "sonner";
import { logAudit } from "@/lib/audit";
import * as XLSX from "xlsx";

export const Route = createFileRoute("/_app/staff")({
  head: () => ({
    meta: [
      { title: "Staff — Nurses Rota" },
      {
        name: "description",
        content:
          "Manage nursing staff records, roles, ward assignments and bulk import via Excel upload.",
      },
      { property: "og:title", content: "Staff — Nurses Rota" },
      { property: "og:description", content: "Manage nursing staff, roles and ward assignments." },
    ],
  }),
  component: StaffPage,
});

const FACILITIES = ["Ikeja", "Ikoyi", "Ligali"] as const;

const NURSE_ROLES = [
  "Nurse",
  "Matron",
  "Coverage Nurse",
  "Nurse Intern",
  "Nursing Assistant",
  "Nursing Assistant - Day",
  "Porter",
  "Porter - Day",
] as const;

// Coverage Nurses, Nurse Interns, and Porters are scheduled independently — no ward is tagged.
function isNoWardRole(role: string) {
  return /^(head|coverage)\s*nurse$|^intern\s*nurse$|^nurse\s*intern$|^porter(\s*-\s*day)?$/i.test(
    role,
  );
}

// Auto-correct role strings from Excel imports to exact system role names.
function normalizeRole(raw: string): string {
  if (!raw) return "Nurse";
  const s = raw.trim();

  // Exact case-insensitive match wins immediately
  const exact = NURSE_ROLES.find((r) => r.toLowerCase() === s.toLowerCase());
  if (exact) return exact;

  // Porter / Porter - Day
  if (/^porter\s*-\s*day$/i.test(s)) return "Porter - Day";
  if (/^porter$/i.test(s)) return "Porter";

  // Nursing Assistant / Nursing Assistant - Day
  // Accepts: "Nurse Assistant", "Nursing Asst", "Nurs Asst - Day", etc.
  if (/^nurs(e|ing)\s+ass(istant|t?)?\s*-\s*day$/i.test(s)) return "Nursing Assistant - Day";
  if (/^nurs(e|ing)\s+ass(istant|t?)?$/i.test(s)) return "Nursing Assistant";

  // Matron — catches "mtron", "mtrn", "maton", "matorn", etc.
  if (/^ma?t[ro]{0,2}n?$/i.test(s)) return "Matron";

  // Coverage Nurse
  if (/^(coverage|cover)\s*nurse$/i.test(s)) return "Coverage Nurse";

  // Nurse Intern
  if (/^(nurse\s*intern|intern\s*nurse)$/i.test(s)) return "Nurse Intern";

  // Plain Nurse
  if (/^nurse$/i.test(s)) return "Nurse";

  // Unknown — keep original so the user can see what came in
  return s;
}

function parseWards(ward: string | null): string[] {
  if (!ward) return [];
  return ward.split("|").filter(Boolean);
}

function formatWards(wards: string[]): string | null {
  const f = wards.filter(Boolean);
  return f.length ? f.join("|") : null;
}

type Nurse = {
  id: string;
  name: string;
  employee_id: string | null;
  role: string;
  facility: string | null;
  ward: string | null;
  email: string | null;
  hours_this_month: number;
  target_hours: number;
};

function StaffPage() {
  const { canManageStaff, canCreateLogin, canEditTargetHours } = useAuth();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [filterRole, setFilterRole] = useState("");
  const [filterFacility, setFilterFacility] = useState("");
  const [filterWard, setFilterWard] = useState("");
  const [filterStatus, setFilterStatus] = useState<"" | "active" | "inactive">("");
  const [showAdd, setShowAdd] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showSetHours, setShowSetHours] = useState(false);
  const [editingNurse, setEditingNurse] = useState<Nurse | null>(null);
  const [createLoginNurse, setCreateLoginNurse] = useState<Nurse | null>(null);
  const [resetPasswordTarget, setResetPasswordTarget] = useState<{
    name: string;
    userId: string;
  } | null>(null);

  const { data: nurses = [], isLoading } = useQuery({
    queryKey: ["nurses"],
    queryFn: () => api.get<Nurse[]>("/nurses"),
  });

  const { data: profileRows = [] } = useQuery({
    queryKey: ["profile-names"],
    enabled: canCreateLogin,
    queryFn: () =>
      api.get<{ id: string; full_name: string | null; is_active: boolean }[]>("/profiles"),
  });
  const profileMap = useMemo(
    () =>
      new Map(
        profileRows.map((p) => [
          p.full_name?.toLowerCase() ?? "",
          { id: p.id, isActive: p.is_active },
        ]),
      ),
    [profileRows],
  );
  const profileInfo = useMemo(
    () => (name: string) => profileMap.get(name.toLowerCase()),
    [profileMap],
  );

  async function deactivateLogin(userId: string) {
    if (!confirm("Deactivate this login? The user will not be able to log in until reactivated."))
      return;
    try {
      await api.patch(`/auth/admin/users/${userId}/ban`);
      void qc.invalidateQueries({ queryKey: ["profile-names"] });
      void qc.invalidateQueries({ queryKey: ["user-profiles"] });
      toast.success("Login deactivated");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function reactivateLogin(userId: string) {
    try {
      await api.patch(`/auth/admin/users/${userId}/unban`);
      void qc.invalidateQueries({ queryKey: ["profile-names"] });
      void qc.invalidateQueries({ queryKey: ["user-profiles"] });
      toast.success("Login reactivated");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const { data: wards = [] } = useQuery<{ name: string; facility: string | null }[]>({
    queryKey: ["wards"],
    staleTime: 30 * 60 * 1000,
    queryFn: () => api.get<{ name: string; facility: string | null }[]>("/wards"),
  });

  // Hours from shift_logs for the current period (period_start of the most recent
  // published batch). Falls back to last 28 days so the window always covers one period.
  const periodStart = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 27);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, []);

  const { data: shiftLogs = [] } = useQuery<{ nurse_id: string; hours_logged: number | null }[]>({
    queryKey: ["staff-shift-logs-current", periodStart],
    staleTime: 2 * 60 * 1000,
    queryFn: () =>
      api.get<{ nurse_id: string; hours_logged: number | null }[]>(
        `/shift-logs?from=${periodStart}&ended_at_not_null=true`,
      ),
  });

  const hoursMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of shiftLogs) {
      if (l.hours_logged != null) {
        m.set(l.nurse_id, (m.get(l.nurse_id) ?? 0) + l.hours_logged);
      }
    }
    return m;
  }, [shiftLogs]);

  const delMut = useMutation({
    mutationFn: (id: string) => api.del(`/nurses/${id}`),
    onSuccess: async (_, id) => {
      toast.success("Nurse removed");
      qc.invalidateQueries({ queryKey: ["nurses"] });
      logAudit("Removed nurse", id);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const filtered = useMemo(
    () =>
      nurses.filter((n) => {
        if (
          search &&
          !`${n.name} ${n.employee_id ?? ""} ${n.role} ${n.facility ?? ""} ${n.ward ?? ""} ${n.email ?? ""}`
            .toLowerCase()
            .includes(search.toLowerCase())
        )
          return false;
        if (filterRole && n.role !== filterRole) return false;
        if (filterFacility && n.facility !== filterFacility) return false;
        if (filterWard && !parseWards(n.ward).includes(filterWard)) return false;
        if (filterStatus) {
          const info = profileInfo(n.name);
          if (filterStatus === "active" && (!info || !info.isActive)) return false;
          if (filterStatus === "inactive" && (!info || info.isActive)) return false;
        }
        return true;
      }),
    [nurses, search, filterRole, filterFacility, filterWard, filterStatus, profileInfo],
  );

  const activeFilters = [filterRole, filterFacility, filterWard, filterStatus].filter(Boolean).length;
  const clearFilters = () => {
    setFilterRole("");
    setFilterFacility("");
    setFilterWard("");
    setFilterStatus("");
    setSearch("");
  };

  // Ward names shown in the filter bar: scoped to the selected facility when one is active.
  const wardNames = useMemo(
    () =>
      (filterFacility ? wards.filter((w) => w.facility === filterFacility) : wards).map(
        (w) => w.name,
      ),
    [wards, filterFacility],
  );

  return (
    <div>
      <PageHeader
        title="Nursing Staff"
        subtitle={`${nurses.length} nurse${nurses.length === 1 ? "" : "s"} registered`}
        actions={
          <>
            {canEditTargetHours && (
              <button
                type="button"
                onClick={() => setShowSetHours(true)}
                className="inline-flex items-center gap-2 h-10 px-3 rounded-md border bg-card text-sm hover:bg-muted"
              >
                <Clock className="h-4 w-4" />
                <span className="hidden sm:inline">Set Target Hours</span>
              </button>
            )}
            {canManageStaff && (
              <>
                <button
                  type="button"
                  onClick={() => setShowUpload(true)}
                  className="inline-flex items-center gap-2 h-10 px-3 rounded-md border bg-card text-sm hover:bg-muted"
                >
                  <Upload className="h-4 w-4" />{" "}
                  <span className="hidden sm:inline">Upload Excel</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowAdd(true)}
                  className="inline-flex items-center gap-2 h-10 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
                >
                  <UserPlus className="h-4 w-4" /> Add nurse
                </button>
              </>
            )}
          </>
        }
      />

      <div className="bg-card border rounded-xl shadow-soft mb-4 p-3 space-y-2">
        {/* Name search — full width on all sizes */}
        <div className="relative">
          <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            type="search"
            aria-label="Search staff"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-9 pl-9 pr-3 rounded-md bg-muted/60 text-sm outline-none focus:ring-2 focus:ring-ring"
            placeholder="Search by name or employee ID…"
          />
        </div>

        {/* Filter dropdowns — 2-col grid on mobile, single row on sm+ */}
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
          {/* Role filter */}
          <select
            aria-label="Filter by role"
            value={filterRole}
            onChange={(e) => setFilterRole(e.target.value)}
            className="h-9 px-2 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring w-full sm:w-auto"
          >
            <option value="">All roles</option>
            {NURSE_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>

          {/* Facility filter */}
          <select
            aria-label="Filter by facility"
            value={filterFacility}
            onChange={(e) => {
              setFilterFacility(e.target.value);
              setFilterWard("");
            }}
            className="h-9 px-2 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring w-full sm:w-auto"
          >
            <option value="">All facilities</option>
            {FACILITIES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>

          {/* Ward filter */}
          <select
            aria-label="Filter by ward"
            value={filterWard}
            onChange={(e) => setFilterWard(e.target.value)}
            className="h-9 px-2 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring w-full sm:w-auto"
          >
            <option value="">All wards</option>
            {wardNames.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>

          {/* Login status filter */}
          {canCreateLogin && (
            <select
              aria-label="Filter by login status"
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as "" | "active" | "inactive")}
              className="h-9 px-2 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring w-full sm:w-auto"
            >
              <option value="">All logins</option>
              <option value="active">Login active</option>
              <option value="inactive">Login inactive</option>
            </select>
          )}

          {/* Clear + count row */}
          <div className="col-span-2 sm:contents flex items-center justify-between">
            {(activeFilters > 0 || search) && (
              <button
                type="button"
                onClick={clearFilters}
                className="h-9 px-3 rounded-md border text-sm inline-flex items-center gap-1.5 hover:bg-muted text-muted-foreground"
              >
                <X className="h-3.5 w-3.5" /> Clear
                {activeFilters > 0 && (
                  <span className="ml-0.5 h-4 w-4 rounded-full bg-primary text-primary-foreground text-[10px] grid place-items-center font-bold">
                    {activeFilters}
                  </span>
                )}
              </button>
            )}
            <span className="sm:ml-auto text-xs text-muted-foreground whitespace-nowrap">
              {filtered.length} of {nurses.length}
            </span>
          </div>
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground py-12 text-center">Loading…</p>
      ) : nurses.length === 0 ? (
        <EmptyState
          icon={<Users className="h-6 w-6" />}
          title="No nurses yet"
          description={
            canManageStaff
              ? "Add your first nurse manually or upload an Excel file with Name, Employee ID, Role and Ward columns."
              : "Ask an administrator to add staff."
          }
          action={
            canManageStaff && (
              <div className="flex justify-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowUpload(true)}
                  className="inline-flex items-center gap-2 h-9 px-3 rounded-md border bg-card text-sm hover:bg-muted"
                >
                  <FileSpreadsheet className="h-4 w-4" /> Upload Excel
                </button>
                <button
                  type="button"
                  onClick={() => setShowAdd(true)}
                  className="inline-flex items-center gap-2 h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm hover:bg-primary/90"
                >
                  <UserPlus className="h-4 w-4" /> Add manually
                </button>
              </div>
            )
          }
        />
      ) : (
        <div className="bg-card border rounded-xl shadow-soft overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="text-left font-semibold px-4 py-3">Name</th>
                  <th className="text-left font-semibold px-4 py-3 hidden md:table-cell">
                    Emp. ID
                  </th>
                  <th className="text-left font-semibold px-4 py-3">Role</th>
                  <th className="text-left font-semibold px-4 py-3 hidden sm:table-cell">
                    Facility
                  </th>
                  <th className="text-left font-semibold px-4 py-3">Ward</th>
                  <th className="text-left font-semibold px-4 py-3 hidden lg:table-cell">Email</th>
                  <th className="text-right font-semibold px-4 py-3 hidden sm:table-cell">Hours</th>
                  {canCreateLogin && <th className="text-center font-semibold px-4 py-3">Login</th>}
                  {canManageStaff && (
                    <th className="px-4 py-3">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {filtered.map((n) => (
                  <tr key={n.id} className="border-t hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium">
                      <div className="flex items-center gap-3">
                        <div className="h-8 w-8 rounded-full bg-primary/15 text-primary grid place-items-center text-xs font-semibold shrink-0">
                          {n.name
                            .split(" ")
                            .map((s) => s[0])
                            .slice(0, 2)
                            .join("")}
                        </div>
                        <span className="truncate">{n.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">
                      {n.employee_id ? (
                        <span className="font-mono text-xs">{n.employee_id}</span>
                      ) : (
                        <span className="text-xs italic opacity-40">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{n.role}</td>
                    <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">
                      {n.facility ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {isNoWardRole(n.role) ? (
                        <span className="text-xs italic opacity-50">—</span>
                      ) : (
                        parseWards(n.ward).join(", ") || "—"
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">
                      <span className="truncate block max-w-45" title={n.email ?? ""}>
                        {n.email ?? <span className="text-xs italic opacity-50">—</span>}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums hidden sm:table-cell">
                      {(() => {
                        const hrs = hoursMap.get(n.id) ?? 0;
                        const display =
                          hrs < 1 && hrs > 0 ? `${Math.round(hrs * 60)}m` : `${Math.round(hrs)}h`;
                        return (
                          <span title={`${hrs.toFixed(2)}h worked / ${n.target_hours}h target`}>
                            {display}
                            <span className="text-muted-foreground">/{n.target_hours}h</span>
                          </span>
                        );
                      })()}
                    </td>
                    {canCreateLogin && (
                      <td className="px-4 py-3 text-center">
                        {(() => {
                          const info = profileInfo(n.name);
                          if (!info) {
                            return (
                              <button
                                type="button"
                                onClick={() => setCreateLoginNurse(n)}
                                className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md border text-[11px] hover:bg-primary hover:text-primary-foreground hover:border-primary transition"
                                title="Create login for this nurse"
                              >
                                <KeyRound className="h-3 w-3" /> Create
                              </button>
                            );
                          }
                          if (info.isActive) {
                            return (
                              <div className="inline-flex items-center gap-1">
                                <span
                                  className="inline-flex items-center gap-1 text-[11px] text-success font-medium"
                                  title="Login active"
                                >
                                  <CheckCircle2 className="h-3.5 w-3.5" /> Active
                                </span>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setResetPasswordTarget({ name: n.name, userId: info.id })
                                  }
                                  className="h-6 px-1.5 rounded border text-[10px] text-muted-foreground hover:bg-amber-50 hover:text-amber-700 hover:border-amber-300 transition"
                                  title="Reset password"
                                >
                                  <RotateCcw className="h-3 w-3" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void deactivateLogin(info.id)}
                                  className="h-6 px-1.5 rounded border text-[10px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive hover:border-destructive/40 transition"
                                  title="Deactivate login"
                                >
                                  <UserX className="h-3 w-3" />
                                </button>
                              </div>
                            );
                          }
                          return (
                            <div className="inline-flex items-center gap-1.5">
                              <span
                                className="inline-flex items-center gap-1 text-[11px] text-destructive font-medium"
                                title="Login deactivated"
                              >
                                <UserX className="h-3.5 w-3.5" /> Inactive
                              </span>
                              <button
                                type="button"
                                onClick={() => void reactivateLogin(info.id)}
                                className="h-6 px-1.5 rounded border text-[10px] text-muted-foreground hover:bg-success/10 hover:text-success hover:border-success/40 transition"
                                title="Reactivate login"
                              >
                                <UserCheck className="h-3 w-3" />
                              </button>
                            </div>
                          );
                        })()}
                      </td>
                    )}
                    {canManageStaff && (
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            aria-label={`Edit ${n.name}`}
                            onClick={() => setEditingNurse(n)}
                            className="h-8 w-8 grid place-items-center rounded-md hover:bg-accent text-muted-foreground hover:text-foreground"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            aria-label={`Remove ${n.name}`}
                            onClick={() => {
                              if (confirm(`Remove ${n.name}?`)) delMut.mutate(n.id);
                            }}
                            className="h-8 w-8 grid place-items-center rounded-md hover:bg-destructive/10 text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showAdd && (
        <AddNurseModal
          currentTargetHours={nurses[0]?.target_hours ?? 180}
          onClose={() => setShowAdd(false)}
          wards={wards}
        />
      )}
      {editingNurse && (
        <EditNurseModal nurse={editingNurse} wards={wards} onClose={() => setEditingNurse(null)} />
      )}
      {showSetHours && (
        <SetTargetHoursModal
          currentHours={nurses[0]?.target_hours ?? 180}
          onClose={() => setShowSetHours(false)}
        />
      )}
      {showUpload && (
        <UploadModal
          currentTargetHours={nurses[0]?.target_hours ?? 180}
          onClose={() => setShowUpload(false)}
        />
      )}
      {createLoginNurse && (
        <CreateLoginModal
          nurse={createLoginNurse}
          onClose={() => {
            setCreateLoginNurse(null);
            qc.invalidateQueries({ queryKey: ["profile-names"] });
          }}
        />
      )}
      {resetPasswordTarget && (
        <ResetPasswordModal
          name={resetPasswordTarget.name}
          userId={resetPasswordTarget.userId}
          onClose={() => setResetPasswordTarget(null)}
        />
      )}
    </div>
  );
}

function WardMultiField({
  selectedWards,
  allWards,
  onChange,
}: {
  selectedWards: string[];
  allWards: string[];
  onChange: (v: string[]) => void;
}) {
  const available = allWards.filter((w) => !selectedWards.includes(w));

  return (
    <div>
      <p className="text-sm font-medium">
        Wards <span className="text-xs font-normal text-muted-foreground">(max 3)</span>
      </p>
      {selectedWards.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-1.5">
          {selectedWards.map((w, i) => (
            <span
              key={w}
              className="inline-flex items-center gap-1 bg-primary/10 text-primary text-xs px-2.5 py-1 rounded-full"
            >
              {i === 0 && (
                <span className="text-[9px] uppercase tracking-wide opacity-60 mr-0.5">
                  primary
                </span>
              )}
              {w}
              <button
                type="button"
                onClick={() => onChange(selectedWards.filter((x) => x !== w))}
                className="hover:text-destructive"
                aria-label={`Remove ${w}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      {selectedWards.length < 3 &&
        (allWards.length > 0 ? (
          <select
            title="Add ward"
            value=""
            onChange={(e) => {
              if (e.target.value) onChange([...selectedWards, e.target.value]);
            }}
            className={inputCls + " mt-1.5"}
          >
            <option value="" disabled>
              {selectedWards.length === 0 ? "Select primary ward…" : "Add another ward…"}
            </option>
            {available.map((w) => (
              <option key={w}>{w}</option>
            ))}
            {available.length === 0 && (
              <option value="" disabled>
                All wards assigned
              </option>
            )}
          </select>
        ) : (
          <p className="text-xs text-muted-foreground mt-1.5">
            No wards configured. Add wards first.
          </p>
        ))}
    </div>
  );
}

function AddNurseModal({
  currentTargetHours,
  onClose,
  wards,
}: {
  currentTargetHours: number;
  onClose: () => void;
  wards: { name: string; facility: string | null }[];
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("Nurse");
  const [facility, setFacility] = useState("");
  const [nurseWards, setNurseWards] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const noWard = isNoWardRole(role);
  // Only show wards belonging to the selected facility (or untagged wards).
  const availableWards = (
    facility ? wards.filter((w) => w.facility === facility || !w.facility) : wards
  ).map((w) => w.name);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post("/nurses", {
        name,
        employee_id: employeeId || null,
        email: email || null,
        role,
        facility: facility || null,
        ward: noWard ? null : formatWards(nurseWards),
      });
      // Ensure the new nurse inherits the current global target hours
      await api.patch("/nurses/bulk-target-hours", { target_hours: currentTargetHours });
    } catch (e) {
      setBusy(false);
      return toast.error(e instanceof Error ? e.message : "Failed to add nurse");
    }
    setBusy(false);
    toast.success("Nurse added");
    logAudit("Added nurse", name);
    qc.invalidateQueries({ queryKey: ["nurses"] });
    onClose();
  }

  return (
    <Modal title="Add nurse" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field id="nurse-name" label="Full name">
          <input
            id="nurse-name"
            type="text"
            required
            placeholder="Enter full name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field id="nurse-emp-id" label="Employee ID" hint="Optional — e.g. EMP001">
          <input
            id="nurse-emp-id"
            type="text"
            placeholder="e.g. EMP001"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field id="nurse-email" label="Email address" hint="Used for login credentials">
          <input
            id="nurse-email"
            type="email"
            placeholder="nurse@hospital.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field id="nurse-role" label="Role">
          <select
            id="nurse-role"
            title="Role"
            value={role}
            onChange={(e) => {
              setRole(e.target.value);
              setNurseWards([]);
            }}
            className={inputCls}
          >
            {NURSE_ROLES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </Field>
        <Field id="nurse-facility" label="Facility">
          <select
            id="nurse-facility"
            title="Facility"
            value={facility}
            onChange={(e) => {
              setFacility(e.target.value);
              setNurseWards([]); // clear wards when facility changes
            }}
            className={inputCls}
          >
            <option value="">— Unassigned —</option>
            {FACILITIES.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </Field>
        {noWard ? (
          <p className="text-xs text-muted-foreground rounded-lg border border-dashed px-3 py-2">
            Ward assignment is not applicable for {role}s — their schedule is managed independently.
          </p>
        ) : (
          <WardMultiField
            selectedWards={nurseWards}
            allWards={availableWards}
            onChange={setNurseWards}
          />
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-4 rounded-md border bg-card text-sm"
          >
            Cancel
          </button>
          <button
            disabled={busy}
            type="submit"
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm inline-flex items-center gap-2"
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />} Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EditNurseModal({
  nurse,
  onClose,
  wards,
}: {
  nurse: Nurse;
  onClose: () => void;
  wards: { name: string; facility: string | null }[];
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(nurse.name);
  const [employeeId, setEmployeeId] = useState(nurse.employee_id ?? "");
  const [email, setEmail] = useState(nurse.email ?? "");
  const [role, setRole] = useState(nurse.role);
  const [facility, setFacility] = useState(nurse.facility ?? "");
  const [nurseWards, setNurseWards] = useState<string[]>(parseWards(nurse.ward));
  const [busy, setBusy] = useState(false);

  const noWard = isNoWardRole(role);
  // Only show wards belonging to the selected facility (or untagged wards).
  const availableWards = (
    facility ? wards.filter((w) => w.facility === facility || !w.facility) : wards
  ).map((w) => w.name);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.patch(`/nurses/${nurse.id}`, {
        name,
        employee_id: employeeId || null,
        email: email || null,
        role,
        facility: facility || null,
        ward: noWard ? null : formatWards(nurseWards),
      });
    } catch (e) {
      setBusy(false);
      return toast.error(e instanceof Error ? e.message : "Failed to update");
    }
    setBusy(false);
    toast.success("Profile updated");
    logAudit("Updated nurse profile", name);
    qc.invalidateQueries({ queryKey: ["nurses"] });
    onClose();
  }

  return (
    <Modal title="Edit nurse" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field id="edit-name" label="Full name">
          <input
            id="edit-name"
            type="text"
            required
            placeholder="Enter full name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field id="edit-emp-id" label="Employee ID" hint="Optional — e.g. EMP001">
          <input
            id="edit-emp-id"
            type="text"
            placeholder="e.g. EMP001"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field id="edit-email" label="Email address" hint="Used for login credentials">
          <input
            id="edit-email"
            type="email"
            placeholder="nurse@hospital.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field id="edit-role" label="Role">
          <select
            id="edit-role"
            title="Role"
            value={role}
            onChange={(e) => {
              const newRole = e.target.value;
              setRole(newRole);
              // Only clear wards when switching to a no-ward role
              if (isNoWardRole(newRole)) setNurseWards([]);
            }}
            className={inputCls}
          >
            {NURSE_ROLES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </Field>
        <Field id="edit-facility" label="Facility">
          <select
            id="edit-facility"
            title="Facility"
            value={facility}
            onChange={(e) => {
              const newFacility = e.target.value;
              setFacility(newFacility);
              // Keep only wards that exist in the new facility (don't blank everything)
              if (newFacility) {
                const validNames = new Set(
                  wards.filter((w) => w.facility === newFacility || !w.facility).map((w) => w.name),
                );
                setNurseWards((prev) => prev.filter((w) => validNames.has(w)));
              }
            }}
            className={inputCls}
          >
            <option value="">— Unassigned —</option>
            {FACILITIES.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </Field>
        {noWard ? (
          <p className="text-xs text-muted-foreground rounded-lg border border-dashed px-3 py-2">
            Ward assignment is not applicable for {role}s — their schedule is managed independently.
          </p>
        ) : (
          <WardMultiField
            selectedWards={nurseWards}
            allWards={availableWards}
            onChange={setNurseWards}
          />
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-4 rounded-md border bg-card text-sm"
          >
            Cancel
          </button>
          <button
            disabled={busy}
            type="submit"
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm inline-flex items-center gap-2"
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />} Save changes
          </button>
        </div>
      </form>
    </Modal>
  );
}

function UploadModal({
  currentTargetHours,
  onClose,
}: {
  currentTargetHours: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [facility, setFacility] = useState("");
  const [rows, setRows] = useState<
    { name: string; employee_id: string; role: string; ward: string; email: string }[]
  >([]);
  const [parsing, setParsing] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleFile(file: File) {
    setParsing(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
      const norm = raw
        .map((r) => {
          const keys = Object.fromEntries(Object.keys(r).map((k) => [k.trim().toLowerCase(), k]));
          const get = (...names: string[]) => {
            for (const n of names) if (keys[n]) return String(r[keys[n]] ?? "").trim();
            return "";
          };
          return {
            name: get("name", "full name", "nurse"),
            employee_id: get("employee id", "emp id", "employee number", "emp no", "staff id"),
            role: normalizeRole(get("role", "position")),
            ward: get("ward", "department", "unit"),
            email: get("email", "email address"),
          };
        })
        .filter((r) => r.name);
      setRows(norm);
      if (norm.length === 0) toast.error("No valid rows found. Need columns: Name, Role, Ward.");
    } catch (e: unknown) {
      toast.error("Could not parse file: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setParsing(false);
    }
  }

  async function importAll() {
    if (!facility) return toast.error("Select a facility before importing");
    setBusy(true);
    try {
      await api.post(
        "/nurses/bulk",
        rows.map((r) => ({
          name: r.name,
          employee_id: r.employee_id || null,
          email: r.email || null,
          role: r.role,
          facility,
          ward: r.ward || null,
        })),
      );
      // Re-apply the existing target hours so newly imported nurses aren't left on the DB default
      await api.patch("/nurses/bulk-target-hours", { target_hours: currentTargetHours });
    } catch (e) {
      setBusy(false);
      return toast.error(e instanceof Error ? e.message : "Import failed");
    }
    setBusy(false);
    toast.success(`Imported ${rows.length} nurses into ${facility}`);
    logAudit("Imported nurses from Excel", `${rows.length} rows — ${facility}`);
    qc.invalidateQueries({ queryKey: ["nurses"] });
    onClose();
  }

  return (
    <Modal title="Upload Excel" onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label htmlFor="upload-facility" className="text-sm font-medium">
            Facility <span className="text-destructive">*</span>
          </label>
          <select
            id="upload-facility"
            value={facility}
            onChange={(e) => setFacility(e.target.value)}
            className={inputCls + " mt-1"}
          >
            <option value="">— Select facility —</option>
            {FACILITIES.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </div>
        <p className="text-sm text-muted-foreground">
          Upload an <code className="text-foreground">.xlsx</code> or{" "}
          <code className="text-foreground">.csv</code> with headers: <strong>Name</strong>,{" "}
          <strong>Employee ID</strong> <span className="text-xs">(optional)</span>,{" "}
          <strong>Role</strong>, <strong>Ward</strong>, <strong>Email</strong>{" "}
          <span className="text-xs">(optional)</span>.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          hidden
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="w-full h-32 rounded-lg border-2 border-dashed border-border hover:border-primary hover:bg-primary/5 transition-colors grid place-items-center text-sm text-muted-foreground"
        >
          {parsing ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Parsing…
            </span>
          ) : (
            <span className="inline-flex items-center gap-2">
              <FileSpreadsheet className="h-4 w-4" /> Click to choose file
            </span>
          )}
        </button>

        {rows.length > 0 && (
          <div className="border rounded-lg overflow-hidden">
            <div className="px-3 py-2 bg-muted/50 text-xs font-semibold flex justify-between">
              <span>Preview ({rows.length} rows)</span>
            </div>
            <div className="max-h-56 overflow-y-auto text-sm">
              <table className="w-full">
                <thead className="bg-muted/30 text-[10px] uppercase text-muted-foreground">
                  <tr>
                    <th className="text-left px-3 py-1.5">Name</th>
                    <th className="text-left px-3 py-1.5">Emp. ID</th>
                    <th className="text-left px-3 py-1.5">Role</th>
                    <th className="text-left px-3 py-1.5">Ward</th>
                    <th className="text-left px-3 py-1.5">Email</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 50).map((r, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-3 py-1.5">{r.name}</td>
                      <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">
                        {r.employee_id || "—"}
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">{r.role}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{r.ward || "—"}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{r.email || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-4 rounded-md border bg-card text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={importAll}
            disabled={!rows.length || busy}
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm disabled:opacity-50 inline-flex items-center gap-2"
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />} Import {rows.length || ""}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function SetTargetHoursModal({
  currentHours,
  onClose,
}: {
  currentHours: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [hours, setHours] = useState(currentHours);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (
      !confirm(
        `Set target hours to ${hours}h for ALL nurses in the system?\n\nThis will overwrite each nurse's current target.`,
      )
    )
      return;
    setBusy(true);
    try {
      await api.patch("/nurses/bulk-target-hours", { target_hours: hours });
    } catch (e) {
      setBusy(false);
      return toast.error(e instanceof Error ? e.message : "Failed to update");
    }
    setBusy(false);
    toast.success(`Target hours updated to ${hours}h for all staff`);
    logAudit("Updated global target hours", `${hours}h`);
    qc.invalidateQueries({ queryKey: ["nurses"] });
    onClose();
  }

  return (
    <Modal title="Set Target Hours" onClose={onClose}>
      <p className="text-sm text-muted-foreground mb-4">
        Sets the monthly target hours for <strong>all nurses</strong> in the system. This will
        overwrite each nurse's current target.
      </p>
      <form onSubmit={submit} className="space-y-4">
        <Field id="global-target-hours" label="Target Hours (monthly)">
          <input
            id="global-target-hours"
            type="number"
            min={1}
            max={999}
            title="Monthly target hours for all staff"
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            className={inputCls}
          />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-4 rounded-md border bg-card text-sm"
          >
            Cancel
          </button>
          <button
            disabled={busy || hours < 1}
            type="submit"
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm inline-flex items-center gap-2 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />} Apply to all staff
          </button>
        </div>
      </form>
    </Modal>
  );
}

const inputCls =
  "w-full h-10 px-3 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring";

function Field({
  label,
  hint,
  children,
  id,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  id: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4 bg-black/50" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-card border rounded-xl shadow-card w-full max-w-lg max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="font-semibold">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="h-8 w-8 grid place-items-center rounded-md hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

// ── Create Login modal ────────────────────────────────────────────────────────

const LOGIN_ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: "nurse", label: "Nurse" },
  { value: "head_nurse", label: "Head Nurse" },
  { value: "hr_admin", label: "HR / Admin" },
  { value: "chief_matron", label: "Chief Matron" },
  { value: "cno", label: "Chief Nursing Officer (CNO)" },
  { value: "admin", label: "System Administrator" },
];

function generatePassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function CreateLoginModal({ nurse, onClose }: { nurse: Nurse; onClose: () => void }) {
  const [email, setEmail] = useState(nurse.email ?? "");
  const [password, setPassword] = useState(() => generatePassword());
  const [role, setRole] = useState("nurse");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Fetch the nurse's current email fresh from the DB on open — the parent
  // list may be serving a cached (stale) row where email is still null.
  useEffect(() => {
    if (nurse.email) return;
    api
      .get<{ email: string | null }>(`/nurses/${nurse.id}`)
      .then((n) => {
        if (n?.email) setEmail(n.email);
      })
      .catch(() => {});
  }, [nurse.id, nurse.email]);

  function copyPassword() {
    void navigator.clipboard.writeText(password).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!email) {
      toast.error("Email address is required");
      return;
    }
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    setBusy(true);
    try {
      const { id: userId } = await api.post<{ id: string }>("/auth/admin/create-user", {
        email,
        password,
        full_name: nurse.name,
      });

      await Promise.all([
        api.post("/user-roles", { user_id: userId, role }),
        api.patch(`/nurses/${nurse.id}`, { email }),
      ]);

      logAudit("Created login", `${nurse.name} (${email}) — role: ${role}`);
      toast.success(`Login created for ${nurse.name} — can log in immediately`);
      onClose();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to create login");
    } finally {
      setBusy(false);
    }
  }

  const cls =
    "w-full h-10 px-3 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring";

  return (
    <Modal title={`Create login — ${nurse.name}`} onClose={onClose}>
      <p className="text-sm text-muted-foreground mb-4">
        Creates a system account. The user will log in with the credentials below. Their dashboard
        will be scoped to the <strong>{nurse.facility ?? "assigned"}</strong> facility.
      </p>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="login-email" className="text-sm font-medium">
            Email address <span className="text-destructive">*</span>
          </label>
          <input
            id="login-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="nurse@hospital.com"
            className={cls}
          />
          {!nurse.email && (
            <p className="mt-1 text-xs text-amber-600">
              No email saved on this nurse's profile. Enter one above and it will be saved
              automatically.
            </p>
          )}
        </div>
        <div>
          <label htmlFor="login-password" className="text-sm font-medium">
            Password
          </label>
          <div className="flex gap-2 mt-1">
            <input
              id="login-password"
              type="text"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="flex-1 h-10 px-3 rounded-md border bg-card text-sm font-mono outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              type="button"
              onClick={copyPassword}
              className="h-10 px-3 rounded-md border bg-card text-sm hover:bg-muted whitespace-nowrap"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
            <button
              type="button"
              onClick={() => setPassword(generatePassword())}
              className="h-10 px-3 rounded-md border bg-card text-sm hover:bg-muted whitespace-nowrap"
              title="Generate new password"
            >
              ↻
            </button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Auto-generated. Share these credentials securely with the nurse before clicking Create.
          </p>
        </div>
        <div>
          <label htmlFor="login-role" className="text-sm font-medium">
            System role <span className="text-destructive">*</span>
          </label>
          <select
            id="login-role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className={cls}
          >
            {LOGIN_ROLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted-foreground">
            Determines what this user can see and do in the system.
          </p>
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
            type="submit"
            disabled={busy || !email}
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium inline-flex items-center gap-2 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <KeyRound className="h-3 w-3" />}
            Create login
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Reset Password modal ───────────────────────────────────────────────────────

function ResetPasswordModal({
  name,
  userId,
  onClose,
}: {
  name: string;
  userId: string;
  onClose: () => void;
}) {
  const [password, setPassword] = useState(() => generatePassword());
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copyToClipboard() {
    await navigator.clipboard.writeText(password);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) return toast.error("Password must be at least 8 characters");
    setBusy(true);
    try {
      await api.patch(`/auth/admin/users/${userId}/reset-password`, { password });
      await logAudit("Reset password", name);
      setDone(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reset password");
    } finally {
      setBusy(false);
    }
  }

  const cls =
    "w-full h-10 px-3 rounded-md border bg-background text-sm outline-none focus:ring-2 focus:ring-ring";

  return (
    <Modal title="Reset Password" onClose={onClose}>
      {done ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
            <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-emerald-800">Password reset successfully</p>
              <p className="text-xs text-emerald-700 mt-0.5">
                {name} will be prompted to change their password on next login.
              </p>
            </div>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1.5">
              Temporary password — share securely:
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 h-10 px-3 rounded-md border bg-muted text-sm font-mono flex items-center">
                {password}
              </code>
              <button
                type="button"
                onClick={copyToClipboard}
                className="h-10 px-3 rounded-md border bg-card text-sm hover:bg-muted inline-flex items-center gap-1.5"
              >
                <Copy className="h-3.5 w-3.5" />
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-full h-10 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
          >
            Done
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <ShieldAlert className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-800">
              Resetting <strong>{name}</strong>&apos;s password will require them to set a new
              password on their next login.
            </p>
          </div>

          <div>
            <label className="text-sm font-medium block mb-1.5">New temporary password</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={8}
                  required
                  className={cls + " pr-9"}
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <button
                type="button"
                onClick={() => setPassword(generatePassword())}
                className="h-10 px-3 rounded-md border bg-card text-sm hover:bg-muted inline-flex items-center gap-1.5 shrink-0"
                title="Generate new password"
              >
                <RotateCcw className="h-3.5 w-3.5" /> Generate
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">Minimum 8 characters.</p>
          </div>

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 h-10 rounded-md border bg-background text-sm font-medium hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || password.length < 8}
              className="flex-1 h-10 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 inline-flex items-center justify-center gap-2"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <KeyRound className="h-4 w-4" />
              )}
              Reset password
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
