const { withAssignmentShiftDefinitions } = require("./assignment-shift-definition");

async function recordConfiguredMissedShifts(pool, now = new Date()) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    // Row locks serialize configured finalizers and prevent duty/leave edits
    // between resolving the saved definition and recording the missed shift.
    const { rows } = await db.query(
      `SELECT sa.*,sa.shift_date::text,
        (SELECT id FROM locum_requests lr WHERE lr.status='filled'
          AND lr.accepted_by_nurse_id=sa.nurse_id AND lr.shift_date=sa.shift_date LIMIT 1) AS locum_id
      FROM shift_assignments sa
      WHERE sa.status='published' AND sa.shift NOT IN ('OFF','LEAVE')
        AND COALESCE(sa.shift_definition_run_id,sa.scheduling_run_id) IS NOT NULL
        AND sa.shift_date <= ($1::timestamptz AT TIME ZONE 'UTC')::date + 1
        AND NOT EXISTS (SELECT 1 FROM shift_logs sl WHERE sl.nurse_id=sa.nurse_id AND sl.shift_date=sa.shift_date)
      ORDER BY sa.shift_date,sa.id FOR UPDATE OF sa SKIP LOCKED`,
      [now.toISOString()],
    );
    const resolved = await withAssignmentShiftDefinitions(db, rows);
    const inserted = [],
      errors = [];
    for (const row of resolved) {
      const definition = row.scheduled_shift;
      if (row.shift_definition_error || !definition) {
        errors.push({
          assignmentId: row.id,
          error: row.shift_definition_error ?? "Missing shift definition",
        });
        continue;
      }
      if (Date.parse(definition.endsAt) > now.getTime()) continue;
      const code = ["M", "MWC"].includes(row.shift)
        ? "M"
        : ["N", "NC"].includes(row.shift)
          ? "N"
          : row.shift;
      const saved = await db.query(
        `INSERT INTO shift_logs
        (nurse_id,shift_date,shift_type,started_at,expected_end_at,ended_at,period_start,
         hours_logged,is_missed,is_leave,is_locum,locum_request_id,is_swap,scheduling_definition)
        SELECT $1,$2::date,$3::text,$4,$5,$5,
          COALESCE(rota_period_start($2::date),$2::date),
          0,true,false,$6::uuid IS NOT NULL,$6,false,$7::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM shift_logs WHERE nurse_id=$1 AND shift_date=$2::date)
        RETURNING nurse_id,shift_date,shift_type,scheduling_definition`,
        [
          row.nurse_id,
          row.shift_date,
          code,
          definition.startsAt,
          definition.endsAt,
          row.locum_id,
          JSON.stringify(definition),
        ],
      );
      inserted.push(...saved.rows);
    }
    await db.query("COMMIT");
    return { rows: inserted, errors };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

module.exports = { recordConfiguredMissedShifts };
