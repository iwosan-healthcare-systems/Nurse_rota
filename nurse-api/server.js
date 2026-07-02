require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '10mb' }));

const { requireAuth } = require('./middleware/auth');

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
app.use('/api/notifications',     requireAuth, require('./routes/notifications'));
app.use('/api/nurse-period-hours',requireAuth, require('./routes/nurse-period-hours'));
app.use('/api/rpc',               requireAuth, require('./routes/rpc'));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Nurse API running on port ${PORT}`));
