/**
 * Reading the signed-in user inside a request (§9).
 *
 * Split out of src/lib/auth.ts because it reaches for `next/headers`, which
 * only exists inside a request scope — auth.ts has to stay importable from
 * middleware, where cookies arrive on the request object instead.
 */

import { cookies } from "next/headers";
import {
  SESSION_COOKIE,
  getSessionHouseholdContext,
  getSessionUser,
  type HouseholdSessionContext,
} from "@/lib/auth";
import type { User } from "@prisma/client";

/** The signed-in user, or null. */
export async function currentUser(): Promise<User | null> {
  const jar = await cookies();
  return getSessionUser(jar.get(SESSION_COOKIE)?.value);
}

/** The signed-in browser's active household, or null when none is available. */
export async function currentHouseholdContext(): Promise<HouseholdSessionContext | null> {
  const jar = await cookies();
  return getSessionHouseholdContext(jar.get(SESSION_COOKIE)?.value);
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

/** Require a signed-in user with an active household membership. */
export async function requireHouseholdContext(): Promise<HouseholdSessionContext> {
  const context = await currentHouseholdContext();
  if (!context) throw new UnauthorizedError();
  return context;
}

/** Require administration rights in the active household. */
export async function requireHouseholdAdmin(): Promise<HouseholdSessionContext> {
  const context = await requireHouseholdContext();
  if (context.role !== "ADMIN") throw new ForbiddenError();
  return context;
}

/** Require installation-wide operational rights, without granting meal-data access. */
export async function requirePlatformAdmin(): Promise<User> {
  const user = await requireUser();
  if (user.platformRole !== "ADMIN") throw new ForbiddenError();
  return user;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  constructor() {
    super("forbidden");
    this.name = "ForbiddenError";
  }
}
