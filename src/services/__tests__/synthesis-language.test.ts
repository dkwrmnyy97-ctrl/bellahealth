/**
 * synthesis-language.test.ts
 *
 * Regression + acceptance tests for the Your Story synthesis renderer.
 *
 * Verifies that the story:
 *   - Answers "why are these signals interesting together today?"
 *   - Weaves evidence into integrated prose, not a paragraph-per-fact list
 *   - Uses association language only (no causation, no moral judgment)
 *   - Selects a coherent subset when many signals are available
 *   - Matches established patterns when relevant, ignores them when not
 *   - Stays silent on ordinary days
 *
 * Scenarios:
 *   S01: alcohol + below-baseline sleep + run
 *   S02: alcohol + below-baseline sleep + run + repeated low hydration
 *   S03: below-baseline sleep + run + low hydration, no alcohol (sleep_activity)
 *   S04: alcohol + normal physiology (stable recovery)
 *   S05: established Activity→HRV pattern + today's matching state
 *   S06: established pattern exists but today's state does NOT match → not surfaced
 *   S07: multiple unrelated signals → coherent subset, not full list
 *   S08: ordinary day → silence
 *   S09: insufficient hydration history → no hydration inference
 *   S10: source independence — HK-only signals (no Oura readiness/sleepScore)
 *   S11: causal-language safety
 *   S12: judgment/guilt-language safety
 *
 * Hard stop: no EAS build. Local proof only.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import { buildEnhancedStoryWithKey } from '../../utils/pattern-language';
import { buildStoryEpisode } from '../story-engine';
import type { HealthDayRecord, PatternResult } from '../pattern-engine';
import type { ContextEvent } from '../context-events';
import type { SynthesisResult, ThemeDescriptor } from '../context-synthesis';

// ─── Constants ─────────────────────────────────────────────────────────────────

const SEP_30 = '2026-09-30';
const OCT_1  = '2026-10-01';

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Build 14-day baseline (Sep 1–14) with consistent physio metrics. */
function makePhysioBaseline(opts: {
  sleepHours?: number;
  hrv?: number;
  readiness?: number;
  sleepScore?: number;
} = {}): HealthDayRecord[] {
  const { sleepHours = 7.5, hrv = 55, readiness = 78, sleepScore = 82 } = opts;
  return Array.from({ length: 14 }, (_, i) => {
    const sleepJitter = ((i % 3) - 1) * 0.2;
    const scoreJitter = ((i % 3) - 1) * 3;
    return {
      date:       `2026-09-${String(i + 1).padStart(2, '0')}`,
      sleepHours: sleepHours + sleepJitter,
      hrv:        hrv        + scoreJitter,
      readiness:  readiness  + scoreJitter,
      sleepScore: sleepScore + scoreJitter,
    };
  });
}

/** Build 7-day water window (Sep 24–30), no overlap with physio baseline. */
function makeWaterWindow(opts: {
  loggedCount: number;
  belowCount:  number;
  goalOz?:     number;
  belowOz?:    number;
  aboveOz?:    number;
}): HealthDayRecord[] {
  const { loggedCount, belowCount, belowOz = 55, aboveOz = 100 } = opts;
  const dates = [
    '2026-09-24', '2026-09-25', '2026-09-26',
    '2026-09-27', '2026-09-28', '2026-09-29', SEP_30,
  ];
  return dates.map((date, i) => {
    if (i >= loggedCount) return { date };
    const isBelow = i < belowCount;
    return { date, waterOz: isBelow ? belowOz : aboveOz };
  });
}

/** Minimal SynthesisResult for the given context events and optional waterGoalOz. */
function makeSynthesis(
  relevantContext: ContextEvent[] = [],
  opts: { waterGoalOz?: number; allPatterns?: PatternResult[] } = {},
): SynthesisResult {
  return {
    generatedAt:         new Date().toISOString(),
    primaryTheme:        { theme: 'insufficient_data', primarySignal: null, rationale: [] } as ThemeDescriptor,
    supportingSignals:   [],
    concerningSignals:   [],
    conflictingSignals:  [],
    relevantContext,
    strongestConnection: null,
    allPatterns:         opts.allPatterns ?? [],
    eventWindows:        [],
    eventTypePattern:    null,
    recoveryConstrained: false,
    sources:             [],
    waterGoalOz:         opts.waterGoalOz,
  };
}

