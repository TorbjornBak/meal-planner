import Link from "next/link";

import { needsSetup } from "@/lib/auth";
import { currentUser } from "@/lib/currentUser";

// Reads the session cookie to decide which way the button points, so there is
// nothing here Next could render once and hand to everybody.
export const dynamic = "force-dynamic";

/**
 * Once an account exists, it cannot stop existing for this process.
 *
 * The landing page is the only page on this app an unauthenticated stranger on
 * the public internet can reach, which makes every query it runs a query anyone
 * can make it run. The session lookup at least costs a cookie; needsSetup()
 * would be a COUNT on every hit from every visitor forever, to answer a
 * question that stops being interesting the moment the box is set up.
 *
 * So: ask until the answer is "no", then stop asking. Being wrong is only
 * possible in the direction of showing "Sign in" to an instance that has
 * somehow gone back to having no accounts — where /setup is still reachable by
 * hand and still re-derives for itself whether it may act (§9). The opposite
 * error, offering setup to a live instance, is the one this can't make.
 */
let bootstrapDone = false;

async function bootstrapPending(): Promise<boolean> {
  if (bootstrapDone) return false;
  const pending = await needsSetup();
  if (!pending) bootstrapDone = true;
  return pending;
}

/** Which door this visitor is offered. */
type Door = "dashboard" | "setup" | "login";

/**
 * Where the button goes — and, when the box is unwell, the fact that it still
 * goes somewhere.
 *
 * Both questions here are database questions, and this is the page somebody
 * loads when the app is misbehaving: the bare domain is what you type to find
 * out whether the thing is up. A dead Postgres should not turn the front door
 * into a stack trace, so a failure to answer either question is treated as the
 * ordinary anonymous case — the sign-in door, which will then fail honestly
 * and with a form, instead of a 500 at the address people give each other.
 */
async function door(): Promise<Door> {
  try {
    if (await currentUser()) return "dashboard";
    return (await bootstrapPending()) ? "setup" : "login";
  } catch {
    return "login";
  }
}

/**
 * The front door (§9, §10).
 *
 * Everything else in this app is behind an account, which was fine when the
 * only way to type this address was to be on the tailnet. On the public
 * internet somebody reaches the bare domain without an account and without
 * context, and the honest thing to show them is what this is, followed by the
 * one door there is — rather than a login form for an app they have no way to
 * identify, or a dashboard they can't have.
 *
 * Public in both directions. Somebody already signed in gets this page too,
 * not a redirect: the button is how they carry on, and a front door that
 * refuses to be looked at by the people who live there is a strange front
 * door. It costs them one press, and it means the address in the phone's
 * address bar behaves the same way for everyone.
 */
export default async function LandingPage() {
  const destination = await door();

  return (
    <div className="landing">
      <h1 className="landing-title">MealPlanner</h1>
      <p className="landing-lede">
        Household dinners → shopping list → grocery spend.
      </p>

      <p className="landing-body">
        Paste a recipe or a link and it&rsquo;s parsed into ingredients and steps. Put
        the week&rsquo;s dinners on a calendar, and the shopping list writes itself —
        everything added up, with what&rsquo;s already in the pantry set aside. Tick it
        off in the store, photograph the receipt on the way out, and watch what the
        month is costing.
      </p>

      <p className="landing-cta">
        {destination === "dashboard" ? (
          <Link className="cta" href="/dashboard">
            Go to dashboard
          </Link>
        ) : destination === "setup" ? (
          <Link className="cta" href="/setup">
            Set up this MealPlanner
          </Link>
        ) : (
          <Link className="cta" href="/login">
            Sign in
          </Link>
        )}
      </p>

      {/* Only for the signed-out, and only once the box is past setup: the
          person who is about to create the first account is not waiting on an
          invitation from anybody. */}
      {destination === "login" && (
        <p className="landing-note">
          There&rsquo;s no sign-up form — accounts come from a household invitation.
          If your household already uses MealPlanner, ask one of its members to
          invite you and the link will arrive by mail.
        </p>
      )}

      <p className="landing-note">
        No third-party services: recipes are parsed on this server, receipts are
        read on it, and your kitchen&rsquo;s data stays on the box this is running
        on.
      </p>
    </div>
  );
}
