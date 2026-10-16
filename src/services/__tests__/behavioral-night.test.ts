/**
 * behavioral-night.test.ts
 *
 * Deterministic tests for the 4 AM behavioral-night cutoff.
 *
 * Product rule: events logged after midnight but before 04:00 local time belong
 * to the prior behavioral night. At 04:00 or later they belong to the current
 * calendar day.
 *
 * All tests pass an explicit `now` Date to findAlcoholNightEvent (via
 * buildContextResponseContrastLayer / buildStoryEpisode) so results are
 * identical regardless of when or where the test suite is run.
 *
 * Scenarios (per spec):
 *   1. 01:00 AM   → prior behavioral night  (early-morning spillover)
 *   2. 03:59 AM   → prior behavioral night  (one minute before cutoff)
 *   3. 04:00 AM   → current calendar day    (exactly at cutoff — not prior night)
 *   4. 04:01 AM   → current calendar day
 *   5. 11:30 PM + 01:00 AM drinks → combined into one behavioral-night session
 *   6. 01:00 AM alcohol + following sleep → story engine associates with prior night
 *   7. Timezone boundary — local Date constructor makes .getHours() deterministic
 *      in every host timezone; behavior must not depend on machine's UTC offset
 *   8. Daytime "now" → same results as a different daytime, no clock dependency
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import { buildContextResponseContrastLayer, buildPhysiologicalState } from '../story-engine';
import { buildEnhancedStoryWithKey } from '../../utils/pattern-language';
import type { HealthDayRecord } from '../pattern-engine';
import type { ContextEvent } from '../context-events';

// ─── Fixed test dates ──────────────────────────────────────────────────────────

const TODAY     = '2026-10-01'; // Oct 1 — the morning after
const YESTERDAY = '2026-09-30'; // Sep 30 — behavioral night

// ─── Clock fixtures ────────────────────────────────────────────────────────────
//
// Using `new Date(year, month, day, hours, minutes)` — the multi-arg Date
// constructor creates a date in LOCAL time, so `.getHours()` is always the
// stated value regardless of the host machine's UTC offset.
//
// This is the only way to write a clock-dependent test that is timezone-safe
// without mocking the entire system clock.

const at = (h: number, m = 0) => new Date(2026, 9, 1, h, m, 0); // Oct 1 local

const NOW_1_00AM  = at(1,  0);   // 01:00 — inside spillover window
const NOW_3_59AM  = at(3, 59);   // 03:59 — one minute before cutoff
const NOW_4_00AM  = at(4,  0);   // 04:00 — exactly at cutoff (NOT spillover)
const NOW_4_01AM  = at(4,  1);   // 04:01 — past cutoff
const NOW_2PM_A   = at(14, 0);   // 14:00 — normal daytime (reference)
const NOW_2PM_B   = at(14, 30);  // 14:30 — different daytime (same result expected)

// ─── Minimal fixtures ──────────────────────────────────────────────────────────

function makeAlcoholEvent(date: string, totalDrinks: number): ContextEvent {
  return {
    id:        `drink_${date}`,
    type:      'alcohol_period',
    source:    'derived',
    startDate: date,
    endDate:   date,
    metadata:  { totalDrinks, totalCalories: totalDrinks * 130 },
    createdAt: `${date}T23:00:00.000Z`,
    updatedAt: `${date}T23:00:00.000Z`,
  };
}

/** 14-day baseline: sleepHours=7.5 cycling with slight jitter for natural spread. */
function makeTimeline(): HealthDayRecord[] {
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date(TODAY + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - (13 - i));
    const date = d.toISOString().split('T')[0];
    const jitter = ((i % 3) - 1) * 0.2; // −0.2, 0, +0.2
    return { date, sleepHours: 7.5 + jitter };
  });
}

/** Today with sleep below baseline — provides ≥1 physio finding. */
function makeRespondingToday(): HealthDayRecord {
  return { date: TODAY, sleepHours: 5.9 };
}

