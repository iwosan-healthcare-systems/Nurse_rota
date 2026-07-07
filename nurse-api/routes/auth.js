const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.post(
  "/login",
  wrap(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });

    const { rows } = await pool.query(
      `SELECT id, email, full_name, password_hash, is_active, must_change_password
     FROM profiles WHERE lower(email) = lower($1)`,
      [email.trim()],
    );

    const user = rows[0];
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    if (!user.is_active) return res.status(401).json({ error: "Account is inactive" });
    if (!user.password_hash)
      return res.status(401).json({ error: "Password not set — contact your admin" });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });

    const { rows: roleRows } = await pool.query("SELECT role FROM user_roles WHERE user_id = $1", [
      user.id,
    ]);
    const roles = roleRows.map((r) => r.role);

    const { rows: nurseRows } = await pool.query(
      "SELECT id, facility FROM nurses WHERE name = $1 LIMIT 1",
      [user.full_name],
    );
    const nurse = nurseRows[0] ?? null;

    const token = jwt.sign(
      {
        userId: user.id,
        full_name: user.full_name,
        roles,
        mustChangePassword: user.must_change_password,
      },
      process.env.JWT_SECRET,
      { expiresIn: "10h" },
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        roles,
        must_change_password: user.must_change_password,
        nurse_id: nurse?.id ?? null,
        nurse_facility: nurse?.facility ?? null,
      },
    });
  }),
);

router.get(
  "/me",
  requireAuth,
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      "SELECT id, email, full_name, is_active, must_change_password FROM profiles WHERE id = $1",
      [req.user.userId],
    );
    if (!rows[0]) return res.status(404).json({ error: "User not found" });

    const [{ rows: roleRows }, { rows: nurseRows }] = await Promise.all([
      pool.query("SELECT role FROM user_roles WHERE user_id = $1", [req.user.userId]),
      pool.query("SELECT id, facility FROM nurses WHERE name = $1 LIMIT 1", [rows[0].full_name]),
    ]);

    const nurse = nurseRows[0] ?? null;
    res.json({
      ...rows[0],
      roles: roleRows.map((r) => r.role),
      nurse_id: nurse?.id ?? null,
      nurse_facility: nurse?.facility ?? null,
    });
  }),
);

router.post(
  "/change-password",
  requireAuth,
  wrap(async (req, res) => {
    const { current_password, new_password } = req.body;
    if (!new_password || new_password.length < 8)
      return res.status(400).json({ error: "Password must be at least 8 characters" });

    const { rows } = await pool.query(
      "SELECT password_hash, must_change_password FROM profiles WHERE id = $1",
      [req.user.userId],
    );
    if (!rows[0]) return res.status(404).json({ error: "User not found" });

    if (!rows[0].must_change_password) {
      if (!current_password) return res.status(400).json({ error: "Current password is required" });
      const valid = await bcrypt.compare(current_password, rows[0].password_hash);
      if (!valid) return res.status(401).json({ error: "Current password is incorrect" });
    }

    const hash = await bcrypt.hash(new_password, 12);
    await pool.query(
      "UPDATE profiles SET password_hash = $1, must_change_password = false, updated_at = NOW() WHERE id = $2",
      [hash, req.user.userId],
    );

    res.json({ success: true });
  }),
);

// ── Admin endpoints ───────────────────────────────────────────
router.get(
  "/admin/users",
  requireAuth,
  requireRole("admin", "cno"),
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      "SELECT id, email, full_name, is_active, must_change_password, created_at, updated_at FROM profiles ORDER BY full_name",
    );
    res.json(rows);
  }),
);

router.post(
  "/admin/create-user",
  requireAuth,
  requireRole("admin", "cno"),
  wrap(async (req, res) => {
    const { email, password, full_name } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      "INSERT INTO profiles (email, full_name, password_hash, must_change_password) VALUES (lower($1), $2, $3, true) RETURNING id",
      [email.trim(), full_name || null, hash],
    );
    res.json({ id: rows[0].id });
  }),
);

