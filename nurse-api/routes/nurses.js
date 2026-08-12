const router = require("express").Router();
const pool = require("../db");
const { requireCapability } = require("../middleware/capability");
const { resolveUnitNurseIds, roleGroupOf } = require("../lib/force-submit-rota");
const { getUnitPeriod } = require("../lib/rota-period-dates");
const { sendMail, portalUrl } = require("../lib/mailer");
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const ROLE_GROUP_LABELS = {
  matron: "Matron",
  head: "Coverage Nurse",
  porter: "Porter",
  intern: "Nurse Intern",
};

// Notifies head_nurse/chief_matron/admin when a newly-created nurse lands in
// a ward or facility-wide role group that already has a rota cycle in
// progress (draft/submitted/hr_approved/published) — otherwise they'd have
// no shifts until someone happens to notice on the Rota page. Skipped for a
// facility with no rota history at all yet (getUnitPeriod returns null) —
// ordinary full-facility generation covers that case already.
async function notifyNewStaff(nurse) {
  if (!nurse.facility) return;
  const group = roleGroupOf(nurse.role);
  const ward = nurse.ward && !group ? nurse.ward : null;

  const nurseIds = await resolveUnitNurseIds({ facility: nurse.facility, ward, roleGroup: group });
  if (!nurseIds.length) return;

  const period = await getUnitPeriod(nurseIds, ward);
  if (!period) return;

  const unitLabel = ward ?? (group ? ROLE_GROUP_LABELS[group] : null) ?? "Facility-wide staff";
  const unitSlug = ward ? ward.toLowerCase().replace(/\s+/g, "_") : (group ?? "facility_wide");
  const facilitySlug = nurse.facility.toLowerCase().replace(/\s+/g, "_");
  // "|" separator, same reason as notifyUnit() in auto-generate-rota.js — a
  // plain "_" join can't be split back apart reliably since facility and
  // ward names can themselves contain "_".
  const notifKey = `rota_new_staff_${facilitySlug}|${unitSlug}|${period.periodStart}`;

  const { rows: recipients } = await pool.query(
    `SELECT DISTINCT p.id, p.email, ur.role
       FROM profiles p
       JOIN user_roles ur ON ur.user_id = p.id
      WHERE ur.role IN ('head_nurse', 'chief_matron', 'admin')
        AND p.is_active = true`,
  );
  if (!recipients.length) return;

  const headNurseAction = period.hasActive
    ? "Generate a draft schedule for them from the Rota page — it'll go through the normal review process with the rest of the ward."
    : "Click Generate for them on the Rota page, then Submit — this publishes directly since the rest of the ward is already live.";

  for (const { id, email, role: recipientRole } of recipients) {
    pool
      .query(
        `INSERT INTO notification_state (user_id, notif_key, is_read)
         VALUES ($1, $2, false)
         ON CONFLICT (user_id, notif_key) DO UPDATE SET is_read = false, updated_at = NOW()`,
        [id, notifKey],
      )
      .catch(() => {});

    if (!email) continue;
    const isHeadNurse = recipientRole === "head_nurse";
    sendMail({
      to: email,
      subject: `New staff added — ${unitLabel} · ${nurse.facility}`,
      title: "New staff added to the rota",
      bodyHtml: isHeadNurse
        ? `<p><strong>${nurse.name}</strong> was added to <strong>${unitLabel} · ${nurse.facility}</strong> mid-cycle (period starting ${period.periodStart}). They have no shifts scheduled yet.</p><p>${headNurseAction}</p>`
        : `<p><strong>${nurse.name}</strong> was added to <strong>${unitLabel} · ${nurse.facility}</strong> mid-cycle (period starting ${period.periodStart}). They have no shifts scheduled yet — the head nurse has been notified to generate and submit their schedule.</p>`,
      ctaText: "Open Rota",
      ctaUrl: portalUrl("/rota"),
    }).catch(() => {});
  }
}

router.get(
  "/",
  wrap(async (req, res) => {
    let query = "SELECT * FROM nurses";
    const params = [];
    const conditions = [];

    // Exclude deactivated nurses unless the caller explicitly requests them
    if (req.query.include_inactive !== "true") {
      conditions.push("is_active = true");
    }

    if (req.query.ward) {
      conditions.push(`ward = $${params.length + 1}`);
      params.push(req.query.ward);
    }
    if (req.query.facility) {
      conditions.push(`facility = $${params.length + 1}`);
      params.push(req.query.facility);
    }
    if (req.query.id) {
      conditions.push(`id = $${params.length + 1}`);
      params.push(req.query.id);
    }

    if (conditions.length) query += " WHERE " + conditions.join(" AND ");
    query += " ORDER BY name";

    const { rows } = await pool.query(query, params);
    res.json(rows);
  }),
);

router.get(
  "/:id",
  wrap(async (req, res) => {
    const { rows } = await pool.query("SELECT * FROM nurses WHERE id = $1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Nurse not found" });
    res.json(rows[0]);
  }),
);

