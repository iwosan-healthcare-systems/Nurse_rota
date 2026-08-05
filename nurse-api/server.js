require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1); // trust Apache reverse proxy for X-Forwarded-For

const allowedOrigin = process.env.ALLOWED_ORIGIN;
if (!allowedOrigin) throw new Error('ALLOWED_ORIGIN env var is not set');

app.use(cors({
  origin: allowedOrigin,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  // Cache the preflight result client-side (Chrome caps this at 2h regardless of
  // the value sent) — the frontend is on a different origin (Netlify) than the
  // API, and the Authorization header makes every GET/POST a "non-simple" CORS
  // request. Login + first page load fires ~24 API calls at once; without this,
  // each one pays its own separate OPTIONS preflight round trip on top of the
  // real request.
  maxAge: 7200,
}));
app.use(compression()); // gzip JSON responses — no-op cost, real win on slower connections
app.use(express.json({ limit: '100kb' }));

// Rate-limit login to 10 attempts per 15 minutes per IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts — please try again in 15 minutes' },
});

const { requireAuth } = require('./middleware/auth');

app.use('/api/auth/login', loginLimiter);
app.use('/api/auth',              require('./routes/auth'));
app.use('/api/nurses',            requireAuth, require('./routes/nurses'));
app.use('/api/wards',             requireAuth, require('./routes/wards'));
app.use('/api/profiles',          requireAuth, require('./routes/profiles'));
app.use('/api/user-roles',        requireAuth, require('./routes/user-roles'));
app.use('/api/shift-assignments', requireAuth, require('./routes/shift-assignments'));
app.use('/api/shift-logs',        requireAuth, require('./routes/shift-logs'));
app.use('/api/leave-requests',    requireAuth, require('./routes/leave-requests'));
app.use('/api/locum',             requireAuth, require('./routes/locum'));
app.use('/api/audit-logs',        requireAuth, require('./routes/audit-logs'));
app.use('/api/portal-settings',   requireAuth, require('./routes/portal-settings'));
app.use('/api/roles',             requireAuth, require('./routes/roles'));
app.use('/api/rota-edit-requests',requireAuth, require('./routes/rota-edit-requests'));
app.use('/api/notifications',     requireAuth, require('./routes/notifications'));
app.use('/api/nurse-period-hours',requireAuth, require('./routes/nurse-period-hours'));
app.use('/api/rota-transitions',  requireAuth, require('./routes/rota-transitions'));
app.use('/api/rpc',               requireAuth, require('./routes/rpc'));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use((err, req, res, next) => {
  console.error(err.stack);
  // Never leak raw PostgreSQL error details (table names, constraint names, enum values).
  const isPgError = err.code && /^\d{5}$/.test(String(err.code));
  res.status(500).json({ error: isPgError ? 'Database error' : (err.message || 'Internal server error') });
});

const { startAutoEndJob } = require('./jobs/auto-end-shifts');
const { startAutoDeclineJob } = require('./jobs/auto-decline-requests');
const { startAutoExpireLocumJob } = require('./jobs/auto-expire-locum-requests');
const { startAutoGenerateJob } = require('./jobs/auto-generate-rota');
const { startAutoSubmitJob } = require('./jobs/auto-submit-draft');
const { startAutoPublishJob } = require('./jobs/auto-publish-rota');
const { startShiftStartReminderJob } = require('./jobs/auto-shift-start-reminder');
const { startShiftMissedReminderJob } = require('./jobs/auto-shift-missed-reminder');
const { startLeaveApprovalReminderJob } = require('./jobs/auto-leave-approval-reminder');
const { startLocumApprovalReminderJob } = require('./jobs/auto-locum-approval-reminder');
const { startRotaEditApprovalReminderJob } = require('./jobs/auto-rota-edit-approval-reminder');
const { startRotaApprovalReminderJob } = require('./jobs/auto-rota-approval-reminder');

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Nurse API running on port ${PORT}`);
  startAutoEndJob();
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
});
