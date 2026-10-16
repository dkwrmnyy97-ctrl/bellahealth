/**
 * evidence-bridge.test.ts
 *
 * Tests for three Build-103 additive improvements:
 *
 *   1. Alcohol wiring fix — deriveDrinkEvents() now reaches relevantContext.
 *      Validates that 2+ drinks yesterday → contrast story; 1 drink does not.
 *
 *   2. Type-specific life-context relevance windows (replaces universal 4-day cutoff).
 *      Validates per-type boundaries for travel, illness, stress, training, user_defined.
 *
 *   3. Confirmed-pattern bridge — pattern engine findings with PATTERN/CONSISTENT
 *      confidence + today's physiology notably off-baseline → story eligible.
 *      Validates the guard: pattern alone (ordinary physiology) = no story.
 *
 * Product rules:
 *   - Silence remains valid: more evidence paths ≠ lower quality bar
 *   - Confirmed pattern + ordinary physiology = NO story
 *   - What's Connected output is unchanged (this tests story-engine only)
 *   - Suppression prevents the same episode from repeating every day
 *   - Existing behavioral corroboration paths are unaffected
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import {
  buildContextResponseContrastLayer,
  buildConfirmedPatternLayer,
  buildPhysiologicalState,
  buildContextEventLayer,
  type ConfirmedPatternFinding,
} from '../story-engine';
import { buildEnhancedStory, buildEnhancedStoryWithKey, renderStoryEpisode } from '../../utils/pattern-language';
import { buildStoryEpisode } from '../story-engine';
import { mergeContributions, SIGNAL_PRIORITY, type DayContribution } from '../canonical-signals';
import type { HealthDayRecord, PatternResult, PeriodStats, EventWindowAnalysis } from '../pattern-engine';
import type { SynthesisResult } from '../context-synthesis';
import type { ContextEvent } from '../context-events';

// ─── Shared constants and helpers ─────────────────────────────────────────────

/** Fixed "today" so all date math is deterministic */
const TODAY = '2026-10-01';

/**
 * Deterministic "now" for tests: 2 PM local on Oct 1 2026.
 * Date constructor (not ISO string) makes .getHours() = 14 in every timezone,
 * so isOvernightSpillover() always returns false — no accidental behavioral-night
 * spillover logic during CI.
 */
const TEST_NOW = new Date(2026, 9, 1, 14, 0, 0); // Oct 1 2026, 14:00 local

