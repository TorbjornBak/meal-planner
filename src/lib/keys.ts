/**
 * Normalize an ingredient name into a stable merge/diff key.
 *
 * Used for three things that must agree (§5):
 *   - merging the same ingredient across dinners into one shopping-list line,
 *   - diffing a regenerated list against the old one to preserve checked state,
 *   - matching against the pantry list by name.
 *
 * Deliberately simple: lowercase, strip punctuation, collapse whitespace, and
 * drop a trailing plural "s". Good enough for a household; not a stemmer.
 */
export function ingredientKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/s$/, "");
}
