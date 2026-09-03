const router = require("express").Router();
const pool = require("../db");
const { requireCapability } = require("../middleware/capability");
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.get(
  "/",
  wrap(async (req, res) => {
    const conditions = [];
    const params = [];

    if (req.query.nurse_id) {
      conditions.push(`nph.nurse_id = $${params.length + 1}`);
      params.push(req.query.nurse_id);
    }
    if (req.query.period_start) {
      conditions.push(`nph.period_start = $${params.length + 1}`);
      params.push(req.query.period_start);
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    let query = `
      SELECT nph.*,
             COALESCE(assigned.assigned_hours, 0) AS assigned_hours
        FROM nurse_period_hours nph
        LEFT JOIN LATERAL (
          SELECT ROUND(
                   SUM(
                     CASE
                       WHEN sa.shift = 'LEAVE' AND sa.pre_leave_shift IN ('M', 'MWC') THEN 9
                       WHEN sa.shift = 'LEAVE' AND sa.pre_leave_shift IN ('N', 'NC') THEN 15
                       WHEN sa.shift IN ('M', 'MWC') THEN 9
                       WHEN sa.shift IN ('N', 'NC') THEN 15
                       ELSE 0
                     END
                   )::numeric,
                   2
                 ) AS assigned_hours
            FROM shift_assignments sa
           WHERE sa.nurse_id = nph.nurse_id
             AND sa.shift_date BETWEEN nph.period_start AND nph.period_end
             AND sa.status = 'published'
        ) assigned ON TRUE
      ${where}
       ORDER BY nph.period_start DESC`;
    if (req.query.limit) {
      query += ` LIMIT $${params.length + 1}`;
      params.push(parseInt(req.query.limit, 10));
    }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  }),
);

router.post(
  "/upsert",
  requireCapability("manage_period_hours", ["admin", "cno", "hr_admin"]),
  wrap(async (req, res) => {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    if (!items.length) return res.status(400).json({ error: "Array required" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const item of items) {
        await client.query(
          `INSERT INTO nurse_period_hours (nurse_id, period_start, period_end, total_hours, total_shifts)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (nurse_id, period_start) DO UPDATE
         SET period_end = EXCLUDED.period_end, total_hours = EXCLUDED.total_hours, total_shifts = EXCLUDED.total_shifts`,
          [item.nurse_id, item.period_start, item.period_end, item.total_hours, item.total_shifts],
        );
      }
      await client.query("COMMIT");
      res.json({ success: true });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }),
);

module.exports = router;
