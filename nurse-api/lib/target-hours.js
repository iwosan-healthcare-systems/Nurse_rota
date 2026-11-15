// Dated target hours (migration 060). A change takes effect from the start of
// the next rota period; nurses.target_hours is always the target for today.
// Every function runs in the caller's hospital context (row-level security).

// Before any dated change, a person's existing target applies; it is recorded
// from this date so earlier periods keep it once the change takes effect.
const BASELINE = "2000-01-01";
const TODAY = "(NOW() AT TIME ZONE 'Africa/Lagos')::date";

// Schedules `hours` from the next rota period for `nurseIds` (everyone when
// omitted). Returns { effectiveFrom, staff }.
async function scheduleTargetHours(db, hours, nurseIds = null) {
  const {
    rows: [{ next_start }],
  } = await db.query(`SELECT (rota_period_end(${TODAY}) + 1)::text AS next_start`);
  if (!next_start) throw new Error("Rota period could not be determined");
  // $2 is the staff list, or NULL for everyone.
  const ids = nurseIds ?? null;
  // Keep today's target for everything before the change.
  await db.query(
    `INSERT INTO nurse_target_hours (nurse_id, effective_from, hours)
     SELECT n.id, $1::date, n.target_hours FROM nurses n
     WHERE ($2::uuid[] IS NULL OR n.id = ANY($2::uuid[]))
       AND NOT EXISTS (SELECT 1 FROM nurse_target_hours t
                       WHERE t.nurse_id = n.id AND t.effective_from <= ${TODAY})
     ON CONFLICT DO NOTHING`,
    [BASELINE, ids],
  );
  // This change replaces any later one already scheduled.
  await db.query(
    `DELETE FROM nurse_target_hours t
     WHERE t.effective_from > $1::date AND ($2::uuid[] IS NULL OR t.nurse_id = ANY($2::uuid[]))`,
    [next_start, ids],
  );
  const { rowCount } = await db.query(
    `INSERT INTO nurse_target_hours (nurse_id, effective_from, hours)
     SELECT n.id, $1::date, $3::numeric FROM nurses n
     WHERE ($2::uuid[] IS NULL OR n.id = ANY($2::uuid[]))
     ON CONFLICT (nurse_id, effective_from) DO UPDATE SET hours = EXCLUDED.hours`,
    [next_start, ids, hours],
  );
  return { effectiveFrom: next_start, staff: rowCount };
}

// New or imported staff take the hospital's current target, and any change
// already scheduled for everyone else. Staff with a dated history keep theirs.
async function inheritTargetHours(db, hours) {
  const { rowCount } = await db.query(
    `UPDATE nurses n SET target_hours = $1, updated_at = NOW()
     WHERE n.target_hours IS DISTINCT FROM $1
       AND NOT EXISTS (SELECT 1 FROM nurse_target_hours t WHERE t.nurse_id = n.id)`,
    [hours],
  );
  const upcoming = await upcomingTargetChange(db);
  if (upcoming) {
    await db.query(
      `INSERT INTO nurse_target_hours (nurse_id, effective_from, hours)
       SELECT n.id, $1::date, n.target_hours FROM nurses n
       WHERE NOT EXISTS (SELECT 1 FROM nurse_target_hours t WHERE t.nurse_id = n.id)
       ON CONFLICT DO NOTHING`,
      [BASELINE],
    );
    await db.query(
      `INSERT INTO nurse_target_hours (nurse_id, effective_from, hours)
       SELECT n.id, $1::date, $2::numeric FROM nurses n
       ON CONFLICT DO NOTHING`,
      [upcoming.effective_from, upcoming.hours],
    );
  }
  return { updated: rowCount };
}

// Brings nurses.target_hours up to date once a scheduled change has started.
async function syncCurrentTargets(db) {
  const { rowCount } = await db.query(
    `UPDATE nurses n SET target_hours = t.hours, updated_at = NOW()
     FROM (SELECT DISTINCT ON (nurse_id) nurse_id, hours FROM nurse_target_hours
           WHERE effective_from <= ${TODAY}
           ORDER BY nurse_id, effective_from DESC) t
     WHERE n.id = t.nurse_id AND n.target_hours IS DISTINCT FROM t.hours`,
  );
  return rowCount;
}

// The change scheduled for most staff, if any: { hours, effective_from, staff }.
async function upcomingTargetChange(db) {
  const { rows } = await db.query(
    `SELECT effective_from::text, hours, COUNT(*)::int AS staff
     FROM nurse_target_hours WHERE effective_from > ${TODAY}
     GROUP BY effective_from, hours ORDER BY staff DESC, effective_from LIMIT 1`,
  );
  return rows[0] ? { ...rows[0], hours: Number(rows[0].hours) } : null;
}

module.exports = {
  scheduleTargetHours,
  inheritTargetHours,
  syncCurrentTargets,
  upcomingTargetChange,
};
