const { Pool, types } = require('pg');

// Return DATE columns as plain "YYYY-MM-DD" strings instead of JavaScript Date
// objects. pg's default parser uses the server's local timezone to construct the
// Date, so a stored "2026-07-22" becomes "2026-07-21T23:00:00.000Z" on a UTC+1
// server — causing off-by-one day bugs and breaking any code that appends
// "T00:00:00" to build a local-midnight Date.
types.setTypeParser(1082, (val) => val);

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 25,                    // support 250 concurrent users across 2 PM2 instances
  min: 4,                     // keep a few connections warm so a login's burst of
                               // ~24 parallel queries doesn't all pay a fresh-connection
                               // penalty at once after a quiet period
  idleTimeoutMillis: 300000,  // release idle connections after 5 min, not 30s — 30s was
                               // shorter than typical gaps between a nurse's app checks,
                               // so most logins were hitting a cold pool (this is the
                               // main suspect behind "sometimes login is slow to load")
  connectionTimeoutMillis: 5000, // fail fast if pool is exhausted
});

pool.on('error', (err) => console.error('DB pool error:', err));

module.exports = pool;
