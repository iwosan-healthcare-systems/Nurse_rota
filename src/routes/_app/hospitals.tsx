import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Users, UserRound, Pencil } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { HospitalSetupWizard } from "@/components/hospitals/HospitalSetupWizard";
import { HospitalLogoField } from "@/components/hospitals/HospitalLogoField";
import appLogo from "@/assets/logo.jpeg";

export const Route = createFileRoute("/_app/hospitals")({
  head: () => ({ meta: [{ title: "Hospitals — Nurses Rota" }] }),
  component: HospitalsPage,
});

type Hospital = {
  id: string;
  name: string;
  created_at: string;
  members: number;
  staff: number;
  logo: string | null;
};
type PlatformUser = {
  id: string;
  full_name: string | null;
  email: string | null;
  is_active: boolean;
  is_super_admin: boolean;
  hospital_ids: string[];
  roles: string[];
};
type Created = {
  id: string;
  name: string;
  administrator: { email: string };
  temporary_password: string;
};

const input = "h-9 rounded-md border bg-background px-3 text-sm";
const PAGE_SIZE = 20;

function HospitalsPage() {
  const { isSuperAdmin, hospitalId, switchHospital, user, roleLabel } = useAuth();
  const client = useQueryClient();
  const [tab, setTab] = useState("hospitals");
  const [created, setCreated] = useState<Created | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [logoFor, setLogoFor] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const hospitals = useQuery({
    queryKey: ["platform-hospitals"],
    enabled: isSuperAdmin,
    queryFn: () => api.get<{ hospitals: Hospital[] }>("/hospitals"),
  });
  const users = useQuery({
    queryKey: ["platform-users"],
    enabled: isSuperAdmin,
    queryFn: () => api.get<{ users: PlatformUser[] }>("/hospitals/users"),
  });
  const security = useQuery({
    queryKey: ["platform-security"],
    enabled: isSuperAdmin,
    queryFn: () =>
      api.get<{
        database_user: string;
        superuser: boolean;
        bypasses_row_security: boolean;
        isolation_enforced: boolean;
      }>("/hospitals/security"),
  });
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (users.data?.users ?? []).filter(
      (u) =>
        !term ||
        (u.full_name ?? "").toLowerCase().includes(term) ||
        (u.email ?? "").toLowerCase().includes(term),
    );
  }, [users.data, search]);

  if (!isSuperAdmin) return <p role="alert">Only platform administrators can manage hospitals.</p>;

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["platform-hospitals"] });
    void client.invalidateQueries({ queryKey: ["platform-users"] });
    void client.invalidateQueries({ queryKey: ["my-hospitals"] });
  };
  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }
  const list = hospitals.data?.hospitals ?? [];
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageUsers = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Hospitals"
        subtitle="Each hospital's facilities, staff, rotas, leave and settings are kept separate."
      />

      {security.data && (
        <p
          role={security.data.isolation_enforced ? "status" : "alert"}
          className={`rounded-xl border p-3 text-sm ${
            security.data.isolation_enforced
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-destructive/40 bg-destructive/10 text-destructive"
          }`}
        >
          {security.data.isolation_enforced
            ? `Hospital data separation is enforced by the database (user "${security.data.database_user}").`
            : `Hospital data is NOT separated: the API's database user "${security.data.database_user}" ${
                security.data.superuser ? "is a superuser" : "can bypass row-level security"
              }. Do not add another hospital until the API connects as a normal database user.`}
        </p>
      )}

      {created && (
        <section
          role="status"
          className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-4"
        >
          <h2 className="font-semibold">{created.name} is ready</h2>
          <p className="text-sm">
            An account was created for {created.administrator.email}, and the sign-in details were
            emailed to them. If the email does not arrive, give them this temporary password
            securely. It is shown only once, and they must change it when they first sign in.
          </p>
          <p className="font-mono text-lg font-semibold tracking-wide">
            {created.temporary_password}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => switchHospital(created.id)}>Switch to {created.name}</Button>
            <Button variant="ghost" onClick={() => setCreated(null)}>
              Dismiss
            </Button>
          </div>
        </section>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto flex-wrap justify-start gap-1">
          <TabsTrigger value="hospitals">Hospitals ({list.length})</TabsTrigger>
          <TabsTrigger value="access">Access ({users.data?.users.length ?? 0})</TabsTrigger>
          <TabsTrigger value="add">Add hospital</TabsTrigger>
        </TabsList>

        <TabsContent value="hospitals" className="mt-4">
          {hospitals.isPending ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {list.map((h) => (
                <article
                  key={h.id}
                  className={`flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-soft ${
                    h.id === hospitalId ? "ring-2 ring-primary/40" : ""
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-lg border bg-white">
                      <img
                        src={h.logo || appLogo}
                        alt={`${h.name} logo`}
                        className="h-full w-full object-contain"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      {renaming?.id === h.id ? (
                        <form
                          className="flex flex-wrap gap-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void run(async () => {
                              await api.patch(`/hospitals/${h.id}`, { name: renaming.name });
                              setRenaming(null);
                            }, "Hospital renamed");
                          }}
                        >
                          <input
                            aria-label="New hospital name"
                            className={`${input} min-w-0 flex-1`}
                            value={renaming.name}
                            maxLength={160}
                            onChange={(e) => setRenaming({ id: h.id, name: e.target.value })}
                          />
                          <Button type="submit" size="sm" disabled={busy || !renaming.name.trim()}>
                            Save
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setRenaming(null)}
                          >
                            Cancel
                          </Button>
                        </form>
                      ) : (
                        <>
                          <h3 className="truncate font-semibold" title={h.name}>
                            {h.name}
                          </h3>
                          {h.id === hospitalId && (
                            <span className="mt-1 inline-block rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                              You are here
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                  <dl className="grid grid-cols-2 gap-2 text-sm">
                    <div className="rounded-lg bg-muted/50 p-2">
                      <dt className="flex items-center gap-1 text-xs text-muted-foreground">
                        <UserRound className="h-3 w-3" /> Active staff
                      </dt>
                      <dd className="font-semibold">{h.staff}</dd>
                    </div>
                    <div className="rounded-lg bg-muted/50 p-2">
                      <dt className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Users className="h-3 w-3" /> Accounts
                      </dt>
                      <dd className="font-semibold">{h.members}</dd>
                    </div>
                  </dl>
                  {logoFor === h.id && (
                    <div className="rounded-lg border p-3">
                      <HospitalLogoField
                        value={h.logo}
                        disabled={busy}
                        onChange={(logo) =>
                          run(
                            () => api.put(`/hospitals/${h.id}/logo`, { logo }),
                            logo ? "Logo updated" : "Logo removed",
                          )
                        }
                      />
                    </div>
                  )}
                  <div className="mt-auto flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={h.id === hospitalId}
                      onClick={() => switchHospital(h.id)}
                    >
                      Switch to
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setRenaming({ id: h.id, name: h.name })}
                    >
                      <Pencil className="mr-1 h-3.5 w-3.5" /> Rename
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-expanded={logoFor === h.id}
                      onClick={() => setLogoFor(logoFor === h.id ? null : h.id)}
                    >
                      Logo
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="access" className="mt-4">
          <section className="space-y-3 rounded-xl border bg-card p-4">
            <p className="text-sm text-muted-foreground">
              Staff only see hospitals ticked here and keep the same roles in each. Platform
              administrators can enter and manage every hospital.
            </p>
            <input
              aria-label="Search accounts"
              className={`${input} w-full sm:w-80`}
              placeholder="Search by name or email"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
            />
            {users.isPending ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">Account</th>
                        {list.map((h) => (
                          <th key={h.id} className="px-2 py-2 text-center font-medium">
                            {h.name}
                          </th>
                        ))}
                        <th className="px-2 py-2 text-center font-medium">Platform admin</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageUsers.map((u) => (
                        <tr key={u.id} className="border-b last:border-0">
                          <td className="py-2 pr-3">
                            <p className="font-medium">
                              {u.full_name ?? u.email ?? "Unnamed account"}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {[u.email, u.roles.map(roleLabel).join(", ")]
                                .filter(Boolean)
                                .join(" · ")}
                              {!u.is_active && " · inactive"}
                            </p>
                          </td>
                          {list.map((h) => {
                            const member = u.hospital_ids.includes(h.id);
                            return (
                              <td key={h.id} className="px-2 py-2 text-center">
                                <input
                                  type="checkbox"
                                  aria-label={`${u.full_name ?? u.email} can access ${h.name}`}
                                  checked={member}
                                  disabled={busy}
                                  onChange={() =>
                                    void run(
                                      () =>
                                        member
                                          ? api.del(`/hospitals/${h.id}/members/${u.id}`)
                                          : api.put(`/hospitals/${h.id}/members/${u.id}`),
                                      member
                                        ? `Access to ${h.name} removed`
                                        : `Access to ${h.name} granted`,
                                    )
                                  }
                                />
                              </td>
                            );
                          })}
                          <td className="px-2 py-2 text-center">
                            <input
                              type="checkbox"
                              aria-label={`${u.full_name ?? u.email} is a platform administrator`}
                              checked={u.is_super_admin}
                              disabled={busy || u.id === user?.id}
                              onChange={() => {
                                if (
                                  !u.is_super_admin &&
                                  !window.confirm(
                                    `Make ${u.full_name ?? u.email} a platform administrator? They will be able to enter, create and manage every hospital.`,
                                  )
                                )
                                  return;
                                void run(
                                  () =>
                                    api.patch(`/hospitals/users/${u.id}/super-admin`, {
                                      is_super_admin: !u.is_super_admin,
                                    }),
                                  "Platform access updated",
                                );
                              }}
                            />
                          </td>
                        </tr>
                      ))}
                      {!pageUsers.length && (
                        <tr>
                          <td
                            colSpan={list.length + 2}
                            className="py-6 text-center text-muted-foreground"
                          >
                            No accounts match this search.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <nav
                  aria-label="Accounts pages"
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <span className="text-muted-foreground">
                    {filtered.length
                      ? `${currentPage * PAGE_SIZE + 1}–${Math.min(
                          (currentPage + 1) * PAGE_SIZE,
                          filtered.length,
                        )} of ${filtered.length}`
                      : "0 accounts"}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={currentPage === 0}
                      onClick={() => setPage(currentPage - 1)}
                    >
                      <ChevronLeft className="h-4 w-4" /> Previous
                    </Button>
                    <span>
                      Page {currentPage + 1} of {pageCount}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={currentPage >= pageCount - 1}
                      onClick={() => setPage(currentPage + 1)}
                    >
                      Next <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </nav>
              </>
            )}
          </section>
        </TabsContent>

        <TabsContent value="add" className="mt-4">
          <HospitalSetupWizard
            onCancel={() => setTab("hospitals")}
            onCreated={(hospital) => {
              setCreated(hospital);
              setTab("hospitals");
              refresh();
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
