/**
 * Password hashing (§9).
 *
 * scrypt from node:crypto — memory-hard, in the standard library, and so no
 * new dependency and nothing to keep patched. The same reasoning that keeps
 * recipe parsing and receipt OCR in-process (§12) applies to hashing.
 *
 * Node-only: unlike src/lib/auth.ts this uses node:crypto, so it must not be
 * imported from Edge-runtime code.
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Cost parameters. N=2^15 costs roughly 100ms and 32 MB per hash on the home
 * box — slow enough to make guessing expensive, fast enough that signing in
 * feels instant. They're written into every hash, so raising them later leaves
 * existing passwords verifiable.
 */
const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

// scrypt's default maxmem (32 MB) is exactly at the limit for N=2^15; give it
// room so Node doesn't refuse the very parameters we asked for.
const MAXMEM = 128 * 1024 * 1024;

/** Shortest password we'll accept. Length beats character-class rules. */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * Hash a password for storage.
 *
 * Returns a self-describing string — `scrypt$N$r$p$salt$hash`, salt and hash
 * base64 — so a stored hash carries the parameters it was made with.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(password.normalize("NFKC"), salt, KEYLEN, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  });
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

/**
 * Check a password against a stored hash, in constant time.
 *
 * Never throws on a malformed or unrecognised hash — it returns false, so a
 * corrupt row denies access rather than 500ing the login route.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;

  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const actual = await scryptAsync(password.normalize("NFKC"), salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: MAXMEM,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    // Absurd cost parameters in a tampered row land here.
    return false;
  }
}

let dummy: Promise<string> | null = null;

/**
 * A hash of nothing in particular, to verify against when no account matched.
 *
 * Without it, signing in as an unknown address returns before scrypt has run
 * and a stopwatch tells an attacker which addresses are real. Computed once,
 * on first miss, over a value nobody can supply.
 */
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(32).toString("base64"));
  return dummy;
}

/**
 * Why a password is unacceptable, or null if it's fine.
 *
 * Deliberately minimal: a length floor and a check that it isn't one of the
 * handful of passwords every credential-stuffing list opens with.
 */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) {
    return "That's longer than 200 characters.";
  }
  if (OBVIOUS.has(password.toLowerCase())) {
    return "That password is too easy to guess.";
  }
  return null;
}

const OBVIOUS = new Set([
  "password",
  "password1",
  "password123",
  "12345678",
  "123456789",
  "1234567890",
  "qwertyuiop",
  "letmein123",
  "mealplanner",
]);
