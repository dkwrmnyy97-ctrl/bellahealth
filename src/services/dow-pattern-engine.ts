/**
 * dow-pattern-engine.ts
 *
 * Day-of-week recurring pattern detection.
 *
 * Asks a different question than detectPatterns() in pattern-engine.ts:
 * not "does X correlate with Y across the timeline?" but "is signal X
 * consistently different from this user's personal baseline on a specific
 * weekday compared to the rest of the week?"
 *
 * Algorithm:
 *   1. Group HealthDayRecord[] by day-of-week (0=Sun … 6=Sat)
 *   2. For each (signal, DOW) pair with ≥ MIN_DOW_OCCURRENCES data points:
 *      a. Compute the mean for that DOW
 *      b. Compute the mean for all OTHER days (personal weekly baseline)
 *      c. Gate on MEANINGFUL_EFFECT_THRESHOLD for that signal
 *      d. Gate on consistency rate ≥ MIN_CONSISTENCY
 *   3. Apply same-DOW deduplication for oura_stress family:
 *      if stress↑ and recovery↓ fire for the same day (or inverse),
 *      keep only the higher-consistency observation.
 *   4. Return DowPatternResult[] sorted by strength (consistencyRate × absoluteDiff)
 *
 * Conservative philosophy: false negatives preferred over noisy observations.
 * Minimum 4 occurrences = roughly 4 weeks of data per weekday.
 *
 * Designed to be forward-compatible with intraday time-window patterns —
 * see PatternObservationNote in pattern-observation-store.ts.
 */

import type { HealthDayRecord, ConfidenceTier } from './pattern-engine';
import { MEANINGFUL_EFFECT_THRESHOLD, SIGNAL_FAMILY, type SignalKey } from './pattern-registry';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum occurrences of a weekday in the timeline to evaluate a pattern. */
const MIN_DOW_OCCURRENCES = 4;

/**
 * Minimum fraction of DOW occurrences that must go in the same direction
 * relative to personal baseline. 0.65 = 65%.
 */
const MIN_CONSISTENCY = 0.65;

/**
 * Minimum number of other-day samples needed to establish a meaningful
 * personal baseline for comparison.
 */
const MIN_BASELINE_DAYS = 8;

/**
 * Signals evaluated for day-of-week patterns.
 * Conservative: only high-coverage Oura signals where daily data is reliable.
 * Lifestyle logs (alcohol, caffeine, etc.) are too sparse for DOW patterns.
 */
const DOW_SIGNALS: SignalKey[] = [
  'readiness',
  'hrv',
  'sleepScore',
  'sleepHours',
  'stressHighMinutes',
  'recoveryHighMinutes',
];

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ─── Result type ──────────────────────────────────────────────────────────────

