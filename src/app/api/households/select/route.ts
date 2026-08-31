import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, selectSessionHousehold } from "@/lib/auth";

/**
 * POST /api/households/select — act in a different household (§9).
 *
 * The selection lives on the session row rather than in a cookie of its own,
 * so a member removed from a household stops acting in it on their very next
 * request, and so the choice follows the browser rather than the tab.
 *
 * `selectSessionHousehold` refuses a household the session's user has no
 * membership in, and the composite foreign key behind it refuses it a second
 * time — which is the check that matters, since it holds even if this route is
 * one day called with something clever in the body.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { householdId?: unknown } | null;
  const householdId = typeof body?.householdId === "string" ? body.householdId : "";
  if (!householdId) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const jar = await cookies();
  const ok = await selectSessionHousehold(jar.get(SESSION_COOKIE)?.value, householdId);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  return NextResponse.json({ ok: true });
}
