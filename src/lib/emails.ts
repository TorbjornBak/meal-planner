/**
 * Email templates (§9).
 *
 * The presentation primitives live in src/lib/emailLayout.ts, which is kept
 * free of dependencies; these templates add the copy and the absolute links,
 * which is why this module needs the environment (appUrl) and that one doesn't.
 *
 * Every template returns HTML *and* plain text. The text half is not an
 * afterthought; it's what a watch notification shows.
 */

import { PALETTE, button, esc, layout, type Composed } from "./emailLayout.ts";
import { appUrl } from "@/lib/mail";

/**
 * "Somebody asked to reset your password."
 *
 * Deliberately says *if this wasn't you, ignore it* rather than urging action:
 * the request is unauthenticated, so this mail can land in the inbox of
 * someone who did nothing at all.
 */
export function passwordResetEmail(opts: { name: string | null; token: string }): Composed {
  const link = appUrl(`/reset/${opts.token}`);
  const hello = opts.name ? `Hi ${opts.name},` : "Hi,";

  const text = `${hello}

Someone asked to reset the password on your MealPlanner account. To choose a
new one, open this link within the next hour:

${link}

If that wasn't you, you can ignore this email — your password stays as it is.`;

  const html = layout({
    title: "Reset your MealPlanner password",
    preheader: "Choose a new password — the link works for one hour.",
    body: `<p style="margin:0 0 12px 0;">${esc(hello)}</p>
<p style="margin:0 0 4px 0;">Someone asked to reset the password on your MealPlanner account. Choose a new one:</p>
${button(link, "Set a new password")}
<p style="margin:0;color:${PALETTE.muted};font-size:14px;">This link works for one hour and only once. If it wasn't you, ignore this email — your password stays as it is.</p>`,
  });

  return { subject: "Reset your MealPlanner password", text, html };
}

/** "You've been added to the household." Same machinery, warmer copy. */
export function inviteEmail(opts: {
  name: string | null;
  token: string;
  invitedBy: string;
}): Composed {
  const link = appUrl(`/reset/${opts.token}`);
  const hello = opts.name ? `Hi ${opts.name},` : "Hi,";

  const text = `${hello}

${opts.invitedBy} added you to their MealPlanner household — the shared dinner
plan, recipe library and shopping list.

Pick a password to get in:

${link}

The link works for seven days.`;

  const html = layout({
    title: "You've been added to a MealPlanner household",
    preheader: `${opts.invitedBy} added you to their MealPlanner household.`,
    body: `<p style="margin:0 0 12px 0;">${esc(hello)}</p>
<p style="margin:0 0 4px 0;">${esc(opts.invitedBy)} added you to their MealPlanner household — the shared dinner plan, recipe library and shopping list.</p>
${button(link, "Pick a password")}
<p style="margin:0;color:${PALETTE.muted};font-size:14px;">The link works for seven days.</p>`,
  });

  return { subject: "You've been added to a MealPlanner household", text, html };
}

/** Confirmation that a password actually changed, sent after the fact. */
export function passwordChangedEmail(opts: { name: string | null }): Composed {
  const hello = opts.name ? `Hi ${opts.name},` : "Hi,";
  const link = appUrl("/forgot");

  const text = `${hello}

Your MealPlanner password was just changed, and every signed-in device was
signed out.

If that wasn't you, reset the password immediately: ${link}`;

  const html = layout({
    title: "Your MealPlanner password changed",
    preheader: "Your password was changed and all devices were signed out.",
    body: `<p style="margin:0 0 12px 0;">${esc(hello)}</p>
<p style="margin:0 0 12px 0;">Your MealPlanner password was just changed, and every signed-in device was signed out.</p>
<p style="margin:0;color:${PALETTE.muted};font-size:14px;">If that wasn't you, <a href="${esc(link)}" style="color:${PALETTE.accent};">reset it immediately</a>.</p>`,
  });

  return { subject: "Your MealPlanner password changed", text, html };
}
