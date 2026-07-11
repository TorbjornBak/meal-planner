import {
  parseIngredientLine,
  parseRecipeText,
  parseServingsText,
  type ParsedIngredient,
  type ParsedRecipe,
} from "./parse";

/**
 * Recipe extraction from captured page HTML (§1, bookmarklet capture).
 *
 * Three strategies, best first:
 *   1. schema.org/Recipe JSON-LD — many recipe sites embed it; when present
 *      it's structured and reliable.
 *   2. schema.org/Recipe *microdata* (itemprop attributes) — sites like
 *      valdemarsro.dk use this instead of JSON-LD. Also structured and reliable.
 *   3. Fallback: strip the HTML to readable text and run the same deterministic
 *      text parser used for hand-pasted recipes.
 *
 * Still feeds the review-and-edit step — capture saves a recipe you then curate.
 */
export function parseRecipeHtml(html: string): ParsedRecipe {
  // A full page has nav/header/cart chrome before the article, so the text
  // parser's "first line is the title" heuristic is unreliable here. Take the
  // title from the document metadata instead.
  const htmlTitle = extractHtmlTitle(html);

  const fromJsonLd = extractJsonLdRecipe(html);
  if (fromJsonLd && fromJsonLd.ingredients.length > 0) {
    if (!isGoodName(fromJsonLd.name) && htmlTitle) fromJsonLd.name = htmlTitle;
    return fromJsonLd;
  }

  const fromMicrodata = extractMicrodataRecipe(html);
  if (fromMicrodata && fromMicrodata.ingredients.length > 0) {
    // The Recipe scope's own name is hard to isolate (a page has many
    // itemprop="name" nodes); the document title is cleaner.
    if (htmlTitle) fromMicrodata.name = htmlTitle;
    return fromMicrodata;
  }

  const fromInertia = extractInertiaRecipe(html);
  if (fromInertia && fromInertia.ingredients.length > 0) {
    if (!isGoodName(fromInertia.name) && htmlTitle) fromInertia.name = htmlTitle;
    return fromInertia;
  }

  const parsed = parseRecipeText(htmlToText(html));
  if (htmlTitle) parsed.name = htmlTitle;
  return parsed;
}

function isGoodName(name: string): boolean {
  const n = name.trim();
  return n.length >= 2 && !/^\d+$/.test(n) && n !== "Untitled recipe";
}

/** Best title from the page: og:title, then <title>, then first <h1>. */
export function extractHtmlTitle(html: string): string | null {
  const og =
    html.match(
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    ) ??
    html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
    );
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);

  for (const cand of [og?.[1], title?.[1], h1?.[1]]) {
    if (!cand) continue;
    let t = decodeEntities(stripTags(cand)).replace(/\s+/g, " ").trim();
    // Drop a trailing " — Site Name" / " | Site Name" suffix.
    t = t.split(/\s+[—–|]\s+/)[0].trim();
    // Drop a trailing " - opskrift" / " - recipe" tag (e.g. valdemarsro.dk).
    t = t.replace(/\s*[-–—]\s*(opskrift|recipe)\s*$/i, "").trim();
    if (isGoodName(t)) return t;
  }
  return null;
}

// --- JSON-LD ------------------------------------------------------------------

export function extractJsonLdRecipe(html: string): ParsedRecipe | null {
  const scripts = [
    ...html.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ];

  for (const s of scripts) {
    let data: unknown;
    try {
      data = JSON.parse(s[1].trim());
    } catch {
      continue;
    }
    const node = findRecipeNode(data);
    if (node) return mapRecipeNode(node);
  }
  return null;
}

function findRecipeNode(data: unknown): Record<string, unknown> | null {
  const nodes: unknown[] = Array.isArray(data) ? data : [data];
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const obj = n as Record<string, unknown>;
    if (Array.isArray(obj["@graph"])) {
      const inner = findRecipeNode(obj["@graph"]);
      if (inner) return inner;
    }
    const type = obj["@type"];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((t) => typeof t === "string" && /recipe/i.test(t))) {
      return obj;
    }
  }
  return null;
}

function mapRecipeNode(node: Record<string, unknown>): ParsedRecipe {
  const name = asString(node.name) ?? "Untitled recipe";

  const yieldVal = node.recipeYield ?? node.yield;
  const statedServings = yieldVal
    ? parseServingsText(asString(Array.isArray(yieldVal) ? yieldVal[0] : yieldVal) ?? "")
    : 4;

  const rawIngredients = toArray(node.recipeIngredient ?? node.ingredients);
  const ingredients = rawIngredients
    .map((x) => asString(x))
    .filter((x): x is string => !!x && x.trim().length > 0)
    .map((line) => parseIngredientLine(stripTags(line).trim()));

  return {
    name: stripTags(name).trim(),
    source: null, // set by the caller to the captured URL
    statedServings,
    ingredients,
    instructions: mapInstructions(node.recipeInstructions) || null,
  };
}

function mapInstructions(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return stripTags(value).trim();

  const parts: string[] = [];
  for (const step of toArray(value)) {
    if (typeof step === "string") {
      parts.push(stripTags(step).trim());
    } else if (step && typeof step === "object") {
      const obj = step as Record<string, unknown>;
      const type = asString(obj["@type"]) ?? "";
      if (/HowToSection/i.test(type)) {
        const header = asString(obj.name);
        if (header) parts.push(header.toUpperCase());
        parts.push(mapInstructions(obj.itemListElement));
      } else {
        const text = asString(obj.text) ?? asString(obj.name);
        if (text) parts.push(stripTags(text).trim());
      }
    }
  }
  return parts.filter(Boolean).join("\n");
}

