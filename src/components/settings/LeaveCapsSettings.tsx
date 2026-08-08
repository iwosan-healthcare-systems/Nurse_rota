import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

const ENTITLEMENT_TYPES = [
  "Annual",
  "Sick",
  "Study Leave",
  "Compassionate Leave",
  "Maternity",
] as const;

type RoleGroupOption = { key: string; label: string };
type EntitlementOverride = {
  id: string;
  scope: "individual" | "role";
  nurse_id: string | null;
  nurse_name: string | null;
  role: string | null;
  type: string;
  days: string | number;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
};

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// Change how many days someone is entitled to (not usage) — per individual
// or per job-role group. Separate concept from the pencil-icon adjustment on
// the Leave Entitlements page: that credits days already taken; this
// changes how many days someone is entitled to in the first place. Lives
// under System Settings (admin-only) rather than the Leave Entitlements
// page itself, so it fetches its own staff list instead of receiving one
// from a parent that no longer renders it.
export function LeaveCapsSettings() {
  const qc = useQueryClient();
  const [scope, setScope] = useState<"individual" | "role">("individual");
  const [nurseId, setNurseId] = useState("");
  const [role, setRole] = useState("");
  const [type, setType] = useState<string>(ENTITLEMENT_TYPES[0]);
  const [days, setDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [nurseSearch, setNurseSearch] = useState("");

  const { data: nurses = [] } = useQuery<{ nurse_id: string; name: string }[]>({
    queryKey: ["leave-caps-nurse-list"],
    queryFn: async () => {
      const rows = await api.get<{ id: string; name: string }[]>("/nurses");
      return rows.map((n) => ({ nurse_id: n.id, name: n.name }));
    },
  });
  const { data: roleGroups = [] } = useQuery<RoleGroupOption[]>({
    queryKey: ["leave-entitlement-role-groups"],
    queryFn: () => api.get<RoleGroupOption[]>("/leave-entitlements/role-groups"),
  });
  const { data: overrides = [], isLoading } = useQuery<EntitlementOverride[]>({
    queryKey: ["leave-entitlement-overrides"],
    queryFn: () => api.get<EntitlementOverride[]>("/leave-entitlements/overrides"),
  });

  const matchingNurses = nurseSearch.trim()
    ? nurses
        .filter((n) => n.name.toLowerCase().includes(nurseSearch.trim().toLowerCase()))
        .slice(0, 8)
    : [];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const daysNum = Number(days);
    if (!days || Number.isNaN(daysNum) || daysNum < 0) {
      toast.error("Enter a valid number of days (0 or more).");
      return;
    }
    if (scope === "individual" && !nurseId) {
      toast.error("Select a staff member.");
      return;
    }
    if (scope === "role" && !role) {
      toast.error("Select a job role.");
      return;
    }
    setBusy(true);
    try {
      await api.post("/leave-entitlements/overrides", {
        scope,
        nurse_id: scope === "individual" ? nurseId : undefined,
        role: scope === "role" ? role : undefined,
        type,
        days: daysNum,
      });
      toast.success("Entitlement cap saved");
      setDays("");
      setNurseId("");
      setNurseSearch("");
      setRole("");
      qc.invalidateQueries({ queryKey: ["leave-entitlement-overrides"] });
      qc.invalidateQueries({ queryKey: ["leave-entitlements-all"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save cap");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await api.del(`/leave-entitlements/overrides/${id}`);
      toast.success("Reverted to system default");
      qc.invalidateQueries({ queryKey: ["leave-entitlement-overrides"] });
      qc.invalidateQueries({ queryKey: ["leave-entitlements-all"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove override");
    }
  }

  const selectedNurseName = nurses.find((n) => n.nurse_id === nurseId)?.name;

  return (
    <div className="rounded-xl border bg-card shadow-soft p-5">
      <div className="flex items-center gap-2 mb-1">
        <Settings2 className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Leave Entitlement Caps</h2>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Change how many days someone is entitled to, rather than crediting days already used. An
        individual override always wins over a job-role override, which wins over the system
        default. A role override applies to every Day/non-Day variant of that role together.
      </p>

      <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end mb-5">
        <div>
          <label className="text-xs font-medium block mb-1">Applies to</label>
          <div className="flex rounded-md border overflow-hidden h-9 text-sm">
            <button
              type="button"
              onClick={() => setScope("individual")}
              className={`flex-1 ${scope === "individual" ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted"}`}
            >
              Individual
            </button>
            <button
              type="button"
              onClick={() => setScope("role")}
              className={`flex-1 ${scope === "role" ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted"}`}
            >
              Job Role
            </button>
          </div>
        </div>

        {scope === "individual" ? (
          <div className="relative sm:col-span-1">
            <label className="text-xs font-medium block mb-1">Staff member</label>
            <input
              type="text"
              value={nurseId ? (selectedNurseName ?? "") : nurseSearch}
              onChange={(e) => {
                setNurseId("");
                setNurseSearch(e.target.value);
              }}
              placeholder="Search by name…"
              className="w-full h-9 px-3 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            {matchingNurses.length > 0 && !nurseId && (
              <div className="absolute z-10 mt-1 w-full bg-card border rounded-md shadow-lg max-h-48 overflow-y-auto">
                {matchingNurses.map((n) => (
                  <button
                    type="button"
                    key={n.nurse_id}
                    onClick={() => {
                      setNurseId(n.nurse_id);
                      setNurseSearch("");
                    }}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted"
                  >
                    {n.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div>
            <label className="text-xs font-medium block mb-1">Job role</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="w-full h-9 px-3 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Select…</option>
              {roleGroups.map((g) => (
                <option key={g.key} value={g.key}>
                  {g.label}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label className="text-xs font-medium block mb-1">Leave type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="w-full h-9 px-3 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
          >
            {ENTITLEMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        <div className="flex gap-2">
          <div className="flex-1">
            <label className="text-xs font-medium block mb-1">Days</label>
            <input
              type="number"
              min={0}
              step="1"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              placeholder="e.g. 18"
              className="w-full h-9 px-3 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50 shrink-0"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading current overrides…</p>
      ) : overrides.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No overrides set — every staff member is currently on the system default caps.
        </p>
      ) : (
        <div className="space-y-1.5">
          {overrides.map((o) => (
            <div
              key={o.id}
              className="flex items-center justify-between gap-3 text-xs border rounded-md px-3 py-2 bg-muted/30"
            >
              <div className="min-w-0">
                <span className="font-medium">
                  {o.scope === "individual"
                    ? (o.nurse_name ?? "Unknown staff")
                    : (roleGroups.find((g) => g.key === o.role)?.label ?? o.role)}
                </span>
                <span className="text-muted-foreground"> — {o.type}: </span>
                <span className="font-semibold tabular-nums">{o.days} day(s)</span>
                <span className="text-muted-foreground">
                  {" "}
                  · set by {o.created_by_name ?? "Unknown"} on {fmtDate(o.updated_at)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => remove(o.id)}
                title="Remove override (revert to system default)"
                className="text-muted-foreground hover:text-rose-600 shrink-0"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
