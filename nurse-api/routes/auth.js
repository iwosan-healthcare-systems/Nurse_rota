const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");
const { requireCapability } = require("../middleware/capability");
const { sendMail, portalUrl } = require("../lib/mailer");

const DEFAULT_INITIAL_PASSWORD = "RotaLogin@123";
const OTP_TTL_MINUTES = 5;
const MAX_OTP_ATTEMPTS = 5;

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

async function getPasswordExpiryDays() {
  const { rows } = await pool.query(
    "SELECT value FROM portal_settings WHERE key = 'password_expiry_days'",
  );
  return rows[0] ? parseInt(rows[0].value, 10) || 30 : 30;
}

async function getMinPasswordLength() {
  const { rows } = await pool.query(
    "SELECT value FROM portal_settings WHERE key = 'min_password_length'",
  );
  return rows[0] ? parseInt(rows[0].value, 10) || 8 : 8;
}

function computeExpiresInDays(passwordChangedAt, expiryDays) {
  const changedAt = new Date(passwordChangedAt);
  const expiresAt = new Date(changedAt.getTime() + expiryDays * 24 * 60 * 60 * 1000);
  return Math.floor((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[char];
  });
}

function uniqueEmails(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const email = String(value ?? "").trim();
    const key = email.toLowerCase();
    if (!email || seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

function excludeEmail(values, emailToExclude) {
  const excluded = String(emailToExclude ?? "")
    .trim()
    .toLowerCase();
  return uniqueEmails(values).filter((email) => email.toLowerCase() !== excluded);
}

async function getAccountCreatedCcEmails() {
  const { rows } = await pool.query(
    `SELECT DISTINCT lower(trim(p.email)) AS email
       FROM profiles p
       JOIN user_roles ur ON ur.user_id = p.id
      WHERE ur.role IN ('admin', 'hr_admin')
        AND p.is_active = true
        AND p.email IS NOT NULL
        AND trim(p.email) != ''`,
  );
  return uniqueEmails(rows.map((row) => row.email));
}

function sendAccountCreatedEmail({ email, fullName, password, ccEmails }) {
  const safeName = escapeHtml(fullName || "there");
  const safeEmail = escapeHtml(email);
  const safePassword = escapeHtml(password);
  const cc = excludeEmail(ccEmails, email);

  return sendMail({
    to: email,
    cc,
    subject: "Your Nurses Rota account has been created",
    title: "Your account has been created",
    bodyHtml: `<p>Hi ${safeName},</p>
<p>Your Nurses Rota account has been created. Sign in to the portal with the details below, then update your password when prompted.</p>
<p><strong>Username:</strong> ${safeEmail}</p>
<p><strong>Default password:</strong></p>
<p style="font-size:20px;font-weight:700;letter-spacing:1px;color:#1b2559;margin:14px 0;font-family:Consolas,Menlo,monospace;">${safePassword}</p>
<p>Please keep this password private and change it when you first log in.</p>`,
    ctaText: "Open Portal",
    ctaUrl: portalUrl("/login"),
  });
}

// Public (no requireAuth — /api/portal-settings is auth-gated at the mount
// level, but the logged-out forgot-password flow still needs to show/enforce
// the real minimum, not a stale hardcoded guess) — just the one number, not
// sensitive.
router.get(
  "/password-policy",
  wrap(async (req, res) => {
    res.json({ min_password_length: await getMinPasswordLength() });
  }),
);

router.post(
  "/login",
  wrap(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });

    const { rows } = await pool.query(
      `SELECT id, email, full_name, password_hash, is_active, must_change_password, password_changed_at
       FROM profiles WHERE lower(email) = lower($1)
       ORDER BY created_at DESC LIMIT 1`,
      [email.trim()],
    );

    const user = rows[0];
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    if (!user.is_active) return res.status(401).json({ error: "Account is inactive" });
    if (!user.password_hash)
      return res.status(401).json({ error: "Password not set — contact your admin" });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });

    const [{ rows: roleRows }, expiryDays, { rows: overrideRows }] = await Promise.all([
      pool.query("SELECT role FROM user_roles WHERE user_id = $1", [user.id]),
      getPasswordExpiryDays(),
      pool.query("SELECT capability_key FROM user_capability_overrides WHERE user_id = $1", [
        user.id,
      ]),
    ]);
    const roles = roleRows.map((r) => r.role);
    const capabilityOverrides = overrideRows.map((r) => r.capability_key);
    const isAdminUser = roles.includes("admin");
    const passwordExpiresInDays = isAdminUser
      ? null
      : computeExpiresInDays(user.password_changed_at ?? new Date(), expiryDays);

    // Reject expired passwords — admin must reset before the user can log back in.
    if (passwordExpiresInDays !== null && passwordExpiresInDays <= 0) {
      return res.status(401).json({
        error: "Your password has expired. Contact your administrator to reset it.",
      });
    }

    // Try direct profile_id link first (exact, no name-collision risk)
    let { rows: nurseRows } = await pool.query(
      "SELECT id, facility FROM nurses WHERE profile_id = $1 LIMIT 1",
      [user.id],
    );
    if (!nurseRows[0]) {
      const { rows: byName } = await pool.query(
        "SELECT id, facility FROM nurses WHERE LOWER(name) = LOWER($1) LIMIT 1",
        [user.full_name],
      );
      if (byName[0]) {
        nurseRows = byName;
        pool
          .query("UPDATE nurses SET profile_id = $1 WHERE id = $2", [user.id, byName[0].id])
          .catch(() => {});
      }
    }
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

    pool
      .query(
        "INSERT INTO audit_logs (action, actor_id, actor_name, actor_role) VALUES ($1,$2,$3,$4)",
        ["Logged in", user.id, user.full_name, roles[0] ?? null],
      )
      .catch(() => {});

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        roles,
        must_change_password: user.must_change_password,
        password_expires_in_days: passwordExpiresInDays,
        nurse_id: nurse?.id ?? null,
        nurse_facility: nurse?.facility ?? null,
        capability_overrides: capabilityOverrides,
      },
    });
  }),
);

