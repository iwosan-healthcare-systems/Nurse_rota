import { useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";
import { useIsFetching } from "@tanstack/react-query";

/**
 * Thin progress bar pinned to the very top of the viewport.
 *
 * Two independent signals drive it:
 *  • router.subscribe('onBeforeNavigate') / ('onLoad') — fires synchronously on
 *    every route change, even when there are no async loaders, so the bar always
 *    starts the instant the user clicks a link.
 *  • useIsFetching() — keeps the bar alive while React Query fetches data for
 *    the newly mounted page, and shows it for background re-fetches too.
 *
 * All animation is done via direct DOM ref writes, not React state, so it is
 * never dropped by React's batching/scheduling on fast transitions.
 */
export function TopProgressBar() {
  const router = useRouter();
  const fetchingCount = useIsFetching();
  const barRef = useRef<HTMLDivElement>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hideRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track how many "loading sources" are active (router + queries).
  const sourcesRef = useRef(0);

  function clearTimers() {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    if (hideRef.current) { clearTimeout(hideRef.current); hideRef.current = null; }
  }

  function domStart() {
    const bar = barRef.current;
    if (!bar) return;
    clearTimers();
    // Hard-reset width so the animation always begins from the left.
    bar.style.transition = "none";
    bar.style.width = "0%";
    bar.style.opacity = "1";
    bar.offsetWidth; // force reflow
    bar.style.transition = "width 250ms ease-out";
    bar.style.width = "15%";
    // Creep toward 88% — decelerates to simulate waiting for the server.
    tickRef.current = setInterval(() => {
      const cur = parseFloat(bar.style.width) || 0;
      if (cur < 88) bar.style.width = `${cur + (88 - cur) * 0.09 + 0.35}%`;
    }, 180);
  }

  function domComplete() {
    const bar = barRef.current;
    if (!bar) return;
    clearTimers();
    bar.style.transition = "width 120ms ease-out";
    bar.style.width = "100%";
    hideRef.current = setTimeout(() => {
      if (!barRef.current) return;
      barRef.current.style.transition = "opacity 280ms ease";
      barRef.current.style.opacity = "0";
      hideRef.current = setTimeout(() => {
        if (barRef.current) {
          barRef.current.style.transition = "none";
          barRef.current.style.width = "0%";
        }
      }, 300);
    }, 180);
  }

  // ── Router navigation events ────────────────────────────────────────────────
  useEffect(() => {
    const unsubStart = router.subscribe("onBeforeNavigate", () => {
      sourcesRef.current += 1;
      if (sourcesRef.current === 1) domStart();
    });
    const unsubEnd = router.subscribe("onLoad", () => {
      sourcesRef.current = Math.max(0, sourcesRef.current - 1);
      if (sourcesRef.current === 0 && fetchingCount === 0) domComplete();
    });
    return () => { unsubStart(); unsubEnd(); };
    // fetchingCount intentionally omitted — we only want the snapshot at subscribe time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  // ── React Query fetch activity ──────────────────────────────────────────────
  useEffect(() => {
    if (fetchingCount > 0) {
      if (sourcesRef.current === 0) domStart();
      sourcesRef.current = Math.max(sourcesRef.current, 1);
    } else {
      sourcesRef.current = 0;
      domComplete();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchingCount]);

  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: "3px",
        zIndex: 9999,
        pointerEvents: "none",
      }}
    >
      <div
        ref={barRef}
        style={{
          height: "100%",
          width: "0%",
          opacity: 0,
          backgroundColor: "hsl(var(--primary))",
          boxShadow: "0 0 10px 1px hsl(var(--primary) / 0.45)",
        }}
      />
    </div>
  );
}
