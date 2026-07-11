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

/**
 * Measuring units we recognize as an ingredient's unit — Danish and English,
 * so recipes pasted from Danish sites (anotherdayofeating, Vegetarisk Hverdag)
 * and English ones (Ottolenghi) both parse.
 */
const UNITS = new Set([
  // Danish
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
  "ds",
  "knsp",
  "håndfuld",
  "bundt",
  "pakke",
  // English
  "tsp",
  "tbsp",
  "cup",
  "cups",
  "oz",
  "lb",
  "lbs",
  "pound",
  "pounds",
  "clove",
  "cloves",
  "can",
  "cans",
  "tin",
  "tins",
  "pinch",
  "slice",
  "slices",
  "bunch",
  "pack",
  "packet",
  "stick",
  "sticks",
  "sprig",
  "sprigs",
]);

/** Leading vague-quantity phrases we strip to get a clean ingredient name. */
const VAGUE_PREFIX =
  /^(en håndfuld|et drys|et nip|en knivspids|a handful of|a pinch of|a couple of|a few|squish|lidt|et|en|a|an)\s+/i;

// Section markers, anchored to the start of a (trimmed) line so a stray mention
// in the intro prose doesn't trip them. Danish + English.
const INGREDIENTS_START = /^(hvad skal du bruge|ingredienser|ingredients)\b/i;
const METHOD_START =
  /^(hvordan|fremgangs|s[åa]dan|tilberedning|method|instructions?|directions?|preparation|steps?|how to)\b/i;
// Sections that follow the method (tips / allergy notes / sign-off) — where the
// instructions block ends.
const NOTES_START = /^(opm[æae]rksomhed|tips|noter|god forn[øo]jelse|notes?)\b/i;

// Page chrome that appears after the recipe on modern sites (cart, share
// widgets, "you may also like", footer nav) — pasting a whole page drags it in.
// These distinctive lines never occur inside a real cooking step, so the first
// one we hit marks the end of the instructions. Ottolenghi's footer starts with
// "Quick add" / "View basket"; the rest are defensive.
const BOILERPLATE_STOP =
  /^(quick add|quick buy|added to your (cart|basket)|view basket|view cart|add to basket|add to cart|your (cart|basket)|continue shopping|are you over \d+|checkout|all done|close follow mode|follow mode|tag @|tag us|share with friends|share this|you may also like|on social|experience ottolenghi|book a table|buy a gift voucher|add comment|be the first|lock thread|next step|choosing a selection|opens in a new window|privacy and cookies|terms and conditions|terms of use|site by|all rights? reserved|©|copyright)\b/i;

const BARE_DOMAIN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

// Servings phrasings, most specific first. Danish "Nok til 4 pers." / "4
// portioner", English "Serves 4-6" / "Makes 12".
const SERVINGS_PATTERNS: RegExp[] = [
  /nok til\s+(\d+)(?:\s*[–-]\s*(\d+))?\s*pers/i,
  /serves?\s+(\d+)(?:\s*[–-]\s*(\d+))?/i,
  /makes?\s+(\d+)(?:\s*[–-]\s*(\d+))?/i,
  /(\d+)(?:\s*[–-]\s*(\d+))?\s*(?:portioner|portion|personer|pers\.?|servings?|people)/i,
];

/** First servings count found in the text (upper bound of a range), or null. */
function servingsFrom(text: string): number | null {
  for (const re of SERVINGS_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const lo = Number(m[1]);
      const hi = m[2] ? Number(m[2]) : lo;
      return Math.max(lo, hi);
    }
  }
  return null;
}

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
    // Stop at a notes/tips section or at the page-footer chrome that follows
    // the recipe when a whole page is pasted.
    if (NOTES_START.test(lines[i]) || BOILERPLATE_STOP.test(lines[i])) break;
    steps.push(lines[i]);
  }
  const text = steps.join("\n").trim();
  return text.length > 0 ? text : null;
}

/** Strip a trailing " — Site Name" / " | Site Name" suffix from a title. */
function cleanTitle(line: string): string {
  return line.split(/\s+[—–|]\s+/)[0].split(/\s[—–-]\s/)[0].trim() || line;
}

