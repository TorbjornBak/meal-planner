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
 * installation was only reachable on a private network. On the public
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
      <header className="landing-hero">
        <div className="landing-hero-copy">
          <p className="landing-wordmark">MealPlanner</p>
          <p className="landing-kicker">A calmer way to feed a household</p>
          <h1>Make a good dinner plan. Keep the rest of the week easy.</h1>
          <p className="landing-lede">
            Save the recipes you love, put them on the week, and head to the shop
            with one list that already knows your pantry.
          </p>

          <div className="landing-action">
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
          </div>

          {/* Only for the signed-out, and only once the box is past setup: the
              person who is about to create the first account is not waiting on an
              invitation from anybody. */}
          {destination === "login" && (
            <p className="landing-invitation">
              New here? Accounts are created by a household invitation.
            </p>
          )}
        </div>

        <div className="landing-preview" aria-hidden="true">
          <section className="landing-week-card">
            <div className="landing-preview-heading">
              <span>This week</span>
              <span>September</span>
            </div>
            <div className="landing-days">
              <div className="landing-day">
                <span>Mon</span>
                <strong>01</strong>
                <i className="landing-meal landing-meal-tomato">Tomato pasta</i>
              </div>
              <div className="landing-day">
                <span>Tue</span>
                <strong>02</strong>
                <i className="landing-meal landing-meal-herb">Green curry</i>
              </div>
              <div className="landing-day">
                <span>Wed</span>
                <strong>03</strong>
                <i className="landing-meal landing-meal-berry">Berry galette</i>
              </div>
            </div>
          </section>
          <section className="landing-list-card">
            <div className="landing-preview-heading">
              <span>Shopping list</span>
              <span className="landing-list-count">8 items</span>
            </div>
            <ul>
              <li><span className="landing-check" />Fresh basil</li>
              <li><span className="landing-check" />Coconut milk</li>
              <li><span className="landing-check landing-check-done" />Cherry tomatoes</li>
              <li><span className="landing-check" />Puff pastry</li>
            </ul>
          </section>
          <div className="landing-preview-sun" />
        </div>
      </header>

      <section className="landing-workflow" aria-labelledby="how-it-works">
        <div className="landing-section-heading">
          <p className="landing-kicker">From idea to table</p>
          <h2 id="how-it-works">The small rituals that make dinner happen.</h2>
        </div>
        <ol className="landing-steps">
          <li>
            <span className="landing-step-number">01</span>
            <h3>Plan</h3>
            <p>Paste a favourite recipe or link, then give every dinner a place in the week.</p>
          </li>
          <li>
            <span className="landing-step-number">02</span>
            <h3>Shop</h3>
            <p>Your list adds ingredients together and leaves out what is already in the pantry.</p>
          </li>
          <li>
            <span className="landing-step-number">03</span>
            <h3>Track</h3>
            <p>Tick things off at the store, save the receipt, and see where the grocery budget goes.</p>
          </li>
        </ol>
      </section>

      <aside className="landing-privacy" aria-labelledby="privacy-title">
        <div className="landing-privacy-mark" aria-hidden="true">⌂</div>
        <div>
          <p className="landing-kicker">Made for your kitchen</p>
          <h2 id="privacy-title">Your household&rsquo;s food stays with your household.</h2>
          <p>
            MealPlanner is self-hosted. Recipes are parsed here, receipts are read
            here, and no third-party service gets a copy of your kitchen&rsquo;s data.
          </p>
        </div>
      </aside>
    </div>
  );
}
