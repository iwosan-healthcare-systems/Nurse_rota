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
      conditions.push(`lr.nurse_id = $${params.length + 1}`);
      params.push(req.query.nurse_id);
    }
    if (req.query.status) {
      conditions.push(`lr.status = $${params.length + 1}`);
      params.push(req.query.status);
    }
    // from_date >= value
    if (req.query.from) {
      conditions.push(`lr.from_date >= $${params.length + 1}`);
      params.push(req.query.from);
    }
    // to_date <= value
    if (req.query.to) {
      conditions.push(`lr.to_date <= $${params.length + 1}`);
      params.push(req.query.to);
    }
    // to_date >= value (rota: leaves not yet finished before cutoff)
    if (req.query.to_date_gte) {
      conditions.push(`lr.to_date >= $${params.length + 1}`);
      params.push(req.query.to_date_gte);
    }
    // from_date <= value (overlap: leave started on or before end of period)
    if (req.query.from_date_lte) {
      conditions.push(`lr.from_date <= $${params.length + 1}`);
      params.push(req.query.from_date_lte);
    }
    if (req.query.type) {
      conditions.push(`lr.type = $${params.length + 1}`);
      params.push(req.query.type);
    }
    if (req.query.requested_by) {
      conditions.push(`lr.requested_by = $${params.length + 1}`);
      params.push(req.query.requested_by);
    }
    if (req.query.switch_nurse_b) {
      conditions.push(`lr.switch_nurse_b = $${params.length + 1}`);
      params.push(req.query.switch_nurse_b);
    }
    if (req.query.nurse_ids) {
      const ids = req.query.nurse_ids.split(",");
      conditions.push(`lr.nurse_id = ANY($${params.length + 1})`);
      params.push(ids);
    }
    if (req.query.from_date) {
      conditions.push(`lr.from_date = $${params.length + 1}`);
      params.push(req.query.from_date);
    }
    if (req.query.reason_like) {
      conditions.push(`lr.reason LIKE $${params.length + 1}`);
      params.push(req.query.reason_like + "%");
    }
    // Filter to only leave requests belonging to nurses at a specific facility.
    if (req.query.facility) {
      conditions.push(`lr.nurse_id IN (SELECT id FROM nurses WHERE facility = $${params.length + 1})`);
      params.push(req.query.facility);
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    // Include the nurse's system role so the frontend can route approval correctly
    // (chief_matron leave → CNO approves; all others → chief_matron approves).
    // We prefer user_roles (authoritative) over nurses.role (may be stale/mis-entered).
    let query = `
      SELECT lr.*,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM user_roles ur
            WHERE ur.user_id = n.profile_id AND ur.role = 'chief_matron'
          ) THEN 'chief_matron'
          ELSE COALESCE(n.role, '')
        END AS nurse_role,
        p.full_name AS requested_by_name
      FROM leave_requests lr
      LEFT JOIN nurses n ON lr.nurse_id = n.id
      LEFT JOIN profiles p ON p.id = lr.requested_by
      ${where}
      ORDER BY lr.created_at DESC`;
    if (req.query.limit) {
      query += ` LIMIT $${params.length + 1}`;
      params.push(parseInt(req.query.limit, 10));
    }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  }),
);

// Leave types exempt from the 21-day pre-period closure window.
// Sick, Emergency, and Compassionate Leave can always be submitted; Swap is a shift switch (not leave).
const EXEMPT_LEAVE_TYPES = ["Sick", "Emergency", "Compassionate Leave", "Swap"];

// Roles allowed to create a shift-switch (type "Swap") on someone else's behalf.
// Mirrors canRequestShiftSwitch in auth-context.tsx (admin bypass is implicit via requireRole-style check below).
const SWITCH_INITIATOR_ROLES = ["admin", "cno", "chief_matron"];

