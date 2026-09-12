import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMemo, useState, useId } from "react";
import { Building2, Plus, Trash2, Loader2, Pencil } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { EmptyState } from "@/components/EmptyState";
import { Modal } from "./staff";
import { toast } from "sonner";
import { logAudit } from "@/lib/audit";
import { FACILITY_LOCATIONS } from "@/lib/geo-fence";

export const Route = createFileRoute("/_app/wards")({
  head: () => ({
    meta: [
      { title: "Wards — Nurses Rota" },
      {
        name: "description",
        content: "Manage hospital wards and minimum staffing requirements per shift.",
      },
    ],
  }),
  component: WardsPage,
});

const WARD_QUERY_KEYS = [
  ["wards"],
  ["gen-wards"],
  ["wards-by-facility"],
  ["wards-simple"],
] as const;

type Ward = {
  id: string;
  name: string;
  facility: string | null;
  min_morning_nurses: number;
  min_morning_na: number;
  min_night_nurses: number;
  min_night_na: number;
};

type StaffFacilityRow = {
  facility: string | null;
};

type FacilitySettings = {
  facilities?: Record<string, unknown>;
};

function refreshWardQueries(qc: ReturnType<typeof useQueryClient>) {
  return Promise.all(WARD_QUERY_KEYS.map((queryKey) => qc.invalidateQueries({ queryKey })));
}

