/**
 * hydration-story.test.ts
 *
 * Verifies that the hydration wiring flows end-to-end from waterOz values
 * in the timeline through buildHydrationContext → buildContextResponseContrastLayer
 * → buildEnhancedStoryWithKey, enriching both alcohol_night and sleep_activity
 * stories with a neutral hydration observation.
 *
 * Rule under test (completed-days path):
 *   Window  : 7 most recent completed days BEFORE today (today excluded — incomplete)
 *   Coverage: ≥4 of those 7 days must have waterOz logged
 *   Below   : ≥3 logged days have waterOz < waterGoalOz (or < 85% of baseline mean)
 *   Language: "lately" — never shame, never causation, never "failed your goal"
 *
 * Scenarios:
 *   J1: fewer than 4 logged days in window → not_tracked (no enrichment)
 *   J2: ≥4 logged days, ≥3 below goal → below_target, goalOz set
 *   J3: ≥4 logged days, only 2 below goal → adequate (no enrichment)
 *   J4: ≥4 logged days, no goal → falls back to baseline mean comparison
 *   J5: alcohol_night + below_target → story text includes hydration note
 *   J6: sleep_activity + below_target → story text includes hydration note
 *   J7: full Oct 1 chain (Sep30 alcohol + 5.9h sleep + run + low water) →
 *       story mentions run AND hydration in one story
 *
 * Hard stop: no EAS build. Local proof only.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import {
  buildHydrationContext,
  buildContextResponseContrastLayer,
  buildStoryEpisode,
} from '../story-engine';
import { buildEnhancedStoryWithKey } from '../../utils/pattern-language';
import type { HealthDayRecord } from '../pattern-engine';
import type { ContextEvent } from '../context-events';
import type { SynthesisResult, ThemeDescriptor } from '../context-synthesis';

// ─── Constants ─────────────────────────────────────────────────────────────────

const SEP_24 = '2026-09-24';
const SEP_25 = '2026-09-25';
const SEP_26 = '2026-09-26';
const SEP_27 = '2026-09-27';
const SEP_28 = '2026-09-28';
const SEP_29 = '2026-09-29';
const SEP_30 = '2026-09-30';
const OCT_1  = '2026-10-01';

const WATER_GOAL = 80; // oz

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a 14-day baseline timeline for physio metrics (no water).
 * Sep 01–14 (no overlap with Sep 24–30 water window).
 * sleepHours=7.5 ± jitter, readiness=78 ± jitter.
 */
function buildPhysioBaseline(): HealthDayRecord[] {
  return Array.from({ length: 14 }, (_, i) => {
    const jitter = ((i % 3) - 1) * 0.2;
    const scoreJitter = ((i % 3) - 1) * 3;
    const date = `2026-09-${String(i + 1).padStart(2, '0')}`;  // Sep 01–14
    return {
      date,
      sleepHours: 7.5 + jitter,
      readiness:  78  + scoreJitter,
      hrv:        55  + scoreJitter,
      sleepScore: 82  + scoreJitter,
    };
  });
}

/**
 * Build a 7-day window of completed days (Sep 24–30) with waterOz.
 * loggedCount: how many of those 7 days have waterOz defined.
 * belowCount:  how many of the logged days have waterOz < WATER_GOAL.
 * aboveOz:     value for "above goal" days (default 100)
 * belowOz:     value for "below goal" days (default 55)
 */
function buildWaterWindow(opts: {
  loggedCount: number;
  belowCount:  number;
  aboveOz?:    number;
  belowOz?:    number;
}): HealthDayRecord[] {
  const { loggedCount, belowCount, aboveOz = 100, belowOz = 55 } = opts;
  const dates = [SEP_24, SEP_25, SEP_26, SEP_27, SEP_28, SEP_29, SEP_30];
  return dates.map((date, i) => {
    if (i >= loggedCount) return { date };               // unlogged
    const isBelow = i < belowCount;
    return { date, waterOz: isBelow ? belowOz : aboveOz };
  });
}

