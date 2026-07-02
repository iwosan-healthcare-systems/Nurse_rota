// Geo-fence configuration for all facility locations.
// Each facility key matches the `facility` field stored on nurse records.
// Ikeja has two campuses — the nearest one is used for distance checking.
export const FACILITY_LOCATIONS: Record<string, { lat: number; lng: number; label: string }[]> = {
  Ikeja: [
    { lat: 6.6044, lng: 3.3458, label: "Ikeja — 91 Obafemi Awolowo Way" },
    { lat: 6.6153343, lng: 3.3458773, label: "Ikeja — 91 Adeniyi Jones, Ogba" },
  ],
  Ikoyi: [{ lat: 6.4531, lng: 3.4329, label: "Ikoyi — 17B Bourdillon Road" }],
  Ligali: [{ lat: 6.428565, lng: 3.44097, label: "Ligali — 3B Ligali Ayorinde Street" }],
};

// Nurses must be within this distance of their own facility to clock in.
// 1000 m keeps each facility isolated — the closest pair (Ikoyi / Ligali) are ~2.9 km apart,
// and the two Ikeja campuses are ~1.2 km apart (nearestLocation picks the closer one).
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
): { distanceM: number; label: string } | null {
  const locs = FACILITY_LOCATIONS[facility];
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
): Promise<{ lat: number; lng: number; ip: string | null }> {
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
          const nearest = nearestLocation(facility, lat, lng);
          if (!nearest) {
            reject(
              new Error(`No location configured for "${facility}". Contact your administrator.`),
            );
            return;
          }
          if (nearest.distanceM > GEO_FENCE_RADIUS_M) {
            reject(
              new Error(
                `You are ${nearest.distanceM}m from ${nearest.label} — must be within ${GEO_FENCE_RADIUS_M}m to start your shift.`,
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