function extractTitle(lines: string[]): string {
  // Pasting a whole page puts nav chrome ("Drinks", "Tableware", cart links)
  // above the dish name, so the first line isn't reliably the title. The
  // servings line ("Serves 4-6", "4 portioner", "Nok til 3-4 pers.") sits just
  // below the title block, so anchor on it.
  const sIdx = lines.findIndex((l) => servingsFrom(l) != null);

  if (sIdx > 0) {
    const above = lines.slice(0, sIdx);
    // Recipe sites repeat the dish name near the top (breadcrumb, H1, share
    // widgets). If a line above the servings line recurs, it's the title; walk
    // upward so the repeat closest to the servings line wins.
    const counts = new Map<string, number>();
    for (const l of above) counts.set(l, (counts.get(l) ?? 0) + 1);
    for (let i = above.length - 1; i >= 0; i--) {
      if ((counts.get(above[i]) ?? 0) >= 2) return cleanTitle(above[i]);
    }
    // No repeat (e.g. anotherdayofeating): the line just above servings is it.
    return cleanTitle(above[above.length - 1]);
  }

  return cleanTitle(lines[0] ?? "Untitled recipe");
}

function extractSource(lines: string[]): string | null {
  // A line that is just a domain (e.g. "anotherdayofeating.dk").
  const domain = lines.find(
    (l) => BARE_DOMAIN.test(l) && /\.(dk|com|net|org|se|no)$/i.test(l),
  );
  return domain ?? null;
}

function extractServings(text: string): number {
  return servingsFrom(text) ?? 4; // default is editable in review
}

function extractIngredients(lines: string[]): ParsedIngredient[] {
  const methodIdx = lines.findIndex((l) => METHOD_START.test(l));
  const limit = methodIdx === -1 ? lines.length : methodIdx;

  // A whole-page capture can carry a nav/shop "Ingredients" link before the
  // recipe's own heading (e.g. Ottolenghi's mega-menu). The real list is the
  // last "Ingredients" before the method, so scan forward and keep the latest.
  let start = -1;
  for (let i = 0; i < limit; i++) {
    if (INGREDIENTS_START.test(lines[i])) start = i;
  }
  if (start === -1) return [];

  const raw: string[] = [];
  for (let i = start + 1; i < limit; i++) {
    if (BOILERPLATE_STOP.test(lines[i])) break; // page-footer chrome
    if (isSectionHeader(lines[i])) continue; // e.g. BLOMKÅL / ÆRTECREME
    raw.push(lines[i]);
  }
  return mergeSplitAmounts(raw).map(parseIngredientLine);
}

/**
 * A line that is *only* a quantity, optionally followed by a unit (possibly
 * duplicated, as some rendered pages emit "4 tbsp tbsp" / "55 g g"). Returns the
 * normalized "amount [unit]" string, or null if the line carries a real name.
 */
function amountOnly(line: string): string | null {
  const m = line.match(
    /^(\d+(?:[.,]\d+)?(?:\s*[–-]\s*\d+(?:[.,]\d+)?)?)((?:\s+[\p{L}.]+)*)$/u,
  );
  if (!m) return null;
  const tail = m[2].trim();
  if (tail === "") return m[1];
  const toks = tail.split(/\s+/).map((t) => t.toLowerCase().replace(/\.$/, ""));
  return toks.every((t) => UNITS.has(t)) ? `${m[1]} ${toks[0]}` : null;
}

/**
 * Some captures put an ingredient's amount and name on separate lines ("2" then
 * "small butternut squash"). Fold an amount-only line into the following name
 * line so it parses as one ingredient.
 */
function mergeSplitAmounts(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const amount = amountOnly(lines[i]);
    const next = lines[i + 1];
    if (
      amount &&
      next &&
      amountOnly(next) === null &&
      !/^\d/.test(next) &&
      !isSectionHeader(next)
    ) {
      out.push(`${amount} ${next}`);
      i++; // consumed the name line
    } else {
      out.push(lines[i]);
    }
  }
  return out;
}