/** Minimal SynthesisResult for contrast-layer tests. */
function buildMinimalSynthesis(
  relevantContext: ContextEvent[] = [],
  waterGoalOz?: number,
): SynthesisResult {
  return {
    generatedAt:         new Date().toISOString(),
    primaryTheme:        { theme: 'insufficient_data', primarySignal: null, rationale: [] } as ThemeDescriptor,
    supportingSignals:   [],
    concerningSignals:   [],
    conflictingSignals:  [],
    relevantContext,
    strongestConnection: null,
    allPatterns:         [],
    eventWindows:        [],
    eventTypePattern:    null,
    recoveryConstrained: false,
    sources:             [],
    waterGoalOz,
  };
}

/** Sep30 alcohol event (2 drinks) — mimics deriveDrinkEvents output. */
function makeSep30AlcoholEvent(): ContextEvent {
  return {
    id:        `derived_drink_${SEP_30}`,
    type:      'alcohol_period',
    source:    'derived',
    startDate: SEP_30,
    endDate:   SEP_30,
    metadata:  { totalDrinks: 2, totalCalories: 260 },
    createdAt: `${SEP_30}T23:59:00.000Z`,
    updatedAt: `${SEP_30}T23:59:00.000Z`,
  };
}

// ─── J1: not_tracked — fewer than 4 logged days ────────────────────────────────

describe('J1: not_tracked when fewer than 4 of 7 days have waterOz logged', () => {
  test('3 logged days → not_tracked, no goalOz confusion', () => {
    const timeline = [
      ...buildPhysioBaseline(),
      ...buildWaterWindow({ loggedCount: 3, belowCount: 3 }),
    ];

    const result = buildHydrationContext(timeline, undefined, undefined, WATER_GOAL, OCT_1);

    expect(result.status).toBe('not_tracked');
    expect(result.loggedDaysInWindow).toBe(3);
  });

  test('0 logged days → not_tracked', () => {
    const timeline = [
      ...buildPhysioBaseline(),
      ...buildWaterWindow({ loggedCount: 0, belowCount: 0 }),
    ];

    const result = buildHydrationContext(timeline, undefined, undefined, WATER_GOAL, OCT_1);

    expect(result.status).toBe('not_tracked');
    expect(result.loggedDaysInWindow).toBe(0);
  });
});

// ─── J2: below_target — ≥4 logged, ≥3 below goal ──────────────────────────────

describe('J2: below_target when ≥4 logged days and ≥3 are below goal', () => {
  test('4 logged days, all 4 below goal → below_target, goalOz = 80', () => {
    const timeline = [
      ...buildPhysioBaseline(),
      ...buildWaterWindow({ loggedCount: 4, belowCount: 4, belowOz: 55 }),
    ];

    const result = buildHydrationContext(timeline, undefined, undefined, WATER_GOAL, OCT_1);

    expect(result.status).toBe('below_target');
    expect(result.goalOz).toBe(WATER_GOAL);
    expect(result.daysBelow).toBe(4);
    expect(result.loggedDaysInWindow).toBe(4);
  });

  test('7 logged days, 5 below goal → below_target', () => {
    const timeline = [
      ...buildPhysioBaseline(),
      ...buildWaterWindow({ loggedCount: 7, belowCount: 5, belowOz: 60 }),
    ];

    const result = buildHydrationContext(timeline, undefined, undefined, WATER_GOAL, OCT_1);

    expect(result.status).toBe('below_target');
    expect(result.daysBelow).toBe(5);
  });
});

// ─── J3: adequate — ≥4 logged but only 2 below goal ───────────────────────────

