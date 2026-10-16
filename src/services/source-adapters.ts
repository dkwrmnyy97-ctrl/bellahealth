/**
 * source-adapters.ts
 *
 * Pure transformation functions: raw device/service data → DayContribution[].
 *
 * NO I/O in this file. All API calls happen in callers (timeline-builder.ts,
 * or screens that orchestrate data fetching). Adapters receive already-fetched
 * data and normalize it to the canonical DayContribution shape.
 *
 * Supported sources:
 *   adaptOuraWeekly         — from fetchOuraWeekly() in oura.ts
 *   adaptHKWorkouts         — from getRecentWorkouts() in healthkit.ts
 *   adaptHKSleepByDate      — from getHistoricalSleepHours() in healthkit.ts
 *   adaptHKStepsToday       — from getTodaySteps() in healthkit.ts
 *   adaptHKHrvToday         — from getLatestHRV() in healthkit.ts (today only)
 *   adaptStorageLogs        — from buildHealthTimelineFromStorage() in pattern-engine.ts
 */

import type { OuraWeeklyDay } from './oura';
import type { WorkoutSample } from './healthkit';
import type { HealthDayRecord } from './pattern-engine';
import { type DayContribution, SIGNAL_PRIORITY } from './canonical-signals';

// ─── Oura adapter ──────────────────────────────────────────────────────────────

/**
 * Adapt Oura API weekly data into DayContributions.
 *
 * Date semantics: OuraWeeklyDay.date is the wakeup date (same convention as
 * readiness, HRV, and sleep score — all reported on the wakeup morning).
 * This maps directly to HealthDayRecord.date with no adjustment.
 *
 * Oura steps go to ouraSteps (not hkSteps) — the pattern engine uses
 * hkSteps ?? ouraSteps, so both are preserved when both exist.
 *
 * Oura workout data is intentionally NOT mapped to workoutDurationMin here.
 * Oura pulls workout data FROM Apple Health — using the Oura workout endpoint
 * as the workout source would duplicate data already in HealthKit.
 */
export function adaptOuraWeekly(days: OuraWeeklyDay[]): DayContribution[] {
  return days.map((d) => {
    const signals: Partial<HealthDayRecord> = {};

    // Only set fields that have meaningful values (> 0 means Oura has data)
    if (d.sleepScore  > 0) signals.sleepScore  = d.sleepScore;
    if (d.sleepHours  > 0) signals.sleepHours  = d.sleepHours;
    if (d.hrv         > 0) signals.hrv         = d.hrv;
    if (d.readiness   > 0) signals.readiness   = d.readiness;
    if (d.steps       > 0) signals.ouraSteps   = d.steps;

    // Thread bedtime timestamps (already fetched, previously discarded).
    // No interpretation yet — preserved for future sleep-timing story logic.
    if (d.bedtimeStart) signals.bedtimeStart = d.bedtimeStart;
    if (d.bedtimeEnd)   signals.bedtimeEnd   = d.bedtimeEnd;

    // Oura daily_stress signals — undefined when endpoint unavailable for this day.
    // null check already handled upstream (undefined in type means not fetched or absent).
    if (d.stressHighMinutes   != null) signals.stressHighMinutes   = d.stressHighMinutes;
    if (d.recoveryHighMinutes != null) signals.recoveryHighMinutes = d.recoveryHighMinutes;

    return {
      date:     d.date,
      sourceId: 'oura_readiness',
      priority: SIGNAL_PRIORITY.OURA,
      signals,
    };
  });
}

// ─── HealthKit workouts adapter ────────────────────────────────────────────────

/**
 * Adapt HealthKit workout history into DayContributions.
 *
 * Multiple workouts on the same day are summed: duration and calories are
 * aggregated, count is the number of distinct workout sessions.
 *
 * Date: the calendar date of workout.startDate (local time).
 */
