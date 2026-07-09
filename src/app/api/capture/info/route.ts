import { NextResponse } from "next/server";
import { captureToken } from "@/lib/auth";

// GET /api/capture/info — the household capture token, for building the
// bookmarklet on the Settings page. Session-protected by the middleware.
export async function GET() {
  return NextResponse.json({ token: await captureToken() });
}
