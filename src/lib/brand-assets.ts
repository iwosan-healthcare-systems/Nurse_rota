import lagoonLogo from "@/assets/logo.jpeg";
import iwosanIcon from "@/assets/iwosan_icon.webp";
import iwosanLogo from "@/assets/iwosan_logo.webp";
import { LAGOON_HOSPITAL_ID } from "@/lib/scheduling-configuration";

// The website's own brand: the Iwosan wordmark (white lettering, so it needs a
// dark background) and the square Iwosan mark.
export { iwosanIcon, iwosanLogo };

// The square logo shown for a hospital that has not uploaded its own. The
// Lagoon logo belongs to Lagoon Hospitals only; every other hospital falls
// back to the Iwosan mark.
export function defaultHospitalLogo(hospitalId?: string | null): string {
  return hospitalId === LAGOON_HOSPITAL_ID ? lagoonLogo : iwosanIcon;
}
