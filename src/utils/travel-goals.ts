/**
 * travel-goals.ts
 *
 * Single source of truth for Travel Mode goal values.
 * Both TravelModal (display) and the Home dashboard (runtime goal selection)
 * import from here so the numbers can never drift apart.
 */

/** Travel Mode numeric goal constants */
export const TRAVEL_STEP_GOAL  = 6000;  // steps/day
export const TRAVEL_WATER_OZ   = 64;    // fluid oz/day
export const TRAVEL_SLEEP_HRS  = 8;     // hours/night

/**
 * Compute the effective goals to display on the Home dashboard.
 * Pure function — no side effects, no AsyncStorage access.
 *
 * When Travel Mode is ON:
 *   - Steps, water, and sleep goals use the relaxed Travel Mode values.
 *   - Calories goal is replaced with "Relaxed" (caloriesRelaxed = true).
 *
 * When Travel Mode is OFF:
 *   - All values pass through unchanged from the user's profile.
 *   - user_profile is never mutated.
 */
export function resolveTravelGoals(
  isTravelMode: boolean,
  profileStepGoal: number,
  profileWaterOz: number,
  profileSleepHrs: number,
): {
  stepGoal: number;
  waterGoal: number;
  sleepGoalHrs: number;
  caloriesRelaxed: boolean;
} {
  return {
    stepGoal:        isTravelMode ? TRAVEL_STEP_GOAL : profileStepGoal,
    waterGoal:       isTravelMode ? TRAVEL_WATER_OZ  : profileWaterOz,
    sleepGoalHrs:    isTravelMode ? TRAVEL_SLEEP_HRS : profileSleepHrs,
    caloriesRelaxed: isTravelMode,
  };
}
