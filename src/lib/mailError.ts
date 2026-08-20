/**
 * Turning an SMTP failure into something actionable (§9).
 *
 * Nodemailer reports failures as an error with a `code`, and sometimes the
 * server's own reply in `response`. On their own those are opaque —
 * "ECONNREFUSED" doesn't tell you that your mail server is on the host while
 * the app is in a container. This maps the handful that actually happen onto
 * the thing to go and check.
 *
 * Deliberately dependency-free and pure, so it can be unit-tested without an
 * SMTP server: pass in a shape like the error nodemailer throws, get a
 * sentence back.
 */

export interface MailErrorShape {
  code?: string;
  /** The SMTP verb that failed, e.g. "AUTH", "MAIL FROM", "CONN". */
  command?: string;
  /** The server's raw reply, when it got far enough to send one. */
  response?: string;
  responseCode?: number;
  message?: string;
}

export interface MailDiagnosis {
  /** One line naming the likely cause. */
  summary: string;
  /** What to change, when we can be specific about it. */
  hint?: string;
  /** The raw detail, always passed through so nothing is hidden. */
  detail: string;
}

/**
 * `SMTP_HOST` values that mean "this machine" — and so, inside a container,
 * mean the container itself rather than the box you think you're pointing at.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

export function describeMailError(err: unknown, host?: string): MailDiagnosis {
  const e = (err ?? {}) as MailErrorShape;
  const code = e.code ?? "";
  const response = e.response ?? "";
  const detail = [code, e.command, response || e.message].filter(Boolean).join(" · ") ||
    "No detail was reported.";

  const loopback = host ? LOOPBACK.has(host.trim().toLowerCase()) : false;

  // Nothing accepted the connection.
  if (code === "ECONNREFUSED") {
    return {
      summary: "Nothing is listening at that host and port.",
      hint: loopback
        ? "SMTP_HOST is localhost, which inside the app container means the container itself — not the box. Point it at the host's address (or add host.docker.internal via extra_hosts in docker-compose.yml)."
        : "Check SMTP_HOST and SMTP_PORT, and that the mail server accepts connections from the app.",
      detail,
    };
  }

  // The name didn't resolve.
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return {
      summary: "That hostname doesn't resolve from inside the app container.",
      hint: "Check SMTP_HOST for a typo, and that the container's DNS can see it — a name that resolves on the host doesn't always resolve in the container.",
      detail,
    };
  }

  // Connected to nothing, or to something that never replied.
  if (code === "ETIMEDOUT" || code === "ECONNRESET") {
    return {
      summary: "The connection opened but the server never completed the handshake.",
      hint: "Usually a firewall in the way, or the wrong port. 587 expects STARTTLS; 465 expects implicit TLS (SMTP_SECURE=true).",
      detail,
    };
  }

  // Credentials were rejected.
  if (code === "EAUTH" || e.responseCode === 535 || /^5(35|30)/.test(response)) {
    return {
      summary: "The mail server rejected the username or password.",
      hint: "Check SMTP_USER and SMTP_PASS. Providers that use app-specific passwords need one of those here, not the account password.",
      detail,
    };
  }

  // TLS: the certificate isn't trusted.
  if (
    /self[- ]signed certificate|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED/i.test(
      response || e.message || "",
    )
  ) {
    return {
      summary: "The mail server's TLS certificate isn't trusted.",
      hint: "Expected for a self-hosted server with a self-signed certificate. Set SMTP_TLS_REJECT_UNAUTHORIZED=false to accept it — only do that on a server you control, on a network you trust.",
      detail,
    };
  }

  // TLS: talking the wrong protocol at the port.
  if (code === "ESOCKET" || /wrong version number|SSL routines/i.test(e.message ?? "")) {
    return {
      summary: "TLS was negotiated the wrong way round for this port.",
      hint: "SMTP_SECURE=true is for implicit TLS on port 465. On 587, leave it false and let STARTTLS upgrade the connection.",
      detail,
    };
  }

  // The server took the connection but refused the message.
  if (code === "EENVELOPE" || e.responseCode === 550 || e.responseCode === 553) {
    return {
      summary: "The server accepted the connection but refused the message.",
      hint: "Usually MAIL_FROM isn't an address this server is willing to send as, or it won't relay to that recipient.",
      detail,
    };
  }

  return {
    summary: "The mail server refused the message.",
    hint: "The raw error below is what the server said.",
    detail,
  };
}