/** Returns true for activity types that represent running. */
function isRunningActivity(activityName: string): boolean {
  const lower = activityName.toLowerCase();
  // Covers "Running", "Outdoor Run", "Trail Running", "Treadmill Running", etc.
  // Intentionally excludes cross-training, cycling, swimming.
  return lower.includes('running') || lower === 'outdoor run' || lower === 'treadmill';
}

export function adaptHKWorkouts(workouts: WorkoutSample[]): DayContribution[] {
  type DayTotals = {
    durationMin: number;
    calories: number;
    count: number;
    runningDistanceKm: number;
    runningSessionCount: number;
    // Map<activityName, sessionCount> to derive primaryActivityType
    activityCounts: Map<string, number>;
  };
  const byDate = new Map<string, DayTotals>();

  for (const w of workouts) {
    const date = toLocalDateStr(w.startDate);
    const existing = byDate.get(date) ?? {
      durationMin: 0, calories: 0, count: 0,
      runningDistanceKm: 0, runningSessionCount: 0,
      activityCounts: new Map<string, number>(),
    };

    existing.durationMin += w.duration ?? 0;
    existing.calories    += w.calories ?? 0;
    existing.count       += 1;

    const name = w.activityName ?? '';
    existing.activityCounts.set(name, (existing.activityCounts.get(name) ?? 0) + 1);

    if (isRunningActivity(name) && w.distance !== undefined) {
      existing.runningDistanceKm   += w.distance; // HealthKit returns km when unit='km'
      existing.runningSessionCount += 1;
    } else if (isRunningActivity(name)) {
      // Running session but no distance logged — still count the session
      existing.runningSessionCount += 1;
    }

    byDate.set(date, existing);
  }

  const contributions: DayContribution[] = [];
  for (const [date, totals] of byDate) {
    // Pick the activity type with the most sessions; fall back to first entry.
    let primaryActivityType: string | undefined;
    let maxCount = 0;
    for (const [name, cnt] of totals.activityCounts) {
      if (cnt > maxCount) { maxCount = cnt; primaryActivityType = name; }
    }

    contributions.push({
      date,
      sourceId: 'apple_health_workouts',
      priority: SIGNAL_PRIORITY.HEALTHKIT,
      signals: {
        workoutDurationMin:    totals.durationMin,
        workoutCaloriesBurned: totals.calories,
        workoutCount:          totals.count,
        runningDistanceKm:     totals.runningDistanceKm > 0 ? Math.round(totals.runningDistanceKm * 100) / 100 : undefined,
        runningSessionCount:   totals.runningSessionCount > 0 ? totals.runningSessionCount : undefined,
        primaryActivityType,
      },
    });
  }

  return contributions;
}

// ─── HealthKit sleep adapter ───────────────────────────────────────────────────

/**
 * Adapt HealthKit historical sleep hours (by wakeup date) into DayContributions.
 *
 * Input: Record<YYYY-MM-DD, sleepHours> — wakeup date → hours.
 * See getHistoricalSleepHours() in healthkit.ts for how wakeup date is derived.
 *
 * These contributions have HEALTHKIT priority, so Oura sleepHours (priority OURA)
 * will overwrite them on days where both exist.
 */
export function adaptHKSleepByDate(sleepByDate: Record<string, number>): DayContribution[] {
  return Object.entries(sleepByDate)
    .filter(([, hours]) => hours > 0)
    .map(([date, sleepHours]) => ({
      date,
      sourceId: 'oura_sleep',   // maps to same display label as Oura sleep in SOURCE_LABELS
      priority: SIGNAL_PRIORITY.HEALTHKIT,
      signals:  { sleepHours } as Partial<HealthDayRecord>,
    }));
}

// ─── HealthKit today: steps ────────────────────────────────────────────────────

/**
 * Adapt today's HealthKit step count into a DayContribution.
 * Writes to hkSteps (not ouraSteps) so both are preserved when Oura also provides steps.
 */
export function adaptHKStepsToday(steps: number, date: string): DayContribution {
  return {
    date,
    sourceId: 'apple_health_steps',
    priority: SIGNAL_PRIORITY.HEALTHKIT,
    signals:  { hkSteps: steps } as Partial<HealthDayRecord>,
  };
}

