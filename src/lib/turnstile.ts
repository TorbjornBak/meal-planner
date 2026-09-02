import { clientIp } from "./rateLimitPolicy.ts";
import type { TurnstileAction } from "./turnstileActions.ts";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface SiteverifyResult {
  success?: boolean;
  action?: string;
  hostname?: string;
}

/** Verify a browser-provided Turnstile token before a protected handler runs. */
export async function verifyTurnstile(
  request: Request,
  token: unknown,
  expectedAction: TurnstileAction,
): Promise<boolean> {
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) return false;

  const secret = process.env.TURNSTILE_SECRET?.trim();
  const hostnames = new Set(
    (process.env.TURNSTILE_HOSTNAMES ?? "")
      .split(",")
      .map((hostname) => hostname.trim())
      .filter(Boolean),
  );
  if (!secret || hostnames.size === 0) return false;

  const body = new URLSearchParams({ secret, response: token });
  const ip = clientIp(request.headers);
  if (ip) body.set("remoteip", ip);

  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10_000),
      body,
    });
    if (!response.ok) return false;

    const result = (await response.json()) as SiteverifyResult;
    return (
      result.success === true &&
      result.action === expectedAction &&
      typeof result.hostname === "string" &&
      hostnames.has(result.hostname)
    );
  } catch {
    return false;
  }
}
