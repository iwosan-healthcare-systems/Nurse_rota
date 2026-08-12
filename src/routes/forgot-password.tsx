import { createFileRoute, useNavigate, Link, redirect } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { api, getToken } from "@/lib/api";
import { Loader2, Eye, EyeOff, ArrowLeft } from "lucide-react";
import logo from "@/assets/logo.jpeg";
import { toast } from "sonner";

export const Route = createFileRoute("/forgot-password")({
  beforeLoad: async () => {
    if (!getToken()) return;
    throw redirect({ to: "/" });
  },
  head: () => ({
    meta: [
      { title: "Reset password — Nurses Rota" },
      { name: "description", content: "Reset your Nurses Rota account password." },
    ],
  }),
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<"email" | "reset">("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  // Public endpoint (no auth) — /api/portal-settings is auth-gated at the
  // mount level, but this page is by definition logged-out.
  const [minPasswordLength, setMinPasswordLength] = useState(8);

  useEffect(() => {
    api
      .get<{ min_password_length: number }>("/auth/password-policy")
      .then(({ min_password_length }) => {
        if (typeof min_password_length === "number" && min_password_length > 0) {
          setMinPasswordLength(min_password_length);
        }
      })
      .catch(() => {});
  }, []);

  async function submitEmail(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      const data = await api.post<{ message: string }>("/auth/forgot-password", { email });
      toast.success(data.message);
      setStep("reset");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function submitReset(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error("Passwords don't match");
      return;
    }
    setBusy(true);
    try {
      await api.post("/auth/reset-password", { email, otp, new_password: newPassword });
      toast.success("Password reset — sign in with your new password");
      navigate({ to: "/login" });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
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

          <Link
            to="/login"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-4"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
          </Link>

          {step === "email" ? (
            <>
              <h2 className="text-2xl font-bold">Reset your password</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Enter the email on your account and we'll send you a code to reset your password.
              </p>

              <form onSubmit={submitEmail} className="space-y-4 mt-6">
                <div>
                  <label htmlFor="fp-email" className="text-sm font-medium">
                    Email
                  </label>
                  <input
                    id="fp-email"
                    required
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="mt-1 w-full h-10 px-3 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <button
                  disabled={busy}
                  type="submit"
                  className="w-full h-10 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center justify-center gap-2"
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  Send reset code
                </button>
              </form>
            </>
          ) : (
            <>
              <h2 className="text-2xl font-bold">Enter your code</h2>
              <p className="text-sm text-muted-foreground mt-1">
                If an account exists for <span className="font-medium">{email}</span>, a 6-digit
                code was sent to it. It expires in 5 minutes.
              </p>

              <form onSubmit={submitReset} className="space-y-4 mt-6">
                <div>
                  <label htmlFor="fp-otp" className="text-sm font-medium">
                    Reset code
                  </label>
                  <input
                    id="fp-otp"
                    required
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="123456"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    className="mt-1 w-full h-10 px-3 rounded-md border bg-card text-sm tracking-[0.3em] outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div>
                  <label htmlFor="fp-new-password" className="text-sm font-medium">
                    New password
                  </label>
                  <div className="relative mt-1">
                    <input
                      id="fp-new-password"
                      type={showPassword ? "text" : "password"}
                      required
                      minLength={minPasswordLength}
                      autoComplete="new-password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
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
                <div>
                  <label htmlFor="fp-confirm-password" className="text-sm font-medium">
                    Confirm new password
                  </label>
                  <input
                    id="fp-confirm-password"
                    type={showPassword ? "text" : "password"}
                    required
                    minLength={minPasswordLength}
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="mt-1 w-full h-10 px-3 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <button
                  disabled={busy}
                  type="submit"
                  className="w-full h-10 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-60 inline-flex items-center justify-center gap-2"
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  Reset password
                </button>
                <button
                  type="button"
                  onClick={() => setStep("email")}
                  className="w-full text-xs text-muted-foreground hover:text-foreground"
                >
                  Use a different email or resend code
                </button>
              </form>
            </>
          )}

          <p className="lg:hidden text-xs text-muted-foreground text-center mt-8">
            Powered by Iwosan Healthcare Systems. <br />© {new Date().getFullYear()}. All rights
            reserved.
          </p>
        </div>
      </div>
    </div>
  );
}
