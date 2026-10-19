const { withAssignmentShiftDefinitions } = require("./assignment-shift-definition");

async function withPeriodAssignedHours(db, periods) {
  if (!periods.length) return periods;
  const keyDate = (value) =>
    value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  const keys = periods.map((p, index) => ({
    index,
    nurse_id: p.nurse_id,
    start: keyDate(p.period_start),
    end: keyDate(p.period_end),
  }));
  const { rows } = await db.query(
    `SELECT sa.*,sa.shift_date::text,p.index AS period_index
    FROM jsonb_to_recordset($1::jsonb) AS p(index integer,nurse_id uuid,start date,"end" date)
    JOIN shift_assignments sa ON sa.nurse_id=p.nurse_id
      AND sa.shift_date BETWEEN p.start AND p."end" AND sa.status='published'`,
    [JSON.stringify(keys)],
  );
  const resolved = await withAssignmentShiftDefinitions(db, rows);
  const totals = periods.map(() => ({ minutes: 0, error: null }));
  for (const row of resolved) {
    const total = totals[row.period_index];
    if (row.shift_definition_error)
      total.error = "Scheduled hours unavailable: a saved shift definition needs review";
    else total.minutes += row.scheduled_shift?.creditedMinutes ?? 0;
  }
  return periods.map((period, index) => ({
    ...period,
    assigned_hours: totals[index].error
      ? null
      : Math.round((totals[index].minutes / 60) * 100) / 100,
    assigned_hours_error: totals[index].error,
  }));
}
module.exports = { withPeriodAssignedHours };