router.get(
  "/me",
  requireAuth,
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      "SELECT id, email, full_name, is_active, must_change_password, password_changed_at FROM profiles WHERE id = $1",
      [req.user.userId],
    );
    if (!rows[0]) return res.status(404).json({ error: "User not found" });

    const [{ rows: roleRows }, { rows: profileIdRows }, expiryDays, { rows: overrideRows }] =
      await Promise.all([
        pool.query("SELECT role FROM user_roles WHERE user_id = $1", [req.user.userId]),
        pool.query("SELECT id, facility FROM nurses WHERE profile_id = $1 LIMIT 1", [
          req.user.userId,
        ]),
        getPasswordExpiryDays(),
        pool.query("SELECT capability_key FROM user_capability_overrides WHERE user_id = $1", [
          req.user.userId,
        ]),
      ]);

    let nurseRows = profileIdRows;
    if (!nurseRows[0]) {
      const { rows: byName } = await pool.query(
        "SELECT id, facility FROM nurses WHERE LOWER(name) = LOWER($1) LIMIT 1",
        [rows[0].full_name],
      );
      if (byName[0]) {
        nurseRows = byName;
        pool
          .query("UPDATE nurses SET profile_id = $1 WHERE id = $2", [req.user.userId, byName[0].id])
          .catch(() => {});
      }
    }
    const nurse = nurseRows[0] ?? null;
    const meRoles = roleRows.map((r) => r.role);
    const isAdminUser = meRoles.includes("admin");
    const passwordExpiresInDays = isAdminUser
      ? null
      : computeExpiresInDays(rows[0].password_changed_at ?? new Date(), expiryDays);
    res.json({
      ...rows[0],
      roles: meRoles,
      password_expires_in_days: passwordExpiresInDays,
      nurse_id: nurse?.id ?? null,
      nurse_facility: nurse?.facility ?? null,
      capability_overrides: overrideRows.map((r) => r.capability_key),
    });
  }),
);

