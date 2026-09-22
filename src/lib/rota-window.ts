/** Advance a known rota boundary without depending on period-hours archiving. */
export function currentRotaStart(anchor: string, today: string): string {
  const start = Date.parse(anchor.slice(0, 10) + "T00:00:00Z");
  const now = Date.parse(today.slice(0, 10) + "T00:00:00Z");
  const periodMs = 28 * 86400000;
  const elapsed = Math.max(0, Math.floor((now - start) / periodMs));
  return new Date(start + elapsed * periodMs).toISOString().slice(0, 10);
}

export function rotaToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
