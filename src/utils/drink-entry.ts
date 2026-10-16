/**
 * drink-entry.ts
 *
 * Pure helper for computing a drink log entry from a counts snapshot.
 * No React Native imports — safe to unit-test in Jest without native mocks.
 */

export type DrinkItem = {
  id: string;
  name: string;
  detail: string;
  calories: number;
  standardDrinks: number;
};

export type DrinkEntry = {
  date: string;
  totalDrinks: number;
  totalCalories: number;
  vibe: string | null;
  counts: Record<string, number>;
};

/**
 * Computes the drink log entry object for a given counts snapshot.
 * Returns null when no drinks have been logged (totalDrinks === 0).
 *
 * Pure function — no side effects.
 */
export function buildDrinkEntry(
  counts: Record<string, number>,
  allItems: DrinkItem[],
  vibe: string | null,
  dateStr: string,
): DrinkEntry | null {
  const total  = allItems.reduce((s, item) => s + (counts[item.id] ?? 0) * item.standardDrinks, 0);
  const cals   = allItems.reduce((s, item) => s + (counts[item.id] ?? 0) * item.calories, 0);
  const drinks = Math.round(total * 10) / 10;
  if (drinks === 0) return null;
  return { date: dateStr, totalDrinks: drinks, totalCalories: cals, vibe, counts };
}
