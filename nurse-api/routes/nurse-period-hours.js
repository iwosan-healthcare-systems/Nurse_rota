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
      conditions.push(`nurse_id = $${params.length + 1}`);
      params.push(req.query.nurse_id);
    }
    if (req.query.period_start) {
      conditions.push(`period_start = $${params.length + 1}`);
      params.push(req.query.period_start);
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    let query = `SELECT * FROM nurse_period_hours ${where} ORDER BY period_start DESC`;
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
