import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SESSION_COOKIE, selectSessionHousehold } from "@/lib/auth";
import { safeNextPath } from "@/lib/safeRedirect";

/**
 * The origin every digest link is measured against.
 *
 * APP_URL is what built the link in the first place (src/lib/mail.ts requires
 * it to send at all), so it is the honest yardstick here. The literal fallback
 * is never navigated to — it exists so an unparsable APP_URL makes safeNextPath
 * refuse everything off-path rather than throw on a request somebody is making.
 */
function appOrigin(): string {
  try {
    return new URL(process.env.APP_URL ?? "").origin;
  } catch {
    return "https://mealplanner.invalid";
  }
}

/**
 * Open a page *in* a particular household (§9, §9b).
 *
 * Every link in a weekly digest comes through here. Without it, a member of
 * two households who clicks "see the plan" in Saturday's mail gets whichever
 * household their browser happened to be acting in — which, half the time, is
 * a different week's dinners than the mail was about, with no hint that
 * anything was substituted.
 *
 * Not public: middleware bounces an anonymous visitor to /login with this
 * whole URL as `next`, so signing in lands them here and the switch still
 * happens. The switch itself is refused unless the session's account is a
 * member, so a guessed household id in a mail client does nothing.
 */
export default async function OpenPage({
  searchParams,
}: {
  searchParams: Promise<{ h?: string; next?: string }>;
}) {
  const { h, next } = await searchParams;

  /**
   * Only same-site paths.
   *
   * `next` arrives from a URL that has been sitting in somebody's inbox, so
   * "//evil.example/x" — a valid relative URL that browsers read as another
   * origin — has to be refused here rather than handed to redirect(). The
   * rule lives in safeNextPath because refusing protocol-relative paths is
   * not sufficient on its own: a browser reads `/\evil.example` as another
   * origin too, and a digest link is exactly the kind of long-lived URL
   * somebody would craft to exploit that.
   */
  const destination = safeNextPath(next, appOrigin());

  if (h) {
    const jar = await cookies();
    const switched = await selectSessionHousehold(jar.get(SESSION_COOKIE)?.value, h);
    if (!switched) {
      return (
        <div className="card" style={{ maxWidth: 420, margin: "3rem auto" }}>
          <h1>That household isn&apos;t yours</h1>
          <p style={{ color: "var(--muted)" }}>
            This link opens a household you&apos;re no longer a member of — or never
            were. Nothing has changed about the one you are in.
          </p>
          <p style={{ marginTop: 16 }}>
            <Link href="/">Go to the dashboard</Link>
          </p>
        </div>
      );
    }
  }

  redirect(destination);
}
