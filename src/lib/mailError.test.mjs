// Tests for the SMTP failure interpreter (§9). Run with `npm test`.
//
// The shapes below are what nodemailer actually throws for each failure mode.
// Pure input to pure output, so no SMTP server is involved.

import test from "node:test";
import assert from "node:assert/strict";

import { describeMailError } from "./mailError.ts";

test("connection refused to localhost names the container trap", () => {
  const d = describeMailError({ code: "ECONNREFUSED", command: "CONN" }, "localhost");
  assert.match(d.summary, /Nothing is listening/);
  // The single most likely cause when the mail server runs on the host.
  assert.match(d.hint, /container itself/);
  assert.match(d.hint, /host\.docker\.internal/);
});

test("connection refused to a real host doesn't blame Docker", () => {
  const d = describeMailError({ code: "ECONNREFUSED" }, "smtp.example.com");
  assert.match(d.summary, /Nothing is listening/);
  assert.ok(!d.hint.includes("container itself"));
});

test("127.0.0.1 counts as loopback too", () => {
  const d = describeMailError({ code: "ECONNREFUSED" }, "127.0.0.1");
  assert.match(d.hint, /container itself/);
});

test("DNS failure points at the container's resolver", () => {
  const d = describeMailError({ code: "ENOTFOUND" }, "smpt.example.com");
  assert.match(d.summary, /doesn't resolve/);
  assert.match(d.hint, /DNS/);
});

test("rejected credentials are reported as credentials", () => {
  const d = describeMailError({ code: "EAUTH", responseCode: 535, response: "535 5.7.8 Bad" });
  assert.match(d.summary, /rejected the username or password/);
  assert.match(d.hint, /SMTP_USER/);
});

test("a self-signed certificate names the opt-out and its caveat", () => {
  const d = describeMailError({
    code: "ESOCKET",
    message: "self-signed certificate in certificate chain",
  });
  assert.match(d.summary, /certificate isn't trusted/);
  assert.match(d.hint, /SMTP_TLS_REJECT_UNAUTHORIZED=false/);
  assert.match(d.hint, /server you control/);
});

test("a TLS version mismatch explains the 465-vs-587 split", () => {
  const d = describeMailError({ code: "ESOCKET", message: "wrong version number" });
  assert.match(d.summary, /wrong way round/);
  assert.match(d.hint, /465/);
  assert.match(d.hint, /587/);
});

test("a refused envelope points at MAIL_FROM", () => {
  const d = describeMailError({ code: "EENVELOPE", responseCode: 550, response: "550 denied" });
  assert.match(d.summary, /refused the message/);
  assert.match(d.hint, /MAIL_FROM/);
});

test("timeouts blame the firewall or the port, not the credentials", () => {
  const d = describeMailError({ code: "ETIMEDOUT" });
  assert.match(d.summary, /never completed the handshake/);
  assert.match(d.hint, /firewall/);
});

test("the raw server reply always survives into the detail", () => {
  const d = describeMailError({
    code: "EAUTH",
    command: "AUTH PLAIN",
    response: "535 5.7.8 Username and Password not accepted",
  });
  assert.match(d.detail, /EAUTH/);
  assert.match(d.detail, /AUTH PLAIN/);
  assert.match(d.detail, /Username and Password not accepted/);
});

test("an unrecognised failure still returns something printable", () => {
  const d = describeMailError({ code: "EWEIRD", message: "something odd" });
  assert.ok(d.summary.length > 0);
  assert.match(d.detail, /EWEIRD/);
});

test("a non-error value doesn't throw", () => {
  // sendMail can in principle reject with anything.
  const d = describeMailError(undefined);
  assert.ok(d.summary.length > 0);
  assert.equal(d.detail, "No detail was reported.");
});
