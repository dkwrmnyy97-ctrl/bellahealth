/**
 * context-production-chain.test.ts
 *
 * End-to-end proof that the Oct 1 production scenario populates Your Story
 * using the real engine pipeline — from raw drink_log through deriveDrinkEvents
 * → buildContextResponseContrastLayer → buildStoryEpisode → buildEnhancedStoryWithKey.
 *
 * Scenarios traced:
 *
 *   A. Alcohol end-to-end: Sep30 drink_log → story fires on Oct1
 *   B. Old-bug regression: drinks on wrong date (Oct1) → story falls back
 *   C. Physio classification: 5.9h sleep classifies as below_baseline/substantial
 *   D. Run enrichment: alcohol story + run today → story text mentions run
 *   E. Boundary conditions that stay null even after the sleep_activity fix
 *   F. Source independence: HK-only (no Oura) + Sep30 alcohol → story fires
 *   G. sleep_activity fix: short sleep + run WITHOUT alcohol → story fires
 *   H. Story language: no causation, no guilt, no moralizing
 *   I. Ordinary-day silence: normal values → story = null
 *
 * Architectural gap documented (Sections E + G):
 *   Without the sleep_activity fix, 5.9h sleep + run alone cannot produce a story
 *   because there is no contextual frame (no life event, no alcohol, no training goal).
 *   All non-alcohol branches in buildContextResponseContrastLayer require a
 *   findMeaningfulContextEvent() match — which won't exist for a spontaneous short night.
 *   The sleep_activity branch (added before Gate 1, like alcohol) closes this gap.
 *
 * Hard stop: no EAS build. This is local proof only.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import { deriveDrinkEvents, type ContextEvent } from '../context-events';
import {
  buildPhysiologicalState,
  buildContextResponseContrastLayer,
  buildStoryEpisode,
} from '../story-engine';
import { buildEnhancedStoryWithKey } from '../../utils/pattern-language';
import type { HealthDayRecord } from '../pattern-engine';
import type { SynthesisResult, ThemeDescriptor } from '../context-synthesis';

// ─── Test dates ────────────────────────────────────────────────────────────────

const SEP_30 = '2026-09-30';
const OCT_1  = '2026-10-01';

/**
 * Deterministic "now" for tests: 2 PM local on Oct 1 2026.
 * Date constructor (not ISO string) makes .getHours() = 14 in every timezone,
 * so isOvernightSpillover() always returns false — no accidental early-morning
 * behavioral-night logic during CI.
 */
const TEST_NOW = new Date(2026, 9, 1, 14, 0, 0); // Oct 1 2026, 14:00 local

// ─── Baseline timeline helpers ─────────────────────────────────────────────────

/**
 * Build n days of historical HealthDayRecord entries (baseline history).
 * Dates run from Sep 15 up to (but NOT including) today (Oct 1).
 * Slight jitter (-0.2/0/+0.2 for sleep, -3/0/+3 for scores) ensures
 * computeMetricBaseline sees natural spread.
 *
 * Baseline with 14 days, sleepHours=7.5:
 *   sorted: [7.3×5, 7.5×5, 7.7×4] (14 total)
 *   p25 = sorted[3] = 7.3, median = sorted[7] = 7.5, p75 = sorted[10] = 7.7
 *   iqr = max(0.4, 1) = 1  (clamped at 1 by classifyVsBaseline)
 *   → sleepHours=5.9: below_baseline, absDist=1.6 > 1 → substantial ✓
 *   → sleepHours=7.5: within [7.3,7.7] → near_baseline ✓
 *   → sleepHours=7.2: below 7.3 → below_baseline; absDist=0.3 < 0.4 → mild ✓
 */