function WardsPage() {
  const { canManageWards, nurseFacility, isAdmin, activeRole } = useAuth();
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editingWard, setEditingWard] = useState<Ward | null>(null);

  const isMultiFacility = isAdmin || activeRole === "cno" || activeRole === "hr_admin";
  const defaultFacility = nurseFacility && !isMultiFacility ? nurseFacility : "";
  const [selectedFacility, setSelectedFacility] = useState(defaultFacility);

  const { data: wards = [], isLoading } = useQuery({
    queryKey: ["wards"],
    queryFn: () => api.get<Ward[]>("/wards"),
  });

  const { data: staffFacilities = [] } = useQuery({
    queryKey: ["ward-facility-staff"],
    queryFn: () => api.get<StaffFacilityRow[]>("/nurses"),
  });

  const { data: settingsFacilities = Object.keys(FACILITY_LOCATIONS) } = useQuery({
    queryKey: ["ward-facility-settings"],
    queryFn: async () => {
      const fallback = Object.keys(FACILITY_LOCATIONS);
      try {
        const { value } = await api.get<{ value?: FacilitySettings }>(
          "/portal-settings/gps_settings",
        );
        const names = Object.keys(value?.facilities ?? {});
        return names.length ? names : fallback;
      } catch {
        return fallback;
      }
    },
    refetchOnMount: "always",
    staleTime: 0,
  });

  const facilityOptions = useMemo(() => {
    const names = new Set<string>();
    for (const facility of settingsFacilities) {
      if (facility.trim()) names.add(facility.trim());
    }
    for (const ward of wards) if (ward.facility?.trim()) names.add(ward.facility.trim());
    for (const staff of staffFacilities) {
      if (staff.facility?.trim()) names.add(staff.facility.trim());
    }
    if (selectedFacility.trim()) names.add(selectedFacility.trim());
    if (defaultFacility.trim()) names.add(defaultFacility.trim());
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [defaultFacility, selectedFacility, settingsFacilities, staffFacilities, wards]);

  const filterOptions = isMultiFacility
    ? facilityOptions
    : selectedFacility
      ? [selectedFacility]
      : [];

  const visibleWards = selectedFacility
    ? wards.filter((w) => w.facility === selectedFacility)
    : wards;

  async function del(w: Ward) {
    if (!confirm(`Remove ward "${w.name}"?`)) return;
    try {
      await api.del(`/wards/${w.id}`);
      toast.success("Ward removed");
      logAudit("Removed ward", w.name);
      await refreshWardQueries(qc);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to remove ward");
    }
  }

  return (
    <div>
      <PageHeader
        title="Wards & Safety Rules"
        subtitle="Minimum staffing rules enforced by the rota engine"
        actions={
          canManageWards &&
          selectedFacility && (
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="inline-flex items-center gap-2 h-10 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" /> Add ward
            </button>
          )
        }
      />

      {filterOptions.length > 0 && (
        <div className="flex items-center gap-2 mb-5 flex-wrap">
          <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
          {isMultiFacility && (
            <button
              type="button"
              onClick={() => setSelectedFacility("")}
              className={`px-4 py-1.5 rounded-full text-sm font-medium border transition ${
                selectedFacility === ""
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card hover:bg-muted"
              }`}
            >
              All Facilities
            </button>
          )}
          {filterOptions.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setSelectedFacility(f)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium border transition ${
                selectedFacility === f
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card hover:bg-muted"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground py-12 text-center">Loading…</p>
      ) : visibleWards.length === 0 ? (
        <EmptyState
          icon={<Building2 className="h-6 w-6" />}
          title="No wards configured"
          description={
            canManageWards
              ? selectedFacility
                ? "Add wards to define minimum staffing rules for this facility or branch."
                : "Select a facility before adding wards."
              : "Ask an administrator to configure wards."
          }
          action={
            canManageWards &&
            selectedFacility && (
              <button
                type="button"
                onClick={() => setShowAdd(true)}
                className="inline-flex items-center gap-2 h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm"
              >
                <Plus className="h-4 w-4" /> Add ward
              </button>
            )
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {visibleWards.map((w) => (
            <WardCard
              key={w.id}
              ward={w}
              showFacility={!selectedFacility}
              canManage={canManageWards}
              onEdit={() => setEditingWard(w)}
              onDelete={() => del(w)}
            />
          ))}
        </div>
      )}

      {showAdd && <AddWardModal facility={selectedFacility} onClose={() => setShowAdd(false)} />}
      {editingWard && (
        <EditWardModal
          ward={editingWard}
          facilityOptions={facilityOptions}
          onClose={() => setEditingWard(null)}
        />
      )}
    </div>
  );
}

function WardCard({
  ward: w,
  showFacility,
  canManage,
  onEdit,
  onDelete,
}: {
  ward: Ward;
  showFacility: boolean;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const nightOnly = w.min_night_nurses === 0 && w.min_night_na === 0;
  return (
    <div className="bg-card border rounded-xl p-5 shadow-soft">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold truncate">{w.name}</h3>
          {showFacility && (
            <p className="mt-1 inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
              <Building2 className="h-3 w-3 shrink-0" />
              <span className="truncate">{w.facility || "No facility assigned"}</span>
            </p>
          )}
        </div>
        {canManage && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              aria-label={`Edit ${w.name}`}
              onClick={onEdit}
              className="h-8 w-8 grid place-items-center rounded-md hover:bg-accent text-muted-foreground hover:text-foreground"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              aria-label={`Remove ${w.name}`}
              onClick={onDelete}
              className="h-8 w-8 grid place-items-center rounded-md hover:bg-destructive/10 text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 mt-4">
        <div className="border rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
            Morning min
          </p>
          <p className="text-sm font-semibold mt-1">
            {w.min_morning_nurses}N · {w.min_morning_na}NA
          </p>
        </div>
        <div className="border rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
            Night min
          </p>
          {nightOnly ? (
            <p className="text-sm font-semibold mt-1 text-muted-foreground">Morning only</p>
          ) : (
            <p className="text-sm font-semibold mt-1">
              {w.min_night_nurses}N · {w.min_night_na}NA
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function AddWardModal({ facility, onClose }: { facility: string; onClose: () => void }) {
  const qc = useQueryClient();
  const selectedFacility = facility.trim();
  const [form, setForm] = useState({
    name: "",
    min_morning_nurses: 2,
    min_morning_na: 1,
    min_night_nurses: 2,
    min_night_na: 1,
  });
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedFacility) {
      toast.error("Select a facility before adding a ward");
      return;
    }
    setBusy(true);
    try {
      await api.post("/wards", { ...form, facility: selectedFacility });
      toast.success("Ward added");
      logAudit("Added ward", form.name);
      await refreshWardQueries(qc);
      onClose();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to add ward");
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "w-full h-10 px-3 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring";

  return (
    <Modal title="Add ward" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="ward-facility" className="text-sm font-medium">
            Facility / branch
          </label>
          <input
            id="ward-facility"
            type="text"
            readOnly
            value={selectedFacility}
            className={`${inputCls} bg-muted/40`}
          />
        </div>
        <div>
          <label htmlFor="ward-name" className="text-sm font-medium">
            Ward name
          </label>
          <input
            id="ward-name"
            type="text"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={inputCls}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <NumField
            label="AM Nurses"
            value={form.min_morning_nurses}
            onChange={(v) => setForm({ ...form, min_morning_nurses: v })}
          />
          <NumField
            label="AM NA"
            value={form.min_morning_na}
            onChange={(v) => setForm({ ...form, min_morning_na: v })}
          />
          <NumField
            label="PM Nurses"
            value={form.min_night_nurses}
            onChange={(v) => setForm({ ...form, min_night_nurses: v })}
          />
          <NumField
            label="PM NA"
            value={form.min_night_na}
            onChange={(v) => setForm({ ...form, min_night_na: v })}
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

function EditWardModal({
  ward,
  facilityOptions,
  onClose,
}: {
  ward: Ward;
  facilityOptions: string[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const editFacilityOptions = useMemo(() => {
    const names = new Set(facilityOptions);
    if (ward.facility?.trim()) names.add(ward.facility.trim());
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [facilityOptions, ward.facility]);
  const [form, setForm] = useState({
    name: ward.name,
    facility: ward.facility ?? "",
    min_morning_nurses: ward.min_morning_nurses,
    min_morning_na: ward.min_morning_na,
    min_night_nurses: ward.min_night_nurses,
    min_night_na: ward.min_night_na,
  });
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const facility = form.facility.trim();
    if (!facility) {
      toast.error("Facility or branch name is required");
      return;
    }
    setBusy(true);
    try {
      await api.patch(`/wards/${ward.id}`, { ...form, facility });
      toast.success("Ward updated");
      logAudit("Updated ward", form.name);
      await refreshWardQueries(qc);
      onClose();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update ward");
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "w-full h-10 px-3 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring";

  return (
    <Modal title={`Edit "${ward.name}"`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="edit-ward-name" className="text-sm font-medium">
            Ward name
          </label>
          <input
            id="edit-ward-name"
            type="text"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={inputCls}
          />
        </div>
        <div>
          <label htmlFor="edit-ward-facility" className="text-sm font-medium">
            Facility / branch
          </label>
          <select
            id="edit-ward-facility"
            required
            value={form.facility}
            onChange={(e) => setForm({ ...form, facility: e.target.value })}
            className={inputCls}
          >
            <option value="">Select facility</option>
            {editFacilityOptions.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <NumField
            label="AM Nurses"
            value={form.min_morning_nurses}
            onChange={(v) => setForm({ ...form, min_morning_nurses: v })}
          />
          <NumField
            label="AM NA"
            value={form.min_morning_na}
            onChange={(v) => setForm({ ...form, min_morning_na: v })}
          />
          <NumField
            label="PM Nurses"
            value={form.min_night_nurses}
            onChange={(v) => setForm({ ...form, min_night_nurses: v })}
          />
          <NumField
            label="PM NA"
            value={form.min_night_na}
            onChange={(v) => setForm({ ...form, min_night_na: v })}
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

function NumField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-[11px] font-medium text-muted-foreground">
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={0}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value) || 0)}
        className="w-full h-9 px-2 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
      />
    </div>
  );
}
