const router = require("express").Router();
const pool = require("../db");
const { requireCapability } = require("../middleware/capability");
const { sendMail, portalUrl } = require("../lib/mailer");
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function fmtShiftDate(d) {
  return new Date(String(d).slice(0, 10) + "T00:00:00").toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

async function activeProfilesWithRole(role) {
  const { rows } = await pool.query(
    `SELECT DISTINCT p.id, p.email FROM profiles p
       JOIN user_roles ur ON ur.user_id = p.id AND ur.role = $1
      WHERE p.is_active = true`,
    [role],
  );
  return rows;
}

async function profileEmail(userId) {
  if (!userId) return null;
  const { rows } = await pool.query("SELECT email FROM profiles WHERE id = $1", [userId]);
  return rows[0]?.email ?? null;
}

// Resolves a nurses.id to their login profile email — same COALESCE chain
// (profile_id link, then name match) used throughout the jobs/routes that
// need to email a specific nurse.
async function nurseEmail(nurseId) {
  if (!nurseId) return null;
  const { rows } = await pool.query(
    `SELECT COALESCE(
       (SELECT p.email FROM nurses n JOIN profiles p ON p.id = n.profile_id WHERE n.id = $1),
       (SELECT p.email FROM nurses n JOIN profiles p ON LOWER(p.full_name) = LOWER(n.name) WHERE n.id = $1 LIMIT 1)
     ) AS email`,
    [nurseId],
  );
  return rows[0]?.email ?? null;
}

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
    // Batch-fetch by request id — used by the notification bell to resolve
    // details (ward, shift, accepting nurse) for a set of unread notif_keys
    // that each carry a locum_requests.id suffix.
    if (req.query.ids) {
      conditions.push(`id = ANY($${params.length + 1})`);
      params.push(req.query.ids.split(","));
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
  requireCapability("request_locum", ["admin", "chief_matron"]),
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
    const created = rows[0];
    res.status(201).json(created);

    (async () => {
      const cnoProfiles = await activeProfilesWithRole("cno");
      for (const { email } of cnoProfiles) {
        sendMail({
          to: email,
          subject: `New locum shift request — ${created.ward}`,
          title: "New locum shift request",
          bodyHtml: `<p><strong>${created.requested_by_name}</strong> requested a ${created.shift} locum shift for <strong>${created.ward}</strong> · ${created.facility} on ${fmtShiftDate(created.shift_date)}.</p>`,
          ctaText: "Review Request",
          ctaUrl: portalUrl("/locum"),
        }).catch(() => {});
      }
    })().catch(() => {});
  }),
);

