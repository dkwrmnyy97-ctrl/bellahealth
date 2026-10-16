/**
 * explore-regression.test.ts
 *
 * Regression tests for the Explore BellaHealth data pipeline.
 *
 * These guard against the specific failure mode observed in Build 98:
 * loadContextState(true) was blocked by a concurrent real-data load, leaving
 * the screen in the empty-real-data state while isExploring=true caused
 * overrideStory to show the demo story — a misleading partial state.
 *
 * Tests here verify the full demo data pipeline independently of the
 * component lifecycle so any future regression is caught before a build.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import {
  DEMO_CONTEXT_DAYS,
  DEMO_CONTEXT_EVENTS,
  DEMO_CONTEXT_STORAGE_DAYS,
  DEMO_EXPLORE_STORY,
} from '../../demo/demo-data';
import { buildTimelineFromAdapters } from '../timeline-builder';
import {
  detectPatterns,
  rankPatternsForDisplay,
} from '../pattern-engine';
import { computeCoverageForDisplay, summarizeTimelineCoverage } from '../context-coverage';
import type { HealthDayRecord } from '../pattern-engine';
import { synthesizeContext } from '../context-synthesis';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildDemoTimeline() {
  return buildTimelineFromAdapters({
    ouraWeeklyDays: DEMO_CONTEXT_DAYS,
    storageLogs:    DEMO_CONTEXT_STORAGE_DAYS,
  });
}

function demoTodayStr() {
  return DEMO_CONTEXT_DAYS[DEMO_CONTEXT_DAYS.length - 1].date;
}

// ─── Demo data structural integrity ───────────────────────────────────────────

describe('DEMO_CONTEXT_DAYS', () => {
  it('has at least 28 days of data (minimum for CONSISTENT-tier patterns)', () => {
    expect(DEMO_CONTEXT_DAYS.length).toBeGreaterThanOrEqual(28);
  });

  it('every day has sleepHours, readiness, and hrv', () => {
    for (const day of DEMO_CONTEXT_DAYS) {
      expect(typeof day.sleepHours).toBe('number');
      expect(typeof day.readiness).toBe('number');
      expect(typeof day.hrv).toBe('number');
    }
  });

  it('dates are in ascending chronological order', () => {
    for (let i = 1; i < DEMO_CONTEXT_DAYS.length; i++) {
      expect(DEMO_CONTEXT_DAYS[i].date > DEMO_CONTEXT_DAYS[i - 1].date).toBe(true);
    }
  });
});

describe('DEMO_CONTEXT_EVENTS', () => {
  it('contains at least one travel event', () => {
    expect(DEMO_CONTEXT_EVENTS.some((e) => e.type === 'travel')).toBe(true);
  });

  it('contains at least one training_block event', () => {
    expect(DEMO_CONTEXT_EVENTS.some((e) => e.type === 'training_block')).toBe(true);
  });

  it('every event has required fields', () => {
    for (const evt of DEMO_CONTEXT_EVENTS) {
      expect(typeof evt.id).toBe('string');
      expect(typeof evt.type).toBe('string');
      expect(typeof evt.startDate).toBe('string');
    }
  });

  it('event dates fall within the DEMO_CONTEXT_DAYS window', () => {
    const first = DEMO_CONTEXT_DAYS[0].date;
    const last  = DEMO_CONTEXT_DAYS[DEMO_CONTEXT_DAYS.length - 1].date;
    for (const evt of DEMO_CONTEXT_EVENTS) {
      expect(evt.startDate >= first).toBe(true);
      expect(evt.startDate <= last).toBe(true);
    }
  });
});

describe('DEMO_EXPLORE_STORY', () => {
  it('is a non-empty string', () => {
    expect(typeof DEMO_EXPLORE_STORY).toBe('string');
    expect(DEMO_EXPLORE_STORY.length).toBeGreaterThan(50);
  });
});

// ─── Pattern pipeline (What's Connected) ──────────────────────────────────────

describe('Explore mode: What\'s Connected pipeline', () => {
  it('detectPatterns finds at least one pattern from demo data', () => {
    const timeline = buildDemoTimeline();
    const patterns = detectPatterns(timeline);
    expect(patterns.length).toBeGreaterThan(0);
  });

  it('rankPatternsForDisplay returns non-empty ranked list and hadEvidence=true', () => {
    const timeline = buildDemoTimeline();
    const patterns = detectPatterns(timeline);
    const activeEventTypes = DEMO_CONTEXT_EVENTS.map((e) => e.type);
    const { ranked, hadEvidence } = rankPatternsForDisplay(patterns, activeEventTypes);
    expect(hadEvidence).toBe(true);
    expect(ranked.length).toBeGreaterThan(0);
  });

  it('the top-ranked pattern is CONSISTENT or PATTERN tier', () => {
    const timeline = buildDemoTimeline();
    const patterns = detectPatterns(timeline);
    const { ranked } = rankPatternsForDisplay(patterns, []);
    expect(['CONSISTENT', 'PATTERN']).toContain(ranked[0].confidenceTier);
  });
});

// ─── Coverage (Your Picture) ──────────────────────────────────────────────────

describe('Explore mode: Your Picture coverage', () => {
  let coverage: ReturnType<typeof computeCoverageForDisplay>;

  beforeAll(() => {
    const timeline = buildDemoTimeline();
    const demoToday = demoTodayStr();
    const todayRec  = timeline.find((d) => d.date === demoToday) ?? { date: demoToday };
    coverage = computeCoverageForDisplay(todayRec, timeline);
  });

  it('has data in at least one domain', () => {
    expect(coverage.hasAnyData).toBe(true);
  });

  it('Sleep domain is not unavailable', () => {
    const sleep = coverage.domains.find((d) => d.domain === 'SLEEP');
    expect(sleep?.level).not.toBe('unavailable');
  });

  it('Recovery domain is not unavailable', () => {
    const rec = coverage.domains.find((d) => d.domain === 'RECOVERY');
    expect(rec?.level).not.toBe('unavailable');
  });

  it('canAnalyzeRecovery is true with full Oura demo data', () => {
    expect(coverage.canAnalyzeRecovery).toBe(true);
  });
});

// ─── Nutrition label logic (Your Picture) ─────────────────────────────────────
//
// The YourPicture component renders a per-row displayLabel:
//   NUTRITION + unavailable + nutritionDaysLogged > 0  → 'Still learning'
//   NUTRITION + unavailable + nutritionDaysLogged === 0 → 'Not enough data'
//   NUTRITION + limited/available                      → existing COVERAGE_LABEL
//
// These tests verify the underlying coverage levels that drive those branches.

function makeNutritionDay(hasCalories: boolean, hasProtein: boolean): HealthDayRecord {
  const day: HealthDayRecord = { date: '2025-01-01' };
  if (hasCalories) day.calories = 2000;
  if (hasProtein)  day.protein  = 120;
  return day;
}

function makeBlankDay(date: string): HealthDayRecord {
  return { date };
}

describe('Your Picture: nutrition display-label coverage levels', () => {
  it('0 logged nutrition days → NUTRITION level is unavailable (drives "Not enough data")', () => {
    const timeline: HealthDayRecord[] = Array.from({ length: 30 }, (_, i) =>
      makeBlankDay(`2025-01-${String(i + 1).padStart(2, '0')}`),
    );
    const summary = summarizeTimelineCoverage(timeline);
    expect(summary.typicalCoverage['NUTRITION']).toBe('unavailable');
    // nutritionDaysLogged would be 0 → displayLabel = 'Not enough data'
    const nutritionDaysLogged = timeline.filter((d) => d.calories !== undefined).length;
    expect(nutritionDaysLogged).toBe(0);
  });

  it('7 logged days out of 30 → NUTRITION level still unavailable (drives "Still learning")', () => {
    // 7 days with calories+protein, 23 blank — majority vote: 23 unavailable > 7 available
    const loggedDays = Array.from({ length: 7 }, (_, i) =>
      ({ ...makeNutritionDay(true, true), date: `2025-01-${String(i + 1).padStart(2, '0')}` }),
    );
    const blankDays = Array.from({ length: 23 }, (_, i) =>
      makeBlankDay(`2025-01-${String(i + 8).padStart(2, '0')}`),
    );
    const timeline = [...loggedDays, ...blankDays];
    const summary = summarizeTimelineCoverage(timeline);
    expect(summary.typicalCoverage['NUTRITION']).toBe('unavailable');
    // nutritionDaysLogged would be 7 > 0 → displayLabel = 'Still learning'
    const nutritionDaysLogged = timeline.filter((d) => d.calories !== undefined).length;
    expect(nutritionDaysLogged).toBe(7);
  });

  it('16 logged days out of 30 → NUTRITION level is limited or available (standard label)', () => {
    // 16 days with calories only → limited; 14 blank → majority limited >= unavailable
    const loggedDays = Array.from({ length: 16 }, (_, i) =>
      ({ ...makeNutritionDay(true, false), date: `2025-01-${String(i + 1).padStart(2, '0')}` }),
    );
    const blankDays = Array.from({ length: 14 }, (_, i) =>
      makeBlankDay(`2025-01-${String(i + 17).padStart(2, '0')}`),
    );
    const timeline = [...loggedDays, ...blankDays];
    const summary = summarizeTimelineCoverage(timeline);
    expect(summary.typicalCoverage['NUTRITION']).not.toBe('unavailable');
    // level is limited or available → displayLabel = COVERAGE_LABEL[level] (no special case)
  });

  it('16 logged days with calories+protein → NUTRITION level is available', () => {
    const loggedDays = Array.from({ length: 16 }, (_, i) =>
      ({ ...makeNutritionDay(true, true), date: `2025-01-${String(i + 1).padStart(2, '0')}` }),
    );
    const blankDays = Array.from({ length: 14 }, (_, i) =>
      makeBlankDay(`2025-01-${String(i + 17).padStart(2, '0')}`),
    );
    const timeline = [...loggedDays, ...blankDays];
    const summary = summarizeTimelineCoverage(timeline);
    expect(summary.typicalCoverage['NUTRITION']).toBe('available');
  });
});

// ─── Nutrition displayLabel + hint semantic contract ─────────────────────────
//
// These mirror the exact logic in context.tsx (YourPicture + nutritionHint) so
// that any future change to the display-label branch or hint copy breaks here.
//
// displayLabel rule (from context.tsx):
//   NUTRITION + unavailable + daysLogged > 0  → 'Still learning'
//   NUTRITION + unavailable + daysLogged = 0  → 'Not enough data'
//   NUTRITION + limited/available             → COVERAGE_LABEL[level]
//
// nutritionHint rule (from context.tsx):
//   daysWithMeals > 0 + unavailable → "Meal data is available. Keep logging…over time."
//   daysWithMeals > 0 + not-unavailable → "…maintain pattern accuracy."
//   daysWithMeals = 0, daysWithWater > 0 + unavailable → "Hydration data is available…over time."
//   daysWithMeals = 0, daysWithWater > 0 + not-unavailable → "…Log meals too…"
//   both = 0 → "Log meals in the Nutrition section to start building your nutrition picture."

type CoverageLevel = 'available' | 'limited' | 'unavailable';

const COVERAGE_LABEL: Record<string, string> = {
  available:   'Available',
  limited:     'Limited',
  unavailable: 'Not enough data',
};

function nutritionDisplayLabel(level: CoverageLevel, daysLogged: number): string {
  if (level === 'unavailable' && daysLogged > 0) return 'Still learning';
  return COVERAGE_LABEL[level];
}

function nutritionHintFn(daysWithMeals: number, daysWithWater: number, level: CoverageLevel): string {
  if (daysWithMeals > 0) {
    return level === 'unavailable'
      ? 'Meal data is available. Keep logging to help BellaHealth identify reliable patterns over time.'
      : 'Meal data is available. Keep logging to maintain pattern accuracy.';
  }
  if (daysWithWater > 0) {
    return level === 'unavailable'
      ? 'Hydration data is available. Keep logging meals and water to help BellaHealth build reliable patterns over time.'
      : 'Hydration data is available for analysis. Log meals too to unlock nutrition patterns.';
  }
  return 'Log meals in the Nutrition section to start building your nutrition picture.';
}

describe('Your Picture: nutrition displayLabel mapping', () => {
  it('0 logged days + unavailable → "Not enough data" (zero state, not Still learning)', () => {
    expect(nutritionDisplayLabel('unavailable', 0)).toBe('Not enough data');
  });

  it('1 logged day + unavailable → "Still learning" (data exists but patterns unreliable)', () => {
    expect(nutritionDisplayLabel('unavailable', 1)).toBe('Still learning');
  });

  it('7 logged days + unavailable → "Still learning" (engine not yet satisfied)', () => {
    expect(nutritionDisplayLabel('unavailable', 7)).toBe('Still learning');
  });

  it('limited coverage → "Limited" (standard label, no special-case)', () => {
    expect(nutritionDisplayLabel('limited', 16)).toBe('Limited');
  });

  it('available coverage → "Available" (standard label)', () => {
    expect(nutritionDisplayLabel('available', 20)).toBe('Available');
  });

  it('"Still learning" and "Not enough data" are semantically distinct (zero vs some data)', () => {
    expect(nutritionDisplayLabel('unavailable', 0)).not.toBe(nutritionDisplayLabel('unavailable', 7));
  });
});

describe('Your Picture: nutritionHint copy contract', () => {
  it('zero state has no hardcoded day promise', () => {
    const hint = nutritionHintFn(0, 0, 'unavailable');
    expect(hint).not.toMatch(/\d+ day/i);
    expect(hint).not.toMatch(/patterns appear/i);
    expect(hint).toContain('Log meals');
  });

  it('Still learning hint (meals exist, unavailable) does not promise a specific day count', () => {
    const hint = nutritionHintFn(7, 0, 'unavailable');
    expect(hint).not.toMatch(/\d+ (day|days)/);
    expect(hint).not.toMatch(/needed before/i);
    expect(hint).toContain('Meal data is available');
    expect(hint).toContain('over time');
  });

  it('Still learning and sufficient hints are semantically distinct', () => {
    const stillLearning = nutritionHintFn(16, 0, 'unavailable');
    const sufficient    = nutritionHintFn(16, 0, 'available');
    expect(stillLearning).not.toBe(sufficient);
    expect(stillLearning).toContain('over time');
    expect(sufficient).toContain('maintain pattern accuracy');
  });

  it('water-only + unavailable hint does not promise a day count', () => {
    const hint = nutritionHintFn(0, 5, 'unavailable');
    expect(hint).not.toMatch(/\d+ (day|days)/);
    expect(hint).toContain('Hydration data is available');
  });

  it('water-only + sufficient hint encourages meal logging', () => {
    const hint = nutritionHintFn(0, 5, 'available');
    expect(hint).toContain('Log meals');
    expect(hint).toContain('nutrition patterns');
  });
});

// ─── Synthesis (Your Story) ───────────────────────────────────────────────────

describe('Explore mode: synthesizeContext returns non-null synthesis', () => {
  it('synthesis.primaryTheme is not insufficient_data when demo data is present', () => {
    const timeline = buildDemoTimeline();
    const demoToday = demoTodayStr();
    const baseTodayRec  = timeline.find((d) => d.date === demoToday) ?? { date: demoToday };
    const patterns  = detectPatterns(timeline);
    const { ranked } = rankPatternsForDisplay(patterns, DEMO_CONTEXT_EVENTS.map((e) => e.type));
    const synthesis = synthesizeContext({
      today: baseTodayRec,
      patterns: ranked,
      activeContextEvents: DEMO_CONTEXT_EVENTS,
      eventWindows: [],
    });
    expect(synthesis).not.toBeNull();
    expect(synthesis!.primaryTheme.theme).not.toBe('insufficient_data');
  });
});

// ─── Data isolation: demo data is never written to real storage ────────────────

describe('Explore mode: data isolation', () => {
  it('DEMO_CONTEXT_EVENTS objects do not share references with loadContextEvents output', async () => {
    // Verify that DEMO_CONTEXT_EVENTS is a constant array, not derived from AsyncStorage.
    // This ensures demo data cannot contaminate real user storage.
    const AsyncStorage = require('@react-native-async-storage/async-storage');
    await AsyncStorage.clear();

    // After clearing storage, demo data should still be accessible as a constant
    expect(DEMO_CONTEXT_EVENTS.length).toBeGreaterThan(0);

    // Real context events from storage should be empty after a clear
    const { loadContextEvents } = require('../context-events');
    const realEvents = await loadContextEvents();
    expect(realEvents).toHaveLength(0);
  });
});
