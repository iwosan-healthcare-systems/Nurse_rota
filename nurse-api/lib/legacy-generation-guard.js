// Called inside legacy bulk generation transactions, not individual cell edits.
async function guardLegacyGeneration(db, nurseIds, endDate, cells = null) {
  if (!nurseIds.length || !endDate) return;
  const { rows: facilities } = await db.query(
    `SELECT f.id FROM scheduling_facilities f
     WHERE EXISTS (SELECT 1 FROM nurses n WHERE n.facility=f.legacy_facility AND n.id=ANY($1::uuid[]))
     ORDER BY f.id FOR UPDATE`,
    [nurseIds],
  );
  const policy = await db.query(
    "SELECT 1 FROM scheduling_policy_events WHERE facility_id=ANY($1::uuid[]) AND effective_from<=$2 LIMIT 1",
    [facilities.map((f) => f.id), endDate],
  );
  // A waiting repeatable-read activation must retry after this legacy write;
  // a row lock alone would leave its earlier snapshot valid after the wait.
  await db.query(
    "UPDATE scheduling_facilities SET policy_revision=policy_revision WHERE id=ANY($1::uuid[])",
    [facilities.map((f) => f.id)],
  );
  if (policy.rows.length) {
    // The legacy upsert also carries status-only approval transitions. Preserve
    // those when every existing cell's scheduling values are unchanged.
    if (cells) {
      const { rows: existing } = await db.query(
        "SELECT nurse_id,shift_date::text,shift,ward,pre_leave_shift,leave_type FROM shift_assignments WHERE nurse_id=ANY($1::uuid[]) AND shift_date=ANY($2::date[]) FOR UPDATE",
        [nurseIds, cells.map((c) => c.shift_date)],
      );
      const byCell = new Map(existing.map((c) => [`${c.nurse_id}:${c.shift_date}`, c]));
      if (
        cells.every((c) => {
          const old = byCell.get(`${c.nurse_id}:${c.shift_date}`);
          return (
            old &&
            ["shift", "ward", "pre_leave_shift", "leave_type"].every(
              (k) => (old[k] || null) === (c[k] || null),
            )
          );
        })
      )
        return;
    }
    const error = new Error(
      "This period uses configured scheduling. Open Scheduling to generate with the active configuration; individual shift edits remain available.",
    );
    error.code = "CONFIGURED_GENERATION_REQUIRED";
    throw error;
  }
}
module.exports = { guardLegacyGeneration };
