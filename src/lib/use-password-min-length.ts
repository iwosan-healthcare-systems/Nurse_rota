import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

// Admin-configurable via System Settings (default 8) — shared by every
// password-setting form so the client-side hint/validation never disagrees
// with what the backend will actually accept. Cached across every caller
// under the same query key, so using this in several forms on the same page
// is still just one network request.
export function usePasswordMinLength(): number {
  const { data } = useQuery({
    queryKey: ["password-min-length"],
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      api
        .get<{ value: number }>("/portal-settings/min_password_length")
        .then(({ value }) => (typeof value === "number" && value > 0 ? value : 8))
        .catch(() => 8),
  });
  return data ?? 8;
}
