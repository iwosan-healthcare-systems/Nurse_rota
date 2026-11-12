import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, getToken, getHospitalId } from "@/lib/api";
import { defaultHospitalLogo } from "@/lib/brand-assets";

// Each hospital's logo and name, remembered in this browser so that after a
// reload (signing in, switching hospital) the sidebar shows the right logo
// straight away instead of a placeholder that then changes.
const BRANDING_CACHE_KEY = "nurse_rota_hospital_branding";
const BRANDING_CACHE_SIZE = 6;
type CachedBranding = { logo: string | null; name: string };

function readBrandingCache(): Record<string, CachedBranding> {
  try {
    return JSON.parse(localStorage.getItem(BRANDING_CACHE_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

export function rememberHospitalBranding(hospitalId: string, branding: CachedBranding) {
  try {
    const cache = readBrandingCache();
    delete cache[hospitalId];
    cache[hospitalId] = branding;
    const ids = Object.keys(cache);
    for (const id of ids.slice(0, Math.max(0, ids.length - BRANDING_CACHE_SIZE))) delete cache[id];
    localStorage.setItem(BRANDING_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Storage full or blocked: the logo still loads, just after a moment.
  }
}

// Loads a hospital's logo and name into the cache before the app reloads into it.
export async function preloadHospitalBranding() {
  try {
    const mine = await api.get<MyHospitals>("/hospitals/mine");
    const current = mine.hospitals.find((h) => h.id === mine.current_hospital_id);
    rememberHospitalBranding(mine.current_hospital_id, {
      logo: mine.current_logo,
      name: current?.name ?? "Nurses Rota",
    });
  } catch {
    // Not fatal: the hospital loads normally after the reload.
  }
}

export type MyHospitals = {
  hospitals: { id: string; name: string; is_active?: boolean }[];
  current_hospital_id: string;
  current_logo: string | null;
  is_super_admin: boolean;
};

// The hospitals this user can work in, the current one and its logo.
export function useMyHospitals(enabled = true) {
  return useQuery({
    queryKey: ["my-hospitals"],
    enabled: enabled && !!getToken(),
    staleTime: 5 * 60 * 1000,
    queryFn: () => api.get<MyHospitals>("/hospitals/mine"),
  });
}

// The current hospital's logo and name. Without its own logo, Lagoon shows the
// Lagoon logo and every other hospital the Iwosan mark. `logo` is null only
// while a hospital this browser has never shown is still loading; callers show
// a neutral placeholder then, never another hospital's logo.
export function useHospitalBranding() {
  const { data } = useMyHospitals();
  const current = data?.hospitals.find((h) => h.id === data.current_hospital_id);
  useEffect(() => {
    if (data)
      rememberHospitalBranding(data.current_hospital_id, {
        logo: data.current_logo,
        name: current?.name ?? "Nurses Rota",
      });
  }, [data, current?.name]);
  if (data)
    return {
      logo: data.current_logo || defaultHospitalLogo(data.current_hospital_id),
      name: current?.name ?? "Nurses Rota",
    };
  const id = getHospitalId();
  const cached = id ? readBrandingCache()[id] : undefined;
  return cached
    ? { logo: cached.logo || defaultHospitalLogo(id), name: cached.name }
    : { logo: null, name: "" };
}

const MAX_DATA_URL = 550_000;
const MAX_SIDE = 512;

// Reads an uploaded logo into a data URL. Photos are scaled down to at most
// 512px on the longest side; SVG files are kept as they are.
export async function readLogoFile(file: File): Promise<string> {
  const allowed = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];
  if (!allowed.includes(file.type)) throw new Error("Choose a PNG, JPEG, WebP or SVG image");
  const asDataUrl = () =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Could not read the image"));
      reader.readAsDataURL(file);
    });
  if (file.type === "image/svg+xml") {
    const svg = await asDataUrl();
    if (svg.length > MAX_DATA_URL) throw new Error("This SVG is too large; use one under 400 KB");
    return svg;
  }
  const source = await asDataUrl();
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not read the image"));
    img.src = source;
  });
  const scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
  const png = canvas.toDataURL("image/png");
  const result = png.length <= MAX_DATA_URL ? png : canvas.toDataURL("image/jpeg", 0.85);
  if (result.length > MAX_DATA_URL) throw new Error("This image is too large; try a smaller file");
  return result;
}
