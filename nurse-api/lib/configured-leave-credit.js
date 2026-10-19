const { withAssignmentShiftDefinitions } = require("./assignment-shift-definition");

async function creditConfiguredLeave(pool, now = new Date()) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const { rows } = await db.query(
      `SELECT sa.*,sa.shift_date::text,lr.id AS leave_id
       FROM shift_assignments sa
       JOIN LATERAL (SELECT id FROM leave_requests WHERE nurse_id=sa.nurse_id
         AND status='Approved' AND type!='Swap' AND sa.shift_date BETWEEN from_date AND to_date
         ORDER BY id LIMIT 1) lr ON true
       WHERE sa.status='published' AND sa.shift='LEAVE'
         AND COALESCE(sa.shift_definition_run_id,sa.scheduling_run_id) IS NOT NULL
         AND sa.pre_leave_shift NOT IN ('OFF','LEAVE')
         AND sa.shift_date<=($1::timestamptz AT TIME ZONE 'UTC')::date+1
         AND NOT EXISTS (SELECT 1 FROM shift_logs sl WHERE sl.nurse_id=sa.nurse_id AND sl.shift_date=sa.shift_date)
       ORDER BY sa.id FOR UPDATE OF sa SKIP LOCKED`,
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
      if (Date.parse(definition.startsAt) > now.getTime()) continue;
      const { rows: credits } = await db.query(
        `INSERT INTO shift_logs
         (nurse_id,shift_date,shift_type,started_at,expected_end_at,ended_at,period_start,
          hours_logged,is_leave,is_missed,is_locum,is_swap,leave_request_id,scheduling_definition)
         SELECT $1,$2::date,$3::text,$4,$5,$5,
          COALESCE((SELECT anchor+(($2::date-anchor)/28)*28 FROM
            (SELECT MIN(shift_date)::date AS anchor FROM shift_assignments
              WHERE status='published' AND shift_date<=$2::date) cycle),$2::date),
          $6,true,false,false,false,$7,$8::jsonb
         WHERE NOT EXISTS (SELECT 1 FROM shift_logs WHERE nurse_id=$1 AND shift_date=$2::date)
         RETURNING nurse_id,hours_logged`,
        [
          row.nurse_id,
          row.shift_date,
          definition.code,
          definition.startsAt,
          definition.endsAt,
          Math.round((definition.creditedMinutes / 60) * 100) / 100,
          row.leave_id,
          JSON.stringify(definition),
        ],
      );
      for (const credit of credits) {
        if (Number(credit.hours_logged) > 0)
          await db.query("SELECT increment_nurse_hours($1,$2)", [
            credit.nurse_id,
            credit.hours_logged,
          ]);
      }
      inserted.push(...credits);
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
module.exports = { creditConfiguredLeave };