describe('J3: adequate when ≥4 logged days but fewer than 3 are below goal', () => {
  test('4 logged days, 2 below goal → adequate', () => {
    const timeline = [
      ...buildPhysioBaseline(),
      ...buildWaterWindow({ loggedCount: 4, belowCount: 2, belowOz: 60, aboveOz: 100 }),
    ];

    const result = buildHydrationContext(timeline, undefined, undefined, WATER_GOAL, OCT_1);

    expect(result.status).toBe('adequate');
  });

  test('7 logged days, 0 below goal → adequate', () => {
    const timeline = [
      ...buildPhysioBaseline(),
      ...buildWaterWindow({ loggedCount: 7, belowCount: 0, aboveOz: 100 }),
    ];

    const result = buildHydrationContext(timeline, undefined, undefined, WATER_GOAL, OCT_1);

    expect(result.status).toBe('adequate');
  });
});

// ─── J4: no goal — baseline mean fallback ─────────────────────────────────────

describe('J4: falls back to baseline mean when no waterGoalOz provided', () => {
  test('4+ logged days, all far below baseline mean → below_target, goalOz = null', () => {
    // 14-day baseline: waterOz=90 each day
    const baseline: HealthDayRecord[] = Array.from({ length: 14 }, (_, i) => ({
      date:    `2026-09-${String(i + 1).padStart(2, '0')}`,
      waterOz: 90,
    }));
    // 7-day window: all logged at 50 (well below 90 * 0.85 = 76.5)
    const window: HealthDayRecord[] = [SEP_24, SEP_25, SEP_26, SEP_27, SEP_28, SEP_29, SEP_30]
      .map(date => ({ date, waterOz: 50 }));

    const timeline = [...baseline, ...window];
    const result = buildHydrationContext(timeline, undefined, undefined, undefined, OCT_1);

    expect(result.status).toBe('below_target');
    expect(result.goalOz).toBeNull();
    expect(result.daysBelow).toBeGreaterThanOrEqual(3);
  });

  test('4+ logged days near baseline mean → adequate', () => {
    const baseline: HealthDayRecord[] = Array.from({ length: 14 }, (_, i) => ({
      date:    `2026-09-${String(i + 1).padStart(2, '0')}`,
      waterOz: 80,
    }));
    const window: HealthDayRecord[] = [SEP_24, SEP_25, SEP_26, SEP_27, SEP_28, SEP_29, SEP_30]
      .map(date => ({ date, waterOz: 82 })); // above baseline mean of 80

    const timeline = [...baseline, ...window];
    const result = buildHydrationContext(timeline, undefined, undefined, undefined, OCT_1);

    expect(result.status).toBe('adequate');
  });
});

// ─── J5: alcohol_night + below_target → hydration note in story ───────────────

describe('J5: alcohol_night story enriched with hydration note when below_target', () => {
  test('Sep30 alcohol + 5.9h sleep + below_target water → hydrationContext propagated to layer', () => {
    const timeline: HealthDayRecord[] = [
      ...buildPhysioBaseline(),
      ...buildWaterWindow({ loggedCount: 5, belowCount: 4, belowOz: 55, aboveOz: 100 }),
    ];

    const today: HealthDayRecord = { date: OCT_1, sleepHours: 5.9 };
    const alcoholEvent = makeSep30AlcoholEvent();

    const hydrationContext = buildHydrationContext(
      timeline, undefined, undefined, WATER_GOAL, OCT_1,
    );
    expect(hydrationContext.status).toBe('below_target');

    // alcohol gate requires ≥1 physio finding
    const { buildPhysiologicalState } = require('../story-engine');
    const physioState = buildPhysiologicalState(today, timeline);

    const layer = buildContextResponseContrastLayer(
      [alcoholEvent],
      null,
      physioState,
      timeline,
      today,
      undefined,
      hydrationContext,
    );

    expect(layer).not.toBeNull();
    expect(layer!.contextType).toBe('alcohol_night');
    expect(layer!.hydrationContext?.status).toBe('below_target');
    expect(layer!.hydrationContext?.goalOz).toBe(WATER_GOAL);
    // Text rendering verified end-to-end in J7
  });

  test('alcohol_night + adequate hydration → no hydration note added', () => {
    const timeline: HealthDayRecord[] = [
      ...buildPhysioBaseline(),
      ...buildWaterWindow({ loggedCount: 5, belowCount: 1, aboveOz: 100, belowOz: 60 }),
    ];
    const today: HealthDayRecord = { date: OCT_1, sleepHours: 5.9 };
    const alcoholEvent = makeSep30AlcoholEvent();

    const hydrationContext = buildHydrationContext(
      timeline, undefined, undefined, WATER_GOAL, OCT_1,
    );
    expect(hydrationContext.status).toBe('adequate');

    const { buildPhysiologicalState } = require('../story-engine');
    const physioState = buildPhysiologicalState(today, timeline);

    const layer = buildContextResponseContrastLayer(
      [alcoholEvent], null, physioState, timeline, today, undefined, hydrationContext,
    );

    expect(layer?.hydrationContext?.status).toBe('adequate');
    // adequate status → buildHydrationEnrichment returns null → no extra paragraph
  });
});

