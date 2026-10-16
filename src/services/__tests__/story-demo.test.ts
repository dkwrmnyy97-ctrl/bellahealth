/**
 * story-demo.test.ts
 *
 * Renders 6 representative scenarios as final narrative output for review.
 * Not a correctness test — run with:  npx jest story-demo --verbose --no-coverage
 */

import {
  buildStoryEpisode,
} from '../story-engine';
import { renderStoryEpisode } from '../../utils/pattern-language';
import type { HealthDayRecord, EventWindowAnalysis, PeriodStats } from '../pattern-engine';
import type { SynthesisResult } from '../context-synthesis';
import type { ContextEvent, ContextEventType } from '../context-events';

// ─── Fixtures (identical to story-engine.test.ts) ─────────────────────────────

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
    id: `demo-${type}-${startDaysAgo}`,
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
    generatedAt:        TODAY + 'T00:00:00Z',
    primaryTheme:       { theme: 'insufficient_data', rationale: [] },
    supportingSignals:  [],
    concerningSignals:  [],
    conflictingSignals: [],
    relevantContext:    [],
    strongestConnection: null,
    allPatterns:        [],
    eventWindows:       [],
    eventTypePattern:   null,
    recoveryConstrained: false,
    sources:            [],
    ...overrides,
  };
}

function render(label: string, synthesis: SynthesisResult, timeline: HealthDayRecord[], today: HealthDayRecord) {
  const episode = buildStoryEpisode(synthesis, timeline, today);
  const text    = renderStoryEpisode(episode);
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`SCENARIO: ${label}`);
  console.log('─'.repeat(60));
  console.log(text ?? '(null — not surface-worthy)');
}

// ─── A: Travel + high activity + low sleep/HRV → illness → lighter activity afterward
describe('Demo A: Travel (high activity + low sleep/HRV) → completed illness → lighter activity afterward', () => {
  it('renders', () => {
    // Travel ended 12 days ago. Illness ended 4 days ago (completed).
    const travelEvent  = makeEvent('travel',  12, 7);
    const illnessEvent = makeEvent('illness',  4, 7);

    // Travel: sleep lower, activity higher, HRV lower
    const travelWindow = makeWindow(
      travelEvent,
      { days: 7, sleepHours: 7.8, hrv: 52, readiness: 78, workoutDurationMin: 35 },
      { days: 7, sleepHours: 6.1, hrv: 37, readiness: 63, workoutDurationMin: 72 },
    );
    // Illness: HRV + readiness lower; activity dropped (recovery-aligned)
    const illnessWindow = makeWindow(
      illnessEvent,
      { days: 7, sleepHours: 7.5, hrv: 48, readiness: 74, workoutDurationMin: 35 },
      { days: 7, sleepHours: 7.2, hrv: 34, readiness: 57, workoutDurationMin: 10 },
    );

    // 45-day timeline: 30 days of clear baseline, then disruption during travel/illness, then recovery.
    // Long baseline ensures median stays high, so post-illness metrics read as still below baseline.
    const timeline = buildTimeline(45, () => ({
      sleepHours: 7.5, sleepScore: 78, hrv: 52, readiness: 78, workoutDurationMin: 40,
    }));
    // Travel period (indices 26–32, ~18–12 days ago): high activity, lower sleep/HRV
    timeline.slice(26, 33).forEach(d => { d.workoutDurationMin = 72; d.hrv = 37; d.readiness = 63; d.sleepHours = 6.1; });
    // Illness period (indices 33–39, ~11–5 days ago): very light activity, low HRV/readiness
    timeline.slice(33, 40).forEach(d => { d.workoutDurationMin = 8; d.hrv = 32; d.readiness = 55; });
    // Post-illness last 5 days (indices 40–44): activity still lighter, HRV/readiness recovering but below baseline
    timeline.slice(40).forEach((d, i) => { d.readiness = 60 + i * 3; d.hrv = 38 + i * 2; d.workoutDurationMin = 12 + i * 3; });

    const today: HealthDayRecord = { date: TODAY, readiness: 72, hrv: 46, sleepScore: 78, sleepHours: 7.5, workoutDurationMin: 24 };

    render('A: Travel (high activity + low sleep/HRV) → completed illness → lighter activity after', makeSynthesis({ eventWindows: [travelWindow, illnessWindow] }), timeline, today);
    expect(true).toBe(true);
  });
});

