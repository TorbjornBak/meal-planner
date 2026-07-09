import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";

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
    include: { ingredients: { orderBy: { position: "asc" } } },
  });
  if (!recipe) notFound();

  const sections = recipe.instructions ? toSections(recipe.instructions) : [];

  return (
    <>
      <p style={{ display: "flex", justifyContent: "space-between" }}>
        <Link href="/recipes">← Recipes</Link>
        <Link href={`/recipes/${recipe.id}/edit`}>Edit</Link>
      </p>

      <h1>
        {recipe.isFavorite ? "★ " : ""}
        {recipe.name}
      </h1>
      <p className="muted">
        Serves {recipe.statedServings}
        {recipe.source ? (
          <>
            {" · "}
            <a href={sourceHref(recipe.source)} target="_blank" rel="noreferrer">
              View original ↗
            </a>
          </>
        ) : null}
      </p>

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

      <div className="card">
        <h2>Method</h2>
        {sections.length === 0 ? (
          <p className="muted">
            No instructions saved.{" "}
            {recipe.source ? (
              <a href={sourceHref(recipe.source)} target="_blank" rel="noreferrer">
                Open the original ↗
              </a>
            ) : null}
          </p>
        ) : (
          sections.map((sec, i) => (
            <div key={i} style={{ marginBottom: 12 }}>
              {sec.header && <h3 style={{ marginBottom: 4 }}>{sec.header}</h3>}
              <ol style={{ marginTop: 4 }}>
                {sec.steps.map((step, j) => (
                  <li key={j} style={{ marginBottom: 4 }}>
                    {step}
                  </li>
                ))}
              </ol>
            </div>
          ))
        )}
      </div>
    </>
  );
}
