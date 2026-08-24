require("dotenv").config();
const express = require("express");
const cors = require("cors");
const compression = require("compression");
const rateLimit = require("express-rate-limit");

const app = express();
app.set("trust proxy", 1); // trust Apache reverse proxy for X-Forwarded-For

const allowedOrigin = process.env.ALLOWED_ORIGIN;
if (!allowedOrigin) throw new Error("ALLOWED_ORIGIN env var is not set");

app.use(
  cors({
    origin: allowedOrigin,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    // Cache the preflight result client-side (Chrome caps this at 2h regardless of
    // the value sent) — the frontend is on a different origin (Netlify) than the
    // API, and the Authorization header makes every GET/POST a "non-simple" CORS
    // request. Login + first page load fires ~24 API calls at once; without this,
    // each one pays its own separate OPTIONS preflight round trip on top of the
    // real request.
    maxAge: 7200,
  }),
);
app.use(compression()); // gzip JSON responses — no-op cost, real win on slower connections
app.use(express.json({ limit: "100kb" }));

// Rate-limit login to 10 attempts per 15 minutes per IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts — please try again in 15 minutes" },
});

// Forgot-password requests a fresh email each time — cap per IP so it can't
// be used to mail-bomb an address or hammer the email provider.
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please try again in 15 minutes" },
});

// Per-code attempt cap already lives in the route itself (MAX_OTP_ATTEMPTS);
// this is a second, IP-scoped layer against distributed guessing.
const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts — please try again in 15 minutes" },
});

const { requireAuth } = require("./middleware/auth");

app.use("/api/auth/login", loginLimiter);
app.use("/api/auth/forgot-password", forgotPasswordLimiter);
app.use("/api/auth/reset-password", resetPasswordLimiter);
app.use("/api/auth", require("./routes/auth"));
app.use("/api/nurses", requireAuth, require("./routes/nurses"));
app.use("/api/wards", requireAuth, require("./routes/wards"));
app.use("/api/profiles", requireAuth, require("./routes/profiles"));
app.use("/api/user-roles", requireAuth, require("./routes/user-roles"));
app.use("/api/shift-assignments", requireAuth, require("./routes/shift-assignments"));
app.use("/api/shift-logs", requireAuth, require("./routes/shift-logs"));
app.use("/api/leave-requests", requireAuth, require("./routes/leave-requests"));
app.use("/api/leave-entitlements", requireAuth, require("./routes/leave-entitlements"));
app.use("/api/locum", requireAuth, require("./routes/locum"));
app.use("/api/audit-logs", requireAuth, require("./routes/audit-logs"));
app.use("/api/portal-settings", requireAuth, require("./routes/portal-settings"));
app.use(
  "/api/user-capability-overrides",
  requireAuth,
  require("./routes/user-capability-overrides"),
);
app.use("/api/roles", requireAuth, require("./routes/roles"));
app.use("/api/rota-edit-requests", requireAuth, require("./routes/rota-edit-requests"));
app.use("/api/notifications", requireAuth, require("./routes/notifications"));
app.use("/api/nurse-period-hours", requireAuth, require("./routes/nurse-period-hours"));
app.use("/api/rota-transitions", requireAuth, require("./routes/rota-transitions"));
app.use("/api/rpc", requireAuth, require("./routes/rpc"));
app.use("/api/backup-log", requireAuth, require("./routes/backup-log"));

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

app.use((err, req, res, next) => {
  console.error(err.stack);
  // Never leak raw PostgreSQL error details (table names, constraint names, enum values).
  const isPgError = err.code && /^\d{5}$/.test(String(err.code));
  res
    .status(500)
    .json({ error: isPgError ? "Database error" : err.message || "Internal server error" });
});

const { startAutoEndJob } = require("./jobs/auto-end-shifts");
const { startAutoClosePeriodJob } = require("./jobs/auto-close-period");
const { startAutoDeclineJob } = require("./jobs/auto-decline-requests");
const { startAutoExpireLocumJob } = require("./jobs/auto-expire-locum-requests");
const { startAutoGenerateJob } = require("./jobs/auto-generate-rota");
const { startAutoSubmitJob } = require("./jobs/auto-submit-draft");
const { startAutoPublishJob } = require("./jobs/auto-publish-rota");
const { startShiftStartReminderJob } = require("./jobs/auto-shift-start-reminder");
const { startShiftMissedReminderJob } = require("./jobs/auto-shift-missed-reminder");
const { startLeaveApprovalReminderJob } = require("./jobs/auto-leave-approval-reminder");
const { startLocumApprovalReminderJob } = require("./jobs/auto-locum-approval-reminder");
const { startRotaEditApprovalReminderJob } = require("./jobs/auto-rota-edit-approval-reminder");
const { startRotaApprovalReminderJob } = require("./jobs/auto-rota-approval-reminder");

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Nurse API running on port ${PORT}`);

  // In PM2 cluster mode (production runs 4 workers), every worker process
  // would otherwise register every cron job, and node-cron fires all of them
  // in every worker at the same wall-clock tick. The pg advisory lock in each
  // job already ensures only one worker's invocation actually does the work,
  // but all N workers still open a Postgres connection just to check the
  // lock — 12 jobs x 4 workers = 48 near-simultaneous connection attempts
  // every 5 minutes (and again at every deploy restart), which is what
  // exhausted Postgres's max_connections. Registering cron only on the first
  // worker (NODE_APP_INSTANCE, set by PM2 in both cluster and fork mode,
  // always starting at '0') cuts that to 12. The advisory locks stay in place
  // as a safety net (e.g. a moment where two "instance 0"s briefly overlap
  // during a rolling deploy), just no longer the only thing preventing a
  // connection-count blowup.
  if (!process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === "0") {
    startAutoEndJob();
    startAutoClosePeriodJob();
    startAutoDeclineJob();
    startAutoExpireLocumJob();
    startAutoGenerateJob();
    startAutoSubmitJob();
    startAutoPublishJob();
    startShiftStartReminderJob();
    startShiftMissedReminderJob();
    startLeaveApprovalReminderJob();
    startLocumApprovalReminderJob();
    startRotaEditApprovalReminderJob();
    startRotaApprovalReminderJob();
  }
});
