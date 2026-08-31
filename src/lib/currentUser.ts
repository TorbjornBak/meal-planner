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
import { type AccessDecision, operationalAccess } from "@/lib/platformAdmin";

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

/**
 * The caller of an installation-wide operation, and whether they may (§9c).
 *
 * The routes for SMTP diagnostics and the backup repository all used to ask
 * only "is anybody signed in?". That was very nearly true on a one-household
 * box, and stopped being true the moment a second household existed: "anybody
 * with a login" then includes people from a kitchen with no stake in this
 * machine, and the backup passphrase is not theirs to read.
 *
 * `bearer` is for the endpoints a script drives instead of a browser — the
 * nightly backup answering CRON_SECRET — which the route establishes for
 * itself before calling this, since only it knows which secret applies.
 */
export async function operationalCaller(
  opts: { bearer?: boolean } = {},
): Promise<{ decision: AccessDecision; user: User | null }> {
  if (opts.bearer) return { decision: "allow", user: null };
  const user = await currentUser();
  return {
    decision: operationalAccess({ platformRole: user?.platformRole ?? null }),
    user,
  };
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