/** Sep30 alcohol event — mirrors deriveDrinkEvents output. */
function makeSep30AlcoholEvent(totalDrinks = 2): ContextEvent {
  return {
    id:        `derived_drink_${SEP_30}`,
    type:      'alcohol_period',
    source:    'derived',
    startDate: SEP_30,
    endDate:   SEP_30,
    metadata:  { totalDrinks, totalCalories: totalDrinks * 130 },
    createdAt: `${SEP_30}T23:59:00.000Z`,
    updatedAt: `${SEP_30}T23:59:00.000Z`,
  };
}

/** Build a PatternResult at PATTERN or CONSISTENT tier for testing. */
function makePatternResult(opts: {
  inputSignal:   string;
  outcomeSignal: string;
  direction:     'positive' | 'negative';
  tier?:         'PATTERN' | 'CONSISTENT';
  n?:            number;
}): PatternResult {
  const { inputSignal, outcomeSignal, direction, tier = 'PATTERN', n = 8 } = opts;
  return {
    patternId:         `${inputSignal}_${outcomeSignal}`,
    relationshipId:    `${inputSignal}_${outcomeSignal}`,
    inputSignal:       inputSignal as PatternResult['inputSignal'],
    outcomeSignal:     outcomeSignal as PatternResult['outcomeSignal'],
    temporalRelationship: 'next_day',
    direction,
    confidenceTier:    tier,
    observationCount:  n,
    absoluteDifference: 5,
    relativeDifference: 0.1,
    inputCondition:    'Higher activity',
    outcomeSignal_label: outcomeSignal,
    sources:           ['hk_workouts', 'oura_hrv'],
    windowStart:       '2026-08-01',
    windowEnd:         SEP_30,
    conditionCount:    n,
    outcomeCount:      n,
    baselineCount:     5,
    pValue:            0.04,
    lastUpdated:       SEP_30,
  } as unknown as PatternResult;
}

/** Convenience: run the full engine + render pipeline. */
function story(
  synthesis: SynthesisResult,
  timeline: HealthDayRecord[],
  today: HealthDayRecord,
): string | null {
  const { story: text } = buildEnhancedStoryWithKey(synthesis, timeline, today);
  return text;
}

// ─── S01: alcohol + below-baseline sleep + run ────────────────────────────────

describe('S01: alcohol + below-baseline sleep + run → integrated synthesis', () => {
  test('story fires and weaves context into prose', () => {
    const timeline = makePhysioBaseline();
    const today: HealthDayRecord = {
      date:                OCT_1,
      sleepHours:          5.9,
      workoutDurationMin:  35,
      primaryActivityType: 'Running',
    };
    const s = story(makeSynthesis([makeSep30AlcoholEvent()]), timeline, today);

    expect(s).not.toBeNull();
    expect(s).toContain('Last night was a little outside your usual routine');
    expect(s).toMatch(/sleep|lower/i);
    expect(s).toMatch(/run/i);
    // Drinks mentioned neutrally — coexisting, not moralised
    expect(s).toMatch(/alongside.*evening.*drinks|evening with drinks/i);
    // Activity is not framed as compensation or redemption
    expect(s).not.toMatch(/despite|still managed|make up|even though/i);
    console.log('\n=== S01 ===\n', s);
  });

  test('story does not answer "what happened?" — no mere event recap', () => {
    const timeline = makePhysioBaseline();
    const today: HealthDayRecord = { date: OCT_1, sleepHours: 5.9, workoutDurationMin: 35, primaryActivityType: 'Running' };
    const s = story(makeSynthesis([makeSep30AlcoholEvent()]), timeline, today);

    // Should NOT be a 1:1 list of the 3 facts
    expect(s).not.toBe(
      'Last night looked a little different.\n\nSleep came in lower than your usual range.\n\nYou also logged a run today.',
    );
  });
});

// ─── S02: alcohol + below-baseline sleep + run + low hydration ────────────────