// ─── B: Completed travel without illness ─────────────────────────────────────
describe('Demo B: Completed travel (no subsequent illness)', () => {
  it('renders', () => {
    const travelEvent = makeEvent('travel', 4, 7);   // ended 4 days ago

    const travelWindow = makeWindow(
      travelEvent,
      { days: 7, sleepHours: 7.8, hrv: 54, readiness: 80, workoutDurationMin: 35 },
      { days: 7, sleepHours: 5.9, hrv: 37, readiness: 62, workoutDurationMin: 75 },
    );

    const timeline = buildTimeline(30, () => ({
      sleepHours: 7.8, sleepScore: 82, hrv: 54, readiness: 80,
    }));
    // Travel period: worse metrics
    timeline.slice(16, 23).forEach(d => { d.sleepHours = 5.9; d.hrv = 37; d.readiness = 62; });
    // Post-travel recovery
    timeline.slice(26).forEach((d, i) => { d.readiness = 68 + i * 3; d.hrv = 44 + i * 2; });

    const today: HealthDayRecord = { date: TODAY, readiness: 76, hrv: 50, sleepScore: 81, sleepHours: 7.6 };

    render('B: Completed travel without illness (futureLesson close)', makeSynthesis({
      eventWindows: [travelWindow],
    }), timeline, today);
    expect(true).toBe(true);
  });
});

// ─── S3: Travel → ongoing illness with hydration gap ─────────────────────────
// Travel ended 5 days ago, illness started 4 days ago (gap = 1 day ≤ 3 → transition fires).
// Hydration was not logged during travel → not_tracked note for the travel window.
describe('Demo S3: Travel → ongoing illness (gap 1 day, hydration not tracked during travel)', () => {
  it('renders', () => {
    const travelEvent  = makeEvent('travel',  5, 7);          // ended 5 days ago (7-day trip)
    const illnessEvent = makeEvent('illness', 0, 4, true);    // started 4 days ago, ongoing

    const travelWindow = makeWindow(
      travelEvent,
      { days: 7, sleepHours: 7.8, hrv: 52, readiness: 78, workoutDurationMin: 40 },
      { days: 7, sleepHours: 6.4, hrv: 40, readiness: 67, workoutDurationMin: 65 },
    );
    const illnessWindow = makeWindow(
      illnessEvent,
      { days: 7, sleepHours: 7.5, hrv: 48, readiness: 74 },
      { days: 4, sleepHours: 7.2, hrv: 35, readiness: 55 },
      true,
    );

    // Timeline: 30 days. Water logged only in first 18 days (pre-travel baseline).
    // Travel window (days 5–12 ago, indices 18–25): no water logged.
    // Illness (last 4 days): no water logged either.
    const timeline = buildTimeline(30, () => ({
      sleepHours: 7.5, sleepScore: 78, hrv: 48, readiness: 72,
    }));
    // Baseline water (pre-travel)
    timeline.slice(0, 18).forEach(d => { d.waterOz = 80; });
    // No waterOz during travel or illness (indices 18–29)
    // Illness days: lower metrics
    timeline.slice(-4).forEach(d => { d.readiness = 55; d.hrv = 35; });

    const today: HealthDayRecord = { date: TODAY, readiness: 55, hrv: 35, sleepScore: 72, sleepHours: 7.0 };

    render('S3: Travel → ongoing illness (hydration not tracked during trip)', makeSynthesis({
      eventWindows: [travelWindow, illnessWindow],
    }), timeline, today);
    expect(true).toBe(true);
  });
});

