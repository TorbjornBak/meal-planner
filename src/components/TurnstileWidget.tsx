"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { TurnstileAction } from "@/lib/turnstileActions";

const SITE_KEY = "0x4AAAAAAEkqaqTEXn-DcUnA";
const SCRIPT_ID = "cloudflare-turnstile-script";
const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      callback(token: string): void;
      "expired-callback"(): void;
      "timeout-callback"(): void;
      "error-callback"(): void;
    },
  ): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;

function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing ?? document.createElement("script");

    const loaded = () => (window.turnstile ? resolve() : reject(new Error("Turnstile unavailable")));
    script.addEventListener("load", loaded, { once: true });
    script.addEventListener("error", () => reject(new Error("Turnstile failed to load")), {
      once: true,
    });

    if (!existing) {
      script.id = SCRIPT_ID;
      script.src = SCRIPT_URL;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });

  return scriptPromise;
}

export interface TurnstileWidgetHandle {
  reset(): void;
}

export const TurnstileWidget = forwardRef<
  TurnstileWidgetHandle,
  { action: TurnstileAction; onTokenChange(token: string | null): void }
>(function TurnstileWidget({ action, onTokenChange }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useImperativeHandle(ref, () => ({
    reset() {
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.reset(widgetIdRef.current);
      }
      onTokenChange(null);
    },
  }));

  useEffect(() => {
    let cancelled = false;

    loadTurnstile()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: SITE_KEY,
          action,
          callback: (token) => onTokenChange(token),
          "expired-callback": () => onTokenChange(null),
          "timeout-callback": () => onTokenChange(null),
          "error-callback": () => onTokenChange(null),
        });
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [action, onTokenChange]);

  return (
    <div style={{ marginTop: 12 }}>
      <div ref={containerRef} />
      {loadFailed && (
        <p role="alert" style={{ color: "var(--accent)", fontSize: 13 }}>
          Verification could not load. Reload the page and try again.
        </p>
      )}
    </div>
  );
});
