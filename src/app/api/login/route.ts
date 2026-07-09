import { NextResponse } from "next/server";
import { SESSION_COOKIE, issueSessionToken, verifyPassword } from "@/lib/auth";

// POST /api/login — exchange the shared password for a session cookie (§9).
export async function POST(req: Request) {
  const { password } = await req.json().catch(() => ({ password: "" }));

  if (!verifyPassword(String(password ?? ""))) {
    return NextResponse.json({ error: "invalid" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await issueSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: 60 * 60 * 24 * 365, // a year; it's a home app behind Tailscale
  });
  return res;
}
