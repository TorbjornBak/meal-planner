/**
 * Classifying an address as loopback, link-local, carrier-grade-NAT, or
 * otherwise not a place an outbound fetch should be allowed to land (§10,
 * Phase 6).
 *
 * Pure, and separate from the guard in src/lib/image.ts for the same reason
 * src/lib/rateLimitPolicy.ts is separate from src/lib/rateLimit.ts: the part
 * worth getting right is a table of numeric ranges and their boundaries, and
 * none of that needs a socket or a DNS resolver to check. `image.ts` resolves
 * a hostname to the addresses it actually points at — which needs
 * `node:dns` and so can't live here — and asks this module whether any of
 * them is somewhere a pasted URL or a page's own declared photo URL
 * shouldn't be able to send this server.
 *
 * This app runs on a home box reachable over a private Tailscale tailnet
 * (§10). That is what makes 100.64.0.0/10 — carrier-grade-NAT space, not one
 * of the RFC 1918 ranges a generic "is this a public IP" check usually
 * stops at — the range that matters most here: it is Tailscale's own address
 * space, so without it a pasted recipe URL could probe every other machine
 * on the household's tailnet, not just the box's own loopback.
 *
 * Every classifier here takes a plain address string and returns the name of
 * the range it falls in, or null for "nothing here objects" — never a throw.
 * A string this module can't parse as the address shape it looks like (an
 * IPv6 literal with a syntax error, say) is classified as blocked rather than
 * ignored: for a guard whose only job is refusing addresses, "couldn't tell
 * what this is" and "let it through" must not be the same answer. An
 * ordinary hostname — no colon, and not all digits — is simply not this
 * module's business and always comes back null; resolving *that* is
 * `image.ts`'s job.
 */

/**
 * Parse one IPv4 address, accepting every notation the WHATWG URL Standard's
 * own "IPv4 parser" accepts — decimal, octal (a leading zero), hex (a
 * leading `0x`), and shorthand forms with fewer than four parts, where the
 * last part absorbs the remaining bytes (`127.1` is `127.0.0.1`).
 *
 * `resolvePublicUrl` in image.ts only ever calls this on `URL#hostname`,
 * which the URL constructor has already run through exactly this algorithm —
 * `new URL("http://2130706433/").hostname` comes back `"127.0.0.1"`, not
 * `"2130706433"`. So in practice that upstream normalization is what closes
 * the "decimal/octal/hex IP" bypass before this module ever sees the raw
 * string. This parser matches that algorithm anyway, rather than the plain
 * dotted-decimal regex it replaces, so the encoding bypass is closed by this
 * module's own logic too — testable without a URL object, and not resting
 * on a second piece of code continuing to agree with it forever.
 */
export function parseIPv4(host: string): number | null {
  if (host === "") return null;
  const parts = host.split(".");
  if (parts.length > 4) return null;

  const numbers: number[] = [];
  for (const part of parts) {
    const n = parseIPv4Part(part);
    if (n === null) return null;
    numbers.push(n);
  }

  // Every part but the last must fit in one byte; the last absorbs whatever
  // bits remain, which is what lets "127.1" mean 127.0.0.1.
  for (let i = 0; i < numbers.length - 1; i++) {
    if (numbers[i] > 255) return null;
  }
  const last = numbers[numbers.length - 1];
  const maxLast = 256 ** (5 - numbers.length) - 1;
  if (last > maxLast) return null;

  let value = last;
  for (let i = 0; i < numbers.length - 1; i++) {
    value += numbers[i] * 256 ** (3 - i);
  }
  return value >>> 0;
}

function parseIPv4Part(part: string): number | null {
  if (part === "") return null;
  let radix = 10;
  let digits = part;
  if (digits.length >= 2 && digits[0] === "0" && (digits[1] === "x" || digits[1] === "X")) {
    radix = 16;
    digits = digits.slice(2);
  } else if (digits.length >= 2 && digits[0] === "0") {
    radix = 8;
    digits = digits.slice(1);
  }
  if (digits === "") return 0; // "0", "0x", and "00" are all zero.

  const pattern = radix === 16 ? /^[0-9a-f]+$/i : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  if (!pattern.test(digits)) return null;
  const n = parseInt(digits, radix);
  return Number.isSafeInteger(n) ? n : null;
}

