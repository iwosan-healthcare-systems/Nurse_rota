const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 25,                    // support 250 concurrent users across 2 PM2 instances
  idleTimeoutMillis: 30000,   // release idle connections after 30s
  connectionTimeoutMillis: 5000, // fail fast if pool is exhausted
});

pool.on('error', (err) => console.error('DB pool error:', err));

module.exports = pool;
