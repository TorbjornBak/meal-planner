"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { findDurations, formatClock } from "@/lib/durations";

/**
 * The method, with the cook times in it turned into timers (§2).
 *
 * Every "20 minutter" in a step is a button: tap it and a countdown docks at
 * the bottom of the page, labelled with the step it came from, so several
 * things can be on the go at once. Times that couldn't be read out of the text
 * — or that aren't in the text at all — are covered by the manual timer.
 *
 * Timers live in this page only: no notifications, no service-worker alarms.
 * Leaving the recipe ends them, which is why cooking mode holds the screen
 * awake in the first place.
 */

export interface Section {
  header: string | null;
  steps: string[];
}

interface Timer {
  id: number;
  label: string;
  /** Epoch ms the countdown ends — the clock, not a tick count, so a moment
   *  of the phone being asleep doesn't slow the timer down. */
  endsAt: number;
  /** Seconds left while paused. */
  remaining: number;
  running: boolean;
  done: boolean;
}

function shorten(step: string, max = 44): string {
  const s = step.trim();
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

export function Method({ sections }: { sections: Section[] }) {
  const [timers, setTimers] = useState<Timer[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [adding, setAdding] = useState(false);
  const [minutes, setMinutes] = useState("5");
  const audio = useRef<AudioContext | null>(null);

  const running = timers.some((t) => t.running);

  // One ticker for all timers, and none at all when nothing is counting.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [running]);

  // A timer reaching zero: stop it, mark it, make a noise.
  useEffect(() => {
    const expired = timers.filter((t) => t.running && t.endsAt <= now);
    if (expired.length === 0) return;
    const ids = new Set(expired.map((t) => t.id));
    setTimers((ts) =>
      ts.map((t) => (ids.has(t.id) ? { ...t, running: false, remaining: 0, done: true } : t)),
    );
    alarm();
    navigator.vibrate?.([300, 150, 300, 150, 300]);
  }, [now, timers]);

  /** Three short beeps, synthesised — the app ships no audio files (§12). */
  function alarm() {
    const ctx = audioContext();
    if (!ctx) return;
    void ctx.resume();
    for (let i = 0; i < 3; i++) {
      const at = ctx.currentTime + i * 0.45;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      // Ramped rather than switched, so it's a beep and not a click.
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.32);
    }
  }

  function audioContext(): AudioContext | null {
    if (audio.current) return audio.current;
    const Ctx =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    try {
      audio.current = new Ctx();
    } catch {
      return null; // No audio: the dock still turns red and the phone buzzes.
    }
    return audio.current;
  }

  function start(seconds: number, label: string) {
    // Starting a timer is a tap, which is the only moment iOS lets us wake the
    // audio up — do it now so the alarm isn't silent half an hour from here.
    void audioContext()?.resume();
    const t: Timer = {
      id: Date.now() + Math.random(),
      label,
      endsAt: Date.now() + seconds * 1000,
      remaining: seconds,
      running: true,
      done: false,
    };
    setNow(Date.now());
    setTimers((ts) => [...ts, t]);
  }

  function toggle(id: number) {
    setTimers((ts) =>
      ts.map((t) => {
        if (t.id !== id || t.done) return t;
        return t.running
          ? { ...t, running: false, remaining: Math.max(0, (t.endsAt - Date.now()) / 1000) }
          : { ...t, running: true, endsAt: Date.now() + t.remaining * 1000 };
      }),
    );
  }

  function dismiss(id: number) {
    setTimers((ts) => ts.filter((t) => t.id !== id));
  }

  function addManual(e: React.FormEvent) {
    e.preventDefault();
    const m = Number(minutes.replace(",", "."));
    if (!Number.isFinite(m) || m <= 0) return;
    start(Math.round(m * 60), `${m} min`);
    setAdding(false);
  }

  return (
    <>
      <div className="card">
        <div className="method-head">
          <h2>Method</h2>
          {adding ? (
            <form className="timer-add" onSubmit={addManual}>
              <input
                type="number"
                inputMode="decimal"
                min="1"
                step="1"
                autoFocus
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                aria-label="Timer length in minutes"
              />
              <span className="muted">min</span>
              <button type="submit">Start</button>
              <button type="button" className="muted" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </form>
          ) : (
            <button type="button" onClick={() => setAdding(true)}>
              ＋ Timer
            </button>
          )}
        </div>

        {sections.map((sec, i) => (
          <div key={i} style={{ marginBottom: 12 }}>
            {sec.header && <h3 style={{ marginBottom: 4 }}>{sec.header}</h3>}
            <ol style={{ marginTop: 4 }}>
              {sec.steps.map((step, j) => (
                <li key={j} style={{ marginBottom: 4 }}>
                  <Step step={step} onStart={start} />
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>

      {timers.length > 0 && (
        <div className="timer-dock" role="status" aria-live="polite">
          {timers.map((t) => {
            const left = t.running ? (t.endsAt - now) / 1000 : t.remaining;
            return (
              <div key={t.id} className={`timer${t.done ? " timer-done" : ""}`}>
                <div className="timer-body">
                  <span className="timer-clock">{t.done ? "Done" : formatClock(left)}</span>
                  <span className="muted timer-label">{t.label}</span>
                </div>
                {!t.done && (
                  <button
                    type="button"
                    className="muted"
                    onClick={() => toggle(t.id)}
                    aria-label={t.running ? "Pause timer" : "Resume timer"}
                  >
                    {t.running ? "❙❙" : "▶"}
                  </button>
                )}
                <button
                  type="button"
                  className="muted"
                  onClick={() => dismiss(t.id)}
                  aria-label={t.done ? "Dismiss timer" : "Cancel timer"}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/** One step, with each cook time in it rendered as a button. */
function Step({
  step,
  onStart,
}: {
  step: string;
  onStart: (seconds: number, label: string) => void;
}) {
  const parts = useMemo(() => {
    const found = findDurations(step);
    const out: (string | { text: string; seconds: number })[] = [];
    let at = 0;
    for (const d of found) {
      if (d.start > at) out.push(step.slice(at, d.start));
      out.push({ text: d.text, seconds: d.seconds });
      at = d.end;
    }
    if (at < step.length) out.push(step.slice(at));
    return out;
  }, [step]);

  return (
    <>
      {parts.map((part, i) =>
        typeof part === "string" ? (
          part
        ) : (
          <button
            key={i}
            type="button"
            className="time-chip"
            onClick={() => onStart(part.seconds, shorten(step))}
            title={`Start a ${formatClock(part.seconds)} timer`}
          >
            {part.text}
          </button>
        ),
      )}
    </>
  );
}
