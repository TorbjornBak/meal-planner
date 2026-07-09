// Weekly dinner plan (§3, §4) — 7 dinner slots, nights may be empty, per-slot
// servings override. This scaffold renders the empty week grid; assigning
// recipes to slots and generating the list are wired up in a later pass.
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function PlanPage() {
  return (
    <>
      <h1>This week&rsquo;s dinners</h1>
      <p className="muted">
        Assign a recipe to any night. Leave nights empty for leftovers or eating
        out. Override servings per night for guests or batch-cooking.
      </p>

      {DAYS.map((day) => (
        <div className="card" key={day}>
          <strong>{day}</strong>
          <div className="muted">— empty —</div>
          {/* TODO: recipe picker (from library), per-slot servings override. */}
        </div>
      ))}

      {/* TODO: "Generate shopping list" action → POST /api/shopping. */}
    </>
  );
}