// --- Microdata (schema.org/Recipe via itemprop) -------------------------------

/**
 * Some sites (e.g. valdemarsro.dk) mark recipes up with schema.org *microdata*
 * — itemprop attributes on ordinary elements — instead of JSON-LD. When a
 * Recipe scope is present, read the structured fields straight out of it; far
 * more reliable than scraping a full page's rendered text (which drags in the
 * method, notes and comment threads as if they were ingredients).
 */
export function extractMicrodataRecipe(html: string): ParsedRecipe | null {
  if (!/itemtype=["']https?:\/\/schema\.org\/Recipe["']/i.test(html)) return null;

  const ingredients = itemprops(html, "recipeIngredient")
    .map((raw) => decodeEntities(stripTags(raw)).replace(/\s+/g, " ").trim())
    .filter((x) => x.length > 0)
    .map((line) => parseIngredientLine(line));

  if (ingredients.length === 0) return null;

  const steps = itemprops(html, "recipeInstructions")
    .map((raw) => decodeEntities(stripTags(raw)).replace(/[ \t]+/g, " ").trim())
    .filter((x) => x.length > 0);

  const yieldRaw = itemprops(html, "recipeYield")[0];
  const statedServings = yieldRaw
    ? parseServingsText(decodeEntities(stripTags(yieldRaw)).trim())
    : 4;

  return {
    name: "Untitled recipe", // caller overrides with the page title
    source: null,
    statedServings,
    ingredients,
    instructions: steps.length ? steps.join("\n") : null,
  };
}

/**
 * Inner content (or a `content=""` attribute, meta-style) of every element
 * carrying itemprop="prop". Assumes non-nesting leaf elements, which is what
 * recipe microdata uses for these fields (flat <li>/<span>/<div>).
 */
function itemprops(html: string, prop: string): string[] {
  const out: string[] = [];
  const re = new RegExp(
    `<(\\w+)([^>]*\\bitemprop=["']${prop}["'][^>]*)>([\\s\\S]*?)<\\/\\1>`,
    "gi",
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const contentAttr = m[2].match(/\bcontent=["']([^"']*)["']/i);
    out.push(contentAttr && contentAttr[1].trim() ? contentAttr[1] : m[3]);
  }
  return out;
}

// --- Inertia.js data-page (bespoke recipe JSON) -------------------------------

/**
 * Some sites are Inertia.js single-page apps (e.g. spisbedre.dk) with no
 * schema.org markup — the recipe lives in an HTML-entity-encoded JSON blob on
 * `<div data-page="…">`. Read it straight from that blob, since the rendered
 * page carries no standard structured data. Guarded to the specific shape
 * (`props.recipe.grouped_ingredients`) so it never misfires on other Inertia
 * apps.
 */
export function extractInertiaRecipe(html: string): ParsedRecipe | null {
  const m = html.match(/data-page="([^"]*)"/i);
  if (!m) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any;
  try {
    data = JSON.parse(decodeEntities(m[1]));
  } catch {
    return null;
  }

  const recipe = data?.props?.recipe;
  const groups = recipe?.grouped_ingredients;
  if (!recipe || !Array.isArray(groups) || groups.length === 0) return null;

  const ingredients: ParsedIngredient[] = [];
  for (const g of groups) {
    for (const it of g?.ingredients ?? []) {
      const base = it?.ingredient?.name_singular ?? it?.ingredient?.name_plural;
      if (typeof base !== "string" || !base.trim()) continue;
      const name = [it?.prefix, base, it?.suffix]
        .filter((x) => typeof x === "string" && x.trim())
        .join(" ")
        .trim();
      const quantity = typeof it?.amount === "number" ? it.amount : null;
      const unitRaw = it?.unit?.abbreviation ?? it?.unit?.name_singular;
      const unit =
        typeof unitRaw === "string" && unitRaw.trim()
          ? unitRaw.trim().replace(/\.$/, "")
          : null;
      ingredients.push({ name, quantity, unit });
    }
  }
  if (ingredients.length === 0) return null;

  // Instructions: each group's steps, with its title as an upper-case header
  // (matches how the cooking view marks sections).
  const parts: string[] = [];
  for (const g of recipe?.grouped_instructions ?? []) {
    if (typeof g?.title === "string" && g.title.trim()) {
      parts.push(g.title.trim().toUpperCase());
    }
    for (const s of g?.instructions ?? []) {
      if (typeof s?.instruction === "string" && s.instruction.trim()) {
        parts.push(s.instruction.trim());
      }
    }
  }

  const statedServings =
    typeof recipe.serving_size === "number" && recipe.serving_size > 0
      ? recipe.serving_size
      : 4;
  const name =
    typeof recipe.title === "string" && recipe.title.trim()
      ? recipe.title.trim()
      : "Untitled recipe";

  return {
    name,
    source: null,
    statedServings,
    ingredients,
    instructions: parts.length ? parts.join("\n") : null,
  };
}

// --- HTML → text --------------------------------------------------------------

export function htmlToText(html: string): string {
  let s = html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    // Turn block boundaries into line breaks so markers/ingredients keep their
    // own lines for the text parser.
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|section|article|tr|table|header|footer)>/gi, "\n");

  s = stripTags(s);
  s = decodeEntities(s);

  return s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  aring: "å",
  aelig: "æ",
  oslash: "ø",
  Aring: "Å",
  AElig: "Æ",
  Oslash: "Ø",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n =
        code[1] === "x" || code[1] === "X"
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code] ?? m;
  });
}

// --- small helpers ------------------------------------------------------------

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
}
function toArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}
