const router = require("express").Router();
const pool = require("../db");
const { requireRole } = require("../middleware/auth");
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Map a nurse role string to the facility-wide group slug used in notification keys.
// Mirrors the isMatron / isGlobalHead / isPorterType / isInternType helpers on the frontend.
function facilityWideGroupSlug(role) {
  if (!role) return "facility_wide";
  if (/^matron$/i.test(role)) return "matron";
  if (/^(head|coverage)\s*nurse$/i.test(role)) return "head";
  if (/^porter(\s*-\s*day)?$/i.test(role)) return "porter";
  if (/nurse\s*intern|intern\s*nurse/i.test(role)) return "intern";
  return "facility_wide";
}

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
    // Batch-fetch by request id — used by the notification bell to resolve
    // details (nurse name, type, outcome) for a set of unread notif_keys
    // that each carry a leave_requests.id suffix.
    if (req.query.ids) {
      conditions.push(`lr.id = ANY($${params.length + 1})`);
      params.push(req.query.ids.split(","));
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
        p.full_name AS requested_by_name,
        rp.full_name AS reviewed_by_name
      FROM leave_requests lr
      LEFT JOIN nurses n ON lr.nurse_id = n.id
      LEFT JOIN profiles p ON p.id = lr.requested_by
      LEFT JOIN profiles rp ON rp.id = lr.reviewed_by
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
// Sick and Emergency can always be submitted; Swap is a shift switch (not leave).
const EXEMPT_LEAVE_TYPES = ["Sick", "Emergency", "Swap"];

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
    if (to_date < from_date) {
      return res.status(400).json({ error: "End date cannot be before the start date" });
    }

    // Block leave requests for dates where the nurse's rota is currently under review.
    if (type !== "Swap" && nurse_id) {
      const { rows: inApprovalRows } = await pool.query(
        `SELECT 1 FROM shift_assignments
          WHERE nurse_id = $1
            AND status IN ('submitted', 'hr_approved')
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
        `SELECT id, facility FROM nurses
          WHERE profile_id = $1
             OR LOWER(name) = LOWER((SELECT full_name FROM profiles WHERE id = $1))
          LIMIT 1`,
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
    // is_closed is computed against NOW() (Africa/Lagos) rather than a JS
    // date-string compare, so the window stays open through the whole of the
    // T-21 calendar day and only closes at 23:59:59 Lagos time that day —
    // not the instant that day begins.
    if (!EXEMPT_LEAVE_TYPES.includes(type)) {
      const { rows: pubRows } = await pool.query(`
        SELECT
          (MAX(shift_date::date) + 1)::text AS next_start,
          (
            (MAX(shift_date::date) + 1) > (NOW() AT TIME ZONE 'Africa/Lagos')::date
            AND NOW() >= ((MAX(shift_date::date) + 1 - INTERVAL '21 days') + INTERVAL '1 day')::timestamp AT TIME ZONE 'Africa/Lagos'
          ) AS is_closed
        FROM shift_assignments
        WHERE status = 'published'
      `);
      const nextStart = pubRows[0]?.next_start;
      const isClosed = pubRows[0]?.is_closed;
      if (isClosed) {
        return res.status(422).json({
          error: `Leave requests are closed until the next schedule begins (${nextStart}). Only Sick and Emergency Leave can be submitted now.`,
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

    // Capture the rota stage at the moment of request so reports can show
    // whether leave was requested before/after the rota was submitted or published.
    let rotaStageAtRequest = "no_rota";
    if (nurse_id) {
      const { rows: stageRows } = await pool.query(
        `SELECT CASE
           WHEN EXISTS (
             SELECT 1 FROM shift_assignments
             WHERE nurse_id = $1 AND shift_date BETWEEN $2 AND $3 AND status = 'published'
           ) THEN 'published'
           WHEN EXISTS (
             SELECT 1 FROM shift_assignments
             WHERE nurse_id = $1 AND shift_date BETWEEN $2 AND $3 AND status = 'draft'
           ) THEN 'draft'
           ELSE 'no_rota'
         END AS stage`,
        [nurse_id, from_date, to_date],
      );
      rotaStageAtRequest = stageRows[0]?.stage ?? "no_rota";
    }

    const { rows } = await pool.query(
      `INSERT INTO leave_requests (nurse_id, nurse_name, type, from_date, to_date, reason, requested_by, switch_nurse_b, rota_stage_at_request)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        nurse_id || null,
        nurse_name,
        type,
        from_date,
        to_date,
        reason || null,
        requested_by || null,
        switch_nurse_b || null,
        rotaStageAtRequest,
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
      // for every date in the leave window that already exists in shift_assignments —
      // including draft cells. Draft used to be excluded here, leaving the flip
      // to a manual "Regenerate" click on the Rota page (see reapply-leave in
      // shift-assignments.js, still there as a manual re-trigger / historical
      // catch-up path, and its UNAPPLIED_LEAVE_EXISTS submit-time guard, still
      // there as a defensive backstop). Draft rota status can't itself block
      // this: a leave request can only be Pending against a draft or published
      // rota in the first place (POST / here rejects new requests once the
      // rota is submitted/hr_approved), so by approval time the rota is either
      // still draft or already published — never mid-review.
      const leave = rows[0];
      let creditsToApply = [];
      if (
        leave.status === "Approved" &&
        leave.nurse_id &&
        leave.from_date &&
        leave.to_date &&
        leave.type !== "Swap"
      ) {
        const { rows: flippedRows } = await client.query(
          `UPDATE shift_assignments
              SET pre_leave_shift = shift,
                  shift = 'LEAVE'
            WHERE nurse_id = $1
              AND shift_date BETWEEN $2 AND $3
              AND shift != 'LEAVE'
            RETURNING shift_date, pre_leave_shift`,
          [leave.nurse_id, leave.from_date, leave.to_date],
        );
        const preShiftByDate = new Map(
          flippedRows.map((r) => [r.shift_date.toString().slice(0, 10), r.pre_leave_shift]),
        );

        // The nurse may currently be mid-shift when this leave is approved (e.g.
        // they fell sick and Sick Leave was approved right away) — auto-end any
        // active, un-ended shift_logs row in the leave window instead of leaving
        // it open for an admin to close manually.
        const { rows: endedRows } = await client.query(
          `UPDATE shift_logs
              SET ended_at = NOW(),
                  hours_logged = ROUND(EXTRACT(EPOCH FROM (NOW() - started_at)) / 3600 * 100) / 100
            WHERE nurse_id = $1
              AND shift_date BETWEEN $2 AND $3
              AND ended_at IS NULL
            RETURNING id, shift_date, hours_logged, is_locum, is_swap`,
          [leave.nurse_id, leave.from_date, leave.to_date],
        );

        for (const log of endedRows) {
          if (log.is_locum || log.is_swap) continue; // not a roster shift — leave doesn't top these up
          if (log.hours_logged > 0) creditsToApply.push({ hours: Number(log.hours_logged) });

          // Top up the rest of the shift as a separate leave-credit entry, so the
          // day totals the full shift's hours instead of just the partial time
          // she was actually clocked in for. This ALSO stops the auto-end-shifts
          // cron's own leave-credit pass from later inserting a second, full-value
          // credit for the same date — its guard only checks for an existing
          // is_leave = true row, so without this the day would get double-credited
          // (partial worked hours + a full separate shift's worth on top).
          const dateKey = log.shift_date.toString().slice(0, 10);
          const preShift = preShiftByDate.get(dateKey);
          if (!preShift) continue;
          const fullShiftHours = preShift === "N" || preShift === "NC" ? 15 : 9;
          const remaining = Math.round((fullShiftHours - Number(log.hours_logged)) * 100) / 100;
          if (remaining <= 0) continue;

          const isNight = preShift === "N" || preShift === "NC";
          const { rows: creditRows } = await client.query(
            `INSERT INTO shift_logs
               (nurse_id, shift_date, shift_type, started_at, expected_end_at, ended_at,
                period_start, hours_logged, is_leave, is_missed, is_locum, is_swap, leave_request_id)
             VALUES (
               $1, $2::date,
               CASE WHEN $3 THEN 'N' ELSE 'M' END,
               CASE WHEN $3 THEN ($2::date::timestamp + INTERVAL '17 hours') AT TIME ZONE 'Africa/Lagos'
                    ELSE ($2::date::timestamp + INTERVAL '8 hours') AT TIME ZONE 'Africa/Lagos' END,
               CASE WHEN $3 THEN ($2::date::timestamp + INTERVAL '1 day 8 hours') AT TIME ZONE 'Africa/Lagos'
                    ELSE ($2::date::timestamp + INTERVAL '17 hours') AT TIME ZONE 'Africa/Lagos' END,
               CASE WHEN $3 THEN ($2::date::timestamp + INTERVAL '1 day 8 hours') AT TIME ZONE 'Africa/Lagos'
                    ELSE ($2::date::timestamp + INTERVAL '17 hours') AT TIME ZONE 'Africa/Lagos' END,
               COALESCE(
                 (SELECT MIN(s2.shift_date) FROM shift_assignments s2
                   WHERE s2.status = 'published' AND s2.shift_date BETWEEN $2::date - 27 AND $2::date),
                 $2::date
               ),
               $4, true, false, false, false, $5
             )
             RETURNING hours_logged`,
            [leave.nurse_id, dateKey, isNight, remaining, leave.id],
          );
          creditsToApply.push({ hours: Number(creditRows[0].hours_logged) });
        }
      }

      await client.query("COMMIT");

      // Credit hours for the partial shift + its leave top-up computed above.
      for (const credit of creditsToApply) {
        await pool
          .query("SELECT increment_nurse_hours($1, $2)", [leave.nurse_id, credit.hours])
          .catch((err) =>
            console.error(
              `[leave-approval] auto-end hours increment failed for ${leave.nurse_id}:`,
              err.message,
            ),
          );
      }

      // After committing: if leave was approved or rejected, notify rota generators
      // (head_nurse / admin) when there are draft assignments in the same facility & period.
      if (
        (leave.status === "Approved" || leave.status === "Rejected") &&
        leave.nurse_id
      ) {
        pool
          .query("SELECT facility, role FROM nurses WHERE id = $1", [leave.nurse_id])
          .then(async ({ rows: nurseRows }) => {
            const facility = nurseRows[0]?.facility;
            const nurseRole = nurseRows[0]?.role || "";
            if (!facility) return;
            const facilitySlug = facility.toLowerCase().replace(/\s+/g, "_");

            // Approved leave is now flipped to LEAVE automatically above — no
            // "regenerate" prompt needed. A Rejected leave leaves the draft's
            // existing shift exactly as it was (nothing was ever flipped for a
            // Pending request), but the head_nurse may still want to know a
            // decision landed, e.g. to re-arrange cover they'd informally
            // planned around — so that ping stays for Rejected only.
            if (leave.status === "Rejected") {
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
              if (draftRows.length) {
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
                    : facilityWideGroupSlug(nurseRole);
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
              }
            }

            // If no pending leaves remain that overlap any draft rota in this facility,
            // clear all pending_leave_check notifications for everyone (matron + head_nurse/admin).
            const { rows: remainingPending } = await pool.query(
              `SELECT 1 FROM leave_requests lr
                WHERE lr.status = 'Pending'
                  AND lr.type != 'Swap'
                  AND lr.nurse_id IN (SELECT id FROM nurses WHERE facility = $1)
                  AND EXISTS (
                    SELECT 1 FROM shift_assignments sa
                    WHERE sa.nurse_id = lr.nurse_id
                      AND sa.status = 'draft'
                      AND sa.shift_date BETWEEN lr.from_date AND lr.to_date
                  )
                LIMIT 1`,
              [facility],
            );
            if (!remainingPending.length) {
              pool
                .query(
                  `UPDATE notification_state
                      SET is_read = true, updated_at = NOW()
                    WHERE notif_key LIKE $1
                      AND is_read = false`,
                  [`pending_leave_check_${facilitySlug}_%`],
                )
                .catch(() => {});
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
