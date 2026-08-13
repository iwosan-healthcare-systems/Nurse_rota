const router = require("express").Router();
const pool = require("../db");
const { requireRole } = require("../middleware/auth");
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Admin-only visibility into the daily pg_dump cron on NRota-DB — the script
// itself lives outside this repo (/var/backups/nrota-db/pg_backup.sh) and
// writes one row here per database per run. Just the most recent handful;
// this is a status check, not an audit trail (audit_logs already exists for
// that if it's ever needed).
router.get(
  "/",
  requireRole("admin"),
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (database) database, filename, size_bytes, status, error, created_at
         FROM backup_log
        ORDER BY database, created_at DESC`,
    );
    res.json(rows);
  }),
);

module.exports = router;
