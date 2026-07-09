import Link from "next/link";
import { prisma } from "@/lib/prisma";

// Reads live data behind the shared-session gate — never statically rendered.
export const dynamic = "force-dynamic";

// Recipe library (§2) — browse, search, favorite, rename, delete, reuse.
// This scaffold lists saved recipes; search/tag filters and actions are TODO.
export default async function RecipesPage() {
  const recipes = await prisma.recipe.findMany({
    orderBy: [{ isFavorite: "desc" }, { name: "asc" }],
    include: { _count: { select: { ingredients: true } } },
  });

  return (
    <>
      <h1>Recipes</h1>
      <p>
        <Link href="/recipes/new">+ Paste a new recipe</Link>
      </p>

      {recipes.length === 0 ? (
        <p className="muted">Nothing saved yet.</p>
      ) : (
        recipes.map((r) => (
          <div className="card" key={r.id}>
            <strong>
              {r.isFavorite ? "★ " : ""}
              {r.name}
            </strong>
            <div className="muted">
              {r._count.ingredients} ingredients · serves {r.statedServings}
              {r.source ? ` · ${r.source}` : ""}
            </div>
          </div>
        ))
      )}

      {/* TODO: search box, tag filter, favorite/rename/delete controls. */}
    </>
  );
}
