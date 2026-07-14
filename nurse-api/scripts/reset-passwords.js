// One-time script: set all login passwords (except the admin) to RotaLogin@123
// Run from /root/nurse-api: node scripts/reset-passwords.js

require("dotenv").config();
const bcrypt = require("bcryptjs");
const pool = require("../db");

const ADMIN_ID = "02f6d507-d1f6-45c2-a739-6da0c6e88725";
const NEW_PASSWORD = "RotaLogin@123";

async function main() {
  const hash = await bcrypt.hash(NEW_PASSWORD, 12);

  const { rows } = await pool.query(
    `UPDATE profiles
     SET password_hash = $1, must_change_password = true, updated_at = NOW()
     WHERE id != $2
     RETURNING full_name, email`,
    [hash, ADMIN_ID],
  );

  console.log(`\nUpdated ${rows.length} account(s):`);
  rows.forEach((r) => console.log(`  ✓ ${r.full_name ?? "(no name)"} — ${r.email ?? "(no email)"}`));
  console.log("\nDone. All affected users will be prompted to change their password on next login.\n");

  await pool.end();
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
