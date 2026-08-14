const router = require("express").Router();
const pool = require("../db");
const { requireCapability, checkCapability } = require("../middleware/capability");
const { sendMail, portalUrl } = require("../lib/mailer");
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Mirrors leave-requests.js's facilityWideGroupSlug — maps a nurse's job role
// to the facility-wide role_group used on ward-less rota_edit_requests rows.
function roleGroupOf(role) {
  if (!role) return null;
  if (/^matron$/i.test(role)) return "matron";
  if (/^(head|coverage)\s*nurse$/i.test(role) || /^coverage\s*nurse\s*-\s*day$/i.test(role))
    return "head";
  if (/^porter(\s*-\s*day)?$/i.test(role)) return "porter";
  if (/nurse\s*intern|intern\s*nurse/i.test(role)) return "intern";
  return null;
}

const ROLE_GROUP_LABELS = {
  matron: "Matron",
  head: "Coverage Nurse",
  porter: "Porter",
  intern: "Nurse Intern",
};

function fmtPeriodDate(d) {
  return d
    ? new Date(String(d).slice(0, 10) + "T00:00:00").toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "";
}

// A head_nurse (not admin) may only create/update draft cells within a
// ward/facility-wide-group + period they currently hold an active edit-access
// grant for (see routes/rota-edit-requests.js). Admin bypasses (usual
// override); chief_matron isn't checked by name here, but no longer needs to
// be — they no longer hold the edit_rota/manage_shift_assignments
// capabilities this function's callers are gated behind in the first place,
// so they can't reach here at all. `cells` is an
// array of { nurse_id, ward, shift_date } — every cell must be covered by an
// active grant, or the whole request is rejected (no partial writes).
async function headNurseHasEditGrantForAll(req, cells) {
  const userRoles = req.user?.roles || [];
  if (userRoles.includes("admin") || !userRoles.includes("head_nurse")) return true;
  if (!cells.length) return true;

  const nurseIds = [...new Set(cells.map((c) => c.nurse_id).filter(Boolean))];
  if (!nurseIds.length) return false;
  const { rows: nurseRows } = await pool.query(
    "SELECT id, facility, role FROM nurses WHERE id = ANY($1)",
    [nurseIds],
  );
  const nurseById = new Map(nurseRows.map((n) => [n.id, n]));

  const { rows: grants } = await pool.query(
    `SELECT facility, ward, role_group, period_start, period_end
       FROM rota_edit_requests
      WHERE requested_by = $1 AND status = 'Approved' AND revoked_at IS NULL`,
    [req.user.userId],
  );

  return cells.every((cell) => {
    const nurse = nurseById.get(cell.nurse_id);
    if (!nurse) return false;
    const ward = cell.ward || null;
    const group = ward ? null : roleGroupOf(nurse.role);
    return grants.some(
      (g) =>
        g.facility === nurse.facility &&
        (ward ? g.ward === ward : g.role_group === group) &&
        cell.shift_date >= g.period_start &&
        cell.shift_date <= g.period_end,
    );
  });
}

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
  requireCapability("edit_shift_assignments", ["admin", "head_nurse"]),
  wrap(async (req, res) => {
    const { nurse_id, shift, shift_date, ward, status } = req.body;
    if (!nurse_id || !shift || !shift_date)
      return res.status(400).json({ error: "nurse_id, shift, shift_date required" });

    if (!(await headNurseHasEditGrantForAll(req, [{ nurse_id, ward, shift_date }]))) {
      return res.status(403).json({ error: "No active edit-access grant for this ward/period" });
    }

    // created_by/created_by_name come from the authenticated actor, not the
    // request body — trusting a client-supplied value would let anyone
    // attribute a cell to someone else.
    const { rows } = await pool.query(
      `INSERT INTO shift_assignments (nurse_id, shift, shift_date, ward, status, created_by, created_by_name, nurse_role)
     VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT role FROM nurses WHERE id = $1)) RETURNING *`,
      [
        nurse_id,
        shift,
        shift_date,
        ward || null,
        status || "draft",
        req.user?.userId ?? null,
        req.user?.full_name ?? null,
      ],
    );
    await reapplyApprovedLeave(pool, [nurse_id], shift_date, shift_date);
    const { rows: finalRows } = await pool.query("SELECT * FROM shift_assignments WHERE id = $1", [
      rows[0].id,
    ]);
    res.status(201).json(finalRows[0] ?? rows[0]);
  }),
);

