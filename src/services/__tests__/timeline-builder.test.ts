/**
 * timeline-builder.test.ts
 *
 * 16-scenario integration test matrix for the source adapter layer.
 *
 * All tests are pure: no native device APIs, no AsyncStorage.
 * The test data drives the adapters and merge logic directly.
 *
 * Scenarios:
 *  1.  Apple Watch only — HK sleep + workouts + steps, no Oura
 *  2.  Oura + HealthKit — both present, all domains covered
 *  3.  No Oura — HK + storage logs only
 *  4.  Oura only — no HK data
 *  5.  Steps deduplication — hkSteps preserved alongside ouraSteps
 *  6.  Sleep deduplication — Oura sleepHours (priority 3) wins over HK (priority 2)
 *  7.  Mixed provenance — different sources on different days
 *  8.  Sleep date alignment — Oura wakeup date used directly
 *  9.  HK sleep date alignment — wakeup date derived from endDate
 * 10.  ContextEvent pipeline — activeContextTypes appear in merged record
 * 11.  Drink log → totalAlcoholDrinks in timeline
 * 12.  Caffeine log → caffeineMg in timeline
 * 13.  Workout history → duration summed per day
 * 14.  Coverage: Oura + HK + logs → SLEEP/RECOVERY/MOVEMENT all available
 * 15.  Coverage: HK only → RECOVERY unavailable
 * 16.  Coverage: no data → all domains unavailable
 */

import {
  mergeContributions,
  buildDayRecords,
  SIGNAL_PRIORITY,
  type DayContribution,
} from '../canonical-signals';
import {
  adaptOuraWeekly,
  adaptHKWorkouts,
  adaptHKSleepByDate,
  adaptHKStepsToday,
  adaptHKHrvToday,
  adaptStorageLogs,
} from '../source-adapters';
import { buildTimelineFromAdapters } from '../timeline-builder';
import { computeCoverage, summarizeTimelineCoverage } from '../context-coverage';
import type { OuraWeeklyDay } from '../oura';
import type { WorkoutSample } from '../healthkit';
import type { HealthDayRecord } from '../pattern-engine';

// ─── Fixture helpers ────────────────────────────────────────────────────────────

function makeOuraDay(overrides: Partial<OuraWeeklyDay> & { date: string }): OuraWeeklyDay {
  return {
    date:           overrides.date,
    dayLabel:       'Mon',
    sleepScore:     overrides.sleepScore  ?? 0,
    sleepHours:     overrides.sleepHours  ?? 0,
    hrv:            overrides.hrv         ?? 0,
    readiness:      overrides.readiness   ?? 0,
    steps:          overrides.steps       ?? 0,
    activeCalories: overrides.activeCalories ?? 0,
  };
}

function makeWorkout(
  date: string,
  durationMin: number,
  calories = 200
): WorkoutSample {
  const start = new Date(`${date}T09:00:00`);
  const end   = new Date(`${date}T09:00:00`);
  end.setMinutes(end.getMinutes() + durationMin);
  return {
    activityName: 'Running',
    calories,
    duration: durationMin,
    startDate: start,
    endDate:   end,
  };
}