export interface DowPatternResult {
  /**
   * Deterministic ID: `${signal}_dow_${dayOfWeek}`.
   * Stable across sessions — used as deduplication key in the observation store.
   */
  id: string;
  signal: SignalKey;
  /** 0 = Sunday, 1 = Monday, … 6 = Saturday */
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  dayLabel: string;
  direction: 'above_baseline' | 'below_baseline';
  /** Personal mean across all OTHER days of the week */
  baselineMean: number;
  /** Mean on this specific day of week */
  dowMean: number;
  absoluteDiff: number;
  /** Number of weeks (occurrences of this DOW) with data for this signal */
  occurrences: number;
  /**
   * Fraction of occurrences where the value went in the detected direction
   * relative to personal baseline. Used as the primary confidence indicator.
   */
  consistencyRate: number;
  /**
   * Reuses the existing ConfidenceTier vocabulary:
   *   EARLY      — 4–5 occurrences
   *   PATTERN    — 6–9 occurrences, consistency ≥ 0.65
   *   CONSISTENT — 10+ occurrences, consistency ≥ 0.70
   */
  confidenceTier: ConfidenceTier;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function getSignalForDow(day: HealthDayRecord, signal: SignalKey): number | undefined {
  switch (signal) {
    case 'readiness':           return day.readiness;
    case 'hrv':                 return day.hrv;
    case 'sleepScore':          return day.sleepScore;
    case 'sleepHours':          return day.sleepHours;
    case 'stressHighMinutes':   return day.stressHighMinutes;
    case 'recoveryHighMinutes': return day.recoveryHighMinutes;
    default:                    return undefined;
  }
}

function dayOfWeekFromDateStr(dateStr: string): number {
  // Parse as local date to match Oura's day convention
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

function confidenceTierForDow(occurrences: number, consistencyRate: number): ConfidenceTier {
  if (occurrences < MIN_DOW_OCCURRENCES) return 'INSUFFICIENT';
  if (occurrences >= 10 && consistencyRate >= 0.70) return 'CONSISTENT';
  if (occurrences >= 6 && consistencyRate >= MIN_CONSISTENCY) return 'PATTERN';
  if (occurrences >= MIN_DOW_OCCURRENCES && consistencyRate >= MIN_CONSISTENCY) return 'EARLY';
  return 'INSUFFICIENT';
}

// ─── Main detection function ──────────────────────────────────────────────────

/**
 * Detect day-of-week recurring patterns in a health timeline.
 *
 * Returns only EARLY, PATTERN, or CONSISTENT results (never INSUFFICIENT).
 * Results are sorted by strength: consistencyRate × absoluteDiff descending.
 * Maximum 1 result per (signal, dayOfWeek) pair after deduplication.
 */
export function detectDowPatterns(timeline: HealthDayRecord[]): DowPatternResult[] {
  if (timeline.length < MIN_DOW_OCCURRENCES + MIN_BASELINE_DAYS) return [];

  const results: DowPatternResult[] = [];

  for (const signal of DOW_SIGNALS) {
    const threshold = MEANINGFUL_EFFECT_THRESHOLD[signal];
    if (threshold === undefined) continue;

    // Group signal values by day-of-week (0–6)
    const byDow: Record<number, number[]> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
    for (const day of timeline) {
      const val = getSignalForDow(day, signal);
      if (val === undefined) continue;
      const dow = dayOfWeekFromDateStr(day.date);
      byDow[dow].push(val);
    }

    for (let dow = 0; dow <= 6; dow++) {
      const dowValues = byDow[dow];
      if (dowValues.length < MIN_DOW_OCCURRENCES) continue;

      // Baseline: all other days combined
      const baselineValues: number[] = [];
      for (let other = 0; other <= 6; other++) {
        if (other !== dow) baselineValues.push(...byDow[other]);
      }
      if (baselineValues.length < MIN_BASELINE_DAYS) continue;

      const dowMean = mean(dowValues);
      const baselineMean = mean(baselineValues);
      const absoluteDiff = Math.abs(dowMean - baselineMean);

      if (absoluteDiff < threshold) continue;

      const direction: 'above_baseline' | 'below_baseline' =
        dowMean > baselineMean ? 'above_baseline' : 'below_baseline';

      // Consistency: fraction of DOW occurrences that went in the detected direction
      const goesInDirection = dowValues.filter((v) =>
        direction === 'above_baseline' ? v > baselineMean : v < baselineMean
      ).length;
      const consistencyRate = goesInDirection / dowValues.length;

      if (consistencyRate < MIN_CONSISTENCY) continue;

      const confidenceTier = confidenceTierForDow(dowValues.length, consistencyRate);
      if (confidenceTier === 'INSUFFICIENT') continue;

      results.push({
        id: `${signal}_dow_${dow}`,
        signal,
        dayOfWeek: dow as 0 | 1 | 2 | 3 | 4 | 5 | 6,
        dayLabel: DAY_NAMES[dow],
        direction,
        baselineMean,
        dowMean,
        absoluteDiff,
        occurrences: dowValues.length,
        consistencyRate,
        confidenceTier,
      });
    }
  }

  // ── Same-DOW deduplication for oura_stress family ─────────────────────────
  // If stressHighMinutes and recoveryHighMinutes both fire for the same DOW
  // and describe the same underlying state (stress↑ + recovery↓, or vice versa),
  // keep only the higher-consistency observation to avoid redundant surfacing.
  const deduped = deduplicateStressFamily(results);

  // Sort by strength: consistencyRate × absoluteDiff (normalized), descending
  return deduped.sort((a, b) => {
    const scoreA = a.consistencyRate * a.absoluteDiff;
    const scoreB = b.consistencyRate * b.absoluteDiff;
    return scoreB - scoreA;
  });
}

function deduplicateStressFamily(results: DowPatternResult[]): DowPatternResult[] {
  const out: DowPatternResult[] = [];
  const suppressedIds = new Set<string>();

  for (const r of results) {
    if (suppressedIds.has(r.id)) continue;

    if (SIGNAL_FAMILY[r.signal] === 'oura_stress') {
      // Find the counterpart signal on the same DOW
      const counterpartSignal: SignalKey =
        r.signal === 'stressHighMinutes' ? 'recoveryHighMinutes' : 'stressHighMinutes';
      const counterpart = results.find(
        (c) => c.signal === counterpartSignal && c.dayOfWeek === r.dayOfWeek
      );

      if (counterpart && !suppressedIds.has(counterpart.id)) {
        // Same story if directions are opposite (stress↑ = recovery↓, or stress↓ = recovery↑)
        const oppositeDirections = r.direction !== counterpart.direction;
        if (oppositeDirections) {
          // Suppress the lower-consistency one
          const toSuppress = r.consistencyRate >= counterpart.consistencyRate ? counterpart : r;
          suppressedIds.add(toSuppress.id);
          if (toSuppress.id === r.id) continue;
        }
      }
    }

    out.push(r);
  }

  return out;
}
