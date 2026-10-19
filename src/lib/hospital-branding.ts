import { useQuery } from "@tanstack/react-query";
import { api, getToken } from "@/lib/api";
import appLogo from "@/assets/logo.jpeg";

export type MyHospitals = {
  hospitals: { id: string; name: string }[];
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

// The current hospital's logo and name; the application's logo when it has none.
export function useHospitalBranding() {
  const { data } = useMyHospitals();
  const current = data?.hospitals.find((h) => h.id === data.current_hospital_id);
  return {
    logo: data?.current_logo || appLogo,
    name: current?.name ?? "Nurses Rota",
    hasOwnLogo: !!data?.current_logo,
  };
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