function makeStorageDay(
  date: string,
  overrides: Partial<HealthDayRecord> = {}
): HealthDayRecord {
  return { date, ...overrides };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

// ── Scenario 1: Apple Watch only ──────────────────────────────────────────────

describe('Scenario 1 — Apple Watch only (no Oura)', () => {
  const date = '2026-09-14';
  const workouts = [makeWorkout(date, 45, 350)];
  const hkSleep = { [date]: 7.2 };

  const timeline = buildTimelineFromAdapters({
    hkWorkouts:    workouts,
    hkSleepByDate: hkSleep,
    hkStepsToday:  { steps: 9500, date },
  });

  test('produces one record', () => {
    expect(timeline).toHaveLength(1);
  });

  test('has sleep hours from HK', () => {
    expect(timeline[0].sleepHours).toBe(7.2);
  });

  test('has workout data from HK', () => {
    expect(timeline[0].workoutDurationMin).toBe(45);
    expect(timeline[0].workoutCount).toBe(1);
  });

  test('has hkSteps', () => {
    expect(timeline[0].hkSteps).toBe(9500);
  });

  test('readiness and sleepScore are absent (no Oura)', () => {
    expect(timeline[0].readiness).toBeUndefined();
    expect(timeline[0].sleepScore).toBeUndefined();
  });
});

// ── Scenario 2: Oura + HealthKit ──────────────────────────────────────────────

describe('Scenario 2 — Oura + HealthKit both present', () => {
  const date = '2026-09-14';
  const oura = [makeOuraDay({
    date, sleepScore: 82, sleepHours: 7.5, hrv: 48, readiness: 78, steps: 6100,
  })];
  const workouts = [makeWorkout(date, 50, 400)];

  const timeline = buildTimelineFromAdapters({
    ouraWeeklyDays: oura,
    hkWorkouts:     workouts,
    hkStepsToday:   { steps: 9800, date },
  });

  test('has Oura recovery signals', () => {
    expect(timeline[0].readiness).toBe(78);
    expect(timeline[0].hrv).toBe(48);
    expect(timeline[0].sleepScore).toBe(82);
  });

  test('has HK workout data', () => {
    expect(timeline[0].workoutDurationMin).toBe(50);
  });

  test('has both hkSteps and ouraSteps', () => {
    expect(timeline[0].hkSteps).toBe(9800);
    expect(timeline[0].ouraSteps).toBe(6100);
  });
});

// ── Scenario 3: No Oura — HK + storage logs ───────────────────────────────────

describe('Scenario 3 — No Oura, HK + storage logs', () => {
  const date = '2026-09-14';
  const storageLogs: HealthDayRecord[] = [
    makeStorageDay(date, { totalAlcoholDrinks: 2, caffeineMg: 200 }),
  ];
  const workouts = [makeWorkout(date, 30, 250)];

  const timeline = buildTimelineFromAdapters({
    hkWorkouts: workouts,
    storageLogs,
  });

  test('has drink log data', () => {
    expect(timeline[0].totalAlcoholDrinks).toBe(2);
  });

  test('has caffeine data', () => {
    expect(timeline[0].caffeineMg).toBe(200);
  });

  test('readiness is absent (no Oura)', () => {
    expect(timeline[0].readiness).toBeUndefined();
  });
});

// ── Scenario 4: Oura only, no HK ──────────────────────────────────────────────

describe('Scenario 4 — Oura only, no HealthKit', () => {
  const date = '2026-09-14';
  const oura = [makeOuraDay({
    date, sleepScore: 75, sleepHours: 7.0, hrv: 42, readiness: 70, steps: 5000,
  })];

  const timeline = buildTimelineFromAdapters({ ouraWeeklyDays: oura });

  test('has Oura data', () => {
    expect(timeline[0].sleepScore).toBe(75);
    expect(timeline[0].readiness).toBe(70);
  });

  test('ouraSteps present, hkSteps absent', () => {
    expect(timeline[0].ouraSteps).toBe(5000);
    expect(timeline[0].hkSteps).toBeUndefined();
  });

  test('no workout data', () => {
    expect(timeline[0].workoutDurationMin).toBeUndefined();
  });
});

// ── Scenario 5: Steps deduplication ──────────────────────────────────────────

describe('Scenario 5 — Steps deduplication: hkSteps preserved alongside ouraSteps', () => {
  const date = '2026-09-14';
  const oura = [makeOuraDay({ date, steps: 6000 })];

  const timeline = buildTimelineFromAdapters({
    ouraWeeklyDays: oura,
    hkStepsToday:   { steps: 9200, date },
  });

  test('both step sources are preserved', () => {
    expect(timeline[0].hkSteps).toBe(9200);
    expect(timeline[0].ouraSteps).toBe(6000);
  });
});

// ── Scenario 6: Sleep deduplication — Oura wins over HK ──────────────────────

describe('Scenario 6 — Sleep deduplication: Oura (priority 3) wins over HK (priority 2)', () => {
  const date = '2026-09-14';
  const oura = [makeOuraDay({ date, sleepHours: 7.5, sleepScore: 80 })];

  const timeline = buildTimelineFromAdapters({
    ouraWeeklyDays: oura,
    hkSleepByDate:  { [date]: 6.8 },  // HK says 6.8 — Oura should win
  });

  test('Oura sleepHours (7.5) overwrites HK (6.8)', () => {
    expect(timeline[0].sleepHours).toBe(7.5);
  });

  test('sleepScore from Oura is preserved', () => {
    expect(timeline[0].sleepScore).toBe(80);
  });
});

// ── Scenario 7: Mixed provenance — different sources on different days ────────

describe('Scenario 7 — Mixed provenance: different sources per day', () => {
  const oura = [makeOuraDay({ date: '2026-09-12', sleepScore: 78, readiness: 74 })];
  const workouts = [makeWorkout('2026-09-13', 40, 300)];
  const storageLogs = [makeStorageDay('2026-09-14', { totalAlcoholDrinks: 1 })];

  const timeline = buildTimelineFromAdapters({
    ouraWeeklyDays: oura,
    hkWorkouts:     workouts,
    storageLogs,
  });

  test('produces three distinct days', () => {
    expect(timeline).toHaveLength(3);
  });

  test('Sept 12 has Oura data', () => {
    const day = timeline.find((d) => d.date === '2026-09-12')!;
    expect(day.readiness).toBe(74);
  });

  test('Sept 13 has workout data', () => {
    const day = timeline.find((d) => d.date === '2026-09-13')!;
    expect(day.workoutDurationMin).toBe(40);
  });

  test('Sept 14 has drink log data', () => {
    const day = timeline.find((d) => d.date === '2026-09-14')!;
    expect(day.totalAlcoholDrinks).toBe(1);
  });
});

// ── Scenario 8: Sleep date alignment — Oura wakeup date ──────────────────────

describe('Scenario 8 — Oura sleep date alignment', () => {
  // Oura: sleep on the night of Sept 14→15 is reported with date '2026-09-15' (wakeup date)
  const oura = [makeOuraDay({ date: '2026-09-15', sleepHours: 7.8, sleepScore: 85, readiness: 82 })];

  const timeline = buildTimelineFromAdapters({ ouraWeeklyDays: oura });

  test('record date is the wakeup date 2026-09-15', () => {
    expect(timeline[0].date).toBe('2026-09-15');
  });

  test('sleep + readiness are both on the wakeup date', () => {
    expect(timeline[0].sleepHours).toBe(7.8);
    expect(timeline[0].readiness).toBe(82);
  });
});

// ── Scenario 9: HK sleep date alignment ──────────────────────────────────────

describe('Scenario 9 — HK sleep date alignment via adaptHKSleepByDate', () => {
  // Caller is responsible for grouping HK samples by wakeup date before passing in
  const hkSleep: Record<string, number> = {
    '2026-09-15': 7.1,   // HK sleep ending morning of Sept 15
    '2026-09-16': 6.8,
  };

  const contributions = adaptHKSleepByDate(hkSleep);

  test('produces a contribution for each wakeup date', () => {
    expect(contributions).toHaveLength(2);
    const dates = contributions.map((c) => c.date).sort();
    expect(dates).toEqual(['2026-09-15', '2026-09-16']);
  });

  test('sleepHours mapped correctly', () => {
    const sept15 = contributions.find((c) => c.date === '2026-09-15')!;
    expect(sept15.signals.sleepHours).toBe(7.1);
  });

  test('priority is HEALTHKIT (2)', () => {
    expect(contributions[0].priority).toBe(SIGNAL_PRIORITY.HEALTHKIT);
  });
});

// ── Scenario 10: ContextEvent pipeline ───────────────────────────────────────

describe('Scenario 10 — ContextEvent activeContextTypes', () => {
  const storageLogs: HealthDayRecord[] = [
    makeStorageDay('2026-09-14', {
      activeContextTypes: ['vacation', 'training_block'],
    }),
  ];

  const timeline = buildTimelineFromAdapters({ storageLogs });

  test('activeContextTypes are present in the merged record', () => {
    expect(timeline[0].activeContextTypes).toEqual(
      expect.arrayContaining(['vacation', 'training_block'])
    );
  });
});

// ── Scenario 11: Drink log ───────────────────────────────────────────────────

describe('Scenario 11 — Drink log → totalAlcoholDrinks', () => {
  const storageLogs: HealthDayRecord[] = [
    makeStorageDay('2026-09-10', { totalAlcoholDrinks: 3 }),
    makeStorageDay('2026-09-11', { totalAlcoholDrinks: 0 }),  // zero — should be filtered
    makeStorageDay('2026-09-12', { totalAlcoholDrinks: 1 }),
  ];

  // adaptStorageLogs filters out days with no lifestyle data
  const contributions = adaptStorageLogs(storageLogs);

  test('includes days with non-zero drinks', () => {
    const drinkDays = contributions.filter((c) => c.signals.totalAlcoholDrinks !== undefined);
    expect(drinkDays.length).toBeGreaterThanOrEqual(1);
  });

  test('totalAlcoholDrinks is 3 on Sept 10', () => {
    const sept10 = contributions.find((c) => c.date === '2026-09-10');
    expect(sept10?.signals.totalAlcoholDrinks).toBe(3);
  });
});

// ── Scenario 12: Caffeine log ────────────────────────────────────────────────

describe('Scenario 12 — Caffeine log → caffeineMg', () => {
  const storageLogs: HealthDayRecord[] = [
    makeStorageDay('2026-09-14', { caffeineMg: 350 }),
  ];

  const timeline = buildTimelineFromAdapters({ storageLogs });

  test('caffeineMg present in merged record', () => {
    expect(timeline[0].caffeineMg).toBe(350);
  });
});

// ── Scenario 13: Workout history grouped by date ─────────────────────────────

describe('Scenario 13 — Multiple workouts on same day are summed', () => {
  const date = '2026-09-14';
  const workouts: WorkoutSample[] = [
    makeWorkout(date, 45, 350),
    makeWorkout(date, 30, 250),
  ];

  const contributions = adaptHKWorkouts(workouts);

  test('produces one contribution for the day', () => {
    expect(contributions).toHaveLength(1);
  });

  test('duration is summed', () => {
    expect(contributions[0].signals.workoutDurationMin).toBe(75);
  });

  test('calories are summed', () => {
    expect(contributions[0].signals.workoutCaloriesBurned).toBe(600);
  });

  test('workoutCount is 2', () => {
    expect(contributions[0].signals.workoutCount).toBe(2);
  });
});

// ── Scenario 14: Coverage — full data → all available ────────────────────────

describe('Scenario 14 — Coverage: Oura + HK + logs → all domains available', () => {
  const day: HealthDayRecord = {
    date:               '2026-09-14',
    sleepScore:         82,
    sleepHours:         7.5,
    hrv:                48,
    readiness:          78,
    hkSteps:            9500,
    workoutDurationMin: 50,
    totalAlcoholDrinks: 1,
    caffeineMg:         200,
    calories:           2100,
    protein:            140,
  };

  const report = computeCoverage(day);

  test('hasAnyData is true', () => expect(report.hasAnyData).toBe(true));
  test('canAnalyzeRecovery is true', () => expect(report.canAnalyzeRecovery).toBe(true));
  test('canAnalyzeMovement is true', () => expect(report.canAnalyzeMovement).toBe(true));

  test('SLEEP is available', () => {
    const sleep = report.domains.find((d) => d.domain === 'SLEEP')!;
    expect(sleep.level).toBe('available');
  });

  test('RECOVERY is available', () => {
    const rec = report.domains.find((d) => d.domain === 'RECOVERY')!;
    expect(rec.level).toBe('available');
  });

  test('MOVEMENT is available', () => {
    const mov = report.domains.find((d) => d.domain === 'MOVEMENT')!;
    expect(mov.level).toBe('available');
  });

  test('NUTRITION is available', () => {
    const nut = report.domains.find((d) => d.domain === 'NUTRITION')!;
    expect(nut.level).toBe('available');
  });
});

// ── Scenario 15: Coverage — HK only → RECOVERY unavailable ───────────────────

describe('Scenario 15 — Coverage: HK only → RECOVERY unavailable', () => {
  const day: HealthDayRecord = {
    date:               '2026-09-14',
    sleepHours:         7.0,           // from HK (no sleepScore)
    hkSteps:            8500,
    workoutDurationMin: 40,
    // no readiness, no hrv
  };

  const report = computeCoverage(day);

  test('RECOVERY is unavailable (no readiness or HRV)', () => {
    const rec = report.domains.find((d) => d.domain === 'RECOVERY')!;
    expect(rec.level).toBe('unavailable');
  });

  test('SLEEP is limited (hours only, no score)', () => {
    const sleep = report.domains.find((d) => d.domain === 'SLEEP')!;
    expect(sleep.level).toBe('limited');
  });

  test('MOVEMENT is available', () => {
    const mov = report.domains.find((d) => d.domain === 'MOVEMENT')!;
    expect(mov.level).toBe('available');
  });

  test('canAnalyzeRecovery is false', () => {
    expect(report.canAnalyzeRecovery).toBe(false);
  });
});

// ── Scenario 16: Coverage — no data ──────────────────────────────────────────

describe('Scenario 16 — Coverage: no data → all unavailable', () => {
  const emptyDay: HealthDayRecord = { date: '2026-09-14' };
  const report = computeCoverage(emptyDay);

  test('hasAnyData is false', () => expect(report.hasAnyData).toBe(false));
  test('canAnalyzeRecovery is false', () => expect(report.canAnalyzeRecovery).toBe(false));
  test('canAnalyzeMovement is false', () => expect(report.canAnalyzeMovement).toBe(false));

  test('all domains are unavailable', () => {
    for (const d of report.domains) {
      expect(d.level).toBe('unavailable');
    }
  });
});

// ── mergeContributions unit tests ─────────────────────────────────────────────

describe('mergeContributions — priority resolution', () => {
  const date = '2026-09-14';

  test('higher priority source overwrites lower for same field', () => {
    const low: DayContribution = {
      date, sourceId: 'oura_sleep', priority: SIGNAL_PRIORITY.HEALTHKIT,
      signals: { sleepHours: 6.5 },
    };
    const high: DayContribution = {
      date, sourceId: 'oura_readiness', priority: SIGNAL_PRIORITY.OURA,
      signals: { sleepHours: 7.5 },
    };
    const merged = mergeContributions(date, [low, high]);
    expect(merged.sleepHours).toBe(7.5);
  });

  test('hkSteps and ouraSteps are both preserved', () => {
    const oura: DayContribution = {
      date, sourceId: 'oura_activity', priority: SIGNAL_PRIORITY.OURA,
      signals: { ouraSteps: 6000 },
    };
    const hk: DayContribution = {
      date, sourceId: 'apple_health_steps', priority: SIGNAL_PRIORITY.HEALTHKIT,
      signals: { hkSteps: 9000 },
    };
    const merged = mergeContributions(date, [oura, hk]);
    expect(merged.hkSteps).toBe(9000);
    expect(merged.ouraSteps).toBe(6000);
  });

  test('activeContextTypes are unioned across contributions', () => {
    const a: DayContribution = {
      date, sourceId: 'a', priority: 1,
      signals: { activeContextTypes: ['vacation'] },
    };
    const b: DayContribution = {
      date, sourceId: 'b', priority: 2,
      signals: { activeContextTypes: ['training_block'] },
    };
    const merged = mergeContributions(date, [a, b]);
    expect(merged.activeContextTypes).toEqual(
      expect.arrayContaining(['vacation', 'training_block'])
    );
  });

  test('duplicate activeContextTypes entries are deduplicated', () => {
    const a: DayContribution = {
      date, sourceId: 'a', priority: 1,
      signals: { activeContextTypes: ['vacation', 'vacation'] },
    };
    const merged = mergeContributions(date, [a]);
    expect(merged.activeContextTypes?.filter((t) => t === 'vacation').length).toBe(1);
  });
});

// ── buildDayRecords — multi-date grouping ──────────────────────────────────────

describe('buildDayRecords — groups and sorts by date', () => {
  test('records are sorted oldest → newest', () => {
    const contributions: DayContribution[] = [
      { date: '2026-09-16', sourceId: 'a', priority: 1, signals: { hkSteps: 100 } },
      { date: '2026-09-14', sourceId: 'a', priority: 1, signals: { hkSteps: 200 } },
      { date: '2026-09-15', sourceId: 'a', priority: 1, signals: { hkSteps: 300 } },
    ];
    const records = buildDayRecords(contributions);
    expect(records.map((r) => r.date)).toEqual(['2026-09-14', '2026-09-15', '2026-09-16']);
  });

  test('empty input produces empty array', () => {
    expect(buildDayRecords([])).toEqual([]);
  });
});

// ── summarizeTimelineCoverage ──────────────────────────────────────────────────

describe('summarizeTimelineCoverage', () => {
  test('typicalCoverage reflects the modal level across all days', () => {
    const timeline: HealthDayRecord[] = [
      { date: '2026-09-12', readiness: 75, hrv: 45 },
      { date: '2026-09-13', readiness: 70, hrv: 42 },
      { date: '2026-09-14' },  // no recovery data this day
    ];

    const summary = summarizeTimelineCoverage(timeline);
    // 2 of 3 days have recovery → typical = 'available'
    expect(summary.typicalCoverage['RECOVERY']).toBe('available');
    expect(summary.totalDays).toBe(3);
  });
});
