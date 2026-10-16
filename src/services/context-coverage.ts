/**
 * context-coverage.ts
 *
 * Computes the coverage status of each health domain for a given HealthDayRecord
 * or a whole timeline.
 *
 * Domains:
 *   SLEEP      — sleep duration and/or quality score
 *   RECOVERY   — readiness and/or HRV
 *   MOVEMENT   — steps and/or workout data
 *   NUTRITION  — calories and/or macros
 *   LIFE_CONTEXT — active context events, drink log, wellness sessions
 *
 * Coverage levels:
 *   'available'   — primary signal(s) present for this domain
 *   'limited'     — secondary signals only (e.g., sleep duration but no score)
 *   'unavailable' — no signals for this domain
 *
 * This is used to:
 *   - Show "Based on:" provenance in the UI
 *   - Gate pattern surface in the Context Engine (only surface patterns
 *     for domains with at least 'limited' coverage)
 *   - Prevent showing "insufficient data" when only one domain is missing
 */

import type { HealthDayRecord } from './pattern-engine';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type CoverageDomain =
  | 'SLEEP'
  | 'RECOVERY'
  | 'MOVEMENT'
  | 'NUTRITION'
  | 'LIFE_CONTEXT';

export type CoverageLevel = 'available' | 'limited' | 'unavailable';

export interface DomainCoverage {
  domain: CoverageDomain;
  level: CoverageLevel;
  /** Human-readable reason, for dev validation and "Based on:" display */
  detail: string;
}

export interface CoverageReport {
  /** Per-domain coverage for this day */
  domains: DomainCoverage[];
  /** True if at least one domain has data (anything above 'unavailable') */
  hasAnyData: boolean;
  /** True if SLEEP and RECOVERY both have at least 'limited' coverage */
  canAnalyzeRecovery: boolean;
  /** True if MOVEMENT has at least 'limited' coverage */
  canAnalyzeMovement: boolean;
}

// ─── Per-domain coverage rules ─────────────────────────────────────────────────

function sleepCoverage(d: HealthDayRecord): DomainCoverage {
  if (d.sleepScore !== undefined && d.sleepHours !== undefined) {
    return { domain: 'SLEEP', level: 'available', detail: 'Oura sleep score + duration' };
  }
  if (d.sleepHours !== undefined) {
    return { domain: 'SLEEP', level: 'limited', detail: 'Sleep duration only (no quality score)' };
  }
  if (d.sleepScore !== undefined) {
    return { domain: 'SLEEP', level: 'limited', detail: 'Sleep score only (no duration)' };
  }
  return { domain: 'SLEEP', level: 'unavailable', detail: 'No sleep data' };
}

function recoveryCoverage(d: HealthDayRecord): DomainCoverage {
  if (d.readiness !== undefined && d.hrv !== undefined) {
    return { domain: 'RECOVERY', level: 'available', detail: 'Oura readiness + HRV' };
  }
  if (d.readiness !== undefined) {
    return { domain: 'RECOVERY', level: 'available', detail: 'Oura readiness score' };
  }
  if (d.hrv !== undefined) {
    return { domain: 'RECOVERY', level: 'limited', detail: 'HRV only (no readiness score)' };
  }
  return {
    domain: 'RECOVERY',
    level: 'unavailable',
    detail: 'No recovery data — connect Oura Ring for readiness + HRV',
  };
}

function movementCoverage(d: HealthDayRecord): DomainCoverage {
  const steps = d.hkSteps ?? d.ouraSteps;
  if (steps !== undefined && d.workoutDurationMin !== undefined) {
    return { domain: 'MOVEMENT', level: 'available', detail: 'Steps + workout data' };
  }
  if (d.workoutDurationMin !== undefined) {
    return { domain: 'MOVEMENT', level: 'available', detail: 'Workout data from Apple Health' };
  }
  if (steps !== undefined) {
    return { domain: 'MOVEMENT', level: 'limited', detail: 'Steps only (no workout sessions)' };
  }
  return { domain: 'MOVEMENT', level: 'unavailable', detail: 'No movement data' };
}

function nutritionCoverage(d: HealthDayRecord): DomainCoverage {
  if (d.calories !== undefined && d.protein !== undefined) {
    return { domain: 'NUTRITION', level: 'available', detail: 'Calories + macros logged' };
  }
  if (d.calories !== undefined) {
    return { domain: 'NUTRITION', level: 'limited', detail: 'Calories only (no macro breakdown)' };
  }
  if (d.waterOz !== undefined) {
    return { domain: 'NUTRITION', level: 'limited', detail: 'Water intake only' };
  }
  return { domain: 'NUTRITION', level: 'unavailable', detail: 'No nutrition data' };
}

function lifeContextCoverage(d: HealthDayRecord): DomainCoverage {
  const hasContextEvents = (d.activeContextTypes?.length ?? 0) > 0;
  const hasBehaviorLogs  =
    d.totalAlcoholDrinks  !== undefined ||
    d.caffeineMg          !== undefined ||
    d.hasSaunaSession     !== undefined ||
    d.hasColdPlungeSession !== undefined ||
    d.hasWellnessClass    !== undefined ||
    d.gratitudeSessions   !== undefined ||
    d.electrolytesLogged  !== undefined;

  if (hasContextEvents && hasBehaviorLogs) {
    return { domain: 'LIFE_CONTEXT', level: 'available', detail: 'Context events + behavior logs' };
  }
  if (hasContextEvents) {
    return { domain: 'LIFE_CONTEXT', level: 'available', detail: 'Active context events' };
  }
  if (hasBehaviorLogs) {
    return { domain: 'LIFE_CONTEXT', level: 'limited', detail: 'Behavior logs (drink/caffeine/wellness)' };
  }
  return { domain: 'LIFE_CONTEXT', level: 'unavailable', detail: 'No life context logged' };
}

