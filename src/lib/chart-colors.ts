// Fixed hue order (validated colorblind-safe) — color is assigned by entity
// identity, never by rank, so a slice or line keeps the same color no matter
// what's filtered or toggled.
export const CHART_SERIES_VARS = [
  "var(--chart-series-1)",
  "var(--chart-series-2)",
  "var(--chart-series-3)",
  "var(--chart-series-4)",
  "var(--chart-series-5)",
  "var(--chart-series-6)",
  "var(--chart-series-7)",
  "var(--chart-series-8)",
];

export const LEAVE_TYPE_ORDER = [
  "Annual",
  "Compassionate Leave",
  "Emergency",
  "Leave of Absence",
  "Maternity",
  "Public Holiday",
  "Sick",
  "Study Leave",
];

export function colorForLeaveType(type: string) {
  const idx = LEAVE_TYPE_ORDER.indexOf(type);
  return CHART_SERIES_VARS[
    idx >= 0 ? idx % CHART_SERIES_VARS.length : CHART_SERIES_VARS.length - 1
  ];
}

// Generic fixed-order color lookup for any other category set (facilities,
// wards, hours-category, etc.) — pass the full ordered key list once so color
// stays stable across re-sorts / filters.
export function colorForKey(key: string, order: string[]) {
  const idx = order.indexOf(key);
  return CHART_SERIES_VARS[idx >= 0 ? idx % CHART_SERIES_VARS.length : CHART_SERIES_VARS.length - 1];
}
