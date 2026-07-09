/**
 * Deterministic recipe parsing (§1) — no LLM.
 *
 * anotherdayofeating.dk (and similar) recipes have a rigid structure we can
 * parse with plain string handling: a title line, a "Nok til N pers." servings
 * line, and an ingredient block bracketed by "HVAD SKAL DU BRUGE:" and the
 * method header, with all-caps sub-section headers and one ingredient per line.
 *
 * The output still feeds the mandatory review-and-edit step — this parser is
 * best-effort and honest: when it can't confidently read a quantity or unit it
 * leaves them null rather than guessing, so a human can fix it before the line
 * counts toward anything.
 */

export interface ParsedIngredient {
  name: string;
  /** null for "to taste" / vague ("en håndfuld") / unmeasured. */
  quantity: number | null;
  /** e.g. "g", "tsk", or null for a bare count / no recognized unit. */
  unit: string | null;
}

export interface ParsedRecipe {
  name: string;
  source: string | null;
  statedServings: number;
  ingredients: ParsedIngredient[];
  /** The method/steps block, for the cooking view. Null if not found. */
  instructions: string | null;
}

/** Danish measuring units we recognize as an ingredient's unit. */
const UNITS = new Set([
  "tsk",
  "spsk",
  "g",
  "kg",
  "mg",
  "ml",
  "cl",
  "dl",
  "l",
  "stk",
  "fed",
  "dåse",
  "dåser",
  "knsp",
]);

/** Leading vague-quantity phrases we strip to get a clean ingredient name. */
const VAGUE_PREFIX =
  /^(en håndfuld|et drys|et nip|en knivspids|squish|lidt|et|en)\s+/i;

const INGREDIENTS_START = /hvad skal du bruge|ingredienser/i;
const METHOD_START = /^(hvordan|fremgangs|s[åa]dan|tilberedning)/i;
// Sections that follow the method (tips / allergy notes / sign-off) — where the
// instructions block ends.
const NOTES_START = /^(opm[æae]rksomhed|tips|noter|god forn[øo]jelse)/i;
const SERVINGS = /nok til\s+(\d+)(?:\s*[–-]\s*(\d+))?\s*pers/i;
const BARE_DOMAIN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

export function parseRecipeText(text: string): ParsedRecipe {
  const rawLines = text.split(/\r?\n/).map((l) => l.trim());
  const lines = rawLines.filter((l) => l.length > 0);

  return {
    name: extractTitle(lines),
    source: extractSource(lines),
    statedServings: extractServings(text),
    ingredients: extractIngredients(lines),
    instructions: extractInstructions(lines),
  };
}

function extractInstructions(lines: string[]): string | null {
  const start = lines.findIndex((l) => METHOD_START.test(l));
  if (start === -1) return null;

  const steps: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (NOTES_START.test(lines[i])) break; // reached tips / notes section
    steps.push(lines[i]);
  }
  const text = steps.join("\n").trim();
  return text.length > 0 ? text : null;
}

function extractTitle(lines: string[]): string {
  // First non-empty line is the title; strip a trailing " — site name" suffix.
  const first = lines[0] ?? "Untitled recipe";
  return first.split(/\s[—–-]\s/)[0].trim() || first;
}

function extractSource(lines: string[]): string | null {
  // A line that is just a domain (e.g. "anotherdayofeating.dk").
  const domain = lines.find(
    (l) => BARE_DOMAIN.test(l) && /\.(dk|com|net|org|se|no)$/i.test(l),
  );
  return domain ?? null;
}

function extractServings(text: string): number {
  const m = text.match(SERVINGS);
  if (!m) return 4; // sensible default; editable in review
  const lo = Number(m[1]);
  const hi = m[2] ? Number(m[2]) : lo;
  return Math.max(lo, hi); // "3-4 pers." → 4
}

function extractIngredients(lines: string[]): ParsedIngredient[] {
  const start = lines.findIndex((l) => INGREDIENTS_START.test(l));
  if (start === -1) return [];

  const out: ParsedIngredient[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (METHOD_START.test(line)) break; // reached the method section
    if (isSectionHeader(line)) continue; // e.g. BLOMKÅL / ÆRTECREME / TOPPING
    out.push(parseIngredientLine(line));
  }
  return out;
}

/** All-caps lines are sub-section headers, not ingredients. */
function isSectionHeader(line: string): boolean {
  return /[A-ZÆØÅ]/.test(line) && line === line.toUpperCase();
}

function parseIngredientLine(line: string): ParsedIngredient {
  // Optional leading amount, possibly a range ("6-8"), then the rest.
  const m = line.match(
    /^(\d+(?:[.,]\d+)?)(?:\s*[–-]\s*(\d+(?:[.,]\d+)?))?\s+(.*)$/,
  );

  if (!m) {
    // No leading number: to-taste / vague. Clean up the name.
    return { name: cleanName(line), quantity: null, unit: null };
  }

  const lo = Number(m[1].replace(",", "."));
  const hi = m[2] ? Number(m[2].replace(",", ".")) : lo;
  const quantity = Math.max(lo, hi); // round up to buy enough

  const rest = m[3].trim();
  const firstTok = rest.split(/\s+/)[0].toLowerCase().replace(/\.$/, "");

  if (UNITS.has(firstTok)) {
    const name = rest.slice(rest.indexOf(" ") + 1).trim();
    return { name: cleanName(name), quantity, unit: firstTok };
  }

  // Number with no recognized unit ("1 stort blomkål", "20 lys miso").
  return { name: cleanName(rest), quantity, unit: null };
}

function cleanName(name: string): string {
  return name
    .replace(VAGUE_PREFIX, "") // drop "en håndfuld", "squish", …
    .replace(/\s*\([^)]*\)\s*$/, "") // drop a trailing "(valgfrit)" note
    .trim();
}