function buildBaselineTimeline(options: {
  days?: number;
  sleepHours?: number;
  readiness?: number;
  hrv?: number;
  sleepScore?: number;
  workoutDurationMin?: number;
}): HealthDayRecord[] {
  const {
    days = 14,
    sleepHours,
    readiness,
    hrv,
    sleepScore,
    workoutDurationMin,
  } = options;

  return Array.from({ length: days }, (_, i) => {
    const sleepJitter = ((i % 3) - 1) * 0.2;   // -0.2, 0, +0.2
    const scoreJitter = ((i % 3) - 1) * 3;      // -3, 0, +3
    const day = 15 + i;
    const date = `2026-09-${String(day).padStart(2, '0')}`;

    return {
      date,
      ...(sleepHours        !== undefined ? { sleepHours:        sleepHours        + sleepJitter } : {}),
      ...(readiness         !== undefined ? { readiness:         readiness         + scoreJitter  } : {}),
      ...(hrv               !== undefined ? { hrv:               hrv               + scoreJitter  } : {}),
      ...(sleepScore        !== undefined ? { sleepScore:        sleepScore        + scoreJitter  } : {}),
      ...(workoutDurationMin !== undefined ? { workoutDurationMin }                                  : {}),
    };
  });
}

/** Minimal SynthesisResult — only relevantContext matters for contrast-layer tests. */
function buildMinimalSynthesis(relevantContext: ContextEvent[] = []): SynthesisResult {
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
  };
}

// ─── A. Alcohol end-to-end ─────────────────────────────────────────────────────

describe('A. Alcohol end-to-end: Sep30 drink_log → story fires on Oct1', () => {
  beforeEach(async () => { await AsyncStorage.clear(); });

  test('A1: Sep30 drink_log → deriveDrinkEvents returns alcohol_period event with correct date', async () => {
    await AsyncStorage.setItem('drink_log', JSON.stringify([
      { date: SEP_30, totalDrinks: 2, totalCalories: 260, vibe: 'social' },
    ]));

    const events = await deriveDrinkEvents();

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('alcohol_period');
    expect(events[0].startDate).toBe(SEP_30);
    expect(events[0].metadata?.totalDrinks).toBe(2);
  });

  test('A2: Sep30 alcohol event → buildContextResponseContrastLayer on Oct1 → contextType = alcohol_night', () => {
    const alcoholEvent: ContextEvent = {
      id:        `derived_drink_${SEP_30}`,
      type:      'alcohol_period',
      source:    'derived',
      startDate: SEP_30,
      endDate:   SEP_30,
      metadata:  { totalDrinks: 2, totalCalories: 260 },
      createdAt: `${SEP_30}T23:59:00.000Z`,
      updatedAt: `${SEP_30}T23:59:00.000Z`,
    };

    const timeline = buildBaselineTimeline({ days: 14, sleepHours: 7.5 });
    const today: HealthDayRecord = { date: OCT_1, sleepHours: 5.9 };

    const physioState = buildPhysiologicalState(today, timeline);
    expect(physioState).not.toBeNull();
    expect(physioState!.findings.length).toBeGreaterThanOrEqual(1);

    const layer = buildContextResponseContrastLayer(
      [alcoholEvent], null, physioState, timeline, today,
    );

    expect(layer).not.toBeNull();
    expect(layer!.contextType).toBe('alcohol_night');
  });

  test('A3: Full chain — Sep30 drinks in AsyncStorage → buildEnhancedStoryWithKey returns non-null story', async () => {
    // This is the real Oct 1 production scenario. DrinkingModal (after the fix)
    // writes the drink_log entry to Sep30. deriveDrinkEvents reads it,
    // buildStoryEpisode finds the alcohol event for yesterday, story fires.
    await AsyncStorage.setItem('drink_log', JSON.stringify([
      { date: SEP_30, totalDrinks: 2, totalCalories: 260 },
    ]));

    const drinkEvents    = await deriveDrinkEvents();
    const timeline       = buildBaselineTimeline({ days: 14, sleepHours: 7.5 });
    const today: HealthDayRecord = { date: OCT_1, sleepHours: 5.9 };
    const synthesis      = buildMinimalSynthesis(drinkEvents);

    const { story } = buildEnhancedStoryWithKey(synthesis, timeline, today);

    expect(story).not.toBeNull();
    expect(story).toContain('Last night');
  });
});

// ─── B. Old-bug regression ────────────────────────────────────────────────────