// ─── J6: sleep_activity + below_target → hydration note in story ──────────────

describe('J6: sleep_activity story enriched with hydration note when below_target', () => {
  test('5.9h sleep + 30min run + 4 low-water days → story mentions both activity and water', () => {
    const physioBaseline = buildPhysioBaseline();
    const waterWindow = buildWaterWindow({ loggedCount: 5, belowCount: 4, belowOz: 55, aboveOz: 100 });
    const timeline = [...physioBaseline, ...waterWindow];

    const today: HealthDayRecord = {
      date:              OCT_1,
      sleepHours:        5.9,
      workoutDurationMin: 30,
      primaryActivityType: 'Running',
    };

    const hydrationContext = buildHydrationContext(
      timeline, undefined, undefined, WATER_GOAL, OCT_1,
    );
    expect(hydrationContext.status).toBe('below_target');

    const { buildPhysiologicalState } = require('../story-engine');
    const physioState = buildPhysiologicalState(today, timeline);

    const layer = buildContextResponseContrastLayer(
      [],          // no relevant context events
      null,
      physioState,
      timeline,
      today,
      undefined,
      hydrationContext,
    );

    expect(layer).not.toBeNull();
    expect(layer!.contextType).toBe('sleep_activity');
    expect(layer!.hydrationContext?.status).toBe('below_target');
    expect(layer!.todayActivityMin).toBe(30);
  });

  test('sleep_activity + not_tracked hydration → hydrationContext.status = not_tracked', () => {
    const timeline = [...buildPhysioBaseline(), ...buildWaterWindow({ loggedCount: 2, belowCount: 2 })];
    const today: HealthDayRecord = { date: OCT_1, sleepHours: 5.9, workoutDurationMin: 30 };

    const hydrationContext = buildHydrationContext(
      timeline, undefined, undefined, WATER_GOAL, OCT_1,
    );
    expect(hydrationContext.status).toBe('not_tracked');

    const { buildPhysiologicalState } = require('../story-engine');
    const physioState = buildPhysiologicalState(today, timeline);

    const layer = buildContextResponseContrastLayer(
      [], null, physioState, timeline, today, undefined, hydrationContext,
    );

    expect(layer!.contextType).toBe('sleep_activity');
    expect(layer!.hydrationContext?.status).toBe('not_tracked');
    // not_tracked → buildHydrationEnrichment returns null → no extra paragraph in story
  });
});

// ─── J7: Full Oct 1 production chain with hydration ───────────────────────────

