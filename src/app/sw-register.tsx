"use client";

import { useEffect } from "react";

/**
 * Registers the offline service worker. Production only — in dev, Turbopack's
 * chunk URLs churn and a cached service worker would serve stale JS.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Registration failures (e.g. no HTTPS) just mean no offline support.
    });
  }, []);

  return null;
}
