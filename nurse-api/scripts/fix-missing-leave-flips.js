// One-time diagnostic + fix for approved leave that never got reflected on the
// rota. When a leave request is approved, routes/leave-requests.js flips the
// nurse's shift_assignments cells to 'LEAVE' for that date range — but only for
// cells whose status isn't still 'draft' (see the "AND status != 'draft'" guard
// there). If the rota for those dates was still in draft at approval time, the
// flip is silently skipped. The only thing that catches it up afterwards is a
// human clicking "Regenerate" in the Rota page (POST /shift-assignments/reapply-leave)
// — if the rota gets submitted/published before that happens, the mismatch rides
// through untouched, and the nurse's rota keeps showing a working shift for a
// day they're actually on approved leave.
//
// This script finds every shift_assignments row that disagrees with an approved
// (non-Swap) leave request covering that date, regardless of the row's status
// (draft/submitted/hr_approved/published) — matching exactly what
// /shift-assignments/reapply-leave already does for a single nurse/date range,
// just applied system-wide in one pass.
//
// Run from /home/ubuntu/nurse-api on NRota:
//   node scripts/fix-missing-leave-flips.js            (dry run — prints every mismatch found)
//   node scripts/fix-missing-leave-flips.js --apply     (flips them to LEAVE)

require("dotenv").config();
const pool = require("../db");

const FIND_MISMATCHES_SQL = `
  SELECT sa.id, sa.nurse_id, sa.shift_date, sa.shift, sa.status, sa.ward,
         n.name AS nurse_name, n.facility,
         lr.id AS leave_id, lr.type AS leave_type, lr.from_date, lr.to_date
    FROM shift_assignments sa
    JOIN leave_requests lr
      ON lr.nurse_id = sa.nurse_id
     AND lr.status = 'Approved'
     AND lr.type != 'Swap'
     AND sa.shift_date BETWEEN lr.from_date AND lr.to_date
    LEFT JOIN nurses n ON n.id = sa.nurse_id
   WHERE sa.shift != 'LEAVE'
   ORDER BY n.name, sa.shift_date
`;

async function main() {
  const apply = process.argv.includes("--apply");

  const { rows: mismatches } = await pool.query(FIND_MISMATCHES_SQL);

  if (!mismatches.length) {
    console.log("No mismatches found — every approved leave date is already reflected on the rota.");
    return pool.end();
  }

  console.log(`Found ${mismatches.length} rota cell(s) that disagree with an approved leave request:\n`);
  for (const m of mismatches) {
    console.log(
      `  ${m.nurse_name ?? "Unknown"} (${m.facility ?? "no facility"}) — ${m.shift_date}: ` +
        `shift=${m.shift} status=${m.status} ward=${m.ward ?? "—"} ` +
        `| leave ${m.leave_type} ${m.from_date} → ${m.to_date} (leave_id ${m.leave_id})`,
    );
  }

  const byNurse = new Map();
  for (const m of mismatches) {
    byNurse.set(m.nurse_name ?? "Unknown", (byNurse.get(m.nurse_name ?? "Unknown") ?? 0) + 1);
  }
  console.log(`\n${mismatches.length} cell(s) across ${byNurse.size} nurse(s).`);

  if (!apply) {
    console.log("\nDry run only — rerun with --apply to flip these cells to LEAVE.");
    return pool.end();
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(`
      UPDATE shift_assignments sa
         SET pre_leave_shift = sa.shift,
             shift = 'LEAVE',
             updated_at = NOW()
        FROM leave_requests lr
       WHERE lr.nurse_id = sa.nurse_id
         AND lr.status = 'Approved'
         AND lr.type != 'Swap'
         AND sa.shift_date BETWEEN lr.from_date AND lr.to_date
         AND sa.shift != 'LEAVE'
    `);
    await client.query(
      `INSERT INTO audit_logs (actor_name, action, target) VALUES ('system', $1, $2)`,
      ["Approved leave reapplied to rota (backfill)", `${rowCount} shift(s) flipped to LEAVE`],
    );
    await client.query("COMMIT");
    console.log(`\nApplied — flipped ${rowCount} shift(s) to LEAVE.`);
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