// Re-applies approved (non-Swap) leave over shift_assignments rows for the
// given nurses/date range — corrects any cell that disagrees with an
// approved leave request back to LEAVE, regardless of how that cell got
// there. Shared by EVERY write path that can create or change a shift
// value (upsertAssignments, the single-row POST/PATCH, and the bulk filter
// PATCH below) specifically so this class of mismatch can't happen no
// matter which route touched the cell — previously only the batch
// upsert path had this, which is exactly how a leave/rota mismatch could
// still occur via a single manual edit (see fix-missing-leave-flips.js,
// now closed at the root instead of needing a periodic manual re-run).
// `queryable` is either the pool or a transaction client — both expose .query.
async function reapplyApprovedLeave(queryable, nurseIds, minDate, maxDate) {
  if (!nurseIds.length || !minDate || !maxDate) return;
  await queryable.query(
    `UPDATE shift_assignments sa
        SET pre_leave_shift = sa.shift, shift = 'LEAVE', updated_at = NOW(),
            leave_type = (
              SELECT lr.type FROM leave_requests lr
              WHERE lr.nurse_id = sa.nurse_id AND lr.status = 'Approved' AND lr.type != 'Swap'
                AND sa.shift_date BETWEEN lr.from_date AND lr.to_date
              LIMIT 1
            )
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
}

// Shared by both /upsert (normal draft editing, grant-checked) and
// /new-staff-upsert (grant-free — see that route for why) — same upsert +
// leave-reapply logic either way, they only differ in what's checked before
// this runs.
// `actor` is { id, name } of whoever triggered this — a real user for the
// manual routes below, or a 'System (auto-generated)'-style label with a
// null id for cron callers. created_by/created_by_name are only applied on
// first insert (preserved on conflict); updated_by/updated_by_name are
// stamped on every conflict, i.e. every re-generate/re-save of an existing
// cell.
async function upsertAssignments(rows, actor = { id: null, name: null }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      await client.query(
        `INSERT INTO shift_assignments
           (nurse_id, shift, shift_date, ward, status, created_by, created_by_name, nurse_role, pre_leave_shift, leave_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT role FROM nurses WHERE id = $1), $8, $9)
       ON CONFLICT (nurse_id, shift_date)
       DO UPDATE SET shift = EXCLUDED.shift, ward = EXCLUDED.ward, status = EXCLUDED.status,
         pre_leave_shift = EXCLUDED.pre_leave_shift, leave_type = EXCLUDED.leave_type, updated_at = NOW(),
         updated_by = $6, updated_by_name = $7`,
        [
          row.nurse_id,
          row.shift,
          row.shift_date,
          row.ward || null,
          row.status || "draft",
          actor.id,
          actor.name,
          row.pre_leave_shift || null,
          row.leave_type || null,
        ],
      );
    }

    // Re-apply approved leave over the freshly upserted shifts.
    // Approved leave may have been granted before this rota period existed, so
    // the approval's shift-flip found no rows to update at approval time.
    const nurseIds = [...new Set(rows.map((r) => r.nurse_id).filter(Boolean))];
    const dates = rows
      .map((r) => r.shift_date)
      .filter(Boolean)
      .sort();
    await reapplyApprovedLeave(client, nurseIds, dates[0], dates[dates.length - 1]);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Batch upsert (onConflict: nurse_id, shift_date)
router.post(
  "/upsert",
  requireCapability("edit_shift_assignments", ["admin", "head_nurse"]),
  wrap(async (req, res) => {
    const rows = req.body;
    if (!Array.isArray(rows) || !rows.length)
      return res.status(400).json({ error: "Array of assignments required" });

    if (
      !(await headNurseHasEditGrantForAll(
        req,
        rows.map((r) => ({ nurse_id: r.nurse_id, ward: r.ward, shift_date: r.shift_date })),
      ))
    ) {
      return res.status(403).json({ error: "No active edit-access grant for this ward/period" });
    }

    await upsertAssignments(rows, {
      id: req.user?.userId ?? null,
      name: req.user?.full_name ?? null,
    });
    res.json({ success: true, count: rows.length });
  }),
);

// Grant-free counterpart to /upsert, scoped strictly to staff who don't have
// a real schedule yet — the "new/reactivated staff mid-cycle" flow on the
// Rota page (Generate + Submit for one nurse). Accepting the auto-generated
// draft for someone who currently has nothing isn't "editing" in the sense
// the CNO edit-access-request system exists to gate (that's for hand-tuning
// an existing draft) — so it only needs the base edit_shift_assignments
// capability, same as /reapply-leave. The safety boundary that keeps this
// from becoming a backdoor around the grant check on everyone else's cells:
// every target (nurse_id, shift_date) must not already have a published row.
router.post(
  "/new-staff-upsert",
  requireCapability("edit_shift_assignments", ["admin", "head_nurse"]),
  wrap(async (req, res) => {
    const rows = req.body;
    if (!Array.isArray(rows) || !rows.length)
      return res.status(400).json({ error: "Array of assignments required" });

    const nurseIds = [...new Set(rows.map((r) => r.nurse_id).filter(Boolean))];
    const dates = rows.map((r) => r.shift_date).filter(Boolean);
    const { rows: publishedRows } = await pool.query(
      `SELECT nurse_id, shift_date::text FROM shift_assignments
        WHERE nurse_id = ANY($1) AND shift_date = ANY($2::date[]) AND status = 'published'`,
      [nurseIds, dates],
    );
    if (publishedRows.length) {
      return res.status(409).json({
        error: "One or more of these cells already has a published shift — can't touch it here.",
      });
    }

    await upsertAssignments(rows, {
      id: req.user?.userId ?? null,
      name: req.user?.full_name ?? null,
    });
    res.json({ success: true, count: rows.length });
  }),
);

router.patch(
  "/:id",
  requireCapability("manage_shift_assignments", ["admin", "cno", "head_nurse", "hr_admin"]),
  wrap(async (req, res) => {
    const allowed = ["shift", "ward", "status", "shift_date"];
    const fields = Object.keys(req.body).filter((k) => allowed.includes(k));
    if (!fields.length) return res.status(400).json({ error: "No valid fields to update" });

    const { rows: existingRows } = await pool.query(
      "SELECT nurse_id, ward, shift_date FROM shift_assignments WHERE id = $1",
      [req.params.id],
    );
    if (!existingRows[0]) return res.status(404).json({ error: "Assignment not found" });
    const existing = existingRows[0];
    if (
      !(await headNurseHasEditGrantForAll(req, [
        {
          nurse_id: existing.nurse_id,
          ward: req.body.ward ?? existing.ward,
          shift_date: existing.shift_date,
        },
      ]))
    ) {
      return res.status(403).json({ error: "No active edit-access grant for this ward/period" });
    }

    const sets = fields.map((f, i) => `${f} = $${i + 1}`);
    sets.push(
      `updated_by = $${fields.length + 1}`,
      `updated_by_name = $${fields.length + 2}`,
      "updated_at = NOW()",
    );
    const values = fields.map((f) => req.body[f]);
    values.push(req.user?.userId ?? null, req.user?.full_name ?? null, req.params.id);

    const { rows } = await pool.query(
      `UPDATE shift_assignments SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    if (!rows[0]) return res.status(404).json({ error: "Assignment not found" });

    if (fields.includes("shift") || fields.includes("shift_date")) {
      const affectedDate = req.body.shift_date ?? existing.shift_date;
      await reapplyApprovedLeave(pool, [existing.nurse_id], affectedDate, affectedDate);
      const { rows: finalRows } = await pool.query(
        "SELECT * FROM shift_assignments WHERE id = $1",
        [req.params.id],
      );
      return res.json(finalRows[0] ?? rows[0]);
    }
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

    if (status) {
      // A pipeline-stage transition — classify the exact (status, filterStatus)
      // pair being requested and gate it with the capability for THAT
      // transition specifically, rather than one coarse "is some kind of
      // manager" check. This is what makes "only head_nurse can submit" (not
      // cno/chief_matron/hr_admin, who could previously submit too) and "only
      // HR approves" actually enforceable server-side.
      let capKey;
      let capFallback;
      if (status === "submitted" && filterStatus === "draft") {
        capKey = "submit_approval";
        capFallback = ["admin", "head_nurse"];
      } else if (status === "cno_approved" && filterStatus === "submitted") {
        capKey = "approve_rota";
        capFallback = ["admin", "cno"];
      } else if (
        status === "draft" &&
        (filterStatus === "submitted" || filterStatus === "cno_approved")
      ) {
        // Reject-to-draft — same capability as approving forward at that stage.
        capKey = "approve_rota";
        capFallback = ["admin", "cno"];
      } else if (status === "published" && filterStatus === "cno_approved") {
        capKey = "publish_rota";
        capFallback = ["admin", "cno"];
      } else if (status === "draft" && filterStatus === "published") {
        capKey = "revert_published";
        capFallback = ["admin"];
      } else {
        return res.status(400).json({ error: "Unsupported status transition" });
      }
      const allowed = await checkCapability(req, capKey, capFallback);
      if (!allowed) return res.status(403).json({ error: "Forbidden" });
    } else {
      // No status change requested — either a manager bulk-editing shift/ward,
      // or the nurse self-service exception below.
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
    if (
      status === "submitted" &&
      filterStatus === "draft" &&
      nurse_ids &&
      shift_date_from &&
      shift_date_to
    ) {
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

    // ── Pre-submission: block if approved leave hasn't been reflected on the draft rota yet ────────
    // Leave approved while these cells were still draft never gets auto-flipped to
    // LEAVE (see routes/leave-requests.js's "AND status != 'draft'" guard) — only a
    // "Regenerate" click (POST /shift-assignments/reapply-leave) fixes it. Without
    // this check, that step was purely advisory (a dismissible-only-by-fixing
    // notification) and nothing stopped the rota from being submitted with the
    // stale shift still showing, which is how approved leave silently failed to
    // reach the rota in the first place.
    if (
      status === "submitted" &&
      filterStatus === "draft" &&
      nurse_ids &&
      shift_date_from &&
      shift_date_to
    ) {
      const nurseIdArr = nurse_ids.split(",");
      const { rows: unflippedLeaves } = await pool.query(
        `SELECT DISTINCT lr.id, lr.nurse_name, lr.type, lr.from_date::text, lr.to_date::text
           FROM shift_assignments sa
           JOIN leave_requests lr
             ON lr.nurse_id = sa.nurse_id
            AND lr.status = 'Approved'
            AND lr.type != 'Swap'
            AND sa.shift_date BETWEEN lr.from_date AND lr.to_date
          WHERE sa.nurse_id = ANY($1)
            AND sa.status = 'draft'
            AND sa.shift != 'LEAVE'
            AND sa.shift_date BETWEEN $2 AND $3`,
        [nurseIdArr, shift_date_from, shift_date_to],
      );

      if (unflippedLeaves.length > 0) {
        return res.status(409).json({
          error: `Cannot submit: ${unflippedLeaves.length} approved leave request${unflippedLeaves.length > 1 ? "s haven't" : " hasn't"} been reflected on the rota yet. Click "Regenerate" for the affected ward, then submit again.`,
          code: "UNAPPLIED_LEAVE_EXISTS",
          unflippedCount: unflippedLeaves.length,
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

    if (!sets.length || !conditions.length)
      return res.status(400).json({ error: "Filters and update fields required" });

    sets.push(`updated_by = $${params.length + 1}`, `updated_by_name = $${params.length + 2}`);
    params.push(req.user?.userId ?? null, req.user?.full_name ?? null);
    sets.push("updated_at = NOW()");

    const where = "WHERE " + conditions.join(" AND ");
    await pool.query(`UPDATE shift_assignments SET ${sets.join(", ")} ${where}`, params);

    // A manager bulk-editing shift values (not a status transition) can hit
    // the same class of mismatch a single edit can — re-apply approved leave
    // over whatever range this touched. Skipped for the self-service locum-
    // accept exception too (harmless either way: that path only ever fires
    // from an OFF cell, which can't coexist with approved leave — see the
    // guard above requiring filterShift === "OFF" — approved leave already
    // flips a cell to LEAVE regardless of status).
    if (shift && nurse_ids && shift_date_from && shift_date_to) {
      await reapplyApprovedLeave(pool, nurse_ids.split(","), shift_date_from, shift_date_to);
    }

    // Publishing spends any edit-access grant that was open for this unit —
    // a grant that was live pre-publish (e.g. for finishing the original
    // draft) shouldn't silently keep working for something that comes up
    // after the rota is already live (e.g. hand-tuning a new staff member's
    // auto-generated shifts). A fresh request is always required post-publish.
    if (
      status === "published" &&
      filterStatus === "cno_approved" &&
      nurse_ids &&
      shift_date_from &&
      shift_date_to
    ) {
      const nurseIdArr = nurse_ids.split(",");
      const { rows: nurseRows } = await pool.query(
        `SELECT DISTINCT facility, role FROM nurses WHERE id = ANY($1) AND facility IS NOT NULL`,
        [nurseIdArr],
      );
      const facilities = [...new Set(nurseRows.map((n) => n.facility))];
      const roleGroup = ward ? null : roleGroupOf(nurseRows[0]?.role);
      for (const facility of facilities) {
        pool
          .query(
            `UPDATE rota_edit_requests
                SET revoked_at = NOW()
              WHERE facility = $1
                AND status = 'Approved' AND revoked_at IS NULL
                AND (($2::text IS NOT NULL AND ward = $2) OR ($2::text IS NULL AND ward IS NULL AND role_group = $3))
                AND period_start <= $5 AND period_end >= $4`,
            [facility, ward || null, roleGroup, shift_date_from, shift_date_to],
          )
          .catch(() => {});
      }
    }

    // HR reject-to-draft: notify the head_nurse/admin for this unit. Was a
    // gap before — this transition wrote nothing, so a returned submission
    // gave no bell notification at all (the exception-carve-out in
    // rota-edit-requests.js for re-requesting edit access is the only place
    // that assumed this event existed).
    if (
      status === "draft" &&
      (filterStatus === "submitted" || filterStatus === "cno_approved") &&
      nurse_ids
    ) {
      const nurseIdArr = nurse_ids.split(",");
      const { rows: nurseRows } = await pool.query(
        `SELECT DISTINCT facility, role FROM nurses WHERE id = ANY($1) AND facility IS NOT NULL`,
        [nurseIdArr],
      );
      const facilities = [...new Set(nurseRows.map((n) => n.facility))];
      const unitLabel = ward || roleGroupOf(nurseRows[0]?.role) || "rota";
      const periodStart = shift_date_from ?? "";
      for (const facility of facilities) {
        const facilitySlug = facility.toLowerCase().replace(/\s+/g, "_");
        const unitSlug = String(unitLabel).toLowerCase().replace(/\s+/g, "_");
        // "|" separates facility/unit/period — see jobs/auto-generate-rota.js's
        // notifyUnit() for why a plain "_" join can't be parsed back reliably.
        const notifKey = `rota_hr_rejected_${facilitySlug}|${unitSlug}|${periodStart}`;
        const { rows: recipients } = await pool.query(
          `SELECT DISTINCT p.id
             FROM profiles p
             JOIN user_roles ur ON ur.user_id = p.id
            WHERE ur.role IN ('head_nurse', 'admin') AND p.is_active = true`,
        );
        for (const { id } of recipients) {
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

    // Email the next actor (or, for publish, everyone with a stake) for a
    // manual rota pipeline transition — the automatic equivalents (T-17
    // auto-submit, T-14 auto-publish) send their own emails from their cron
    // jobs, since they don't go through this endpoint at all.
    if (status && nurse_ids) {
      let recipientRoles = null;
      let subject = null;
      let bodyHtml = null;
      let ctaPath = "/rota";
      if (status === "submitted" && filterStatus === "draft") {
        recipientRoles = ["cno"];
        subject = "Rota submitted for review";
        ctaPath = "/approvals";
      } else if (status === "cno_approved" && filterStatus === "submitted") {
        recipientRoles = ["cno"];
        subject = "Rota approved — ready to publish";
        ctaPath = "/approvals";
      } else if (status === "published" && filterStatus === "cno_approved") {
        recipientRoles = ["head_nurse", "cno", "admin"];
        subject = "Rota published";
        ctaPath = "/rota";
      } else if (
        status === "draft" &&
        (filterStatus === "submitted" || filterStatus === "cno_approved")
      ) {
        recipientRoles = ["head_nurse"];
        subject = "Rota returned to draft — changes needed";
        ctaPath = "/rota";
      }

      if (recipientRoles) {
        (async () => {
          const nurseIdArr = nurse_ids.split(",");
          const { rows: nurseRows } = await pool.query(
            `SELECT DISTINCT facility, role FROM nurses WHERE id = ANY($1) AND facility IS NOT NULL`,
            [nurseIdArr],
          );
          if (!nurseRows.length) return;
          const facilities = [...new Set(nurseRows.map((n) => n.facility))];
          const unitLabel =
            ward || ROLE_GROUP_LABELS[roleGroupOf(nurseRows[0]?.role)] || "the rota";
          const periodLabel = fmtPeriodDate(shift_date_from);

          bodyHtml = `<p>The rota for <strong>${unitLabel}</strong> (${facilities.join(", ")}), period starting ${periodLabel}, ${
            status === "submitted"
              ? "has been submitted and is awaiting CNO approval."
              : status === "cno_approved"
                ? "has been approved and is ready to publish."
                : status === "published"
                  ? "has been published."
                  : "has been returned to draft — changes are needed before resubmitting."
          }</p>`;

          for (const role of recipientRoles) {
            const { rows: recipients } = await pool.query(
              `SELECT DISTINCT p.id, p.email FROM profiles p
                 JOIN user_roles ur ON ur.user_id = p.id AND ur.role = $1
                WHERE p.is_active = true`,
              [role],
            );
            for (const { email } of recipients) {
              sendMail({
                to: email,
                subject: `${subject} — ${unitLabel}`,
                title: subject,
                bodyHtml,
                ctaText: ctaPath === "/approvals" ? "Open Approvals" : "Open Rota",
                ctaUrl: portalUrl(ctaPath),
              }).catch(() => {});
            }
          }

          // Publishing is the one event every staff nurse in the unit cares
          // about, not just managers — everyone whose schedule just went live
          // gets their own copy, separate from the manager email above.
          if (status === "published") {
            const { rows: staffEmails } = await pool.query(
              `SELECT DISTINCT COALESCE(
                 (SELECT p.email FROM profiles p WHERE p.id = n.profile_id),
                 (SELECT p.email FROM profiles p WHERE LOWER(p.full_name) = LOWER(n.name) LIMIT 1)
               ) AS email
               FROM nurses n WHERE n.id = ANY($1)`,
              [nurseIdArr],
            );
            for (const { email } of staffEmails) {
              if (!email) continue;
              sendMail({
                to: email,
                subject: `Your rota is published — ${unitLabel}`,
                title: "Your rota is published",
                bodyHtml: `<p>The rota for <strong>${unitLabel}</strong> (${facilities.join(", ")}), period starting ${periodLabel}, has been published. You can view your schedule now.</p>`,
                ctaText: "View My Rota",
                ctaUrl: portalUrl("/rota"),
              }).catch(() => {});
            }
          }
        })().catch(() => {});
      }
    }

    res.json({ success: true });
  }),
);

// Bulk delete by filter (must come before /:id to avoid routing conflict)
router.delete(
  "/",
  requireCapability("edit_shift_assignments", ["admin", "head_nurse"]),
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
  requireCapability("manage_shift_assignments", ["admin", "cno", "head_nurse", "hr_admin"]),
  wrap(async (req, res) => {
    await pool.query("DELETE FROM shift_assignments WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  }),
);

// Re-apply approved leave to existing draft assignments (used by the "Regenerate" button).
// Flips any draft shift cell to LEAVE where the nurse has an approved leave overlapping that date.
router.post(
  "/reapply-leave",
  requireCapability("edit_shift_assignments", ["admin", "head_nurse"]),
  wrap(async (req, res) => {
    const { nurse_ids, from_date, to_date } = req.body;
    if (!Array.isArray(nurse_ids) || !nurse_ids.length || !from_date || !to_date)
      return res.status(400).json({ error: "nurse_ids, from_date, to_date required" });

    const { rowCount } = await pool.query(
      `UPDATE shift_assignments sa
          SET pre_leave_shift = sa.shift, shift = 'LEAVE', updated_at = NOW(),
              leave_type = (
                SELECT lr.type FROM leave_requests lr
                WHERE lr.nurse_id = sa.nurse_id AND lr.status = 'Approved' AND lr.type != 'Swap'
                  AND sa.shift_date BETWEEN lr.from_date AND lr.to_date
                LIMIT 1
              )
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
