import Link from "next/link";
import { peekAuthToken } from "@/lib/auth";
import { MIN_PASSWORD_LENGTH } from "@/lib/password";
import { ResetForm } from "./ResetForm";

/**
 * Land here from an emailed link (§9).
 *
 * Checked on the server before anything renders, so a dead link says so
 * immediately rather than after the visitor has typed a password twice. The
 * token is only *peeked* at here — it isn't spent until the form is submitted.
 */
export default async function ResetPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Resets and invitations arrive on the same URL shape; try each in turn so
  // the page can word itself correctly.
  const reset = await peekAuthToken(token, "PASSWORD_RESET");
  const invite = reset ? null : await peekAuthToken(token, "INVITE");

  if (!reset && !invite) {
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

  return (
    <ResetForm
      token={token}
      purpose={reset ? "PASSWORD_RESET" : "INVITE"}
      minLength={MIN_PASSWORD_LENGTH}
    />
  );
}
