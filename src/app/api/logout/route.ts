import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, destroySession, sessionCookieOptions } from "@/lib/auth";

// POST /api/logout — end this browser's session (§9).
export async function POST() {
  const jar = await cookies();
  // Deleting the row, not just the cookie: a copy of the cookie taken from
  // another device has to stop working too.
  await destroySession(jar.get(SESSION_COOKIE)?.value);

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(0));
  return res;
}
