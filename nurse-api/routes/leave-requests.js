const router = require("express").Router();
const pool = require("../db");
const { requireRole } = require("../middleware/auth");
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
    if (req.query.status) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(req.query.status);
    }
    // from_date >= value
    if (req.query.from) {
      conditions.push(`from_date >= $${params.length + 1}`);
      params.push(req.query.from);
    }
    // to_date <= value
    if (req.query.to) {
      conditions.push(`to_date <= $${params.length + 1}`);
      params.push(req.query.to);
    }
    // to_date >= value (rota: leaves not yet finished before cutoff)
    if (req.query.to_date_gte) {
      conditions.push(`to_date >= $${params.length + 1}`);
      params.push(req.query.to_date_gte);
    }
    // from_date <= value (overlap: leave started on or before end of period)
    if (req.query.from_date_lte) {
      conditions.push(`from_date <= $${params.length + 1}`);
      params.push(req.query.from_date_lte);
    }
    if (req.query.type) {
      conditions.push(`type = $${params.length + 1}`);
      params.push(req.query.type);
    }
    if (req.query.requested_by) {
      conditions.push(`requested_by = $${params.length + 1}`);
      params.push(req.query.requested_by);
    }
    if (req.query.switch_nurse_b) {
      conditions.push(`switch_nurse_b = $${params.length + 1}`);
      params.push(req.query.switch_nurse_b);
    }
    if (req.query.nurse_ids) {
      const ids = req.query.nurse_ids.split(",");
      conditions.push(`nurse_id = ANY($${params.length + 1})`);
      params.push(ids);
    }
    if (req.query.from_date) {
      conditions.push(`from_date = $${params.length + 1}`);
      params.push(req.query.from_date);
    }
    if (req.query.reason_like) {
      conditions.push(`reason LIKE $${params.length + 1}`);
      params.push(req.query.reason_like + "%");
    }
    // Filter to only leave requests belonging to nurses at a specific facility.
    if (req.query.facility) {
      conditions.push(`nurse_id IN (SELECT id FROM nurses WHERE facility = $${params.length + 1})`);
      params.push(req.query.facility);
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    let query = `SELECT * FROM leave_requests ${where} ORDER BY created_at DESC`;
    if (req.query.limit) {
      query += ` LIMIT $${params.length + 1}`;
      params.push(parseInt(req.query.limit, 10));
    }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  }),
);

// Leave types exempt from the 21-day pre-period closure window.
// Sick, Emergency, Maternity, and Leave of Absence can always be submitted; Swap is a shift switch (not leave).
const EXEMPT_LEAVE_TYPES = ["Sick", "Emergency", "Maternity", "Swap", "Leave of Absence"];

router.post(
  "/",
  wrap(async (req, res) => {
    const { nurse_id, nurse_name, type, from_date, to_date, reason, requested_by, switch_nurse_b } =
      req.body;
    if (!nurse_name || !type || !from_date || !to_date)
      return res.status(400).json({ error: "Missing required fields" });

    // ── Leave closure window enforcement ──────────────────────────────────
    // Once the first rota has been published, all non-exempt leave types are
    // blocked for 21 days leading up to the next schedule period start date.
    if (!EXEMPT_LEAVE_TYPES.includes(type)) {
      const { rows: pubRows } = await pool.query(`
        SELECT
          (MAX(shift_date::date) + 1)::text                             AS next_start,
          (MAX(shift_date::date) + 1 - INTERVAL '21 days')::date::text AS closure_date
        FROM shift_assignments
        WHERE status = 'published'
      `);
      const nextStart = pubRows[0]?.next_start;
      const closureDate = pubRows[0]?.closure_date;
      const today = new Date().toISOString().slice(0, 10);
      // Only enforce when the next period is still in the future
      if (nextStart && closureDate && nextStart > today && today >= closureDate) {
        return res.status(422).json({
          error: `Leave requests are closed until the next schedule begins (${nextStart}). Only Sick, Emergency, Maternity, and Leave of Absence can be submitted now.`,
          code: "LEAVE_WINDOW_CLOSED",
        });
      }
    }

    // Block duplicate/overlapping requests for the same nurse (Pending or Approved only).
    // Swap-type shift switches are exempt — a nurse may legitimately have multiple switch rows.
    if (type !== "Swap" && nurse_name) {
      const overlapParams = [nurse_name, from_date, to_date];
      const idClause = nurse_id ? ` AND (nurse_id = $4 OR nurse_name = $1)` : ` AND nurse_name = $1`;
      if (nurse_id) overlapParams.push(nurse_id);
      const { rows: existing } = await pool.query(
        `SELECT id FROM leave_requests
          WHERE status IN ('Pending', 'Approved')
            AND from_date <= $3 AND to_date >= $2
            ${idClause}
          LIMIT 1`,
        overlapParams,
      );
      if (existing.length > 0) {
        return res.status(409).json({
          error: "A leave request already exists for those dates. Cancel or update the existing request first.",
        });
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO leave_requests (nurse_id, nurse_name, type, from_date, to_date, reason, requested_by, switch_nurse_b)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        nurse_id || null,
        nurse_name,
        type,
        from_date,
        to_date,
        reason || null,
        requested_by || null,
        switch_nurse_b || null,
      ],
    );
    res.status(201).json(rows[0]);
  }),
);

router.patch(
  "/:id",
  wrap(async (req, res) => {
    const userRoles = req.user?.roles || [];
    const isManager = userRoles.some((r) =>
      ["admin", "cno", "chief_matron", "hr_admin"].includes(r),
    );

    const managerOnlyFields = ["status", "reviewed_by", "reviewed_at", "review_note"];
    if (!isManager && Object.keys(req.body).some((k) => managerOnlyFields.includes(k))) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const allowed = isManager
      ? [
          "status",
          "reviewed_by",
          "reviewed_at",
          "review_note",
          "from_date",
          "to_date",
          "reason",
          "type",
        ]
      : ["from_date", "to_date", "reason", "type"];
    const fields = Object.keys(req.body).filter((k) => allowed.includes(k));
    if (!fields.length) return res.status(400).json({ error: "No valid fields to update" });

    const sets = fields.map((f, i) => `${f} = $${i + 1}`);
    const values = fields.map((f) => req.body[f]);
    values.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE leave_requests SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    if (!rows[0]) return res.status(404).json({ error: "Leave request not found" });
    res.json(rows[0]);
  }),
);

module.exports = router;
