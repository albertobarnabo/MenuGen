"use client";

import { useEffect, useState } from "react";

/**
 * Current time in milliseconds, re-rendered every `intervalMs` while `active`.
 * Pass `active = false` to freeze the clock (e.g. once a job has finished).
 */
export function useNow(intervalMs = 1000, active = true): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, active]);

  return now;
}
