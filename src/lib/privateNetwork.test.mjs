// Tests for the address classification behind the outbound-fetch guard
// (§1, §2b, §10, Phase 6). Run with `npm test`.
//
// This is the exhaustive part: every range src/lib/privateNetwork.ts refuses,
// checked at both boundaries, plus the encoding tricks (decimal/octal/hex
// IPv4, IPv4-mapped IPv6) that a plain dotted-quad regex would miss. It's
// pure and fast enough to check the whole table here rather than trust that
// src/lib/image.ts's DNS-resolving guard happens to exercise every branch.

import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyAddress,
  classifyIPv4,
  classifyIPv6,
  isPrivateAddress,
  parseIPv4,
} from "./privateNetwork.ts";

test("parseIPv4 accepts the WHATWG encodings, not just plain dotted-decimal", () => {
  assert.equal(parseIPv4("127.0.0.1"), 0x7f000001);
  assert.equal(parseIPv4("2130706433"), 0x7f000001); // plain decimal, no dots
  assert.equal(parseIPv4("0x7f.0.0.1"), 0x7f000001); // hex first octet
  assert.equal(parseIPv4("0x7f000001"), 0x7f000001); // hex, no dots
  assert.equal(parseIPv4("0177.0.0.1"), 0x7f000001); // octal first octet (0177 = 127)
  assert.equal(parseIPv4("127.1"), 0x7f000001); // shorthand: last part absorbs the rest
  assert.equal(parseIPv4("127.0.1"), 0x7f000001); // three-part shorthand
});

test("parseIPv4 rejects out-of-range octets and junk", () => {
  assert.equal(parseIPv4("256.0.0.1"), null);
  assert.equal(parseIPv4("1.2.3.4.5"), null); // too many parts
  assert.equal(parseIPv4(""), null);
  assert.equal(parseIPv4("example.com"), null); // letters that aren't a 0x prefix
  assert.equal(parseIPv4("1.2.3."), null); // trailing empty part
  assert.equal(parseIPv4("999999999999"), null); // exceeds 32 bits, even as one part
});

// One row per range this app refuses to fetch, both just inside and just
// outside its boundary. Each pair should classify oppositely; if it doesn't,
// the range test in privateNetwork.ts has an off-by-one.
const IPV4_BOUNDARIES = [
  { name: "this-network", blocked: "0.0.0.0", allowed: null },
  { name: "loopback", blocked: "127.255.255.255", allowed: "128.0.0.0" },
  { name: "private-use 10/8", blocked: "10.255.255.255", allowed: "11.0.0.0" },
  { name: "private-use 172.16/12 low", blocked: "172.16.0.0", allowed: "172.15.255.255" },
  { name: "private-use 172.16/12 high", blocked: "172.31.255.255", allowed: "172.32.0.0" },
  { name: "private-use 192.168/16", blocked: "192.168.255.255", allowed: "192.169.0.0" },
  { name: "carrier-grade NAT low (§10)", blocked: "100.64.0.0", allowed: "100.63.255.255" },
  { name: "carrier-grade NAT high", blocked: "100.127.255.255", allowed: "100.128.0.0" },
  { name: "link-local 169.254/16 low", blocked: "169.254.0.0", allowed: "169.253.255.255" },
  { name: "link-local 169.254/16 high", blocked: "169.254.255.255", allowed: "169.255.0.0" },
  { name: "ietf-protocol-assignments 192.0.0/24", blocked: "192.0.0.255", allowed: "192.0.1.0" },
  { name: "benchmarking 198.18.0/15 low", blocked: "198.18.0.0", allowed: "198.17.255.255" },
  { name: "benchmarking 198.18.0/15 high", blocked: "198.19.255.255", allowed: "198.20.0.0" },
  { name: "multicast 224/4 low", blocked: "224.0.0.0", allowed: "223.255.255.255" },
  // 240.0.0.0 is not "allowed" here: it's the first address of the
  // adjoining reserved range, so multicast's high boundary is only checkable
  // on the blocked side.
  { name: "multicast 224/4 high", blocked: "239.255.255.255", allowed: null },
  { name: "reserved 240/4 low", blocked: "240.0.0.0", allowed: null },
  { name: "reserved 240/4, incl. broadcast", blocked: "255.255.255.255", allowed: null },
];