// Common sub-section headers that aren't all-caps (Vegetarisk Hverdag uses
// title-case ones like "Sovs" / "Til servering"). Matched case-insensitively
// against the whole line. Kept to clearly-non-ingredient words to avoid eating
// a real single-word ingredient.
const NAMED_HEADERS = new Set([
  "til servering",
  "til pynt",
  "servering",
  "pynt",
  "topping",
  "sovs",
  "sauce",
  "dressing",
  "marinade",
  "to serve",
  "for serving",
  "garnish",
]);

/** All-caps lines, or a known named header, are sub-sections, not ingredients. */
function isSectionHeader(line: string): boolean {
  if (/[A-ZÆØÅ]/.test(line) && line === line.toUpperCase()) return true;
  return NAMED_HEADERS.has(line.toLowerCase().replace(/:$/, "").trim());
}

/** Parse a servings value like "3-4", "4 personer", "Serves 6", or "4" → int. */
export function parseServingsText(value: string): number {
  const s = servingsFrom(value);
  if (s != null) return s;
  // Fall back to a bare number/range (e.g. JSON-LD recipeYield of "3-4").
  const m = value.match(/(\d+)(?:\s*[–-]\s*(\d+))?/);
  if (!m) return 4;
  return Math.max(Number(m[1]), m[2] ? Number(m[2]) : Number(m[1]));
}

// Unicode fraction glyphs → decimal, so "½ dl" / "1½" parse to a real quantity.
const FRACTIONS: Record<string, number> = {
  "½": 0.5,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "¼": 0.25,
  "¾": 0.75,
  "⅕": 0.2,
  "⅖": 0.4,
  "⅗": 0.6,
  "⅘": 0.8,
  "⅙": 1 / 6,
  "⅛": 0.125,
  "⅜": 0.375,
  "⅝": 0.625,
  "⅞": 0.875,
};
const FRACTION_RE = /(\d+)?\s*([½⅓⅔¼¾⅕⅖⅗⅘⅙⅛⅜⅝⅞])/g;

/** "½ dl" → "0.5 dl", "1½ tsk" → "1.5 tsk". */
function normalizeFractions(line: string): string {
  return line.replace(FRACTION_RE, (_m, whole: string | undefined, frac: string) => {
    const val = (whole ? Number(whole) : 0) + FRACTIONS[frac];
    return String(Number(val.toFixed(3)));
  });
}

export function parseIngredientLine(rawLine: string): ParsedIngredient {
  const line = normalizeFractions(rawLine);
  // Optional leading amount, possibly a range ("6-8"), then the rest. The gap
  // after the number is optional so a unit stuck to it ("55g", "125ml") still
  // parses — the unit then falls out as the first token of `rest`.
  const m = line.match(
    /^(\d+(?:[.,]\d+)?)(?:\s*[–-]\s*(\d+(?:[.,]\d+)?))?\s*(.*)$/,
  );

  const rest = m ? m[3].trim() : "";
  if (!m || !rest) {
    // No leading number (or nothing after it): to-taste / vague. Clean the name.
    return { name: cleanName(line), quantity: null, unit: null };
  }

  const lo = Number(m[1].replace(",", "."));
  const hi = m[2] ? Number(m[2].replace(",", ".")) : lo;
  const quantity = Math.max(lo, hi); // round up to buy enough

  const firstTok = rest.split(/\s+/)[0].toLowerCase().replace(/[.,]$/, "");

  if (UNITS.has(firstTok)) {
    const name = rest.slice(rest.indexOf(" ") + 1).trim();
    return { name: cleanName(name), quantity, unit: firstTok };
  }

  // Number with no recognized unit ("1 stort blomkål", "20 lys miso").
  return { name: cleanName(rest), quantity, unit: null };
}

function cleanName(name: string): string {
  return name
    // "[object Object]" leaks from sites whose JSON-LD serializes a unit object
    // wrong (e.g. meyers.dk emits "150 [object Object] smør").
    .replace(/\[object Object\]/gi, " ")
    .replace(VAGUE_PREFIX, "") // drop "en håndfuld", "squish", …
    .replace(/\s*\([^)]*\)\s*$/, "") // drop a trailing "(valgfrit)" note
    .replace(/\s{2,}/g, " ")
    .trim();
}
