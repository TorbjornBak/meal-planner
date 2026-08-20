import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/currentUser";
import { looksLikeEmail, normalizeEmail } from "@/lib/auth";
import { isMailConfigured } from "@/lib/mail";

/** The shape the Settings page reads. Never includes the password hash. */
function publicUser(u: {
  id: string;
  email: string;
  name: string | null;
  newsletterOptIn: boolean;
}) {
  return { id: u.id, email: u.email, name: u.name, newsletterOptIn: u.newsletterOptIn };
}

// GET /api/account — who am I, and can this instance send mail at all (§9).
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ ...publicUser(user), mailConfigured: isMailConfigured() });
}

const Patch = z.object({
  name: z.string().max(120).nullish(),
  email: z.string().max(320).optional(),
  newsletterOptIn: z.boolean().optional(),
});

// PATCH /api/account — change my display name, address or digest opt-in.
export async function PATCH(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const data: { name?: string | null; email?: string; newsletterOptIn?: boolean } = {};

  if (parsed.data.name !== undefined) {
    const name = parsed.data.name?.trim();
    data.name = name ? name : null;
  }

  if (parsed.data.email !== undefined) {
    const email = normalizeEmail(parsed.data.email);
    if (!looksLikeEmail(email)) {
      return NextResponse.json({ error: "invalid-email" }, { status: 400 });
    }
    if (email !== user.email) {
      const taken = await prisma.user.findUnique({ where: { email } });
      if (taken) return NextResponse.json({ error: "email-taken" }, { status: 409 });
      data.email = email;
    }
  }

  if (parsed.data.newsletterOptIn !== undefined) {
    data.newsletterOptIn = parsed.data.newsletterOptIn;
  }

  const updated = await prisma.user.update({ where: { id: user.id }, data });
  return NextResponse.json(publicUser(updated));
}
