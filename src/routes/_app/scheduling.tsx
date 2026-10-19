import { createFileRoute, useBlocker } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { SchedulingConfigurationEditor } from "@/components/settings/SchedulingConfiguration";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import type { SchedulingFacility } from "@/lib/scheduling-configuration";

export const Route = createFileRoute("/_app/scheduling")({
  head: () => ({ meta: [{ title: "Scheduling Configuration — Nurses Rota" }] }),
  component: SchedulingPage,
});

function SchedulingPage() {
  const { canViewSchedulingConfiguration, canManageSchedulingConfiguration, loading, user } =
    useAuth();
  const [facilityId, setFacilityId] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  useBlocker({
    shouldBlockFn: () =>
      busy || (dirty && !window.confirm("Discard unsaved scheduling changes and leave this page?")),
    enableBeforeUnload: dirty || busy,
  });
  const facilities = useQuery({
    queryKey: ["scheduling-facilities", user?.id],
    queryFn: () => api.get<{ facilities: SchedulingFacility[] }>("/scheduling/facilities"),
    enabled: !loading && canViewSchedulingConfiguration,
    retry: false,
  });
  if (loading) return <p>Loading…</p>;
  if (!canViewSchedulingConfiguration)
    return <p role="alert">You do not have permission to view scheduling configuration.</p>;
  const facility =
    facilities.data?.facilities.find((f) => f.id === facilityId) ?? facilities.data?.facilities[0];
  return (
    <div>
      <PageHeader
        title="Scheduling configuration"
        subtitle="Define how your hospital’s shifts, staff roles and ward requirements fit together."
      />
      {facilities.isPending ? (
        <p role="status">Loading facilities…</p>
      ) : facilities.isError ? (
        <div role="alert" className="rounded-xl border p-5">
          <p>Could not load facilities. {facilities.error.message}</p>
          <Button className="mt-3" variant="outline" onClick={() => void facilities.refetch()}>
            Retry
          </Button>
        </div>
      ) : !facility ? (
        <div className="rounded-xl border p-6">
          <h2 className="font-semibold">No facilities available</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Your account needs a scheduling facility grant before you can view or configure its
            rules.
          </p>
        </div>
      ) : (
        <>
          <label className="mb-5 grid max-w-sm gap-1.5 text-sm font-medium">
            Facility
            <select
              className="rounded-md border bg-background px-3 py-2"
              value={facility.id}
              disabled={busy}
              onChange={(e) => {
                if (!dirty || window.confirm("Discard unsaved changes and switch facility?")) {
                  setDirty(false);
                  setFacilityId(e.target.value);
                }
              }}
            >
              {facilities.data?.facilities.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <SchedulingConfigurationEditor
            key={`${user?.id}-${facility.id}`}
            facility={facility}
            canManage={canManageSchedulingConfiguration}
            onDirtyChange={setDirty}
            onBusyChange={setBusy}
          />
        </>
      )}
    </div>
  );
}
