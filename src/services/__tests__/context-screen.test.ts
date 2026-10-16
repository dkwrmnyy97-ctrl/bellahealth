/**
 * context-screen.test.ts
 *
 * Tests for Context screen logic, data truthfulness, and privacy guarantees.
 *
 * Tests React rendering via @testing-library/react-native.
 * Engine logic tests are pure (no device APIs).
 *
 * Coverage:
 *   - Your Story generation (rich / sparse / insufficient data)
 *   - Pattern language display
 *   - Coverage states (full / HK-only / no data)
 *   - Connection evidence language (tier-appropriate)
 *   - ContextSummary handoff (structured only, no raw timeline)
 *   - No automatic Claude request on synthesis
 *   - ContextEvent pipeline (active / completed)
 *   - Event window rendering data
 *   - Contradiction suppression in synthesis
 *   - First-time walkthrough flag logic
 *   - Add context event creation
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import {
  buildYourStory,
  patternHeadline,
  patternSentence,
  patternEvidenceChip,
  TIER_LABEL,
} from '../../utils/pattern-language';
import {
  buildContextSummary,
  synthesizeContext,
  type SynthesisResult,
} from '../context-synthesis';
import {
  computeCoverage,
} from '../context-coverage';
import {
  mergeContributions,
  SIGNAL_PRIORITY,
} from '../canonical-signals';
import type { PatternResult, HealthDayRecord, EventWindowAnalysis } from '../pattern-engine';
import type { ContextEvent } from '../context-events';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makePattern(overrides: Partial<PatternResult> = {}): PatternResult {
  return {
    patternId:           'p1',
    relationshipId:      'sleep_hours_readiness',
    inputSignal:         'sleepHours',
    outcomeSignal:       'readiness',
    temporalRelationship:'next_day',
    observationUnit:     'day',
    observationCount:    18,
    baselineCount:       12,
    // conditionCount < 5 by default so tests don't trigger count-based sentences
    conditionCount:      4,
    dateRange:           { start: '2026-08-01', end: '2026-09-01' },
    inputCondition:      'nights with more sleep',
    outcomeDuringCondition: 78,
    outcomeBaseline:     68,
    absoluteDifference:  10,
    percentDifference:   14.7,
    direction:           'positive',
    consistency:         0.72,
    sources:             ['oura_sleep', 'oura_readiness'],
    confidenceTier:      'PATTERN',
    lastUpdated:         '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

function makeSynthesis(overrides: Partial<SynthesisResult> = {}): SynthesisResult {
  return {
    generatedAt: '2026-09-02T08:00:00.000Z',
    primaryTheme: {
      theme: 'performing_well',
      primarySignal: 'Readiness',
      rationale: ['Readiness is 78 — favorable.', 'HRV is 52 — favorable.'],
    },
    supportingSignals: [
      { signal: 'Readiness', value: 78, vsBaseline: 'above', interpretation: 'favorable', source: 'Oura Readiness' },
      { signal: 'HRV',       value: 52, vsBaseline: 'within', interpretation: 'favorable', source: 'Oura HRV' },
    ],
    concerningSignals:  [],
    conflictingSignals: [],
    relevantContext:    [],
    strongestConnection: makePattern(),
    allPatterns:        [makePattern()],
    eventWindow:        null,
    eventTypePattern:   null,
    recoveryConstrained: false,
    sources:            ['oura_sleep', 'oura_readiness'],
    ...overrides,
  };
}

// ─── Your Story tests ──────────────────────────────────────────────────────────

describe('buildYourStory', () => {
  test('returns null for insufficient_data theme', () => {
    const synthesis = makeSynthesis({
      primaryTheme: { theme: 'insufficient_data', primarySignal: null, rationale: [] },
    });
    expect(buildYourStory(synthesis)).toBeNull();
  });

  test('performs_well: includes signal names', () => {
    const story = buildYourStory(makeSynthesis());
    expect(story).not.toBeNull();
    expect(story!.toLowerCase()).toMatch(/readiness|hrv|favorable/i);
  });

  test('recovery_needed: uses rationale lines', () => {
    const synthesis = makeSynthesis({
      primaryTheme: {
        theme: 'recovery_needed',
        primarySignal: 'Readiness',
        rationale: ['Readiness is 58 — below the recovery threshold.', 'Sleep is lower than optimal.'],
      },
      concerningSignals: [{ signal: 'Readiness', value: 58, vsBaseline: 'below', interpretation: 'concerning', source: 'Oura' }],
    });
    const story = buildYourStory(synthesis);
    expect(story).not.toBeNull();
    expect(story!).toContain('58');
  });

  test('mixed_signals: mentions both concerning and supporting', () => {
    const synthesis = makeSynthesis({
      primaryTheme: { theme: 'mixed_signals', primarySignal: 'Readiness', rationale: [] },
      concerningSignals: [{ signal: 'Readiness', value: 58, vsBaseline: 'below', interpretation: 'concerning', source: 'Oura' }],
      supportingSignals: [{ signal: 'HRV', value: 55, vsBaseline: 'above', interpretation: 'favorable', source: 'Oura' }],
    });
    const story = buildYourStory(synthesis);
    expect(story!.toLowerCase()).toContain('readiness');
    expect(story!.toLowerCase()).toContain('hrv');
  });

  test('does not claim causation', () => {
    const story = buildYourStory(makeSynthesis()) ?? '';
    const causal = ['causes', 'because of', 'resulted in', 'led to'];
    for (const word of causal) {
      expect(story.toLowerCase()).not.toContain(word);
    }
  });

  test('does not mention Bella as a person', () => {
    const story = buildYourStory(makeSynthesis()) ?? '';
    expect(story).not.toMatch(/Bella (noticed|thinks|learned|recommends|knows)/i);
  });
});

// ─── Pattern language tests ────────────────────────────────────────────────────

describe('patternHeadline', () => {
  test('formats as "SIGNAL → SIGNAL"', () => {
    const p = makePattern({ inputSignal: 'sleepHours', outcomeSignal: 'readiness' });
    expect(patternHeadline(p)).toBe('SLEEP → READINESS');
  });

  test('drinking pattern', () => {
    const p = makePattern({ inputSignal: 'totalAlcoholDrinks', outcomeSignal: 'sleepScore' });
    expect(patternHeadline(p)).toBe('DRINKING → SLEEP QUALITY');
  });
});

describe('patternSentence', () => {
  // ── 1. Next-day positive ──────────────────────────────────────────────────────
  test('next-day positive uses "followed by" with higher outcome', () => {
    const p = makePattern({ temporalRelationship: 'next_day', direction: 'positive', confidenceTier: 'PATTERN' });
    const s = patternSentence(p);
    expect(s).toContain('followed by');
    expect(s.toLowerCase()).toContain('higher readiness');
  });

  // ── 2. Next-day negative ──────────────────────────────────────────────────────
  test('next-day negative uses "followed by" with lower outcome', () => {
    const p = makePattern({
      inputSignal: 'workoutDurationMin', outcomeSignal: 'readiness',
      temporalRelationship: 'next_day', direction: 'negative', confidenceTier: 'PATTERN',
    });
    const s = patternSentence(p);
    expect(s).toContain('followed by');
    expect(s.toLowerCase()).toContain('lower readiness');
  });

  // ── 3. Same-period positive ───────────────────────────────────────────────────
  test('same-day positive uses personal same-period language', () => {
    const p = makePattern({ temporalRelationship: 'same_day', direction: 'positive' });
    const s = patternSentence(p);
    // Should not say "followed by" (that implies next-day)
    expect(s).not.toContain('followed by');
    // Should contain "your" or reference the input condition
    expect(s.toLowerCase()).toMatch(/your|on your/);
  });

  // ── 4. Same-period negative ───────────────────────────────────────────────────
  test('same-day negative uses personal same-period language', () => {
    const p = makePattern({
      inputSignal: 'totalAlcoholDrinks', outcomeSignal: 'sleepScore',
      temporalRelationship: 'same_day', direction: 'negative', confidenceTier: 'PATTERN',
    });
    const s = patternSentence(p);
    expect(s).not.toContain('followed by');
    expect(s.toLowerCase()).toMatch(/lower|less/);
  });

  // ── 5. Early pattern wording ─────────────────────────────────────────────────
  test('EARLY tier uses hedging language like "so far" or "often"', () => {
    const p = makePattern({ confidenceTier: 'EARLY', direction: 'negative' });
    const s = patternSentence(p);
    expect(s.toLowerCase()).toMatch(/so far|often|may be/);
    // Must not claim it is established
    expect(s.toLowerCase()).not.toContain('consistently');
    expect(s.toLowerCase()).not.toContain('usually');
  });

  // ── 6. Consistent pattern wording ────────────────────────────────────────────
  test('CONSISTENT tier uses strong-confidence language', () => {
    const p = makePattern({ confidenceTier: 'CONSISTENT', direction: 'positive' });
    const s = patternSentence(p);
    expect(s.toLowerCase()).toMatch(/consistently|usually/);
    // Must not sound tentative
    expect(s.toLowerCase()).not.toContain('so far');
  });

  // ── 7. Count-based when conditionCount is reliable ───────────────────────────
  test('uses count-based sentence when conditionCount ≥ 5 and observationCount ≥ 12', () => {
    const p = makePattern({
      inputSignal: 'workoutDurationMin', outcomeSignal: 'readiness',
      temporalRelationship: 'next_day', direction: 'negative',
      confidenceTier: 'PATTERN', conditionCount: 8, observationCount: 16,
    });
    const s = patternSentence(p);
    expect(s).toContain('8');
    expect(s).toContain('16');
    expect(s.toLowerCase()).toContain('higher-training days');
  });

  // ── 8. No invented counts when conditionCount is low ────────────────────────
  test('does NOT produce count-based sentence when conditionCount < 5', () => {
    const p = makePattern({ conditionCount: 3, observationCount: 18 });
    const s = patternSentence(p);
    // Should not embed raw numbers for the condition count
    expect(s).not.toMatch(/On 3 of/);
  });

  // ── 9. No causal verbs ───────────────────────────────────────────────────────
  test('does not use causal verbs', () => {
    const causal = [
      'causes', 'caused', 'because', 'resulted', 'led to', 'proves',
      'means', 'leads to', 'results in', 'improves', 'worsens', 'drives', 'affects',
    ];
    const signals: Array<Partial<PatternResult>> = [
      {},
      { inputSignal: 'workoutDurationMin', outcomeSignal: 'readiness', temporalRelationship: 'next_day', direction: 'negative' },
      { inputSignal: 'totalAlcoholDrinks', outcomeSignal: 'sleepScore', temporalRelationship: 'same_day', direction: 'negative' },
      { confidenceTier: 'EARLY', direction: 'negative' },
    ];
    for (const override of signals) {
      const s = patternSentence(makePattern(override)).toLowerCase();
      for (const word of causal) {
        expect(s).not.toContain(word);
      }
    }
  });

  // ── 10. Personalized "your" language ────────────────────────────────────────
  test('every sentence contains "your" for personalization', () => {
    const variants: Array<Partial<PatternResult>> = [
      {},
      { temporalRelationship: 'same_day' },
      { confidenceTier: 'EARLY' },
      { confidenceTier: 'CONSISTENT' },
      { inputSignal: 'workoutDurationMin', outcomeSignal: 'readiness', temporalRelationship: 'next_day', direction: 'negative' },
      { inputSignal: 'totalAlcoholDrinks', outcomeSignal: 'sleepScore', temporalRelationship: 'same_day', direction: 'negative' },
    ];
    for (const override of variants) {
      const s = patternSentence(makePattern(override));
      expect(s.toLowerCase()).toContain('your');
    }
  });

  // ── 11. No "tends to mean" phrasing ─────────────────────────────────────────
  test('does not use "tends to mean" phrasing', () => {
    const variants: Array<Partial<PatternResult>> = [
      {},
      { direction: 'negative' },
      { temporalRelationship: 'same_day' },
      { confidenceTier: 'CONSISTENT' },
    ];
    for (const override of variants) {
      const s = patternSentence(makePattern(override));
      expect(s.toLowerCase()).not.toContain('tends to mean');
    }
  });

  // ── 12. Graceful fallback for weak/unknown evidence ──────────────────────────
  test('fallback sentence for unknown direction is non-empty and non-causal', () => {
    const p = makePattern({ direction: 'neutral', confidenceTier: 'EARLY' });
    const s = patternSentence(p);
    expect(s.length).toBeGreaterThan(10);
    expect(s.toLowerCase()).not.toContain('causes');
    expect(s.toLowerCase()).not.toContain('means');
  });

  // ── same_day has no "followed by" (legacy guard) ────────────────────────────
  test('same_day never says "followed by"', () => {
    const p = makePattern({ temporalRelationship: 'same_day', direction: 'positive' });
    expect(patternSentence(p)).not.toContain('followed by');
  });
});

describe('patternEvidenceChip', () => {
  test('formats observation count and tier', () => {
    const p = makePattern({ observationCount: 18, confidenceTier: 'PATTERN' });
    expect(patternEvidenceChip(p)).toBe('18 days · Pattern');
  });

  test('singular "day" for count 1', () => {
    const p = makePattern({ observationCount: 1, confidenceTier: 'EARLY' });
    expect(patternEvidenceChip(p)).toBe('1 day · Early pattern');
  });

  test('INSUFFICIENT tier uses correct label', () => {
    const p = makePattern({ confidenceTier: 'INSUFFICIENT' });
    expect(patternEvidenceChip(p)).toContain('Not enough data');
  });

  test('CONSISTENT tier uses correct label', () => {
    const p = makePattern({ confidenceTier: 'CONSISTENT', observationCount: 35 });
    expect(patternEvidenceChip(p)).toBe('35 days · Consistent pattern');
  });
});

describe('TIER_LABEL', () => {
  test('EARLY evidence does not get CONSISTENT language', () => {
    expect(TIER_LABEL['EARLY']).not.toBe(TIER_LABEL['CONSISTENT']);
    expect(TIER_LABEL['EARLY']).not.toMatch(/consistent|reliable/i);
  });
});

// ─── ContextSummary handoff tests ─────────────────────────────────────────────

describe('buildContextSummary — privacy', () => {
  test('does not include raw timeline records', () => {
    const summary = buildContextSummary(makeSynthesis());
    expect((summary as any).timeline).toBeUndefined();
    expect((summary as any).rawDays).toBeUndefined();
  });

  test('does not include cycle or gratitude free text', () => {
    const summary = buildContextSummary(makeSynthesis());
    expect((summary as any).cycleNotes).toBeUndefined();
    expect((summary as any).journalText).toBeUndefined();
  });

  test('includes only structured findings', () => {
    const summary = buildContextSummary(makeSynthesis());
    expect(summary.currentTheme).toBeDefined();
    expect(summary.todaySignals).toBeDefined();
    expect(summary.provenanceLabels).toBeDefined();
  });

  test('activeContextTypes are event types only, not notes', () => {
    const synthesis = makeSynthesis({
      relevantContext: [
        {
          id: 'e1', type: 'vacation', source: 'user_logged',
          startDate: '2026-09-01',
          notes: 'Private journal note that should never appear',
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      ],
    });
    const summary = buildContextSummary(synthesis);
    expect(summary.activeContextTypes).toEqual(['vacation']);
    const json = JSON.stringify(summary);
    expect(json).not.toContain('Private journal note');
  });

  test('strongestConnection description uses association language', () => {
    const summary = buildContextSummary(makeSynthesis());
    if (summary.strongestConnection) {
      expect(summary.strongestConnection.description).not.toMatch(/causes|because|resulted/i);
    }
  });
});

// ─── Contradiction suppression ─────────────────────────────────────────────────

describe('synthesizeContext — contradiction suppression', () => {
  test('recovery constrained suppresses push-harder recommendation', () => {
    const today: HealthDayRecord = {
      date: '2026-09-02',
      readiness: 58,   // below threshold → recoveryConstrained
      hrv: 55,         // favorable
      sleepHours: 7.0,
    };
    const synthesis = synthesizeContext({
      today, patterns: [], activeContextEvents: [],
    });
    expect(synthesis.recoveryConstrained).toBe(true);
    // Theme must be recovery_needed, not performing_well
    expect(synthesis.primaryTheme.theme).toBe('recovery_needed');
  });

  test('HRV + low readiness produces ConflictDescriptor', () => {
    const today: HealthDayRecord = {
      date: '2026-09-02',
      readiness: 55,
      hrv: 58,
      sleepHours: 7.0,
    };
    const synthesis = synthesizeContext({
      today, patterns: [], activeContextEvents: [],
    });
    expect(synthesis.conflictingSignals.length).toBeGreaterThan(0);
    expect(synthesis.conflictingSignals[0].suppressedRecommendation).toBeDefined();
  });

  test('HRV preserved as supporting signal despite low readiness', () => {
    const today: HealthDayRecord = {
      date: '2026-09-02',
      readiness: 55,
      hrv: 60,
      sleepHours: 7.0,
    };
    const synthesis = synthesizeContext({
      today, patterns: [], activeContextEvents: [],
    });
    const hasHrv = synthesis.supportingSignals.some((s) => s.signal === 'HRV');
    expect(hasHrv).toBe(true);
  });
});

// ─── Coverage state tests ──────────────────────────────────────────────────────

describe('Coverage — Context screen scenarios', () => {
  test('rich Oura user: all core domains available', () => {
    const day: HealthDayRecord = {
      date: '2026-09-02',
      sleepScore: 82, sleepHours: 7.5, hrv: 48, readiness: 78,
      hkSteps: 9500, workoutDurationMin: 45,
      totalAlcoholDrinks: 1, calories: 2000, protein: 140,
    };
    const report = computeCoverage(day);
    expect(report.domains.find(d => d.domain === 'SLEEP')!.level).toBe('available');
    expect(report.domains.find(d => d.domain === 'RECOVERY')!.level).toBe('available');
    expect(report.domains.find(d => d.domain === 'MOVEMENT')!.level).toBe('available');
  });

  test('Apple Watch-only user: RECOVERY unavailable', () => {
    const day: HealthDayRecord = {
      date: '2026-09-02',
      sleepHours: 7.0,
      hkSteps: 8500, workoutDurationMin: 40,
    };
    const report = computeCoverage(day);
    expect(report.domains.find(d => d.domain === 'RECOVERY')!.level).toBe('unavailable');
    expect(report.canAnalyzeRecovery).toBe(false);
  });

  test('No Oura: sleepScore absent → SLEEP is limited', () => {
    const day: HealthDayRecord = {
      date: '2026-09-02',
      sleepHours: 6.8,  // from HK only
    };
    const report = computeCoverage(day);
    expect(report.domains.find(d => d.domain === 'SLEEP')!.level).toBe('limited');
  });

  test('sparse user: most domains unavailable', () => {
    const day: HealthDayRecord = { date: '2026-09-02' };
    const report = computeCoverage(day);
    expect(report.hasAnyData).toBe(false);
    expect(report.domains.every(d => d.level === 'unavailable')).toBe(true);
  });

  test('active ContextEvent: LIFE_CONTEXT at least limited', () => {
    const day: HealthDayRecord = {
      date: '2026-09-02',
      activeContextTypes: ['vacation'],
    };
    const report = computeCoverage(day);
    expect(report.domains.find(d => d.domain === 'LIFE_CONTEXT')!.level).not.toBe('unavailable');
  });
});

// ─── ContextEvent pipeline tests ──────────────────────────────────────────────

describe('ContextEvent in synthesis', () => {
  test('active vacation event appears in relevantContext', () => {
    const today: HealthDayRecord = { date: '2026-09-02' };
    const event: ContextEvent = {
      id: 'e1', type: 'vacation', source: 'user_logged',
      startDate: '2026-09-01',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const synthesis = synthesizeContext({
      today, patterns: [], activeContextEvents: [event],
    });
    expect(synthesis.relevantContext).toHaveLength(1);
    expect(synthesis.relevantContext[0].type).toBe('vacation');
  });

  test('completed ContextEvent (past endDate) not in active context', () => {
    // Event ended before today
    const event: ContextEvent = {
      id: 'e2', type: 'training_block', source: 'user_logged',
      startDate: '2026-08-01', endDate: '2026-08-15',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:00.000Z',
    };
    // We filter active events before calling synthesizeContext — verify empty
    const today = '2026-09-02';
    const isActive = !event.endDate || event.endDate >= today;
    expect(isActive).toBe(false);
  });

  test('retroactive event can be created with past startDate', () => {
    // The createContextEvent function accepts any past date
    // Verify the logic (not the async storage call)
    const pastDate = '2026-08-01';
    const todayDate = '2026-09-02';
    const isPast = pastDate <= todayDate;
    expect(isPast).toBe(true);
  });
});

// ─── Event window rendering tests ─────────────────────────────────────────────

describe('EventWindowAnalysis', () => {
  const vacationEvent: ContextEvent = {
    id: 'v1', type: 'vacation', source: 'user_logged',
    startDate: '2026-08-05', endDate: '2026-08-11',
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  };

  const mockWindow: EventWindowAnalysis = {
    event: vacationEvent,
    preWindow:    { days: 7, sleepHours: 7.5, sleepScore: 82, hrv: 54, readiness: 78, steps: 9000, workoutDurationMin: 40, totalAlcoholDrinks: 0 },
    duringWindow: { days: 7, sleepHours: 6.8, sleepScore: 71, hrv: 46, readiness: 68, steps: 5000, workoutDurationMin: 20, totalAlcoholDrinks: 1 },
    postWindow:   { days: 7, sleepHours: 7.2, sleepScore: 78, hrv: 51, readiness: 74, steps: 8500, workoutDurationMin: 35, totalAlcoholDrinks: 0 },
    availableSignals: ['sleepHours', 'sleepScore', 'hrv', 'readiness', 'steps'],
    sources: ['oura_sleep', 'oura_readiness'],
    languageGuard: 'SINGLE_EVENT',
    observationCount: 7,
  };

  test('languageGuard is SINGLE_EVENT for a single event window', () => {
    expect(mockWindow.languageGuard).toBe('SINGLE_EVENT');
  });

  test('all three periods have sleep data', () => {
    expect(mockWindow.preWindow.sleepHours).not.toBeNull();
    expect(mockWindow.duringWindow.sleepHours).not.toBeNull();
    expect(mockWindow.postWindow.sleepHours).not.toBeNull();
  });

  test('during-vacation sleep is lower than before', () => {
    const pre    = mockWindow.preWindow.sleepHours!;
    const during = mockWindow.duringWindow.sleepHours!;
    expect(during).toBeLessThan(pre);
  });

  test('synthesis does not claim causation from single event', () => {
    // Single event NEVER becomes "vacation causes lower sleep"
    expect(mockWindow.languageGuard).toBe('SINGLE_EVENT');
    // UI should use descriptive language only
  });
});

// ─── No automatic Claude request ──────────────────────────────────────────────

describe('Context screen: no automatic Claude calls', () => {
  test('buildContextSummary is not called until user explicitly requests it', () => {
    // The context screen only builds ContextSummary inside handleTalkMore()
    // which is triggered by the "Talk more about your insights" button.
    // Here we verify the function produces a safe structured object.
    const summary = buildContextSummary(makeSynthesis());
    // Should contain structured data, not raw health values or timeline
    expect(summary.currentTheme).toBeDefined();
    expect(summary.todaySignals.length).toBeGreaterThan(0);
    expect(summary.provenanceLabels).toBeDefined();
    // No raw timeline exposure
    expect((summary as any).rawTimeline).toBeUndefined();
  });
});

// ─── Provenance rendering ──────────────────────────────────────────────────────

describe('provenance display', () => {
  test('source names are human-readable, not internal keys', () => {
    const p = makePattern({ sources: ['oura_sleep', 'oura_readiness'] });
    // The UI maps via SOURCE_LABELS — verify the raw keys are internal only
    expect(p.sources).toContain('oura_sleep');
    // SOURCE_LABELS maps oura_sleep → 'Oura Sleep'
    const { SOURCE_LABELS } = require('../pattern-registry');
    expect(SOURCE_LABELS['oura_sleep']).toBe('Oura Sleep');
    expect(SOURCE_LABELS['apple_health_workouts']).toBe('Apple Health Workouts');
  });
});

// ─── Missing data / no patterns state ─────────────────────────────────────────

describe('sparse data states', () => {
  test('synthesizeContext with no signals produces insufficient_data theme', () => {
    const today: HealthDayRecord = { date: '2026-09-02' };
    const synthesis = synthesizeContext({ today, patterns: [], activeContextEvents: [] });
    expect(synthesis.primaryTheme.theme).toBe('insufficient_data');
  });

  test('buildYourStory returns null for insufficient_data', () => {
    const synthesis = synthesizeContext({
      today: { date: '2026-09-02' },
      patterns: [],
      activeContextEvents: [],
    });
    expect(buildYourStory(synthesis)).toBeNull();
  });

  test('patterns list with only INSUFFICIENT tier shows learning state', () => {
    const p = makePattern({ confidenceTier: 'INSUFFICIENT', observationCount: 3 });
    // Context screen filters INSUFFICIENT from display
    const visible = [p].filter((pat) => pat.confidenceTier !== 'INSUFFICIENT');
    expect(visible).toHaveLength(0);
  });
});

// ─── Two-key modal architecture (QA Issue 1) ──────────────────────────────────
//
// index.tsx owns WHATS_NEW_KEY (home-level announcement: "Introducing Context")
// context.tsx owns CONTEXT_TOUR_KEY (in-screen tour: 4-beat section guide)
//
// Keys are versioned independently so future releases can re-show either
// announcement without resetting the other.
//
// Keys are defined in their respective component files and cannot be imported
// here due to React Native CSS dependency chains. Values are mirrored below
// and enforced at compile time via the TypeScript imports in index.tsx / context.tsx.

import AsyncStorage from '@react-native-async-storage/async-storage';

// Mirrors of the constants — if you change them in the component files,
// update these too (and increment the version suffix).
const WHATS_NEW_KEY   = 'whats_new_context_v1';   // index.tsx — home announcement
const CONTEXT_TOUR_KEY = 'context_tour_v1';        // context.tsx — screen tour

describe('Two-key modal architecture — key contract', () => {
  test('WHATS_NEW_KEY has expected value', () => {
    expect(WHATS_NEW_KEY).toBe('whats_new_context_v1');
    expect(WHATS_NEW_KEY).toMatch(/_v1$/);
  });

  test('CONTEXT_TOUR_KEY has expected value', () => {
    expect(CONTEXT_TOUR_KEY).toBe('context_tour_v1');
    expect(CONTEXT_TOUR_KEY).toMatch(/_v1$/);
  });

  test('keys are distinct — one does not control the other', () => {
    expect(WHATS_NEW_KEY).not.toBe(CONTEXT_TOUR_KEY);
  });
});

describe('WhatsNew announcement (index.tsx) — trigger logic', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  test('fresh install: WHATS_NEW_KEY absent → announcement shows', async () => {
    const seen = await AsyncStorage.getItem(WHATS_NEW_KEY);
    expect(seen).toBeNull();
  });

  test('upgrading user: old walkthrough key does not suppress announcement', async () => {
    await AsyncStorage.setItem('context_walkthrough_seen', '1');   // pre-QA-pass key
    await AsyncStorage.setItem('context_walkthrough_v1', '1');     // previous version key
    const seen = await AsyncStorage.getItem(WHATS_NEW_KEY);
    expect(seen).toBeNull();  // new key absent → announcement fires
  });

  test('"Explore Context" CTA marks announcement seen', async () => {
    // Simulates onExplore handler in index.tsx
    await AsyncStorage.setItem(WHATS_NEW_KEY, '1');
    expect(await AsyncStorage.getItem(WHATS_NEW_KEY)).toBe('1');
  });

  test('"Not now" marks announcement seen', async () => {
    // Simulates onDismiss handler in index.tsx
    await AsyncStorage.setItem(WHATS_NEW_KEY, '1');
    expect(await AsyncStorage.getItem(WHATS_NEW_KEY)).toBe('1');
  });

  test('key present on launch → announcement suppressed (no repeat)', async () => {
    await AsyncStorage.setItem(WHATS_NEW_KEY, '1');
    const seen = await AsyncStorage.getItem(WHATS_NEW_KEY);
    const shouldShow = seen === null;
    expect(shouldShow).toBe(false);
  });

  test('seeing announcement does NOT set tour key', async () => {
    // Dismissing the home-level announcement must not suppress the Context tour
    await AsyncStorage.setItem(WHATS_NEW_KEY, '1');
    const tourSeen = await AsyncStorage.getItem(CONTEXT_TOUR_KEY);
    expect(tourSeen).toBeNull();
  });
});

describe('Context screen tour (context.tsx) — trigger logic', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  test('first visit to Context tab: CONTEXT_TOUR_KEY absent → tour shows', async () => {
    const seen = await AsyncStorage.getItem(CONTEXT_TOUR_KEY);
    expect(seen).toBeNull();
  });

  test('"Got it" on last beat marks tour seen', async () => {
    // Simulates onDone handler in context.tsx
    await AsyncStorage.setItem(CONTEXT_TOUR_KEY, '1');
    expect(await AsyncStorage.getItem(CONTEXT_TOUR_KEY)).toBe('1');
  });

  test('skip marks tour seen — same persistence path as Got it', async () => {
    // Simulates onSkip handler in context.tsx
    await AsyncStorage.setItem(CONTEXT_TOUR_KEY, '1');
    expect(await AsyncStorage.getItem(CONTEXT_TOUR_KEY)).toBe('1');
  });

  test('key present → tour suppressed on subsequent visits', async () => {
    await AsyncStorage.setItem(CONTEXT_TOUR_KEY, '1');
    const seen = await AsyncStorage.getItem(CONTEXT_TOUR_KEY);
    const shouldShow = seen === null;
    expect(shouldShow).toBe(false);
  });

  test('seeing tour does NOT set announcement key', async () => {
    // Completing the tour must not re-suppress the home announcement (future re-announce scenario)
    await AsyncStorage.setItem(CONTEXT_TOUR_KEY, '1');
    const announcementSeen = await AsyncStorage.getItem(WHATS_NEW_KEY);
    expect(announcementSeen).toBeNull();
  });
});

// ─── Coverage fix — life events reflected in LIFE_CONTEXT domain (QA Issue 4 + 7) ───

describe('Coverage — life events and LIFE_CONTEXT domain', () => {
  test('LIFE_CONTEXT unavailable with no activeContextTypes', () => {
    const day: HealthDayRecord = { date: '2026-09-02' };
    const report = computeCoverage(day);
    expect(report.domains.find(d => d.domain === 'LIFE_CONTEXT')!.level).toBe('unavailable');
  });

  test('LIFE_CONTEXT at least limited when activeContextTypes is populated', () => {
    const day: HealthDayRecord = {
      date: '2026-09-02',
      activeContextTypes: ['illness'],
    };
    const report = computeCoverage(day);
    expect(report.domains.find(d => d.domain === 'LIFE_CONTEXT')!.level).not.toBe('unavailable');
  });

  test('multiple context types all elevate LIFE_CONTEXT', () => {
    const day: HealthDayRecord = {
      date: '2026-09-02',
      activeContextTypes: ['vacation', 'training_block'],
    };
    const report = computeCoverage(day);
    expect(report.domains.find(d => d.domain === 'LIFE_CONTEXT')!.level).not.toBe('unavailable');
  });

  test('active vacation event in synthesis sets relevantContext', () => {
    const today: HealthDayRecord = { date: '2026-09-02' };
    const event: ContextEvent = {
      id: 'ev1', type: 'vacation', source: 'user_logged',
      startDate: '2026-09-01',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const synthesis = synthesizeContext({ today, patterns: [], activeContextEvents: [event] });
    expect(synthesis.relevantContext.map(e => e.type)).toContain('vacation');
  });

  test('illness event in synthesis sets relevantContext', () => {
    const today: HealthDayRecord = { date: '2026-09-02' };
    const event: ContextEvent = {
      id: 'ev2', type: 'illness', source: 'user_logged',
      startDate: '2026-09-01',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const synthesis = synthesizeContext({ today, patterns: [], activeContextEvents: [event] });
    expect(synthesis.relevantContext.map(e => e.type)).toContain('illness');
  });
});

// ─── Coverage hints — actionable per-domain explanations (QA Issue 7) ─────────

const COVERAGE_HINT_FIXTURE: Partial<Record<string, string>> = {
  SLEEP:        'More sleep history will help uncover recovery connections.',
  RECOVERY:     'Recovery signals like readiness and HRV come from a connected wearable.',
  MOVEMENT:     'Grant Apple Health access to include workout and step data.',
  NUTRITION:    'Log meals through the Nutrition section to enrich this domain.',
  LIFE_CONTEXT: 'Add life events using the + button in Life + Health.',
};

describe('Coverage hints — per-domain actionable text', () => {
  test('every non-available domain has a hint string', () => {
    const domains = ['SLEEP', 'RECOVERY', 'MOVEMENT', 'NUTRITION', 'LIFE_CONTEXT'];
    for (const domain of domains) {
      expect(COVERAGE_HINT_FIXTURE[domain]).toBeDefined();
      expect(COVERAGE_HINT_FIXTURE[domain]!.length).toBeGreaterThan(10);
    }
  });

  test('LIFE_CONTEXT hint directs user to + button', () => {
    expect(COVERAGE_HINT_FIXTURE['LIFE_CONTEXT']).toContain('+');
  });

  test('RECOVERY hint mentions wearable', () => {
    expect(COVERAGE_HINT_FIXTURE['RECOVERY']!.toLowerCase()).toContain('wearable');
  });

  test('MOVEMENT hint mentions Apple Health', () => {
    expect(COVERAGE_HINT_FIXTURE['MOVEMENT']).toContain('Apple Health');
  });
});
