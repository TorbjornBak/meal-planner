import { prisma } from "@/lib/prisma";

// Reads live data behind the shared-session gate — never statically rendered.
export const dynamic = "force-dynamic";

// Settings (§4, §9) — household size (scales every recipe) and the pantry list
// (§5). The shared password lives in the environment, not here.
export default async function SettingsPage() {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  const pantry = await prisma.pantryItem.findMany({ orderBy: { name: "asc" } });

  return (
    <>
      <h1>Settings</h1>

      <div className="card">
        <h2>Household size</h2>
        <p>
          Currently <strong>{settings?.householdSize ?? 2}</strong>. Every recipe
          scales from its stated servings to this.
        </p>
        {/* TODO: editable field → PATCH /api/settings. */}
      </div>

      <div className="card">
        <h2>Pantry — things we always have</h2>
        <p className="muted">
          Items matching these names get pulled out of the main shopping list
          into their own section.
        </p>
        {pantry.length === 0 ? (
          <p className="muted">No pantry items yet.</p>
        ) : (
          <ul>
            {pantry.map((p) => (
              <li key={p.id}>{p.name}</li>
            ))}
          </ul>
        )}
        {/* TODO: add/remove pantry items → POST/DELETE /api/pantry. */}
      </div>
    </>
  );
}
