import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

// Facility (site) names of the hospital being worked in: its GPS sites, wards
// and staff. Each hospital has its own sites, so nothing here is hard-coded.
export function useHospitalFacilities(): string[] {
  const { data } = useQuery({
    queryKey: ["hospital-facilities"],
    staleTime: 60 * 1000,
    queryFn: () => api.get<{ facilities: string[] }>("/hospitals/current/facilities"),
  });
  return data?.facilities ?? [];
}
