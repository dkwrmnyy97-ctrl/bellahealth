/**
 * context-timeline.ts
 *
 * Normalized data access layer for the Context Engine.
 * Produces daily timelines, life-context timelines, and on-device baseline profiles.
 *
 * Design rules:
 *   - Missing values stay missing — never coerced to 0.
 *   - Source provenance is always preserved.
 *   - On-device only. No cross-user data. No new server calls.
 *   - Observation unit (day vs. bounded event) is explicit in evidence metadata.
 */

import { fetchContextSources, type ContextEvent } from './context-events';

// ─── Evidence metadata ─────────────────────────────────────────────────────────

export type ObservationUnit = 'day' | 'bounded_event';

export interface EvidenceMetadata {
  observationUnit: ObservationUnit;
  /** Total number of individual observations that contributed */
  observationCount: number;
  /** Date range of observations, or null if fewer than 2 observations */
  dateRange: { start: string; end: string } | null;
  /** Number of baseline days used for comparison */
  baselineCount: number;
  effectMagnitude: 'small' | 'moderate' | 'large' | 'unknown';
  direction: 'positive' | 'negative' | 'neutral' | 'unknown';
  /** 0–1: fraction of observations where the pattern held */
  consistency: number;
  /** Which data sources contributed */
  sources: string[];
}

// ─── Daily context entry ───────────────────────────────────────────────────────

export interface DailyContextEntry {
  date: string;
  /** User-logged events whose date range spans this day */
  activeEvents: ContextEvent[];
  /** Derived events that fell on this day */
  derivedEvents: ContextEvent[];
  /** Which source types contributed data for this day */
  sources: string[];
}

// ─── Baseline types ────────────────────────────────────────────────────────────

export interface BaselineMetric {
  key: string;
  /** Valid (non-null) observations only */
  values: number[];
  sampleCount: number;
  dateRange: { start: string; end: string } | null;
  mean: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
}

export interface BaselineProfile {
  generatedAt: string;
  windowDays: number;
  metrics: Record<string, BaselineMetric>;
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

function lastNDays(n: number): string[] {
  const dates: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

function medianOf(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function percentileOf(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}

function cutoffDate(windowDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() - windowDays);
  return d.toISOString().split('T')[0];
}

// ─── buildBodyTimeline ─────────────────────────────────────────────────────────

/**
 * Builds a daily timeline of health context for the past `windowDays` days.
 * For each day: which user-logged events were active + which derived events fired.
 */
export async function buildBodyTimeline(windowDays = 30): Promise<DailyContextEntry[]> {
  const sources = await fetchContextSources();
  const dates = lastNDays(windowDays);

  const allDerived = [
    ...sources.drinkEvents,
    ...sources.wellnessClassEvents,
    ...sources.wellnessSessionEvents,
    ...sources.cyclePhaseEvents,
  ];

  return dates.map((date) => {
    const activeEvents = sources.userEvents.filter((e) => {
      if (e.startDate > date) return false;
      if (e.endDate !== undefined && e.endDate < date) return false;
      return true;  // open-ended events (no endDate) are still active
    });

    const derivedEvents = allDerived.filter(
      (e) => e.startDate <= date && (e.endDate === undefined || e.endDate >= date)
    );

    const sourceSet = new Set<string>();
    activeEvents.forEach((e) => sourceSet.add(e.type));
    derivedEvents.forEach((e) => sourceSet.add(e.type));

    return { date, activeEvents, derivedEvents, sources: [...sourceSet] };
  });
}

// ─── buildLifeContextTimeline ──────────────────────────────────────────────────

/**
 * Returns all ContextEvents (user-logged + derived) within the window,
 * sorted by startDate descending (most recent first).
 * Source provenance is preserved on each event.
 */
export async function buildLifeContextTimeline(windowDays = 90): Promise<ContextEvent[]> {
  const sources = await fetchContextSources();
  const cutoff = cutoffDate(windowDays);

  const all: ContextEvent[] = [
    ...sources.userEvents,
    ...sources.drinkEvents,
    ...sources.wellnessClassEvents,
    ...sources.wellnessSessionEvents,
    ...sources.cyclePhaseEvents,
  ];

  return all
    .filter((e) => e.startDate >= cutoff)
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
}

// ─── buildBaselineProfile ──────────────────────────────────────────────────────

/**
 * Builds an on-device personal baseline from provided numeric observations.
 *
 * @param metricObservations  Map of metric key → array of values (may include null/undefined).
 *                            Null/undefined values are treated as missing — never become 0.
 * @param windowDays          Rolling window this baseline covers (default 90).
 * @param dateRange           Optional start/end dates for the observation window.
 *
 * Sparse history: metrics with 0 valid samples have null central tendency values.
 * This is intentional — better to report "insufficient data" than a misleading number.
 */
export function buildBaselineProfile(
  metricObservations: Record<string, (number | null | undefined)[]>,
  windowDays = 90,
  dateRange?: { start: string; end: string }
): BaselineProfile {
  const metrics: Record<string, BaselineMetric> = {};

  for (const [key, rawValues] of Object.entries(metricObservations)) {
    const valid = rawValues.filter((v): v is number => v !== null && v !== undefined);
    const sorted = [...valid].sort((a, b) => a - b);
    const mean = valid.length > 0
      ? valid.reduce((acc, v) => acc + v, 0) / valid.length
      : null;

    metrics[key] = {
      key,
      values: valid,
      sampleCount: valid.length,
      dateRange: dateRange ?? null,
      mean,
      median: medianOf(sorted),
      p25: percentileOf(sorted, 25),
      p75: percentileOf(sorted, 75),
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    metrics,
  };
}
