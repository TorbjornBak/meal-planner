import { NextResponse } from "next/server";
import { captureToken } from "@/lib/auth";
import { currentHouseholdContext } from "@/lib/currentUser";

// GET /api/capture/info — the household capture token, for building the
// bookmarklet on the Settings page. Session-protected by the middleware.
export async function GET() {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const householdId = context.household.id;
  return NextResponse.json({ householdId, token: await captureToken(householdId) });
}