router.delete(
  "/admin/users/:id",
  requireAuth,
  requireRole("admin"),
  wrap(async (req, res) => {
    await pool.query("DELETE FROM profiles WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  }),
);

router.patch(
  "/admin/users/:id/ban",
  requireAuth,
  requireRole("admin", "cno"),
  wrap(async (req, res) => {
    await pool.query("UPDATE profiles SET is_active = false, updated_at = NOW() WHERE id = $1", [
      req.params.id,
    ]);
    res.json({ success: true });
  }),
);

router.patch(
  "/admin/users/:id/unban",
  requireAuth,
  requireRole("admin", "cno"),
  wrap(async (req, res) => {
    await pool.query("UPDATE profiles SET is_active = true, updated_at = NOW() WHERE id = $1", [
      req.params.id,
    ]);
    res.json({ success: true });
  }),
);

router.patch(
  "/admin/users/:id/reset-password",
  requireAuth,
  requireRole("admin", "cno"),
  wrap(async (req, res) => {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: "Password required" });
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      "UPDATE profiles SET password_hash = $1, must_change_password = true, updated_at = NOW() WHERE id = $2",
      [hash, req.params.id],
    );
    res.json({ success: true });
  }),
);

router.patch(
  "/admin/users/:id/profile",
  requireAuth,
  requireRole("admin", "cno"),
  wrap(async (req, res) => {
    const { full_name, email } = req.body;
    if (!full_name?.trim()) return res.status(400).json({ error: "full_name is required" });
    if (!email?.trim()) return res.status(400).json({ error: "email is required" });

    const { rows: current } = await pool.query("SELECT full_name FROM profiles WHERE id = $1", [
      req.params.id,
    ]);
    if (!current[0]) return res.status(404).json({ error: "User not found" });

    const oldName = current[0].full_name;

    await pool.query(
      "UPDATE profiles SET full_name = $1, email = lower($2), updated_at = NOW() WHERE id = $3",
      [full_name.trim(), email.trim(), req.params.id],
    );

    if (oldName) {
      await pool.query("UPDATE nurses SET name = $1, email = lower($2) WHERE name = $3", [
        full_name.trim(),
        email.trim().toLowerCase(),
        oldName,
      ]);
    }

    res.json({ success: true });
  }),
);

router.post(
  "/admin/bulk-create-users",
  requireAuth,
  requireRole("admin"),
  wrap(async (req, res) => {
    const { default_password } = req.body;
    if (!default_password || default_password.length < 8)
      return res.status(400).json({ error: "Password must be at least 8 characters" });

    // Map each nurse's job role (from the staff table) to the appropriate system role.
    function jobRoleToAppRole(jobRole) {
      if (!jobRole) return "nurse";
      const r = jobRole.trim().toLowerCase();
      if (r === "cno" || r === "chief nursing officer") return "cno";
      if (r === "chief matron") return "chief_matron";
      if (r === "matron") return "chief_matron";
      if (r === "coverage nurse") return "head_nurse";
      if (r === "head nurse") return "head_nurse";
      if (/^hr/.test(r)) return "hr_admin";
      if (/^porter/.test(r)) return "porter";
      if (/^nurs(e|ing).?assistant/.test(r)) return "nursing_assistant";
      if (/^surgical\s*nurse/i.test(r)) return "surgical_nurse";
      return "nurse";
    }

    const { rows: nurses } = await pool.query(
      `SELECT name, email, role FROM nurses WHERE email IS NOT NULL AND trim(email) != '' ORDER BY name`,
    );

    if (nurses.length === 0) return res.json({ created: [], skipped: [] });

    const { rows: existing } = await pool.query(
      `SELECT lower(trim(email)) AS email FROM profiles WHERE email IS NOT NULL`,
    );
    const existingEmails = new Set(existing.map((r) => r.email));

    const hash = await bcrypt.hash(default_password, 12);
    const created = [];
    const skipped = [];

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const nurse of nurses) {
        const email = nurse.email.trim().toLowerCase();
        if (existingEmails.has(email)) {
          skipped.push({ name: nurse.name, email, reason: "Already has an account" });
          continue;
        }
        const appRole = jobRoleToAppRole(nurse.role);
        const { rows } = await client.query(
          `INSERT INTO profiles (email, full_name, password_hash, must_change_password)
         VALUES ($1, $2, $3, true) RETURNING id`,
          [email, nurse.name, hash],
        );
        await client.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, $2)`, [
          rows[0].id,
          appRole,
        ]);
        created.push({ name: nurse.name, email });
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    res.json({ created, skipped });
  }),
);

module.exports = router;
