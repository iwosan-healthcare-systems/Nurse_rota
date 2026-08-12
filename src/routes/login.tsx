import { createFileRoute, useNavigate, redirect, Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { api, setToken, getToken } from "@/lib/api";
import { Loader2, Eye, EyeOff } from "lucide-react";
import logo from "@/assets/logo.jpeg";
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
          "Sign in to Nurses Rota to manage nursing schedules, wards and staff for Iwosan Lagoon Hospitals.",
      },
      { property: "og:title", content: "Sign in — Nurses Rota" },
      {
        property: "og:description",
        content: "Secure access for Lagoon Hospitals nursing staff and administrators.",
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

  const isChoosingRole = roleOptions.length > 1;

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

    setBusy(true);
    try {
      const data = await api.post<{ token: string; user: ApiUser }>("/auth/login", {
        email,
        password,
      });
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

  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-background">
      <div className="hidden lg:flex flex-col justify-between p-12 bg-sidebar text-sidebar-foreground">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-lg bg-white grid place-items-center overflow-hidden">
            <img
              src={logo}
              alt="Iwosan Lagoon Hospitals"
              className="h-full w-full object-contain"
            />
          </div>
          <div>
            <p className="font-bold">Nurses Rota</p>
            <p className="text-xs text-sidebar-foreground/60">Iwosan Lagoon Hospitals</p>
          </div>
        </div>
        <div>
          <h1 className="text-4xl font-bold leading-tight">Safer staffing, automated.</h1>
          <p className="mt-4 text-sidebar-foreground/70 max-w-md">
            Automated rota generation, ward safety rules, leave management and a layered approval
            workflow — built for the nursing department.
          </p>
        </div>
        <p className="text-xs text-sidebar-foreground/50">
          Powered by Iwosan Healthcare Systems. <br />© {new Date().getFullYear()}. All rights
          reserved.
        </p>
      </div>

      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="lg:hidden flex items-center gap-2.5 mb-8">
            <div className="h-12 w-12 rounded-lg bg-white grid place-items-center overflow-hidden border">
              <img
                src={logo}
                alt="Iwosan Lagoon Hospitals"
                className="h-full w-full object-contain"
              />
            </div>
            <p className="font-bold text-lg">Nurses Rota</p>
          </div>

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
                      Forgot password?
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
          <p className="lg:hidden text-xs text-muted-foreground text-center mt-8">
            Powered by Iwosan Healthcare Systems. <br />© {new Date().getFullYear()}. All rights
            reserved.
          </p>
        </div>
      </div>
    </div>
  );
}