router.post(
  "/change-password",
  requireAuth,
  wrap(async (req, res) => {
    const { current_password, new_password } = req.body;
    const minLen = await getMinPasswordLength();
    if (!new_password || new_password.length < minLen)
      return res.status(400).json({ error: `Password must be at least ${minLen} characters` });

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
      `UPDATE profiles
       SET password_hash = $1, must_change_password = false,
           password_changed_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [hash, req.user.userId],
    );

    await pool.query(
      "INSERT INTO audit_logs (action, actor_id, actor_name, actor_role) VALUES ($1,$2,$3,$4)",
      ["Changed password", req.user.userId, req.user.full_name, (req.user.roles || [])[0] ?? null],
    );

    res.json({ success: true });
  }),
);

// Password change triggered from the expiry warning banner.
// Current password is required to confirm the user's identity before changing it.
router.post(
  "/change-password-expiry",
  requireAuth,
  wrap(async (req, res) => {
    const { current_password, new_password } = req.body;
    if (!current_password) return res.status(400).json({ error: "Current password is required" });
    const minLen = await getMinPasswordLength();
    if (!new_password || new_password.length < minLen)
      return res.status(400).json({ error: `Password must be at least ${minLen} characters` });

    const { rows } = await pool.query("SELECT password_hash FROM profiles WHERE id = $1", [
      req.user.userId,
    ]);
    if (!rows[0]) return res.status(404).json({ error: "User not found" });

    const valid = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: "Current password is incorrect" });

    if (current_password === new_password)
      return res
        .status(400)
        .json({ error: "New password must be different from your current password" });

    const hash = await bcrypt.hash(new_password, 12);
    await pool.query(
      `UPDATE profiles
       SET password_hash = $1, must_change_password = false,
           password_changed_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [hash, req.user.userId],
    );

    await pool.query(
      "INSERT INTO audit_logs (action, actor_id, actor_name, actor_role) VALUES ($1,$2,$3,$4)",
      [
        "Changed password (expiry)",
        req.user.userId,
        req.user.full_name,
        (req.user.roles || [])[0] ?? null,
      ],
    );

    res.json({ success: true });
  }),
);

// ── Forgot password (self-service, unauthenticated) ────────────────────────

router.post(
  "/forgot-password",
  wrap(async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    // Always the same response whether or not the email has an account —
    // otherwise this endpoint could be used to build a list of valid staff
    // emails (confirmed intentional trade-off; see conversation history).
    const genericResponse = {
      message: "If that email has an account, we've sent a reset code.",
    };

    const { rows } = await pool.query(
      "SELECT id, email, full_name, is_active FROM profiles WHERE lower(email) = lower($1) ORDER BY created_at DESC LIMIT 1",
      [email.trim()],
    );
    const user = rows[0];
    if (!user || !user.is_active) return res.json(genericResponse);

    // Light cooldown — a double-click or rapid retry shouldn't burn a fresh
    // code (invalidating the one the user might already be typing in) or
    // spam their inbox with duplicate emails.
    const { rows: recentRows } = await pool.query(
      `SELECT id FROM password_reset_otps
       WHERE user_id = $1 AND used_at IS NULL AND created_at > NOW() - INTERVAL '60 seconds'`,
      [user.id],
    );
    if (recentRows.length) return res.json(genericResponse);

    const otp = crypto.randomInt(100000, 1000000).toString();
    const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Only one live code per user — a fresh request supersedes any earlier one.
      await client.query("DELETE FROM password_reset_otps WHERE user_id = $1 AND used_at IS NULL", [
        user.id,
      ]);
      await client.query(
        "INSERT INTO password_reset_otps (user_id, otp_hash, expires_at) VALUES ($1, $2, $3)",
        [user.id, otpHash, expiresAt],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    sendMail({
      to: user.email,
      subject: "Your Nurses Rota password reset code",
      title: "Reset your password",
      bodyHtml: `<p>Hi ${user.full_name ?? "there"},</p>
<p>Use this code to reset your password. It expires in ${OTP_TTL_MINUTES} minutes.</p>
<p style="font-size:28px;font-weight:700;letter-spacing:6px;color:#1b2559;margin:20px 0;">${otp}</p>
<p>If you didn't request this, you can safely ignore this email — your password won't change unless this code is used.</p>`,
      ctaText: "Enter Reset Code",
      ctaUrl: portalUrl("/forgot-password"),
    }).catch(() => {});

    res.json(genericResponse);
  }),
);