test("IPv4 ranges block exactly at their documented boundary", () => {
  for (const { name, blocked, allowed } of IPV4_BOUNDARIES) {
    assert.equal(isPrivateAddress(blocked), true, `${name}: ${blocked} should be blocked`);
    if (allowed) {
      assert.equal(isPrivateAddress(allowed), false, `${name}: ${allowed} should be allowed`);
    }
  }
});

test("ordinary public IPv4 addresses are never blocked (the guard must not break the feature)", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "151.101.1.69", "203.0.113.5"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("IPv6 special ranges", () => {
  assert.equal(classifyIPv6("::"), "unspecified");
  assert.equal(classifyIPv6("::1"), "loopback");
  assert.equal(classifyIPv6("fe80::1"), "link-local");
  assert.equal(classifyIPv6("fe80::"), "link-local");
  assert.equal(classifyIPv6("febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"), "link-local"); // top of fe80::/10
  assert.equal(classifyIPv6("fec0::1"), null); // just past fe80::/10 — not the (deprecated) site-local range
  assert.equal(classifyIPv6("fc00::1"), "unique-local");
  assert.equal(classifyIPv6("fd12:3456::1"), "unique-local");
  assert.equal(classifyIPv6("fe00::1"), null); // outside fc00::/7
  assert.equal(classifyIPv6("2001:db8::1"), null); // documentation range, but not one we block
  assert.equal(classifyIPv6("2606:4700:4700::1111"), null); // a real public resolver
});

test("IPv6 is case-insensitive and accepts the bracketed form classifyAddress receives", () => {
  assert.equal(classifyAddress("[FE80::1]"), "link-local");
  assert.equal(classifyAddress("FE80::1"), "link-local");
});

test("IPv4-mapped and IPv4-compatible IPv6 addresses inherit the embedded address's own class", () => {
  // Both spellings of the same address (RFC 4291's mixed notation vs. the
  // canonical hex-group form `dns.lookup`/URL hand back) must agree.
  assert.equal(classifyIPv6("::ffff:127.0.0.1"), "loopback");
  assert.equal(classifyIPv6("::ffff:7f00:1"), "loopback");
  assert.equal(classifyIPv6("::ffff:169.254.169.254"), "link-local");
  assert.equal(classifyIPv6("::ffff:10.0.0.1"), "private-use");
  // A public address wrapped in IPv4-mapped notation is still public — the
  // notation itself is not a reason to block, only what it contains is.
  assert.equal(classifyIPv6("::ffff:8.8.8.8"), null);
  assert.equal(classifyIPv6("::8.8.8.8"), null); // deprecated IPv4-compatible form
});

test("a syntactically invalid IPv6-shaped host is blocked, not ignored", () => {
  // classifyAddress must never treat "couldn't parse this" as "safe to
  // fetch" — see the module comment on why unparseable fails closed.
  assert.equal(classifyIPv6("not:valid:::ipv6"), "unparseable");
  assert.equal(isPrivateAddress("[not:valid:::ipv6]"), true);
});

test("named private hosts", () => {
  for (const host of ["localhost", "foo.localhost", "box.internal", "LOCALHOST"]) {
    assert.equal(isPrivateAddress(host), true, host);
  }
});

test("ordinary hostnames are not classified here at all — that's image.ts's DNS lookup", () => {
  for (const host of ["example.com", "www.arla.dk", "valdemarsro.dk", "allrecipes.com"]) {
    assert.equal(classifyAddress(host), null, host);
  }
});
