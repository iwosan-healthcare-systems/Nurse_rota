import { useEffect, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useIsFetching } from "@tanstack/react-query";

export function TopProgressBar() {
  const routerLoading = useRouterState({ select: (s) => s.isLoading });
  const fetchingCount = useIsFetching();
  const isLoading = routerLoading || fetchingCount > 0;
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearTimers() {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }

  useEffect(() => {
    if (isLoading) {
      clearTimers();
      setVisible(true);
      setWidth(12);
      // Tick toward 90% — decelerates as it approaches to fake "waiting for server"
      intervalRef.current = setInterval(() => {
        setWidth((w) => {
          if (w >= 90) return w;
          return w + (90 - w) * 0.08 + 0.5;
        });
      }, 150);
    } else {
      clearTimers();
      // Complete the bar, then fade it out
      setWidth(100);
      timeoutRef.current = setTimeout(() => {
        setVisible(false);
        timeoutRef.current = setTimeout(() => setWidth(0), 300);
      }, 250);
    }

    return clearTimers;
  }, [isLoading]);

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
        style={{
          height: "100%",
          width: `${width}%`,
          opacity: visible ? 1 : 0,
          backgroundColor: "hsl(var(--primary))",
          boxShadow: "0 0 10px 1px hsl(var(--primary) / 0.5)",
          transition: [
            "width 300ms ease-out",
            visible ? "opacity 80ms ease" : "opacity 300ms ease",
          ].join(", "),
        }}
      />
    </div>
  );
}