router.post(
  "/reset-password",
  wrap(async (req, res) => {
    const { email, otp, new_password } = req.body;
    if (!email || !otp || !new_password)
      return res.status(400).json({ error: "Email, code, and new password are required" });
    const minLen = await getMinPasswordLength();
    if (new_password.length < minLen)
      return res.status(400).json({ error: `Password must be at least ${minLen} characters` });

    // Same generic-feeling error throughout this route — never hint whether
    // the email itself, the code, or the attempt count was the problem.
    const invalidError = { error: "Invalid or expired code" };

    const { rows } = await pool.query(
      "SELECT id, full_name FROM profiles WHERE lower(email) = lower($1) ORDER BY created_at DESC LIMIT 1",
      [email.trim()],
    );
    const user = rows[0];
    if (!user) return res.status(400).json(invalidError);

    const { rows: otpRows } = await pool.query(
      `SELECT id, otp_hash, expires_at, attempts FROM password_reset_otps
       WHERE user_id = $1 AND used_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [user.id],
    );
    const record = otpRows[0];
    if (!record || new Date(record.expires_at) < new Date())
      return res.status(400).json(invalidError);
    if (record.attempts >= MAX_OTP_ATTEMPTS)
      return res.status(400).json({ error: "Too many attempts — request a new code" });

    const valid = await bcrypt.compare(otp, record.otp_hash);
    if (!valid) {
      await pool.query("UPDATE password_reset_otps SET attempts = attempts + 1 WHERE id = $1", [
        record.id,
      ]);
      return res.status(400).json(invalidError);
    }

    const hash = await bcrypt.hash(new_password, 12);
    await pool.query(
      `UPDATE profiles SET password_hash = $1, must_change_password = false,
       password_changed_at = NOW(), updated_at = NOW() WHERE id = $2`,
      [hash, user.id],
    );
    await pool.query("UPDATE password_reset_otps SET used_at = NOW() WHERE id = $1", [record.id]);

    pool
      .query(
        "INSERT INTO audit_logs (action, actor_id, actor_name, actor_role) VALUES ($1,$2,$3,$4)",
        ["Reset password via email code", user.id, user.full_name, null],
      )
      .catch(() => {});

    res.json({ success: true });
  }),
);

// ── Admin endpoints ───────────────────────────────────────────
router.get(
  "/admin/users",
  requireAuth,
  requireCapability("manage_users", ["admin", "cno", "service_support"]),
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      "SELECT id, email, full_name, is_active, must_change_password, password_changed_at, created_at, updated_at FROM profiles ORDER BY full_name",
    );
    res.json(rows);
  }),
);

router.post(
  "/admin/create-user",
  requireAuth,
  requireCapability("manage_users", ["admin", "cno", "service_support"]),
  wrap(async (req, res) => {
    const { email, full_name, role, nurse_id } = req.body;
    const password = req.body.password || DEFAULT_INITIAL_PASSWORD;
    if (!email) return res.status(400).json({ error: "Email is required" });
    const minLen = await getMinPasswordLength();
    if (password.length < minLen)
      return res.status(400).json({ error: `Password must be at least ${minLen} characters` });

    const normalizedEmail = email.trim().toLowerCase();

    // Prevent duplicate profiles for the same email
    const { rows: existing } = await pool.query("SELECT id FROM profiles WHERE lower(email) = $1", [
      normalizedEmail,
    ]);
    if (existing.length > 0) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    const hash = await bcrypt.hash(password, 12);
    const accountCreatedCcEmails = await getAccountCreatedCcEmails().catch((err) => {
      console.error("[auth] account-created cc lookup failed:", err.message);
      return [];
    });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query(
        "INSERT INTO profiles (email, full_name, password_hash, must_change_password) VALUES ($1, $2, $3, true) RETURNING id",
        [normalizedEmail, full_name || null, hash],
      );
      const userId = rows[0].id;

      if (role) {
        await client.query(
          "INSERT INTO user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [userId, role],
        );
      }

      if (nurse_id) {
        await client.query("UPDATE nurses SET email = $1, profile_id = $2 WHERE id = $3", [
          normalizedEmail,
          userId,
          nurse_id,
        ]);
      }

      await client.query("COMMIT");
      sendAccountCreatedEmail({
        email: normalizedEmail,
        fullName: full_name || normalizedEmail,
        password,
        ccEmails: accountCreatedCcEmails,
      }).catch(() => {});
      res.json({ id: userId });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }),
);

router.delete(
  "/admin/users/:id",
  requireAuth,
  requireCapability("delete_user_account", ["admin"]),
  wrap(async (req, res) => {
    await pool.query("DELETE FROM profiles WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  }),
);

router.patch(
  "/admin/users/:id/ban",
  requireAuth,
  requireCapability("manage_users", ["admin", "cno", "service_support"]),
  wrap(async (req, res) => {
    const profileId = req.params.id;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Deactivate the login account
      const { rows: profileRows } = await client.query(
        "UPDATE profiles SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING full_name",
        [profileId],
      );

      // Find linked nurse record — try exact profile_id first, fall back to name match
      let { rows: nurseRows } = await client.query(
        "UPDATE nurses SET is_active = false, profile_id = $1 WHERE profile_id = $1 RETURNING id",
        [profileId],
      );
      if (!nurseRows[0] && profileRows[0]?.full_name) {
        ({ rows: nurseRows } = await client.query(
          `UPDATE nurses SET is_active = false, profile_id = $1
           WHERE LOWER(name) = LOWER($2) RETURNING id`,
          [profileId, profileRows[0].full_name],
        ));
      }

      // Clear all future and current shift assignments for the deactivated nurse
      if (nurseRows[0]) {
        await client.query(
          "DELETE FROM shift_assignments WHERE nurse_id = $1 AND shift_date >= CURRENT_DATE",
          [nurseRows[0].id],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    res.json({ success: true });
  }),
);

router.patch(
  "/admin/users/:id/unban",
  requireAuth,
  requireCapability("manage_users", ["admin", "cno", "service_support"]),
  wrap(async (req, res) => {
    const profileId = req.params.id;
    const { rows: profileRows } = await pool.query(
      "UPDATE profiles SET is_active = true, updated_at = NOW() WHERE id = $1 RETURNING full_name",
      [profileId],
    );
    // Restore by profile_id first, fall back to name
    const { rowCount } = await pool.query(
      "UPDATE nurses SET is_active = true WHERE profile_id = $1",
      [profileId],
    );
    if (!rowCount && profileRows[0]?.full_name) {
      await pool.query(
        "UPDATE nurses SET is_active = true, profile_id = $1 WHERE LOWER(name) = LOWER($2)",
        [profileId, profileRows[0].full_name],
      );
    }
    res.json({ success: true });
  }),
);

router.patch(
  "/admin/users/:id/reset-password",
  requireAuth,
  requireCapability("manage_users", ["admin", "cno", "service_support"]),
  wrap(async (req, res) => {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: "Password required" });
    const minLen = await getMinPasswordLength();
    if (password.length < minLen)
      return res.status(400).json({ error: `Password must be at least ${minLen} characters` });
    const { rows: targetRows } = await pool.query("SELECT full_name FROM profiles WHERE id = $1", [
      req.params.id,
    ]);
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      `UPDATE profiles SET password_hash = $1, must_change_password = true,
       password_changed_at = NOW(), updated_at = NOW() WHERE id = $2`,
      [hash, req.params.id],
    );
    await pool.query(
      "INSERT INTO audit_logs (action, actor_id, actor_name, actor_role, target) VALUES ($1,$2,$3,$4,$5)",
      [
        "Reset password (admin)",
        req.user.userId,
        req.user.full_name,
        (req.user.roles || [])[0] ?? null,
        targetRows[0]?.full_name ?? req.params.id,
      ],
    );
    res.json({ success: true });
  }),
);

router.patch(
  "/admin/users/:id/profile",
  requireAuth,
  requireCapability("edit_user_profile", ["admin", "cno"]),
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

    // Update the matching nurse record.
    // Prefer profile_id linkage (reliable); fall back to case-insensitive name
    // match for nurses that haven't been linked yet.
    if (oldName) {
      await pool.query(
        `UPDATE nurses SET name = $1, email = lower($2), updated_at = NOW()
         WHERE profile_id = $3
            OR (profile_id IS NULL AND LOWER(name) = LOWER($4))`,
        [full_name.trim(), email.trim().toLowerCase(), req.params.id, oldName],
      );
    } else {
      await pool.query(
        `UPDATE nurses SET name = $1, email = lower($2), updated_at = NOW()
         WHERE profile_id = $3`,
        [full_name.trim(), email.trim().toLowerCase(), req.params.id],
      );
    }

    res.json({ success: true });
  }),
);

router.post(
  "/admin/bulk-create-users",
  requireAuth,
  requireCapability("bulk_create_users", ["admin"]),
  wrap(async (req, res) => {
    const { default_password = DEFAULT_INITIAL_PASSWORD } = req.body;
    const minLen = await getMinPasswordLength();
    if (!default_password || default_password.length < minLen)
      return res.status(400).json({ error: `Password must be at least ${minLen} characters` });

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
    const accountCreatedCcEmails = await getAccountCreatedCcEmails().catch((err) => {
      console.error("[auth] account-created cc lookup failed:", err.message);
      return [];
    });
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
        await client.query(
          "UPDATE nurses SET profile_id = $1 WHERE LOWER(name) = LOWER($2) AND profile_id IS NULL",
          [rows[0].id, nurse.name],
        );
        created.push({ name: nurse.name, email });
        existingEmails.add(email);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    for (const account of created) {
      sendAccountCreatedEmail({
        email: account.email,
        fullName: account.name,
        password: default_password,
        ccEmails: accountCreatedCcEmails,
      }).catch(() => {});
    }

    res.json({ created, skipped });
  }),
);

module.exports = router;
