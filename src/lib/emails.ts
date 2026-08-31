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

/**
 * "Come and share our kitchen."
 *
 * Links to /invite/<token>, not /reset/<token>: an invitation is no longer a
 * password reset wearing different words. The recipient may already have an
 * account here, in which case that page asks them for nothing at all — which
 * is why this copy promises a way in rather than a password field.
 */
export function householdInviteEmail(opts: {
  name: string | null;
  token: string;
  invitedBy: string;
  householdName: string;
}): Composed {
  const link = appUrl(`/invite/${opts.token}`);
  const hello = opts.name ? `Hi ${opts.name},` : "Hi,";
  const subject = `${opts.invitedBy} invited you to a MealPlanner household`;

  const text = `${hello}

${opts.invitedBy} invited you to join ${opts.householdName} on MealPlanner — the
shared dinner plan, recipe library and shopping list.

Accept the invitation here:

${link}

The link works for seven days, once, and only for this email address. If you
weren't expecting it, you can ignore it — nothing happens until you accept.`;

  const html = layout({
    title: subject,
    preheader: `${opts.invitedBy} invited you to join ${opts.householdName}.`,
    body: `<p style="margin:0 0 12px 0;">${esc(hello)}</p>
<p style="margin:0 0 4px 0;">${esc(opts.invitedBy)} invited you to join <strong>${esc(opts.householdName)}</strong> on MealPlanner — the shared dinner plan, recipe library and shopping list.</p>
${button(link, "Accept the invitation")}
<p style="margin:0;color:${PALETTE.muted};font-size:14px;">The link works for seven days, once, and only for this email address. If you weren't expecting it, ignore it — nothing happens until you accept.</p>`,
  });

  return { subject, text, html };
}

/**
 * "You may set up a household here."
 *
 * The installation-wide invitation (§9, Phase 5). Nothing exists for the
 * recipient yet: accepting creates their household and makes them the first
 * admin of it, so the copy has to be about starting rather than joining.
 */
export function platformInviteEmail(opts: {
  name: string | null;
  token: string;
  invitedBy: string;
  householdName: string | null;
}): Composed {
  const link = appUrl(`/invite/${opts.token}`);
  const hello = opts.name ? `Hi ${opts.name},` : "Hi,";
  const subject = "You've been invited to set up a MealPlanner household";
  const named = opts.householdName
    ? ` It'll be called ${opts.householdName} unless you'd rather it weren't.`
    : "";

  const text = `${hello}

${opts.invitedBy} has set you up with a household of your own on MealPlanner —
somewhere to keep your dinner plan, your recipes and your shopping list.${named}

Get started here:

${link}

The link works for seven days, once, and only for this email address.`;

  const html = layout({
    title: subject,
    preheader: "Set up your own MealPlanner household.",
    body: `<p style="margin:0 0 12px 0;">${esc(hello)}</p>
<p style="margin:0 0 4px 0;">${esc(opts.invitedBy)} has set you up with a household of your own on MealPlanner — somewhere to keep your dinner plan, your recipes and your shopping list.${esc(named)}</p>
${button(link, "Set up your household")}
<p style="margin:0;color:${PALETTE.muted};font-size:14px;">The link works for seven days, once, and only for this email address.</p>`,
  });

  return { subject, text, html };
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
