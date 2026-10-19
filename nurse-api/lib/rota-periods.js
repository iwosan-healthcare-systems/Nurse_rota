// Rota period boundaries come from the database functions rota_period_start /
// rota_period_end (migration 053): calendar months, after any 28-day periods a
// hospital already had. Callers must run inside a hospital's context.
async function periodFor(db, date) {
  const {
    rows: [row],
  } = await db.query(
    "SELECT rota_period_start($1::date)::text AS start, rota_period_end($1::date)::text AS end",
    [String(date).slice(0, 10)],
  );
  return row?.start ? { start: row.start, end: row.end } : null;
}

function daysInclusive(start, end) {
  return Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
}

module.exports = { periodFor, daysInclusive };
