"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Cooking mode (§2) — hold the screen awake while the recipe is open.
 *
 * The browser grants a screen wake lock only to a visible page and takes it
 * back the moment the page is hidden — switching apps to start a timer is
 * enough to lose it. So the toggle records *intent*, and the lock itself is
 * re-taken every time the page comes back into view; `sentinel` is only the
 * grant we happen to be holding right now.
 *
 * The intent is remembered in localStorage, so you turn cooking mode on once
 * and it stays on as you move between tonight's recipes.
 */

const STORAGE_KEY = "mealplanner:cookingMode";

export function CookingMode() {
  const sentinel = useRef<WakeLockSentinel | null>(null);
  // Bumped by every release, so a request still in flight when cooking mode is
  // switched off can tell that its grant is no longer wanted.
  const generation = useRef(0);

  // null until mounted — on the server there is no browser to ask.
  const [supported, setSupported] = useState<boolean | null>(null);
  const [on, setOn] = useState(false);
  const [refused, setRefused] = useState(false);

  const release = useCallback(async () => {
    generation.current += 1;
    const held = sentinel.current;
    sentinel.current = null;
    if (held && !held.released) await held.release().catch(() => {});
  }, []);

  const acquire = useCallback(async () => {
    if (sentinel.current && !sentinel.current.released) return true;
    const mine = generation.current;
    try {
      const granted = await navigator.wakeLock.request("screen");
      if (mine !== generation.current) {
        // Switched off (or navigated away) while we were asking.
        await granted.release().catch(() => {});
        return false;
      }
      sentinel.current = granted;
      setRefused(false);
      return true;
    } catch {
      // Battery saver, a backgrounded tab, or a browser that just says no.
      sentinel.current = null;
      setRefused(true);
      return false;
    }
  }, []);

  // Mount: work out whether we can do this at all, then restore the setting.
  useEffect(() => {
    const ok = "wakeLock" in navigator;
    setSupported(ok);
    if (!ok || localStorage.getItem(STORAGE_KEY) !== "on") return;
    void acquire().then((held) => setOn(held));
  }, [acquire]);

  // Re-take the lock whenever the page is shown again.
  useEffect(() => {
    if (!on) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [on, acquire]);

  // Leaving the page drops the lock anyway; releasing it explicitly keeps a
  // remount (or a fast client-side navigation) from stranding a sentinel.
  useEffect(() => () => void release(), [release]);

  async function toggle() {
    if (on) {
      setOn(false);
      setRefused(false);
      localStorage.setItem(STORAGE_KEY, "off");
      await release();
      return;
    }
    const held = await acquire();
    setOn(held);
    localStorage.setItem(STORAGE_KEY, held ? "on" : "off");
  }

  if (supported === null) return null;

  return (
    <p className="cooking-mode">
      <button
        type="button"
        className="cooking-toggle"
        aria-pressed={on}
        disabled={!supported}
        onClick={toggle}
      >
        {on ? "☀ Cooking mode on" : "☾ Cooking mode"}
      </button>
      <span className="muted">
        {!supported
          ? "This browser can't hold the screen awake."
          : refused
            ? "The browser wouldn't hold the screen awake — battery saver is the usual reason."
            : on
              ? "The screen stays on while this page is in front."
              : "Keep the screen on while you cook."}
      </span>
    </p>
  );
}