router.patch(
  "/requests/:id",
  requireCapability("review_locum_request", ["admin", "cno", "chief_matron"]),
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
    const updated = rows[0];
    res.json(updated);

    if (fields.includes("status") && (updated.status === "approved" || updated.status === "declined")) {
      (async () => {
        const email = await profileEmail(updated.requested_by);
        if (!email) return;
        const approved = updated.status === "approved";
        sendMail({
          to: email,
          subject: `Locum request ${approved ? "approved" : "declined"} — ${updated.ward}`,
          title: `Locum request ${approved ? "approved" : "declined"}`,
          bodyHtml: approved
            ? `<p>Your locum request for <strong>${updated.ward}</strong> · ${updated.shift} on ${fmtShiftDate(updated.shift_date)} was approved. Send invites to off-duty nurses to fill it.</p>`
            : `<p>Your locum request for <strong>${updated.ward}</strong> · ${updated.shift} on ${fmtShiftDate(updated.shift_date)} was declined${updated.decline_reason ? ` — "${updated.decline_reason}"` : ""}.</p>`,
          ctaText: "Open Bank Shift (Locum)",
          ctaUrl: portalUrl("/locum"),
        }).catch(() => {});
      })().catch(() => {});
    }
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
    const updated = rows[0] ?? null;
    res.json(updated);

    if (updated?.status === "filled") {
      (async () => {
        const recipientIds = new Set();
        if (updated.requested_by) recipientIds.add(updated.requested_by);
        if (updated.reviewed_by) recipientIds.add(updated.reviewed_by);
        if (recipientIds.size) {
          const { rows: recipients } = await pool.query("SELECT email FROM profiles WHERE id = ANY($1)", [
            [...recipientIds],
          ]);
          for (const { email } of recipients) {
            sendMail({
              to: email,
              subject: `Locum shift filled — ${updated.ward}`,
              title: "Locum shift filled",
              bodyHtml: `<p><strong>${nurseName}</strong> accepted the ${updated.shift} locum shift for <strong>${updated.ward}</strong> on ${fmtShiftDate(updated.shift_date)}.</p>`,
              ctaText: "Open Bank Shift (Locum)",
              ctaUrl: portalUrl("/locum"),
            }).catch(() => {});
          }
        }

        // Other nurses whose invite for this request is now moot.
        const { rows: others } = await pool.query(
          `SELECT DISTINCT li.nurse_id FROM locum_invites li
            WHERE li.locum_request_id = $1 AND li.status = 'pending'`,
          [req.params.id],
        );
        for (const { nurse_id } of others) {
          const email = await nurseEmail(nurse_id);
          if (!email) continue;
          sendMail({
            to: email,
            subject: `Locum shift filled — ${updated.ward}`,
            title: "Locum shift already filled",
            bodyHtml: `<p>The ${updated.shift} locum shift for <strong>${updated.ward}</strong> on ${fmtShiftDate(updated.shift_date)} you were invited to has been filled by someone else.</p>`,
            ctaUrl: portalUrl("/locum"),
          }).catch(() => {});
        }
      })().catch(() => {});
    }
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
    // Batch-fetch by invite id — used by the notification bell to resolve
    // details for unread locum_flip_failed_ notif_keys.
    if (req.query.ids) {
      conditions.push(`li.id = ANY($${params.length + 1})`);
      params.push(req.query.ids.split(","));
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
  requireCapability("send_locum_invites", ["admin", "chief_matron"]),
  wrap(async (req, res) => {
    const invites = Array.isArray(req.body) ? req.body : [req.body];
    if (!invites.length) return res.status(400).json({ error: "Invite data required" });

    const deduped = [];
    const seen = new Set();
    for (const invite of invites) {
      if (!invite?.locum_request_id || !invite?.nurse_id) continue;
      const key = `${invite.locum_request_id}:${invite.nurse_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push({
        ...invite,
        status: invite.status || "pending",
      });
    }

    if (!deduped.length) return res.status(400).json({ error: "No valid invites to send" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const requestIds = [...new Set(deduped.map((invite) => invite.locum_request_id))];
      for (const requestId of requestIds) {
        const { rows: requestRows } = await client.query(
          `UPDATE locum_requests
           SET status = 'invites_sent', updated_at = NOW()
           WHERE id = $1 AND status IN ('approved', 'invites_sent')
           RETURNING *`,
          [requestId],
        );
        if (!requestRows[0]) {
          throw new Error(`Locum request ${requestId} is not in an invite-sending state`);
        }
      }

      const results = [];
      for (const invite of deduped) {
        const { rows } = await client.query(
          `INSERT INTO locum_invites (locum_request_id, nurse_id, nurse_name, status)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (locum_request_id, nurse_id) DO NOTHING
         RETURNING *`,
          [invite.locum_request_id, invite.nurse_id, invite.nurse_name, invite.status],
        );
        if (rows[0]) results.push(rows[0]);
      }
      await client.query("COMMIT");
      res.status(201).json(results);

      (async () => {
        if (!results.length) return;
        // Invites in one batch usually share a request, but resolve per unique
        // id rather than assume — small batches, negligible extra cost.
        const requestIds = [...new Set(results.map((r) => r.locum_request_id))];
        const { rows: reqRows } = await pool.query(
          "SELECT * FROM locum_requests WHERE id = ANY($1)",
          [requestIds],
        );
        const reqById = new Map(reqRows.map((r) => [r.id, r]));
        for (const invite of results) {
          const lr = reqById.get(invite.locum_request_id);
          if (!lr) continue;
          const email = await nurseEmail(invite.nurse_id);
          if (!email) continue;
          sendMail({
            to: email,
            subject: `Locum shift invite — ${lr.ward}`,
            title: "You've been invited to a locum shift",
            bodyHtml: `<p>You've been invited to cover a ${lr.shift} locum shift for <strong>${lr.ward}</strong> · ${lr.facility} on ${fmtShiftDate(lr.shift_date)}.</p>`,
            ctaText: "Respond to Invite",
            ctaUrl: portalUrl("/locum"),
          }).catch(() => {});
        }
      })().catch(() => {});
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }),
);

// Bulk PATCH invites by filter (e.g. mark others unavailable after claim).
// Only callable by a manager, or by the nurse who just filled this request
// (proven by holding an accepted invite for it) — otherwise any authenticated
// user could invalidate other nurses' pending invites for a shift they never claimed.
router.patch(
  "/invites",
  wrap(async (req, res) => {
    if (!req.query.locum_request_id)
      return res.status(400).json({ error: "locum_request_id required" });

    const userRoles = req.user?.roles || [];
    const isManager = userRoles.some((r) => ["admin", "cno", "chief_matron"].includes(r));
    if (!isManager) {
      const { rows: claimRows } = await pool.query(
        `SELECT 1 FROM locum_invites li
         WHERE li.locum_request_id = $1 AND li.status = 'accepted'
           AND li.nurse_id = COALESCE(
             (SELECT id FROM nurses WHERE profile_id = $2 LIMIT 1),
             (SELECT id FROM nurses WHERE LOWER(name) = LOWER((SELECT full_name FROM profiles WHERE id = $2)) LIMIT 1)
           )
         LIMIT 1`,
        [req.query.locum_request_id, req.user.userId],
      );
      if (!claimRows[0]) return res.status(403).json({ error: "Forbidden" });
    }

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

    // A nurse may only accept/decline their own invite. Managers can override.
    const userRoles = req.user?.roles || [];
    const isManager = userRoles.some((r) => ["admin", "cno", "chief_matron"].includes(r));
    if (!isManager) {
      const { rows: inviteRows } = await pool.query(
        "SELECT nurse_id FROM locum_invites WHERE id = $1",
        [req.params.id],
      );
      if (!inviteRows[0]) return res.status(404).json({ error: "Invite not found" });

      let { rows: nurseRows } = await pool.query(
        "SELECT id FROM nurses WHERE profile_id = $1 LIMIT 1",
        [req.user.userId],
      );
      if (!nurseRows[0]) {
        nurseRows = (
          await pool.query(
            "SELECT id FROM nurses WHERE LOWER(name) = LOWER((SELECT full_name FROM profiles WHERE id = $1)) LIMIT 1",
            [req.user.userId],
          )
        ).rows;
      }
      if (!nurseRows[0] || nurseRows[0].id !== inviteRows[0].nurse_id) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

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