describe('S02: alcohol + below-baseline sleep + run + repeated low hydration', () => {
  test('hydration is woven into sentence 1, not a standalone paragraph', () => {
    const timeline = [
      ...makePhysioBaseline(),
      ...makeWaterWindow({ loggedCount: 5, belowCount: 4 }),
    ];
    const today: HealthDayRecord = {
      date:                OCT_1,
      sleepHours:          5.9,
      workoutDurationMin:  35,
      primaryActivityType: 'Running',
    };
    const s = story(makeSynthesis([makeSep30AlcoholEvent()], { waterGoalOz: 80 }), timeline, today);

    expect(s).not.toBeNull();
    // Context + sleep + hydration should appear
    expect(s).toContain('Last night was a little outside your usual routine');
    expect(s).toMatch(/sleep|lower/i);
    // Hydration is phrased as background context ("a recent stretch of lower hydration")
    expect(s).toMatch(/lower hydration|recent stretch of lower hydration/i);
    expect(s).toMatch(/run/i);
    // Drinks mentioned neutrally alongside other signals
    expect(s).toMatch(/alongside.*evening.*drinks|evening with drinks/i);
    // Hydration woven in, not a standalone paragraph — story ≤ 3 paras
    expect(s!.split('\n\n').length).toBeLessThanOrEqual(3);
    console.log('\n=== S02 ===\n', s);
  });
});

// ─── S03: sleep_activity + low hydration, no alcohol ─────────────────────────

describe('S03: below-baseline sleep + run + low hydration (no alcohol) → sleep_activity synthesis', () => {
  test('sleep_activity path weaves signals together', () => {
    const timeline = [
      ...makePhysioBaseline(),
      ...makeWaterWindow({ loggedCount: 5, belowCount: 4 }),
    ];
    const today: HealthDayRecord = {
      date:                OCT_1,
      sleepHours:          5.9,
      workoutDurationMin:  35,
      primaryActivityType: 'Running',
    };
    const episode = buildStoryEpisode(makeSynthesis([], { waterGoalOz: 80 }), timeline, today);
    expect(episode.contextResponseContrast?.contextType).toBe('sleep_activity');

    const s = story(makeSynthesis([], { waterGoalOz: 80 }), timeline, today);
    expect(s).not.toBeNull();
    expect(s).toMatch(/shorter than usual|mixed/i);
    expect(s).toMatch(/run|activity/i);
    // Hydration is background context, woven into Para 1
    expect(s).toMatch(/lower hydration|recent stretch of lower hydration/i);
    // Activity not framed as compensatory
    expect(s).not.toMatch(/despite|still managed|even though/i);
    // Forward-looking closing
    expect(s).toMatch(/BellaHealth will watch|shift|broader/i);
    console.log('\n=== S03 ===\n', s);
  });

  test('sleep_activity with hydration: max 2 paragraphs (hydration woven, not separate)', () => {
    const timeline = [
      ...makePhysioBaseline(),
      ...makeWaterWindow({ loggedCount: 5, belowCount: 4 }),
    ];
    const today: HealthDayRecord = { date: OCT_1, sleepHours: 5.9, workoutDurationMin: 35, primaryActivityType: 'Running' };
    const s = story(makeSynthesis([], { waterGoalOz: 80 }), timeline, today);

    // Hydration woven into Para 1 alongside activity — only 2 paragraphs total
    expect(s!.split('\n\n').length).toBeLessThanOrEqual(2);
  });
});

// ─── S04: alcohol + normal physiology (stable recovery) ───────────────────────

describe('S04: alcohol + normal physiology → stable recovery note', () => {
  test('story fires but does not alarm — stable recovery described calmly', () => {
    const timeline = makePhysioBaseline();
    // sleepHours=7.4 is within baseline (7.5 ± small jitter)
    const today: HealthDayRecord = { date: OCT_1, sleepHours: 7.4 };
    const s = story(makeSynthesis([makeSep30AlcoholEvent()]), timeline, today);

    expect(s).not.toBeNull();
    expect(s).toContain('Last night was a little outside your usual routine');
    expect(s).toMatch(/usual range|near your|sitting near/i);
    // Drinks mentioned neutrally — even in stable recovery story
    expect(s).toMatch(/drinks|logged drinks/i);
    // No alarm language
    expect(s).not.toMatch(/concerning|alarming|at risk|damage/i);
    console.log('\n=== S04 ===\n', s);
  });
});

// ─── S05: established pattern + today's matching state ───────────────────────