// ─── Scenario 1: 01:00 AM — inside spillover window ───────────────────────────

describe('Scenario 1 — 01:00 AM: drinks on TODAY belong to prior behavioral night', () => {
  it('returns a non-null alcohol_night layer (drink dated today, logged at 1 AM)', () => {
    const today    = makeRespondingToday();
    const timeline = makeTimeline();
    const physio   = buildPhysiologicalState(today, timeline);

    // Drink dated TODAY (logged after midnight, before cutoff)
    const drinkToday = makeAlcoholEvent(TODAY, 2);

    const layer = buildContextResponseContrastLayer(
      [drinkToday], null, physio, timeline, today,
      undefined, undefined, NOW_1_00AM,
    );

    expect(layer).not.toBeNull();
    expect(layer!.contextType).toBe('alcohol_night');
  });

  it('suppression key anchors to YESTERDAY date (stable across the morning)', () => {
    const today    = makeRespondingToday();
    const timeline = makeTimeline();
    const physio   = buildPhysiologicalState(today, timeline);
    const drinkToday = makeAlcoholEvent(TODAY, 2);

    const layer = buildContextResponseContrastLayer(
      [drinkToday], null, physio, timeline, today,
      undefined, undefined, NOW_1_00AM,
    );

    // Suppression key uses the behavioral night's anchor (yesterday), not today
    expect(layer!.suppressionKey).toMatch(new RegExp(`^alcohol_${YESTERDAY}_`));
  });
});

// ─── Scenario 2: 03:59 AM — one minute before cutoff ─────────────────────────

describe('Scenario 2 — 03:59 AM: one minute before cutoff, still prior night', () => {
  it('returns alcohol_night layer at 03:59', () => {
    const today    = makeRespondingToday();
    const timeline = makeTimeline();
    const physio   = buildPhysiologicalState(today, timeline);
    const drinkToday = makeAlcoholEvent(TODAY, 2);

    const layer = buildContextResponseContrastLayer(
      [drinkToday], null, physio, timeline, today,
      undefined, undefined, NOW_3_59AM,
    );

    expect(layer).not.toBeNull();
    expect(layer!.contextType).toBe('alcohol_night');
  });
});

// ─── Scenario 3: 04:00 AM — exactly at cutoff, NOT spillover ─────────────────

describe('Scenario 3 — 04:00 AM: exactly at cutoff, no longer prior night', () => {
  it('returns null when drink is on TODAY and clock is exactly 04:00', () => {
    const today    = makeRespondingToday();
    const timeline = makeTimeline();
    const physio   = buildPhysiologicalState(today, timeline);

    // Drink dated TODAY only (no YESTERDAY entry)
    const drinkToday = makeAlcoholEvent(TODAY, 2);

    const layer = buildContextResponseContrastLayer(
      [drinkToday], null, physio, timeline, today,
      undefined, undefined, NOW_4_00AM,
    );

    // At the cutoff hour, TODAY drinks are NOT pulled into last night
    expect(layer).toBeNull();
  });

  it('still returns alcohol_night when drink is on YESTERDAY at 04:00', () => {
    const today    = makeRespondingToday();
    const timeline = makeTimeline();
    const physio   = buildPhysiologicalState(today, timeline);

    // Standard case: drink dated yesterday — works at any time of day
    const drinkYesterday = makeAlcoholEvent(YESTERDAY, 2);

    const layer = buildContextResponseContrastLayer(
      [drinkYesterday], null, physio, timeline, today,
      undefined, undefined, NOW_4_00AM,
    );

    expect(layer).not.toBeNull();
    expect(layer!.contextType).toBe('alcohol_night');
  });
});

// ─── Scenario 4: 04:01 AM — past cutoff ──────────────────────────────────────

