export function rotaToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const ymdParts = (d: string) => d.slice(0, 10).split("-").map(Number);

/** "January 2027" for a calendar-month period, otherwise "5 Jan – 31 Jan 2027". */
export function rotaPeriodLabel(start: string, end: string): string {
  const [sy, sm, sd] = ymdParts(start);
  const [ey, em, ed] = ymdParts(end);
  const monthEnd = new Date(Date.UTC(sy, sm, 0)).getUTCDate();
  const s = new Date(Date.UTC(sy, sm - 1, sd));
  if (sd === 1 && sy === ey && sm === em && ed === monthEnd)
    return s.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const e = new Date(Date.UTC(ey, em - 1, ed));
  const short: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", timeZone: "UTC" };
  return `${s.toLocaleDateString("en-GB", short)} – ${e.toLocaleDateString("en-GB", { ...short, year: "numeric" })}`;
}

/** Shift a YYYY-MM-DD date by whole days. */
export function addDaysYmd(date: string, days: number): string {
  const [y, m, d] = ymdParts(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// Period ends seen in rows fetched with include_period=true, keyed by period start.
const knownPeriodEnds = new Map<string, string>();

export function rememberRotaPeriod(start?: string | null, end?: string | null) {
  if (start && end) knownPeriodEnds.set(start.slice(0, 10), end.slice(0, 10));
}

/**
 * Last day of the rota period starting on `start`. Uses the server's answer when
 * one has been seen; otherwise a period starting on the 1st runs to month end
 * and any other start is a legacy 28-day period.
 */
export function rotaPeriodEndFor(start: string): string {
  const key = start.slice(0, 10);
  const known = knownPeriodEnds.get(key);
  if (known) return known;
  const [y, m, d] = ymdParts(key);
  return d === 1 ? new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) : addDaysYmd(key, 27);
}