describe('B. OLD BUG regression: drinks written to Oct1 (stale selectedDate) → story fails', () => {
  beforeEach(async () => { await AsyncStorage.clear(); });

  test('B1: Oct1 drink_log entry (bug: selectedDate was Oct1) → deriveDrinkEvents returns Oct1 event', async () => {
    // Simulates the buggy DrinkingModal saving to Oct1 instead of Sep30.
    await AsyncStorage.setItem('drink_log', JSON.stringify([
      { date: OCT_1, totalDrinks: 2, totalCalories: 260 },
    ]));

    const events = await deriveDrinkEvents();
    expect(events[0].startDate).toBe(OCT_1);  // event is on today, not yesterday
  });

  test('B2: Oct1 alcohol event → findAlcoholNightEvent on Oct1 looks for Sep30 → not found → layer null', () => {
    // The engine looks for YESTERDAY (Sep30) but the buggy entry is on Oct1.
    const alcoholEventOnWrongDate: ContextEvent = {
      id:        `derived_drink_${OCT_1}`,
      type:      'alcohol_period',
      source:    'derived',
      startDate: OCT_1,   // ← BUG: should be Sep30
      endDate:   OCT_1,
      metadata:  { totalDrinks: 2 },
      createdAt: `${OCT_1}T23:59:00.000Z`,
      updatedAt: `${OCT_1}T23:59:00.000Z`,
    };

    const timeline = buildBaselineTimeline({ days: 14, sleepHours: 7.5 });
    const today: HealthDayRecord = { date: OCT_1, sleepHours: 5.9 };
    const physioState = buildPhysiologicalState(today, timeline);

    const layer = buildContextResponseContrastLayer(
      [alcoholEventOnWrongDate], null, physioState, timeline, today,
      undefined, undefined, TEST_NOW,
    );

    // Engine looks for Sep30 but only Oct1 is in context → alcohol branch skipped
    expect(layer).toBeNull();
  });

  test('B3: Full chain with buggy Oct1 entry → story is null', async () => {
    await AsyncStorage.setItem('drink_log', JSON.stringify([
      { date: OCT_1, totalDrinks: 2, totalCalories: 260 },   // wrong date (bug)
    ]));

    const drinkEvents = await deriveDrinkEvents();
    const timeline    = buildBaselineTimeline({ days: 14, sleepHours: 7.5 });
    const today: HealthDayRecord = { date: OCT_1, sleepHours: 5.9 };
    const synthesis   = buildMinimalSynthesis(drinkEvents);

    const { story } = buildEnhancedStoryWithKey(synthesis, timeline, today, undefined, undefined, TEST_NOW);

    // Bug: drinks saved to Oct1 → engine looks for Sep30 → not found → null
    expect(story).toBeNull();
  });
});

// ─── C. Physio classification ─────────────────────────────────────────────────

describe('C. Physio classification: 5.9h sleep vs personal baseline', () => {
  test('C1: 5.9h sleep against 14-day ~7.5h baseline → below_baseline, substantial', () => {
    const timeline = buildBaselineTimeline({ days: 14, sleepHours: 7.5 });
    const today: HealthDayRecord = { date: OCT_1, sleepHours: 5.9 };

    const state = buildPhysiologicalState(today, timeline);

    expect(state).not.toBeNull();
    const sleepFinding = state!.findings.find(f => f.metric === 'Sleep');
    expect(sleepFinding).toBeDefined();
    expect(sleepFinding!.direction).toBe('below_baseline');
    expect(sleepFinding!.magnitude).toBe('substantial');
  });

  test('C2: 7.5h sleep (exactly at median) → near_baseline', () => {
    const timeline = buildBaselineTimeline({ days: 14, sleepHours: 7.5 });
    const today: HealthDayRecord = { date: OCT_1, sleepHours: 7.5 };

    const state = buildPhysiologicalState(today, timeline);
    const sleepFinding = state!.findings.find(f => f.metric === 'Sleep');
    expect(sleepFinding).toBeDefined();
    expect(sleepFinding!.direction).toBe('near_baseline');
  });

  test('C3: 5.9h sleep + normal readiness (75) + normal HRV (45) → 3 findings, only sleep off-baseline', () => {
    const timeline = buildBaselineTimeline({
      days: 14, sleepHours: 7.5, readiness: 75, hrv: 45,
    });
    const today: HealthDayRecord = {
      date:       OCT_1,
      sleepHours: 5.9,
      readiness:  75,
      hrv:        45,
    };

    const state = buildPhysiologicalState(today, timeline);

    expect(state).not.toBeNull();
    expect(state!.findings.length).toBe(3);
    const offBaseline = state!.findings.filter(f => f.direction !== 'near_baseline');
    expect(offBaseline).toHaveLength(1);
    expect(offBaseline[0].metric).toBe('Sleep');
  });

  test('C4: 7.2h sleep → below_baseline (below p25=7.3) but only mild magnitude', () => {
    // Baseline: p25=7.3, p75=7.7, median=7.5, iqr=max(0.4,1)=1
    // sleepHours=7.2: below p25 → below_baseline; absDist=0.3 < iqr*0.4=0.4 → mild
    const timeline = buildBaselineTimeline({ days: 14, sleepHours: 7.5 });
    const today: HealthDayRecord = { date: OCT_1, sleepHours: 7.2 };

    const state = buildPhysiologicalState(today, timeline);
    const sleepFinding = state!.findings.find(f => f.metric === 'Sleep');
    expect(sleepFinding!.direction).toBe('below_baseline');
    expect(sleepFinding!.magnitude).toBe('mild');
  });
});

