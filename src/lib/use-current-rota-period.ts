import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { rotaToday } from "@/lib/rota-window";

export type RotaPeriod = { start: string; end: string };

/** The rota period (a calendar month, or a legacy 28-day period) containing `date`. */
export function fetchRotaPeriod(date: string): Promise<RotaPeriod> {
  return api.get<RotaPeriod>(`/rpc/rota-period?date=${date.slice(0, 10)}`);
}

export function useRotaPeriod(date: string | null | undefined) {
  return useQuery({
    queryKey: ["rota-period", date?.slice(0, 10)],
    enabled: !!date,
    staleTime: 5 * 60 * 1000,
    queryFn: () => fetchRotaPeriod(date!),
  });
}

/** Calendar boundaries shared by live shift totals and reports. */
export function useCurrentRotaPeriod() {
  return useQuery({
    queryKey: ["current-rota-period"],
    refetchInterval: 30_000,
    queryFn: () => fetchRotaPeriod(rotaToday()),
  });
}
