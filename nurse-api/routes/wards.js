const router = require("express").Router();
const pool = require("../db");
const { requireCapability } = require("../middleware/capability");
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.get(
  "/",
  wrap(async (req, res) => {
    const conditions = [];
    const params = [];

    if (req.query.facility) {
      conditions.push(`facility = $${params.length + 1}`);
      params.push(req.query.facility);
    }
    if (req.query.facility_or_null) {
      conditions.push(`(facility = $${params.length + 1} OR facility IS NULL)`);
      params.push(req.query.facility_or_null);
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const { rows } = await pool.query(`SELECT * FROM wards ${where} ORDER BY name`, params);
    res.json(rows);
  }),
);

router.post(
  "/",
  requireCapability("manage_wards", ["admin", "cno"]),
  wrap(async (req, res) => {
    const { name, facility, min_morning_nurses, min_morning_na, min_night_nurses, min_night_na } =
      req.body;
    if (!name) return res.status(400).json({ error: "Name is required" });

    const { rows } = await pool.query(
      `INSERT INTO wards (name, facility, min_morning_nurses, min_morning_na, min_night_nurses, min_night_na)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        name,
        facility || null,
        min_morning_nurses || 0,
        min_morning_na || 0,
        min_night_nurses || 0,
        min_night_na || 0,
      ],
    );
    res.status(201).json(rows[0]);
  }),
);

router.patch(
  "/:id",
  requireCapability("manage_wards", ["admin", "cno"]),
  wrap(async (req, res) => {
    const allowed = [
      "name",
      "facility",
      "min_morning_nurses",
      "min_morning_na",
      "min_night_nurses",
      "min_night_na",
    ];
    const fields = Object.keys(req.body).filter((k) => allowed.includes(k));
    if (!fields.length) return res.status(400).json({ error: "No valid fields to update" });

    const sets = fields.map((f, i) => `${f} = $${i + 1}`);
    const values = fields.map((f) => req.body[f]);
    values.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE wards SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    if (!rows[0]) return res.status(404).json({ error: "Ward not found" });
    res.json(rows[0]);
  }),
);

router.delete(
  "/:id",
  requireCapability("manage_wards", ["admin", "cno"]),
  wrap(async (req, res) => {
    await pool.query("DELETE FROM wards WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  }),
);

module.exports = router;