// ─── D. Run enrichment ────────────────────────────────────────────────────────

describe('D. Run enrichment: alcohol story mentions run when present', () => {
  beforeEach(async () => { await AsyncStorage.clear(); });

  test('D1: Sep30 drinks + 45min run on Oct1 → story contains "run"', async () => {
    await AsyncStorage.setItem('drink_log', JSON.stringify([
      { date: SEP_30, totalDrinks: 2, totalCalories: 260 },
    ]));

    const drinkEvents = await deriveDrinkEvents();
    const timeline    = buildBaselineTimeline({ days: 14, sleepHours: 7.5 });
    const today: HealthDayRecord = {
      date:                OCT_1,
      sleepHours:          5.9,
      workoutDurationMin:  45,
      primaryActivityType: 'Running',
    };
    const synthesis = buildMinimalSynthesis(drinkEvents);

    const { story } = buildEnhancedStoryWithKey(synthesis, timeline, today);

    expect(story).not.toBeNull();
    expect(story).toContain('run');
  });

  test('D2: Sep30 drinks + 10min activity (too short) → story does NOT mention activity', async () => {
    await AsyncStorage.setItem('drink_log', JSON.stringify([
      { date: SEP_30, totalDrinks: 2, totalCalories: 260 },
    ]));

    const drinkEvents = await deriveDrinkEvents();
    const timeline    = buildBaselineTimeline({ days: 14, sleepHours: 7.5 });
    const today: HealthDayRecord = {
      date:                OCT_1,
      sleepHours:          5.9,
      workoutDurationMin:  10,  // below 15-min gate
      primaryActivityType: 'Running',
    };
    const synthesis = buildMinimalSynthesis(drinkEvents);

    const { story } = buildEnhancedStoryWithKey(synthesis, timeline, today);

    expect(story).not.toBeNull();
    expect(story).not.toContain('run');
    expect(story).not.toContain('activity');
  });

  test('D3: Sep30 drinks + no workout → story fires, no activity mention', async () => {
    await AsyncStorage.setItem('drink_log', JSON.stringify([
      { date: SEP_30, totalDrinks: 2, totalCalories: 260 },
    ]));

    const drinkEvents = await deriveDrinkEvents();
    const timeline    = buildBaselineTimeline({ days: 14, sleepHours: 7.5 });
    const today: HealthDayRecord = { date: OCT_1, sleepHours: 5.9 };
    const synthesis = buildMinimalSynthesis(drinkEvents);

    const { story } = buildEnhancedStoryWithKey(synthesis, timeline, today);

    expect(story).not.toBeNull();
    expect(story).not.toMatch(/run|activity/i);
  });
});

// ─── E. Boundary conditions that stay null even after the sleep_activity fix ──