router.post(
  "/",
  wrap(async (req, res) => {
    const { nurse_id, nurse_name, type, from_date, to_date, reason, requested_by, switch_nurse_b } =
      req.body;
    if (!nurse_name || !type || !from_date || !to_date)
      return res.status(400).json({ error: "Missing required fields" });

    const today = new Date().toISOString().slice(0, 10);
    if (from_date < today) {
      return res.status(400).json({ error: "Cannot submit a request for past dates" });
    }

    // Block leave requests for dates where the nurse's rota is currently under review.
    if (type !== "Swap" && nurse_id) {
      const { rows: inApprovalRows } = await pool.query(
        `SELECT 1 FROM shift_assignments
          WHERE nurse_id = $1
            AND status IN ('submitted', 'approved_chief', 'approved_cno')
            AND shift_date BETWEEN $2 AND $3
          LIMIT 1`,
        [nurse_id, from_date, to_date],
      );
      if (inApprovalRows.length > 0) {
        return res.status(422).json({
          error:
            "The rota for this period is currently under review. Leave requests cannot be submitted until after the rota is published.",
          code: "ROTA_IN_APPROVAL",
        });
      }
    }

    // ── Ownership / initiator enforcement ─────────────────────────────────
    // A "Swap" (shift switch) may be raised by a manager on another nurse's
    // behalf. Every other leave type is self-service — except Chief Matron,
    // who may submit leave for a staff member in her own facility (e.g. the
    // staff member is unable to submit it themselves at that time).
    const userRoles = req.user?.roles || [];
    const isPrivileged = userRoles.some((r) => SWITCH_INITIATOR_ROLES.includes(r));
    if (type === "Swap") {
      if (!isPrivileged) return res.status(403).json({ error: "Forbidden" });
    } else if (!userRoles.includes("admin") && !userRoles.includes("cno") && nurse_id) {
      const { rows: ownNurse } = await pool.query(
        "SELECT id, facility FROM nurses WHERE name = (SELECT full_name FROM profiles WHERE id = $1) LIMIT 1",
        [req.user.userId],
      );
      const own = ownNurse[0];
      const isSelf = own && own.id === nurse_id;
      if (!isSelf) {
        if (!own || !userRoles.includes("chief_matron")) {
          return res.status(403).json({ error: "Forbidden" });
        }
        const { rows: targetRows } = await pool.query(
          "SELECT facility FROM nurses WHERE id = $1",
          [nurse_id],
        );
        if (!targetRows[0] || targetRows[0].facility !== own.facility) {
          return res.status(403).json({ error: "Forbidden" });
        }
      }
    }

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
          error: `Leave requests are closed until the next schedule begins (${nextStart}). Only Sick, Emergency, and Compassionate Leave can be submitted now.`,
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

    // Non-managers may only edit a Pending leave request they personally submitted.
    if (!isManager) {
      const { rows: existing } = await pool.query(
        "SELECT status, requested_by FROM leave_requests WHERE id = $1",
        [req.params.id],
      );
      if (!existing[0]) return res.status(404).json({ error: "Leave request not found" });
      if (existing[0].status !== "Pending") {
        return res.status(400).json({ error: "Only pending requests can be edited" });
      }
      if (existing[0].requested_by !== req.user.userId) {
        return res.status(403).json({ error: "Forbidden" });
      }
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

    // Wrap the leave update + shift flip in a single transaction so they
    // never end up in a split state (approved leave with un-flipped shifts).
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query(
        `UPDATE leave_requests SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING *`,
        values,
      );
      if (!rows[0]) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Leave request not found" });
      }

      // When a leave request is approved, flip the nurse's shift cells to LEAVE
      // for every date in the leave window that already exists in shift_assignments.
      const leave = rows[0];
      if (
        leave.status === "Approved" &&
        leave.nurse_id &&
        leave.from_date &&
        leave.to_date &&
        leave.type !== "Swap"
      ) {
        await client.query(
          `UPDATE shift_assignments
              SET shift = 'LEAVE'
            WHERE nurse_id = $1
              AND shift_date BETWEEN $2 AND $3
              AND shift != 'LEAVE'`,
          [leave.nurse_id, leave.from_date, leave.to_date],
        );
      }

      await client.query("COMMIT");

      // After committing: if leave was approved or rejected, notify rota generators
      // (head_nurse / admin) when there are draft assignments in the same facility & period.
      if (
        (leave.status === "Approved" || leave.status === "Rejected") &&
        leave.nurse_id
      ) {
        pool
          .query("SELECT facility FROM nurses WHERE id = $1", [leave.nurse_id])
          .then(async ({ rows: nurseRows }) => {
            const facility = nurseRows[0]?.facility;
            if (!facility) return;
            // Find draft assignments for THIS specific nurse, grouped by ward.
            // A nurse may appear in multiple wards (rare) or in facility-wide (ward = null).
            const { rows: draftRows } = await pool.query(
              `SELECT sa.ward, MIN(sa.shift_date)::text AS period_start
                 FROM shift_assignments sa
                WHERE sa.nurse_id = $1
                  AND sa.status = 'draft'
                  AND EXISTS (
                    SELECT 1 FROM shift_assignments sa2
                     WHERE sa2.nurse_id = sa.nurse_id
                       AND sa2.status = 'draft'
                       AND sa2.ward IS NOT DISTINCT FROM sa.ward
                       AND sa2.shift_date BETWEEN $2 AND $3
                  )
                GROUP BY sa.ward`,
              [leave.nurse_id, leave.from_date, leave.to_date],
            );
            if (!draftRows.length) return;
            const facilitySlug = facility.toLowerCase().replace(/\s+/g, "_");
            // Notify all head_nurse and admin profiles
            const { rows: generators } = await pool.query(
              `SELECT DISTINCT p.id
                 FROM profiles p
                 JOIN user_roles ur ON ur.user_id = p.id
                WHERE ur.role IN ('head_nurse', 'admin')
                  AND p.is_active = true`,
            );
            for (const draftRow of draftRows) {
              const wardSlug = draftRow.ward
                ? draftRow.ward.toLowerCase().replace(/\s+/g, "_")
                : "facility_wide";
              const notifKey = `rota_regenerate_needed_${facilitySlug}_${draftRow.period_start}_${wardSlug}`;
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
          })
          .catch(() => {});
      }

      res.json(leave);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }),
);

module.exports = router;
