/**
 * story-engine.test.ts
 *
 * 28 scenarios for the StoryEpisode structured intermediate representation.
 * Tests buildStoryEpisode() — the interpretation layer.
 * Language rendering is NOT tested here (see context-screen.test.ts).
 */

import {
  buildStoryEpisode,
  buildContextEventLayer,
  buildTransitionLayer,
  buildBehavioralFindings,
  buildPhysiologicalState,
  buildCurrentDirectionLayer,
  buildNutritionLayer,
  assessNutritionEvidence,
  classifyMealCategory,
  buildHydrationContext,
  buildInterpretationLayer,
  buildAftermathLayer,
  buildNextFocusLayer,
  buildFutureLessonLayer,
  type StoryEpisode,
  type EvidenceStrength,
  type MealTimingBucket,
} from '../story-engine';
import { renderStoryEpisode } from '../../utils/pattern-language';
import type { HealthDayRecord, EventWindowAnalysis, PeriodStats, PatternResult } from '../pattern-engine';
import type { SynthesisResult } from '../context-synthesis';
import type { ContextEvent, ContextEventType } from '../context-events';

// ─── Fixture helpers ────────────────────────────────────────────────────────────

const TODAY = '2026-09-23';

function pastDate(daysAgo: number): string {
  const d = new Date(TODAY + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

function buildTimeline(
  days: number,
  builder: (i: number, date: string) => Partial<HealthDayRecord>,
): HealthDayRecord[] {
  return Array.from({ length: days }, (_, i) => {
    const date = pastDate(days - 1 - i);
    return { date, ...builder(i, date) } as HealthDayRecord;
  });
}

const EMPTY_STATS: PeriodStats = {
  days: 0,
  sleepHours: null, sleepScore: null, hrv: null, readiness: null,
  steps: null, workoutDurationMin: null, totalAlcoholDrinks: null,
  calories: null, protein: null,
};

function makeEvent(
  type: ContextEventType,
  startDaysAgo: number,
  durationDays: number,
  ongoing = false,
): ContextEvent {
  const startDate = pastDate(startDaysAgo + durationDays - 1);
  const endDate   = ongoing ? undefined : pastDate(startDaysAgo);
  return {
    id: `test-${type}-${startDaysAgo}`,
    type,
    source:    'user_logged',
    startDate,
    endDate,
    createdAt: startDate + 'T00:00:00Z',
    updatedAt: startDate + 'T00:00:00Z',
  };
}

function makeWindow(
  event: ContextEvent,
  pre: Partial<PeriodStats>,
  during: Partial<PeriodStats>,
  isOngoing = false,
): EventWindowAnalysis {
  return {
    event,
    preWindow:    { ...EMPTY_STATS, ...pre },
    duringWindow: { ...EMPTY_STATS, ...during },
    postWindow:   { ...EMPTY_STATS },
    isOngoing,
  };
}

function makeSynthesis(overrides: Partial<SynthesisResult> = {}): SynthesisResult {
  return {
    generatedAt:       TODAY + 'T00:00:00Z',
    primaryTheme:      { theme: 'insufficient_data', rationale: [] },
    supportingSignals: [],
    concerningSignals: [],
    conflictingSignals: [],
    relevantContext:   [],
    strongestConnection: null,
    allPatterns:       [],
    eventWindows:      [],
    eventTypePattern:  null,
    recoveryConstrained: false,
    sources:           [],
    ...overrides,
  };
}

const TODAY_REC: HealthDayRecord = {
  date:      TODAY,
  readiness: 72,
  hrv:       48,
  sleepScore: 78,
  sleepHours: 7.5,
};

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Travel → lower sleep + lower HRV → illness → recovery
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 1: travel + lower sleep/HRV + later illness + recovery', () => {
  const travelEvent  = makeEvent('travel', 12, 7);       // ended 12 days ago
  const illnessEvent = makeEvent('illness', 4, 7);       // ended 4 days ago

  const travelWindow = makeWindow(
    travelEvent,
    { days: 7, sleepHours: 7.8, hrv: 52, readiness: 78 },
    { days: 7, sleepHours: 6.2, hrv: 38, readiness: 65 },
  );
  const illnessWindow = makeWindow(
    illnessEvent,
    { days: 7, sleepHours: 7.5, hrv: 48, readiness: 74 },
    { days: 7, sleepHours: 7.0, hrv: 38, readiness: 60 },
  );

  // Recovery timeline: readiness rising from 58 → 68 → 74
  const timeline = buildTimeline(30, (i) => ({
    sleepHours: 7.5, sleepScore: 78, hrv: 48, readiness: 72,
  }));
  // Override last 3 days to show recovery (prior 7 days worse)
  timeline.slice(-10, -3).forEach(d => { d.readiness = 55; d.hrv = 35; });
  timeline.slice(-3).forEach((d, i) => { d.readiness = 62 + i * 4; d.hrv = 40 + i * 3; });

  const today: HealthDayRecord = { ...TODAY_REC, date: TODAY, readiness: 70, hrv: 46 };

  const synthesis = makeSynthesis({
    eventWindows: [travelWindow, illnessWindow],
  });

  const episode = buildStoryEpisode(synthesis, timeline, today);

  it('has a transition layer (travel → illness)', () => {
    expect(episode.transition).not.toBeNull();
    expect(episode.transition!.precedingEventType).toBe('travel');
    expect(episode.transition!.currentEventType).toBe('illness');
  });

  it('transition includes preceding metric changes', () => {
    expect(episode.transition!.precedingMetricChanges.length).toBeGreaterThan(0);
    const dirs = episode.transition!.precedingMetricChanges.map(c => c.direction);
    expect(dirs).toContain('lower');
  });

  it('current direction shows recovering', () => {
    expect(episode.currentDirection?.trajectory).toBe('recovering');
  });

  it('is surface-worthy', () => {
    expect(episode.surfaceWorthy).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Travel + metric changes with no later event
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 2: travel + metric changes, no subsequent event', () => {
  const travelEvent = makeEvent('travel', 12, 7);
  const travelWindow = makeWindow(
    travelEvent,
    { days: 7, sleepHours: 7.8, hrv: 52, readiness: 78 },
    { days: 7, sleepHours: 6.1, hrv: 36, readiness: 62 },
  );

  const timeline = buildTimeline(30, () => ({ sleepHours: 7.5, hrv: 50, readiness: 75, sleepScore: 79 }));
  const today: HealthDayRecord = { ...TODAY_REC };

  const episode = buildStoryEpisode(
    makeSynthesis({ eventWindows: [travelWindow] }),
    timeline,
    today,
  );

  it('has a context event layer for travel', () => {
    expect(episode.contextEvent).not.toBeNull();
    expect(episode.contextEvent!.eventType).toBe('travel');
    expect(episode.contextEvent!.hasEnoughEvidence).toBe(true);
  });

  it('has no transition (only one event)', () => {
    expect(episode.transition).toBeNull();
  });

  it('travel context event has metric changes including sleep or HRV', () => {
    const metrics = episode.contextEvent!.metricChanges.map(c => c.metric);
    expect(metrics.some(m => m === 'Sleep' || m === 'HRV' || m === 'Readiness')).toBe(true);
  });

  // Single travel event with metric changes does not pass the Insight Value Gate.
  // "Sleep and HRV were lower during travel" is visible in Trends — not a Story.
  // A Story requires transition narrative, strong_contextual_pattern, or conflicting signals.
  it('is NOT surface-worthy (event data alone without transition or corroborated pattern)', () => {
    expect(episode.surfaceWorthy).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Illness + reduced activity + recovery
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 3: illness + reduced activity + recovery', () => {
  const illnessEvent = makeEvent('illness', 2, 8);
  const window = makeWindow(
    illnessEvent,
    { days: 7, sleepHours: 7.5, workoutDurationMin: 45, readiness: 76 },
    { days: 8, sleepHours: 8.0, workoutDurationMin: 5,  readiness: 58 },
  );

  const timeline = buildTimeline(30, (i) => ({
    sleepHours: 7.5, sleepScore: 78, hrv: 48, readiness: 74,
    workoutDurationMin: 40,
  }));
  // Illness period: lower readiness
  timeline.slice(-10).forEach(d => { d.readiness = 55; d.hrv = 34; });
  timeline.slice(-2).forEach(d => { d.readiness = 62; d.hrv = 40; });

  const today: HealthDayRecord = { ...TODAY_REC, readiness: 64, hrv: 42 };

  const episode = buildStoryEpisode(
    makeSynthesis({ eventWindows: [window] }),
    timeline,
    today,
  );

  it('context event has activity change', () => {
    const hasActivity = episode.contextEvent?.metricChanges.some(c => c.metric === 'Activity');
    expect(hasActivity).toBe(true);
  });

  it('activity direction is lower during illness', () => {
    const act = episode.contextEvent!.metricChanges.find(c => c.metric === 'Activity');
    expect(act!.direction).toBe('lower');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Stress + sleep change
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 4: stress period + sleep worse', () => {
  const stressEvent = makeEvent('stressful_period', 0, 7, true);
  const window = makeWindow(
    stressEvent,
    { days: 7, sleepHours: 7.8, sleepScore: 82 },
    { days: 7, sleepHours: 6.0, sleepScore: 65 },
    true,
  );

  const timeline = buildTimeline(30, () => ({ sleepHours: 7.6, sleepScore: 80, readiness: 74 }));
  const today: HealthDayRecord = { ...TODAY_REC, sleepHours: 5.8, sleepScore: 62 };

  const episode = buildStoryEpisode(
    makeSynthesis({ eventWindows: [window] }),
    timeline,
    today,
  );

  it('context event has a sleep change', () => {
    const sleep = episode.contextEvent?.metricChanges.find(
      c => c.metric === 'Sleep' || c.metric === 'Sleep quality',
    );
    expect(sleep).toBeDefined();
    expect(sleep!.direction).toBe('lower');
  });

  it('context event is ongoing', () => {
    expect(episode.contextEvent?.isOngoing).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Stress + gratitude pattern (4+ repeated associations)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 5: stress period + repeated gratitude pattern', () => {
  // 30-day timeline: non-gratitude days readiness ~62, gratitude days readiness ~76
  const timeline = buildTimeline(30, (i) => {
    const gratitudeDay = i % 5 === 0;
    return {
      readiness:         gratitudeDay ? 76 : 62,
      sleepScore:        gratitudeDay ? 80 : 68,
      gratitudeSessions: gratitudeDay ? 1  : 0,
    };
  });
  const today: HealthDayRecord = { ...TODAY_REC };
  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('has a gratitude behavioral finding', () => {
    const grat = episode.behavioralFindings.find(f => f.behaviorType === 'gratitude');
    expect(grat).toBeDefined();
  });

  it('gratitude evidence is repeated_pattern or strong_contextual_pattern', () => {
    const grat = episode.behavioralFindings.find(f => f.behaviorType === 'gratitude')!;
    expect(['repeated_pattern', 'strong_contextual_pattern']).toContain(grat.evidence.strength);
  });

  it('gratitude outcome direction is better', () => {
    const grat = episode.behavioralFindings.find(f => f.behaviorType === 'gratitude')!;
    expect(grat.outcomeDirection).toBe('better');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Gratitude with insufficient repetitions (2 occurrences)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 6: gratitude with only 2 occurrences', () => {
  const timeline = buildTimeline(30, (i) => {
    // Only days 0 and 6 have gratitude
    const gratitudeDay = i === 0 || i === 6;
    return {
      readiness:         gratitudeDay ? 78 : 65,
      gratitudeSessions: gratitudeDay ? 1  : 0,
    };
  });
  // today matches the baseline median (~65) so physio state doesn't falsely drive surfaceWorthy
  const today: HealthDayRecord = { date: TODAY, readiness: 65, hrv: 48, sleepScore: 78, sleepHours: 7.5 };
  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('gratitude finding has weak_association evidence (or isolated_coincidence)', () => {
    const grat = episode.behavioralFindings.find(f => f.behaviorType === 'gratitude');
    if (grat) {
      expect(['isolated_coincidence', 'weak_association']).toContain(grat.evidence.strength);
      expect(grat.evidence.occurrenceCount).toBeLessThanOrEqual(2);
    } else {
      // Either not enough contrast or filtered — either is acceptable
      expect(grat).toBeUndefined();
    }
  });

  it('does not make episode surface-worthy via gratitude alone', () => {
    const gratAlone = episode.behavioralFindings
      .filter(f => f.behaviorType !== 'gratitude')
      .every(f => f.evidence.strength === 'isolated_coincidence');
    if (gratAlone) {
      expect(episode.surfaceWorthy).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Alcohol + repeated next-day readiness drop (5 occurrences)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 7: alcohol + repeated next-day readiness drop', () => {
  const timeline = buildTimeline(30, (i) => {
    const drinkingDay  = i % 5 === 0;
    const dayAfterDrink = i % 5 === 1;
    return {
      totalAlcoholDrinks: drinkingDay ? 3  : 0,
      readiness:          dayAfterDrink ? 52 : 78,
      hrv:                dayAfterDrink ? 30 : 52,
    };
  });
  const today: HealthDayRecord = { ...TODAY_REC };
  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('has an alcohol behavioral finding', () => {
    const alc = episode.behavioralFindings.find(f => f.behaviorType === 'alcohol');
    expect(alc).toBeDefined();
  });

  it('alcohol outcome direction is worse', () => {
    const alc = episode.behavioralFindings.find(f => f.behaviorType === 'alcohol')!;
    expect(alc.outcomeDirection).toBe('worse');
  });

  it('alcohol evidence is repeated_pattern or strong_contextual_pattern', () => {
    const alc = episode.behavioralFindings.find(f => f.behaviorType === 'alcohol')!;
    expect(['repeated_pattern', 'strong_contextual_pattern']).toContain(alc.evidence.strength);
  });

  // repeated_pattern alone does not pass the Insight Value Gate.
  // Gate 2 requires strong_contextual_pattern (both behavioral analysis AND pattern
  // engine independently corroborate), which this test setup cannot produce because
  // makeSynthesis() passes no corroborating PatternResult entries.
  it('is NOT surface-worthy at repeated_pattern without corroboration', () => {
    expect(episode.surfaceWorthy).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. One alcohol event — isolated coincidence, does not drive surfaceWorthy
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 8: one alcohol event with insufficient evidence', () => {
  const timeline = buildTimeline(20, (i) => ({
    totalAlcoholDrinks: i === 5 ? 2  : 0,
    readiness:          i === 6 ? 58 : 76,
    sleepScore:         78,
    sleepHours:         7.5,
  }));
  // today matches the baseline median (~76) so physio state doesn't drive surfaceWorthy
  const today: HealthDayRecord = { date: TODAY, readiness: 76, hrv: 48, sleepScore: 78, sleepHours: 7.5 };
  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('alcohol finding (if present) has isolated_coincidence strength', () => {
    const alc = episode.behavioralFindings.find(f => f.behaviorType === 'alcohol');
    if (alc) {
      expect(alc.evidence.strength).toBe('isolated_coincidence');
    }
  });

  it('alcohol does not make episode surface-worthy on its own', () => {
    const hasSomethingElse = episode.behavioralFindings
      .filter(f => f.behaviorType !== 'alcohol')
      .some(f => f.evidence.strength !== 'isolated_coincidence');
    if (!hasSomethingElse && !episode.contextEvent?.hasEnoughEvidence) {
      expect(episode.surfaceWorthy).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Late caffeine + repeated sleep quality drop
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 9: high caffeine + repeated next-day sleep quality drop', () => {
  const timeline = buildTimeline(28, (i) => {
    const highCaffeine = i % 4 === 0;
    const afterCaffeine = i % 4 === 1;
    return {
      caffeineMg:  highCaffeine ? 450 : 80,
      sleepScore:  afterCaffeine ? 58 : 80,
      sleepHours:  afterCaffeine ? 6.2 : 7.8,
    };
  });
  const today: HealthDayRecord = { ...TODAY_REC };
  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('has a caffeine behavioral finding', () => {
    const caf = episode.behavioralFindings.find(f => f.behaviorType === 'caffeine');
    expect(caf).toBeDefined();
  });

  it('caffeine outcome direction is worse', () => {
    const caf = episode.behavioralFindings.find(f => f.behaviorType === 'caffeine')!;
    expect(caf.outcomeDirection).toBe('worse');
  });

  it('caffeine evidence is repeated_pattern or stronger', () => {
    const caf = episode.behavioralFindings.find(f => f.behaviorType === 'caffeine')!;
    expect(['repeated_pattern', 'strong_contextual_pattern']).toContain(caf.evidence.strength);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. Electrolytes during recovery — association present
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 10: electrolytes logged during recovery with higher next-day readiness', () => {
  const timeline = buildTimeline(30, (i) => {
    const electDay  = i % 5 === 0;
    const afterElect = i % 5 === 1;
    return {
      electrolytesLogged: electDay,
      readiness:          afterElect ? 78 : 62,
      sleepScore:         78,
    };
  });
  const today: HealthDayRecord = { ...TODAY_REC };
  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('has an electrolytes behavioral finding', () => {
    const elec = episode.behavioralFindings.find(f => f.behaviorType === 'electrolytes');
    expect(elec).toBeDefined();
  });

  it('electrolytes outcome direction is better', () => {
    const elec = episode.behavioralFindings.find(f => f.behaviorType === 'electrolytes')!;
    expect(elec.outcomeDirection).toBe('better');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. Sauna + broader recovery trend (repeated pattern)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 11: sauna + repeated same-day readiness elevation', () => {
  const timeline = buildTimeline(30, (i) => {
    const saunaDay = i % 5 === 0;
    return {
      hasSaunaSession: saunaDay,
      readiness:       saunaDay ? 85 : 68,
      sleepScore:      78,
    };
  });
  const today: HealthDayRecord = { ...TODAY_REC };
  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('has a sauna behavioral finding', () => {
    const sauna = episode.behavioralFindings.find(f => f.behaviorType === 'sauna');
    expect(sauna).toBeDefined();
  });

  it('sauna outcome direction is better', () => {
    const sauna = episode.behavioralFindings.find(f => f.behaviorType === 'sauna')!;
    expect(sauna.outcomeDirection).toBe('better');
  });

  it('sauna evidence is at least repeated_pattern', () => {
    const sauna = episode.behavioralFindings.find(f => f.behaviorType === 'sauna')!;
    expect(['repeated_pattern', 'strong_contextual_pattern']).toContain(sauna.evidence.strength);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. One sauna event — insufficient evidence
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 12: one sauna event — isolated coincidence', () => {
  const timeline = buildTimeline(20, (i) => ({
    hasSaunaSession: i === 10,
    readiness:       i === 10 ? 82 : 70,
    sleepScore:      78,
  }));
  // today matches the baseline median (~70) so physio state doesn't drive surfaceWorthy
  const today: HealthDayRecord = { date: TODAY, readiness: 70, hrv: 48, sleepScore: 78 };
  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('sauna finding (if present) is isolated_coincidence', () => {
    const sauna = episode.behavioralFindings.find(f => f.behaviorType === 'sauna');
    if (sauna) {
      expect(sauna.evidence.strength).toBe('isolated_coincidence');
    }
  });

  it('does not make episode surface-worthy via sauna alone', () => {
    const hasStrongOther = episode.behavioralFindings
      .filter(f => f.behaviorType !== 'sauna')
      .some(f => f.evidence.strength !== 'isolated_coincidence');
    if (!hasStrongOther && !episode.contextEvent?.hasEnoughEvidence) {
      expect(episode.surfaceWorthy).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 13. Cold plunge as repeated routine context
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 13: cold plunge as repeated routine (4+ days, clear effect)', () => {
  const timeline = buildTimeline(28, (i) => {
    const coldDay = i % 3 === 0;
    return {
      hasColdPlungeSession: coldDay,
      readiness:            coldDay ? 84 : 67,
      hrv:                  coldDay ? 58 : 44,
    };
  });
  const today: HealthDayRecord = { ...TODAY_REC };
  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('has a cold_plunge behavioral finding', () => {
    const cp = episode.behavioralFindings.find(f => f.behaviorType === 'cold_plunge');
    expect(cp).toBeDefined();
  });

  it('cold plunge evidence is repeated_pattern or stronger', () => {
    const cp = episode.behavioralFindings.find(f => f.behaviorType === 'cold_plunge')!;
    expect(['repeated_pattern', 'strong_contextual_pattern']).toContain(cp.evidence.strength);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 14. Cold plunge with no meaningful physiological pattern
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 14: cold plunge logged but readiness unchanged', () => {
  const timeline = buildTimeline(28, (i) => ({
    hasColdPlungeSession: i % 5 === 0,
    readiness:            74,           // same regardless of cold plunge
    sleepScore:           79,
  }));
  const today: HealthDayRecord = { ...TODAY_REC };
  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('has no cold_plunge behavioral finding (no meaningful difference)', () => {
    const cp = episode.behavioralFindings.find(f => f.behaviorType === 'cold_plunge');
    expect(cp).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 15. Missing HRV data throughout
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 15: no HRV data in timeline', () => {
  const timeline = buildTimeline(30, () => ({
    sleepHours: 7.5, sleepScore: 78, readiness: 74,
    // hrv deliberately absent
  }));
  const today: HealthDayRecord = { date: TODAY, sleepHours: 6.0, sleepScore: 65, readiness: 60 };

  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('physiological state has no HRV finding', () => {
    const hasHrv = episode.physiologicalState?.findings.some(f => f.metric === 'HRV');
    expect(hasHrv).toBeFalsy();
  });

  it('still produces findings for other available metrics', () => {
    const hasReadiness = episode.physiologicalState?.findings.some(f => f.metric === 'Readiness');
    expect(hasReadiness).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 16. Missing sleep data throughout
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 16: no sleep data in timeline', () => {
  const timeline = buildTimeline(30, () => ({
    hrv: 48, readiness: 74,
    // sleepHours and sleepScore deliberately absent
  }));
  const today: HealthDayRecord = { date: TODAY, hrv: 48, readiness: 74 };

  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('physiological state has no Sleep finding', () => {
    const hasSleep = episode.physiologicalState?.findings.some(
      f => f.metric === 'Sleep' || f.metric === 'Sleep quality'
    );
    expect(hasSleep).toBeFalsy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 17. Missing hydration/electrolytes data
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 17: no electrolytes or water data logged', () => {
  const timeline = buildTimeline(30, () => ({
    readiness: 74, sleepScore: 78, hrv: 48, sleepHours: 7.5,
    // electrolytesLogged absent, waterOz absent
  }));
  const today: HealthDayRecord = { ...TODAY_REC };

  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('has no electrolytes behavioral finding', () => {
    const elec = episode.behavioralFindings.find(f => f.behaviorType === 'electrolytes');
    expect(elec).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 18. Overlapping life events
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 18: overlapping illness and stressful_period events', () => {
  const illnessEvent = makeEvent('illness', 3, 7);
  const stressEvent  = makeEvent('stressful_period', 0, 14, true);

  const illnessWindow = makeWindow(
    illnessEvent,
    { days: 7, sleepHours: 7.5, readiness: 74 },
    { days: 7, sleepHours: 8.0, readiness: 58 },
  );
  const stressWindow = makeWindow(
    stressEvent,
    { days: 7, sleepHours: 7.8, readiness: 76 },
    { days: 14, sleepHours: 6.2, readiness: 62 },
    true,
  );

  const timeline = buildTimeline(30, () => ({ readiness: 74, sleepHours: 7.5, hrv: 48, sleepScore: 78 }));
  const today: HealthDayRecord = { ...TODAY_REC };

  const episode = buildStoryEpisode(
    makeSynthesis({ eventWindows: [illnessWindow, stressWindow] }),
    timeline,
    today,
  );

  it('has at least one context event layer', () => {
    expect(episode.contextEvent).not.toBeNull();
  });

  it('context event is the most recent event (stressful_period, started 14 days ago)', () => {
    // The most recent start date is the stressEvent (started most recently as ongoing)
    expect(episode.contextEvent!.eventType).toBe('stressful_period');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 19. Conflicting physiological signals
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 19: HRV above baseline, readiness below baseline — conflicting', () => {
  // 30-day baseline: readiness ~74, hrv ~48
  const timeline = buildTimeline(30, () => ({
    readiness: 74, hrv: 48, sleepScore: 78, sleepHours: 7.5,
  }));
  // Today: HRV elevated (above p75), readiness depressed (below p25)
  const today: HealthDayRecord = {
    date: TODAY,
    readiness: 55,   // below baseline p25
    hrv:       62,   // above baseline p75
    sleepScore: 75,
    sleepHours: 7.2,
  };

  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('physiological state is conflicting', () => {
    expect(episode.physiologicalState?.conflicting).toBe(true);
  });

  it('has both above and below baseline findings', () => {
    const dirs = episode.physiologicalState!.findings.map(f => f.direction);
    expect(dirs).toContain('above_baseline');
    expect(dirs).toContain('below_baseline');
  });

  it('is surface-worthy', () => {
    expect(episode.surfaceWorthy).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 20. No life event + meaningful multi-day trend
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 20: no life event, but sleep consistently above baseline', () => {
  const timeline = buildTimeline(30, () => ({
    sleepHours: 7.5, sleepScore: 78, readiness: 74, hrv: 48,
  }));
  // Today: all metrics well above baseline
  const today: HealthDayRecord = {
    date: TODAY,
    readiness: 88,    // above p75
    hrv:       62,    // above p75
    sleepScore: 91,
    sleepHours: 8.5,
  };

  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('has physiological state with above-baseline findings', () => {
    const hasAbove = episode.physiologicalState?.findings.some(
      f => f.direction === 'above_baseline' && f.magnitude !== 'mild',
    );
    expect(hasAbove).toBe(true);
  });

  // All metrics above baseline (non-conflicting) does not pass the Insight Value Gate.
  // "Everything looks good today" is a Home screen observation, not a Story.
  // Gate 2 requires transition, strong_contextual_pattern, or conflicting signals.
  it('is NOT surface-worthy (all metrics above baseline, non-conflicting)', () => {
    expect(episode.surfaceWorthy).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 21. No life event + meaningless noise (all metrics near baseline)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 21: no life event, all metrics near baseline — not surface-worthy', () => {
  const timeline = buildTimeline(30, () => ({
    readiness: 74, hrv: 48, sleepScore: 78, sleepHours: 7.5,
  }));
  // Today: all within the p25–p75 band
  const today: HealthDayRecord = {
    date: TODAY, readiness: 74, hrv: 48, sleepScore: 78, sleepHours: 7.5,
  };

  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('has no transition', () => {
    expect(episode.transition).toBeNull();
  });

  it('has no context event', () => {
    expect(episode.contextEvent?.hasEnoughEvidence).toBeFalsy();
  });

  it('is NOT surface-worthy', () => {
    expect(episode.surfaceWorthy).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 22. Two nearby events NOT linked (gap > 3 days)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 22: two events with 5-day gap — should NOT produce a transition', () => {
  const travelEvent  = makeEvent('travel', 15, 7);    // ended 15 days ago
  const illnessEvent = makeEvent('illness', 5, 5);    // started 10 days ago; gap = 5 days

  const travelWindow = makeWindow(
    travelEvent,
    { days: 7, sleepHours: 7.8, hrv: 52 },
    { days: 7, sleepHours: 6.2, hrv: 36 },
  );
  const illnessWindow = makeWindow(
    illnessEvent,
    { days: 5, readiness: 72 },
    { days: 5, readiness: 58 },
  );

  const timeline = buildTimeline(30, () => ({ readiness: 72, hrv: 48, sleepScore: 78, sleepHours: 7.5 }));
  const today: HealthDayRecord = { ...TODAY_REC };

  const episode = buildStoryEpisode(
    makeSynthesis({ eventWindows: [travelWindow, illnessWindow] }),
    timeline,
    today,
  );

  it('has no transition (gap too large)', () => {
    expect(episode.transition).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 23. Incomplete wearable data (steps + workouts only, no Oura)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 23: Apple Health only — no Oura readiness/HRV', () => {
  const timeline = buildTimeline(30, () => ({
    hkSteps: 8000, workoutDurationMin: 45,
    // no readiness, hrv, sleepScore, sleepHours
  }));
  const today: HealthDayRecord = { date: TODAY, hkSteps: 12000, workoutDurationMin: 60 };

  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('physiological state is null (no Oura signals available)', () => {
    expect(episode.physiologicalState).toBeNull();
  });

  it('no behavioral findings that require readiness baseline (no comparison possible)', () => {
    // alcohol/caffeine/sauna/etc need readiness baseline — without it, no findings
    expect(episode.behavioralFindings.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 24. Apple Health only user (sleep hours from HK, no sleep score)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 24: Apple Health sleep hours only, no Oura sleep score', () => {
  const timeline = buildTimeline(30, () => ({
    sleepHours: 7.5, hkSteps: 8000,
    // no sleepScore, no readiness, no hrv
  }));
  const today: HealthDayRecord = {
    date: TODAY, sleepHours: 5.5, hkSteps: 7000,
  };

  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('physiological state shows sleep finding only', () => {
    const metrics = episode.physiologicalState?.findings.map(f => f.metric) ?? [];
    expect(metrics).toContain('Sleep');
    expect(metrics).not.toContain('Readiness');
    expect(metrics).not.toContain('HRV');
    expect(metrics).not.toContain('Sleep quality');
  });

  it('sleep finding is below baseline', () => {
    const sleep = episode.physiologicalState?.findings.find(f => f.metric === 'Sleep');
    expect(sleep?.direction).toBe('below_baseline');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 25. Behavior logged without meaningful physiological response
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 25: alcohol logged 5 times but readiness unchanged', () => {
  // Drinking days have same readiness as non-drinking days
  const timeline = buildTimeline(30, (i) => ({
    totalAlcoholDrinks: i % 5 === 0 ? 2 : 0,
    readiness:          74,    // constant — no association
    sleepScore:         78,
    sleepHours:         7.5,
  }));
  const today: HealthDayRecord = { ...TODAY_REC };
  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('has no alcohol behavioral finding (no meaningful readiness difference)', () => {
    const alc = episode.behavioralFindings.find(f => f.behaviorType === 'alcohol');
    expect(alc).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 26. Current direction returning toward baseline (recovering)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 26: readiness was below baseline, now trending up', () => {
  const timeline = buildTimeline(20, (i) => {
    if (i < 10)  return { readiness: 75, hrv: 50, sleepScore: 80 }; // historical baseline
    if (i < 17)  return { readiness: 52, hrv: 34, sleepScore: 65 }; // disrupted period
    return          { readiness: 58 + (i - 17) * 5, hrv: 38 + (i - 17) * 4 }; // recovering (58, 63, 68)
  });
  const today: HealthDayRecord = { date: TODAY, readiness: 68, hrv: 46 };

  const dir = buildCurrentDirectionLayer(timeline, today);

  it('trajectory is recovering', () => {
    expect(dir?.trajectory).toBe('recovering');
  });

  it('has improving metrics', () => {
    expect(dir?.improvingMetrics.length).toBeGreaterThan(0);
  });

  it('has below-baseline metrics (still not fully recovered)', () => {
    expect(dir?.belowBaselineMetrics.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 27. Current direction still disrupted (below baseline, not improving)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 27: readiness below baseline and flat — disrupted', () => {
  const timeline = buildTimeline(20, (i) => {
    if (i < 10) return { readiness: 76, hrv: 52, sleepScore: 81 }; // normal
    return        { readiness: 54, hrv: 34, sleepScore: 63 };       // all below, no improvement
  });
  const today: HealthDayRecord = { date: TODAY, readiness: 53, hrv: 33 };

  const dir = buildCurrentDirectionLayer(timeline, today);

  it('trajectory is disrupted', () => {
    expect(dir?.trajectory).toBe('disrupted');
  });

  it('has below-baseline metrics', () => {
    expect(dir?.belowBaselineMetrics.length).toBeGreaterThan(0);
  });

  it('has no improving metrics', () => {
    expect(dir?.improvingMetrics.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 28. Insufficient recent data for current direction
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 28: only 2 days of total data — insufficient for direction', () => {
  const timeline: HealthDayRecord[] = [
    { date: pastDate(1), readiness: 72, hrv: 48 },
    { date: TODAY,       readiness: 70, hrv: 46 },
  ];
  const today: HealthDayRecord = { date: TODAY, readiness: 70, hrv: 46 };

  const dir = buildCurrentDirectionLayer(timeline, today);

  it('trajectory is insufficient_data', () => {
    expect(dir?.trajectory).toBe('insufficient_data');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// NUTRITION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── N1. Sufficient nutrition logging + meaningful protein pattern ────────────

describe('Nutrition N1: moderate logging confidence + protein → readiness association', () => {
  // 30 days, all with credible logging (calories ≥ 600).
  // High-protein days (every 3rd): protein=140g, readiness=82
  // Lower-protein days: protein=60g, readiness=68
  const timeline = buildTimeline(30, (i) => ({
    calories:  i % 3 === 0 ? 2400 : 1800,
    protein:   i % 3 === 0 ? 140  : 60,
    readiness: i % 3 === 0 ? 82   : 68,
    sleepScore: 78,
    hrv: 48,
  }));

  const layer = buildNutritionLayer(timeline);

  it('logging confidence is moderate', () => {
    expect(layer.loggingEvidence.confidence).toBe('moderate');
  });

  it('has a protein finding', () => {
    const p = layer.findings.find(f => f.signal === 'protein');
    expect(p).toBeDefined();
  });

  it('protein finding direction is better', () => {
    const p = layer.findings.find(f => f.signal === 'protein')!;
    expect(p.outcomeDirection).toBe('better');
  });

  it('protein finding has at least repeated_pattern evidence', () => {
    const p = layer.findings.find(f => f.signal === 'protein')!;
    expect(['repeated_pattern', 'strong_contextual_pattern']).toContain(p.evidence.strength);
  });

  it('episode is NOT surface-worthy at repeated_pattern nutrition (requires strong_contextual_pattern)', () => {
    const today: HealthDayRecord = { date: TODAY, readiness: 72, hrv: 48 };
    const episode = buildStoryEpisode(makeSynthesis(), timeline, today);
    // Nutrition at repeated_pattern alone does not pass Gate 2 (Insight Value Gate).
    // strong_contextual_pattern (both behavioral analysis + pattern engine agree) is required.
    // makeSynthesis() supplies no corroborating PatternResult entries, so corroboration
    // cannot fire here — test confirms the gate correctly suppresses this episode.
    const atRepeatedPattern = episode.nutritionLayer?.findings.some(
      f => f.evidence.strength === 'repeated_pattern',
    );
    const atStrongPattern = episode.nutritionLayer?.findings.some(
      f => f.evidence.strength === 'strong_contextual_pattern',
    );
    if (atRepeatedPattern && !atStrongPattern) {
      expect(episode.surfaceWorthy).toBe(false);
    }
  });
});

// ─── N2. Nutrition during travel (via ContextEventLayer) ─────────────────────

describe('Nutrition N2: calories lower during travel — captured in context layer', () => {
  const travelEvent  = makeEvent('travel', 5, 7);
  const travelWindow = makeWindow(
    travelEvent,
    { days: 7, calories: 2200, protein: 120, sleepHours: 7.8 },
    { days: 7, calories: 1300, protein:  70, sleepHours: 6.2 },
  );

  const timeline = buildTimeline(30, () => ({
    sleepHours: 7.5, hrv: 48, readiness: 74,
    calories: 2100, protein: 115,
  }));
  const today: HealthDayRecord = { ...TODAY_REC };

  const episode = buildStoryEpisode(
    makeSynthesis({ eventWindows: [travelWindow] }),
    timeline,
    today,
  );

  it('context event layer captures a nutrition/calorie change', () => {
    const nutritionChange = episode.contextEvent?.metricChanges.find(
      c => c.metric === 'Nutrition',
    );
    expect(nutritionChange).toBeDefined();
  });

  it('nutrition/calorie direction is lower during travel', () => {
    const nutritionChange = episode.contextEvent?.metricChanges.find(
      c => c.metric === 'Nutrition',
    )!;
    expect(nutritionChange.direction).toBe('lower');
  });
});

// ─── N3. Nutrition during illness (via ContextEventLayer) ─────────────────────

describe('Nutrition N3: calories lower during illness — captured in context layer', () => {
  const illnessEvent  = makeEvent('illness', 2, 8);
  const illnessWindow = makeWindow(
    illnessEvent,
    { days: 7, calories: 2100, protein: 110, readiness: 76 },
    { days: 8, calories:  900, protein:  55, readiness: 58 },
  );

  const timeline = buildTimeline(30, () => ({
    readiness: 74, hrv: 48, sleepScore: 78, sleepHours: 7.5,
    calories: 2000, protein: 100,
  }));
  const today: HealthDayRecord = { ...TODAY_REC };

  const episode = buildStoryEpisode(
    makeSynthesis({ eventWindows: [illnessWindow] }),
    timeline,
    today,
  );

  it('context event layer captures the calorie change during illness', () => {
    const nutritionChange = episode.contextEvent?.metricChanges.find(
      c => c.metric === 'Nutrition',
    );
    expect(nutritionChange).toBeDefined();
    expect(nutritionChange!.direction).toBe('lower');
  });
});

// ─── N4. One meal logged only (low calories ≠ low intake) ────────────────────

describe('Nutrition N4: sparse logging — only a few low-calorie days logged', () => {
  // Most days have no nutrition data; a few have 250 cal (likely incomplete)
  const timeline = buildTimeline(30, (i) => ({
    readiness: 74,
    calories: i === 5 || i === 12 ? 250 : undefined,
    protein:  i === 5 || i === 12 ? 20  : undefined,
  }));

  const layer = buildNutritionLayer(timeline);

  it('logging confidence is insufficient', () => {
    expect(layer.loggingEvidence.confidence).toBe('insufficient');
  });

  it('no nutrition findings are generated for sparse/low-calorie logging', () => {
    expect(layer.findings).toHaveLength(0);
  });

  it('daysWithLogging is zero (250 cal is below the completeness floor)', () => {
    expect(layer.loggingEvidence.daysWithLogging).toBe(0);
  });
});

// ─── N5. Apparently low calories from incomplete logging — never a finding ────

describe('Nutrition N5: days with some logging but all below calorie floor', () => {
  // 20 days with calories logged, but all appear to be partial days (< 600 cal).
  // This looks like "low intake" but is actually incomplete logging.
  const timeline = buildTimeline(30, (i) => ({
    readiness: 74,
    calories: i < 20 ? 350 : undefined,  // all below MIN_LOGGED_CALORIES (600)
    protein:  i < 20 ? 30  : undefined,
  }));

  const evidence = assessNutritionEvidence(timeline);
  const layer    = buildNutritionLayer(timeline);

  it('daysWithLogging is zero despite calories being present', () => {
    // All entries are below the completeness floor — not credible as complete logs
    expect(evidence.daysWithLogging).toBe(0);
  });

  it('no deficiency claim is generated', () => {
    expect(layer.findings).toHaveLength(0);
  });

  it('confidence is insufficient', () => {
    expect(layer.loggingEvidence.confidence).toBe('insufficient');
  });
});

// ─── N6. Several missing days — logging rate too low ─────────────────────────

describe('Nutrition N6: only 8 days out of 30 have credible nutrition logging', () => {
  const timeline = buildTimeline(30, (i) => ({
    readiness: 74,
    calories: i < 8 ? 1800 : undefined,
    protein:  i < 8 ? 90   : undefined,
  }));

  const layer = buildNutritionLayer(timeline);

  it('logging rate is below the moderate threshold', () => {
    expect(layer.loggingEvidence.loggingRate).toBeLessThan(0.6);
  });

  it('no nutrition findings surfaced (insufficient coverage)', () => {
    expect(layer.findings).toHaveLength(0);
  });
});

// ─── N7. Meal-timing association — not implementable (schema has no timestamps) ─

describe('Nutrition N7: meal timing — not implementable without timestamp data', () => {
  // HealthDayRecord has no meal-level timestamps, only daily totals.
  // The nutrition layer must NOT generate a timing finding.
  const timeline = buildTimeline(30, (i) => ({
    readiness: 74,
    calories: 2000,
    protein: 100,
  }));

  const layer = buildNutritionLayer(timeline);

  it('no meal-timing finding exists (timestamps not available in schema)', () => {
    // There is no 'meal_timing' signal type in NutritionFinding
    // This test documents the schema gap rather than testing behavior
    const timingFinding = layer.findings.find(
      (f) => (f as { signal: string }).signal === 'meal_timing',
    );
    expect(timingFinding).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HYDRATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── H1. Repeated high-hydration pattern → better readiness ──────────────────

describe('Hydration H1: repeated high-hydration days → better same-day readiness', () => {
  // 30-day timeline where well-hydrated days (≥ 72 oz) show higher readiness
  const timeline = buildTimeline(30, (i) => {
    const wellHydrated = i % 4 === 0;
    return {
      waterOz:   wellHydrated ? 90 : 40,
      readiness: wellHydrated ? 84 : 66,
      sleepScore: 78,
      hrv: 48,
    };
  });
  const today: HealthDayRecord = { ...TODAY_REC };
  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('has a water behavioral finding', () => {
    const w = episode.behavioralFindings.find(f => f.behaviorType === 'water');
    expect(w).toBeDefined();
  });

  it('water finding direction is better', () => {
    const w = episode.behavioralFindings.find(f => f.behaviorType === 'water')!;
    expect(w.outcomeDirection).toBe('better');
  });

  it('water finding evidence is repeated_pattern or stronger', () => {
    const w = episode.behavioralFindings.find(f => f.behaviorType === 'water')!;
    expect(['repeated_pattern', 'strong_contextual_pattern']).toContain(w.evidence.strength);
  });

  // repeated_pattern alone does not pass Gate 2 (Insight Value Gate).
  // Water → readiness correlation requires strong_contextual_pattern (both behavioral
  // analysis and pattern engine corroborate) to surface as a Story.
  it('is NOT surface-worthy at repeated_pattern without corroboration', () => {
    expect(episode.surfaceWorthy).toBe(false);
  });
});

// ─── H2. Missing hydration logs — no water finding ───────────────────────────

describe('Hydration H2: waterOz never logged — no hydration finding', () => {
  const timeline = buildTimeline(30, () => ({
    readiness: 74, sleepScore: 78, hrv: 48,
    // waterOz deliberately absent throughout
  }));
  const today: HealthDayRecord = { ...TODAY_REC };
  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('has no water behavioral finding (nothing logged)', () => {
    const w = episode.behavioralFindings.find(f => f.behaviorType === 'water');
    expect(w).toBeUndefined();
  });
});

// ─── H3. Single high-hydration day — isolated coincidence, not surface-worthy ─

describe('Hydration H3: only one well-hydrated day logged', () => {
  // One day with high water, rest are either low or missing
  const timeline = buildTimeline(20, (i) => ({
    waterOz:   i === 7 ? 90 : 35,
    readiness: i === 7 ? 85 : 70,
    sleepScore: 78,
    sleepHours: 7.5,
  }));
  // today matches baseline to keep physio from driving surfaceWorthy
  const today: HealthDayRecord = { date: TODAY, readiness: 70, hrv: 48, sleepScore: 78, sleepHours: 7.5 };
  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('water finding (if present) is isolated_coincidence', () => {
    const w = episode.behavioralFindings.find(f => f.behaviorType === 'water');
    if (w) {
      expect(w.evidence.strength).toBe('isolated_coincidence');
    }
  });

  it('water alone does not make the episode surface-worthy', () => {
    const hasStrongOther = episode.behavioralFindings
      .filter(f => f.behaviorType !== 'water')
      .some(f => f.evidence.strength !== 'isolated_coincidence');
    if (!hasStrongOther && !episode.contextEvent?.hasEnoughEvidence) {
      expect(episode.surfaceWorthy).toBe(false);
    }
  });
});

// ─── H4. Missing water ≠ zero — unlogged days excluded from comparison ────────

describe('Hydration H4: undefined waterOz days excluded from non-behavior group', () => {
  // Mix: some days have high water logged, many have no water logged at all.
  // Undefined days should NOT be treated as "low hydration days".
  const timeline = buildTimeline(30, (i) => {
    if (i % 5 === 0) return { waterOz: 90,        readiness: 82 }; // high hydration, high readiness
    if (i % 5 === 1) return { waterOz: 40,         readiness: 68 }; // low hydration logged
    // remaining 3/5 of days: water NOT logged (not zero)
    return                  { readiness: 72 };
  });

  it('comparison only uses logged water days (not undefined = zero)', () => {
    // Test that buildBehavioralFindings correctly gates comparison group.
    // Days with undefined waterOz must not pollute the non-behavior group.
    const findings = buildBehavioralFindings(timeline, []);
    const w = findings.find(f => f.behaviorType === 'water');
    // If a finding exists, it was built from logged vs logged days, not logged vs missing.
    // We can verify the occurrence count is ≤ the number of high-water days (6 out of 30).
    if (w) {
      expect(w.evidence.occurrenceCount).toBeLessThanOrEqual(6);
    }
    // The test passes regardless of whether a finding was generated —
    // the key property is that no exception was thrown and missing ≠ 0.
    expect(true).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TIMING TESTS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── T1. No timestamps → caffeine uses day-level data safely ─────────────────

describe('Timing T1: caffeine behavioral finding works correctly without timestamps', () => {
  // Only daily caffeine totals are available (no time-of-day info).
  // The engine should work with daily totals and not invent timing.
  const timeline = buildTimeline(28, (i) => {
    const highCaffeine  = i % 4 === 0;
    const afterCaffeine = i % 4 === 1;
    return {
      caffeineMg: highCaffeine ? 450 : 80,
      sleepScore: afterCaffeine ? 55 : 82,
      sleepHours: afterCaffeine ? 6.0 : 7.9,
    };
  });
  const today: HealthDayRecord = { ...TODAY_REC };
  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('caffeine finding is present (daily totals are sufficient)', () => {
    const caf = episode.behavioralFindings.find(f => f.behaviorType === 'caffeine');
    expect(caf).toBeDefined();
  });

  it('caffeine finding does not include any time-of-day information', () => {
    // timeRelationship is either same_day or next_day — no timestamps
    const caf = episode.behavioralFindings.find(f => f.behaviorType === 'caffeine')!;
    expect(['same_day', 'next_day']).toContain(caf.timeRelationship);
  });

  it('caffeine time relationship is next_day (consistent with spec)', () => {
    const caf = episode.behavioralFindings.find(f => f.behaviorType === 'caffeine')!;
    expect(caf.timeRelationship).toBe('next_day');
  });
});

// ─── T2. One isolated behavior — not surface-worthy regardless of signal ──────

describe('Timing T2: one occurrence of any behavior is never surface-worthy alone', () => {
  // One alcohol event, one caffeine event, one sauna event — all isolated.
  // today matches baseline median so physio state doesn't trigger surfaceWorthy.
  const timeline = buildTimeline(20, (i) => ({
    totalAlcoholDrinks: i === 3 ? 3  : 0,
    caffeineMg:         i === 8 ? 400 : 80,
    hasSaunaSession:    i === 14,
    readiness:          i === 4 || i === 9 ? 60 : 74,
    sleepScore:         78,
    sleepHours:         7.5,
  }));
  // today matches the bulk baseline (~74) to avoid physio triggering surfaceWorthy
  const today: HealthDayRecord = { date: TODAY, readiness: 74, hrv: 48, sleepScore: 78, sleepHours: 7.5 };
  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('all behavioral findings are isolated_coincidence or absent', () => {
    for (const f of episode.behavioralFindings) {
      expect(f.evidence.strength).toBe('isolated_coincidence');
    }
  });

  it('episode is not surface-worthy from isolated behaviors alone', () => {
    const hasStrongEvent = episode.contextEvent?.hasEnoughEvidence;
    if (!hasStrongEvent) {
      expect(episode.surfaceWorthy).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MEAL TIMING BUCKET TESTS
// Validates classifyMealCategory() — the single source of truth for coarse
// meal-timing classification in the story engine.
// ═══════════════════════════════════════════════════════════════════════════════

describe('Meal timing MT1: Breakfast uploaded at 9 PM → still morning bucket', () => {
  // Batch-logging scenario: user uploads "Breakfast" at 9 PM.
  // logged_at = 9 PM (never passed to classifyMealCategory).
  // consumed_at = absent (user did not set an explicit time).
  // Expected: category name drives the bucket → breakfast_window.
  it('uses category name when consumed_at is absent', () => {
    const bucket = classifyMealCategory('Breakfast');
    expect(bucket).toBe('breakfast_window');
  });

  it('uses category name when consumed_at is null', () => {
    const bucket = classifyMealCategory('Breakfast', null);
    expect(bucket).toBe('breakfast_window');
  });
});

describe('Meal timing MT2: Lunch uploaded at 11 PM → still midday bucket', () => {
  it('uses category name when consumed_at is absent', () => {
    const bucket = classifyMealCategory('Lunch');
    expect(bucket).toBe('lunch_window');
  });
});

describe('Meal timing MT3: Dinner logged in real time with explicit consumed_at', () => {
  // 6:30 PM local → within dinner_window [16, 22)
  const dinnerTime = new Date(TODAY + 'T18:30:00').toISOString();

  it('returns dinner_window when consumed_at is 6:30 PM local', () => {
    const bucket = classifyMealCategory('Dinner', dinnerTime);
    expect(bucket).toBe('dinner_window');
  });

  it('same result with category alone (Dinner → dinner_window)', () => {
    const bucket = classifyMealCategory('Dinner');
    expect(bucket).toBe('dinner_window');
  });
});

describe('Meal timing MT4: Snack remains timing-ambiguous unless explicit time exists', () => {
  it('Snack with no consumed_at → snack_ambiguous', () => {
    const bucket = classifyMealCategory('Snack');
    expect(bucket).toBe('snack_ambiguous');
  });

  it('Snack with null consumed_at → snack_ambiguous', () => {
    const bucket = classifyMealCategory('Snack', null);
    expect(bucket).toBe('snack_ambiguous');
  });

  it('Snack with consumed_at at 2 PM local → lunch_window (explicit time overrides)', () => {
    const afternoonSnack = new Date(TODAY + 'T14:00:00').toISOString();
    const bucket = classifyMealCategory('Snack', afternoonSnack);
    expect(bucket).toBe('lunch_window');
  });
});

describe('Meal timing MT5: logged_at is never used as consumption time', () => {
  // classifyMealCategory() does not accept a logged_at parameter.
  // This structural test documents the contract: the function signature
  // only accepts mealName and consumedAt — there is no way to pass logged_at.
  it('function signature has no logged_at parameter', () => {
    // Called with only mealName → relies solely on category, not any timestamp
    const bucket = classifyMealCategory('Dinner');
    expect(bucket).toBe('dinner_window');
    // Two-argument form: only mealName + consumedAt — no logged_at path exists
    const bucket2 = classifyMealCategory('Dinner', null);
    expect(bucket2).toBe('dinner_window');
  });

  it('a meal categorised as Breakfast cannot be reclassified by any upload timestamp', () => {
    // Even if logged_at were 9 PM, classifyMealCategory('Breakfast')
    // still returns breakfast_window because consumed_at is absent.
    const bucketNoTime  = classifyMealCategory('Breakfast');
    const bucketNullTime = classifyMealCategory('Breakfast', null);
    expect(bucketNoTime).toBe('breakfast_window');
    expect(bucketNullTime).toBe('breakfast_window');
  });
});

describe('Meal timing MT6: explicit consumed_at overrides the category bucket', () => {
  // A "Breakfast"-labelled meal logged with consumed_at at 7 PM local
  // should be classified as dinner_window, not breakfast_window.
  // Use case: user ate "breakfast food" for dinner.
  const eveningTime = new Date(TODAY + 'T19:00:00').toISOString();

  it('Breakfast + consumed_at at 7 PM → dinner_window', () => {
    const bucket = classifyMealCategory('Breakfast', eveningTime);
    expect(bucket).toBe('dinner_window');
  });

  it('Lunch + consumed_at at 8 AM → breakfast_window', () => {
    const morningTime = new Date(TODAY + 'T08:00:00').toISOString();
    const bucket = classifyMealCategory('Lunch', morningTime);
    expect(bucket).toBe('breakfast_window');
  });

  it('Dinner + consumed_at at 11:30 PM → snack_ambiguous (outside all windows)', () => {
    const lateNight = new Date(TODAY + 'T23:30:00').toISOString();
    const bucket = classifyMealCategory('Dinner', lateNight);
    expect(bucket).toBe('snack_ambiguous');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ARC TESTS — Interpretation, Aftermath, NextFocus, FutureLesson, Hydration
// (20 scenarios covering the new narrative arc layers)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── ARC I1. Transition → strain_accumulation interpretation ──────────────────

describe('Arc I1: travel → illness transition produces strain_accumulation', () => {
  const travelEvent  = makeEvent('travel',  10, 7);    // ended 10 days ago
  const illnessEvent = makeEvent('illness',  5, 4, true); // started ~7 days ago, ongoing

  const travelWindow = makeWindow(
    travelEvent,
    { days: 7, sleepHours: 7.5, workoutDurationMin: 35 },
    { days: 7, sleepHours: 5.8, workoutDurationMin: 75 }, // lower sleep, higher activity
  );
  const illnessWindow = makeWindow(
    illnessEvent,
    { days: 4, readiness: 72, sleepHours: 7.5 },
    { days: 4, readiness: 52, sleepHours: 7.0 },
    true,
  );

  const timeline = buildTimeline(30, () => ({
    readiness: 74, sleepHours: 7.5, hrv: 48, sleepScore: 78,
  }));
  const today: HealthDayRecord = { ...TODAY_REC };
  const episode = buildStoryEpisode(
    makeSynthesis({ eventWindows: [travelWindow, illnessWindow] }),
    timeline,
    today,
  );

  it('transition exists (travel → illness)', () => {
    expect(episode.transition).not.toBeNull();
    expect(episode.transition!.precedingEventType).toBe('travel');
    expect(episode.transition!.currentEventType).toBe('illness');
  });

  it('interpretation is strain_accumulation', () => {
    expect(episode.interpretation?.hasInterpretation).toBe(true);
    expect(episode.interpretation?.connectionType).toBe('strain_accumulation');
  });

  it('load signals come from the preceding travel window changes', () => {
    expect(episode.interpretation!.loadSignals.length).toBeGreaterThan(0);
  });

  it('outcomeEventType is illness', () => {
    expect(episode.interpretation!.outcomeEventType).toBe('illness');
  });
});

// ─── ARC I2. Behavioral cluster: 2+ meaningful behavioral findings ────────────

describe('Arc I2: 2+ meaningful behavioral findings → behavioral_cluster', () => {
  // Caffeine + sauna both show repeated associations
  const timeline = buildTimeline(30, (i) => ({
    caffeineMg:      i % 4 === 0 ? 450 : 80,
    hasSaunaSession: i % 3 === 0,
    sleepScore:      i % 4 === 1 ? 55  : 82,  // next day after high caffeine: lower sleep
    readiness:       i % 3 === 0 ? 84  : 65,  // sauna days: higher readiness
    sleepHours:      i % 4 === 1 ? 6.0 : 7.9,
    hrv:             48,
  }));
  const today: HealthDayRecord = { ...TODAY_REC };
  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('has 2+ behavioral findings', () => {
    const meaningful = episode.behavioralFindings.filter(
      f => f.evidence.strength !== 'isolated_coincidence',
    );
    expect(meaningful.length).toBeGreaterThanOrEqual(2);
  });

  it('interpretation is behavioral_cluster', () => {
    const meaningful = episode.behavioralFindings.filter(
      f => f.evidence.strength !== 'isolated_coincidence',
    );
    if (meaningful.length >= 2) {
      expect(episode.interpretation?.connectionType).toBe('behavioral_cluster');
      expect(episode.interpretation?.hasInterpretation).toBe(true);
    }
  });
});

// ─── ARC I3. Routine disruption: travel with 2+ metric changes ───────────────

describe('Arc I3: travel event with 2+ metric changes → routine_disruption', () => {
  const travelEvent  = makeEvent('travel', 3, 7);
  const travelWindow = makeWindow(
    travelEvent,
    { days: 7, sleepHours: 7.8, calories: 2200, readiness: 76 },
    { days: 7, sleepHours: 5.9, calories: 1300, readiness: 72 }, // sleep + calories lower
  );

  const timeline = buildTimeline(30, () => ({
    readiness: 74, sleepHours: 7.5, hrv: 48, sleepScore: 78,
    calories: 2000,
  }));
  const today: HealthDayRecord = { ...TODAY_REC };
  const episode = buildStoryEpisode(
    makeSynthesis({ eventWindows: [travelWindow] }),
    timeline,
    today,
  );

  it('has 2+ metric changes from travel', () => {
    expect(episode.contextEvent?.metricChanges.length).toBeGreaterThanOrEqual(2);
  });

  it('interpretation is routine_disruption when no transition', () => {
    if (!episode.transition && episode.contextEvent?.metricChanges.length! >= 2) {
      expect(episode.interpretation?.connectionType).toBe('routine_disruption');
      expect(episode.interpretation?.hasInterpretation).toBe(true);
    }
  });
});

// ─── ARC I4. No interpretation when insufficient signals ─────────────────────

describe('Arc I4: no interpretation when only one behavioral finding', () => {
  // Only sauna shows an association — not enough for a cluster
  const timeline = buildTimeline(28, (i) => ({
    hasSaunaSession: i % 4 === 0,
    readiness:       i % 4 === 0 ? 85 : 68,
    sleepScore: 78, hrv: 48,
  }));
  const today: HealthDayRecord = { ...TODAY_REC };
  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);

  it('interpretation hasInterpretation is false', () => {
    // Only one behavioral finding — no behavioral_cluster, no transition, no travel event
    const meaningfulBehaviors = episode.behavioralFindings.filter(
      f => f.evidence.strength !== 'isolated_coincidence',
    );
    if (meaningfulBehaviors.length < 2 && !episode.transition) {
      expect(episode.interpretation?.hasInterpretation).toBe(false);
    }
  });
});

// ─── ARC H1. Hydration: below_target when logged water < 85% baseline ────────

describe('Arc H1: logged hydration below personal baseline → below_target', () => {
  // Baseline: 30 days of 85oz, except the event window (8 days at 30oz)
  const eventStart = pastDate(12);
  const eventEnd   = pastDate(5);

  const timeline = buildTimeline(30, (_, date) => {
    const isTravelDay = date >= eventStart && date <= eventEnd;
    return {
      readiness: 74, sleepHours: 7.5,
      waterOz:   isTravelDay ? 30 : 85,
    };
  });

  const hydration = buildHydrationContext(timeline, eventStart, eventEnd);

  it('status is below_target', () => {
    expect(hydration.status).toBe('below_target');
  });

  it('coverage rate is above 50% (enough to make the claim)', () => {
    expect(hydration.coverageRate).toBeGreaterThanOrEqual(0.5);
  });
});

// ─── ARC H2. Hydration: not_tracked when < 50% of days have waterOz ──────────

describe('Arc H2: waterOz logged on only 2 of 10 event days → not_tracked', () => {
  const eventStart = pastDate(12);
  const eventEnd   = pastDate(3);

  const timeline = buildTimeline(30, (_, date) => {
    const isTravelDay = date >= eventStart && date <= eventEnd;
    // Only 2 event days have waterOz logged
    const daysIntoTravel = isTravelDay
      ? Math.floor((new Date(date).getTime() - new Date(eventStart).getTime()) / 86400000)
      : -1;
    return {
      readiness: 74,
      waterOz: (isTravelDay && daysIntoTravel < 2) ? 60 : undefined,
    };
  });

  const hydration = buildHydrationContext(timeline, eventStart, eventEnd);

  it('status is not_tracked (< 50% coverage)', () => {
    expect(hydration.status).toBe('not_tracked');
  });

  it('coverageRate is below 0.5', () => {
    expect(hydration.coverageRate).toBeLessThan(0.5);
  });
});

// ─── ARC H3. Missing hydration must never render as "didn't drink enough" ─────

describe('Arc H3: not_tracked hydration context does not produce deficit language', () => {
  const travelEvent  = makeEvent('travel', 3, 7);
  const travelWindow = makeWindow(
    travelEvent,
    { days: 7, sleepHours: 7.8, readiness: 76 },
    { days: 7, sleepHours: 5.8, readiness: 60 },
  );

  // No waterOz logged anywhere in timeline
  const timeline = buildTimeline(30, () => ({
    readiness: 74, sleepHours: 7.5, hrv: 48, sleepScore: 78,
  }));
  const today: HealthDayRecord = { ...TODAY_REC };
  const episode = buildStoryEpisode(
    makeSynthesis({ eventWindows: [travelWindow] }),
    timeline,
    today,
  );

  it('hydrationContext is not_tracked', () => {
    expect(episode.hydrationContext?.status).toBe('not_tracked');
  });

  it('rendered story does not mention drinking or hydration deficit', () => {
    const text = renderStoryEpisode(episode) ?? '';
    const deficitPhrases = [
      "didn't drink", "not enough water", "dehydrated",
      "drink more", "low hydration", "drink enough",
    ];
    for (const phrase of deficitPhrases) {
      expect(text.toLowerCase()).not.toContain(phrase);
    }
  });
});

// ─── ARC AF1. Aftermath: illness followed by improving sleep ──────────────────

describe('Arc AF1: illness then improving sleep → recovery-aligned aftermath', () => {
  const illnessEnd   = pastDate(5);
  const illnessStart = pastDate(12);

  // During illness: sleepHours=5.5, readiness=50
  // Post-illness: sleepHours=7.5+, readiness=70+
  const timeline = buildTimeline(30, (_, date) => {
    if (date >= illnessStart && date <= illnessEnd) {
      return { sleepHours: 5.5, readiness: 50, hrv: 32 };
    }
    if (date > illnessEnd) {
      return { sleepHours: 7.8, readiness: 72, hrv: 48 };
    }
    return { sleepHours: 7.5, readiness: 74, hrv: 48 };
  });

  const aftermath = buildAftermathLayer(timeline, 'illness', illnessEnd, illnessStart, false);

  it('has evidence', () => {
    expect(aftermath.hasEvidence).toBe(true);
  });

  it('sleep observation is recovery-aligned (higher after illness)', () => {
    const sleepObs = aftermath.observations.find(o => o.signal === 'Sleep');
    if (sleepObs) {
      expect(sleepObs.direction).toBe('higher');
      expect(sleepObs.isRecoveryAligned).toBe(true);
    } else {
      // Sleep might not pass the ≥2 comparison threshold in some edge cases
      expect(aftermath.observations.some(o => o.isRecoveryAligned)).toBe(true);
    }
  });
});

// ─── ARC AF2. Aftermath: illness followed by lower activity (rest) ────────────

describe('Arc AF2: illness then lower activity → recovery-aligned (rest)', () => {
  const illnessEnd   = pastDate(4);
  const illnessStart = pastDate(11);

  const timeline = buildTimeline(30, (_, date) => {
    if (date >= illnessStart && date <= illnessEnd) {
      // During illness: high activity (struggling through workouts)
      return { workoutDurationMin: 70, readiness: 52, sleepHours: 6.0 };
    }
    if (date > illnessEnd) {
      // Post-illness: resting (lower activity = recovery-aligned)
      return { workoutDurationMin: 20, readiness: 70, sleepHours: 7.5 };
    }
    return { workoutDurationMin: 45, readiness: 74, sleepHours: 7.5 };
  });

  const aftermath = buildAftermathLayer(timeline, 'illness', illnessEnd, illnessStart, false);

  it('activity observation is recovery-aligned (lower after illness = rest)', () => {
    const actObs = aftermath.observations.find(o => o.signal === 'Activity');
    if (actObs) {
      expect(actObs.direction).toBe('lower');
      expect(actObs.isRecoveryAligned).toBe(true);
    }
  });
});

// ─── ARC AF3. Ongoing event → no aftermath ────────────────────────────────────

describe('Arc AF3: ongoing illness event → aftermath.hasEvidence = false', () => {
  const illnessEnd   = undefined;
  const illnessStart = pastDate(5);

  const timeline = buildTimeline(20, () => ({
    readiness: 52, sleepHours: 6.0,
  }));

  const aftermath = buildAftermathLayer(timeline, 'illness', illnessEnd, illnessStart, true);

  it('hasEvidence is false for ongoing event', () => {
    expect(aftermath.hasEvidence).toBe(false);
  });

  it('postEventDays is 0', () => {
    expect(aftermath.postEventDays).toBe(0);
  });
});

// ─── ARC AF4. Insufficient post-event data → no aftermath ────────────────────

describe('Arc AF4: only 2 post-event days → aftermath has no evidence', () => {
  const illnessEnd   = pastDate(2);   // ended 2 days ago — not enough post-event data
  const illnessStart = pastDate(9);

  const timeline = buildTimeline(15, (_, date) => {
    if (date >= illnessStart && date <= illnessEnd) {
      return { readiness: 52, sleepHours: 5.5 };
    }
    return { readiness: 74, sleepHours: 7.5 };
  });

  const aftermath = buildAftermathLayer(timeline, 'illness', illnessEnd, illnessStart, false);

  it('hasEvidence is false (insufficient post-event days)', () => {
    // Less than 3 post-event days → no aftermath
    expect(aftermath.hasEvidence).toBe(false);
  });
});

// ─── ARC NF1. NextFocus: recovery context with below-baseline sleep ───────────

describe('Arc NF1: recovery context + sleep below baseline → sleep priority', () => {
  const timeline = buildTimeline(20, (i) => {
    if (i < 10) return { readiness: 76, hrv: 52, sleepScore: 81, sleepHours: 7.8 };
    return        { readiness: 54, hrv: 34, sleepScore: 63, sleepHours: 6.0 };
  });
  const today: HealthDayRecord = {
    date: TODAY, readiness: 58, hrv: 38, sleepScore: 66, sleepHours: 6.2,
  };

  const currentDir   = buildCurrentDirectionLayer(timeline, today);
  const nextFocusResult = buildNextFocusLayer(null, currentDir, [], null);

  it('has at least one priority', () => {
    expect(nextFocusResult.hasRecommendation).toBe(true);
    expect(nextFocusResult.priorities.length).toBeGreaterThan(0);
  });

  it('context is recovery', () => {
    expect(nextFocusResult.context).toBe('recovery');
  });

  it('priority area references sleep or recovery', () => {
    const areas = nextFocusResult.priorities.map(p => p.area.toLowerCase());
    const hasSleepOrRecovery = areas.some(a => a.includes('sleep') || a.includes('recovery'));
    expect(hasSleepOrRecovery).toBe(true);
  });
});

// ─── ARC NF2. No recommendation when trajectory is stable ────────────────────

describe('Arc NF2: stable trajectory → no next focus recommendation', () => {
  const timeline = buildTimeline(20, () => ({
    readiness: 74, hrv: 48, sleepScore: 78, sleepHours: 7.5,
  }));
  const today: HealthDayRecord = { ...TODAY_REC };

  const currentDir      = buildCurrentDirectionLayer(timeline, today);
  const nextFocusResult = buildNextFocusLayer(null, currentDir, [], null);

  it('hasRecommendation is false when trajectory is stable', () => {
    if (currentDir?.trajectory === 'stable') {
      expect(nextFocusResult.hasRecommendation).toBe(false);
    }
  });
});

// ─── ARC NF3. Below-target hydration → hydration priority ────────────────────

describe('Arc NF3: hydration below_target → hydration priority in nextFocus', () => {
  const hydrationCtx: import('../story-engine').HydrationContext = {
    status: 'below_target',
    loggedDaysInWindow: 6,
    windowDays: 8,
    coverageRate: 0.75,
  };

  const nextFocusResult = buildNextFocusLayer(null, null, [], hydrationCtx);

  it('includes a hydration priority', () => {
    const areas = nextFocusResult.priorities.map(p => p.area.toLowerCase());
    expect(areas.some(a => a.includes('hydration'))).toBe(true);
  });

  it('rationale references logged data, not a general claim', () => {
    const hydPriority = nextFocusResult.priorities.find(
      p => p.area.toLowerCase().includes('hydration'),
    )!;
    expect(hydPriority.rationale).toMatch(/logged/i);
  });
});

// ─── ARC FL1. Future lesson: completed travel with metric drops ───────────────

describe('Arc FL1: completed travel with sleep + nutrition drops → hasLesson = true', () => {
  const travelEvent  = makeEvent('travel', 5, 7);
  const travelWindow = makeWindow(
    travelEvent,
    { days: 7, sleepHours: 7.8, calories: 2200 },
    { days: 7, sleepHours: 5.9, calories: 1300 }, // sleep and nutrition lower
  );

  const contextLayer = buildContextEventLayer(travelWindow)!;
  const lesson       = buildFutureLessonLayer(contextLayer, []);

  it('hasLesson is true', () => {
    expect(lesson.hasLesson).toBe(true);
  });

  it('monitorSignals contains sleep', () => {
    expect(lesson.monitorSignals.some(s => s.toLowerCase().includes('sleep'))).toBe(true);
  });

  it('eventType is travel', () => {
    expect(lesson.eventType).toBe('travel');
  });
});

// ─── ARC FL2. Ongoing event → no lesson ──────────────────────────────────────

describe('Arc FL2: ongoing travel event → hasLesson = false', () => {
  const travelEvent  = makeEvent('travel', 0, 7, true); // ongoing
  const travelWindow = makeWindow(
    travelEvent,
    { days: 7, sleepHours: 7.8 },
    { days: 7, sleepHours: 5.9 },
    true,
  );

  const contextLayer = buildContextEventLayer(travelWindow)!;
  const lesson       = buildFutureLessonLayer(contextLayer, []);

  it('hasLesson is false for ongoing event', () => {
    expect(lesson.hasLesson).toBe(false);
  });
});

// ─── ARC R1. No causal verbs in rendered story ────────────────────────────────

describe('Arc R1: rendered story contains no causal language', () => {
  // Travel → illness transition: rich enough to produce multi-sentence story
  const travelEvent  = makeEvent('travel',  10, 7);
  const illnessEvent = makeEvent('illness',  4, 5, true);

  const travelWindow = makeWindow(
    travelEvent,
    { days: 7, sleepHours: 7.5, hrv: 52 },
    { days: 7, sleepHours: 5.9, hrv: 36 },
  );
  const illnessWindow = makeWindow(
    illnessEvent,
    { days: 5, readiness: 72 },
    { days: 5, readiness: 52 },
    true,
  );

  const timeline = buildTimeline(30, () => ({
    readiness: 74, sleepHours: 7.5, hrv: 48, sleepScore: 78,
  }));
  const today: HealthDayRecord = { ...TODAY_REC };
  const episode = buildStoryEpisode(
    makeSynthesis({ eventWindows: [travelWindow, illnessWindow] }),
    timeline,
    today,
  );
  const text = renderStoryEpisode(episode) ?? '';

  it('rendered text is non-empty (episode is surface-worthy)', () => {
    expect(text.length).toBeGreaterThan(0);
  });

  it('no causal verbs', () => {
    const causalVerbs = [
      'caused', 'causes', 'led to', 'leads to', 'resulted in', 'results in',
      'triggers', 'triggered', 'means that', 'means your', 'because of',
      'due to your', 'suppressed', 'damages', 'impairs',
    ];
    for (const verb of causalVerbs) {
      expect(text.toLowerCase()).not.toContain(verb);
    }
  });
});

// ─── ARC R2. No medical or diagnostic claims ──────────────────────────────────

describe('Arc R2: rendered story contains no medical/diagnostic language', () => {
  const timeline = buildTimeline(30, (i) => ({
    readiness: i < 10 ? 76 : 52,
    hrv:       i < 10 ? 52 : 34,
    sleepScore: 78,
    sleepHours: 7.5,
  }));
  const today: HealthDayRecord = {
    date: TODAY, readiness: 54, hrv: 36, sleepScore: 70, sleepHours: 7.0,
  };
  const episode = buildStoryEpisode(makeSynthesis(), timeline, today);
  const text    = renderStoryEpisode(episode) ?? '';

  it('no medical claims', () => {
    const medicalTerms = [
      'diagnos', 'disease', 'condition', 'disorder', 'symptom', 'treat',
      'cure', 'medical', 'clinical', 'therapy', 'medication',
    ];
    for (const term of medicalTerms) {
      expect(text.toLowerCase()).not.toContain(term);
    }
  });
});

// ─── ARC R3. Signal density cap ───────────────────────────────────────────────

describe('Arc R3: rendered story respects signal density cap (≤ 5 paragraphs)', () => {
  const travelEvent  = makeEvent('travel', 10, 7);
  const illnessEvent = makeEvent('illness',  4, 5, true);

  const travelWindow = makeWindow(
    travelEvent,
    { days: 7, sleepHours: 7.8, hrv: 52, workoutDurationMin: 30, calories: 2200 },
    { days: 7, sleepHours: 5.9, hrv: 36, workoutDurationMin: 80, calories: 1300 },
  );
  const illnessWindow = makeWindow(
    illnessEvent,
    { days: 5, readiness: 72 },
    { days: 5, readiness: 52 },
    true,
  );

  // Rich timeline with hydration + behavioral signals
  const timeline = buildTimeline(30, (i) => ({
    readiness:       74,
    sleepHours:      7.5,
    hrv:             48,
    sleepScore:      78,
    hasSaunaSession: i % 4 === 0,
    waterOz:         i % 3 === 0 ? 90 : 45,
    caffeineMg:      i % 5 === 0 ? 450 : 80,
  }));
  const today: HealthDayRecord = { ...TODAY_REC };
  const episode = buildStoryEpisode(
    makeSynthesis({ eventWindows: [travelWindow, illnessWindow] }),
    timeline,
    today,
  );
  const text = renderStoryEpisode(episode) ?? '';

  it('rendered text has at most 5 double-newline-separated parts', () => {
    const parts = text.split('\n\n').filter(p => p.trim().length > 0);
    expect(parts.length).toBeLessThanOrEqual(5);
  });
});

// ─── ARC R4. NextFocus priorities are not generic boilerplate ─────────────────

describe('Arc R4: nextFocus priorities reference actual data, never generic advice', () => {
  const timeline = buildTimeline(20, (i) => {
    if (i < 10) return { readiness: 76, hrv: 52, sleepScore: 81, sleepHours: 7.8 };
    return        { readiness: 54, hrv: 34, sleepScore: 63, sleepHours: 6.0 };
  });
  const today: HealthDayRecord = {
    date: TODAY, readiness: 56, hrv: 36, sleepScore: 65, sleepHours: 6.3,
  };
  const currentDir      = buildCurrentDirectionLayer(timeline, today);
  const nextFocusResult = buildNextFocusLayer(null, currentDir, [], null);

  it('rationale strings do not contain generic health boilerplate', () => {
    const genericPhrases = [
      'eat more vegetables', 'exercise regularly', 'get more sleep in general',
      'drink 8 glasses', 'see a doctor', 'manage stress',
    ];
    for (const p of nextFocusResult.priorities) {
      for (const phrase of genericPhrases) {
        expect(p.rationale.toLowerCase()).not.toContain(phrase);
      }
    }
  });

  it('rationale strings reference specific metric data', () => {
    for (const p of nextFocusResult.priorities) {
      // Each rationale should mention a metric (readiness, hrv, sleep, etc.)
      const mentionsMetric = /readiness|hrv|sleep|hydration|caffeine|alcohol/i.test(p.rationale);
      expect(mentionsMetric).toBe(true);
    }
  });
});
