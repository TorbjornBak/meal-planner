// Which Monday a date belongs to (§3). Weeks are the unit the plan is keyed by —
// `WeekPlan.weekStart` is a unique date column holding a Monday — so every route
// that takes a date has to snap it the same way, or two spellings of the same
// week become two rows.
//
// This sits beside the routes rather than in src/lib because it is plan-week
// arithmetic and nothing else uses it. Next only routes `route.ts`, so a plain
// module can live in the same folder without becoming an endpoint.

/** Monday (UTC, date-only) of the week containing `d`. */
export function mondayOf(d: Date): Date {
  const day = d.getUTCDay(); // 0 = Sun
  const diff = (day + 6) % 7; // days since Monday
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff),
  );
}
