export type FacilityLocation = { lat: number; lng: number; label: string };

export type GpsSettings = {
  radius_m: number;
  facilities: Record<string, FacilityLocation[]>;
};

// Each hospital's sites and their GPS locations come from its own gps_settings
// (entered when the hospital is set up; keys match nurses.facility). There is
// no built-in site list: a site without a saved location cannot be clocked into.

// Default distance offered when entering a new fence radius.
export const GEO_FENCE_RADIUS_M = 1000;

function haversineMetres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function nearestLocation(
  facility: string,
  lat: number,
  lng: number,
  facilityLocations?: Record<string, FacilityLocation[]>,
): { distanceM: number; label: string } | null {
  const locs = facilityLocations?.[facility];
  if (!locs?.length) return null;
  let best: { distanceM: number; label: string } | null = null;
  for (const loc of locs) {
    const d = haversineMetres(lat, lng, loc.lat, loc.lng);
    if (!best || d < best.distanceM) best = { distanceM: Math.round(d), label: loc.label };
  }
  return best;
}

/** Resolves with {lat, lng, ip} or rejects with a user-facing error message. */
export async function verifyLocationAndCaptureIp(
  facility: string | null,
  gpsSettings?: GpsSettings | null,
): Promise<{ lat: number; lng: number; ip: string | null }> {
  const radiusM = gpsSettings?.radius_m ?? GEO_FENCE_RADIUS_M;
  const facilityLocations = gpsSettings?.facilities;

  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Your browser does not support GPS. Cannot verify location."));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude: lat, longitude: lng } = position.coords;

        // Fence check (skip only when no facility is configured).
        if (facility) {
          const nearest = nearestLocation(facility, lat, lng, facilityLocations);
          if (!nearest) {
            reject(
              new Error(`No location configured for "${facility}". Contact your administrator.`),
            );
            return;
          }
          if (nearest.distanceM > radiusM) {
            reject(
              new Error(
                `You are ${nearest.distanceM}m from ${nearest.label} — must be within ${radiusM}m to start your shift.`,
              ),
            );
            return;
          }
        }

        // Capture public IP — non-fatal if it fails.
        let ip: string | null = null;
        try {
          const res = await Promise.race([
            fetch("https://api.ipify.org?format=json").then(
              (r) => r.json() as Promise<{ ip: string }>,
            ),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000)),
          ]);
          ip = res.ip;
        } catch {
          // IP capture failure is silent — location check already passed.
        }

        resolve({ lat, lng, ip });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          reject(
            new Error(
              "Location access was denied. Enable GPS in your browser settings and try again.",
            ),
          );
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          reject(
            new Error(
              "Your location could not be determined. Check your GPS signal and try again.",
            ),
          );
        } else {
          reject(new Error("Location request timed out. Check your GPS signal and try again."));
        }
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  });
}
