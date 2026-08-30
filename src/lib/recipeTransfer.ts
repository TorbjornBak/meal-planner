import { z } from "zod";

// Imported relatively, with its extension, so the round-trip test can run this
// module straight through Node — the `@/` alias only exists inside the bundler.
import { DEFAULT_RECIPE_KIND, RECIPE_KINDS, type RecipeKind } from "./recipeKind.ts";

/**
 * The recipe-library transfer file (§2, §11) — one shape, seen from both sides.
 *
 * Three separate problems share this one answer:
 *   - a brand-new instance opens on an empty library with nothing to do, and
 *     someone else's file is the fastest way to make it feel alive;
 *   - a recipe can't currently leave the household it was typed into;
 *   - the Borg backups (§11) are a Postgres dump — excellent for restoring the
 *     whole box after a disk dies, useless for "send me your lasagne" or for
 *     pulling four recipes back out of last March.
 *
 * A plain JSON file on disk is the whole mechanism. No sync service, no account
 * anywhere else, nothing to sign up for (§12) — you download a file, you hand it
 * over however you already hand files over, the other household uploads it.
 *
 * Everything here is pure: the export route reads rows and calls
 * `toTransferRecipe`, the import route calls `parseTransferFile` and
 * `toRecipeCreateData`. Keeping the two directions in one module is the point —
 * they are the same contract, and `recipeTransfer.test.mjs` round-trips them
 * against each other to prove they still agree.
 */

/**
 * Marks the file as ours. Without it, any stray .json a browser hands us would
 * fail deep inside the recipe schema with a message about missing names; with it
 * we can say "this isn't a recipe export" and point at the button that makes one.
 */
export const TRANSFER_FORMAT = "mealplanner.recipes";

/**
 * Bumped only when the shape changes in a way an older reader would get wrong.
 * Additive fields don't need it: unknown keys are stripped on read (see
 * `TransferFileSchema`), so a v1 reader survives a v2 file that merely gained a
 * field.
 */
export const TRANSFER_VERSION = 1;

/** One ingredient line. Order in the array *is* `position` — see below. */
export interface TransferIngredient {
  name: string;
  /** Null for "to taste" / uncountable lines, exactly as stored (§1). */
  quantity: number | null;
  /** Null for bare counts ("2 onions"). */
  unit: string | null;
}

export interface TransferRecipe {
  name: string;
  /**
   * Dinner or drink (§2c). Absent in files written before drinks existed, and
   * read as DINNER — which is what every recipe in such a file is.
   */
  kind: RecipeKind;
  source: string | null;
  statedServings: number;
  instructions: string | null;
  tags: string[];
  /** Roughly how long the dish takes; null when nobody has ever said. */
  totalTimeMinutes: number | null;
  /**
   * Whether that number is our arithmetic rather than the recipe's claim. It has
   * to travel with the number: drop it and a summed-from-the-step-timers guess
   * arrives in the new library looking like a stated fact, and the receiving UI
   * prints "40 min" flat where it should print "about 40 min".
   */
  totalTimeIsEstimate: boolean;
}

export interface TransferRecipeWithLines extends TransferRecipe {
  ingredients: TransferIngredient[];
}

/** The envelope. Deliberately small — enough for a future reader to orient. */
export interface RecipeTransferFile {
  format: typeof TRANSFER_FORMAT;
  version: number;
  /** ISO timestamp, so a folder of exports sorts and dates itself. */
  exportedAt: string;
  recipes: TransferRecipeWithLines[];
}

/** What a recipe row looks like coming out of Prisma, for the export side. */
export interface RecipeRowForTransfer {
  name: string;
  kind: RecipeKind;
  source: string | null;
  statedServings: number;
  instructions: string | null;
  tags: string[];
  totalTimeMinutes: number | null;
  totalTimeIsEstimate: boolean;
  ingredients: {
    name: string;
    quantity: number | null;
    unit: string | null;
    position: number;
  }[];
}

// -----------------------------------------------------------------------------
// Export side
// -----------------------------------------------------------------------------

/**
 * A database row as it goes into the file.
 *
 * Photos are deliberately absent. `Recipe.image` is raw bytes (§2b) and the only
 * way to put bytes in JSON is base64, which would turn a 20 KB text file you can
 * open in any editor into tens of megabytes of unreadable padding — for the one
 * part of a recipe you can replace in seconds from the edit page. `imageUrl` goes
 * with it: a hotlink that already dies the day the source site reorganises (§2b)
 * is worth even less in someone else's library. The Settings page says so out
 * loud, because finding it out after a restore is the bad way to learn it.
 *
 * `position` is dropped too, because the array already carries it. That keeps the
 * file editable by hand: reordering two lines in a text editor does what it looks
 * like it does, and there's no numbering left to get out of step.
 */
