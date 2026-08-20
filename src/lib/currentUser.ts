/**
 * Reading the signed-in user inside a request (§9).
 *
 * Split out of src/lib/auth.ts because it reaches for `next/headers`, which
 * only exists inside a request scope — auth.ts has to stay importable from
 * middleware, where cookies arrive on the request object instead.
 */

import { cookies } from "next/headers";
import { SESSION_COOKIE, getSessionUser } from "@/lib/auth";
import type { User } from "@prisma/client";

/** The signed-in user, or null. */
export async function currentUser(): Promise<User | null> {
  const jar = await cookies();
  return getSessionUser(jar.get(SESSION_COOKIE)?.value);
}

/**
 * The signed-in user, or a thrown 401.
 *
 * Middleware already turns anonymous API calls away, so reaching this throw
 * means the session died between the two checks — rare, and still a 401.
 */
export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}
