import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, UserCheck, UserMinus, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useCurrentRotaPeriod } from "@/lib/use-current-rota-period";
import { rotaToday } from "@/lib/rota-window";

type StaffRef = {
  id: string;
  name: string;
  role: string;
  facility: string | null;
  profile_id?: string | null;
};
type LeftStaff = StaffRef & { left_on: string | null };

const longDate = (ymd: string) =>
  new Date(`${ymd}T00:00:00`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ["nurses"] });
  void qc.invalidateQueries({ queryKey: ["assignments"] });
  void qc.invalidateQueries({ queryKey: ["profile-names"] });
  void qc.invalidateQueries({ queryKey: ["staff-left"] });
}

/** Choose a staff member's last working day and take them off the rota. */
export function RemoveFromRotaDialog({ staff, onClose }: { staff: StaffRef; onClose: () => void }) {
  const qc = useQueryClient();
  const [lastDay, setLastDay] = useState(rotaToday().slice(0, 10));
  const [deactivateLogin, setDeactivateLogin] = useState(true);
  const period = useCurrentRotaPeriod();
  const start = period.data?.start?.slice(0, 10);
  const end = period.data?.end?.slice(0, 10);
  const remove = useMutation({
    mutationFn: () =>
      api.post<{ shiftsCleared: number; requestsExpired: number; invitesClosed: number }>(
        `/nurses/${staff.id}/remove-from-rota`,
        { last_day: lastDay, deactivate_login: deactivateLogin && !!staff.profile_id },
      ),
    onSuccess: (r) => {
      toast.success(
        `${staff.name} is off the rota after ${longDate(lastDay)} · ${r.shiftsCleared} shift${
          r.shiftsCleared === 1 ? "" : "s"
        } cleared${r.requestsExpired ? ` · ${r.requestsExpired} pending request(s) expired` : ""}`,
        { duration: 8000 },
      );
      invalidate(qc);
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-from-rota-title"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border bg-card shadow-card"
      >
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 id="remove-from-rota-title" className="font-semibold">
            Remove {staff.name} from the rota
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid size-8 place-items-center rounded-md hover:bg-muted"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="space-y-4 p-5 text-sm">
          <p className="text-muted-foreground">
            For staff leaving partway through the month. {staff.role}
            {staff.facility ? ` · ${staff.facility}` : ""}.
          </p>
          <label className="grid gap-1.5">
            <span className="font-medium">Last working day</span>
            <input
              type="date"
              className="w-full rounded-md border bg-background px-3 py-2"
              value={lastDay}
              min={start}
              max={end}
              onChange={(e) => setLastDay(e.target.value)}
            />
            <span className="text-xs text-muted-foreground">
              {lastDay ? longDate(lastDay) : "Choose a date"}
              {start && end
                ? `. Must be in the current rota month (${new Date(`${start}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${new Date(`${end}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}).`
                : ""}
            </span>
          </label>
          <div className="rounded-lg bg-muted/50 p-3">
            <p className="font-medium">What happens</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
              <li>Their shifts after that day are cleared, including published ones.</li>
              <li>Their pending leave and switch requests after that day expire.</li>
              <li>They are left out of all future rotas.</li>
              <li>Shifts they already worked stay on the rota and in their hours.</li>
            </ul>
          </div>
          {staff.profile_id && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4"
                checked={deactivateLogin}
                onChange={(e) => setDeactivateLogin(e.target.checked)}
              />
              Also deactivate their login
            </label>
          )}
          <p className="text-xs text-muted-foreground">
            You can put them back later from “Staff who have left”. Cleared shifts are not restored.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!lastDay || remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? <Loader2 className="animate-spin" /> : <UserMinus />}
              Remove from rota
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Staff taken off the rota, with a way to bring them back. */
export function StaffWhoHaveLeft({ facility }: { facility: string | null }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const left = useQuery({
    queryKey: ["staff-left"],
    queryFn: () => api.get<LeftStaff[]>("/nurses?inactive_only=true"),
  });
  const rows = (left.data ?? []).filter((n) => !facility || n.facility === facility);
  const back = useMutation({
    mutationFn: (n: LeftStaff) =>
      api.post(`/nurses/${n.id}/return-to-rota`, { reactivate_login: !!n.profile_id }),
    onSuccess: (_, n) => {
      toast.success(
        `${n.name} is back on the rota. Use “Generate for new staff” on the Rota page to schedule them.`,
        { duration: 8000 },
      );
      invalidate(qc);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (!rows.length) return null;
  return (
    <div className="mt-6 rounded-xl border bg-card">
      <button
        type="button"
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Staff who have left ({rows.length})
        <span className="text-xs font-normal text-muted-foreground">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <ul className="divide-y border-t text-sm">
          {rows.map((n) => (
            <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <span>
                <span className="font-medium">{n.name}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · {n.role}
                  {n.facility ? ` · ${n.facility}` : ""}
                  {n.left_on
                    ? ` · last day ${new Date(`${n.left_on.slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`
                    : ""}
                </span>
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={back.isPending}
                onClick={() => {
                  if (window.confirm(`Put ${n.name} back on the rota?`)) back.mutate(n);
                }}
              >
                <UserCheck />
                Return to rota
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
