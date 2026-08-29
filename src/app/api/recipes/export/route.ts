import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  buildTransferFile,
  transferFilename,
  type RecipeRowForTransfer,
} from "@/lib/recipeTransfer";

/**
 * GET /api/recipes/export — the whole library as one JSON file (§2, §12).
 *
 * Three problems share this one answer. A fresh instance opens on an empty
 * library and has nothing to do until somebody pastes a recipe, which is the
 * cold start that makes a new install feel dead. Recipes can't move between
 * households at all, though a household that likes yours is the likeliest
 * source of a good one. And the Borg backups (§11) are a restore-everything
 * mechanism — correct, but not something a person can read, or pick three
 * recipes out of.
 *
 * A file rather than a service, for the same reason parsing and OCR are
 * in-process (§12): there's nothing to sign up for and no key to leak, and the
 * thing you end up holding is a file you can read, e-mail, and keep.
 *
 * Access is the session cookie, via the middleware — `/api/recipes/export`
 * isn't in `isPublic()`, so an unauthenticated request never reaches this
 * handler. That matters more here than on most routes: this one hands over the
 * entire library in a single response.
 */
export async function GET() {
  // Selected field by field rather than omitting blobs, so the photo columns
  // can't arrive by accident. `toTransferRecipe` drops them anyway, but a
  // query that never loads megabytes of image bytes is the cheaper mistake to
  // not make.
  const rows: RecipeRowForTransfer[] = await prisma.recipe.findMany({
    // By name, not by creation date: the natural thing to do with an export is
    // take another one next month and compare, and a stable order makes that a
    // readable diff instead of a reshuffle.
    orderBy: { name: "asc" },
    select: {
      name: true,
      source: true,
      statedServings: true,
      instructions: true,
      tags: true,
      totalTimeMinutes: true,
      totalTimeIsEstimate: true,
      ingredients: {
        orderBy: { position: "asc" },
        select: { name: true, quantity: true, unit: true, position: true },
      },
    },
  });

  const exportedAt = new Date();
  const file = buildTransferFile(rows, exportedAt);

  // Indented on purpose. The file is meant to be opened, read and hand-edited
  // — that's most of why it's JSON and not a database dump — and the bytes
  // saved by minifying are worth less than being able to see what you have.
  return new NextResponse(JSON.stringify(file, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${transferFilename(exportedAt)}"`,
      // A library people are actively editing; a cached copy would quietly
      // hand back yesterday's recipes.
      "cache-control": "no-store",
    },
  });
}