// ─── D: Completed illness/recovery ────────────────────────────────────────────
describe('Demo D: Completed illness with aftermath recovery (no futureLesson)', () => {
  it('renders', () => {
    const illnessEvent = makeEvent('illness', 4, 7);   // ended 4 days ago

    const illnessWindow = makeWindow(
      illnessEvent,
      { days: 7, sleepHours: 7.5, hrv: 52, readiness: 78 },
      { days: 7, sleepHours: 7.8, hrv: 35, readiness: 55, workoutDurationMin: 8 },
    );

    const timeline = buildTimeline(30, () => ({
      sleepHours: 7.5, sleepScore: 78, hrv: 52, readiness: 78,
    }));
    timeline.slice(19, 26).forEach(d => { d.readiness = 55; d.hrv = 35; d.sleepHours = 7.8; });
    // Post-illness: recovering
    timeline.slice(26).forEach((d, i) => { d.readiness = 62 + i * 4; d.hrv = 40 + i * 3; });

    const today: HealthDayRecord = { date: TODAY, readiness: 74, hrv: 49, sleepScore: 80, sleepHours: 7.4 };

    render('D: Completed illness — aftermath + nextFocus close (no "next illness" language)', makeSynthesis({
      eventWindows: [illnessWindow],
    }), timeline, today);
    expect(true).toBe(true);
  });
});

// ─── E: Ongoing stress ────────────────────────────────────────────────────────
describe('Demo E: Ongoing stressful period with useful close', () => {
  it('renders', () => {
    const stressEvent = makeEvent('stressful_period', 0, 8, true);   // ongoing

    const stressWindow = makeWindow(
      stressEvent,
      { days: 7, sleepHours: 7.6, hrv: 54, readiness: 80, sleepScore: 83 },
      { days: 8, sleepHours: 6.1, hrv: 38, readiness: 61, sleepScore: 68 },
      true,
    );

    // Flat timeline where current metrics are uniformly disrupted (so currentDirection = stable)
    const timeline = buildTimeline(30, () => ({
      sleepHours: 6.1, sleepScore: 68, hrv: 38, readiness: 61,
    }));

    const today: HealthDayRecord = { date: TODAY, readiness: 61, hrv: 38, sleepScore: 68, sleepHours: 6.1 };

    render('E: Ongoing stressful period (metric drops → nextFocus close)', makeSynthesis({
      eventWindows: [stressWindow],
    }), timeline, today);
    expect(true).toBe(true);
  });
});

// ─── F: Sauna association, no meaningful episode ──────────────────────────────
describe('Demo F: Sauna association with no event context (should NOT appear in Your Story)', () => {
  it('renders (expected: null — suppressed from Your Story)', () => {
    // Strong sauna → readiness association, but no event context, no trend
    const timeline = buildTimeline(40, (i) => ({
      sleepHours: 7.5, sleepScore: 78, hrv: 50, readiness: i % 3 === 0 ? 85 : 72,
      hasSaunaSession: i % 3 === 0,
    }));

    // Today is at the baseline median — no significant physio state
    const today: HealthDayRecord = { date: TODAY, readiness: 72, hrv: 50, sleepScore: 78, sleepHours: 7.5 };

    const episode = buildStoryEpisode(makeSynthesis(), timeline, today);
    const text = renderStoryEpisode(episode);

    console.log('\n' + '─'.repeat(60));
    console.log('SCENARIO: F: Sauna correlation only (no event context)');
    console.log('─'.repeat(60));
    console.log(`Your Story output: ${text ?? '(null — correctly suppressed)'}`);
    console.log(`surfaceWorthy: ${episode.surfaceWorthy} (behavioral finding still available for What's Connected)`);
    const saunaFinding = episode.behavioralFindings.find(f => f.behaviorType === 'sauna');
    console.log(`Sauna finding: ${saunaFinding ? `${saunaFinding.evidence.strength} (available for What's Connected)` : 'none'}`);

    // Your Story should be null — correlation alone is not a story
    expect(text).toBeNull();
    expect(true).toBe(true);
  });
});