describe('E. Boundary conditions: cases that must NOT produce a story', () => {
  test('E1: Short sleep with NO workout → sleep_activity does not fire (no qualifying activity)', () => {
    // sleep_activity requires workoutDurationMin >= 15. Without it, branch skips.
    const timeline = buildBaselineTimeline({ days: 14, sleepHours: 7.5 });
    const today: HealthDayRecord = {
      date:       OCT_1,
      sleepHours: 5.9,
      // no workoutDurationMin
    };

    const physioState = buildPhysiologicalState(today, timeline);
    const layer = buildContextResponseContrastLayer([], null, physioState, timeline, today);
    expect(layer).toBeNull();

    const { story } = buildEnhancedStoryWithKey(
      buildMinimalSynthesis([]), timeline, today,
    );
    expect(story).toBeNull();
  });

  test('E2: Mild sleep dip (7.2h, near boundary) + 45min run → sleep_activity does not fire (only mild magnitude)', () => {
    // baseline p25=7.3, so 7.2 is below_baseline but magnitude='mild'.
    // sleep_activity gate requires moderate or substantial — mild is not notable enough.
    const timeline = buildBaselineTimeline({ days: 14, sleepHours: 7.5 });
    const today: HealthDayRecord = {
      date:                OCT_1,
      sleepHours:          7.2,
      workoutDurationMin:  45,
      primaryActivityType: 'Running',
    };

    const physioState = buildPhysiologicalState(today, timeline);
    const sleepFinding = physioState!.findings.find(f => f.metric === 'Sleep');
    expect(sleepFinding!.direction).toBe('below_baseline');
    expect(sleepFinding!.magnitude).toBe('mild');   // verify it's mild not moderate

    const layer = buildContextResponseContrastLayer([], null, physioState, timeline, today);
    expect(layer).toBeNull();
  });

  test('E3: Short sleep + 12min workout (under 15-min threshold) → sleep_activity does not fire', () => {
    const timeline = buildBaselineTimeline({ days: 14, sleepHours: 7.5 });
    const today: HealthDayRecord = {
      date:                OCT_1,
      sleepHours:          5.9,
      workoutDurationMin:  12,   // below 15-min gate
      primaryActivityType: 'Running',
    };

    const physioState = buildPhysiologicalState(today, timeline);
    const layer = buildContextResponseContrastLayer([], null, physioState, timeline, today);
    expect(layer).toBeNull();
  });
});

// ─── F. Source independence ───────────────────────────────────────────────────

describe('F. Source independence: alcohol story works with HK-only sleep (no Oura sync)', () => {
  beforeEach(async () => { await AsyncStorage.clear(); });

  test('F1: Oura-backed baseline but Oura not synced today (HK-only) + Sep30 alcohol → story fires (1 physio finding sufficient)', async () => {
    // Baseline has Oura metrics; today Oura hasn't synced yet (only HK sleepHours available).
    // Alcohol gate requires findings.length >= 1 — one is enough.
    await AsyncStorage.setItem('drink_log', JSON.stringify([
      { date: SEP_30, totalDrinks: 2, totalCalories: 260 },
    ]));

    const drinkEvents = await deriveDrinkEvents();
    const timeline    = buildBaselineTimeline({
      days: 14, sleepHours: 7.5, readiness: 75, hrv: 45, sleepScore: 72,
    });
    const today: HealthDayRecord = {
      date:       OCT_1,
      sleepHours: 5.9,
      // readiness, hrv, sleepScore absent — Oura not synced
    };
    const synthesis = buildMinimalSynthesis(drinkEvents);

    // Verify: physioState has exactly 1 finding (sleepHours only)
    const physioState = buildPhysiologicalState(today, timeline);
    expect(physioState!.findings.length).toBe(1);

    // Alcohol branch gate: alcoholEvent && findings.length >= 1 → passes
    const { story } = buildEnhancedStoryWithKey(synthesis, timeline, today);
    expect(story).not.toBeNull();
    expect(story).toContain('Last night');
  });

  test('F2: Pure HK (no Oura in baseline at all) + Sep30 alcohol → story fires', async () => {
    await AsyncStorage.setItem('drink_log', JSON.stringify([
      { date: SEP_30, totalDrinks: 2, totalCalories: 260 },
    ]));

    const drinkEvents = await deriveDrinkEvents();
    // HK-only baseline: no readiness/hrv/sleepScore in history
    const timeline    = buildBaselineTimeline({ days: 14, sleepHours: 7.5 });
    const today: HealthDayRecord = { date: OCT_1, sleepHours: 5.9 };
    const synthesis = buildMinimalSynthesis(drinkEvents);

    const { story } = buildEnhancedStoryWithKey(synthesis, timeline, today);
    expect(story).not.toBeNull();
    expect(story).toContain('Last night');
  });
});

