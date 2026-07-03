const router = require("express").Router();
const pool = require("../db");
const { requireRole } = require("../middleware/auth");
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Must be before GET / to avoid conflict
router.get(
  "/current",
  wrap(async (req, res) => {
    const { nurse_id, shift_date } = req.query;
    if (!nurse_id || !shift_date)
      return res.status(400).json({ error: "nurse_id and shift_date required" });
    const { rows } = await pool.query(
      `SELECT * FROM shift_logs
     WHERE nurse_id = $1 AND is_leave = false
     AND (ended_at IS NULL OR shift_date = $2)
     ORDER BY started_at DESC LIMIT 1`,
      [nurse_id, shift_date],
    );
    res.json(rows[0] ?? null);
  }),
);

router.get(
  "/",
  wrap(async (req, res) => {
    const conditions = [];
    const params = [];

    if (req.query.nurse_id) {
      conditions.push(`nurse_id = $${params.length + 1}`);
      params.push(req.query.nurse_id);
    }
    if (req.query.shift_date) {
      conditions.push(`shift_date = $${params.length + 1}`);
      params.push(req.query.shift_date);
    }
    if (req.query.shift_date_in) {
      const dates = req.query.shift_date_in.split(",");
      conditions.push(`shift_date = ANY($${params.length + 1})`);
      params.push(dates);
    }
    if (req.query.from) {
      conditions.push(`shift_date >= $${params.length + 1}`);
      params.push(req.query.from);
    }
    if (req.query.to) {
      conditions.push(`shift_date <= $${params.length + 1}`);
      params.push(req.query.to);
    }
    if (req.query.period_start) {
      conditions.push(`period_start = $${params.length + 1}`);
      params.push(req.query.period_start);
    }
    if (req.query.ended_at_null === "true") {
      conditions.push("ended_at IS NULL");
    }
    if (req.query.ended_at_not_null === "true") {
      conditions.push("ended_at IS NOT NULL");
    }
    if (req.query.is_locum === "true") {
      conditions.push("is_locum = true");
    } else if (req.query.is_locum === "false") {
      conditions.push("is_locum = false");
    }
    if (req.query.hours_not_null === "true") {
      conditions.push("hours_logged IS NOT NULL");
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    let query = `SELECT * FROM shift_logs ${where} ORDER BY started_at DESC`;
    if (req.query.limit) {
      query += ` LIMIT $${params.length + 1}`;
      params.push(parseInt(req.query.limit, 10));
    }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  }),
);

router.post(
  "/",
  wrap(async (req, res) => {
    const {
      nurse_id,
      shift_date,
      shift_type,
      started_at,
      expected_end_at,
      period_start,
      is_late,
      late_minutes,
      late_reason,
      latitude,
      longitude,
      ip_address,
      is_locum,
      locum_request_id,
      is_swap,
      swap_note,
      is_leave,
      leave_request_id,
    } = req.body;

    if (!shift_date || !shift_type || !started_at || !expected_end_at || !period_start)
      return res.status(400).json({ error: "Missing required fields" });

    // Admins/CNO can log shifts for any nurse; other users can only log their own
    const userRoles = req.user?.roles || [];
    const isAdmin = userRoles.some((r) => ["admin", "cno"].includes(r));
    let resolvedNurseId = nurse_id;
    if (!isAdmin) {
      const { rows: nurseRows } = await pool.query(
        "SELECT id FROM nurses WHERE name = (SELECT full_name FROM profiles WHERE id = $1) LIMIT 1",
        [req.user.userId],
      );
      if (!nurseRows[0])
        return res.status(403).json({ error: "Nurse record not found for this account" });
      resolvedNurseId = nurseRows[0].id;
    }
    if (!resolvedNurseId) return res.status(400).json({ error: "nurse_id required" });

    const { rows } = await pool.query(
      `INSERT INTO shift_logs
     (nurse_id, shift_date, shift_type, started_at, expected_end_at, period_start,
      is_late, late_minutes, late_reason, latitude, longitude, ip_address,
      is_locum, locum_request_id, is_swap, swap_note, is_leave, leave_request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *`,
      [
        resolvedNurseId,
        shift_date,
        shift_type,
        started_at,
        expected_end_at,
        period_start,
        is_late || false,
        late_minutes || null,
        late_reason || null,
        latitude || null,
        longitude || null,
        ip_address || null,
        is_locum || false,
        locum_request_id || null,
        is_swap || false,
        swap_note || null,
        is_leave || false,
        leave_request_id || null,
      ],
    );
    res.status(201).json(rows[0]);
  }),
);

// Bulk insert shift logs (used for leave approval)
router.post(
  "/bulk",
  requireRole("admin", "cno", "chief_matron", "hr_admin"),
  wrap(async (req, res) => {
    const rows = Array.isArray(req.body) ? req.body : [req.body];
    if (!rows.length) return res.status(400).json({ error: "Array of shift logs required" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const results = [];
      for (const row of rows) {
        const { rows: inserted } = await client.query(
          `INSERT INTO shift_logs
         (nurse_id, shift_date, shift_type, started_at, expected_end_at, period_start,
          is_leave, leave_request_id, hours_logged, ended_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT DO NOTHING
         RETURNING *`,
          [
            row.nurse_id,
            row.shift_date,
            row.shift_type || "LEAVE",
            row.started_at,
            row.expected_end_at,
            row.period_start,
            row.is_leave || true,
            row.leave_request_id || null,
            row.hours_logged || null,
            row.ended_at || null,
          ],
        );
        if (inserted[0]) results.push(inserted[0]);
      }
      await client.query("COMMIT");
      res.status(201).json(results);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }),
);

router.patch(
  "/:id",
  wrap(async (req, res) => {
    const allowed = ["ended_at", "hours_logged", "is_late", "late_minutes", "late_reason"];
    const fields = Object.keys(req.body).filter((k) => allowed.includes(k));
    if (!fields.length) return res.status(400).json({ error: "No valid fields to update" });

    const userRoles = req.user?.roles || [];
    const isAdmin = userRoles.some((r) => ["admin", "cno"].includes(r));

    const sets = fields.map((f, i) => `${f} = $${i + 1}`);
    const values = fields.map((f) => req.body[f]);
    values.push(req.params.id);

    let query;
    if (isAdmin) {
      query = `UPDATE shift_logs SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING *`;
    } else {
      // Enforce ownership: only update if the shift log belongs to this user's nurse record
      values.push(req.user.userId);
      query = `UPDATE shift_logs SET ${sets.join(", ")}
      WHERE id = $${values.length - 1}
      AND nurse_id = (SELECT id FROM nurses WHERE name = (SELECT full_name FROM profiles WHERE id = $${values.length}) LIMIT 1)
      RETURNING *`;
    }

    const { rows } = await pool.query(query, values);
    if (!rows[0]) return res.status(404).json({ error: "Shift log not found or access denied" });
    res.json(rows[0]);
  }),
);

module.exports = router;
