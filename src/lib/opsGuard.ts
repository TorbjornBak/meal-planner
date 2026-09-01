/**
 * Turning an operational authorization decision into a response (§9c).
 *
 * Three lines, in one place, because the alternative is three lines copied
 * into six route handlers, and the copy that gets the status code wrong is
 * the one nobody notices — a 401 where a 403 belongs sends a signed-in member
 * who found the URL back to a login form that cannot help them.
 */

import { NextResponse } from "next/server";
import type { User } from "@prisma/client";
import { operationalCaller } from "@/lib/currentUser";

export type OperationalGuard =
  | { ok: true; user: User | null }
  | { ok: false; response: NextResponse };

export async function guardOperational(
  opts: { bearer?: boolean } = {},
): Promise<OperationalGuard> {
  const { decision, user } = await operationalCaller(opts);
  if (decision === "allow") return { ok: true, user };

  return {
    ok: false,
    response: NextResponse.json(
      { error: decision },
      { status: decision === "unauthorized" ? 401 : 403 },
    ),
  };
}