describe('Scenario 4 — 04:01 AM: past cutoff, current day', () => {
  it('returns null for a TODAY drink at 04:01 — no spillover', () => {
    const today    = makeRespondingToday();
    const timeline = makeTimeline();
    const physio   = buildPhysiologicalState(today, timeline);
    const drinkToday = makeAlcoholEvent(TODAY, 2);

    const layer = buildContextResponseContrastLayer(
      [drinkToday], null, physio, timeline, today,
      undefined, undefined, NOW_4_01AM,
    );

    expect(layer).toBeNull();
  });
});

// ─── Scenario 5: 11:30 PM + 01:00 AM drinks → same behavioral-night session ──

describe('Scenario 5 — 11:30 PM + 01:00 AM drinks combined into one session', () => {
  /**
   * User had 2 drinks on Sep 30 at 11:30 PM (stored as YESTERDAY)
   * and 1 more drink on Oct 1 at 1:00 AM (stored as TODAY).
   * At 01:00 AM the engine is still in the spillover window → total = 3 drinks.
   */
  it('combines yesterday and early-today drinks into one session at 01:00 AM', () => {
    const today    = makeRespondingToday();
    const timeline = makeTimeline();
    const physio   = buildPhysiologicalState(today, timeline);

    const drinkYesterday = makeAlcoholEvent(YESTERDAY, 2); // 11:30 PM entry
    const drinkToday     = makeAlcoholEvent(TODAY, 1);     // 1:00 AM entry

    const layer = buildContextResponseContrastLayer(
      [drinkYesterday, drinkToday], null, physio, timeline, today,
      undefined, undefined, NOW_1_00AM,
    );

    expect(layer).not.toBeNull();
    expect(layer!.contextType).toBe('alcohol_night');
    // Combined count reflects the full session (2 + 1 = 3)
    expect(layer!.drinkCount).toBe(3);
  });

  it('at 04:00 AM the same scenario only counts yesterday drinks (today entry excluded)', () => {
    const today    = makeRespondingToday();
    const timeline = makeTimeline();
    const physio   = buildPhysiologicalState(today, timeline);

    const drinkYesterday = makeAlcoholEvent(YESTERDAY, 2);
    const drinkToday     = makeAlcoholEvent(TODAY, 1);

    const layer = buildContextResponseContrastLayer(
      [drinkYesterday, drinkToday], null, physio, timeline, today,
      undefined, undefined, NOW_4_00AM,
    );

    expect(layer).not.toBeNull();
    expect(layer!.contextType).toBe('alcohol_night');
    // At cutoff, only yesterday count (2) — today's 1 is NOT merged
    expect(layer!.drinkCount).toBe(2);
  });
});

// ─── Scenario 6: 01:00 AM alcohol + following sleep → story fires ─────────────

