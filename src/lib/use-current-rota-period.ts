import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { currentRotaStart, rotaToday } from "@/lib/rota-window";

/** Calendar boundaries shared by live shift totals and reports. */
export function useCurrentRotaPeriod() {
  return useQuery({
    queryKey: ["current-rota-period"],
    refetchInterval: 30_000,
    queryFn: async () => {
      const rows = await api.get<{ shift_date: string }[]>(
        "/shift-assignments?status=published&limit=1",
      );
      const today = rotaToday();
      const start = currentRotaStart(rows[0]?.shift_date ?? today, today);
      const end = new Date(start + "T00:00:00Z");
      end.setUTCDate(end.getUTCDate() + 27);
      return { start, end: end.toISOString().slice(0, 10) };
    },
  });
}
