import { useState } from "react";
import { PieChart as PieChartIcon, BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";

export type CategoryDatum = { key: string; label: string; value: number; color: string };

function DefaultTooltip({
  active,
  payload,
  total,
  valueLabel,
  formatValue,
}: {
  active?: boolean;
  payload?: { payload: CategoryDatum }[];
  total: number;
  valueLabel: string;
  formatValue: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const pct = total > 0 ? Math.round((d.value / total) * 100) : 0;
  return (
    <div className="bg-popover border rounded-lg px-3 py-2 shadow-md text-xs">
      <p className="font-medium">{d.label}</p>
      <p className="text-muted-foreground">
        {formatValue(d.value)} {valueLabel} · {pct}%
      </p>
    </div>
  );
}

// Reusable donut/bar category-breakdown card — shared shape used across the
// dashboard and Reports Overview so every "X by category" widget behaves and
// looks the same (fixed color-by-identity, toggle, table-equivalent legend).
export function CategoryChartCard({
  title,
  subtitle,
  data,
  emptyMessage,
  valueLabel = "",
  formatValue = (v) => String(v),
  defaultView = "donut",
  headerExtra,
}: {
  title: string;
  subtitle?: string;
  data: CategoryDatum[];
  emptyMessage: string;
  valueLabel?: string;
  formatValue?: (v: number) => string;
  defaultView?: "donut" | "bar";
  headerExtra?: React.ReactNode;
}) {
  const [view, setView] = useState<"donut" | "bar">(defaultView);
  const total = data.reduce((sum, d) => sum + d.value, 0);

  return (
    <div className="bg-card border rounded-xl p-5 shadow-soft">
      <div className="flex items-center justify-between mb-4 gap-2">
        <div>
          <h2 className="font-semibold">{title}</h2>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          {headerExtra}
          <div className="flex items-center rounded-md border overflow-hidden shrink-0">
            <button
              type="button"
              onClick={() => setView("donut")}
              title="Donut view"
              aria-label="Donut view"
              className={cn(
                "h-8 w-8 grid place-items-center transition-colors",
                view === "donut" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
              )}
            >
              <PieChartIcon className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setView("bar")}
              title="Bar view"
              aria-label="Bar view"
              className={cn(
                "h-8 w-8 grid place-items-center transition-colors border-l",
                view === "bar" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
              )}
            >
              <BarChart3 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {total === 0 ? (
        <div className="h-64 flex items-center justify-center">
          <p className="text-sm text-muted-foreground text-center">{emptyMessage}</p>
        </div>
      ) : view === "bar" ? (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
              <XAxis
                type="number"
                allowDecimals={false}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                axisLine={{ stroke: "var(--border)" }}
                tickLine={false}
              />
              <YAxis
                type="category"
                dataKey="label"
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                axisLine={false}
                tickLine={false}
                width={110}
              />
              <Tooltip
                content={<DefaultTooltip total={total} valueLabel={valueLabel} formatValue={formatValue} />}
                cursor={{ fill: "var(--muted)" }}
              />
              <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={16}>
                {data.map((d) => (
                  <Cell key={d.key} fill={d.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:h-64 sm:justify-center">
          <div className="h-44 w-44 sm:h-52 sm:w-52 shrink-0 mx-auto sm:mx-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="label"
                  innerRadius="60%"
                  outerRadius="90%"
                  paddingAngle={2}
                  stroke="var(--card)"
                  strokeWidth={2}
                >
                  {data.map((d) => (
                    <Cell key={d.key} fill={d.color} />
                  ))}
                </Pie>
                <Tooltip content={<DefaultTooltip total={total} valueLabel={valueLabel} formatValue={formatValue} />} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="min-w-0 w-full sm:w-52 space-y-2 sm:max-h-52 sm:overflow-y-auto pr-1">
            {data.map((d) => (
              <div key={d.key} className="flex items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2 min-w-0">
                  <span className="h-3 w-3 rounded-full shrink-0" style={{ backgroundColor: d.color }} />
                  <span className="truncate">{d.label}</span>
                </span>
                <span className="text-muted-foreground tabular-nums shrink-0">
                  {formatValue(d.value)} · {total > 0 ? Math.round((d.value / total) * 100) : 0}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