// ─── G. sleep_activity fix: short sleep + run WITHOUT alcohol ─────────────────
//
// ARCHITECTURAL GAP (pre-fix):
//   Without the sleep_activity branch, 5.9h sleep + run alone cannot fire Your Story.
//   All non-alcohol branches in buildContextResponseContrastLayer require a
//   findMeaningfulContextEvent() match (illness/travel/stress/training_block) — which
//   won't exist for a spontaneous short night. Gate 1 (findings < 2) kills HK-only path.
//   Even with Oura (4 findings, Gate 1+2 pass), Branch 1 and Branch 3 both return null.
//
// FIX: A new 'sleep_activity' branch placed before Gate 1 (like alcohol) fires when:
//   - sleepHours is below_baseline with moderate or substantial magnitude
//   - workoutDurationMin >= 15
//   - No alcohol event (alcohol branch already handles that narrative)
//   - No active life event (illness/travel/stress provides a better frame)

describe('G. sleep_activity fix: short sleep + run without alcohol → story fires', () => {
  test('G1: HK-only 5.9h sleep + 45min run, no alcohol → contextType = sleep_activity', () => {
    const timeline = buildBaselineTimeline({ days: 14, sleepHours: 7.5 });
    const today: HealthDayRecord = {
      date:                OCT_1,
      sleepHours:          5.9,
      workoutDurationMin:  45,
      primaryActivityType: 'Running',
    };

    const physioState = buildPhysiologicalState(today, timeline);
    const layer = buildContextResponseContrastLayer([], null, physioState, timeline, today);

    expect(layer).not.toBeNull();
    expect(layer!.contextType).toBe('sleep_activity');
    expect(layer!.todayActivityMin).toBe(45);
    expect(layer!.todayActivityType).toBe('Running');
  });

  test('G2: Oura+HK 5.9h sleep + stable readiness/hrv + 45min run → contextType = sleep_activity', () => {
    const timeline = buildBaselineTimeline({
      days: 14, sleepHours: 7.5, readiness: 75, hrv: 45, sleepScore: 72,
    });
    const today: HealthDayRecord = {
      date:                OCT_1,
      sleepHours:          5.9,
      readiness:           75,
      hrv:                 45,
      sleepScore:          72,
      workoutDurationMin:  45,
      primaryActivityType: 'Running',
    };

    const physioState = buildPhysiologicalState(today, timeline);
    expect(physioState!.findings.length).toBe(4);  // Gate 1 would have passed anyway

    const layer = buildContextResponseContrastLayer([], null, physioState, timeline, today);

    expect(layer).not.toBeNull();
    expect(layer!.contextType).toBe('sleep_activity');
  });

  test('G3: Full chain — 5.9h sleep + 45min run, no alcohol → buildEnhancedStoryWithKey returns non-null story', () => {
    const timeline = buildBaselineTimeline({ days: 14, sleepHours: 7.5 });
    const today: HealthDayRecord = {
      date:                OCT_1,
      sleepHours:          5.9,
      workoutDurationMin:  45,
      primaryActivityType: 'Running',
    };
    const synthesis = buildMinimalSynthesis([]);   // no alcohol, no logged events

    const episode = buildStoryEpisode(synthesis, timeline, today);
    expect(episode.surfaceWorthy).toBe(true);
    expect(episode.contextResponseContrast).not.toBeNull();
    expect(episode.contextResponseContrast!.contextType).toBe('sleep_activity');

    const { story } = buildEnhancedStoryWithKey(synthesis, timeline, today);
    expect(story).not.toBeNull();
    expect(story).toContain('run');
  });

  test('G4: Alcohol event takes priority over sleep_activity when both conditions met', () => {
    const alcoholEvent: ContextEvent = {
      id:        `derived_drink_${SEP_30}`,
      type:      'alcohol_period',
      source:    'derived',
      startDate: SEP_30,
      endDate:   SEP_30,
      metadata:  { totalDrinks: 2 },
      createdAt: `${SEP_30}T23:59:00.000Z`,
      updatedAt: `${SEP_30}T23:59:00.000Z`,
    };

    const timeline = buildBaselineTimeline({ days: 14, sleepHours: 7.5 });
    const today: HealthDayRecord = {
      date:                OCT_1,
      sleepHours:          5.9,
      workoutDurationMin:  45,
      primaryActivityType: 'Running',
    };

    const physioState = buildPhysiologicalState(today, timeline);
    const layer = buildContextResponseContrastLayer(
      [alcoholEvent], null, physioState, timeline, today,
    );

    // Alcohol branch fires first; sleep_activity is skipped
    expect(layer!.contextType).toBe('alcohol_night');
  });
});

