/**
 * canonical-signals.ts
 *
 * Source adapter interface, DayContribution type, and merge logic.
 *
 * Architecture:
 *   DATA SOURCES → SOURCE ADAPTERS → DayContribution[]
 *   → mergeContributions → HealthDayRecord[] → CONTEXT ENGINE
 *
 * The Context Engine (pattern-engine, context-synthesis) NEVER imports
 * device-specific code. It only consumes HealthDayRecord[].
 *
 * Source priority (higher = wins for overlapping fields):
 *   1 = BellaHealth lifestyle logs (AsyncStorage)
 *   2 = HealthKit / Apple Health
 *   3 = Oura API
 *
 * Special deduplication rules:
 *   - hkSteps and ouraSteps are BOTH preserved (separate fields).
 *     The 'steps' virtual signal in the pattern engine uses hkSteps ?? ouraSteps.
 *   - sleepHours: Oura API (priority 3) wins over HealthKit (priority 2).
 *     HK sleep is used only when Oura is unavailable.
 *   - workoutDurationMin: HealthKit (priority 2) wins over Oura (priority 3)?
 *     NO — Oura syncs workouts FROM Apple Health. To prevent double-counting,
 *     HealthKit workouts are written to HK-specific fields; Oura workout data
 *     is NOT mapped to workoutDurationMin (Oura's workout endpoint is treated
 *     as informational only in the adapter layer).
 *   - hrv: Oura (ring sensor during sleep, high accuracy) > HealthKit SDNN
 *     (instantaneous measurement, less accurate). For non-Oura users, HK HRV
 *     from the last-known point-in-time sample can populate today only.
 */

import type { HealthDayRecord } from './pattern-engine';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface DayContribution {
  /** YYYY-MM-DD — wakeup/reporting date for this data */
  date: string;
  /** Identifier matching SourceName in pattern-registry */
  sourceId: string;
  /**
   * Priority for field conflicts. Higher priority overwrites lower.
   * Use SIGNAL_PRIORITY constants.
   */
  priority: number;
  /** Signal values this source contributes for this day */
  signals: Partial<HealthDayRecord>;
}

/**
 * Interface for all source adapters.
 * Adapters are pure transformers: they receive already-fetched data
 * and return DayContribution[]. No I/O inside adapter functions.
 */
export interface SourceAdapterInterface {
  readonly sourceId: string;
  readonly displayName: string;
}

// ─── Priority constants ────────────────────────────────────────────────────────

export const SIGNAL_PRIORITY = {
  BELLAHEALTH_LOGS: 1,
  HEALTHKIT:        2,
  OURA:             3,
} as const;

// ─── Merge ─────────────────────────────────────────────────────────────────────

/**
 * Merge multiple DayContributions for the same date into a single HealthDayRecord.
 *
 * Higher-priority sources win for all overlapping scalar fields.
 * Exception: hkSteps and ouraSteps are BOTH preserved regardless of priority.
 * activeContextTypes arrays are unioned.
 */
export function mergeContributions(
  date: string,
  contributions: DayContribution[],
): HealthDayRecord {
  // Sort ascending priority so higher-priority entries overwrite lower ones
  const sorted = [...contributions].sort((a, b) => a.priority - b.priority);

  const merged: HealthDayRecord = { date };

  for (const c of sorted) {
    const s = c.signals;

    // Oura ring signals
    if (s.sleepHours  !== undefined) merged.sleepHours  = s.sleepHours;
    if (s.sleepScore  !== undefined) merged.sleepScore  = s.sleepScore;
    if (s.hrv         !== undefined) merged.hrv         = s.hrv;
    if (s.readiness   !== undefined) merged.readiness   = s.readiness;
    if (s.ouraSteps   !== undefined) merged.ouraSteps   = s.ouraSteps;

    // HealthKit signals — hkSteps always kept alongside ouraSteps
    if (s.hkSteps                !== undefined) merged.hkSteps                = s.hkSteps;
    if (s.workoutDurationMin     !== undefined) merged.workoutDurationMin     = s.workoutDurationMin;
    if (s.workoutCaloriesBurned  !== undefined) merged.workoutCaloriesBurned  = s.workoutCaloriesBurned;
    if (s.workoutCount           !== undefined) merged.workoutCount           = s.workoutCount;
    if (s.waterOz                !== undefined) merged.waterOz                = s.waterOz;

    // Nutrition
    if (s.calories !== undefined) merged.calories = s.calories;
    if (s.protein  !== undefined) merged.protein  = s.protein;
    if (s.carbs    !== undefined) merged.carbs    = s.carbs;
    if (s.fat      !== undefined) merged.fat      = s.fat;

    // BellaHealth lifestyle logs
    if (s.totalAlcoholDrinks    !== undefined) merged.totalAlcoholDrinks    = s.totalAlcoholDrinks;
    if (s.caffeineMg            !== undefined) merged.caffeineMg            = s.caffeineMg;
    if (s.hasSaunaSession       !== undefined) merged.hasSaunaSession       = s.hasSaunaSession;
    if (s.hasColdPlungeSession  !== undefined) merged.hasColdPlungeSession  = s.hasColdPlungeSession;
    if (s.hasWellnessClass      !== undefined) merged.hasWellnessClass      = s.hasWellnessClass;
    if (s.gratitudeSessions     !== undefined) merged.gratitudeSessions     = (merged.gratitudeSessions ?? 0) + s.gratitudeSessions;
    if (s.electrolytesLogged    !== undefined) merged.electrolytesLogged    = s.electrolytesLogged;

    // Context types: union of all arrays
    if (s.activeContextTypes?.length) {
      merged.activeContextTypes = [
        ...new Set([...(merged.activeContextTypes ?? []), ...s.activeContextTypes]),
      ];
    }
  }

  return merged;
}

// ─── Group + merge by date ─────────────────────────────────────────────────────

/**
 * Group a flat list of DayContributions by date, merge each group,
 * and return a HealthDayRecord[] sorted oldest → newest.
 */
export function buildDayRecords(contributions: DayContribution[]): HealthDayRecord[] {
  const byDate = new Map<string, DayContribution[]>();

  for (const c of contributions) {
    const existing = byDate.get(c.date) ?? [];
    existing.push(c);
    byDate.set(c.date, existing);
  }

  const records: HealthDayRecord[] = [];
  for (const [date, group] of byDate) {
    records.push(mergeContributions(date, group));
  }

  return records.sort((a, b) => a.date.localeCompare(b.date));
}