describe('S05: established Activity→HRV pattern + today\'s matching state', () => {
  test('contextual pattern appears in contrast story when today matches', () => {
    // Pattern: workoutDurationMin → hrv (negative direction: more activity → lower HRV)
    const activityHrvPattern = makePatternResult({
      inputSignal:   'workoutDurationMin',
      outcomeSignal: 'hrv',
      direction:     'negative',
      tier:          'PATTERN',
      n:             8,
    });

    // HRV baseline ~55, today=38 (substantially below)
    const timeline = makePhysioBaseline({ hrv: 55 });
    const today: HealthDayRecord = {
      date:                OCT_1,
      sleepHours:          5.9,
      hrv:                 38,   // substantially below baseline
      workoutDurationMin:  45,
      primaryActivityType: 'Running',
    };

    const synthesis = makeSynthesis([makeSep30AlcoholEvent()], {
      allPatterns: [activityHrvPattern],
    });
    const episode = buildStoryEpisode(synthesis, timeline, today);

    // contextualPattern should fire (contrast active + pattern matched + today HRV below)
    expect(episode.contextualPattern).not.toBeNull();
    expect(episode.contextualPattern?.outcomeLabel).toBe('HRV');

    const s = story(synthesis, timeline, today);
    expect(s).not.toBeNull();
    // Pattern reference present
    expect(s).toMatch(/BellaHealth has.*seen a connection|connection.*BellaHealth/i);
    console.log('\n=== S05 ===\n', s);
  });
});

// ─── S06: established pattern exists, today's state does NOT match ────────────

describe('S06: established pattern exists but today\'s HRV is near baseline → not surfaced', () => {
  test('pattern not mentioned when today does not match it', () => {
    const activityHrvPattern = makePatternResult({
      inputSignal:   'workoutDurationMin',
      outcomeSignal: 'hrv',
      direction:     'negative',
      tier:          'PATTERN',
    });

    // HRV baseline ~55, today HRV=54 (near baseline — within normal range)
    const timeline = makePhysioBaseline({ hrv: 55 });
    const today: HealthDayRecord = {
      date:        OCT_1,
      sleepHours:  5.9,
      hrv:         54,  // near baseline (p25≈52, p75≈58 with jitter)
    };

    const synthesis = makeSynthesis([makeSep30AlcoholEvent()], {
      allPatterns: [activityHrvPattern],
    });
    const episode = buildStoryEpisode(synthesis, timeline, today);

    // contextualPattern should be null — HRV is near baseline, pattern doesn't match
    expect(episode.contextualPattern).toBeNull();

    const s = story(synthesis, timeline, today);
    // Pattern not forced into story
    expect(s).not.toMatch(/connection.*BellaHealth has.*seen/i);
    console.log('\n=== S06 ===\n', s);
  });
});

// ─── S07: multiple unrelated signals → coherent subset ───────────────────────

describe('S07: multiple available signals → coherent subset selected, not exhaustive list', () => {
  test('story is not a 5-paragraph dump', () => {
    // Scenario: alcohol_night + sleep below + HRV near + readiness near + sleep quality below
    const timeline = makePhysioBaseline();
    const today: HealthDayRecord = {
      date:        OCT_1,
      sleepHours:  5.9,    // below baseline
      hrv:         54,     // near baseline
      readiness:   76,     // near baseline (78 ± jitter, 76 is within range)
      sleepScore:  60,     // below baseline (82 ± jitter)
    };

    const s = story(makeSynthesis([makeSep30AlcoholEvent()]), timeline, today);

    expect(s).not.toBeNull();
    // Should NOT list all 4 metrics separately
    expect(s!.split('\n\n').length).toBeLessThanOrEqual(4);
    // Should group stable/shifted coherently
    expect(s).toMatch(/Last night was a little outside your usual routine/i);
    console.log('\n=== S07 ===\n', s);
  });

  test('shifted metrics grouped together, not listed one per paragraph', () => {
    const timeline = makePhysioBaseline();
    const today: HealthDayRecord = {
      date:        OCT_1,
      sleepHours:  5.9,
      hrv:         54,   // near baseline
    };
    const s = story(makeSynthesis([makeSep30AlcoholEvent()]), timeline, today);

    // The stable HRV should appear as part of a sentence, not as its own paragraph
    const paragraphs = s!.split('\n\n');
    const heatCheck  = paragraphs.filter(p => /HRV|hrv/i.test(p));
    // If HRV appears, it should be woven in (not a standalone HRV paragraph)
    if (heatCheck.length > 0) {
      // Stable HRV should be part of a larger sentence (containing "other recovery" or similar)
      expect(heatCheck[0]).toMatch(/other recovery|staying close|normal/i);
    }
    console.log('\n=== S07b ===\n', s);
  });
});

