/**
 * chat-prompt.ts
 *
 * Pure helpers for building the Chat system-prompt health data section.
 * No React Native imports — safe to unit-test in Jest without native mocks.
 */

export type HealthSnapshot = {
  sleep:   { hours: number; score: number; hrv: number; readiness: number };
  steps:   { count: number; goal: number };
  macros:  { calories: number; protein: number; carbs: number; fat: number; calGoal: number };
  workout: { type: string; duration: number; calories: number; done: boolean };
  water:   { oz: number; goalOz: number };
  hadAlcoholLastNight: boolean;
};

/**
 * Build the TODAY'S DATA section of the Chat system prompt.
 * Only include fields that have real measured values.
 * Zero is not a valid reading for sleep, HRV, readiness, macros, or water —
 * in those cases the data simply hasn't loaded or hasn't been logged yet.
 * Omitting them prevents Claude from acting on false zeros.
 *
 * Exceptions that ARE valid at zero/false:
 *   - steps.count: 0 steps early in the day is a real measurement
 *   - workout.done: false = "no workout logged today" (meaningful)
 *   - hadAlcoholLastNight: false = "no alcohol" (meaningful)
 */
export function buildTodaySection(health: HealthSnapshot): string {
  const lines: string[] = [];

  // Sleep: only include sub-fields with real values (> 0)
  const sleepParts: string[] = [];
  if (health.sleep.hours    > 0) sleepParts.push(`${health.sleep.hours} hrs`);
  if (health.sleep.score    > 0) sleepParts.push(`Score: ${health.sleep.score}/100`);
  if (health.sleep.readiness > 0) sleepParts.push(`Readiness: ${health.sleep.readiness}/100`);
  if (health.sleep.hrv      > 0) sleepParts.push(`HRV: ${health.sleep.hrv} ms`);
  lines.push(sleepParts.length > 0
    ? `- Sleep: ${sleepParts.join(' | ')}`
    : '- Sleep: not yet synced for today');

  // Steps: 0 is a valid early-day measurement
  lines.push(`- Steps: ${health.steps.count.toLocaleString()} / ${health.steps.goal.toLocaleString()} goal`);

  // Water: omit if not yet logged (0 oz is not a meaningful daily reading)
  if (health.water.oz > 0) {
    lines.push(`- Hydration: ${health.water.oz} oz / ${health.water.goalOz} oz goal`);
  }

  // Nutrition: omit if nothing has been logged today
  if (health.macros.calories > 0) {
    lines.push(`- Nutrition logged: ${health.macros.calories} kcal | Protein: ${health.macros.protein}g | Carbs: ${health.macros.carbs}g | Fat: ${health.macros.fat}g`);
  }

  // Workout: done=false is valid ("no workout logged today")
  lines.push(`- Workout today: ${health.workout.done
    ? `${health.workout.type}, ${health.workout.duration} min, ${health.workout.calories} kcal burned`
    : 'none logged'}`);

  // Alcohol: false is valid ("no alcohol last night")
  lines.push(`- Alcohol last night: ${health.hadAlcoholLastNight ? 'yes' : 'no'}`);

  return lines.join('\n');
}
