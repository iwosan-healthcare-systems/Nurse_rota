const router = require("express").Router();
const pool = require("../db");
const { requireRole } = require("../middleware/auth");
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ── Locum Requests ────────────────────────────────────────────

router.get(
  "/requests",
  wrap(async (req, res) => {
    const conditions = [];
    const params = [];

    if (req.query.status) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(req.query.status);
    }
    if (req.query.facility) {
      conditions.push(`facility = $${params.length + 1}`);
      params.push(req.query.facility);
    }
    if (req.query.requested_by) {
      conditions.push(`requested_by = $${params.length + 1}`);
      params.push(req.query.requested_by);
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
    if (req.query.accepted_by_nurse_id) {
      conditions.push(`accepted_by_nurse_id = $${params.length + 1}`);
      params.push(req.query.accepted_by_nurse_id);
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    let query = `SELECT * FROM locum_requests ${where} ORDER BY created_at DESC`;
    if (req.query.limit) {
      query += ` LIMIT $${params.length + 1}`;
      params.push(parseInt(req.query.limit, 10));
    }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  }),
);

router.post(
  "/requests",
  wrap(async (req, res) => {
    const {
      shift_date,
      shift,
      facility,
      ward,
      nurses_in_ward,
      ventilated_patients,
      hdu_nurses,
      requested_by,
      requested_by_name,
      role_needed,
    } = req.body;
    if (!shift_date || !shift || !facility || !ward || !requested_by || !requested_by_name)
      return res.status(400).json({ error: "Missing required fields" });

    const nursesNeeded = parseInt(req.body.nurses_needed, 10) || 1;
    const { rows } = await pool.query(
      `INSERT INTO locum_requests
     (shift_date, shift, facility, ward, nurses_in_ward, ventilated_patients, hdu_nurses, requested_by, requested_by_name, nurses_needed, role_needed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        shift_date,
        shift,
        facility,
        ward,
        nurses_in_ward || 0,
        ventilated_patients || 0,
        hdu_nurses || 0,
        requested_by,
        requested_by_name,
        nursesNeeded,
        role_needed || null,
      ],
    );
    res.status(201).json(rows[0]);
  }),
);

router.patch(
  "/requests/:id",
  requireRole("admin", "cno", "chief_matron"),
  wrap(async (req, res) => {
    const allowed = [
      "status",
      "reviewed_by",
      "reviewed_by_name",
      "reviewed_at",
      "decline_reason",
      "accepted_by_nurse_id",
      "accepted_by_nurse_name",
      "accepted_at",
      "nurses_needed",
      "role_needed",
      "updated_at",
    ];
    const fields = Object.keys(req.body).filter((k) => allowed.includes(k));
    if (!fields.length) return res.status(400).json({ error: "No valid fields to update" });

    const sets = fields.map((f, i) => `${f} = $${i + 1}`);
    sets.push("updated_at = NOW()");
    const values = fields.map((f) => req.body[f]);
    values.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE locum_requests SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    if (!rows[0]) return res.status(404).json({ error: "Locum request not found" });
    res.json(rows[0]);
  }),
);

// Atomic claim: supports nurses_needed > 1.
// Returns the updated request, or null if no spots remain.
// Checks accepted-invite count atomically so concurrent claims can't over-fill.
router.post(
  "/requests/:id/claim",
  wrap(async (req, res) => {
    // Derive nurse identity from the authenticated user — never trust the body for this.
    // Try profile_id first (direct link); fall back to name match and auto-save the link.
    let { rows: nurseRows } = await pool.query(
      "SELECT id, name FROM nurses WHERE profile_id = $1 LIMIT 1",
      [req.user.userId],
    );
    if (!nurseRows[0]) {
      const { rows: byName } = await pool.query(
        "SELECT id, name FROM nurses WHERE LOWER(name) = LOWER((SELECT full_name FROM profiles WHERE id = $1)) LIMIT 1",
        [req.user.userId],
      );
      if (byName[0]) {
        nurseRows = byName;
        pool.query("UPDATE nurses SET profile_id = $1 WHERE id = $2", [req.user.userId, byName[0].id]).catch(() => {});
      }
    }
    if (!nurseRows[0])
      return res.status(403).json({ error: "Nurse record not found for this account" });

    const { id: nurseId, name: nurseName } = nurseRows[0];

    // Single UPDATE that:
    //  1. Guards: request must still be open AND accepted count < nurses_needed
    //  2. Sets status to 'filled' only when this acceptance reaches nurses_needed
    //  3. Records the first acceptee (COALESCE preserves existing value for subsequent accepts)
    const { rows } = await pool.query(
      `UPDATE locum_requests
       SET status = CASE
             WHEN (SELECT COUNT(*) FROM locum_invites
                   WHERE locum_request_id = $3 AND status = 'accepted') + 1 >= nurses_needed
             THEN 'filled'
             ELSE 'invites_sent'
           END,
           accepted_by_nurse_id   = COALESCE(accepted_by_nurse_id, $1),
           accepted_by_nurse_name = COALESCE(accepted_by_nurse_name, $2),
           accepted_at            = COALESCE(accepted_at, NOW()),
           updated_at             = NOW()
       WHERE id = $3
         AND status = 'invites_sent'
         AND (SELECT COUNT(*) FROM locum_invites
              WHERE locum_request_id = $3 AND status = 'accepted') < nurses_needed
       RETURNING *`,
      [nurseId, nurseName, req.params.id],
    );
    res.json(rows[0] ?? null);
  }),
);

// ── Locum Invites ─────────────────────────────────────────────

router.get(
  "/invites",
  wrap(async (req, res) => {
    const conditions = [];
    const params = [];

    if (req.query.nurse_id) {
      conditions.push(`li.nurse_id = $${params.length + 1}`);
      params.push(req.query.nurse_id);
    }
    if (req.query.locum_request_id) {
      conditions.push(`li.locum_request_id = $${params.length + 1}`);
      params.push(req.query.locum_request_id);
    }
    if (req.query.status) {
      conditions.push(`li.status = $${params.length + 1}`);
      params.push(req.query.status);
    }
    if (req.query.facility) {
      conditions.push(`lr.facility = $${params.length + 1}`);
      params.push(req.query.facility);
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const { rows } = await pool.query(
      `SELECT li.*, row_to_json(lr.*) as locum_request
     FROM locum_invites li
     LEFT JOIN locum_requests lr ON lr.id = li.locum_request_id
     ${where} ORDER BY li.created_at DESC`,
      params,
    );
    res.json(rows);
  }),
);

router.post(
  "/invites",
  wrap(async (req, res) => {
    const invites = Array.isArray(req.body) ? req.body : [req.body];
    if (!invites.length) return res.status(400).json({ error: "Invite data required" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const results = [];
      for (const invite of invites) {
        const { rows } = await client.query(
          `INSERT INTO locum_invites (locum_request_id, nurse_id, nurse_name, status)
         VALUES ($1,$2,$3,$4) RETURNING *`,
          [invite.locum_request_id, invite.nurse_id, invite.nurse_name, invite.status || "pending"],
        );
        results.push(rows[0]);
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

// Bulk PATCH invites by filter (e.g. mark others unavailable after claim)
router.patch(
  "/invites",
  wrap(async (req, res) => {
    const conditions = [];
    const params = [];

    if (req.query.locum_request_id) {
      conditions.push(`locum_request_id = $${params.length + 1}`);
      params.push(req.query.locum_request_id);
    }
    if (req.query.status) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(req.query.status);
    }
    if (req.query.neq_id) {
      conditions.push(`id != $${params.length + 1}`);
      params.push(req.query.neq_id);
    }
    if (!conditions.length) return res.status(400).json({ error: "At least one filter required" });

    const allowed = ["status", "decline_reason", "responded_at"];
    const fields = Object.keys(req.body).filter((k) => allowed.includes(k));
    if (!fields.length) return res.status(400).json({ error: "No valid update fields" });

    const sets = fields.map((f, i) => `${f} = $${params.length + i + 1}`);
    const setValues = fields.map((f) => req.body[f]);

    await pool.query(
      `UPDATE locum_invites SET ${sets.join(", ")} WHERE ${conditions.join(" AND ")}`,
      [...params, ...setValues],
    );
    res.json({ success: true });
  }),
);

router.patch(
  "/invites/:id",
  wrap(async (req, res) => {
    const allowed = ["status", "decline_reason", "responded_at"];
    const fields = Object.keys(req.body).filter((k) => allowed.includes(k));
    if (!fields.length) return res.status(400).json({ error: "No valid fields to update" });

    const sets = fields.map((f, i) => `${f} = $${i + 1}`);
    const values = fields.map((f) => req.body[f]);
    values.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE locum_invites SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    if (!rows[0]) return res.status(404).json({ error: "Invite not found" });
    res.json(rows[0]);
  }),
);

module.exports = router;
