const pool = require("../db");

async function closeCompletedPeriod() {
  const client = await pool.connect();
  const empty = { closed: false, period_start: null, period_end: null };
  try {
    await client.query("BEGIN");
    // Both manual and cron closure share these locks with the shift finalizer.
    const { rows: locks } = await client.query(
      "SELECT pg_try_advisory_xact_lock(729313) AND pg_try_advisory_xact_lock(729312) AS locked",
    );
    if (!locks[0].locked) {
      await client.query("ROLLBACK");
      return empty;
    }
    const { rows: periodRows } = await client.query(`
      WITH published AS (
        SELECT shift_date::date AS d,
          CASE WHEN shift IN ('N', 'NC')
            THEN (shift_date::timestamp + INTERVAL '1 day 8 hours') AT TIME ZONE 'Africa/Lagos'
            ELSE (shift_date::timestamp + INTERVAL '17 hours') AT TIME ZONE 'Africa/Lagos'
          END AS close_at
        FROM shift_assignments WHERE status = 'published'
      ), anchored AS (
        SELECT d, close_at, MIN(d) OVER () AS anchor FROM published
      ), bucketed AS (
        SELECT d, close_at, anchor + ((d - anchor) / 28) * 28 AS period_start
        FROM anchored
      ), periods AS (
        SELECT period_start, period_start + 27 AS period_end,
          GREATEST(MAX(close_at),
            (period_start + 28)::timestamp AT TIME ZONE 'Africa/Lagos') AS close_at
        FROM bucketed GROUP BY period_start
      )
      SELECT periods.period_start::text, periods.period_end::text
      FROM periods
      WHERE close_at <= NOW()
        AND NOT EXISTS (
          SELECT 1 FROM shift_logs sl
          WHERE sl.shift_date BETWEEN periods.period_start AND periods.period_end
            AND sl.ended_at IS NULL
            AND (sl.expected_end_at IS NULL OR sl.expected_end_at > NOW())
        )
        AND NOT EXISTS (
          SELECT 1 FROM nurse_period_hours nph
          WHERE nph.period_start = periods.period_start
            AND nph.period_end = periods.period_end
        )
      ORDER BY periods.period_end ASC
      LIMIT 1
    `);
    if (!periodRows[0]) {
      await client.query("COMMIT");
      return empty;
    }
    const { period_start, period_end } = periodRows[0];

    // Finalize overdue logs instead of waiting indefinitely for another job.
    // The archive and live counters below include these hours atomically.
    await client.query(
      `UPDATE shift_logs
       SET ended_at = expected_end_at,
           hours_logged = GREATEST(0, ROUND(
             EXTRACT(EPOCH FROM (expected_end_at - started_at)) / 3600 * 100
           ) / 100)
       WHERE shift_date BETWEEN $1::date AND $2::date
         AND ended_at IS NULL AND expected_end_at <= NOW()`,
      [period_start, period_end],
    );
    await client.query(
      `UPDATE shift_logs SET period_start = $1::date
       WHERE shift_date BETWEEN $1::date AND $2::date
         AND period_start IS DISTINCT FROM $1::date`,
      [period_start, period_end],
    );
    const { rows: hoursRows } = await client.query(
      `SELECT n.id AS nurse_id, COALESCE(h.total_hours, 0) AS total_hours,
              COALESCE(h.total_shifts, 0) AS total_shifts
       FROM nurses n
       LEFT JOIN (
         SELECT nurse_id, ROUND(SUM(hours_logged) * 100) / 100 AS total_hours,
                COUNT(*) FILTER (WHERE hours_logged > 0 AND NOT is_missed)::int AS total_shifts
         FROM shift_logs
         WHERE shift_date BETWEEN $1 AND $2
           AND is_locum = false AND is_swap = false
           AND ended_at IS NOT NULL AND hours_logged IS NOT NULL
         GROUP BY nurse_id
       ) h ON h.nurse_id = n.id`,
      [period_start, period_end],
    );
    for (const row of hoursRows) {
      await client.query(
        `INSERT INTO nurse_period_hours
          (nurse_id, period_start, period_end, total_hours, total_shifts)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (nurse_id, period_start) DO UPDATE
         SET period_end = EXCLUDED.period_end, total_hours = EXCLUDED.total_hours,
             total_shifts = EXCLUDED.total_shifts`,
        [row.nurse_id, period_start, period_end, row.total_hours, row.total_shifts],
      );
    }
    // A delayed close must preserve hours already earned in the new period.
    await client.query(
      `UPDATE nurses n SET hours_this_month = COALESCE((
         SELECT ROUND(SUM(sl.hours_logged) * 100) / 100 FROM shift_logs sl
         WHERE sl.nurse_id = n.id
           AND sl.shift_date > (SELECT MAX(period_end) FROM nurse_period_hours)
           AND sl.is_locum = false AND sl.is_swap = false
           AND sl.ended_at IS NOT NULL
       ), 0), updated_at = NOW()
       WHERE n.id = ANY($1)`,
      [hoursRows.map((row) => row.nurse_id)],
    );
    await client.query(
      `INSERT INTO audit_logs (actor_name, action, target)
       VALUES ('system', 'Period auto-closed', $1)`,
      [`${period_start} → ${period_end} · ${hoursRows.length} nurse(s) archived`],
    );
    await client.query("COMMIT");
    return { closed: true, period_start, period_end };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { closeCompletedPeriod };