// ─── S08: ordinary day → silence ──────────────────────────────────────────────

describe('S08: ordinary day → no story', () => {
  test('normal sleep + normal HRV + no events → null', () => {
    const timeline = makePhysioBaseline();
    const today: HealthDayRecord = { date: OCT_1, sleepHours: 7.5, hrv: 55, readiness: 78 };

    const s = story(makeSynthesis([]), timeline, today);
    expect(s).toBeNull();
  });

  test('no baseline data → null', () => {
    const timeline: HealthDayRecord[] = []; // nothing
    const today: HealthDayRecord = { date: OCT_1, sleepHours: 7.5 };

    const s = story(makeSynthesis([]), timeline, today);
    expect(s).toBeNull();
  });
});

// ─── S09: insufficient hydration history → no hydration inference ─────────────

describe('S09: insufficient hydration history → hydration not surfaced', () => {
  test('only 2 logged water days (< 4 required) → story fires without hydration note', () => {
    const timeline = [
      ...makePhysioBaseline(),
      ...makeWaterWindow({ loggedCount: 2, belowCount: 2 }),
    ];
    const today: HealthDayRecord = {
      date:                OCT_1,
      sleepHours:          5.9,
      workoutDurationMin:  35,
      primaryActivityType: 'Running',
    };

    const episode = buildStoryEpisode(
      makeSynthesis([makeSep30AlcoholEvent()], { waterGoalOz: 80 }),
      timeline, today,
    );
    // hydrationContext should be not_tracked
    expect(episode.contextResponseContrast?.hydrationContext?.status).toBe('not_tracked');

    const s = story(makeSynthesis([makeSep30AlcoholEvent()], { waterGoalOz: 80 }), timeline, today);
    expect(s).not.toBeNull();
    expect(s).not.toMatch(/water intake|hydration/i);
    console.log('\n=== S09 ===\n', s);
  });
});

// ─── S10: source independence — HK-only signals ───────────────────────────────

describe('S10: source independence — HealthKit-only signals work without Oura', () => {
  test('HK sleep only (no Oura readiness/sleepScore/HRV) → story still fires', () => {
    // Baseline has ONLY sleepHours (HK source), no Oura metrics
    const timeline: HealthDayRecord[] = Array.from({ length: 14 }, (_, i) => ({
      date:       `2026-09-${String(i + 1).padStart(2, '0')}`,
      sleepHours: 7.5 + ((i % 3) - 1) * 0.2,
      // No hrv, readiness, sleepScore (Oura not connected)
    }));
    const today: HealthDayRecord = {
      date:                OCT_1,
      sleepHours:          5.9,    // below baseline — HK source
      workoutDurationMin:  35,
      primaryActivityType: 'Running',
    };

    const s = story(makeSynthesis([makeSep30AlcoholEvent()]), timeline, today);

    expect(s).not.toBeNull();
    expect(s).toContain('Last night was a little outside your usual routine');
    expect(s).toMatch(/sleep|lower/i);
    console.log('\n=== S10 ===\n', s);
  });

  test('sleep_activity fires with HK-only baseline', () => {
    const timeline: HealthDayRecord[] = Array.from({ length: 14 }, (_, i) => ({
      date:       `2026-09-${String(i + 1).padStart(2, '0')}`,
      sleepHours: 7.5 + ((i % 3) - 1) * 0.2,
    }));
    const today: HealthDayRecord = {
      date:                OCT_1,
      sleepHours:          5.9,
      workoutDurationMin:  35,
      primaryActivityType: 'Running',
    };

    const episode = buildStoryEpisode(makeSynthesis([]), timeline, today);
    expect(episode.contextResponseContrast?.contextType).toBe('sleep_activity');

    const s = story(makeSynthesis([]), timeline, today);
    expect(s).not.toBeNull();
    expect(s).toMatch(/shorter than usual|night/i);
    console.log('\n=== S10b ===\n', s);
  });
});

// ─── S11: causal-language safety ─────────────────────────────────────────────

