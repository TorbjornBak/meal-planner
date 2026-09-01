import { NextResponse } from "next/server";
import { guardOperational } from "@/lib/opsGuard";
import { recordAudit } from "@/lib/audit";
import { consumeAll, tooManyRequests } from "@/lib/rateLimit";
import { isMailConfigured, verifyMailConnection } from "@/lib/mail";
import { describeMailError } from "@/lib/mailError";

/**
 * POST /api/mail/test — check the SMTP settings and say what's wrong (§9).
 *
 * Connects and authenticates without sending anything, so it isolates "can we
 * reach the mail server at all" from "was the message accepted". The real
 * error is returned rather than flattened to "couldn't send": everyone with a
 * session here is a household member on the tailnet (§10), and the person
 * looking at this screen is the person who can go and fix the setting.
 */
export async function POST() {
  // SMTP belongs to the installation, and the diagnosis it returns is the
  // real one — hostnames, ports, what the relay said. That is worth showing to
  // whoever can go and change the setting, and to nobody else.
  const guard = await guardOperational();
  if (!guard.ok) return guard.response;
  const actor = guard.user;
  if (!actor) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // This route has no bearer door (guardOperational() is called with no
  // options above), so `actor` is always the signed-in platform admin who
  // pressed the button — never a script. Keyed by that account: the limit is
  // "how many times can one admin lean on this button", not a defence against
  // guessing anything.
  const refusal = await consumeAll([["mail-test:user", actor.id]]);
  if (refusal) return tooManyRequests(refusal);

  if (!isMailConfigured()) {
    const missing = [
      !process.env.SMTP_HOST && "SMTP_HOST",
      !process.env.MAIL_FROM && "MAIL_FROM",
      !process.env.APP_URL && "APP_URL",
    ].filter(Boolean);

    return NextResponse.json({
      ok: false,
      summary: `Email isn't configured: ${missing.join(", ")} ${
        missing.length === 1 ? "is" : "are"
      } unset.`,
      hint: "Set these in the .env the app container reads, then restart it.",
      detail: `missing: ${missing.join(", ")}`,
    });
  }

  const settings = {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true" || Number(process.env.SMTP_PORT ?? 587) === 465,
    auth: Boolean(process.env.SMTP_USER),
    from: process.env.MAIL_FROM,
  };

  try {
    await verifyMailConnection();
    await recordAudit({
      action: "SMTP_TEST_SENT",
      actor: { id: actor.id, email: actor.email },
      detail: `Checked the SMTP settings against ${settings.host}:${settings.port}; the relay accepted the connection.`,
    });
    return NextResponse.json({
      ok: true,
      summary: `Connected to ${settings.host}:${settings.port} and authenticated.`,
      settings,
    });
  } catch (err) {
    console.error("smtp verify failed", err);
    return NextResponse.json({
      ok: false,
      ...describeMailError(err, settings.host),
      settings,
    });
  }
}
