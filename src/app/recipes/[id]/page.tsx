import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDurationMinutes } from "@/lib/durations";
import { prisma } from "@/lib/prisma";
import { OMIT_RECIPE_BLOBS, recipeImageSrc } from "@/lib/recipeImage";
import { CookingMode } from "./CookingMode";
import { Method } from "./Method";

// Recipe cooking view (§2) — ingredients + method, rendered for use at the
// stove, with a link back to the original source if we have one.
export const dynamic = "force-dynamic";

function amount(q: number | null, u: string | null): string {
  if (q == null) return "";
  return u ? `${q} ${u}` : `${q}`;
}

function isHeader(line: string): boolean {
  return /[A-ZÆØÅ]/.test(line) && line === line.toUpperCase();
}

/** Group the instructions text into { header, steps[] } sections. */
function toSections(instructions: string): { header: string | null; steps: string[] }[] {
  const sections: { header: string | null; steps: string[] }[] = [];
  let current: { header: string | null; steps: string[] } | null = null;

  for (const raw of instructions.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (isHeader(line)) {
      current = { header: line, steps: [] };
      sections.push(current);
    } else {
      if (!current) {
        current = { header: null, steps: [] };
        sections.push(current);
      }
      current.steps.push(line);
    }
  }
  return sections;
}

function sourceHref(source: string): string {
  return /^https?:\/\//i.test(source) ? source : `https://${source}`;
}

export default async function RecipeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const recipe = await prisma.recipe.findUnique({
    where: { id },
    // The photo is fetched by the browser from its own endpoint; no need to
    // drag its bytes (or the captured page HTML) through the render.
    omit: OMIT_RECIPE_BLOBS,
    include: { ingredients: { orderBy: { position: "asc" } } },
  });
  if (!recipe) notFound();

  const sections = recipe.instructions ? toSections(recipe.instructions) : [];
  const photo = recipeImageSrc(recipe);

  return (
    <>
      <p style={{ display: "flex", justifyContent: "space-between" }}>
        <Link href="/recipes">← Recipes</Link>
        <Link href={`/recipes/${recipe.id}/edit`}>Edit</Link>
      </p>

      {photo && (
        // Plain <img>: the photo is served from our own API route, already
        // sized by whoever we got it from, and next/image would want a loader.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photo} alt="" className="recipe-hero" />
      )}

      <h1>
        {recipe.isFavorite ? "★ " : ""}
        {recipe.name}
      </h1>
      <p className="muted">
        Serves {recipe.statedServings}
        {recipe.totalTimeMinutes != null ? (
          <>
            {" · "}
            {/*
              An estimate wears its "about" in the copy, not just in a tooltip:
              a time we summed out of the step timers overstates the dish
              (steps overlap, resting counts), and the whole point of showing a
              time is that you can plan a Tuesday around it. A source-declared
              time is stated flat, because the recipe itself said so.
            */}
            <span
              title={
                recipe.totalTimeIsEstimate
                  ? "Our estimate, from adding up the times in the method — steps overlap, so it usually runs shorter. Correct it on the edit page."
                  : "As the source page states it."
              }
            >
              {recipe.totalTimeIsEstimate ? "about " : ""}
              {formatDurationMinutes(recipe.totalTimeMinutes)}
            </span>
          </>
        ) : null}
        {recipe.source ? (
          <>
            {" · "}
            <a href={sourceHref(recipe.source)} target="_blank" rel="noreferrer">
              View original ↗
            </a>
          </>
        ) : null}
      </p>

      <CookingMode />

      <div className="card">
        <h2>Ingredients</h2>
        <ul>
          {recipe.ingredients.map((i) => (
            <li key={i.id}>
              {amount(i.quantity, i.unit)} {i.name}
            </li>
          ))}
        </ul>
      </div>

      {sections.length === 0 ? (
        <div className="card">
          <h2>Method</h2>
          <p className="muted">
            No instructions saved.{" "}
            {recipe.source ? (
              <a href={sourceHref(recipe.source)} target="_blank" rel="noreferrer">
                Open the original ↗
              </a>
            ) : null}
          </p>
        </div>
      ) : (
        // Client-side from here down: the steps carry tappable timers (§2).
        <Method sections={sections} />
      )}
    </>
  );
}
