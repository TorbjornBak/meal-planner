import Link from "next/link";
import { peekAuthToken } from "@/lib/auth";
import { MIN_PASSWORD_LENGTH } from "@/lib/password";
import { ResetForm } from "./ResetForm";

/**
 * Land here from an emailed reset link (§9).
 *
 * Checked on the server before anything renders, so a dead link says so
 * immediately rather than after the visitor has typed a password twice. The
 * token is only *peeked* at here — it isn't spent until the form is submitted.
 *
 * This page used to also serve invitations: before the `Invitation` model
 * existed, one was minted as an `AuthToken` with purpose `INVITE` and
 * redeemed on this same URL shape. Phase 4 replaced that with `Invitation`
 * rows and /invite/[token]; nothing has minted an `INVITE` token since, so
 * there is only one kind of link left for this page to word (Phase 6).
 */
export default async function ResetPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const reset = await peekAuthToken(token, "PASSWORD_RESET");

  if (!reset) {
    return (
      <div className="card" style={{ maxWidth: 380, margin: "3rem auto" }}>
        <h1>That link has expired</h1>
        <p style={{ color: "var(--muted)" }}>
          Password links can only be used once, and they don&apos;t last forever. Ask for a fresh
          one and it&apos;ll be in your inbox in a moment.
        </p>
        <p style={{ marginTop: 16 }}>
          <Link href="/forgot">Email me a new link</Link>
        </p>
      </div>
    );
  }

  return <ResetForm token={token} minLength={MIN_PASSWORD_LENGTH} />;
}
