/**
 * Presentation primitives for email (§9, §9b).
 *
 * Mail clients are a decade behind browsers: no external stylesheets, no
 * custom fonts, patchy flexbox. So everything here is inline styles on tables,
 * and the palette is hard-coded to match globals.css rather than shared with
 * it — a `var(--accent)` in an email renders as nothing.
 *
 * Deliberately dependency-free: no database, no environment, no mailer. That's
 * what lets the digest composer that builds on it be unit-tested by running it
 * straight through Node.
 */

export const PALETTE = {
  bg: "#faf9f7",
  fg: "#1c1b1a",
  muted: "#6b6863",
  accent: "#b5563a",
  border: "#e3e0da",
  card: "#ffffff",
} as const;

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** What every template returns: one message in both the forms mail needs. */
export interface Composed {
  subject: string;
  text: string;
  html: string;
}

/** Escape text for interpolation into an HTML template. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The shell every message sits in: centred card, wordmark, optional footer.
 * `preheader` is the grey line mail clients show next to the subject.
 */
export function layout(opts: {
  title: string;
  preheader: string;
  body: string;
  footer?: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
</head>
<body style="margin:0;padding:0;background:${PALETTE.bg};color:${PALETTE.fg};font-family:${FONT};">
  <span style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(opts.preheader)}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PALETTE.bg};padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${PALETTE.card};border:1px solid ${PALETTE.border};border-radius:12px;">
          <tr>
            <td style="padding:24px 28px 0 28px;">
              <div style="font-size:14px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:${PALETTE.accent};">MealPlanner</div>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 28px 28px 28px;font-size:16px;line-height:1.55;color:${PALETTE.fg};">
${opts.body}
            </td>
          </tr>
        </table>
        ${
          opts.footer
            ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
          <tr><td style="padding:16px 28px;font-size:12px;line-height:1.5;color:${PALETTE.muted};">${opts.footer}</td></tr>
        </table>`
            : ""
        }
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** A call-to-action button that still looks like a button in Outlook. */
export function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;">
  <tr><td style="background:${PALETTE.accent};border-radius:8px;">
    <a href="${esc(href)}" style="display:inline-block;padding:12px 22px;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;">${esc(label)}</a>
  </td></tr>
</table>`;
}
