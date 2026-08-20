/**
 * Outbound email over your own SMTP server (§9, §9b).
 *
 * SMTP, not a mail API — same reasoning as the deterministic parser and the
 * in-process OCR (§12). There's no account to sign up for and no key to leak;
 * the app talks to a server you already run.
 *
 * Everything is configured from the environment:
 *
 *   SMTP_HOST      hostname of the SMTP server            (required)
 *   SMTP_PORT      port; defaults to 587                  (optional)
 *   SMTP_SECURE    "true" for implicit TLS (port 465)     (optional)
 *   SMTP_USER      username, if the server wants auth     (optional)
 *   SMTP_PASS      password, if the server wants auth     (optional)
 *   MAIL_FROM      From: header, e.g. "MealPlanner <mealplanner@example.com>"
 *   APP_URL        public base URL used for links in mail (required)
 *   SMTP_TLS_REJECT_UNAUTHORIZED
 *                  "false" to accept a self-signed certificate (optional)
 *
 * Note for a mail server running on the *host*: SMTP_HOST=localhost resolves to
 * the app container, not the box. Use the host's address instead.
 */

import nodemailer, { type Transporter } from "nodemailer";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Extra headers — the newsletter uses these for List-Unsubscribe. */
  headers?: Record<string, string>;
}

/** Thrown when mail is attempted on an instance that has no SMTP configured. */
export class MailNotConfiguredError extends Error {
  constructor() {
    super(
      "SMTP is not configured. Set SMTP_HOST, MAIL_FROM and APP_URL to send mail.",
    );
    this.name = "MailNotConfiguredError";
  }
}

/**
 * Whether mail can be sent at all.
 *
 * The UI asks first so it can say "email isn't set up on this instance"
 * up front, instead of offering a reset link that silently goes nowhere.
 */
export function isMailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.MAIL_FROM && process.env.APP_URL);
}

/**
 * The base URL to build links on.
 *
 * Emailed links are read on a phone, away from the app, so they have to be
 * absolute — there's no request to infer an origin from. On the tailnet this
 * is the MagicDNS name, e.g. https://box.tailnet-name.ts.net (§10).
 */
export function appUrl(path = "/"): string {
  const base = (process.env.APP_URL ?? "").replace(/\/+$/, "");
  if (!base) throw new MailNotConfiguredError();
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

let cached: Transporter | null = null;

function transport(): Transporter {
  if (cached) return cached;
  if (!isMailConfigured()) throw new MailNotConfiguredError();

  const port = Number(process.env.SMTP_PORT ?? 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  cached = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // Implicit TLS on 465; everything else negotiates STARTTLS.
    secure: process.env.SMTP_SECURE === "true" || port === 465,
    auth: user ? { user, pass } : undefined,
    tls: {
      // Certificates are verified by default. A self-hosted mail server with a
      // self-signed certificate is the one case where that has to be relaxed —
      // opt in explicitly, and only for a server you control on a network you
      // trust (§10).
      rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== "false",
    },
    // The weekly digest opens one connection and sends every member's copy
    // down it rather than reconnecting per recipient.
    pool: true,
    maxConnections: 1,
    maxMessages: 50,
  });
  return cached;
}

/**
 * Send one message.
 *
 * Every mail carries a plain-text alternative alongside the HTML: some of this
 * is read on a watch, and a digest that degrades to unreadable isn't a digest.
 */
export async function sendMail(mail: Mail): Promise<void> {
  await transport().sendMail({
    from: process.env.MAIL_FROM,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    headers: mail.headers,
  });
}

/** Check the SMTP settings actually connect, for the Settings-page test button. */
export async function verifyMailConnection(): Promise<void> {
  await transport().verify();
}