export function ipv4Octets(value: number): [number, number, number, number] {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

/**
 * Every IPv4 range this app refuses to fetch, most specific first where two
 * could otherwise overlap (none currently do — kept ordered anyway since the
 * next range added might).
 */
const IPV4_RANGES: Array<{
  name: string;
  test: (a: number, b: number, c: number, d: number) => boolean;
}> = [
  { name: "this-network", test: (a) => a === 0 }, // 0.0.0.0/8
  { name: "loopback", test: (a) => a === 127 }, // 127.0.0.0/8
  { name: "private-use", test: (a) => a === 10 }, // 10.0.0.0/8
  { name: "private-use", test: (a, b) => a === 172 && b >= 16 && b <= 31 }, // 172.16.0.0/12
  { name: "private-use", test: (a, b) => a === 192 && b === 168 }, // 192.168.0.0/16
  // Tailscale's own address space (§10) — see the module comment above.
  { name: "carrier-grade-nat", test: (a, b) => a === 100 && b >= 64 && b <= 127 }, // 100.64.0.0/10
  { name: "link-local", test: (a, b) => a === 169 && b === 254 }, // 169.254.0.0/16
  { name: "ietf-protocol-assignments", test: (a, b, c) => a === 192 && b === 0 && c === 0 }, // 192.0.0.0/24
  { name: "benchmarking", test: (a, b) => a === 198 && (b === 18 || b === 19) }, // 198.18.0.0/15
  { name: "multicast", test: (a) => a >= 224 && a <= 239 }, // 224.0.0.0/4
  { name: "reserved", test: (a) => a >= 240 }, // 240.0.0.0/4, including 255.255.255.255
];

/** The IPv4 range `host` falls in, or null if it's an ordinary public address. */
export function classifyIPv4(host: string): string | null {
  const value = parseIPv4(host);
  if (value === null) return null;
  return classifyIPv4Octets(...ipv4Octets(value));
}

function classifyIPv4Octets(a: number, b: number, c: number, d: number): string | null {
  return IPV4_RANGES.find((r) => r.test(a, b, c, d))?.name ?? null;
}

/**
 * Expand an IPv6 literal (no brackets, as `URL#hostname` and `dns.lookup`
 * both hand it back) into its eight 16-bit groups, or null if it isn't a
 * syntactically valid one.
 *
 * Handles the `::` compression and, because RFC 4291 permits it and at least
 * one bypass this module exists to catch depends on it (`::ffff:127.0.0.1`),
 * a dotted-decimal IPv4 tail in the last 32 bits.
 */
function expandIPv6(host: string): number[] | null {
  let input = host;

  const ipv4Tail = input.match(/(^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (ipv4Tail) {
    const value = parseIPv4(ipv4Tail[2]);
    if (value === null) return null;
    const [a, b, c, d] = ipv4Octets(value);
    const hi = ((a << 8) | b).toString(16);
    const lo = ((c << 8) | d).toString(16);
    input = input.slice(0, input.length - ipv4Tail[2].length) + `${hi}:${lo}`;
  }

  const halves = input.split("::");
  if (halves.length > 2) return null; // "::" may appear at most once.

  let head: string[];
  let tail: string[];
  if (halves.length === 2) {
    head = halves[0] === "" ? [] : halves[0].split(":");
    tail = halves[1] === "" ? [] : halves[1].split(":");
  } else {
    head = input === "" ? [] : input.split(":");
    tail = [];
  }

  const missing = 8 - head.length - tail.length;
  // Without "::" the address must spell out exactly eight groups; with it,
  // "::" has to be standing in for at least one.
  if (halves.length === 2 ? missing < 0 : missing !== 0) return null;

  const groups: number[] = [];
  for (const g of head) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    groups.push(parseInt(g, 16));
  }
  for (let i = 0; i < missing; i++) groups.push(0);
  for (const g of tail) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    groups.push(parseInt(g, 16));
  }
  return groups.length === 8 ? groups : null;
}

/**
 * The IPv4 address embedded in an IPv4-mapped (`::ffff:a.b.c.d`) or the
 * deprecated IPv4-compatible (`::a.b.c.d`) form, or null if `groups` isn't
 * either shape.
 */
function embeddedIPv4(groups: number[]): [number, number, number, number] | null {
  const zeroPrefix = groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0;
  if (!zeroPrefix) return null;
  if (groups[5] !== 0 && groups[5] !== 0xffff) return null;
  const hi = groups[6];
  const lo = groups[7];
  return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255];
}

/** The IPv6 range `host` (bracket-stripped, lower-cased) falls in. */
export function classifyIPv6(host: string): string | null {
  const groups = expandIPv6(host);
  if (!groups) return "unparseable";

  // Checked before the IPv4-mapped unwrap below: "::" and "::1" are each
  // also a technically-valid (fully zero) IPv4-compatible embedding, and the
  // exact address deserves its own name rather than "this-network"/"loopback"
  // borrowed from the IPv4 table.
  if (groups.every((g) => g === 0)) return "unspecified"; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return "loopback"; // ::1

  const mapped = embeddedIPv4(groups);
  if (mapped) return classifyIPv4Octets(...mapped);

  // fe80::/10 — the top 10 bits are fixed, i.e. the first group is 0xfe80–0xfebf.
  if (groups[0] >= 0xfe80 && groups[0] <= 0xfebf) return "link-local";
  // fc00::/7 — the top 7 bits are fixed, i.e. the first group's top byte is 0xfc or 0xfd.
  if (groups[0] >> 8 === 0xfc || groups[0] >> 8 === 0xfd) return "unique-local";
  return null;
}

/**
 * The range `raw` — a hostname, or an address handed back by `dns.lookup` —
 * falls in, or null if there's no reason here to refuse it.
 */
export function classifyAddress(raw: string): string | null {
  const host = raw.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return "localhost";
  // Not an IANA-assigned TLD; used by this deployment's own Tailscale
  // MagicDNS names and by convention for other private infrastructure.
  if (host.endsWith(".internal")) return "internal-tld";
  return host.includes(":") ? classifyIPv6(host) : classifyIPv4(host);
}

export function isPrivateAddress(raw: string): boolean {
  return classifyAddress(raw) !== null;
}
