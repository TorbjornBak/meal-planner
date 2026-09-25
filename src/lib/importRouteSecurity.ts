import { csrfVerdict, expectedOrigin } from "./csrf.ts";
import { httpsIsGuaranteed, securityHeaders } from "./securityHeaders.ts";
import { turnstileEnabled } from "./turnstileConfig.ts";

/**
 * Keep the import endpoint's origin check and response headers when it bypasses
 * Node middleware. Next 15's middleware body clone can hand a disturbed stream
 * to the route before its handler runs, especially for larger uploads.
 */
export async function withImportRouteSecurity(
  req: Request,
  handler: () => Promise<Response>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const headers = securityHeaders({
    nonce,
    allowEval: env.NODE_ENV !== "production",
    httpsGuaranteed: httpsIsGuaranteed({ nodeEnv: env.NODE_ENV, appUrl: env.APP_URL }),
    turnstileEnabled: turnstileEnabled(env),
  });
  const finish = (res: Response): Response => {
    for (const [name, value] of headers) res.headers.set(name, value);
    return res;
  };

  const url = new URL(req.url);
  const origin = expectedOrigin({
    appUrl: env.APP_URL,
    nodeEnv: env.NODE_ENV,
    requestOrigin: url.origin,
  });
  if (
    csrfVerdict({
      method: req.method,
      pathname: url.pathname,
      originHeader: req.headers.get("origin"),
      refererHeader: req.headers.get("referer"),
      authorizationHeader: req.headers.get("authorization"),
      expectedOrigin: origin,
    }) === "block"
  ) {
    return finish(Response.json({ error: "request rejected" }, { status: 403 }));
  }

  try {
    return finish(await handler());
  } catch (error) {
    console.error("[recipe import] failed", error);
    return finish(
      Response.json(
        { error: "The server could not complete the import. Check the app logs before trying again." },
        { status: 500 },
      ),
    );
  }
}
