import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { weeklyBuckets } from "@/lib/spending";
import { WeeklySpendChart } from "@/components/WeeklySpendChart";

// Reads live data behind the shared-session gate — never statically rendered.
export const dynamic = "force-dynamic";

function money(n: number): string {
  return `${Math.round(n)} kr`;
}

export default async function DashboardPage() {
  const [recipeCount, trips] = await Promise.all([
    prisma.recipe.count(),
    prisma.shoppingTrip.findMany({ orderBy: { date: "asc" } }),
  ]);

  const rows = trips.map((t) => ({ date: t.date, total: Number(t.total) }));
  const buckets = weeklyBuckets(rows, 12);

  const now = new Date();
  const monthTotal = rows
    .filter(
      (t) =>
        t.date.getFullYear() === now.getFullYear() &&
        t.date.getMonth() === now.getMonth(),
    )
    .reduce((a, t) => a + t.total, 0);

  return (
    <>
      <h1>Dashboard</h1>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
        <div className="card" style={{ flex: 1, minWidth: 160, marginBottom: 0 }}>
          <div className="muted">Recipes</div>
          <strong style={{ fontSize: "2em" }}>{recipeCount}</strong>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 160, marginBottom: 0 }}>
          <div className="muted">Spent this month</div>
          <strong style={{ fontSize: "2em" }}>{money(monthTotal)}</strong>
        </div>
      </div>

      <div className="card">
        <h2>Weekly spend</h2>
        {trips.length === 0 ? (
          <p className="muted">
            No trips logged yet — <Link href="/spending">log one</Link>.
          </p>
        ) : (
          <WeeklySpendChart data={buckets} />
        )}
      </div>

      <div className="card">
        <h2>Quick links</h2>
        <ul>
          <li>
            <Link href="/recipes/new">Paste or capture a recipe</Link> (§1)
          </li>
          <li>
            <Link href="/recipes">Find recipes by ingredient</Link> (§2)
          </li>
          <li>
            <Link href="/plan">Plan this week&rsquo;s dinners</Link> (§3)
          </li>
          <li>
            <Link href="/shopping">Shopping list</Link> (§5, §6)
          </li>
        </ul>
      </div>
    </>
  );
}
