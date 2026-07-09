import Link from "next/link";

// Dashboard — the core-loop landing page. A later pass wires in this week's
// plan summary, an outstanding-shopping count, and a spend snapshot.
export default function DashboardPage() {
  return (
    <>
      <h1>MealPlanner</h1>
      <p className="muted">
        Paste a dinner plan → review ingredients → generate a shopping list →
        tick it off → log what you paid → watch weekly spend.
      </p>

      <div className="card">
        <h2>Start here</h2>
        <ul>
          <li>
            <Link href="/recipes/new">Paste &amp; parse a recipe</Link> (§1)
          </li>
          <li>
            <Link href="/plan">Plan this week&rsquo;s dinners</Link> (§3)
          </li>
          <li>
            <Link href="/shopping">Shopping list</Link> (§5, §6)
          </li>
          <li>
            <Link href="/spending">Log a trip &amp; view spend</Link> (§7, §8)
          </li>
        </ul>
      </div>

      {/* TODO: this-week plan summary, unchecked-items count, spend snapshot. */}
    </>
  );
}