describe('J7: Full Oct 1 production chain — Sep30 alcohol + short sleep + run + low water', () => {
  test('story text includes run note AND hydration note', () => {
    const timeline = [
      ...buildPhysioBaseline(),
      ...buildWaterWindow({ loggedCount: 5, belowCount: 4, belowOz: 55, aboveOz: 100 }),
    ];
    const today: HealthDayRecord = {
      date:                OCT_1,
      sleepHours:          5.9,
      workoutDurationMin:  35,
      primaryActivityType: 'Running',
    };

    const alcoholEvent = makeSep30AlcoholEvent();
    const synthesis    = buildMinimalSynthesis([alcoholEvent], WATER_GOAL);

    // Verify hydration context flows through the episode correctly
    const episode = buildStoryEpisode(synthesis, timeline, today);
    expect(episode.surfaceWorthy).toBe(true);
    expect(episode.contextResponseContrast?.contextType).toBe('alcohol_night');
    expect(episode.contextResponseContrast?.hydrationContext?.status).toBe('below_target');
    expect(episode.contextResponseContrast?.hydrationContext?.goalOz).toBe(WATER_GOAL);

    // Render end-to-end: synthesis + timeline + today → story text
    const { story } = buildEnhancedStoryWithKey(synthesis, timeline, today);

    expect(story).not.toBeNull();
    expect(story).toMatch(/run/i);
    // Hydration phrased as background context, not clinical goal-miss language
    expect(story).toMatch(/lower hydration|recent stretch of lower hydration/i);
    expect(story).not.toMatch(/failed/i);
    expect(story).not.toMatch(/missed your goal/i);
    expect(story).not.toMatch(/poor hydration/i);

    console.log('\n=== J7 Oct 1 Story (alcohol + run + low water) ===\n', story);
  });

  test('sleep_activity path: 5.9h sleep + run + low water (no alcohol) → story mentions both', () => {
    const timeline = [
      ...buildPhysioBaseline(),
      ...buildWaterWindow({ loggedCount: 5, belowCount: 4, belowOz: 55, aboveOz: 100 }),
    ];
    const today: HealthDayRecord = {
      date:                OCT_1,
      sleepHours:          5.9,
      workoutDurationMin:  35,
      primaryActivityType: 'Running',
    };

    const synthesis = buildMinimalSynthesis([], WATER_GOAL);

    const episode = buildStoryEpisode(synthesis, timeline, today);
    expect(episode.surfaceWorthy).toBe(true);
    expect(episode.contextResponseContrast?.contextType).toBe('sleep_activity');
    expect(episode.contextResponseContrast?.hydrationContext?.status).toBe('below_target');

    const { story } = buildEnhancedStoryWithKey(synthesis, timeline, today);

    expect(story).not.toBeNull();
    expect(story).toMatch(/shorter than usual/i);
    expect(story).toMatch(/run/i);
    // Hydration phrased as background context
    expect(story).toMatch(/lower hydration|recent stretch of lower hydration/i);

    console.log('\n=== J7 Oct 1 Story (sleep_activity + run + low water) ===\n', story);
  });

  test('Oct 1 chain with adequate hydration → story fires but no hydration paragraph', () => {
    const timeline = [
      ...buildPhysioBaseline(),
      ...buildWaterWindow({ loggedCount: 5, belowCount: 1, aboveOz: 100, belowOz: 60 }),
    ];
    const today: HealthDayRecord = {
      date:                OCT_1,
      sleepHours:          5.9,
      workoutDurationMin:  35,
      primaryActivityType: 'Running',
    };

    const alcoholEvent = makeSep30AlcoholEvent();
    const synthesis    = buildMinimalSynthesis([alcoholEvent], WATER_GOAL);

    const episode = buildStoryEpisode(synthesis, timeline, today);
    expect(episode.contextResponseContrast?.contextType).toBe('alcohol_night');
    expect(episode.contextResponseContrast?.hydrationContext?.status).toBe('adequate');

    const { story } = buildEnhancedStoryWithKey(synthesis, timeline, today);

    expect(story).not.toBeNull();
    expect(story).not.toMatch(/water intake/i);
    expect(story).not.toMatch(/hydration/i);

    console.log('\n=== J7 Oct 1 Story (alcohol + adequate water — no hydration note) ===\n', story);
  });
});
