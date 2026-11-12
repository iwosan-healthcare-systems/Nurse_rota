import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { iwosanLogo } from "@/lib/brand-assets";
import visionVideo from "@/assets/iwosan_motion_video.mp4";
import visionBulb from "@/assets/vision-icon-1-cutout.webp";
import visionRocket from "@/assets/vision-icon-2-cutout.webp";
import visionAstronaut from "@/assets/vision-icon-3-cutout.webp";

type Floater = {
  src: string;
  className: string;
  style: CSSProperties;
};

// Vision icons drifting around the brand panel, each in a soft white bubble so
// the navy astronaut still reads on the navy background.
const PANEL_FLOATERS: Floater[] = [
  {
    src: visionBulb,
    className: "top-[13%] right-[9%] h-20 w-20",
    style: { "--dur": "9s", "--dx": "-12px", "--dy": "-20px" } as CSSProperties,
  },
  {
    src: visionRocket,
    className: "top-[38%] right-[5%] h-14 w-14 hidden xl:block",
    style: { "--dur": "11s", "--delay": "-3s", "--dx": "14px", "--dy": "-26px" } as CSSProperties,
  },
  {
    src: visionAstronaut,
    className: "bottom-[4%] right-[8%] h-16 w-16",
    style: {
      "--dur": "10s",
      "--delay": "-6s",
      "--dx": "-10px",
      "--dy": "-18px",
      "--r0": "5deg",
      "--r1": "-4deg",
    } as CSSProperties,
  },
];

// Fainter icons around the sign-in side, kept to the edges away from the form.
const PAGE_FLOATERS: Floater[] = [
  {
    src: visionRocket,
    className: "top-[7%] right-[8%] h-16 w-16",
    style: { "--dur": "12s", "--delay": "-2s", "--dy": "-16px" } as CSSProperties,
  },
  {
    src: visionAstronaut,
    className: "bottom-[8%] left-[7%] h-16 w-16",
    style: { "--dur": "13s", "--delay": "-7s", "--dx": "12px" } as CSSProperties,
  },
  {
    src: visionBulb,
    className: "top-[42%] right-[4%] h-12 w-12 hidden xl:block",
    style: { "--dur": "10s", "--delay": "-4s", "--dy": "-14px" } as CSSProperties,
  },
];

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

// The looping "Our vision and values" animation, framed like a screen. It holds
// still on one frame for visitors who ask for reduced motion.
function VisionVideo({ className = "" }: { className?: string }) {
  const reduced = usePrefersReducedMotion();
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (reduced) {
      video.pause();
      video.currentTime = 5.5;
    } else void video.play().catch(() => {});
  }, [reduced]);
  return (
    <figure
      className={`overflow-hidden rounded-2xl bg-white shadow-[0_24px_60px_-20px_rgba(0,0,0,0.55)] ring-1 ring-white/20 ${className}`}
    >
      <video
        ref={ref}
        src={visionVideo}
        muted
        loop
        playsInline
        autoPlay={!reduced}
        preload="auto"
        aria-label="Iwosan Healthcare Systems: our vision and values"
        className="block aspect-[800/368] w-full object-cover"
      />
    </figure>
  );
}

function FloatingIcons({ items, bubble }: { items: Floater[]; bubble: boolean }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
      {items.map((f) => (
        <div key={f.className} className={`brand-float absolute ${f.className}`} style={f.style}>
          {bubble ? (
            <div className="grid h-full w-full place-items-center rounded-full bg-white/95 p-[18%] shadow-[0_12px_30px_-10px_rgba(0,0,0,0.5)] ring-4 ring-white/10">
              <img src={f.src} alt="" className="h-full w-full object-contain" />
            </div>
          ) : (
            <img src={f.src} alt="" className="h-full w-full object-contain opacity-[0.13]" />
          )}
        </div>
      ))}
    </div>
  );
}

const PANEL_BG =
  "bg-[#14204a] bg-[radial-gradient(60rem_40rem_at_-10%_-10%,rgba(71,182,74,0.28),transparent_60%),radial-gradient(50rem_36rem_at_110%_110%,rgba(0,175,219,0.30),transparent_60%)]";

function Footer({ className = "" }: { className?: string }) {
  return (
    <p className={`text-xs ${className}`}>
      Powered by Iwosan Healthcare Systems. <br />© {new Date().getFullYear()}. All rights reserved.
    </p>
  );
}

// The public landing layout shared by sign-in and password reset: the Iwosan
// brand panel with the vision video on the left, the page's form on the right.
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background lg:grid lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      {/* Brand panel (desktop) */}
      <section
        className={`relative hidden overflow-hidden text-white lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-14 ${PANEL_BG}`}
      >
        <FloatingIcons items={PANEL_FLOATERS} bubble />
        <img
          src={iwosanLogo}
          alt="Iwosan Healthcare Systems"
          className="relative z-10 h-10 w-auto self-start"
        />
        <div className="relative z-10 max-w-xl">
          <p className="brand-rise text-xs font-semibold uppercase tracking-[0.2em] text-[#7fd583]">
            Nurses Rota
          </p>
          <h1
            className="brand-rise mt-3 text-4xl font-bold leading-tight xl:text-5xl"
            style={{ "--delay": "80ms" } as CSSProperties}
          >
            Safer staffing, automated.
          </h1>
          <p
            className="brand-rise mt-4 max-w-md text-base text-white/75"
            style={{ "--delay": "160ms" } as CSSProperties}
          >
            Automated rota generation, ward safety rules, leave management and a layered approval
            workflow, built for nursing teams.
          </p>
          <div className="mt-9">
            <VisionVideo />
          </div>
        </div>
        <Footer className="relative z-10 text-white/55" />
      </section>

      {/* Brand header (phones and tablets) */}
      <header
        className={`relative overflow-hidden px-5 pb-8 pt-6 text-white lg:hidden ${PANEL_BG}`}
      >
        <FloatingIcons
          items={[
            { ...PANEL_FLOATERS[0], className: "top-5 right-4 h-12 w-12" },
            { ...PANEL_FLOATERS[2], className: "top-24 right-[22%] h-10 w-10 hidden sm:block" },
          ]}
          bubble
        />
        <img
          src={iwosanLogo}
          alt="Iwosan Healthcare Systems"
          className="relative z-10 h-8 w-auto"
        />
        <h1 className="relative z-10 mt-6 max-w-[16rem] text-2xl font-bold leading-tight sm:max-w-none">
          Safer staffing, automated.
        </h1>
        <VisionVideo className="relative z-10 mx-auto mt-5 max-w-md" />
      </header>

      {/* Form side */}
      <main className="relative flex items-center justify-center px-4 py-10 sm:px-6 lg:min-h-screen">
        <div className="hidden lg:block">
          <FloatingIcons items={PAGE_FLOATERS} bubble={false} />
        </div>
        <div className="brand-rise relative z-10 w-full max-w-sm">
          {children}
          <Footer className="mt-10 text-center text-muted-foreground lg:hidden" />
        </div>
      </main>
    </div>
  );
}
