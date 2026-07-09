// In-store checklist (§5, §6). Aggregated actionable items with a separate
// "Pantry — check you have these" section. Tapping an item toggles its checked
// state, which persists and is shared across household phones.
//
// This scaffold shows the two-section layout; loading the current list and the
// optimistic toggle (PATCH /api/shopping/[itemId]) are wired up in a later pass.
export default function ShoppingPage() {
  return (
    <>
      <h1>Shopping list</h1>
      <p className="muted">
        Tap to tick items off as you grab them. State is shared, so two phones
        stay in sync.
      </p>

      <div className="card">
        <h2>To buy</h2>
        <p className="muted">— no list generated yet —</p>
        {/* TODO: actionable items, tap-to-check. */}
      </div>

      <div className="card">
        <h2>Pantry — check you have these</h2>
        <p className="muted">
          Matched against your pantry list and pulled out of the main list. Pull
          an item back if you&rsquo;ve run out.
        </p>
        {/* TODO: pantry-matched items, "move back to main list" control. */}
      </div>
    </>
  );
}