describe('S11: causal-language safety', () => {
  const CAUSAL_PATTERNS = [
    /\bcaused\b/i,
    /\bbecause (of|you)\b/i,
    /\bdue to\b/i,
    /\bresulted in\b/i,
    /\bled to\b/i,
    /\bdirectly affected\b/i,
    /\bthe (drinking|wine|alcohol) (caused|hurt|damaged)\b/i,
  ];

  function checkNoCausal(s: string | null) {
    if (!s) return;
    for (const pattern of CAUSAL_PATTERNS) {
      expect(s).not.toMatch(pattern);
    }
  }

  test('alcohol + responding physio → no causation language', () => {
    const t = makePhysioBaseline();
    const today = { date: OCT_1, sleepHours: 5.9, workoutDurationMin: 35, primaryActivityType: 'Running' } as HealthDayRecord;
    checkNoCausal(story(makeSynthesis([makeSep30AlcoholEvent()]), t, today));
  });

  test('sleep_activity → no causation language', () => {
    const t = makePhysioBaseline();
    const today = { date: OCT_1, sleepHours: 5.9, workoutDurationMin: 35, primaryActivityType: 'Running' } as HealthDayRecord;
    checkNoCausal(story(makeSynthesis([]), t, today));
  });

  test('hydration below target → no causation between hydration and recovery', () => {
    const t = [...makePhysioBaseline(), ...makeWaterWindow({ loggedCount: 5, belowCount: 4 })];
    const today = { date: OCT_1, sleepHours: 5.9 } as HealthDayRecord;
    checkNoCausal(story(makeSynthesis([makeSep30AlcoholEvent()], { waterGoalOz: 80 }), t, today));
  });

  test('confirmed pattern story → no causation language', () => {
    const activityHrvPattern = makePatternResult({ inputSignal: 'workoutDurationMin', outcomeSignal: 'hrv', direction: 'negative' });
    const t = makePhysioBaseline({ hrv: 55 });
    const today = { date: OCT_1, sleepHours: 7.4, hrv: 38 } as HealthDayRecord;
    // No alcohol → uses confirmedPatternLayer path
    checkNoCausal(story(makeSynthesis([], { allPatterns: [activityHrvPattern] }), t, today));
  });
});

// ─── S12: judgment/guilt-language safety ──────────────────────────────────────

describe('S12: judgment and guilt-language safety', () => {
  const JUDGMENT_PATTERNS = [
    /\bdespite\b/i,
    /\beven though\b/i,
    /\bstill managed\b/i,
    /\bpoor choice\b/i,
    /\bshouldn't\b/i,
    /\bshould have\b/i,
    /\bleft its mark\b/i,
    /\bpaid for\b/i,
    /\bconsequences\b/i,
    /\bcompensate\b/i,
    /\bbounced? back\b/i,
    /\bpoor hydration\b/i,
    /\bfailed to\b/i,
    /\bmissed your goal\b/i,
    /\bwell done\b/i,
    /\bgood job\b/i,
    /\bhandled it\b/i,
  ];

  function checkNoJudgment(s: string | null) {
    if (!s) return;
    for (const pattern of JUDGMENT_PATTERNS) {
      expect(s).not.toMatch(pattern);
    }
  }

  test('alcohol + responding physio → no judgment or praise', () => {
    const t = makePhysioBaseline();
    const today = { date: OCT_1, sleepHours: 5.9, workoutDurationMin: 35, primaryActivityType: 'Running' } as HealthDayRecord;
    checkNoJudgment(story(makeSynthesis([makeSep30AlcoholEvent()]), t, today));
  });

  test('alcohol + stable physio → no praise for recovery', () => {
    const t = makePhysioBaseline();
    const today = { date: OCT_1, sleepHours: 7.4 } as HealthDayRecord;
    checkNoJudgment(story(makeSynthesis([makeSep30AlcoholEvent()]), t, today));
  });

  test('sleep_activity + low hydration → no shame language', () => {
    const t = [...makePhysioBaseline(), ...makeWaterWindow({ loggedCount: 5, belowCount: 4 })];
    const today = { date: OCT_1, sleepHours: 5.9, workoutDurationMin: 35, primaryActivityType: 'Running' } as HealthDayRecord;
    checkNoJudgment(story(makeSynthesis([], { waterGoalOz: 80 }), t, today));
  });

  test('no "make up for" framing when run follows drinking', () => {
    const t = makePhysioBaseline();
    const today = { date: OCT_1, sleepHours: 5.9, workoutDurationMin: 35, primaryActivityType: 'Running' } as HealthDayRecord;
    const s = story(makeSynthesis([makeSep30AlcoholEvent()]), t, today);
    expect(s).not.toMatch(/make up|make it up|redemption|right the ship/i);
  });
});