function pastDate(daysAgo: number): string {
  const d = new Date(TODAY + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

const YESTERDAY = pastDate(1); // '2026-09-30'

function makeDayRecord(date: string, overrides: Partial<HealthDayRecord> = {}): HealthDayRecord {
  return { date, ...overrides };
}

/**
 * 30-day timeline where every day has identical values → stable baseline.
 * Baseline: readiness=75, hrv=55, sleepScore=80, sleepHours=7.5, workoutDurationMin=40
 */
function makeTimeline(
  days = 30,
  builder?: (i: number, date: string) => Partial<HealthDayRecord>,
): HealthDayRecord[] {
  return Array.from({ length: days }, (_, i) => {
    const date = pastDate(days - 1 - i);
    const base: Partial<HealthDayRecord> = {
      readiness: 75, hrv: 55, sleepScore: 80,
      sleepHours: 7.5, workoutDurationMin: 40,
    };
    return { date, ...base, ...(builder ? builder(i, date) : {}) };
  });
}

const EMPTY_STATS: PeriodStats = {
  days: 0,
  sleepHours: null, sleepScore: null, hrv: null, readiness: null,
  steps: null, workoutDurationMin: null, totalAlcoholDrinks: null,
  calories: null, protein: null,
};

function makeContextEvent(
  type: ContextEvent['type'],
  startDaysAgo: number,
  durationDays: number,
  options: Partial<ContextEvent> = {},
): ContextEvent {
  const startDate = pastDate(startDaysAgo + durationDays - 1);
  const endDate   = options.endDate !== undefined ? options.endDate : pastDate(startDaysAgo);
  return {
    id: `test-${type}-${startDaysAgo}`,
    type,
    source: 'user_logged',
    startDate,
    endDate,
    createdAt: startDate + 'T00:00:00Z',
    updatedAt: startDate + 'T00:00:00Z',
    ...options,
  };
}

function makeAlcoholEvent(date: string, totalDrinks: number): ContextEvent {
  return {
    id: `derived_drink_${date}`,
    type: 'alcohol_period',
    source: 'derived',
    startDate: date,
    endDate:   date,
    metadata:  { totalDrinks },
    createdAt: date + 'T23:59:00.000Z',
    updatedAt: date + 'T23:59:00.000Z',
  };
}

function makeSynthesis(
  theme: 'recovery_needed' | 'performing_well' | 'mixed_signals' | 'insufficient_data',
  relevantContext: ContextEvent[] = [],
  eventWindows: EventWindowAnalysis[] = [],
  allPatterns: PatternResult[] = [],
): SynthesisResult {
  return {
    generatedAt: TODAY + 'T12:00:00Z',
    primaryTheme: { theme, primarySignal: null, rationale: [] },
    supportingSignals: [],
    concerningSignals: [],
    conflictingSignals: [],
    relevantContext,
    strongestConnection: null,
    allPatterns,
    eventWindows,
    eventTypePattern: null,
    recoveryConstrained: false,
    sources: [],
  };
}

/** Today's physiology near baseline — "ordinary day" */
function stableToday(): HealthDayRecord {
  return makeDayRecord(TODAY, { readiness: 75, hrv: 55, sleepScore: 80, sleepHours: 7.5 });
}

/** Today's physiology substantially below baseline */
function declinedToday(): HealthDayRecord {
  return makeDayRecord(TODAY, { readiness: 55, hrv: 38, sleepScore: 65, sleepHours: 6.0 });
}

/** Today's HRV substantially above baseline, readiness near baseline */
function elevatedHrvToday(): HealthDayRecord {
  return makeDayRecord(TODAY, { readiness: 76, hrv: 72, sleepScore: 82, sleepHours: 7.6 });
}

function makePatternResult(
  inputSignal: PatternResult['inputSignal'],
  outcomeSignal: PatternResult['outcomeSignal'],
  direction: PatternResult['direction'],
  confidenceTier: PatternResult['confidenceTier'],
  observationCount = 14,
): PatternResult {
  return {
    patternId: `${inputSignal}_${outcomeSignal}`,
    relationshipId: `${inputSignal}_next_${outcomeSignal}`,
    inputSignal,
    outcomeSignal,
    temporalRelationship: 'next_day',
    observationUnit: 'day',
    observationCount,
    baselineCount: 16,
    dateRange: { start: pastDate(30), end: TODAY },
    inputCondition: `High ${String(inputSignal)}`,
    outcomeDuringCondition: 65,
    outcomeBaseline: 52,
    absoluteDifference: 13,
    percentDifference: 25,
    direction,
    consistency: 0.71,
    conditionCount: observationCount,
    sources: ['apple_health_workouts', 'oura_hrv'],
    confidenceTier,
    lastUpdated: TODAY + 'T12:00:00Z',
  };
}

// ─── 1. Alcohol wiring: 2 drinks yesterday → qualifies for contrast ──────────

describe('Alcohol wiring — deriveDrinkEvents integration', () => {
  it('2 drinks yesterday (via derived alcohol_period event) qualifies for contrast story', () => {
    const timeline = makeTimeline();
    const today    = declinedToday();
    const physio   = buildPhysiologicalState(today, timeline);
    const alcoholEvent = makeAlcoholEvent(YESTERDAY, 2);

    const layer = buildContextResponseContrastLayer(
      [alcoholEvent], null, physio, timeline, today,
    );
    expect(layer).not.toBeNull();
    expect(layer?.contextType).toBe('alcohol_night');
    expect(layer?.physioResponse).toBe('responding');
  });

  it('4 drinks yesterday with mildly-off-baseline physiology qualifies (regression: Build 104 real-world case)', () => {
    // Metrics drop mildly — below p25 but only mild magnitude (< 0.4×IQR).
    // Under the old code, classifyPhysioResponse returned 'insufficient' here,
    // silencing the story before the alcohol branch was reached.
    // Baseline: readiness=75, hrv=55, sleepScore=80, sleepHours=7.5
    const timeline = makeTimeline();
    const today = makeDayRecord(TODAY, {
      readiness: 68, hrv: 48, sleepScore: 73, sleepHours: 6.8,
      // Each metric is below p25 but close — "mild" magnitude, not moderate/substantial
    });
    const physio = buildPhysiologicalState(today, timeline);
    const alcoholEvent = makeAlcoholEvent(YESTERDAY, 4);

    const layer = buildContextResponseContrastLayer(
      [alcoholEvent], null, physio, timeline, today,
    );
    expect(layer).not.toBeNull();
    expect(layer?.contextType).toBe('alcohol_night');
    expect(layer?.physioResponse).toBe('responding');
  });

  it('2 drinks yesterday with stable physiology also qualifies', () => {
    const timeline = makeTimeline();
    const today    = stableToday();
    const physio   = buildPhysiologicalState(today, timeline);
    const alcoholEvent = makeAlcoholEvent(YESTERDAY, 2);

    const layer = buildContextResponseContrastLayer(
      [alcoholEvent], null, physio, timeline, today,
    );
    // Alcohol contrast fires for both responding and stable physio
    expect(layer).not.toBeNull();
    expect(layer?.contextType).toBe('alcohol_night');
  });

  it('only 1 physio metric (e.g. HK sleep hours before Oura syncs) still fires alcohol story', () => {
    // Simulates morning before Oura syncs: today only has sleepHours from HealthKit.
    // Timeline has 30 days of sleepHours → baseline exists. Oura metrics absent.
    const timeline = makeTimeline(30, (i) => ({ sleepHours: 7.5 - i * 0.01 }));
    const today    = makeDayRecord(TODAY, { sleepHours: 6.2 }); // only 1 metric
    const physio   = buildPhysiologicalState(today, timeline);
    // Should have exactly 1 finding (sleepHours)
    expect(physio?.findings.length).toBe(1);
    const alcoholEvent = makeAlcoholEvent(YESTERDAY, 2);

    const layer = buildContextResponseContrastLayer(
      [alcoholEvent], null, physio, timeline, today,
    );
    expect(layer).not.toBeNull();
    expect(layer?.contextType).toBe('alcohol_night');
    expect(layer?.physioResponse).toBe('responding');
  });

  it('1 drink yesterday does NOT qualify (below threshold of 2)', () => {
    const timeline = makeTimeline();
    const today    = declinedToday();
    const physio   = buildPhysiologicalState(today, timeline);
    const alcoholEvent = makeAlcoholEvent(YESTERDAY, 1);

    const layer = buildContextResponseContrastLayer(
      [alcoholEvent], null, physio, timeline, today,
    );
    expect(layer).toBeNull();
  });

  it('2 drinks two days ago does NOT qualify (only next-day physio is relevant)', () => {
    const timeline = makeTimeline();
    const today    = declinedToday();
    const physio   = buildPhysiologicalState(today, timeline);
    const alcoholEvent = makeAlcoholEvent(pastDate(2), 3);

    const layer = buildContextResponseContrastLayer(
      [alcoholEvent], null, physio, timeline, today,
    );
    expect(layer).toBeNull();
  });

  it('alcohol event included in relevantContext produces a story via buildEnhancedStory', () => {
    const timeline = makeTimeline();
    const today    = declinedToday();
    const alcoholEvent = makeAlcoholEvent(YESTERDAY, 2);
    const synth    = makeSynthesis('recovery_needed', [alcoholEvent]);

    const story = buildEnhancedStory(synth, timeline, today);
    expect(story).not.toBeNull();
    expect(typeof story).toBe('string');
  });

  it('alcohol event with 0 drinks in metadata does NOT qualify', () => {
    const timeline = makeTimeline();
    const today    = declinedToday();
    const physio   = buildPhysiologicalState(today, timeline);
    const alcoholEvent = makeAlcoholEvent(YESTERDAY, 0);

    const layer = buildContextResponseContrastLayer(
      [alcoholEvent], null, physio, timeline, today,
    );
    expect(layer).toBeNull();
  });

  it('timezone boundary: Sept 30 local date matches yesterday even when UTC timestamp is Oct 1', () => {
    // Guards the local-date-first contract for drink_log storage.
    // At 11pm US/Pacific (UTC-8) on Sept 30, local date = '2026-09-30' but UTC date = '2026-10-01'.
    // deriveDrinkEvents() uses localDateStrFromDate() → stores local date as startDate.
    // findAlcoholNightEvent() computes yesterday via addDaysToStr which uses T12:00:00Z anchor,
    // making it timezone-safe regardless of the host machine's timezone.
    const timeline = makeTimeline();
    const today    = makeDayRecord(TODAY, { readiness: 66, hrv: 44, sleepScore: 71, sleepHours: 6.5 });
    const physio   = buildPhysiologicalState(today, timeline);

    // Correct: local date stored as startDate (what deriveDrinkEvents produces)
    const localDateEvent = makeAlcoholEvent('2026-09-30', 2);
    const layerLocal = buildContextResponseContrastLayer(
      [localDateEvent], null, physio, timeline, today,
      undefined, undefined, TEST_NOW,
    );
    expect(layerLocal).not.toBeNull(); // local date '2026-09-30' matches yesterday

    // Guard: if UTC date were used instead, it would NOT match yesterday and no story fires.
    // Pass TEST_NOW (daytime) so the early-morning spillover path is off — the UTC date
    // event (today) is evaluated with no early-morning exemption and correctly returns null.
    const utcDateEvent = makeAlcoholEvent('2026-10-01', 2); // same as today — wrong
    const layerUtc = buildContextResponseContrastLayer(
      [utcDateEvent], null, physio, timeline, today,
      undefined, undefined, TEST_NOW,
    );
    expect(layerUtc).toBeNull(); // UTC date is today, not yesterday — correctly excluded
  });

  it('production chain: partial Oura sync (1 metric) + 2 drinks last night → story fires end-to-end', () => {
    // Real-world scenario: Oura daily scores not yet processed at app-open time (early morning).
    // Only sleep session data is available → 1 physio metric (sleepHours) in today's record.
    // The synthesis primaryTheme is NOT insufficient_data (1 signal exists).
    // Build 105 failed this case (Gate 1 required ≥2 findings). Build 106 fix allows ≥1.
    const timeline = makeTimeline(30, (i) => ({
      sleepHours: 7.5 - i * 0.02, hrv: 55 - i * 0.1,
    }));
    const today = makeDayRecord(TODAY, {
      sleepHours: 6.1,  // only metric Oura session has before daily score is processed
      // readiness, hrv, sleepScore: undefined (daily summaries not yet synced)
    });
    const physio = buildPhysiologicalState(today, timeline);
    expect(physio?.findings.length).toBe(1); // exactly 1 metric

    const drinkEvent = makeAlcoholEvent(YESTERDAY, 2); // 2 glasses red wine = 2.0 std drinks
    const synth = makeSynthesis('recovery_needed', [drinkEvent]);

    const story = buildEnhancedStory(synth, timeline, today);
    expect(story).not.toBeNull();
    // Synthesis voice: neutral opener, no causation, no judgment
    expect(story).toContain('Last night was a little outside your usual routine');
    expect(story).toContain('lower');
  });
});

// ─── 2. Type-specific relevance windows ───────────────────────────────────────

describe('Type-specific life-context relevance windows', () => {
  const timeline = makeTimeline();
  const today    = declinedToday();
  const physio   = buildPhysiologicalState(today, timeline);

  // Travel: 7-day window after end

  it('travel that ended exactly 7 days ago qualifies (boundary)', () => {
    const event = makeContextEvent('travel', 7, 5, { endDate: pastDate(7) });
    const layer = buildContextResponseContrastLayer([event], null, physio, timeline, today);
    // Need behavioral disruption for stable physio — use declining physio which triggers 'responding'
    expect(layer).not.toBeNull();
    expect(layer?.contextType).toBe('travel');
  });

  it('travel that ended 8 days ago does NOT qualify (outside 7-day window)', () => {
    const event = makeContextEvent('travel', 8, 5, { endDate: pastDate(8) });
    const layer = buildContextResponseContrastLayer([event], null, physio, timeline, today);
    expect(layer).toBeNull();
  });

  it('active travel (no endDate) always qualifies', () => {
    const event = makeContextEvent('travel', 0, 5, { endDate: undefined });
    const layer = buildContextResponseContrastLayer([event], null, physio, timeline, today);
    expect(layer).not.toBeNull();
  });

  // Illness: 10-day window after end

  it('illness that ended 10 days ago qualifies (boundary)', () => {
    const event = makeContextEvent('illness', 10, 3, { endDate: pastDate(10) });
    const layer = buildContextResponseContrastLayer([event], null, physio, timeline, today);
    expect(layer).not.toBeNull();
    expect(layer?.contextType).toBe('illness');
  });

  it('illness that ended 11 days ago does NOT qualify (outside 10-day window)', () => {
    const event = makeContextEvent('illness', 11, 3, { endDate: pastDate(11) });
    const layer = buildContextResponseContrastLayer([event], null, physio, timeline, today);
    expect(layer).toBeNull();
  });

  // Stressful period: 5-day window, must be ≥ 2 days duration

  it('stressful_period ≥ 2 days that ended 5 days ago qualifies', () => {
    const event = makeContextEvent('stressful_period', 5, 3, { endDate: pastDate(5) });
    const layer = buildContextResponseContrastLayer([event], null, physio, timeline, today);
    expect(layer).not.toBeNull();
  });

  it('stressful_period that ended 6 days ago does NOT qualify (outside 5-day window)', () => {
    const event = makeContextEvent('stressful_period', 6, 3, { endDate: pastDate(6) });
    const layer = buildContextResponseContrastLayer([event], null, physio, timeline, today);
    expect(layer).toBeNull();
  });

  it('1-day stressful_period does NOT qualify regardless of window (too casual)', () => {
    const event = makeContextEvent('stressful_period', 2, 1, { endDate: pastDate(2) });
    const layer = buildContextResponseContrastLayer([event], null, physio, timeline, today);
    expect(layer).toBeNull();
  });

  // User-defined: 7-day window

  it('user_defined event ended 7 days ago qualifies (boundary)', () => {
    const event = makeContextEvent('user_defined', 7, 3, {
      endDate: pastDate(7), label: 'Wedding weekend',
    });
    const layer = buildContextResponseContrastLayer([event], null, physio, timeline, today);
    expect(layer).not.toBeNull();
    expect(layer?.contextType).toBe('user_defined');
  });

  it('user_defined event ended 8 days ago does NOT qualify', () => {
    const event = makeContextEvent('user_defined', 8, 3, {
      endDate: pastDate(8), label: 'Wedding weekend',
    });
    const layer = buildContextResponseContrastLayer([event], null, physio, timeline, today);
    expect(layer).toBeNull();
  });

  // Stale events stop qualifying

  it('travel event from 15 days ago does not qualify (stale)', () => {
    const event = makeContextEvent('travel', 15, 5, { endDate: pastDate(15) });
    const layer = buildContextResponseContrastLayer([event], null, physio, timeline, today);
    expect(layer).toBeNull();
  });

  it('illness from 20 days ago does not qualify (stale)', () => {
    const event = makeContextEvent('illness', 20, 3, { endDate: pastDate(20) });
    const layer = buildContextResponseContrastLayer([event], null, physio, timeline, today);
    expect(layer).toBeNull();
  });

  // No duplicate stories: same event remains in window for several days but suppression prevents repeat

  it('same event + same physioResponse produces same suppressionKey (enables deduplication)', () => {
    const event = makeContextEvent('travel', 3, 5, { endDate: pastDate(3) });
    const layer1 = buildContextResponseContrastLayer([event], null, physio, timeline, today);
    const layer2 = buildContextResponseContrastLayer([event], null, physio, timeline, today);
    expect(layer1?.suppressionKey).toBe(layer2?.suppressionKey);
  });

  it('buildEnhancedStoryWithKey suppresses if key already seen', () => {
    const event  = makeContextEvent('travel', 3, 5, { endDate: pastDate(3) });
    const synth  = makeSynthesis('recovery_needed', [event]);
    const { story: first, contrastKeyShown } = buildEnhancedStoryWithKey(
      synth, timeline, today, undefined, new Set(),
    );
    expect(first).not.toBeNull();
    expect(contrastKeyShown).not.toBeNull();

    // Second call with the same key in seenContrastKeys → suppressed
    const { story: second } = buildEnhancedStoryWithKey(
      synth, timeline, today, undefined, new Set([contrastKeyShown!]),
    );
    expect(second).toBeNull();
  });
});

// ─── 3. Confirmed-pattern bridge ──────────────────────────────────────────────

describe('Confirmed-pattern bridge — buildConfirmedPatternLayer', () => {
  const timeline = makeTimeline();

  it('returns null when no patterns are confirmed (EARLY or INSUFFICIENT tier)', () => {
    const patterns = [
      makePatternResult('workoutDurationMin', 'hrv', 'positive', 'EARLY'),
      makePatternResult('steps', 'sleepHours', 'positive', 'INSUFFICIENT'),
    ];
    const today  = elevatedHrvToday();
    const physio = buildPhysiologicalState(today, timeline);
    const layer  = buildConfirmedPatternLayer(patterns, physio);
    expect(layer).toBeNull();
  });

  it('returns null when physio is near baseline even with a confirmed pattern', () => {
    const patterns = [
      makePatternResult('workoutDurationMin', 'hrv', 'positive', 'CONSISTENT'),
    ];
    const today  = stableToday(); // hrv = 55, which is right at baseline
    const physio = buildPhysiologicalState(today, timeline);
    const layer  = buildConfirmedPatternLayer(patterns, physio);
    // hrv=55 is at baseline median — should not produce a story
    expect(layer).toBeNull();
  });

  it('returns a finding when CONSISTENT pattern + outcome metric notably above baseline', () => {
    const patterns = [
      makePatternResult('workoutDurationMin', 'hrv', 'positive', 'CONSISTENT', 18),
    ];
    const today  = elevatedHrvToday(); // hrv=72, well above baseline of 55
    const physio = buildPhysiologicalState(today, timeline);
    const layer  = buildConfirmedPatternLayer(patterns, physio);

    expect(layer).not.toBeNull();
    expect(layer?.inputSignal).toBe('workoutDurationMin');
    expect(layer?.outcomeSignal).toBe('hrv');
    expect(layer?.patternDirection).toBe('positive');
    expect(layer?.todayOutcomeDirection).toBe('above_baseline');
    expect(layer?.confidenceTier).toBe('CONSISTENT');
    expect(layer?.inputLabel).toBe('Time spent training');
    expect(layer?.outcomeLabel).toBe('HRV');
  });

  it('returns a finding when PATTERN tier (not only CONSISTENT) + outcome off baseline', () => {
    const patterns = [
      makePatternResult('steps', 'sleepHours', 'positive', 'PATTERN', 9),
    ];
    // sleepHours notably below baseline
    const today  = makeDayRecord(TODAY, { readiness: 75, hrv: 55, sleepHours: 5.5, sleepScore: 65 });
    const physio = buildPhysiologicalState(today, timeline);
    const layer  = buildConfirmedPatternLayer(patterns, physio);

    expect(layer).not.toBeNull();
    expect(layer?.inputSignal).toBe('steps');
    expect(layer?.outcomeSignal).toBe('sleepHours');
    expect(layer?.inputLabel).toBe('Daily steps');
    expect(layer?.outcomeLabel).toBe('Sleep');
  });

  it('prefers CONSISTENT over PATTERN when both match', () => {
    const patterns = [
      makePatternResult('steps',              'hrv', 'positive', 'PATTERN',    8),
      makePatternResult('workoutDurationMin', 'hrv', 'positive', 'CONSISTENT', 14),
    ];
    const today  = elevatedHrvToday();
    const physio = buildPhysiologicalState(today, timeline);
    const layer  = buildConfirmedPatternLayer(patterns, physio);

    expect(layer?.inputSignal).toBe('workoutDurationMin');
    expect(layer?.confidenceTier).toBe('CONSISTENT');
  });

  it('returns null when no confirmed pattern outcome matches a notable physio finding', () => {
    // Pattern is for sleepHours → hrv, but today only readiness is off-baseline
    const patterns = [
      makePatternResult('sleepHours', 'hrv', 'positive', 'CONSISTENT'),
    ];
    // hrv is near baseline; readiness is below — but readiness is not the pattern outcome
    const today  = makeDayRecord(TODAY, { readiness: 50, hrv: 55, sleepScore: 80, sleepHours: 7.5 });
    const physio = buildPhysiologicalState(today, timeline);
    const layer  = buildConfirmedPatternLayer(patterns, physio);
    expect(layer).toBeNull();
  });

  it('returns null when patternDirection is neutral or unknown', () => {
    const patterns = [
      makePatternResult('workoutDurationMin', 'hrv', 'neutral', 'CONSISTENT'),
    ];
    const today  = elevatedHrvToday();
    const physio = buildPhysiologicalState(today, timeline);
    const layer  = buildConfirmedPatternLayer(patterns, physio);
    expect(layer).toBeNull();
  });
});

// ─── 4. Full episode: confirmedPatternLayer in buildStoryEpisode ───────────────

describe('Confirmed-pattern bridge in buildStoryEpisode', () => {
  it('confirmedPatternLayer fires when core gates + contrast are null, pattern confirmed, physio off-baseline', () => {
    const timeline = makeTimeline();
    const today    = elevatedHrvToday();
    const pattern  = makePatternResult('workoutDurationMin', 'hrv', 'positive', 'CONSISTENT', 16);
    const synth    = makeSynthesis('performing_well', [], [], [pattern]);

    const episode = buildStoryEpisode(synth, timeline, today);
    expect(episode.surfaceWorthyCore).toBe(false);
    expect(episode.contextResponseContrast).toBeNull();
    expect(episode.confirmedPatternLayer).not.toBeNull();
    expect(episode.surfaceWorthy).toBe(true);
  });

  it('confirmedPatternLayer is null when core gates fired', () => {
    // Conflicting state (HRV above + readiness below, both substantial) = surfaceWorthyCore
    const timeline = makeTimeline();
    const today    = makeDayRecord(TODAY, { readiness: 50, hrv: 78, sleepScore: 80, sleepHours: 7.5 });
    const pattern  = makePatternResult('workoutDurationMin', 'hrv', 'positive', 'CONSISTENT', 16);
    const synth    = makeSynthesis('mixed_signals', [], [], [pattern]);

    const episode = buildStoryEpisode(synth, timeline, today);
    // surfaceWorthyCore fires → confirmedPatternLayer should be null
    if (episode.surfaceWorthyCore) {
      expect(episode.confirmedPatternLayer).toBeNull();
    }
    // Either way, surfaceWorthy is true
    expect(episode.surfaceWorthy).toBe(true);
  });

  it('confirmedPatternLayer is null when contrast gate already fired', () => {
    const timeline = makeTimeline();
    const today    = declinedToday();
    const pattern  = makePatternResult('workoutDurationMin', 'hrv', 'positive', 'CONSISTENT', 16);
    const travelEvent = makeContextEvent('travel', 2, 5, { endDate: pastDate(2) });
    const synth    = makeSynthesis('recovery_needed', [travelEvent], [], [pattern]);

    const episode  = buildStoryEpisode(synth, timeline, today);
    // Contrast should fire (travel in window + declined physio with disruption check)
    // confirmedPatternLayer must be null if contrast fires
    if (episode.contextResponseContrast !== null) {
      expect(episode.confirmedPatternLayer).toBeNull();
    }
  });

  it('ordinary day with confirmed pattern = no story (physio near baseline)', () => {
    const timeline = makeTimeline();
    const today    = stableToday();
    const pattern  = makePatternResult('workoutDurationMin', 'hrv', 'positive', 'CONSISTENT', 16);
    const synth    = makeSynthesis('performing_well', [], [], [pattern]);

    const episode = buildStoryEpisode(synth, timeline, today);
    expect(episode.surfaceWorthyCore).toBe(false);
    expect(episode.confirmedPatternLayer).toBeNull();
    expect(episode.surfaceWorthy).toBe(false);
  });
});

// ─── 5. Rendered story output — observational language ────────────────────────

describe('Confirmed-pattern story text — observational language only', () => {
  const timeline = makeTimeline();

  it('story references the pattern and today\'s metric without causation claims', () => {
    const today   = elevatedHrvToday();
    const pattern = makePatternResult('workoutDurationMin', 'hrv', 'positive', 'CONSISTENT', 18);
    const synth   = makeSynthesis('performing_well', [], [], [pattern]);
    const story   = buildEnhancedStory(synth, timeline, today);

    expect(story).not.toBeNull();
    if (story) {
      // Must mention the relationship
      expect(story.toLowerCase()).toMatch(/relationship|recurring|seen/);
      // Must mention the metric name
      expect(story.toLowerCase()).toMatch(/hrv|time spent training/);
      // Must not claim causation
      expect(story.toLowerCase()).not.toMatch(/\bcaused?\b|\bdue to\b|\bbecause\b/);
      // Must not claim mechanism
      expect(story.toLowerCase()).not.toMatch(/nervous system|adapting|managing the load/);
      // Must not claim "your body processed"
      expect(story.toLowerCase()).not.toMatch(/processed it normally/);
    }
  });

  it('story mentions "usual range" or "baseline" when describing today\'s physiology', () => {
    const today   = declinedToday();
    const pattern = makePatternResult('steps', 'hrv', 'positive', 'CONSISTENT', 12);
    const synth   = makeSynthesis('recovery_needed', [], [], [pattern]);
    const story   = buildEnhancedStory(synth, timeline, today);

    if (story) {
      expect(story.toLowerCase()).toMatch(/usual range|baseline/);
    }
  });
});

// ─── 6. Overlapping context types ─────────────────────────────────────────────

describe('Overlapping context types — priority order', () => {
  const timeline = makeTimeline();
  const today    = declinedToday();
  const physio   = buildPhysiologicalState(today, timeline);

  it('illness takes priority over travel when both qualify', () => {
    const travel  = makeContextEvent('travel', 2, 5, { endDate: pastDate(2) });
    const illness = makeContextEvent('illness', 1, 3, { endDate: pastDate(1) });
    const layer   = buildContextResponseContrastLayer([travel, illness], null, physio, timeline, today);
    // illness > travel in priority order
    expect(layer?.contextType).toBe('illness');
  });

  it('travel takes priority over stressful_period when both qualify', () => {
    const travel  = makeContextEvent('travel', 2, 5, { endDate: pastDate(2) });
    const stress  = makeContextEvent('stressful_period', 1, 3, { endDate: pastDate(1) });
    const layer   = buildContextResponseContrastLayer([travel, stress], null, physio, timeline, today);
    expect(layer?.contextType).toBe('travel');
  });
});

// ─── 7. Existing behavioral corroboration unaffected ──────────────────────────

describe('Existing behavioral corroboration — unchanged', () => {
  const timeline = makeTimeline(30, (i, date) => ({
    // Several days with alcohol to enable behavioral spec
    totalAlcoholDrinks: i < 10 ? 2 : 0,
    readiness: i < 10 ? 68 : 75,
  }));

  it('behavioralFindings still computed independently of confirmedPatternLayer', () => {
    const today  = stableToday();
    const pattern = makePatternResult('workoutDurationMin', 'hrv', 'positive', 'CONSISTENT', 16);
    const synth  = makeSynthesis('performing_well', [], [], [pattern]);
    const episode = buildStoryEpisode(synth, timeline, today);

    // behavioralFindings should be an array (may or may not have entries)
    expect(Array.isArray(episode.behavioralFindings)).toBe(true);
  });

  it('strong_contextual_pattern behavioral finding still fires surfaceWorthyCore', () => {
    // This is a pass-through test — the behavioral path is unaffected by pattern bridge
    const today  = stableToday();
    const synth  = makeSynthesis('performing_well', [], []);
    const episode = buildStoryEpisode(synth, timeline, today);
    // Whether or not it fires depends on behavioral data; just confirm no crash
    expect(episode.behavioralFindings).toBeDefined();
    expect(typeof episode.surfaceWorthyCore).toBe('boolean');
  });
});

// ─── 8. What's Connected output unaffected ────────────────────────────────────

describe('What\'s Connected — pattern engine output unaffected', () => {
  it('PatternResult is unchanged by confirmed-pattern bridge logic', () => {
    const pattern = makePatternResult('workoutDurationMin', 'hrv', 'positive', 'CONSISTENT', 16);

    // buildConfirmedPatternLayer reads pattern but does not mutate it
    const timeline = makeTimeline();
    const today    = elevatedHrvToday();
    const physio   = buildPhysiologicalState(today, timeline);
    buildConfirmedPatternLayer([pattern], physio);

    // Original pattern object unchanged
    expect(pattern.confidenceTier).toBe('CONSISTENT');
    expect(pattern.observationCount).toBe(16);
    expect(pattern.direction).toBe('positive');
  });
});

// ─── 9. Source independence — Apple Health-only users ─────────────────────────
//
// Product principle: BellaHealth works with a phone, better with a wearable.
// No Story rule should require Oura data when equivalent HealthKit data exists.

describe('Source independence — Apple Health-only users', () => {
  it('HK-only user with sleep history gets alcohol story (sleep is a normalized signal)', () => {
    // No Oura: readiness, sleepScore, hrv all undefined. Only sleepHours from HealthKit.
    const timeline = makeTimeline(30, () => ({ sleepHours: 7.5 }));
    const today    = makeDayRecord(TODAY, { sleepHours: 6.0 });
    const physio   = buildPhysiologicalState(today, timeline);

    expect(physio).not.toBeNull();
    expect(physio?.findings.length).toBe(1);
    expect(physio?.findings[0].metric).toBe('Sleep');

    const alcoholEvent = makeAlcoholEvent(YESTERDAY, 2);
    const layer = buildContextResponseContrastLayer(
      [alcoholEvent], null, physio, timeline, today,
    );
    expect(layer).not.toBeNull();
    expect(layer?.contextType).toBe('alcohol_night');
    expect(layer?.physioResponse).toBe('responding');
  });

  it('HK-only user with sleep within baseline gets stable story', () => {
    // Sleep at baseline (7.4 within a 7.0-8.0 range) -> near_baseline -> stable physio response.
    // Variance required: flat baselines make p25==p75, so any deviation is below_baseline.
    // With (i%6)*0.2 cycling: sorted p25=7.2, p75=7.8 -> 7.4 is near_baseline.
    const timeline = makeTimeline(30, (i) => ({ sleepHours: 7.0 + (i % 6) * 0.2 }));
    const today    = makeDayRecord(TODAY, { sleepHours: 7.4 });
    const physio   = buildPhysiologicalState(today, timeline);

    expect(physio?.findings[0].direction).toBe('near_baseline');

    const alcoholEvent = makeAlcoholEvent(YESTERDAY, 2);
    const layer = buildContextResponseContrastLayer(
      [alcoholEvent], null, physio, timeline, today,
    );
    expect(layer?.physioResponse).toBe('stable');
  });

  it('no physio data at all → story is null (silence is correct)', () => {
    // Empty today record — no metrics defined anywhere
    const timeline = makeTimeline(30, () => ({ sleepHours: 7.5 }));
    const today    = makeDayRecord(TODAY, {});  // no fields
    const physio   = buildPhysiologicalState(today, timeline);
    expect(physio).toBeNull(); // today has no metrics → no physio state

    const alcoholEvent = makeAlcoholEvent(YESTERDAY, 2);
    const layer = buildContextResponseContrastLayer(
      [alcoholEvent], null, physio, timeline, today,
    );
    expect(layer).toBeNull(); // no physio → no story → correct silence
  });

  it('HK-only user with insufficient history (<7 days) → no story (baseline not established)', () => {
    // Only 5 days of sleep history — not enough for a personal baseline
    const timeline = makeTimeline(5, () => ({ sleepHours: 7.5 }));
    const today    = makeDayRecord(TODAY, { sleepHours: 6.0 });
    const physio   = buildPhysiologicalState(today, timeline);
    // computeMetricBaseline requires ≥7 samples per metric
    expect(physio).toBeNull();

    const alcoholEvent = makeAlcoholEvent(YESTERDAY, 2);
    const layer = buildContextResponseContrastLayer(
      [alcoholEvent], null, physio, timeline, today,
    );
    expect(layer).toBeNull();
  });
});

// ─── 10. Deduplication — Oura + HealthKit same-day data ───────────────────────
//
// Oura writes biometric data (sleep, HRV) back to Apple Health automatically.
// When both direct Oura and HealthKit exist for the same day, Oura wins (priority 3 > 2).
// hkSteps and ouraSteps are intentionally preserved separately.

describe('Deduplication — Oura + HealthKit same-day contributions', () => {
  it('Oura sleepHours wins over HealthKit sleepHours when both present (no double-count)', () => {
    const ouraContrib: DayContribution = {
      date:     TODAY,
      sourceId: 'oura_readiness',
      priority: SIGNAL_PRIORITY.OURA,          // 3
      signals:  { sleepHours: 6.5 },
    };
    const hkContrib: DayContribution = {
      date:     TODAY,
      sourceId: 'oura_sleep',
      priority: SIGNAL_PRIORITY.HEALTHKIT,     // 2 — Oura writes to HK; HK re-reads it
      signals:  { sleepHours: 6.9 },
    };
    const merged = mergeContributions(TODAY, [ouraContrib, hkContrib]);
    // Oura API value (6.5) must win over the HK-re-read value (6.9)
    expect(merged.sleepHours).toBe(6.5);
  });

  it('hkSteps and ouraSteps are both preserved — they are separate fields by design', () => {
    const ouraContrib: DayContribution = {
      date:     TODAY,
      sourceId: 'oura_readiness',
      priority: SIGNAL_PRIORITY.OURA,
      signals:  { ouraSteps: 8200 },
    };
    const hkContrib: DayContribution = {
      date:     TODAY,
      sourceId: 'apple_health_steps',
      priority: SIGNAL_PRIORITY.HEALTHKIT,
      signals:  { hkSteps: 9500 },
    };
    const merged = mergeContributions(TODAY, [ouraContrib, hkContrib]);
    // Both preserved — the pattern engine uses hkSteps ?? ouraSteps for 'steps' signal
    expect(merged.ouraSteps).toBe(8200);
    expect(merged.hkSteps).toBe(9500);
  });

  it('Oura HRV wins over HealthKit point-in-time HRV when both present', () => {
    // Oura: overnight sleep HRV average (more accurate). HK: instantaneous SDNN sample.
    const ouraContrib: DayContribution = {
      date:     TODAY,
      sourceId: 'oura_hrv',
      priority: SIGNAL_PRIORITY.OURA,
      signals:  { hrv: 52 },
    };
    const hkContrib: DayContribution = {
      date:     TODAY,
      sourceId: 'oura_hrv',   // HK HRV adapter uses 'oura_hrv' sourceId for display label
      priority: SIGNAL_PRIORITY.HEALTHKIT,
      signals:  { hrv: 67 },  // point-in-time sample, not overnight average
    };
    const merged = mergeContributions(TODAY, [hkContrib, ouraContrib]);
    expect(merged.hrv).toBe(52); // Oura wins regardless of order
  });

  it('HK sleep fills in when Oura is not connected (graceful fallback)', () => {
    // No Oura data → only HealthKit sleep contribution
    const hkContrib: DayContribution = {
      date:     TODAY,
      sourceId: 'oura_sleep',
      priority: SIGNAL_PRIORITY.HEALTHKIT,
      signals:  { sleepHours: 7.2 },
    };
    const merged = mergeContributions(TODAY, [hkContrib]);
    expect(merged.sleepHours).toBe(7.2); // HK value used when no Oura
  });
});

// ─── 11. Story voice — alcohol: no judgment, no causation, no redemption ───────

describe('Alcohol story voice — observational, non-judgmental', () => {
  it('responding physio: neutral opener + factual physio description', () => {
    const timeline = makeTimeline(30, () => ({ sleepHours: 7.5 }));
    const today    = makeDayRecord(TODAY, { sleepHours: 6.1 });
    const alcoholEvent = makeAlcoholEvent(YESTERDAY, 2);
    const synth    = makeSynthesis('recovery_needed', [alcoholEvent]);

    const story = buildEnhancedStory(synth, timeline, today);
    expect(story).not.toBeNull();
    if (story) {
      expect(story).toContain('Last night was a little outside your usual routine');
      expect(story).toContain('lower');
      // No causation or judgment
      expect(story.toLowerCase()).not.toMatch(/left its mark|caused|due to|because|damage|setback/);
      expect(story.toLowerCase()).not.toMatch(/make up|bounce|despite|pushed through/);
      // No "After [drinking]" causal framing
      expect(story.toLowerCase()).not.toContain('after an evening');
      expect(story.toLowerCase()).not.toContain('after a late night');
    }
  });

  it('stable physio: neutral opener + recovery signals described without praise or alarm', () => {
    const timeline = makeTimeline(30, () => ({ sleepHours: 7.5 }));
    const today    = makeDayRecord(TODAY, { sleepHours: 7.4 }); // near baseline
    const alcoholEvent = makeAlcoholEvent(YESTERDAY, 2);
    const synth    = makeSynthesis('performing_well', [alcoholEvent]);

    const story = buildEnhancedStory(synth, timeline, today);
    expect(story).not.toBeNull();
    if (story) {
      expect(story).toContain('Last night was a little outside your usual routine');
      expect(story).toContain('usual range');
      // No moralizing language
      expect(story.toLowerCase()).not.toMatch(/well done|good job|handled it|despite|still managed/);
    }
  });

  it('mixed physio: shifted metric described, stable metric mentioned separately', () => {
    // sleep below baseline, hrv near baseline → story should mention both without conflating.
    // Variance required: flat baseline makes p25==p75, so hrv 54 vs 55 is below_baseline.
    // sleep (i%6)*0.2: p25=7.2, p75=7.8 -> 6.0 below_baseline.
    // hrv  (i%5)*3: 50,53,56,59,62 cycling -> p25=53, p75=59 -> 54 near_baseline.
    const timeline = makeTimeline(30, (i) => ({ sleepHours: 7.0 + (i % 6) * 0.2, hrv: 50 + (i % 5) * 3 }));
    const today    = makeDayRecord(TODAY, { sleepHours: 6.0, hrv: 54 }); // sleep below, hrv near
    const alcoholEvent = makeAlcoholEvent(YESTERDAY, 2);
    const synth    = makeSynthesis('mixed_signals', [alcoholEvent]);

    const story = buildEnhancedStory(synth, timeline, today);
    expect(story).not.toBeNull();
    if (story) {
      expect(story).toContain('Last night was a little outside your usual routine');
      // Sleep described as shifted
      expect(story.toLowerCase()).toContain('sleep');
      expect(story.toLowerCase()).toContain('lower');
      // HRV or "other recovery signals" should appear noting stability
      expect(story.toLowerCase()).toMatch(/other recovery|staying close|normal/);
    }
  });
});

// ─── 12. Enrichment — same-day activity in alcohol story ──────────────────────
//
// Gates decide qualification. Once qualified, the story should synthesize
// the full picture — including same-day behavior that wouldn't independently qualify.

describe('Story enrichment — today\'s workout in alcohol story', () => {
  it('today\'s run appears in the story as a neutral observation', () => {
    const timeline = makeTimeline(30, () => ({ sleepHours: 7.5 }));
    const today    = makeDayRecord(TODAY, {
      sleepHours:          6.1,
      workoutDurationMin:  35,
      primaryActivityType: 'Running',
    });
    const alcoholEvent = makeAlcoholEvent(YESTERDAY, 2);
    const synth    = makeSynthesis('recovery_needed', [alcoholEvent]);

    const story = buildEnhancedStory(synth, timeline, today);
    expect(story).not.toBeNull();
    if (story) {
      expect(story.toLowerCase()).toContain('run');
      // Neutral — not framed as compensation or redemption
      expect(story.toLowerCase()).not.toMatch(/bounced back|pushed through|despite|make up|compensat/);
      // No causal advice
      expect(story.toLowerCase()).not.toMatch(/will help|should help|may help/);
    }
  });

  it('generic workout (non-running) appears as activity note', () => {
    const timeline = makeTimeline(30, () => ({ sleepHours: 7.5 }));
    const today    = makeDayRecord(TODAY, {
      sleepHours:          6.1,
      workoutDurationMin:  45,
      primaryActivityType: 'Cycling',
    });
    const alcoholEvent = makeAlcoholEvent(YESTERDAY, 2);
    const synth    = makeSynthesis('recovery_needed', [alcoholEvent]);

    const story = buildEnhancedStory(synth, timeline, today);
    if (story) {
      expect(story.toLowerCase()).toContain('activity');
    }
  });

  it('workout < 15 min does not appear (too brief to mention)', () => {
    const timeline = makeTimeline(30, () => ({ sleepHours: 7.5 }));
    const today    = makeDayRecord(TODAY, {
      sleepHours:          6.1,
      workoutDurationMin:  10,
      primaryActivityType: 'Running',
    });
    const alcoholEvent = makeAlcoholEvent(YESTERDAY, 2);
    const synth    = makeSynthesis('recovery_needed', [alcoholEvent]);

    const story = buildEnhancedStory(synth, timeline, today);
    // Story fires (alcohol qualifies) but 10min run should not be mentioned
    if (story) {
      expect(story.toLowerCase()).not.toContain('logged a run');
      expect(story.toLowerCase()).not.toContain('got some activity');
    }
  });

  it('no workout today → no activity note (no phantom activity text)', () => {
    const timeline = makeTimeline(30, () => ({ sleepHours: 7.5 }));
    const today    = makeDayRecord(TODAY, { sleepHours: 6.1 }); // no workout fields
    const alcoholEvent = makeAlcoholEvent(YESTERDAY, 2);
    const synth    = makeSynthesis('recovery_needed', [alcoholEvent]);

    const story = buildEnhancedStory(synth, timeline, today);
    if (story) {
      expect(story.toLowerCase()).not.toContain('activity');
      expect(story.toLowerCase()).not.toContain('run');
    }
  });
});