// ─── HealthKit today: HRV ─────────────────────────────────────────────────────

/**
 * Adapt today's HealthKit HRV (SDNN, most-recent sample) into a DayContribution.
 *
 * Limitations:
 *   - HK HRV is a point-in-time sample, not an overnight sleep average.
 *   - Only available for today (no historical per-day HK HRV query implemented).
 *   - On days where Oura HRV is available, Oura (priority 3) overwrites this (priority 2).
 *
 * This adapter is only useful for non-Oura users who have an Apple Watch.
 */
export function adaptHKHrvToday(hrv: number, date: string): DayContribution {
  return {
    date,
    sourceId: 'oura_hrv',
    priority: SIGNAL_PRIORITY.HEALTHKIT,
    signals:  { hrv } as Partial<HealthDayRecord>,
  };
}

// ─── Nutrition history adapter ─────────────────────────────────────────────────

/**
 * Adapt Supabase nutrition history (daily totals by date) into DayContributions.
 * Input is a Map<YYYY-MM-DD, { calories, protein_g, carbs_g, fat_g }>.
 */
export function adaptNutritionHistory(
  history: Map<string, { calories: number; protein_g: number; carbs_g: number; fat_g: number }>
): DayContribution[] {
  const result: DayContribution[] = [];
  history.forEach((totals, date) => {
    result.push({
      date,
      sourceId: 'bellahealth_nutrition',
      priority: SIGNAL_PRIORITY.BELLAHEALTH_LOGS,
      signals: {
        calories: totals.calories  > 0 ? totals.calories  : undefined,
        protein:  totals.protein_g > 0 ? totals.protein_g : undefined,
        carbs:    totals.carbs_g   > 0 ? totals.carbs_g   : undefined,
        fat:      totals.fat_g     > 0 ? totals.fat_g     : undefined,
      } as Partial<HealthDayRecord>,
    });
  });
  return result;
}

// ─── Storage logs adapter ─────────────────────────────────────────────────────

/**
 * Adapt lifestyle logs from AsyncStorage (already loaded as HealthDayRecord[])
 * into DayContributions.
 *
 * The output of buildHealthTimelineFromStorage() contains: totalAlcoholDrinks,
 * caffeineMg, hasSaunaSession, hasColdPlungeSession, hasWellnessClass,
 * activeContextTypes. These are the only fields populated from storage logs.
 *
 * Sleep, HRV, readiness etc. from storage are NOT set here — those come from
 * Oura or HealthKit adapters with their own higher fidelity.
 */
export function adaptStorageLogs(storageDays: HealthDayRecord[]): DayContribution[] {
  return storageDays
    .filter((d) => hasLifestyleData(d))
    .map((d) => ({
      date:     d.date,
      sourceId: 'bellahealth_drink_log',
      priority: SIGNAL_PRIORITY.BELLAHEALTH_LOGS,
      signals: {
        totalAlcoholDrinks:   d.totalAlcoholDrinks,
        caffeineMg:           d.caffeineMg,
        hasSaunaSession:      d.hasSaunaSession,
        hasColdPlungeSession: d.hasColdPlungeSession,
        hasWellnessClass:     d.hasWellnessClass,
        gratitudeSessions:    d.gratitudeSessions,
        electrolytesLogged:   d.electrolytesLogged,
        activeContextTypes:   d.activeContextTypes,
      } as Partial<HealthDayRecord>,
    }));
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** YYYY-MM-DD from a Date in local time */
function toLocalDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function hasLifestyleData(d: HealthDayRecord): boolean {
  return (
    d.totalAlcoholDrinks  !== undefined ||
    d.caffeineMg          !== undefined ||
    d.hasSaunaSession     !== undefined ||
    d.hasColdPlungeSession !== undefined ||
    d.hasWellnessClass    !== undefined ||
    d.gratitudeSessions   !== undefined ||
    d.electrolytesLogged  !== undefined ||
    (d.activeContextTypes?.length ?? 0) > 0
  );
}
