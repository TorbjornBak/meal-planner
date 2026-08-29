import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  parseTransferFile,
  planImport,
  toRecipeCreateData,
  transferKey,
} from "@/lib/recipeTransfer";

/**
 * POST /api/recipes/import — read a library export back in (§1, §2, §12).
 *
 * The counterpart to `/api/recipes/export`, and the half that makes it worth
 * having: a file you can produce but not consume is a backup, not a way to
 * hand somebody your recipes.
 *
 * **Why this doesn't go through the mandatory review step (§1).** That rule
 * exists because a *parse* is a guess — a bad one silently becomes a wrong
 * shopping list, so a human eyeballs every imported ingredient line before it
 * counts. An export is not a guess. Its lines are the structured rows some
 * other household already reviewed at their own paste-and-parse step, carried
 * across without reinterpretation. Making somebody re-approve two hundred
 * recipes one at a time would cost the review step its meaning everywhere
 * else: a confirmation you always click through stops being a check.
 *
 * The safeguards that replace it are the ones that fit bulk data — the file is
 * validated field by field before anything is written, duplicates are skipped
 * rather than merged, the whole import is one transaction, and every recipe
 * stays editable afterwards.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      {
        error:
          "That file isn't valid JSON, so nothing in it could be read. If you edited it by hand, a missing comma or bracket is the usual cause.",
      },
      { status: 400 },
    );
  }

  // Shape, envelope and version are all `parseTransferFile`'s business, and it
  // returns a sentence rather than an error code — whoever is standing here
  // has a file they believe is a library and needs to know which part of it
  // this instance couldn't read.
  const parsed = parseTransferFile(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.message }, { status: 400 });
  }

  // The library as it stands, as duplicate keys. Two narrow columns for the
  // whole library — cheaper than asking the database once per recipe in the
  // file, and the comparison has to happen somewhere.
  const existing = await prisma.recipe.findMany({
    select: { name: true, source: true },
  });
  const existingKeys = existing.map((r) => transferKey(r.name, r.source));

  const { toCreate, skipped } = planImport(parsed.file.recipes, existingKeys);

  // All-or-nothing. A partial import is the one outcome nobody can act on:
  // you'd be left guessing which recipes landed, and re-running the file to
  // find out is exactly what the duplicate check can't fully protect you from
  // if the first attempt half-succeeded.
  if (toCreate.length) {
    await prisma.$transaction(
      toCreate.map((recipe) =>
        prisma.recipe.create({ data: toRecipeCreateData(recipe) }),
      ),
    );
  }

  return NextResponse.json({
    imported: toCreate.length,
    skipped: skipped.length,
    // Named, not just counted. "12 skipped" invites the question this answers,
    // and the answer is short enough to give unprompted. Capped because the
    // whole point of a cap is the pathological file, not the ordinary one.
    skippedNames: skipped.slice(0, 20).map((r) => r.name),
  });
}
