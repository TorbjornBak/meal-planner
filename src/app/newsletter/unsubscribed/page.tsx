import Link from "next/link";

/**
 * Where the unsubscribe link lands (§9b). Public, because it's reached
 * straight from a mail client with no session.
 */
export default async function UnsubscribedPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string }>;
}) {
  const { ok } = await searchParams;

  if (ok !== "1") {
    return (
      <div className="card" style={{ maxWidth: 420, margin: "3rem auto" }}>
        <h1>That link didn&apos;t work</h1>
        <p style={{ color: "var(--muted)" }}>
          It may have been truncated by your mail client. You can also turn the weekly email off
          in Settings.
        </p>
        <p style={{ marginTop: 16 }}>
          <Link href="/settings">Open Settings</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="card" style={{ maxWidth: 420, margin: "3rem auto" }}>
      <h1>Unsubscribed</h1>
      <p style={{ color: "var(--muted)" }}>
        You won&apos;t get the weekly dinner email any more. Your account and the household&apos;s
        plan are untouched — you can turn it back on in Settings whenever you like.
      </p>
      <p style={{ marginTop: 16 }}>
        <Link href="/settings">Open Settings</Link>
      </p>
    </div>
  );
}