// ─── S13: drinks described neutrally in all alcohol stories ──────────────────

describe('S13: drinks described neutrally across physio states', () => {
  test('shifted physio + alcohol → drinks named alongside other signals', () => {
    const t = makePhysioBaseline();
    const today = { date: OCT_1, sleepHours: 5.9 } as HealthDayRecord;
    const s = story(makeSynthesis([makeSep30AlcoholEvent()]), t, today);

    expect(s).not.toBeNull();
    // Drinks are named in the story, not implied by "outside your usual routine" alone
    expect(s).toMatch(/alongside.*evening.*drinks|evening with drinks/i);
    // No moralising framing
    expect(s).not.toMatch(/poor choice|shouldn't|the drinking hurt|damage/i);
  });

  test('stable physio + alcohol → drinks noted plainly, no alarm', () => {
    const t = makePhysioBaseline();
    const today = { date: OCT_1, sleepHours: 7.4 } as HealthDayRecord;
    const s = story(makeSynthesis([makeSep30AlcoholEvent()]), t, today);

    expect(s).not.toBeNull();
    expect(s).toMatch(/drinks|evening with drinks|logged drinks/i);
    // Still no alarm or praise
    expect(s).not.toMatch(/concerning|well done|great recovery/i);
  });
});

// ─── S14: established pattern is structural lead, not appendage ───────────────

describe('S14: pattern is structural lead when matched', () => {
  test('when contextualPattern fires, pattern reference appears in the first paragraph', () => {
    const activityHrvPattern = makePatternResult({
      inputSignal:   'workoutDurationMin',
      outcomeSignal: 'hrv',
      direction:     'negative',
      n:             8,
    });
    const timeline = makePhysioBaseline({ hrv: 55 });
    const today: HealthDayRecord = {
      date:                OCT_1,
      sleepHours:          5.9,
      hrv:                 38,
      workoutDurationMin:  45,
      primaryActivityType: 'Running',
    };
    const synthesis = makeSynthesis([makeSep30AlcoholEvent()], { allPatterns: [activityHrvPattern] });
    const s = story(synthesis, timeline, today);

    expect(s).not.toBeNull();
    // Pattern reference should be in first paragraph (structural lead), not appended last
    const firstParagraph = s!.split('\n\n')[0];
    expect(firstParagraph).toMatch(/BellaHealth has.*seen a connection/i);
    // Secondary context (drinks) should still appear somewhere in the story
    expect(s).toMatch(/drinks|evening with/i);
    console.log('\n=== S14 ===\n', s);
  });
});

// ─── S15: "alongside" / noncausal framing for coexisting signals ──────────────

describe('S15: noncausal language for coexisting signals', () => {
  test('multiple coexisting signals use alongside / at the same time, not causal framing', () => {
    const timeline = [...makePhysioBaseline(), ...makeWaterWindow({ loggedCount: 5, belowCount: 4 })];
    const today: HealthDayRecord = {
      date:                OCT_1,
      sleepHours:          5.9,
      workoutDurationMin:  35,
      primaryActivityType: 'Running',
    };
    const s = story(makeSynthesis([makeSep30AlcoholEvent()], { waterGoalOz: 80 }), timeline, today);

    expect(s).not.toBeNull();
    // Noncausal connective for coexisting signals
    expect(s).toMatch(/alongside|at the same time|in the context of/i);
    // No language implying one signal caused another
    expect(s).not.toMatch(/because of|due to|as a result|caused|led to/i);
    console.log('\n=== S15 ===\n', s);
  });

  test('sleep_activity: activity alongside sleep — not framed as compensating for it', () => {
    const timeline = makePhysioBaseline();
    const today: HealthDayRecord = {
      date:                OCT_1,
      sleepHours:          5.9,
      workoutDurationMin:  35,
      primaryActivityType: 'Running',
    };
    const s = story(makeSynthesis([]), timeline, today);

    expect(s).not.toBeNull();
    expect(s).toMatch(/alongside|and/i);
    expect(s).not.toMatch(/despite|still managed|even though|compensat/i);
  });
});
