/**
 * Recipe scaling (§4).
 *
 * Every recipe is written for `statedServings`. We scale it to the effective
 * serving count for its slot — the household size, or a per-dinner override for
 * guest nights / batch-cooking.
 *
 * Countable items (no unit, or a discrete unit like "clove") round UP to whole
 * units. Weight/volume (g, ml, kg, l, …) scale precisely.
 */

/** Units treated as continuous — scaled precisely, never rounded. */
const CONTINUOUS_UNITS = new Set([
  "g",
  "kg",
  "mg",
  "ml",
  "cl",
  "l",
  "oz",
  "lb",
  "cup",
  "cups",
  "tbsp",
  "tsp",
  "dl",
]);

export interface ScalableLine {
  quantity: number | null;
  unit: string | null;
}

export interface ScaledLine {
  quantity: number | null;
  unit: string | null;
}

export function isCountable(unit: string | null): boolean {
  if (!unit) return true; // bare count, e.g. "2 onions"
  return !CONTINUOUS_UNITS.has(unit.trim().toLowerCase());
}

/**
 * Scale one ingredient line from `statedServings` to `targetServings`.
 * Lines with no quantity ("to taste") pass through untouched.
 */
export function scaleLine(
  line: ScalableLine,
  statedServings: number,
  targetServings: number,
): ScaledLine {
  if (line.quantity == null || statedServings <= 0) {
    return { quantity: line.quantity, unit: line.unit };
  }

  const factor = targetServings / statedServings;
  const scaled = line.quantity * factor;

  return {
    quantity: isCountable(line.unit) ? Math.ceil(scaled) : round(scaled),
    unit: line.unit,
  };
}

/** The serving count a slot should scale to: override if set, else household. */
export function effectiveServings(
  householdSize: number,
  servingsOverride: number | null | undefined,
): number {
  return servingsOverride ?? householdSize;
}

function round(n: number): number {
  // Keep two decimals to avoid float noise on weight/volume.
  return Math.round(n * 100) / 100;
}
