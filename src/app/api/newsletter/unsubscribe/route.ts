import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isValidUnsubscribeToken } from "@/lib/auth";
import { appUrl } from "@/lib/mail";

/**
 * Unsubscribe from one household's weekly digest (§9b).
 *
 * Public — it has to work from a mail client, which carries no session. The
 * `t` parameter is an HMAC over the user id *and* the household, so the link
 * only opts out the person it was mailed to, from the household it was mailed
 * about; knowing somebody's id is not enough, and neither is holding a link
 * from a household they also belong to.
 *
 * It only clears one membership's digest opt-in; the account, the membership
 * itself and all of the household's data are untouched.
 */
async function unsubscribe(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const userId = url.searchParams.get("u") ?? "";
  const householdId = url.searchParams.get("h") ?? "";
  const token = url.searchParams.get("t") ?? undefined;

  /**
   * Built from APP_URL rather than the request's own origin. HTTPS terminates
   * at the public TLS terminator and is forwarded to loopback (§10), so the origin
   * seen here can be http://127.0.0.1:3000 — a redirect to that is a dead link
   * in someone's mail client.
   */
  const landing = (ok: boolean) => {
    const path = `/newsletter/unsubscribed?ok=${ok ? 1 : 0}`;
    try {
      return appUrl(path);
    } catch {
      return new URL(path, url.origin).toString();
    }
  };

  if (
    !userId ||
    !householdId ||
    !(await isValidUnsubscribeToken(userId, householdId, token))
  ) {
    return NextResponse.redirect(landing(false));
  }

  await prisma.householdMembership
    .update({
      where: { householdId_userId: { householdId, userId } },
      data: { newsletterOptIn: false },
    })
    .catch(() => {});

  return NextResponse.redirect(landing(true));
}

// GET — the link in the footer, clicked by a human.
export async function GET(req: Request) {
  return unsubscribe(req);
}

// POST — RFC 8058 one-click, which is what the List-Unsubscribe header
// promises and what mail clients' own unsubscribe buttons fire.
export async function POST(req: Request) {
  return unsubscribe(req);
}