export function toTransferRecipe(row: RecipeRowForTransfer): TransferRecipeWithLines {
  return {
    name: row.name,
    kind: row.kind ?? DEFAULT_RECIPE_KIND,
    source: row.source ?? null,
    statedServings: row.statedServings,
    instructions: row.instructions ?? null,
    tags: [...(row.tags ?? [])],
    totalTimeMinutes: row.totalTimeMinutes ?? null,
    totalTimeIsEstimate: row.totalTimeIsEstimate ?? false,
    // Sorted here rather than trusted from the caller: ingredient order is the
    // order you cook in, and it would be a shame to lose it to a query somebody
    // later edits without noticing the `orderBy`.
    ingredients: [...row.ingredients]
      .sort((a, b) => a.position - b.position)
      .map((line) => ({
        name: line.name,
        quantity: line.quantity ?? null,
        unit: line.unit ?? null,
      })),
  };
}

export function buildTransferFile(
  rows: RecipeRowForTransfer[],
  exportedAt: Date = new Date(),
): RecipeTransferFile {
  return {
    format: TRANSFER_FORMAT,
    version: TRANSFER_VERSION,
    exportedAt: exportedAt.toISOString(),
    recipes: rows.map(toTransferRecipe),
  };
}

/**
 * The name the browser saves it under. Dated, because the natural thing to do
 * with an export is to take another one next month, and two files called
 * `recipes.json` in a Downloads folder tell you nothing.
 */
export function transferFilename(exportedAt: Date = new Date()): string {
  const day = exportedAt.toISOString().slice(0, 10);
  return `mealplanner-recipes-${day}.json`;
}

// -----------------------------------------------------------------------------
// Import side
// -----------------------------------------------------------------------------

// Bounds exist so a hostile or simply broken file can't turn into an enormous
// transaction, not because any real recipe approaches them.
const MAX_RECIPES = 5000;
const MAX_INGREDIENTS = 500;
const MAX_MINUTES = 60 * 24 * 7;

const TransferIngredientSchema = z.object({
  name: z.string().min(1).max(300),
  // `.nullable().default(null)` so an absent key and an explicit null mean the
  // same thing — a hand-written file shouldn't have to spell out
  // `"quantity": null` on every "salt, to taste" line.
  quantity: z.number().finite().nullable().default(null),
  unit: z.string().max(60).nullable().default(null),
});

const TransferRecipeSchema = z.object({
  name: z.string().min(1).max(300),
  // Defaulted rather than required, because a file older than drinks is a
  // perfectly good file — and a hand-written one shouldn't have to say
  // `"kind": "DINNER"` on every entry to be read.
  kind: z.enum(RECIPE_KINDS).default(DEFAULT_RECIPE_KIND),
  source: z.string().max(2000).nullable().default(null),
  statedServings: z.number().int().positive().max(1000),
  instructions: z.string().nullable().default(null),
  tags: z.array(z.string().min(1).max(60)).max(50).default([]),
  totalTimeMinutes: z.number().int().positive().max(MAX_MINUTES).nullable().default(null),
  totalTimeIsEstimate: z.boolean().default(false),
  ingredients: z.array(TransferIngredientSchema).max(MAX_INGREDIENTS),
});

/**
 * Unknown keys are stripped rather than rejected (zod's default). That's what
 * lets a file written by a later version — one that learned to carry, say, a
 * nutrition block — still import everything this version understands, instead of
 * bouncing wholesale over a field it doesn't need.
 */
const TransferFileSchema = z.object({
  format: z.literal(TRANSFER_FORMAT),
  version: z.number().int().positive(),
  exportedAt: z.string().optional(),
  recipes: z.array(TransferRecipeSchema).max(MAX_RECIPES),
});

export type ParseResult =
  | { ok: true; file: RecipeTransferFile }
  | { ok: false; message: string };

/**
 * Read an uploaded file's parsed JSON into the transfer shape, or explain what is
 * wrong with it.
 *
 * The message matters as much as the rejection. Whoever is standing here has a
 * file they believe is a recipe library and an app saying no; "invalid input"
 * leaves them nowhere. So the envelope is checked first and named specifically,
 * and a per-recipe failure quotes the offending recipe by name — a 200-recipe
 * file with one bad line should tell you which line.
 */
