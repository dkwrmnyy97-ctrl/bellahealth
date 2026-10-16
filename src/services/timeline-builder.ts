/**
 * timeline-builder.ts
 *
 * Assembles HealthDayRecord[] from multiple source adapters.
 * This is the single point where all device/service data converges
 * into the canonical timeline consumed by the Context Engine.
 *
 * Callers are responsible for fetching data from their respective sources.
 * This file performs only normalization and merging — no I/O.
 *
 * For in-app usage:
 *   buildTimelineFromAdapters(input) with data pre-fetched by the calling screen.
 *
 * For dev validation:
 *   buildTimelineFromAdapters(input) with any subset of data (absent sources
 *   simply contribute no records — graceful degradation).
 *
 * Sleep date semantics:
 *   All adapters MUST use the wakeup date as the record date — never the sleep-start date.
 *   Oura: daily_sleep.day = wakeup date (correct out of the box).
 *   HealthKit: getHistoricalSleepHours() groups by wakeup date (see healthkit.ts).
 *   This matches the Oura convention for readiness and HRV (all three share the wakeup date).
 *
 * Source deduplication:
 *   See canonical-signals.ts for priority rules.
 *   Key: hkSteps and ouraSteps are BOTH preserved; `steps` signal = hkSteps ?? ouraSteps.
 */

import type { OuraWeeklyDay } from './oura';
import type { WorkoutSample } from './healthkit';
import type { HealthDayRecord } from './pattern-engine';
import {
  buildDayRecords,
  type DayContribution,
} from './canonical-signals';
import {
  adaptOuraWeekly,
  adaptHKWorkouts,
  adaptHKSleepByDate,
  adaptHKStepsToday,
  adaptHKHrvToday,
  adaptStorageLogs,
  adaptNutritionHistory,
} from './source-adapters';

// ─── Input shape ───────────────────────────────────────────────────────────────

export interface TimelineInput {
  /**
   * Oura API historical data (optional — user may not have Oura).
   * Provide the output of fetchOuraWeekly().
   */
  ouraWeeklyDays?: OuraWeeklyDay[];

  /**
   * HealthKit workout history (optional).
   * Provide the output of getRecentWorkouts(windowDays).
   * Workouts are grouped by startDate and summed per day.
   */
  hkWorkouts?: WorkoutSample[];

  /**
   * HealthKit historical sleep hours keyed by wakeup date (optional).
   * Provide the output of getHistoricalSleepHours().
   * Only used to fill sleepHours when Oura is not available for a date.
   */
  hkSleepByDate?: Record<string, number>;

  /**
   * HealthKit today's step count (optional).
   * Writes to hkSteps; Oura ouraSteps is preserved alongside it.
   */
  hkStepsToday?: { steps: number; date: string };

  /**
   * HealthKit today's HRV (optional — Apple Watch users without Oura).
   * Point-in-time sample only; Oura HRV overwrites this on days where both exist.
   */
  hkHrvToday?: { hrv: number; date: string };

  /**
   * Lifestyle logs from AsyncStorage (optional).
   * Provide the output of buildHealthTimelineFromStorage().
   * Supplies: totalAlcoholDrinks, caffeineMg, wellness booleans, activeContextTypes.
   */
  storageLogs?: HealthDayRecord[];

  /**
   * Supabase nutrition history (optional).
   * Provide the output of fetchNutritionHistory().
   * Supplies: calories, protein, carbs, fat per day.
   */
  nutritionHistory?: Map<string, { calories: number; protein_g: number; carbs_g: number; fat_g: number }>;
}

// ─── buildTimelineFromAdapters ─────────────────────────────────────────────────

/**
 * Merge all provided source adapter outputs into a unified HealthDayRecord[].
 * Returns records sorted oldest → newest.
 * Absent sources contribute no records — the result is always at least [].
 *
 * Grace degradation:
 *   - No Oura → recovery signals (readiness, HRV, sleepScore) will be absent.
 *     Sleep hours may still come from HK if hkSleepByDate is provided.
 *   - No HK → workout data, hkSteps absent.
 *   - No storage logs → drink/caffeine/wellness signals absent.
 */
export function buildTimelineFromAdapters(input: TimelineInput): HealthDayRecord[] {
  const contributions: DayContribution[] = [];

  if (input.ouraWeeklyDays?.length) {
    contributions.push(...adaptOuraWeekly(input.ouraWeeklyDays));
  }

  if (input.hkWorkouts?.length) {
    contributions.push(...adaptHKWorkouts(input.hkWorkouts));
  }

  if (input.hkSleepByDate && Object.keys(input.hkSleepByDate).length > 0) {
    contributions.push(...adaptHKSleepByDate(input.hkSleepByDate));
  }

  if (input.hkStepsToday && input.hkStepsToday.steps > 0) {
    contributions.push(adaptHKStepsToday(input.hkStepsToday.steps, input.hkStepsToday.date));
  }

  if (input.hkHrvToday && input.hkHrvToday.hrv > 0) {
    contributions.push(adaptHKHrvToday(input.hkHrvToday.hrv, input.hkHrvToday.date));
  }

  if (input.storageLogs?.length) {
    contributions.push(...adaptStorageLogs(input.storageLogs));
  }

  if (input.nutritionHistory?.size) {
    contributions.push(...adaptNutritionHistory(input.nutritionHistory));
  }

  if (contributions.length === 0) return [];

  return buildDayRecords(contributions);
}

// ─── Signal provenance summary ─────────────────────────────────────────────────

export type SignalProvenance = {
  /** Which domains have at least one day of data */
  availableSources: string[];
  /** Days with Oura data */
  daysWithOura: number;
  /** Days with HK workout data */
  daysWithHKWorkouts: number;
  /** Days with lifestyle log data */
  daysWithLifestyleLogs: number;
};

/**
 * Summarize which sources contributed to a built timeline.
 * Used by the dev validation report.
 */
export function summarizeProvenance(timeline: HealthDayRecord[]): SignalProvenance {
  let daysWithOura = 0;
  let daysWithHKWorkouts = 0;
  let daysWithLifestyleLogs = 0;

  for (const d of timeline) {
    if (d.readiness !== undefined || d.sleepScore !== undefined || d.hrv !== undefined) {
      daysWithOura++;
    }
    if (d.workoutDurationMin !== undefined) daysWithHKWorkouts++;
    if (
      d.totalAlcoholDrinks !== undefined ||
      d.caffeineMg !== undefined ||
      d.hasSaunaSession !== undefined
    ) {
      daysWithLifestyleLogs++;
    }
  }

  const availableSources: string[] = [];
  if (daysWithOura > 0) availableSources.push('Oura Ring');
  if (daysWithHKWorkouts > 0) availableSources.push('Apple Health Workouts');
  const hasHkSteps = timeline.some((d) => d.hkSteps !== undefined);
  const hasHkSleep = timeline.some((d) => d.sleepHours !== undefined && d.sleepScore === undefined);
  if (hasHkSteps) availableSources.push('Apple Health Steps');
  if (hasHkSleep) availableSources.push('Apple Health Sleep');
  if (daysWithLifestyleLogs > 0) availableSources.push('BellaHealth Logs');

  return { availableSources, daysWithOura, daysWithHKWorkouts, daysWithLifestyleLogs };
}
