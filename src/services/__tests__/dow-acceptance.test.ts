/**
 * dow-acceptance.test.ts
 *
 * Acceptance tests for the day-of-week pattern detection system.
 * Covers all 8 acceptance criteria requested in the review.
 */

import { detectDowPatterns } from '../dow-pattern-engine';
import { adaptOuraWeekly } from '../source-adapters';
import type { HealthDayRecord } from '../pattern-engine';
import type { OuraWeeklyDay } from '../oura';

// ─── AsyncStorage mock ────────────────────────────────────────────────────────

const store: Record<string, string> = {};

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem:    jest.fn((key: string)         => Promise.resolve(store[key] ?? null)),
  setItem:    jest.fn((key: string, val: string) => { store[key] = val; return Promise.resolve(); }),
  removeItem: jest.fn((key: string)         => { delete store[key]; return Promise.resolve(); }),
}));

beforeEach(() => {
  // Clear storage before each test
  Object.keys(store).forEach((k) => delete store[k]);
  jest.clearAllMocks();
});

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/** Returns a YYYY-MM-DD string for a date that is `daysAgo` days in the past,
 *  landing on a specific day-of-week (0=Sun…6=Sat).
 *  Walks backward from today until it finds the right DOW, then adjusts by weeks. */
function dateForDow(targetDow: number, weeksAgo: number): string {
  const d = new Date();
  // Walk back to the most recent targetDow
  while (d.getDay() !== targetDow) d.setDate(d.getDate() - 1);
  // Then go back the requested number of weeks
  d.setDate(d.getDate() - weeksAgo * 7);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Build a minimal HealthDayRecord with just the fields we set. */
function makeRecord(date: string, fields: Partial<HealthDayRecord>): HealthDayRecord {
  return { date, ...fields };
}

/**
 * Build a synthetic timeline with:
 *   - `thursdayOccurrences` Thursdays where readiness = thursdayReadiness
 *   - `otherDaysPerWeek` other-day records per week where readiness = baselineReadiness
 *
 * Each Thursday and its surrounding other days are placed weeksAgo apart.
 */
function buildReadinessTimeline({
  thursdayOccurrences,
  thursdayReadiness,
  baselineReadiness,
  otherDaysPerWeek = 4,
}: {
  thursdayOccurrences: number;
  thursdayReadiness: number;
  baselineReadiness: number;
  otherDaysPerWeek?: number;
}): HealthDayRecord[] {
  const records: HealthDayRecord[] = [];
  const DOW_THURSDAY = 4;
  // Use Mon(1), Tue(2), Wed(3), Fri(5) as "other" days
  const otherDows = [1, 2, 3, 5].slice(0, otherDaysPerWeek);

  for (let week = 0; week < thursdayOccurrences; week++) {
    records.push(makeRecord(dateForDow(DOW_THURSDAY, week), { readiness: thursdayReadiness }));
    for (const dow of otherDows) {
      records.push(makeRecord(dateForDow(dow, week), { readiness: baselineReadiness }));
    }
  }
  return records;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. No observation with insufficient history
// ─────────────────────────────────────────────────────────────────────────────

describe('1. Insufficient history produces no results', () => {
  it('returns [] with only 3 Thursday occurrences (below MIN_DOW_OCCURRENCES=4)', () => {
    // 3 Thursdays, strong signal, plenty of other days
    const timeline = buildReadinessTimeline({
      thursdayOccurrences: 3,
      thursdayReadiness: 45,
      baselineReadiness: 65,
    });
    const results = detectDowPatterns(timeline);
    // No readiness pattern for Thursday should appear
    expect(results.filter(r => r.signal === 'readiness' && r.dayOfWeek === 4)).toHaveLength(0);
  });

  it('returns [] with 4 Thursdays but only 6 other-day baseline records (below MIN_BASELINE_DAYS=8)', () => {
    const timeline = buildReadinessTimeline({
      thursdayOccurrences: 4,
      thursdayReadiness: 45,
      baselineReadiness: 65,
      otherDaysPerWeek: 1, // Only 4 total other-day records across 4 weeks
    });
    const results = detectDowPatterns(timeline);
    expect(results.filter(r => r.signal === 'readiness' && r.dayOfWeek === 4)).toHaveLength(0);
  });

  it('returns [] on an empty timeline', () => {
    expect(detectDowPatterns([])).toHaveLength(0);
  });

  it('returns [] when effect is below MEANINGFUL_EFFECT_THRESHOLD (readiness threshold=3)', () => {
    // 2-point difference: below the 3-point threshold
    const timeline = buildReadinessTimeline({
      thursdayOccurrences: 8,
      thursdayReadiness: 60,
      baselineReadiness: 62, // diff = 2, below threshold
    });
    const results = detectDowPatterns(timeline);
    expect(results.filter(r => r.signal === 'readiness' && r.dayOfWeek === 4)).toHaveLength(0);
  });

  it('returns [] when consistency is below 65%', () => {
    // Build Thursdays where only 50% go in one direction
    const DOW_THURSDAY = 4;
    const records: HealthDayRecord[] = [];
    // 4 Thursdays: 2 low (50) and 2 high (70) — mixed signal
    const readinessValues = [50, 70, 50, 70];
    for (let i = 0; i < 4; i++) {
      records.push(makeRecord(dateForDow(DOW_THURSDAY, i), { readiness: readinessValues[i] }));
    }
    // 20 other-day records at 60
    for (let dow of [1, 2, 3, 5]) {
      for (let week = 0; week < 5; week++) {
        records.push(makeRecord(dateForDow(dow, week), { readiness: 60 }));
      }
    }
    const results = detectDowPatterns(records);
    expect(results.filter(r => r.signal === 'readiness' && r.dayOfWeek === 4)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. A legitimate pattern appears once evidence requirements are met
// ─────────────────────────────────────────────────────────────────────────────

describe('2. Legitimate pattern surfaces when evidence requirements are met', () => {
  it('detects readiness pattern after 6 consistent Thursdays', () => {
    const timeline = buildReadinessTimeline({
      thursdayOccurrences: 6,
      thursdayReadiness: 48,
      baselineReadiness: 65,
    });
    const results = detectDowPatterns(timeline);
    const thursdayPattern = results.find(r => r.signal === 'readiness' && r.dayOfWeek === 4);

    expect(thursdayPattern).toBeDefined();
    expect(thursdayPattern!.direction).toBe('below_baseline');
    expect(thursdayPattern!.confidenceTier).not.toBe('INSUFFICIENT');
    expect(thursdayPattern!.occurrences).toBe(6);
  });

  it('detects an above-baseline pattern correctly', () => {
    const timeline = buildReadinessTimeline({
      thursdayOccurrences: 6,
      thursdayReadiness: 80,
      baselineReadiness: 60,
    });
    const results = detectDowPatterns(timeline);
    const thursdayPattern = results.find(r => r.signal === 'readiness' && r.dayOfWeek === 4);

    expect(thursdayPattern).toBeDefined();
    expect(thursdayPattern!.direction).toBe('above_baseline');
  });

  it('assigns EARLY tier for exactly 4 occurrences meeting consistency', () => {
    const timeline = buildReadinessTimeline({
      thursdayOccurrences: 4,
      thursdayReadiness: 48,
      baselineReadiness: 65,
    });
    const results = detectDowPatterns(timeline);
    const p = results.find(r => r.signal === 'readiness' && r.dayOfWeek === 4);
    expect(p).toBeDefined();
    expect(p!.confidenceTier).toBe('EARLY');
  });

  it('assigns PATTERN tier for 6–9 occurrences', () => {
    const timeline = buildReadinessTimeline({
      thursdayOccurrences: 7,
      thursdayReadiness: 48,
      baselineReadiness: 65,
    });
    const results = detectDowPatterns(timeline);
    const p = results.find(r => r.signal === 'readiness' && r.dayOfWeek === 4);
    expect(p).toBeDefined();
    expect(p!.confidenceTier).toBe('PATTERN');
  });

  it('assigns CONSISTENT tier for 10+ occurrences with ≥70% consistency', () => {
    const timeline = buildReadinessTimeline({
      thursdayOccurrences: 12,
      thursdayReadiness: 48,
      baselineReadiness: 65,
    });
    const results = detectDowPatterns(timeline);
    const p = results.find(r => r.signal === 'readiness' && r.dayOfWeek === 4);
    expect(p).toBeDefined();
    expect(p!.confidenceTier).toBe('CONSISTENT');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Comparison is against personal baseline, not a fixed threshold
// ─────────────────────────────────────────────────────────────────────────────

describe('3. Comparison is personal-baseline-relative', () => {
  it('user with low overall readiness (avg 40) still detects a Thursday pattern relative to their own baseline', () => {
    // This user's readiness is generally low — 35 on Thursdays vs 45 on other days
    // A fixed threshold like "readiness < 50 = bad" would flag every day; we should only flag Thursdays
    const timeline = buildReadinessTimeline({
      thursdayOccurrences: 6,
      thursdayReadiness: 35,
      baselineReadiness: 45,
    });
    const results = detectDowPatterns(timeline);
    const p = results.find(r => r.signal === 'readiness' && r.dayOfWeek === 4);

    expect(p).toBeDefined();
    expect(p!.baselineMean).toBeCloseTo(45, 0);
    expect(p!.dowMean).toBeCloseTo(35, 0);
    expect(p!.direction).toBe('below_baseline');
  });

  it('user with high overall readiness (avg 85) detects a Thursday dip relative to their baseline, not a fixed floor', () => {
    // This user is generally high — 75 on Thursdays vs 88 on other days
    const timeline = buildReadinessTimeline({
      thursdayOccurrences: 6,
      thursdayReadiness: 75,
      baselineReadiness: 88,
    });
    const results = detectDowPatterns(timeline);
    const p = results.find(r => r.signal === 'readiness' && r.dayOfWeek === 4);

    expect(p).toBeDefined();
    expect(p!.direction).toBe('below_baseline');
    // baselineMean should be close to 88, NOT a fixed value like 66
    expect(p!.baselineMean).toBeGreaterThan(80);
    expect(p!.baselineMean).not.toBeCloseTo(66, 0);
  });

  it('exposes baselineMean and dowMean in the result for transparent display', () => {
    const timeline = buildReadinessTimeline({
      thursdayOccurrences: 6,
      thursdayReadiness: 50,
      baselineReadiness: 68,
    });
    const results = detectDowPatterns(timeline);
    const p = results.find(r => r.signal === 'readiness' && r.dayOfWeek === 4);
    expect(p).toBeDefined();
    expect(p!.baselineMean).toBeCloseTo(68, 0);
    expect(p!.dowMean).toBeCloseTo(50, 0);
    expect(p!.absoluteDiff).toBeCloseTo(18, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Stress-high and recovery-low don't produce redundant observations
// ─────────────────────────────────────────────────────────────────────────────

describe('4. Stress/recovery same-DOW deduplication', () => {
  function buildStressRecoveryTimeline(occurrences: number): HealthDayRecord[] {
    const records: HealthDayRecord[] = [];
    const DOW_THURSDAY = 4;
    const otherDows = [1, 2, 3, 5];

    for (let week = 0; week < occurrences; week++) {
      // Thursdays: high stress, low recovery
      records.push(makeRecord(dateForDow(DOW_THURSDAY, week), {
        stressHighMinutes:   80,
        recoveryHighMinutes: 20,
      }));
      // Other days: low stress, high recovery
      for (const dow of otherDows) {
        records.push(makeRecord(dateForDow(dow, week), {
          stressHighMinutes:   30,
          recoveryHighMinutes: 70,
        }));
      }
    }
    return records;
  }

  it('returns exactly one observation when stress-high and recovery-low fire on the same Thursday', () => {
    const timeline = buildStressRecoveryTimeline(6);
    const results = detectDowPatterns(timeline);
    const thursdayStressResults = results.filter(r => r.dayOfWeek === 4);

    // Both qualify independently, but deduplication must suppress one
    expect(thursdayStressResults).toHaveLength(1);
  });

  it('the surviving observation is the higher-consistency one', () => {
    // Make stressHighMinutes perfectly consistent (100%) but recoveryHighMinutes only 70%
    const records: HealthDayRecord[] = [];
    const DOW_THURSDAY = 4;
    const otherDows = [1, 2, 3, 5];

    for (let week = 0; week < 6; week++) {
      // All Thursdays: stress always high
      records.push(makeRecord(dateForDow(DOW_THURSDAY, week), {
        stressHighMinutes:   80,
        // Recovery: only 4 of 6 weeks are low (≈67% consistency)
        recoveryHighMinutes: week < 4 ? 20 : 60,
      }));
      for (const dow of otherDows) {
        records.push(makeRecord(dateForDow(dow, week), {
          stressHighMinutes:   30,
          recoveryHighMinutes: 70,
        }));
      }
    }

    const results = detectDowPatterns(records);
    const thursdayResults = results.filter(r => r.dayOfWeek === 4);

    expect(thursdayResults).toHaveLength(1);
    // stressHighMinutes is perfectly consistent — should win
    expect(thursdayResults[0].signal).toBe('stressHighMinutes');
  });

  it('does NOT deduplicate when stress and recovery point in the SAME direction (both above baseline)', () => {
    // Unusual but valid: both stress and recovery are higher on Thursdays
    const records: HealthDayRecord[] = [];
    const DOW_THURSDAY = 4;
    const otherDows = [1, 2, 3, 5];

    for (let week = 0; week < 6; week++) {
      records.push(makeRecord(dateForDow(DOW_THURSDAY, week), {
        stressHighMinutes:   80,
        recoveryHighMinutes: 90, // both above baseline on Thursdays
      }));
      for (const dow of otherDows) {
        records.push(makeRecord(dateForDow(dow, week), {
          stressHighMinutes:   30,
          recoveryHighMinutes: 40,
        }));
      }
    }

    const results = detectDowPatterns(records);
    const thursdayResults = results.filter(r => r.dayOfWeek === 4);
    // Both are above_baseline — NOT the same underlying story, so both should appear
    expect(thursdayResults).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Answering or dismissing prevents resurfacing
// ─────────────────────────────────────────────────────────────────────────────

describe('5. Answer/dismiss prevents resurfacing', () => {
  const {
    createDowObservationNote,
    answerPatternObservation,
    dismissPatternObservation,
    getActivePendingNotes,
  } = jest.requireActual<typeof import('../pattern-observation-store')>(
    '../pattern-observation-store'
  );

  const mockPattern = {
    id: 'readiness_dow_4',
    signal: 'readiness' as const,
    dayOfWeek: 4 as const,
    dayLabel: 'Thursday',
    direction: 'below_baseline' as const,
    baselineMean: 65,
    dowMean: 50,
    absoluteDiff: 15,
    occurrences: 6,
    consistencyRate: 0.83,
    confidenceTier: 'PATTERN' as const,
  };

  it('a pending note is returned by getActivePendingNotes', async () => {
    await createDowObservationNote(
      mockPattern,
      'Your readiness tends to be lower on Thursdays.',
      'Does anything usually happen on Thursdays?',
    );
    const active = await getActivePendingNotes(new Set(['readiness_dow_4']));
    expect(active).toHaveLength(1);
    expect(active[0].status).toBe('pending');
  });

  it('answering marks the note as answered and removes it from active pending', async () => {
    await createDowObservationNote(
      mockPattern,
      'Your readiness tends to be lower on Thursdays.',
      'Does anything usually happen on Thursdays?',
    );
    await answerPatternObservation('readiness_dow_4', 'Yes, I have back-to-back meetings every Thursday afternoon.');

    const active = await getActivePendingNotes(new Set(['readiness_dow_4']));
    expect(active).toHaveLength(0);
  });

  it('dismissing marks the note as dismissed and removes it from active pending', async () => {
    await createDowObservationNote(
      mockPattern,
      'Your readiness tends to be lower on Thursdays.',
      'Does anything usually happen on Thursdays?',
    );
    await dismissPatternObservation('readiness_dow_4');

    const active = await getActivePendingNotes(new Set(['readiness_dow_4']));
    expect(active).toHaveLength(0);
  });

  it('createDowObservationNote is idempotent — calling it twice does not create a duplicate', async () => {
    await createDowObservationNote(mockPattern, 'obs', 'q');
    await createDowObservationNote(mockPattern, 'obs', 'q'); // second call

    const active = await getActivePendingNotes(new Set(['readiness_dow_4']));
    expect(active).toHaveLength(1);
  });

  it('answered note cannot be re-opened by creating a new note with the same id', async () => {
    await createDowObservationNote(mockPattern, 'obs', 'q');
    await answerPatternObservation('readiness_dow_4', 'My answer.');
    // Try to re-create — should no-op because id already exists
    await createDowObservationNote(mockPattern, 'obs', 'q');

    const active = await getActivePendingNotes(new Set(['readiness_dow_4']));
    expect(active).toHaveLength(0); // still answered, not re-pended
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Stale/disappearing pattern expires without being shown
// ─────────────────────────────────────────────────────────────────────────────

describe('6. Stale patterns expire silently', () => {
  const {
    createDowObservationNote,
    expireStalePendingNotes,
    getActivePendingNotes,
    loadPatternObservationNotes,
  } = jest.requireActual<typeof import('../pattern-observation-store')>(
    '../pattern-observation-store'
  );

  const mockPattern = {
    id: 'hrv_dow_2',
    signal: 'hrv' as const,
    dayOfWeek: 2 as const,
    dayLabel: 'Tuesday',
    direction: 'below_baseline' as const,
    baselineMean: 55,
    dowMean: 40,
    absoluteDiff: 15,
    occurrences: 5,
    consistencyRate: 0.80,
    confidenceTier: 'EARLY' as const,
  };

  it('expires a pending note when its pattern is no longer in the active set', async () => {
    await createDowObservationNote(mockPattern, 'obs', 'q');

    // Pattern disappears from timeline — active set is empty
    await expireStalePendingNotes(new Set<string>());

    const notes = await loadPatternObservationNotes();
    const note = notes.find(n => n.id === 'hrv_dow_2');
    expect(note).toBeDefined();
    expect(note!.status).toBe('dismissed');
    expect(note!.dismissedAt).toBeDefined();
  });

  it('does not expire a note that is still in the active pattern set', async () => {
    await createDowObservationNote(mockPattern, 'obs', 'q');

    // Pattern still active
    await expireStalePendingNotes(new Set(['hrv_dow_2']));

    const active = await getActivePendingNotes(new Set(['hrv_dow_2']));
    expect(active).toHaveLength(1);
    expect(active[0].status).toBe('pending');
  });

  it('does not expire already-answered notes (only pending notes are eligible)', async () => {
    await createDowObservationNote(mockPattern, 'obs', 'q');

    const { answerPatternObservation } = jest.requireActual<typeof import('../pattern-observation-store')>(
      '../pattern-observation-store'
    );
    await answerPatternObservation('hrv_dow_2', 'I know why.');

    // Pattern disappears — expiry should not touch the answered note
    await expireStalePendingNotes(new Set<string>());

    const notes = await loadPatternObservationNotes();
    const note = notes.find(n => n.id === 'hrv_dow_2');
    expect(note!.status).toBe('answered'); // unchanged
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Missing Oura daily_stress data degrades gracefully — never becomes zero
// ─────────────────────────────────────────────────────────────────────────────

describe('7. Missing stress data degrades gracefully', () => {
  it('adaptOuraWeekly does NOT set stressHighMinutes when OuraWeeklyDay has it undefined', () => {
    const day: OuraWeeklyDay = {
      date: '2026-10-01',
      dayLabel: 'Thu',
      sleepScore: 75,
      sleepHours: 7.5,
      hrv: 45,
      readiness: 72,
      steps: 8000,
      activeCalories: 400,
      // stressHighMinutes intentionally absent
    };
    const contributions = adaptOuraWeekly([day]);
    expect(contributions[0].signals.stressHighMinutes).toBeUndefined();
    expect(contributions[0].signals.recoveryHighMinutes).toBeUndefined();
  });

  it('adaptOuraWeekly DOES set stressHighMinutes=0 when the endpoint returns 0 explicitly', () => {
    // 0 is a valid data point (no high-stress minutes today) — should be preserved
    const day: OuraWeeklyDay = {
      date: '2026-10-01',
      dayLabel: 'Thu',
      sleepScore: 75,
      sleepHours: 7.5,
      hrv: 45,
      readiness: 72,
      steps: 8000,
      activeCalories: 400,
      stressHighMinutes: 0,
      recoveryHighMinutes: 120,
    };
    const contributions = adaptOuraWeekly([day]);
    expect(contributions[0].signals.stressHighMinutes).toBe(0);
    expect(contributions[0].signals.recoveryHighMinutes).toBe(120);
  });

  it('detectDowPatterns skips stressHighMinutes entirely when all values are undefined', () => {
    // Timeline with readiness but no stress data at all
    const records: HealthDayRecord[] = [];
    for (let week = 0; week < 8; week++) {
      records.push(makeRecord(dateForDow(4, week), { readiness: 50 }));
      for (const dow of [1, 2, 3, 5]) {
        records.push(makeRecord(dateForDow(dow, week), { readiness: 65 }));
      }
    }
    // None of the records have stressHighMinutes
    const results = detectDowPatterns(records);
    const stressResults = results.filter(r => r.signal === 'stressHighMinutes');
    expect(stressResults).toHaveLength(0);
  });

  it('undefined stressHighMinutes is excluded from the mean calculation (not treated as 0)', () => {
    // If undefined were treated as 0, the Thursday mean would be dragged toward 0
    // Build 6 Thursdays with stress undefined, 6 other-day records with stress = 40
    const records: HealthDayRecord[] = [];
    for (let week = 0; week < 6; week++) {
      // Thursday: stress undefined
      records.push(makeRecord(dateForDow(4, week), { readiness: 60 }));
      // Other days: stress defined
      for (const dow of [1, 2, 3, 5]) {
        records.push(makeRecord(dateForDow(dow, week), {
          readiness: 60,
          stressHighMinutes: 40,
        }));
      }
    }
    const results = detectDowPatterns(records);
    // No Thursday stress pattern should appear because Thursdays have no data
    const thursdayStress = results.filter(r => r.signal === 'stressHighMinutes' && r.dayOfWeek === 4);
    expect(thursdayStress).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Users without Oura are unaffected
// ─────────────────────────────────────────────────────────────────────────────

describe('8. Users without Oura are unaffected', () => {
  it('returns [] for a timeline with only HealthKit steps data (no Oura signals)', () => {
    const records: HealthDayRecord[] = [];
    for (let week = 0; week < 8; week++) {
      for (const dow of [0, 1, 2, 3, 4, 5, 6]) {
        records.push(makeRecord(dateForDow(dow, week), {
          hkSteps: 8000 + Math.random() * 2000,
          // No readiness, hrv, sleepScore, sleepHours, stressHighMinutes, recoveryHighMinutes
        }));
      }
    }
    const results = detectDowPatterns(records);
    expect(results).toHaveLength(0);
  });

  it('returns [] for a timeline with only lifestyle logs (no Oura signals)', () => {
    const records: HealthDayRecord[] = [];
    for (let week = 0; week < 8; week++) {
      records.push(makeRecord(dateForDow(4, week), {
        totalAlcoholDrinks: 3,
        caffeineMg: 200,
      }));
      for (const dow of [1, 2, 3, 5]) {
        records.push(makeRecord(dateForDow(dow, week), {
          totalAlcoholDrinks: 0,
          caffeineMg: 150,
        }));
      }
    }
    const results = detectDowPatterns(records);
    expect(results).toHaveLength(0);
  });

  it('pattern observation store returns [] for users with no notes', async () => {
    const { getActivePendingNotes } = jest.requireActual<typeof import('../pattern-observation-store')>(
      '../pattern-observation-store'
    );
    const active = await getActivePendingNotes(new Set(['readiness_dow_4']));
    expect(active).toHaveLength(0);
  });
});