// ─── computeCoverage ───────────────────────────────────────────────────────────

/** Compute coverage for a single HealthDayRecord */
export function computeCoverage(day: HealthDayRecord): CoverageReport {
  const domains = [
    sleepCoverage(day),
    recoveryCoverage(day),
    movementCoverage(day),
    nutritionCoverage(day),
    lifeContextCoverage(day),
  ];

  const hasAnyData        = domains.some((d) => d.level !== 'unavailable');
  const canAnalyzeRecovery =
    domains.find((d) => d.domain === 'SLEEP')!.level     !== 'unavailable' &&
    domains.find((d) => d.domain === 'RECOVERY')!.level  !== 'unavailable';
  const canAnalyzeMovement =
    domains.find((d) => d.domain === 'MOVEMENT')!.level !== 'unavailable';

  return { domains, hasAnyData, canAnalyzeRecovery, canAnalyzeMovement };
}

// ─── computeCoverageForDisplay ─────────────────────────────────────────────────

/**
 * Coverage report for the "Your Picture" UI.
 *
 * SLEEP, RECOVERY, LIFE_CONTEXT: per-day (today's record) — these are daily readings
 * that meaningfully reflect today's status.
 *
 * MOVEMENT, NUTRITION: timeline-level typical coverage — the user doesn't work out
 * every day, so "today has no workout" must not report Movement as Limited or Unavailable
 * when 30 days of workout history exists.
 *
 * This separation ensures coverage represents data availability for analysis,
 * not just whether the user happened to exercise today.
 */
export function computeCoverageForDisplay(
  today: HealthDayRecord,
  timeline: HealthDayRecord[],
  recentContextEventCount = 0,
): CoverageReport {
  const todayCoverage     = computeCoverage(today);
  const timelineSummary   = summarizeTimelineCoverage(timeline);

  const domains: DomainCoverage[] = todayCoverage.domains.map((d) => {
    if (d.domain === 'LIFE_CONTEXT' && recentContextEventCount > 0) {
      return {
        domain: 'LIFE_CONTEXT' as const,
        level: 'available' as const,
        detail: `${recentContextEventCount} life context event${recentContextEventCount > 1 ? 's' : ''} logged recently`,
      };
    }
    if (d.domain === 'MOVEMENT') {
      const counts = timelineSummary.domainDayCounts['MOVEMENT'];
      // Presence-based: ANY day with movement data means movement is connected.
      // Majority vote fails real users who work out 3x/week — on rest days the
      // movement signal is absent, so unavailable days outvote available ones.
      const level: CoverageLevel =
        counts.available > 0 ? 'available' :
        counts.limited   > 0 ? 'limited'   : 'unavailable';
      const detail =
        level === 'available' ? `${counts.available} days with movement data in the last ${timelineSummary.totalDays} days` :
        level === 'limited'   ? `Step data tracked (${counts.limited} days); no workout sessions found` :
                                'No movement data in the last 30 days';
      return { domain: 'MOVEMENT' as const, level, detail };
    }
    if (d.domain === 'NUTRITION') {
      const level  = timelineSummary.typicalCoverage['NUTRITION'];
      const counts = timelineSummary.domainDayCounts['NUTRITION'];
      const detail =
        level === 'available' ? `${counts.available} days with nutrition data logged` :
        level === 'limited'   ? 'Partial nutrition data logged' :
                                'No nutrition data logged';
      return { domain: 'NUTRITION' as const, level, detail };
    }
    return d;
  });

  const hasAnyData         = domains.some((d) => d.level !== 'unavailable');
  const canAnalyzeRecovery =
    domains.find((d) => d.domain === 'SLEEP')!.level    !== 'unavailable' &&
    domains.find((d) => d.domain === 'RECOVERY')!.level !== 'unavailable';
  const canAnalyzeMovement =
    domains.find((d) => d.domain === 'MOVEMENT')!.level !== 'unavailable';

  return { domains, hasAnyData, canAnalyzeRecovery, canAnalyzeMovement };
}

// ─── summarizeTimelineCoverage ─────────────────────────────────────────────────

export interface TimelineCoverageSummary {
  totalDays: number;
  domainDayCounts: Record<CoverageDomain, { available: number; limited: number; unavailable: number }>;
  /**
   * For each domain: the typical (modal) coverage level across all days.
   * Used to decide which domains to surface in the UI.
   */
  typicalCoverage: Record<CoverageDomain, CoverageLevel>;
}

/**
 * Summarize domain coverage across a whole timeline.
 * Used to determine which features to surface in the Context UI.
 */
export function summarizeTimelineCoverage(timeline: HealthDayRecord[]): TimelineCoverageSummary {
  const domains: CoverageDomain[] = ['SLEEP', 'RECOVERY', 'MOVEMENT', 'NUTRITION', 'LIFE_CONTEXT'];

  const counts = Object.fromEntries(
    domains.map((d) => [d, { available: 0, limited: 0, unavailable: 0 }])
  ) as Record<CoverageDomain, { available: number; limited: number; unavailable: number }>;

  for (const day of timeline) {
    const report = computeCoverage(day);
    for (const dc of report.domains) {
      counts[dc.domain][dc.level]++;
    }
  }

  const typicalCoverage = Object.fromEntries(
    domains.map((d) => {
      const c = counts[d];
      const level: CoverageLevel =
        c.available >= c.limited && c.available >= c.unavailable
          ? 'available'
          : c.limited >= c.unavailable
          ? 'limited'
          : 'unavailable';
      return [d, level];
    })
  ) as Record<CoverageDomain, CoverageLevel>;

  return { totalDays: timeline.length, domainDayCounts: counts, typicalCoverage };
}
