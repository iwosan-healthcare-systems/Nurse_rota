const router = require("express").Router();
const pool = require("../db");
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// GET /rota-transitions?facility=X&period_start=Y[&ward=Z][&role_group=G]
// Returns full event log ordered oldest-first so callers can replay the timeline.
router.get(
  "/",
  wrap(async (req, res) => {
    const { facility, period_start, ward, role_group } = req.query;
    if (!facility || !period_start)
      return res.status(400).json({ error: "facility and period_start required" });

    const conditions = [`facility = $1`, `period_start = $2`];
    const params = [facility, period_start];

    if (ward !== undefined) {
      if (ward === "null" || ward === "") {
        conditions.push(`ward IS NULL`);
      } else {
        conditions.push(`ward = $${params.length + 1}`);
        params.push(ward);
      }
    }
    if (role_group !== undefined) {
      if (role_group === "null" || role_group === "") {
        conditions.push(`role_group IS NULL`);
      } else {
        conditions.push(`role_group = $${params.length + 1}`);
        params.push(role_group);
      }
    }

    const { rows } = await pool.query(
      `SELECT * FROM rota_transitions
       WHERE ${conditions.join(" AND ")}
       ORDER BY transitioned_at ASC`,
      params,
    );
    res.json(rows);
  }),
);

// POST /rota-transitions — append one event to the timeline.
// No deduplication: reverts + re-submissions create new rows intentionally.
router.post(
  "/",
  wrap(async (req, res) => {
    const {
      facility,
      ward,
      role_group,
      period_start,
      period_end,
      status,
      event_type = "advance",
      actor_id,
      actor_name,
    } = req.body;

    if (!facility || !period_start || !period_end || !status)
      return res.status(400).json({ error: "facility, period_start, period_end, and status required" });

    const VALID_STATUSES = ["draft", "submitted", "approved_chief", "approved_cno", "published"];
    if (!VALID_STATUSES.includes(status))
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` });

    const VALID_EVENTS = ["advance", "revert"];
    if (!VALID_EVENTS.includes(event_type))
      return res.status(400).json({ error: `event_type must be 'advance' or 'revert'` });

    const { rows } = await pool.query(
      `INSERT INTO rota_transitions
         (facility, ward, role_group, period_start, period_end, status, event_type, actor_id, actor_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        facility,
        ward ?? null,
        role_group ?? null,
        period_start,
        period_end,
        status,
        event_type,
        actor_id ?? null,
        actor_name ?? null,
      ],
    );
    res.status(201).json(rows[0]);
  }),
);

module.exports = router;