router.post(
  "/",
  requireCapability("manage_staff", ["admin", "hr_admin"]),
  wrap(async (req, res) => {
    const { name, email, role, facility, ward, employee_id } = req.body;
    if (!name) return res.status(400).json({ error: "Name is required" });

    const { rows } = await pool.query(
      `INSERT INTO nurses (name, email, role, facility, ward, employee_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name, email || null, role || "nurse", facility || null, ward || null, employee_id || null],
    );
    res.status(201).json(rows[0]);
    notifyNewStaff(rows[0]).catch(() => {});
  }),
);

// Bulk insert nurses
router.post(
  "/bulk",
  requireCapability("manage_staff", ["admin", "hr_admin"]),
  wrap(async (req, res) => {
    const nurses = Array.isArray(req.body) ? req.body : [req.body];
    if (!nurses.length) return res.status(400).json({ error: "Array of nurses required" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const results = [];
      for (const n of nurses) {
        if (!n.name) continue;
        const { rows } = await client.query(
          `INSERT INTO nurses (name, email, role, facility, ward, employee_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [
            n.name,
            n.email || null,
            n.role || "nurse",
            n.facility || null,
            n.ward || null,
            n.employee_id || null,
          ],
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

// Reset hours_this_month to 0 for a list of nurse IDs (or all if no ids given)
router.patch(
  "/reset-hours",
  requireCapability("manage_staff", ["admin", "hr_admin"]),
  wrap(async (req, res) => {
    const { nurse_ids } = req.body;
    if (nurse_ids && Array.isArray(nurse_ids) && nurse_ids.length) {
      await pool.query(
        "UPDATE nurses SET hours_this_month = 0, updated_at = NOW() WHERE id = ANY($1)",
        [nurse_ids],
      );
    } else {
      await pool.query("UPDATE nurses SET hours_this_month = 0, updated_at = NOW()");
    }
    res.json({ success: true });
  }),
);

// Bulk update target_hours for all nurses
router.patch(
  "/bulk-target-hours",
  requireCapability("manage_staff", ["admin", "hr_admin"]),
  wrap(async (req, res) => {
    const { target_hours } = req.body;
    if (target_hours == null) return res.status(400).json({ error: "target_hours required" });
    await pool.query("UPDATE nurses SET target_hours = $1, updated_at = NOW()", [target_hours]);
    res.json({ success: true });
  }),
);

router.patch(
  "/:id",
  requireCapability("edit_nurse_record", ["admin", "hr_admin", "head_nurse"]),
  wrap(async (req, res) => {
    const userRoles = req.user?.roles || [];
    const isHR = userRoles.some((r) => ["admin", "hr_admin"].includes(r));
    // head_nurse can only update the ward field (used for intern rotation during schedule generation)
    const allowed = isHR
      ? [
          "name",
          "email",
          "role",
          "facility",
          "ward",
          "employee_id",
          "hours_this_month",
          "target_hours",
          "certifications",
          "profile_id",
        ]
      : ["ward"];
    // Nurses in facility-wide roles (Coverage/Head Nurse incl. the Day variant,
    // Interns, Porters) must never carry a ward. Enforce this server-side so
    // historical data or direct-DB edits can't leave stale wards.
    const NO_WARD_ROLE =
      /^(head|coverage)\s*nurse$|^coverage\s*nurse\s*-\s*day$|^intern\s*nurse$|^nurse\s*intern$|^porter(\s*-\s*day)?$/i;
    if (req.body.role && NO_WARD_ROLE.test(req.body.role)) {
      req.body.ward = null;
    }

    const fields = Object.keys(req.body).filter((k) => allowed.includes(k));
    if (!fields.length) return res.status(400).json({ error: "No valid fields to update" });

    const sets = fields.map((f, i) => `${f} = $${i + 1}`);
    sets.push(`updated_at = NOW()`);
    const values = fields.map((f) => req.body[f]);
    values.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE nurses SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    if (!rows[0]) return res.status(404).json({ error: "Nurse not found" });

    // Keep the linked login account in sync when name or email changes.
    const nurse = rows[0];
    if (nurse.profile_id && (fields.includes("name") || fields.includes("email"))) {
      await pool.query(
        `UPDATE profiles
         SET full_name  = COALESCE($1, full_name),
             email      = COALESCE(lower($2), email),
             updated_at = NOW()
         WHERE id = $3`,
        [
          fields.includes("name") ? nurse.name : null,
          fields.includes("email") ? nurse.email : null,
          nurse.profile_id,
        ],
      );
    }

    res.json(nurse);
  }),
);

router.delete(
  "/:id",
  requireCapability("delete_staff", ["admin", "hr_admin"]),
  wrap(async (req, res) => {
    await pool.query("DELETE FROM nurses WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  }),
);

// Rotate all interns in a facility to their next ward in alphabetical sequence.
// Called after the intern rota is published to prepare ward assignments for the next period.
router.post(
  "/rotate-interns",
  requireCapability("rotate_interns", ["admin", "cno", "chief_matron"]),
  wrap(async (req, res) => {
    const { facility } = req.body;
    if (!facility) return res.status(400).json({ error: "facility is required" });

    // Wards for this facility, sorted alphabetically — defines the rotation order.
    const { rows: wardRows } = await pool.query(
      "SELECT name FROM wards WHERE facility = $1 ORDER BY name",
      [facility],
    );
    const wardNames = wardRows.map((r) => r.name);
    if (!wardNames.length) return res.json({ updated: 0 });

    // All interns in this facility.
    const { rows: interns } = await pool.query(
      `SELECT id, ward FROM nurses
       WHERE facility = $1
         AND role ~* '^(nurse\\s+intern|intern\\s+nurse|nursing\\s+intern)$'
       ORDER BY id`,
      [facility],
    );
    if (!interns.length) return res.json({ updated: 0 });

    let updated = 0;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const intern of interns) {
        // Ward is stored as plain string or pipe-separated; use first segment.
        const currentWard = intern.ward ? intern.ward.split("|")[0] : null;
        const idx = wardNames.indexOf(currentWard);
        const nextWard =
          currentWard === null
            ? wardNames[0]
            : wardNames[(idx === -1 ? 0 : idx + 1) % wardNames.length];
        if (nextWard !== intern.ward) {
          await client.query("UPDATE nurses SET ward = $1, updated_at = NOW() WHERE id = $2", [
            nextWard,
            intern.id,
          ]);
          updated++;
        }
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    res.json({ updated });
  }),
);

module.exports = router;