export function parseTransferFile(input: unknown): ParseResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      message:
        "That file doesn't contain a JSON object, so there's no recipe export in it. Export one from Settings to see the shape.",
    };
  }

  const envelope = input as Record<string, unknown>;

  if (envelope.format !== TRANSFER_FORMAT) {
    return {
      ok: false,
      message:
        "That file isn't a MealPlanner recipe export. A real one starts with " +
        `"format": "${TRANSFER_FORMAT}" — take an export from Settings to see it.`,
    };
  }

  // A version from the future carries fields we may not know how to read. Name
  // both numbers, so the fix ("update this instance") is the obvious one.
  if (typeof envelope.version === "number" && envelope.version > TRANSFER_VERSION) {
    return {
      ok: false,
      message: `That file is version ${envelope.version}; this instance reads version ${TRANSFER_VERSION}. Update MealPlanner here, or re-export from an instance running this version.`,
    };
  }

  const parsed = TransferFileSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: describeIssue(parsed.error, envelope) };
  }

  return {
    ok: true,
    file: {
      format: TRANSFER_FORMAT,
      version: parsed.data.version,
      // A file that lost its timestamp still imports; the field is provenance,
      // not data anyone's recipes depend on.
      exportedAt: parsed.data.exportedAt ?? new Date().toISOString(),
      recipes: parsed.data.recipes,
    },
  };
}

/**
 * Field-by-field English for zod's issue list. Only the first issue is reported:
 * a file with one typo produces one problem to fix, and a file that is wholly the
 * wrong shape produces a wall of them that helps nobody.
 */
function describeIssue(error: z.ZodError, envelope: Record<string, unknown>): string {
  const issue = error.issues[0];
  const path = issue.path;

  if (path[0] === "recipes" && typeof path[1] === "number") {
    const index = path[1];
    const list = envelope.recipes;
    const raw = Array.isArray(list) ? list[index] : undefined;
    const named =
      raw && typeof raw === "object" && typeof (raw as { name?: unknown }).name === "string"
        ? `"${(raw as { name: string }).name}"`
        : `number ${index + 1}`;
    const field = path.slice(2).join(".");
    const where = field ? `its ${field} ` : "";
    return `Recipe ${named} can't be read: ${where}${issue.message.toLowerCase()}. Fix that entry and upload the file again.`;
  }

  const field = path.join(".") || "contents";
  return `The file's ${field} can't be read: ${issue.message.toLowerCase()}.`;
}

// -----------------------------------------------------------------------------
// Identity — what counts as "already in the library"
// -----------------------------------------------------------------------------

/**
 * The duplicate key: name plus source, both normalised for case and stray
 * whitespace.
 *
 * Importing the same file twice is a thing people do — they lose track of which
 * copy they sent, or they re-import after adding three recipes to it — and a
 * library that silently doubles is worse than one that refuses. Name alone would
 * be too aggressive: two households legitimately keep a different "Lasagne".
 * Name plus source is the pair that means "this same recipe, again".
 *
 * Contents deliberately don't enter into it. A recipe whose ingredients you
 * corrected after the first import is still the same recipe, and hashing the
 * lines would hand you a second copy of it every time you fixed a typo.
 */
export function transferKey(name: string, source: string | null | undefined): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  return `${norm(name)}|${source ? norm(source) : ""}`;
}

/** Prisma `create` data for one imported recipe. Pure — no client involved. */
export function toRecipeCreateData(recipe: TransferRecipeWithLines) {
  return {
    name: recipe.name.trim(),
    kind: recipe.kind,
    source: recipe.source,
    instructions: recipe.instructions,
    statedServings: recipe.statedServings,
    tags: recipe.tags,
    totalTimeMinutes: recipe.totalTimeMinutes,
    totalTimeIsEstimate: recipe.totalTimeIsEstimate,
    ingredients: {
      // Array order becomes `position` again, closing the loop that
      // `toTransferRecipe` opened when it dropped the numbering.
      create: recipe.ingredients.map((line, i) => ({
        name: line.name,
        quantity: line.quantity,
        unit: line.unit,
        position: i,
      })),
    },
  };
}

/**
 * Split a parsed file into what to create and what to leave alone.
 *
 * `existingKeys` is the library as it stands. Duplicates *within* the file are
 * skipped too — the key is added as we go — because a hand-merged file made from
 * two exports is exactly the sort of thing that carries the same recipe twice.
 */
export function planImport(
  recipes: TransferRecipeWithLines[],
  existingKeys: Iterable<string>,
): { toCreate: TransferRecipeWithLines[]; skipped: TransferRecipeWithLines[] } {
  const seen = new Set(existingKeys);
  const toCreate: TransferRecipeWithLines[] = [];
  const skipped: TransferRecipeWithLines[] = [];

  for (const recipe of recipes) {
    const key = transferKey(recipe.name, recipe.source);
    if (seen.has(key)) {
      skipped.push(recipe);
      continue;
    }
    seen.add(key);
    toCreate.push(recipe);
  }

  return { toCreate, skipped };
}
