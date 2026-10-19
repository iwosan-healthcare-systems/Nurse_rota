// Runs inside leave approval's transaction, using the attendance snapshot.
async function closeConfiguredAttendanceForLeave(db, leave, periodForDate) {
  const { rows } = await db.query(
    `UPDATE shift_logs SET ended_at=NOW(),
       hours_logged=configured_attendance_hours(scheduling_definition,started_at,NOW())
     WHERE nurse_id=$1 AND shift_date BETWEEN $2 AND $3 AND ended_at IS NULL
       AND scheduling_definition IS NOT NULL AND NOT is_locum AND NOT is_swap AND NOT is_leave
     RETURNING id,shift_date::text,hours_logged,scheduling_definition`,
    [leave.nurse_id, leave.from_date, leave.to_date],
  );
  const { rows: previouslyClosed } = await db.query(
    `SELECT id,shift_date::text,hours_logged,scheduling_definition FROM shift_logs sl
     WHERE nurse_id=$1 AND shift_date BETWEEN $2 AND $3 AND ended_at IS NOT NULL
       AND scheduling_definition IS NOT NULL AND NOT is_locum AND NOT is_swap
       AND NOT is_leave AND NOT is_missed AND NOT (id=ANY($4::uuid[]))
       AND NOT EXISTS (SELECT 1 FROM shift_logs credit WHERE credit.nurse_id=sl.nurse_id
         AND credit.shift_date=sl.shift_date AND credit.is_leave)
     ORDER BY id FOR UPDATE OF sl`,
    [leave.nurse_id, leave.from_date, leave.to_date, rows.map((row) => row.id)],
  );
  const newlyClosed = new Set(rows.map((row) => row.id));
  const all = [...rows, ...previouslyClosed];
  const dates = new Set();
  for (const log of all) {
    if (
      dates.has(log.shift_date) ||
      log.hours_logged === null ||
      !Number.isFinite(Number(log.hours_logged))
    ) {
      const error = new Error(
        `Configured attendance on ${log.shift_date} requires review before leave credit`,
      );
      error.code = "CONFIGURED_EDIT_INVALID";
      throw error;
    }
    dates.add(log.shift_date);
  }
  let total = 0;
  for (const log of all) {
    const definition = log.scheduling_definition;
    const worked = Number(log.hours_logged);
    const remaining = Math.max(
      0,
      Math.round((Number(definition.creditedMinutes) / 60 - worked) * 100) / 100,
    );
    if (newlyClosed.has(log.id)) total += worked;
    // Keep a zero marker too, so scheduled leave credit cannot credit this date again.
    const { rows: credits } = await db.query(
      `INSERT INTO shift_logs
        (nurse_id,shift_date,shift_type,started_at,expected_end_at,ended_at,period_start,
         hours_logged,is_leave,is_missed,is_locum,is_swap,leave_request_id,scheduling_definition)
       SELECT $1,$2::date,$3::text,$4::timestamptz,$5::timestamptz,$5::timestamptz,$6::date,
         $7,true,false,false,false,$8,$9::jsonb
       WHERE NOT EXISTS (SELECT 1 FROM shift_logs WHERE nurse_id=$1 AND shift_date=$2::date AND is_leave)
       RETURNING hours_logged`,
      [
        leave.nurse_id,
        log.shift_date,
        definition.code,
        definition.startsAt,
        definition.endsAt,
        await periodForDate(log.shift_date, log.shift_date),
        remaining,
        leave.id,
        JSON.stringify(definition),
      ],
    );
    total += credits.reduce((sum, row) => sum + Number(row.hours_logged), 0);
  }
  if (total > 0) await db.query("SELECT increment_nurse_hours($1,$2)", [leave.nurse_id, total]);
  return { closed: rows.length, creditedHours: total };
}
module.exports = { closeConfiguredAttendanceForLeave };
