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
    SELECT period_start::text, period_end::text
    FROM periods
    WHERE close_at <= NOW()
      AND NOT EXISTS (
        SELECT 1 FROM shift_logs sl
        WHERE sl.shift_date BETWEEN periods.period_start AND periods.period_end
          AND sl.ended_at IS NULL
          AND sl.expected_end_at <= NOW()
      )
      AND NOT EXISTS (
        SELECT 1 FROM nurse_period_hours nph
        WHERE nph.period_start = periods.period_start
      )
    ORDER BY period_end DESC
    LIMIT 1
  `);

  if (!periodRows[0]) return { closed: false, period_start: null, period_end: null };
  const { period_start, period_end } = periodRows[0];

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

    await client.query(
      "UPDATE nurses SET hours_this_month = 0, updated_at = NOW() WHERE id = ANY($1)",
      [hoursRows.map((row) => row.nurse_id)],
    );
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
