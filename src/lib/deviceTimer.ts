/**
 * Handing a cook timer to the device's own clock (§2).
 *
 * The in-page timer dies when you leave the recipe or the phone goes to sleep
 * hard enough. The operating system's clock doesn't — so where a platform lets
 * a web page start a real timer, we offer it. What each one actually allows,
 * as of writing:
 *
 * - **Android** — `intent:` URI with `ACTION_SET_TIMER` and `SKIP_UI`, so the
 *   system clock starts a labelled timer without even coming to the front.
 *   The real thing. Chrome requires a user gesture, which a tap is.
 * - **iPhone / iPad / Mac** — Apple ships no URL scheme for the Clock app, so
 *   the only route is the user's own shortcut, run via `shortcuts://`. It costs
 *   a one-time setup, which is why it's opt-in and the name is editable.
 * - **Windows** — `ms-clock:` opens the Clock app on its timer tab and that's
 *   all; the length can't be passed. Better than nothing, worse than a timer.
 *
 * Everything here is a pure function over the user agent, so it's testable
 * without a browser.
 */

export type Platform = "android" | "ios" | "macos" | "windows" | "other";

export interface DeviceTimer {
  /** Where to send the browser. */
  url: string;
  /**
   * `"starts"` — the device's clock ends up running this exact timer.
   * `"opens"` — the clock app opens and you finish the job by hand.
   */
  kind: "starts" | "opens";
  /** Button text. */
  label: string;
  /** What will actually happen, said plainly. */
  hint: string;
}

/** The shortcut we tell Apple users to make, unless they name theirs differently. */
export const DEFAULT_SHORTCUT = "Start Timer";

/**
 * Which clock we can talk to. `touchPoints` separates an iPad — which claims to
 * be a Mac in every modern user agent — from an actual Mac.
 */
export function detectPlatform(ua: string, touchPoints = 0): Platform {
  const s = ua.toLowerCase();
  if (s.includes("android")) return "android";
  if (/iphone|ipad|ipod/.test(s)) return "ios";
  if (s.includes("mac")) return touchPoints > 1 ? "ios" : "macos";
  if (s.includes("windows")) return "windows";
  return "other";
}

/** Android intent extras are typed by prefix: `i.` int, `S.` string, `B.` bool. */
function androidIntent(seconds: number, label: string): string {
  const message = encodeURIComponent(label);
  return (
    "intent:#Intent;action=android.intent.action.SET_TIMER;" +
    `i.android.intent.extra.alarm.LENGTH=${Math.round(seconds)};` +
    `S.android.intent.extra.alarm.MESSAGE=${message};` +
    "B.android.intent.extra.alarm.SKIP_UI=true;end"
  );
}

/**
 * How to start `seconds` on this platform's own clock, or null where there is
 * no way to. `shortcutName` is only consulted on Apple platforms.
 */
export function deviceTimer(
  platform: Platform,
  seconds: number,
  label: string,
  shortcutName: string = DEFAULT_SHORTCUT,
): DeviceTimer | null {
  const whole = Math.max(1, Math.round(seconds));
  switch (platform) {
    case "android":
      return {
        url: androidIntent(whole, label),
        kind: "starts",
        label: "Phone clock",
        hint: "Starts this timer in the phone's own clock, so it survives leaving the page.",
      };
    case "ios":
    case "macos": {
      const name = encodeURIComponent(shortcutName.trim() || DEFAULT_SHORTCUT);
      return {
        url: `shortcuts://run-shortcut?name=${name}&input=text&text=${whole}`,
        kind: "starts",
        label: platform === "ios" ? "Phone clock" : "Clock app",
        hint: `Runs your "${shortcutName}" shortcut with ${whole} seconds — Apple offers no other way in.`,
      };
    }
    case "windows":
      return {
        url: "ms-clock:",
        kind: "opens",
        label: "Clock app",
        hint: "Opens the Clock app on its timer tab. Windows can't be told the length, so you set it.",
      };
    default:
      return null;
  }
}
