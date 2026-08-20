"use client";

/**
 * How an SMTP failure is shown (§9).
 *
 * The summary and hint come from src/lib/mailError.ts; the raw server reply is
 * kept behind a disclosure so the useful sentence isn't buried under it, but
 * nothing is hidden — the raw text is what you paste into a search when the
 * hint turns out to be wrong.
 */
export interface Diagnosis {
  summary?: string;
  hint?: string;
  detail?: string;
}

export function MailDiagnosis({ d, ok }: { d: Diagnosis; ok?: boolean }) {
  if (!d.summary && !d.detail) return null;

  return (
    <div
      style={{
        marginTop: 10,
        padding: "10px 12px",
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${ok ? "var(--border)" : "var(--accent)"}`,
        borderRadius: 8,
        background: "var(--bg)",
      }}
    >
      {d.summary && (
        <p style={{ margin: 0, fontWeight: 600, color: ok ? "inherit" : "var(--accent)" }}>
          {d.summary}
        </p>
      )}
      {d.hint && (
        <p className="muted" style={{ margin: "6px 0 0 0", fontSize: "0.9em" }}>
          {d.hint}
        </p>
      )}
      {d.detail && (
        <details style={{ marginTop: 6 }}>
          <summary className="muted" style={{ fontSize: "0.85em", cursor: "pointer" }}>
            What the server said
          </summary>
          <code
            style={{
              display: "block",
              marginTop: 6,
              fontSize: "0.8em",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {d.detail}
          </code>
        </details>
      )}
    </div>
  );
}
