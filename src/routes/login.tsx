import { createFileRoute, useNavigate, redirect, Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { api, setToken, getToken } from "@/lib/api";
import { Loader2, Eye, EyeOff, ChevronRight, ArrowLeft } from "lucide-react";
import { AuthLayout } from "@/components/AuthLayout";
import { defaultHospitalLogo } from "@/lib/brand-assets";
import { rememberHospitalBranding } from "@/lib/hospital-branding";

type HospitalChoice = { id: string; name: string; logo: string | null; is_active: boolean };
type LoginResponse =
  | { token: string; user: ApiUser }
  | { choose_hospital: true; hospitals: HospitalChoice[] };
import { toast } from "sonner";
import {
  rememberSelectedRole,
  selectedRoleStorageKey,
  useAuth,
  useAuthInternal,
  type ApiUser,
  type AppRole,
} from "@/lib/auth-context";

export const Route = createFileRoute("/login")({
  beforeLoad: async () => {
    if (!getToken()) return;
    // Token exists; redirect home — auth-context will validate on mount
    throw redirect({ to: "/" });
  },
  head: () => ({
    meta: [
      { title: "Sign in — Nurses Rota" },
      {
        name: "description",
        content:
          "Sign in to Nurses Rota by Iwosan Healthcare Systems to manage nursing schedules, wards and staff.",
      },
      { property: "og:title", content: "Sign in — Nurses Rota" },
      {
        property: "og:description",
        content: "Secure access for nursing staff and administrators.",
      },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const { user, roles, needsRoleSelection, selectRole, roleLabel, roleDescription } = useAuth();
  const { setLoggedInUser } = useAuthInternal();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [roleOptions, setRoleOptions] = useState<AppRole[]>([]);
  const [selectedRole, setSelectedRole] = useState<AppRole | "">("");
  const [pendingUser, setPendingUser] = useState<ApiUser | null>(null);
  // Accounts with access to more than one hospital pick one before signing in.
  const [hospitalChoices, setHospitalChoices] = useState<HospitalChoice[] | null>(null);
  const [enteringHospital, setEnteringHospital] = useState<string | null>(null);

  const isChoosingRole = roleOptions.length > 1;
  const isChoosingHospital = !isChoosingRole && !!hospitalChoices;

  useEffect(() => {
    if (!needsRoleSelection || roles.length <= 1) return;
    setRoleOptions(roles);
    setSelectedRole((current) => (current && roles.includes(current) ? current : roles[0]));
  }, [needsRoleSelection, roles]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (isChoosingRole) {
      continueWithRole();
      return;
    }

    await signIn();
  }

  async function signIn(hospitalId?: string) {
    setBusy(true);
    if (hospitalId) {
      setEnteringHospital(hospitalId);
      // The dashboard then opens with this hospital's logo, not a placeholder.
      const chosen = hospitalChoices?.find((h) => h.id === hospitalId);
      if (chosen) rememberHospitalBranding(chosen.id, { logo: chosen.logo, name: chosen.name });
    }
    try {
      const data = await api.post<LoginResponse>("/auth/login", {
        email,
        password,
        ...(hospitalId ? { hospital_id: hospitalId } : {}),
      });
      if ("choose_hospital" in data) {
        setHospitalChoices(data.hospitals);
        return;
      }
      setToken(data.token);

      const nextUser = data.user;
      // Roles come straight from the server, already validated against the
      // roles table (FK constraint) — no client-side whitelist needed, so a
      // user whose only role is an admin-created custom role isn't silently
      // filtered out here.
      const nextRoles = nextUser.roles;

      if (nextRoles.length > 1) {
        sessionStorage.removeItem(selectedRoleStorageKey(nextUser.id));
        setPendingUser(nextUser);
        setRoleOptions(nextRoles);
        setSelectedRole(nextRoles[0]);
        // Hydrate the auth context so useAuth().roles is populated during role selection
        setLoggedInUser(nextUser);
        toast.success("Select a role to continue");
        return;
      }

      if (nextRoles.length === 1) {
        rememberSelectedRole(nextUser.id, nextRoles[0]);
        setLoggedInUser(nextUser);
        selectRole(nextRoles[0]);
      }

      toast.success("Welcome back");
      navigate({ to: "/" });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setBusy(false);
      setEnteringHospital(null);
    }
  }

  function continueWithRole() {
    if (!selectedRole) {
      toast.error("Select a role to continue");
      return;
    }

    const userId = pendingUser?.id ?? user?.id;
    if (userId) rememberSelectedRole(userId, selectedRole);
    selectRole(selectedRole);
    toast.success(`Signed in as ${roleLabel(selectedRole)}`);
    navigate({ to: "/" });
  }

  if (isChoosingHospital && hospitalChoices)
    return (
      <AuthLayout>
        <div className="rounded-2xl border bg-card/90 p-6 shadow-soft backdrop-blur sm:p-8">
          <h2 className="text-2xl font-bold">Choose a hospital</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Your account works in {hospitalChoices.length} hospitals. Pick the one to open; you can
            switch later from the top bar.
          </p>
          <ul className="mt-6 max-h-88 space-y-2 overflow-y-auto pr-1">
            {hospitalChoices.map((h) => {
              const entering = enteringHospital === h.id;
              return (
                <li key={h.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void signIn(h.id)}
                    className="group flex w-full items-center gap-3 rounded-xl border bg-card p-3 text-left transition hover:border-primary/60 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-70"
                  >
                    <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-lg border bg-white">
                      <img
                        src={h.logo || defaultHospitalLogo(h.id)}
                        alt=""
                        className="h-full w-full object-contain"
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold" title={h.name}>
                        {h.name}
                      </span>
                      {h.is_active === false && (
                        <span className="mt-0.5 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                          Deactivated · staff cannot sign in
                        </span>
                      )}
                    </span>
                    {entering ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-primary" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setHospitalChoices(null);
              setPassword("");
            }}
            className="mt-5 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Use a different account
          </button>
        </div>
      </AuthLayout>
    );

  return (
    <AuthLayout>
      <div className="rounded-2xl border bg-card/90 p-6 shadow-soft backdrop-blur sm:p-8">
        <h2 className="text-2xl font-bold">{isChoosingRole ? "Choose your role" : "Sign in"}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {isChoosingRole
            ? "Select the role you want to use for this session."
            : "Enter your credentials to continue."}
        </p>

        <form onSubmit={submit} className="space-y-4 mt-6">
          {isChoosingRole ? (
            <div>
              <label htmlFor="login-role" className="text-sm font-medium">
                Login role
              </label>
              <select
                id="login-role"
                required
                value={selectedRole}
                onChange={(e) => setSelectedRole(e.target.value as AppRole)}
                className="mt-1 w-full h-10 px-3 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
              >
                {roleOptions.map((role) => (
                  <option key={role} value={role}>
                    {roleLabel(role)}
                  </option>
                ))}
              </select>
              {selectedRole && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {roleDescription(selectedRole)}
                </p>
              )}
            </div>
          ) : (
            <>
              <div>
                <label htmlFor="login-email" className="text-sm font-medium">
                  Email
                </label>
                <input
                  id="login-email"
                  required
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1 w-full h-10 px-3 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <label htmlFor="login-password" className="text-sm font-medium">
                    Password
                  </label>
                  <Link
                    to="/forgot-password"
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Reset password
                  </Link>
                </div>
                <div className="relative mt-1">
                  <input
                    id="login-password"
                    type={showPassword ? "text" : "password"}
                    required
                    minLength={6}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full h-10 px-3 pr-9 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </>
          )}
          <button
            disabled={busy}
            type="submit"
            className="w-full h-10 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center justify-center gap-2"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {isChoosingRole ? "Open dashboard" : "Sign in"}
          </button>
        </form>
      </div>
    </AuthLayout>
  );
}