describe('Scenario 6 — 01:00 AM alcohol + sleep data: full story via buildEnhancedStoryWithKey', () => {
  beforeEach(async () => { await AsyncStorage.clear(); });

  it('story fires from full chain with drink dated today, logged at 01:00 AM', async () => {
    // Drink stored on Oct 1 (after midnight) — user logged it at 1 AM
    const drinkToday: ContextEvent = makeAlcoholEvent(TODAY, 2);

    const { buildMinimalSynthesis } = (() => {
      // Inline helper — avoids importing context-synthesis in this test
      const { SynthesisResult: _SynthesisResult, ...rest } = {} as never; void rest;
      function buildMinimalSynthesis(ctx: ContextEvent[]) {
        return {
          generatedAt:         new Date().toISOString(),
          primaryTheme:        { theme: 'insufficient_data' as const, primarySignal: null, rationale: [] },
          supportingSignals:   [],
          concerningSignals:   [],
          conflictingSignals:  [],
          relevantContext:     ctx,
          strongestConnection: null,
          allPatterns:         [],
          eventWindows:        [],
          eventTypePattern:    null,
          recoveryConstrained: false,
          sources:             [],
        };
      }
      return { buildMinimalSynthesis };
    })();

    const timeline  = makeTimeline();
    const today     = makeRespondingToday();
    const synthesis = buildMinimalSynthesis([drinkToday]);

    const { story } = buildEnhancedStoryWithKey(
      synthesis, timeline, today,
      undefined, undefined, NOW_1_00AM,
    );

    expect(story).not.toBeNull();
    expect(typeof story).toBe('string');
    // Story is about last night — mentions Last night
    expect(story).toContain('Last night');
  });

  it('same scenario at 04:00 AM produces null (drink is current-day, not prior night)', async () => {
    const drinkToday: ContextEvent = makeAlcoholEvent(TODAY, 2);

    function buildMinimalSynthesis(ctx: ContextEvent[]) {
      return {
        generatedAt:         new Date().toISOString(),
        primaryTheme:        { theme: 'insufficient_data' as const, primarySignal: null, rationale: [] },
        supportingSignals:   [],
        concerningSignals:   [],
        conflictingSignals:  [],
        relevantContext:     ctx,
        strongestConnection: null,
        allPatterns:         [],
        eventWindows:        [],
        eventTypePattern:    null,
        recoveryConstrained: false,
        sources:             [],
      };
    }

    const timeline  = makeTimeline();
    const today     = makeRespondingToday();
    const synthesis = buildMinimalSynthesis([drinkToday]);

    const { story } = buildEnhancedStoryWithKey(
      synthesis, timeline, today,
      undefined, undefined, NOW_4_00AM,
    );

    expect(story).toBeNull();
  });
});

// ─── Scenario 7: Timezone boundary — local Date constructor is deterministic ──

describe('Scenario 7 — Timezone boundary: local Date constructor is host-tz-independent', () => {
  /**
   * `new Date(2026, 9, 1, 1, 0, 0).getHours()` is ALWAYS 1 in any timezone.
   * `new Date('2026-10-01T01:00:00Z').getHours()` varies by UTC offset.
   *
   * All clock fixtures in this file use the multi-arg constructor so results
   * are identical on a developer's Mac in PST and on a UTC CI server.
   */
  it('NOW_1_00AM.getHours() is always 1, regardless of host timezone', () => {
    expect(NOW_1_00AM.getHours()).toBe(1);
  });

  it('NOW_4_00AM.getHours() is always 4, regardless of host timezone', () => {
    expect(NOW_4_00AM.getHours()).toBe(4);
  });

  it('NOW_3_59AM.getHours() is always 3, regardless of host timezone', () => {
    expect(NOW_3_59AM.getHours()).toBe(3);
  });

  it('1:00 AM — alcohol_night fires (uses local-time constructor)', () => {
    const today    = makeRespondingToday();
    const timeline = makeTimeline();
    const physio   = buildPhysiologicalState(today, timeline);
    const drinkToday = makeAlcoholEvent(TODAY, 2);

    const layer = buildContextResponseContrastLayer(
      [drinkToday], null, physio, timeline, today,
      undefined, undefined, new Date(2026, 9, 1, 1, 0, 0),
    );

    expect(layer).not.toBeNull();
    expect(layer!.contextType).toBe('alcohol_night');
  });

  it('4:00 AM — alcohol_night does NOT fire (at cutoff, not spillover)', () => {
    const today    = makeRespondingToday();
    const timeline = makeTimeline();
    const physio   = buildPhysiologicalState(today, timeline);
    const drinkToday = makeAlcoholEvent(TODAY, 2);

    const layer = buildContextResponseContrastLayer(
      [drinkToday], null, physio, timeline, today,
      undefined, undefined, new Date(2026, 9, 1, 4, 0, 0),
    );

    expect(layer).toBeNull();
  });
});

// ─── Scenario 8: Daytime now — results identical at different daytime values ──