// ─── H. Story language: no causation, no guilt ───────────────────────────────

describe('H. Story language constraints: no causation, no moralizing', () => {
  beforeEach(async () => { await AsyncStorage.clear(); });

  test('H1: alcohol_night story contains no causation or guilt language', async () => {
    await AsyncStorage.setItem('drink_log', JSON.stringify([
      { date: SEP_30, totalDrinks: 2, totalCalories: 260 },
    ]));

    const drinkEvents = await deriveDrinkEvents();
    const timeline    = buildBaselineTimeline({ days: 14, sleepHours: 7.5 });
    const today: HealthDayRecord = {
      date:                OCT_1,
      sleepHours:          5.9,
      workoutDurationMin:  45,
      primaryActivityType: 'Running',
    };

    const { story } = buildEnhancedStoryWithKey(buildMinimalSynthesis(drinkEvents), timeline, today);

    expect(story).not.toBeNull();
    expect(story).not.toMatch(/caused|because of|due to|resulted in/i);
    expect(story).not.toMatch(/despite|even though|still managed/i);
    expect(story).not.toMatch(/poor choice|shouldn't|should have|next time try/i);
    // Must include the opener
    expect(story).toContain('Last night');
  });

  test('H2: sleep_activity story contains no causation or guilt language', () => {
    const timeline = buildBaselineTimeline({ days: 14, sleepHours: 7.5 });
    const today: HealthDayRecord = {
      date:                OCT_1,
      sleepHours:          5.9,
      workoutDurationMin:  45,
      primaryActivityType: 'Running',
    };

    const { story } = buildEnhancedStoryWithKey(buildMinimalSynthesis([]), timeline, today);

    expect(story).not.toBeNull();
    expect(story).not.toMatch(/caused|because of|due to|resulted in/i);
    expect(story).not.toMatch(/despite|even though|still managed/i);
    expect(story).not.toMatch(/poor choice|shouldn't|should have|next time try/i);
    // Factual: mentions shorter night and run
    expect(story).toContain('shorter');
    expect(story).toContain('run');
  });
});

// ─── I. Ordinary-day silence ──────────────────────────────────────────────────

describe('I. Ordinary-day silence: normal values, no events → story stays null', () => {
  test('I1: Normal sleep (7.5h), normal readiness (75), 30min workout, no events → story null', () => {
    const timeline = buildBaselineTimeline({
      days: 14, sleepHours: 7.5, readiness: 75, hrv: 45,
    });
    const today: HealthDayRecord = {
      date:               OCT_1,
      sleepHours:         7.5,
      readiness:          75,
      hrv:                45,
      workoutDurationMin: 30,
    };

    const { story } = buildEnhancedStoryWithKey(buildMinimalSynthesis([]), timeline, today);
    expect(story).toBeNull();
  });

  test('I2: Normal sleep + no workout → story null', () => {
    const timeline = buildBaselineTimeline({ days: 14, sleepHours: 7.5, readiness: 75 });
    const today: HealthDayRecord = {
      date:       OCT_1,
      sleepHours: 7.5,
      readiness:  75,
    };

    const { story } = buildEnhancedStoryWithKey(buildMinimalSynthesis([]), timeline, today);
    expect(story).toBeNull();
  });

  test('I3: Insufficient baseline (< 7 days) → physiologicalState null → story null', () => {
    // 5 days is below MIN_BASELINE_SAMPLES=7 for buildPhysiologicalState
    const timeline = buildBaselineTimeline({ days: 5, sleepHours: 7.5 });
    const today: HealthDayRecord = {
      date:                OCT_1,
      sleepHours:          5.9,
      workoutDurationMin:  45,
      primaryActivityType: 'Running',
    };

    const physioState = buildPhysiologicalState(today, timeline);
    expect(physioState).toBeNull();  // below MIN_BASELINE_SAMPLES

    const { story } = buildEnhancedStoryWithKey(buildMinimalSynthesis([]), timeline, today);
    expect(story).toBeNull();
  });
});
