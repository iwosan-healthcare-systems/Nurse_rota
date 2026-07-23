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
    if (req.query.ward) {
      conditions.push(`ward = $${params.length + 1}`);
      params.push(req.query.ward);
    }
    if (req.query.status) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(req.query.status);
    }
    if (req.query.status_in) {
      const statuses = req.query.status_in.split(",");
      conditions.push(`status = ANY($${params.length + 1})`);
      params.push(statuses);
    }
    if (req.query.neq_status) {
      conditions.push(`status != $${params.length + 1}`);
      params.push(req.query.neq_status);
    }
    if (req.query.shift_date) {
      conditions.push(`shift_date = $${params.length + 1}`);
      params.push(req.query.shift_date);
    }
    if (req.query.from) {
      conditions.push(`shift_date >= $${params.length + 1}`);
      params.push(req.query.from);
    }
    if (req.query.to) {
      conditions.push(`shift_date <= $${params.length + 1}`);
      params.push(req.query.to);
    }
    if (req.query.nurse_ids) {
      const ids = req.query.nurse_ids.split(",");
      conditions.push(`nurse_id = ANY($${params.length + 1})`);
      params.push(ids);
    }
    if (req.query.shift) {
      conditions.push(`shift = $${params.length + 1}`);
      params.push(req.query.shift);
    }
    if (req.query.shift_in) {
      const shifts = req.query.shift_in.split(",");
      conditions.push(`shift = ANY($${params.length + 1})`);
      params.push(shifts);
    }
    if (req.query.ward_in) {
      const wards = req.query.ward_in.split(",");
      conditions.push(`ward = ANY($${params.length + 1})`);
      params.push(wards);
    }
    if (req.query.ward_null === "true") {
      conditions.push("ward IS NULL");
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    let query = `SELECT * FROM shift_assignments ${where} ORDER BY shift_date`;
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
  requireRole("admin", "head_nurse"),
  wrap(async (req, res) => {
    const { nurse_id, shift, shift_date, ward, status, created_by } = req.body;
    if (!nurse_id || !shift || !shift_date)
      return res.status(400).json({ error: "nurse_id, shift, shift_date required" });

    const { rows } = await pool.query(
      `INSERT INTO shift_assignments (nurse_id, shift, shift_date, ward, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [nurse_id, shift, shift_date, ward || null, status || "draft", created_by || null],
    );
    res.status(201).json(rows[0]);
  }),
);

// Batch upsert (onConflict: nurse_id, shift_date)
router.post(
  "/upsert",
  requireRole("admin", "head_nurse"),
  wrap(async (req, res) => {
    const rows = req.body;
    if (!Array.isArray(rows) || !rows.length)
      return res.status(400).json({ error: "Array of assignments required" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const row of rows) {
        await client.query(
          `INSERT INTO shift_assignments (nurse_id, shift, shift_date, ward, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (nurse_id, shift_date)
         DO UPDATE SET shift = EXCLUDED.shift, ward = EXCLUDED.ward, status = EXCLUDED.status, updated_at = NOW()`,
          [
            row.nurse_id,
            row.shift,
            row.shift_date,
            row.ward || null,
            row.status || "draft",
            row.created_by || null,
          ],
        );
      }

      // Re-apply approved leave over the freshly upserted shifts.
      // Approved leave may have been granted before this rota period existed, so
      // the approval's shift-flip found no rows to update at approval time.
      const nurseIds = [...new Set(rows.map((r) => r.nurse_id).filter(Boolean))];
      const dates = rows.map((r) => r.shift_date).filter(Boolean).sort();
      const minDate = dates[0];
      const maxDate = dates[dates.length - 1];
      await client.query(
        `UPDATE shift_assignments sa
            SET shift = 'LEAVE', updated_at = NOW()
          WHERE sa.nurse_id = ANY($1)
            AND sa.shift_date BETWEEN $2 AND $3
            AND sa.shift != 'LEAVE'
            AND EXISTS (
              SELECT 1 FROM leave_requests lr
              WHERE lr.nurse_id = sa.nurse_id
                AND lr.status = 'Approved'
                AND lr.type != 'Swap'
                AND sa.shift_date BETWEEN lr.from_date AND lr.to_date
            )`,
        [nurseIds, minDate, maxDate],
      );

      await client.query("COMMIT");
      res.json({ success: true, count: rows.length });
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
  requireRole("admin", "cno", "chief_matron", "head_nurse", "hr_admin"),
  wrap(async (req, res) => {
    const allowed = ["shift", "ward", "status", "shift_date"];
    const fields = Object.keys(req.body).filter((k) => allowed.includes(k));
    if (!fields.length) return res.status(400).json({ error: "No valid fields to update" });

    const sets = fields.map((f, i) => `${f} = $${i + 1}`);
    sets.push("updated_at = NOW()");
    const values = fields.map((f) => req.body[f]);
    values.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE shift_assignments SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    if (!rows[0]) return res.status(404).json({ error: "Assignment not found" });
    res.json(rows[0]);
  }),
);

// Batch update by filter
router.patch(
  "/",
  wrap(async (req, res) => {
    const {
      nurse_ids,
      shift_date_from,
      shift_date_to,
      ward,
      status: filterStatus,
      neq_status,
      shift: filterShift,
    } = req.query;
    const { shift, status, ward: newWard } = req.body;

    const userRoles = req.user?.roles || [];
    const isManager = userRoles.some((r) =>
      ["admin", "cno", "chief_matron", "head_nurse", "hr_admin"].includes(r),
    );
    if (!isManager) {
      // Self-service exception: a nurse accepting a bank/locum invite flips their
      // own OFF day to the locum shift type. Never allowed to touch status or ward,
      // or any nurse other than themselves.
      const LOCUM_SHIFT_CODES = ["M", "N", "MWC", "NC"];
      const ids = nurse_ids ? nurse_ids.split(",") : [];
      if (
        status ||
        newWard ||
        !shift ||
        !LOCUM_SHIFT_CODES.includes(shift) ||
        ids.length !== 1 ||
        filterShift !== "OFF"
      ) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const { rows: ownNurse } = await pool.query(
        `SELECT id FROM nurses WHERE profile_id = $1
         UNION ALL
         SELECT id FROM nurses WHERE profile_id IS NULL
           AND LOWER(name) = LOWER((SELECT full_name FROM profiles WHERE id = $1))
         LIMIT 1`,
        [req.user.userId],
      );
      if (!ownNurse[0] || ownNurse[0].id !== ids[0]) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    const conditions = [];
    const params = [];

    if (nurse_ids) {
      conditions.push(`nurse_id = ANY($${params.length + 1})`);
      params.push(nurse_ids.split(","));
    }
    if (shift_date_from) {
      conditions.push(`shift_date >= $${params.length + 1}`);
      params.push(shift_date_from);
    }
    if (shift_date_to) {
      conditions.push(`shift_date <= $${params.length + 1}`);
      params.push(shift_date_to);
    }
    if (ward) {
      conditions.push(`ward = $${params.length + 1}`);
      params.push(ward);
    }
    if (req.query.ward_null === "true") {
      conditions.push("ward IS NULL");
    }
    if (filterStatus) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(filterStatus);
    }
    if (neq_status) {
      conditions.push(`status != $${params.length + 1}`);
      params.push(neq_status);
    }
    if (filterShift) {
      conditions.push(`shift = $${params.length + 1}`);
      params.push(filterShift);
    }

    // ── Pre-submission: block if pending leaves exist for this period ────────
    if (status === "submitted" && filterStatus === "draft" && nurse_ids && shift_date_from && shift_date_to) {
      const nurseIdArr = nurse_ids.split(",");
      const { rows: pendingLeaves } = await pool.query(
        `SELECT lr.nurse_name, lr.type, lr.from_date::text, lr.to_date::text
           FROM leave_requests lr
          WHERE lr.nurse_id = ANY($1)
            AND lr.status = 'Pending'
            AND lr.type != 'Swap'
            AND lr.from_date <= $3
            AND lr.to_date >= $2`,
        [nurseIdArr, shift_date_from, shift_date_to],
      );

      if (pendingLeaves.length > 0) {
        // Notify chief matrons for the affected facility
        const { rows: facilityRows } = await pool.query(
          `SELECT DISTINCT facility FROM nurses WHERE id = ANY($1) AND facility IS NOT NULL`,
          [nurseIdArr],
        );
        for (const { facility } of facilityRows) {
          const notifKey = `pending_leave_check_${facility.toLowerCase().replace(/\s+/g, "_")}_${shift_date_from}`;
          // Notify chief matrons at this facility
          const { rows: matrons } = await pool.query(
            `SELECT DISTINCT p.id
               FROM profiles p
               JOIN user_roles ur ON ur.user_id = p.id AND ur.role = 'chief_matron'
               JOIN nurses n ON LOWER(n.name) = LOWER(p.full_name) AND n.facility = $1
              WHERE p.is_active = true`,
            [facility],
          );
          for (const { id } of matrons) {
            pool
              .query(
                `INSERT INTO notification_state (user_id, notif_key, is_read)
                 VALUES ($1, $2, false)
                 ON CONFLICT (user_id, notif_key) DO UPDATE SET is_read = false, updated_at = NOW()`,
                [id, notifKey],
              )
              .catch(() => {});
          }
          // Also notify head_nurse / admin so they know submission is blocked
          const { rows: generators } = await pool.query(
            `SELECT DISTINCT p.id
               FROM profiles p
               JOIN user_roles ur ON ur.user_id = p.id
              WHERE ur.role IN ('head_nurse', 'admin')
                AND p.is_active = true`,
          );
          for (const { id } of generators) {
            pool
              .query(
                `INSERT INTO notification_state (user_id, notif_key, is_read)
                 VALUES ($1, $2, false)
                 ON CONFLICT (user_id, notif_key) DO UPDATE SET is_read = false, updated_at = NOW()`,
                [id, notifKey],
              )
              .catch(() => {});
          }
        }

        return res.status(409).json({
          error: `Cannot submit: ${pendingLeaves.length} pending leave request${pendingLeaves.length > 1 ? "s" : ""} must be approved or rejected by the matron before the rota can be submitted.`,
          code: "PENDING_LEAVES_EXIST",
          pendingCount: pendingLeaves.length,
        });
      }
    }

    const sets = [];
    if (shift) {
      sets.push(`shift = $${params.length + 1}`);
      params.push(shift);
    }
    if (status) {
      sets.push(`status = $${params.length + 1}`);
      params.push(status);
    }
    if (newWard) {
      sets.push(`ward = $${params.length + 1}`);
      params.push(newWard);
    }
    sets.push("updated_at = NOW()");

    if (sets.length < 2 || !conditions.length)
      return res.status(400).json({ error: "Filters and update fields required" });

    const where = "WHERE " + conditions.join(" AND ");
    await pool.query(`UPDATE shift_assignments SET ${sets.join(", ")} ${where}`, params);
    res.json({ success: true });
  }),
);

// Bulk delete by filter (must come before /:id to avoid routing conflict)
router.delete(
  "/",
  requireRole("admin", "head_nurse"),
  wrap(async (req, res) => {
    const conditions = [];
    const params = [];

    if (req.query.nurse_ids) {
      conditions.push(`nurse_id = ANY($${params.length + 1})`);
      params.push(req.query.nurse_ids.split(","));
    }
    if (req.query.from) {
      conditions.push(`shift_date >= $${params.length + 1}`);
      params.push(req.query.from);
    }
    if (req.query.to) {
      conditions.push(`shift_date <= $${params.length + 1}`);
      params.push(req.query.to);
    }
    if (req.query.status) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(req.query.status);
    }
    if (req.query.neq_status) {
      conditions.push(`status != $${params.length + 1}`);
      params.push(req.query.neq_status);
    }

    if (!conditions.length)
      return res.status(400).json({ error: "At least one filter required for bulk delete" });

    const where = "WHERE " + conditions.join(" AND ");
    const result = await pool.query(`DELETE FROM shift_assignments ${where}`, params);
    res.json({ success: true, deleted: result.rowCount });
  }),
);

router.delete(
  "/:id",
  requireRole("admin", "cno", "chief_matron", "head_nurse", "hr_admin"),
  wrap(async (req, res) => {
    await pool.query("DELETE FROM shift_assignments WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  }),
);

// Re-apply approved leave to existing draft assignments (used by the "Regenerate" button).
// Flips any draft shift cell to LEAVE where the nurse has an approved leave overlapping that date.
router.post(
  "/reapply-leave",
  requireRole("admin", "head_nurse"),
  wrap(async (req, res) => {
    const { nurse_ids, from_date, to_date } = req.body;
    if (!Array.isArray(nurse_ids) || !nurse_ids.length || !from_date || !to_date)
      return res.status(400).json({ error: "nurse_ids, from_date, to_date required" });

    const { rowCount } = await pool.query(
      `UPDATE shift_assignments sa
          SET shift = 'LEAVE', updated_at = NOW()
        WHERE sa.nurse_id = ANY($1)
          AND sa.shift_date BETWEEN $2 AND $3
          AND sa.shift != 'LEAVE'
          AND EXISTS (
            SELECT 1 FROM leave_requests lr
            WHERE lr.nurse_id = sa.nurse_id
              AND lr.status = 'Approved'
              AND lr.type != 'Swap'
              AND sa.shift_date BETWEEN lr.from_date AND lr.to_date
          )`,
      [nurse_ids, from_date, to_date],
    );
    res.json({ success: true, updated: rowCount });
  }),
);

module.exports = router;