describe('Scenario 8 — Daytime now: results are clock-independent at any daytime hour', () => {
  /**
   * Whether you run at 2:00 PM or 2:30 PM, the story result must be the same.
   * This verifies the engine's determinism contract: outside the spillover window,
   * the specific time of day is irrelevant.
   */
  it('standard yesterday drink: story fires at 14:00 and 14:30 identically', () => {
    const today    = makeRespondingToday();
    const timeline = makeTimeline();
    const physio   = buildPhysiologicalState(today, timeline);
    const drinkYesterday = makeAlcoholEvent(YESTERDAY, 2);

    const layerA = buildContextResponseContrastLayer(
      [drinkYesterday], null, physio, timeline, today,
      undefined, undefined, NOW_2PM_A,
    );
    const layerB = buildContextResponseContrastLayer(
      [drinkYesterday], null, physio, timeline, today,
      undefined, undefined, NOW_2PM_B,
    );

    expect(layerA).not.toBeNull();
    expect(layerB).not.toBeNull();
    expect(layerA!.contextType).toBe(layerB!.contextType);
    expect(layerA!.suppressionKey).toBe(layerB!.suppressionKey);
    expect(layerA!.drinkCount).toBe(layerB!.drinkCount);
  });

  it('TODAY drink (daytime): null at 14:00 and 14:30 identically', () => {
    const today    = makeRespondingToday();
    const timeline = makeTimeline();
    const physio   = buildPhysiologicalState(today, timeline);
    const drinkToday = makeAlcoholEvent(TODAY, 2);

    const layerA = buildContextResponseContrastLayer(
      [drinkToday], null, physio, timeline, today,
      undefined, undefined, NOW_2PM_A,
    );
    const layerB = buildContextResponseContrastLayer(
      [drinkToday], null, physio, timeline, today,
      undefined, undefined, NOW_2PM_B,
    );

    expect(layerA).toBeNull();
    expect(layerB).toBeNull();
  });

  it('no alcohol events: null at 14:00 and 14:30 identically', () => {
    const today    = makeRespondingToday();
    const timeline = makeTimeline();
    const physio   = buildPhysiologicalState(today, timeline);

    const layerA = buildContextResponseContrastLayer(
      [], null, physio, timeline, today,
      undefined, undefined, NOW_2PM_A,
    );
    const layerB = buildContextResponseContrastLayer(
      [], null, physio, timeline, today,
      undefined, undefined, NOW_2PM_B,
    );

    expect(layerA).toBeNull();
    expect(layerB).toBeNull();
  });
});

// ─── Cutoff boundary exhaustive sweep ────────────────────────────────────────

describe('Cutoff boundary sweep: every hour from 0 to 5', () => {
  /**
   * Exhaustive check: hours 0, 1, 2, 3 are inside the spillover window;
   * hours 4, 5 are outside it.
   */
  const SPILLOVER_HOURS = [0, 1, 2, 3];
  const CURRENT_DAY_HOURS = [4, 5];

  it.each(SPILLOVER_HOURS)(
    'hour %d: TODAY drink belongs to prior behavioral night (alcohol_night fires)',
    (h) => {
      const now      = at(h, 0);
      const today    = makeRespondingToday();
      const timeline = makeTimeline();
      const physio   = buildPhysiologicalState(today, timeline);
      const drinkToday = makeAlcoholEvent(TODAY, 2);

      const layer = buildContextResponseContrastLayer(
        [drinkToday], null, physio, timeline, today,
        undefined, undefined, now,
      );

      expect(layer).not.toBeNull();
      expect(layer!.contextType).toBe('alcohol_night');
    }
  );

  it.each(CURRENT_DAY_HOURS)(
    'hour %d: TODAY drink belongs to current day (alcohol_night does NOT fire)',
    (h) => {
      const now      = at(h, 0);
      const today    = makeRespondingToday();
      const timeline = makeTimeline();
      const physio   = buildPhysiologicalState(today, timeline);
      const drinkToday = makeAlcoholEvent(TODAY, 2);

      const layer = buildContextResponseContrastLayer(
        [drinkToday], null, physio, timeline, today,
        undefined, undefined, now,
      );

      expect(layer).toBeNull();
    }
  );
});
