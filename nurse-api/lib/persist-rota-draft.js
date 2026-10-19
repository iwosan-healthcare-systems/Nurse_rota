// Caller owns the transaction. Shared by saved-run manual generation and cron.
const { guardLegacyGeneration } = require("./legacy-generation-guard");
class DraftConflict extends Error {}
async function persistRotaDraft(
  db,
  { nurseIds, startDate, endDate, assignments, actorName, runId = null, onlyIfEmpty = false },
) {
  const ids = [...new Set(nurseIds)].sort();
  if (!runId) await guardLegacyGeneration(db, ids, endDate);
  else
    await db.query(
      `UPDATE scheduling_facilities f SET policy_revision=policy_revision
     WHERE EXISTS (SELECT 1 FROM nurses n WHERE n.facility=f.legacy_facility AND n.id=ANY($1::uuid[]))`,
      [ids],
    );
  if (!ids.length || !assignments.length)
    throw new DraftConflict("No staff or assignments to save");
  const allowed = new Set(ids),
    keys = new Set();
  for (const row of assignments) {
    const key = `${row.nurse_id}:${row.shift_date}`;
    if (
      !allowed.has(row.nurse_id) ||
      row.shift_date < startDate ||
      row.shift_date > endDate ||
      keys.has(key)
    )
      throw new DraftConflict("Assignments do not match the requested staff and period");
    keys.add(key);
  }
  // Stable lock ordering serializes overlapping manual/background generations.
  await db.query("SELECT id FROM nurses WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [ids]);
  const { rows: existing } = await db.query(
    "SELECT status FROM shift_assignments WHERE nurse_id=ANY($1::uuid[]) AND shift_date BETWEEN $2 AND $3 FOR UPDATE",
    [ids, startDate, endDate],
  );
  if (onlyIfEmpty && existing.length) return { written: 0, skipped: true };
  if (existing.some((row) => row.status !== "draft"))
    throw new DraftConflict(
      "This period contains submitted, approved or published shifts. Return it to draft before generating.",
    );
  await db.query(
    "DELETE FROM shift_assignments WHERE nurse_id=ANY($1::uuid[]) AND shift_date BETWEEN $2 AND $3 AND status='draft'",
    [ids, startDate, endDate],
  );
  for (const row of assignments) {
    const saved = await db.query(
      `INSERT INTO shift_assignments (nurse_id,shift,shift_date,ward,status,created_by_name,pre_leave_shift,leave_type,scheduling_run_id,nurse_role,shift_definition_run_id)
      VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,(SELECT role FROM nurses WHERE id=$1),$8)
      ON CONFLICT (nurse_id,shift_date) DO UPDATE SET shift=EXCLUDED.shift,ward=EXCLUDED.ward,status='draft',pre_leave_shift=EXCLUDED.pre_leave_shift,leave_type=EXCLUDED.leave_type,scheduling_run_id=EXCLUDED.scheduling_run_id,shift_definition_run_id=EXCLUDED.shift_definition_run_id,updated_at=NOW(),updated_by_name=$5
      WHERE shift_assignments.status='draft' RETURNING id`,
      [
        row.nurse_id,
        row.shift,
        row.shift_date,
        row.ward ?? null,
        actorName,
        row.pre_leave_shift ?? null,
        row.leave_type ?? null,
        runId,
      ],
    );
    if (saved.rowCount !== 1)
      throw new DraftConflict(
        "A shift entered approval during generation; no draft changes were saved",
      );
  }
  return { written: assignments.length, skipped: false };
}
module.exports = { persistRotaDraft, DraftConflict };
