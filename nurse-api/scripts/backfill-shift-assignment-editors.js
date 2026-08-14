// One-time backfill for the updated_by/updated_by_name columns added by
// migrations/040_shift_assignments_audit_columns.sql. Those columns didn't
// exist before, so no historical edit ever recorded an actor — but for rows
// the system auto-generated (created_by IS NULL), the only way a cell could
// have since been hand-adjusted is through an Approved rota_edit_requests
// grant for that ward/role-group + period (see headNurseHasEditGrantForAll
// in routes/shift-assignments.js — auto-generated drafts can't be touched
// any other way). So for every such row that falls inside an approved
// grant's ward/role-group + period window, attribute updated_by/
// updated_by_name to that grant's requester.
//
// This is a heuristic, not a certainty: an approved grant means that person
// *could* edit any cell in scope, not that they touched every one — some
// rows tagged here may never actually have been hand-edited. It's the
// closest attribution available for data that was never tracked directly.
// Where more than one approved grant has covered the same row over time,
// whichever was reviewed most recently wins.
//
// Run from /home/ubuntu/nurse-api on NRota:
//   node scripts/backfill-shift-assignment-editors.js            (dry run)
//   node scripts/backfill-shift-assignment-editors.js --apply     (writes)

require("dotenv").config();
const pool = require("../db");

// Mirrors routes/shift-assignments.js's roleGroupOf / lib/force-submit-rota.js's
// copy — kept as its own copy here too, matching this codebase's convention.
function roleGroupOf(role) {
  if (!role) return null;
  if (/^matron$/i.test(role)) return "matron";
  if (/^(head|coverage)\s*nurse$/i.test(role) || /^coverage\s*nurse\s*-\s*day$/i.test(role))
    return "head";
  if (/^porter(\s*-\s*day)?$/i.test(role)) return "porter";
  if (/nurse\s*intern|intern\s*nurse/i.test(role)) return "intern";
  return null;
}

const CANDIDATES_SQL = `
  SELECT sa.id, sa.ward, sa.shift_date, n.facility, n.role
    FROM shift_assignments sa
    JOIN nurses n ON n.id = sa.nurse_id
   WHERE sa.created_by IS NULL
     AND sa.updated_by IS NULL
`;

const GRANTS_SQL = `
  SELECT facility, ward, role_group, period_start, period_end,
         requested_by, requested_by_name, COALESCE(reviewed_at, created_at) AS decided_at
    FROM rota_edit_requests
   WHERE status = 'Approved'
`;

async function main() {
  const apply = process.argv.includes("--apply");

  const [{ rows: candidates }, { rows: grants }] = await Promise.all([
    pool.query(CANDIDATES_SQL),
    pool.query(GRANTS_SQL),
  ]);

  if (!candidates.length) {
    console.log("No system-generated rows without an editor on record — nothing to backfill.");
    return pool.end();
  }
  if (!grants.length) {
    console.log("No approved edit-access grants exist — nothing to attribute against.");
    return pool.end();
  }

  // Bucket grants by facility + unit key for fast lookup, sorted so the
  // most-recently-decided grant for a given row is found first.
  const grantsByUnit = new Map();
  for (const g of grants) {
    const unitKey = `${g.facility}|${g.ward ?? `role:${g.role_group}`}`;
    if (!grantsByUnit.has(unitKey)) grantsByUnit.set(unitKey, []);
    grantsByUnit.get(unitKey).push(g);
  }
  for (const list of grantsByUnit.values()) {
    list.sort((a, b) => new Date(b.decided_at) - new Date(a.decided_at));
  }

  const matches = [];
  for (const row of candidates) {
    const unitKey = row.ward
      ? `${row.facility}|${row.ward}`
      : `${row.facility}|role:${roleGroupOf(row.role)}`;
    const list = grantsByUnit.get(unitKey);
    if (!list) continue;
    const dateStr = String(row.shift_date).slice(0, 10);
    const grant = list.find((g) => dateStr >= g.period_start && dateStr <= g.period_end);
    if (grant) matches.push({ id: row.id, ...grant });
  }

  if (!matches.length) {
    console.log(
      `Checked ${candidates.length} system-generated row(s) with no editor on record — none fall inside an approved edit-access grant's window.`,
    );
    return pool.end();
  }

  const byEditor = new Map();
  for (const m of matches) {
    const key = m.requested_by_name ?? "Unknown";
    byEditor.set(key, (byEditor.get(key) ?? 0) + 1);
  }
  console.log(`Found ${matches.length} row(s) attributable to an approved edit-access grant:`);
  for (const [name, count] of byEditor) console.log(`  ${name}: ${count} cell(s)`);

  if (!apply) {
    console.log("\nDry run only — rerun with --apply to write updated_by/updated_by_name.");
    return pool.end();
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const m of matches) {
      await client.query(
        "UPDATE shift_assignments SET updated_by = $1, updated_by_name = $2 WHERE id = $3",
        [m.requested_by, m.requested_by_name, m.id],
      );
    }
    await client.query(
      `INSERT INTO audit_logs (actor_name, action, target) VALUES ('system', $1, $2)`,
      [
        "Shift-assignment editors backfilled from approved edit-access grants",
        `${matches.length} cell(s) across ${byEditor.size} editor(s)`,
      ],
    );
    await client.query("COMMIT");
    console.log(`\nApplied — updated ${matches.length} row(s).`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Failed, rolled back:", e.message);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
