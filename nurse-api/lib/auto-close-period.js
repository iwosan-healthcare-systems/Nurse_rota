const pool = require("../db");

async function closeCompletedPeriod() {
  const { rows: periodRows } = await pool.query(`
    WITH published AS (
      SELECT
        shift_date::date AS d,
        CASE WHEN shift IN ('N', 'NC')
          THEN (shift_date::timestamp + INTERVAL '1 day 8 hours') AT TIME ZONE 'Africa/Lagos'
          ELSE (shift_date::timestamp + INTERVAL '17 hours') AT TIME ZONE 'Africa/Lagos'
        END AS close_at
      FROM shift_assignments
      WHERE status = 'published'
    ),
    anchored AS (
      SELECT d, close_at, MIN(d) OVER () AS anchor FROM published
    ),
    bucketed AS (
      SELECT d, close_at, (d - anchor) / 28 AS bucket FROM anchored
    ),
    periods AS (
      SELECT MIN(d) AS period_start, MAX(d) AS period_end, MAX(close_at) AS close_at
      FROM bucketed
      GROUP BY bucket
    )
        SELECT periods.period_start::text, periods.period_end::text,
          MAX(nph.period_end)::text AS archived_period_end
    FROM periods
        LEFT JOIN nurse_period_hours nph ON nph.period_start = periods.period_start
    WHERE close_at <= NOW()
      AND NOT EXISTS (
        SELECT 1 FROM shift_logs sl
        WHERE sl.shift_date BETWEEN periods.period_start AND periods.period_end
          AND sl.ended_at IS NULL
          AND sl.expected_end_at <= NOW()
      )
    GROUP BY periods.period_start, periods.period_end, periods.close_at
    ORDER BY period_end DESC
    LIMIT 1
  `);

  if (!periodRows[0]) return { closed: false, period_start: null, period_end: null };
  const { period_start, period_end, archived_period_end } = periodRows[0];
  const alreadyArchived = !!archived_period_end;

  // Repair logs created by older clients that used the trailing 28-day
  // lookback. The assignment date is authoritative: every log in the closed
  // window belongs to its period start, and the following window starts next.
  const nextPeriodStart = new Date(period_end + "T00:00:00Z");
  nextPeriodStart.setUTCDate(nextPeriodStart.getUTCDate() + 1);
  const nextPeriodEnd = new Date(nextPeriodStart);
  nextPeriodEnd.setUTCDate(nextPeriodEnd.getUTCDate() + 27);
  const repaired = await pool.query(
    `UPDATE shift_logs
        SET period_start = CASE
          WHEN shift_date BETWEEN $1::date AND $2::date THEN $1::date
          ELSE $3::date
        END
      WHERE shift_date BETWEEN $1::date AND $4::date
        AND period_start IS DISTINCT FROM CASE
          WHEN shift_date BETWEEN $1::date AND $2::date THEN $1::date
          ELSE $3::date
        END`,
    [
      period_start,
      period_end,
      nextPeriodStart.toISOString().slice(0, 10),
      nextPeriodEnd.toISOString().slice(0, 10),
    ],
  );
  if (archived_period_end === period_end) {
    return repaired.rowCount
      ? { closed: true, period_start, period_end }
      : { closed: false, period_start: null, period_end: null };
  }

  const { rows: hoursRows } = await pool.query(
    `
    SELECT n.id AS nurse_id, COALESCE(h.total_hours, 0) AS total_hours,
           COALESCE(h.total_shifts, 0) AS total_shifts
    FROM nurses n
    LEFT JOIN (
      SELECT nurse_id,
             ROUND(SUM(hours_logged) * 100) / 100 AS total_hours,
             COUNT(*) FILTER (WHERE hours_logged > 0 AND NOT is_missed)::int AS total_shifts
      FROM shift_logs
      WHERE shift_date BETWEEN $1 AND $2
        AND is_locum = false AND is_swap = false
        AND ended_at IS NOT NULL AND hours_logged IS NOT NULL
      GROUP BY nurse_id
    ) h ON h.nurse_id = n.id
    `,
    [period_start, period_end],
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of hoursRows) {
      await client.query(
        `INSERT INTO nurse_period_hours
          (nurse_id, period_start, period_end, total_hours, total_shifts)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (nurse_id, period_start) DO UPDATE
         SET period_end = EXCLUDED.period_end,
             total_hours = EXCLUDED.total_hours,
             total_shifts = EXCLUDED.total_shifts`,
        [period_start, period_end, row.total_hours, row.total_shifts],
      );
    }

    if (!alreadyArchived) {
      await client.query(
        "UPDATE nurses SET hours_this_month = 0, updated_at = NOW() WHERE id = ANY($1)",
        [hoursRows.map((row) => row.nurse_id)],
      );
    }
    await client.query(
      `INSERT INTO audit_logs (actor_name, action, target)
       VALUES ('system', 'Period auto-closed', $1)`,
      [`${period_start} → ${period_end} · ${hoursRows.length} nurse(s) archived`],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return { closed: true, period_start, period_end };
}

module.exports = { closeCompletedPeriod };
