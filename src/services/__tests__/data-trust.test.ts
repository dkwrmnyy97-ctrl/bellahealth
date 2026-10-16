/**
 * data-trust.test.ts
 *
 * Regression tests for the three data-trust issues fixed in Build 99:
 *
 *   Issue 1 — Session bleed: fetchOuraWeekly allowed a prior night's session to
 *             fill a missing night via ?? fallback, inflating the sleep average.
 *             Fix: claimedSessionKeys Set prevents a session from being borrowed twice.
 *
 *   Issue 2 — Auto-detected activities: HealthKit queryWorkoutSamples returns ALL
 *             workout records including Oura-auto-detected walks and passive movement.
 *             Fix: copy changed from "workouts" to "activity sessions"; no intent claim.
 *
 *   Issue 3 — No-log ≠ alcohol-free: entry?.totalDrinks ?? 0 treated unlogged days as
 *             confirmed zero; drinksTotal === 0 triggered a causal alcohol-free insight.
 *             Fix: null for unlogged days; alcohol_free only fires when daysWithDrinkLog
 *             meets a coverage threshold.
 *
 * These tests are pure-function tests — logic is inlined from explore.tsx and oura.ts
 * so they run without React Native native modules.
 */

// ─── Shared types ─────────────────────────────────────────────────────────────

type OuraWeeklyDay = {
  date: string;
  dayLabel: string;
  sleepScore: number;
  sleepHours: number;
  hrv: number;
  readiness: number;
  steps: number;
  activeCalories: number;
};

type Posture = 'recover' | 'build' | 'maintain' | 'mixed';

type PeriodHealthContext = {
  period: '1w' | '1m';
  avgSleep: number;
  avgScore: number;
  avgHrv: number;
  avgReadiness: number;
  avgSteps: number;
  hrvTrend: number;
  todayHrv: number;
  todayReadiness: number;
  stepGoalDays: number;
  drinksTotal: number;
  daysWithDrinkLog: number;
  workoutCount: number;
  validSleepNights: number;
  hasData: boolean;
  posture: Posture;
  stepGoal: number;
  recoveryConstrained: boolean;
  alcoholHasPattern: boolean;
  alcoholAffectedMetrics: string[];
};

// ─── Inlined helpers from explore.tsx ─────────────────────────────────────────

function periodAvg(vals: number[]): number {
  const nonZero = vals.filter(v => v > 0);
  return nonZero.length ? nonZero.reduce((a, b) => a + b, 0) / nonZero.length : 0;
}

function buildPeriodContext(
  days: OuraWeeklyDay[],
  drinksLogged: (number | null)[],
  workoutCount: number,
  stepGoal: number,
  period: '1w' | '1m',
): PeriodHealthContext {
  const avgSleep     = periodAvg(days.map(d => d.sleepHours));
  const avgScore     = periodAvg(days.map(d => d.sleepScore));
  const avgHrv       = periodAvg(days.map(d => d.hrv));
  const avgReadiness = periodAvg(days.map(d => d.readiness));
  const avgSteps     = periodAvg(days.map(d => d.steps));
  const stepGoalDays = days.filter(d => d.steps >= stepGoal && d.steps > 0).length;
  const drinksTotal  = drinksLogged.reduce<number>((a, b) => a + (b ?? 0), 0);
  const daysWithDrinkLog = drinksLogged.filter(v => v !== null).length;
  const validSleepNights = days.filter(d => d.sleepHours > 0).length;

  const todayHrv       = days[days.length - 1]?.hrv ?? 0;
  const todayReadiness = days[days.length - 1]?.readiness ?? 0;

  const hrvValid = days.map(d => d.hrv).filter(v => v > 0);
  const thirdLen = Math.ceil(hrvValid.length / 3);
  const hrvTrend = hrvValid.length >= 4
    ? periodAvg(hrvValid.slice(-thirdLen)) - periodAvg(hrvValid.slice(0, thirdLen))
    : 0;

  const hasData = avgScore > 0 || avgSteps > 0;

  const drinkThresh = period === '1w' ? 5 : 18;
  let recoverSignals = 0;
  let buildSignals   = 0;
  if (avgSleep > 0 && avgSleep < 6.5)          recoverSignals++;
  if (avgHrv > 0 && hrvTrend < -5)             recoverSignals++;
  if (avgReadiness > 0 && avgReadiness < 62)   recoverSignals++;
  if (drinksTotal > drinkThresh)               recoverSignals++;
  if (avgSleep >= 7.5)                         buildSignals++;
  if (avgHrv > 0 && hrvTrend > 3)             buildSignals++;
  if (avgReadiness >= 78)                      buildSignals++;
  if (avgSteps >= stepGoal && avgSteps > 0)   buildSignals++;

  let posture: Posture;
  if (recoverSignals >= 2 && buildSignals === 0)      posture = 'recover';
  else if (buildSignals >= 3 && recoverSignals === 0) posture = 'build';
  else if (recoverSignals > 0 && buildSignals > 0)    posture = 'mixed';
  else posture = 'maintain';

  const recoveryConstrained = todayReadiness > 0 && todayReadiness < 65;

  return {
    period, avgSleep, avgScore, avgHrv, avgReadiness, avgSteps,
    hrvTrend, todayHrv, todayReadiness, stepGoalDays, drinksTotal,
    daysWithDrinkLog, workoutCount, validSleepNights, hasData, posture,
    stepGoal, recoveryConstrained, alcoholHasPattern: false, alcoholAffectedMetrics: [],
  };
}

type Rec = {
  id: string;
  level: 'warning' | 'nudge' | 'positive';
  kind: string;
  headline: string;
  detail: string;
  source: string;
  icon?: string;
};

function buildInsights(ctx: PeriodHealthContext): Rec[] {
  const { period, avgSleep, avgScore, avgHrv, avgReadiness, avgSteps,
          hrvTrend, todayHrv, todayReadiness, stepGoalDays, drinksTotal,
          daysWithDrinkLog, workoutCount, validSleepNights, hasData, posture,
          stepGoal, recoveryConstrained, alcoholHasPattern, alcoholAffectedMetrics } = ctx;

  if (!hasData) {
    return [{ id: 'no_data', kind: 'observation', level: 'nudge',
      headline: 'Syncing your health data…', detail: '', source: 'BellaHealth' }];
  }

  const candidates: Rec[] = [];

  const sleepNightsThresh = period === '1w' ? 4 : 18;
  const sleepCoverageNote = validSleepNights < sleepNightsThresh
    ? ` (${validSleepNights}/${period === '1w' ? 7 : 30} nights recorded)`
    : '';

  if (avgSleep > 0) {
    if (avgSleep < 6.5) {
      const level = validSleepNights >= sleepNightsThresh ? 'warning' : 'nudge';
      const coverageSuffix = sleepCoverageNote
        ? ` Note: only ${validSleepNights} nights recorded — average may shift as more data syncs.`
        : '';
      candidates.push({ id: 'sleep_low', kind: 'observation', level,
        headline: 'Sleep is your biggest lever right now',
        detail: `You've averaged ${avgSleep.toFixed(1)} hrs ${period === '1w' ? 'this week' : 'this month'}${sleepCoverageNote}. Most recovery — HRV, muscle repair, metabolism — happens during sleep.${coverageSuffix}`,
        source: 'Oura Sleep', icon: 'moon.zzz' });
    }
  }

  // Workout (activity sessions copy — no intent claim)
  if (period === '1w') {
    if (workoutCount >= 4) {
      candidates.push({ id: 'workout_consistent', kind: 'observation', level: 'positive',
        headline: `${workoutCount} activity sessions this week`,
        detail: `Consistent movement frequency — including Apple Health auto-detected sessions — adds up. If you're doing structured training, keep it up; if not, consider adding intentional cardio or strength work.`,
        source: 'Apple Health', icon: 'flame' });
    } else if (workoutCount === 0) {
      candidates.push({ id: 'workout_zero', kind: 'observation', level: 'nudge',
        headline: 'No activity sessions recorded this week',
        detail: `Even two structured sessions — cardio + strength — keeps your fitness from sliding.`,
        source: 'Apple Health', icon: 'flame' });
    }
  }

  // Alcohol
  const drinkWarnThresh = period === '1w' ? 6 : 20;
  if (drinksTotal >= drinkWarnThresh) {
    candidates.push({ id: 'drinking_high', kind: 'observation', level: 'warning',
      headline: `Alcohol elevated — ${Math.round(drinksTotal * 10) / 10} drinks ${period === '1w' ? 'this week' : 'this month'}`,
      detail: `Alcohol has been higher than your recent baseline.`,
      source: 'BellaHealth', icon: 'drop' });
  } else if (drinksTotal === 0 && daysWithDrinkLog > 0 && avgScore >= 78) {
    const totalDays = period === '1w' ? 7 : 30;
    const minLoggedThresh = period === '1w' ? 4 : 18;
    if (daysWithDrinkLog === totalDays) {
      candidates.push({ id: 'alcohol_free', kind: 'observation', level: 'positive',
        headline: `Alcohol-free ${period === '1m' ? 'this month' : 'this week'}`,
        detail: `No drinks on any of your ${totalDays} logged days. Recovery metrics look solid.`,
        source: 'BellaHealth', icon: 'drop' });
    } else if (daysWithDrinkLog >= minLoggedThresh) {
      const unlogged = totalDays - daysWithDrinkLog;
      candidates.push({ id: 'alcohol_free_partial', kind: 'observation', level: 'positive',
        headline: `No alcohol on your ${daysWithDrinkLog} logged days this ${period === '1m' ? 'month' : 'week'}`,
        detail: `${unlogged} day${unlogged !== 1 ? 's' : ''} without a log entry — those remain unknown.`,
        source: 'BellaHealth', icon: 'drop' });
    }
  }

  return candidates;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDay(opts: Partial<OuraWeeklyDay> & { date: string }): OuraWeeklyDay {
  return { dayLabel: 'Mon', sleepScore: 0, sleepHours: 0, hrv: 0, readiness: 0,
    steps: 0, activeCalories: 0, ...opts };
}

function makeWeek(overrides: Partial<OuraWeeklyDay>[] = []): OuraWeeklyDay[] {
  return Array.from({ length: 7 }, (_, i) => {
    const base = makeDay({ date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      sleepHours: 7.5, sleepScore: 82, hrv: 48, readiness: 76, steps: 8000 });
    return { ...base, ...(overrides[i] ?? {}) };
  });
}

// ─── Issue 1: Session bleed / sparse sleep average ───────────────────────────

describe('Issue 1 — sleep sparse-data guard', () => {
  it('sleep_low is level=warning when ≥4 nights recorded (1W)', () => {
    // 5 valid nights + 2 missing: average from 5 nights is trustworthy
    const days = makeWeek([
      { sleepHours: 5.0, sleepScore: 65 },
      { sleepHours: 5.2, sleepScore: 63 },
      { sleepHours: 5.1, sleepScore: 64 },
      { sleepHours: 5.3, sleepScore: 66 },
      { sleepHours: 5.0, sleepScore: 62 },
      { sleepHours: 0,   sleepScore: 0  }, // missing
      { sleepHours: 0,   sleepScore: 0  }, // missing
    ]);
    const ctx = buildPeriodContext(days, Array(7).fill(null), 0, 8000, '1w');
    const insights = buildInsights(ctx);
    const sleepCard = insights.find(r => r.id === 'sleep_low');
    expect(sleepCard).toBeDefined();
    expect(sleepCard?.level).toBe('warning');
    expect(ctx.validSleepNights).toBe(5);
  });

  it('sleep_low is demoted to level=nudge when <4 nights recorded (1W)', () => {
    // Only 2 valid nights out of 7 — can't trust the average
    const days = makeWeek([
      { sleepHours: 5.0, sleepScore: 65 },
      { sleepHours: 5.2, sleepScore: 63 },
      { sleepHours: 0,   sleepScore: 0  },
      { sleepHours: 0,   sleepScore: 0  },
      { sleepHours: 0,   sleepScore: 0  },
      { sleepHours: 0,   sleepScore: 0  },
      { sleepHours: 0,   sleepScore: 0  },
    ]);
    const ctx = buildPeriodContext(days, Array(7).fill(null), 0, 8000, '1w');
    const insights = buildInsights(ctx);
    const sleepCard = insights.find(r => r.id === 'sleep_low');
    expect(sleepCard).toBeDefined();
    expect(sleepCard?.level).toBe('nudge');
    expect(ctx.validSleepNights).toBe(2);
  });

  it('sparse sleep detail includes night count and caveat', () => {
    const days = makeWeek([
      { sleepHours: 5.5, sleepScore: 64 },
      { sleepHours: 5.2, sleepScore: 62 },
      { sleepHours: 0,   sleepScore: 0  },
      { sleepHours: 0,   sleepScore: 0  },
      { sleepHours: 0,   sleepScore: 0  },
      { sleepHours: 0,   sleepScore: 0  },
      { sleepHours: 0,   sleepScore: 0  },
    ]);
    const ctx = buildPeriodContext(days, Array(7).fill(null), 0, 8000, '1w');
    const insights = buildInsights(ctx);
    const sleepCard = insights.find(r => r.id === 'sleep_low');
    expect(sleepCard?.detail).toContain('2/7 nights recorded');
    expect(sleepCard?.detail).toContain('average may shift');
  });

  it('full coverage (7/7 nights): detail does NOT include coverage note', () => {
    const days = makeWeek([
      { sleepHours: 5.5, sleepScore: 64 },
      { sleepHours: 5.2, sleepScore: 62 },
      { sleepHours: 5.3, sleepScore: 63 },
      { sleepHours: 5.0, sleepScore: 61 },
      { sleepHours: 5.4, sleepScore: 65 },
      { sleepHours: 5.1, sleepScore: 62 },
      { sleepHours: 5.2, sleepScore: 63 },
    ]);
    const ctx = buildPeriodContext(days, Array(7).fill(null), 0, 8000, '1w');
    const insights = buildInsights(ctx);
    const sleepCard = insights.find(r => r.id === 'sleep_low');
    expect(sleepCard?.level).toBe('warning');
    expect(sleepCard?.detail).not.toContain('nights recorded');
    expect(sleepCard?.detail).not.toContain('average may shift');
  });

  it('periodAvg correctly excludes zero-value nights from the average', () => {
    // 5.0 + 5.2 out of 7, rest zero — avg should be (5.0+5.2)/2 = 5.1, not 5.1/7
    const vals = [5.0, 5.2, 0, 0, 0, 0, 0];
    expect(periodAvg(vals)).toBeCloseTo(5.1, 1);
  });
});

// ─── Issue 2: Workout copy — activity sessions, no intent claim ───────────────

describe('Issue 2 — workout copy uses "activity sessions"', () => {
  it('workout_consistent headline says "activity sessions", not "workouts"', () => {
    const days = makeWeek();
    const ctx = buildPeriodContext(days, Array(7).fill(null), 5, 8000, '1w');
    const insights = buildInsights(ctx);
    const card = insights.find(r => r.id === 'workout_consistent');
    expect(card).toBeDefined();
    expect(card?.headline).toContain('activity sessions');
    expect(card?.headline).not.toMatch(/\bworkouts?\b/i);
  });

  it('workout_consistent detail does not claim intentional training', () => {
    const days = makeWeek();
    const ctx = buildPeriodContext(days, Array(7).fill(null), 5, 8000, '1w');
    const insights = buildInsights(ctx);
    const card = insights.find(r => r.id === 'workout_consistent');
    // Must not assert these are intentional workouts
    expect(card?.detail).not.toMatch(/great consistency/i);
    expect(card?.detail).not.toMatch(/durable fitness foundation/i);
    expect(card?.detail).not.toMatch(/training frequency compounds/i);
  });

  it('workout_consistent detail acknowledges auto-detected sessions', () => {
    const days = makeWeek();
    const ctx = buildPeriodContext(days, Array(7).fill(null), 5, 8000, '1w');
    const insights = buildInsights(ctx);
    const card = insights.find(r => r.id === 'workout_consistent');
    expect(card?.detail).toContain('auto-detected');
  });

  it('workout_consistent detail invites intentional training without claiming it happened', () => {
    const days = makeWeek();
    const ctx = buildPeriodContext(days, Array(7).fill(null), 5, 8000, '1w');
    const insights = buildInsights(ctx);
    const card = insights.find(r => r.id === 'workout_consistent');
    // Should mention intentional training as a possibility, not an assertion
    expect(card?.detail).toMatch(/intentional|structured/i);
  });

  it('workout_zero headline says "recorded", not "logged"', () => {
    const days = makeWeek();
    const ctx = buildPeriodContext(days, Array(7).fill(null), 0, 8000, '1w');
    const insights = buildInsights(ctx);
    const card = insights.find(r => r.id === 'workout_zero');
    expect(card).toBeDefined();
    expect(card?.headline).toContain('activity sessions');
    expect(card?.headline).not.toMatch(/\bworkouts?\b/i);
  });
});

// ─── Issue 3: No-log ≠ alcohol-free ──────────────────────────────────────────

describe('Issue 3 — alcohol_free eligibility: full-period vs partial vs no insight', () => {
  // ── No insight cases ──────────────────────────────────────────────────────

  it('no insight when zero log entries exist (null = unknown, not confirmed zero)', () => {
    const days = makeWeek(); // avgScore 82
    const ctx = buildPeriodContext(days, Array(7).fill(null), 0, 8000, '1w');
    expect(ctx.daysWithDrinkLog).toBe(0);
    const insights = buildInsights(ctx);
    expect(insights.find(r => r.id === 'alcohol_free')).toBeUndefined();
    expect(insights.find(r => r.id === 'alcohol_free_partial')).toBeUndefined();
  });

  it('no insight when fewer than 4 logged days in 1W (evidence too sparse)', () => {
    const drinksLogged: (number | null)[] = [0, 0, 0, null, null, null, null];
    const ctx = buildPeriodContext(makeWeek(), drinksLogged, 0, 8000, '1w');
    expect(ctx.daysWithDrinkLog).toBe(3);
    const insights = buildInsights(ctx);
    expect(insights.find(r => r.id === 'alcohol_free')).toBeUndefined();
    expect(insights.find(r => r.id === 'alcohol_free_partial')).toBeUndefined();
  });

  it('no alcohol-free insight when any positive drink entries exist', () => {
    // 6 days zero, 1 day with drinks — drinksTotal > 0 → neither insight fires
    const drinksLogged: (number | null)[] = [0, 0, 0, 0, 0, 0, 2];
    const ctx = buildPeriodContext(makeWeek(), drinksLogged, 0, 8000, '1w');
    expect(ctx.drinksTotal).toBe(2);
    const insights = buildInsights(ctx);
    expect(insights.find(r => r.id === 'alcohol_free')).toBeUndefined();
    expect(insights.find(r => r.id === 'alcohol_free_partial')).toBeUndefined();
  });

  it('positive drink entry on any day disqualifies even with 6 other zero days', () => {
    const drinksLogged: (number | null)[] = [1, 0, 0, 0, 0, 0, 0];
    const ctx = buildPeriodContext(makeWeek(), drinksLogged, 0, 8000, '1w');
    expect(ctx.drinksTotal).toBe(1);
    const insights = buildInsights(ctx);
    expect(insights.find(r => r.id === 'alcohol_free')).toBeUndefined();
    expect(insights.find(r => r.id === 'alcohol_free_partial')).toBeUndefined();
    // The drinking_high warning should NOT fire either (1 < 6 threshold)
    expect(insights.find(r => r.id === 'drinking_high')).toBeUndefined();
  });

  it('no insight when avgScore < 78 even with full coverage', () => {
    const days = makeWeek([
      { sleepScore: 70 }, { sleepScore: 70 }, { sleepScore: 70 }, { sleepScore: 70 },
      { sleepScore: 70 }, { sleepScore: 70 }, { sleepScore: 70 },
    ]); // avgScore = 70 < 78
    const ctx = buildPeriodContext(days, Array(7).fill(0), 0, 8000, '1w');
    expect(ctx.daysWithDrinkLog).toBe(7);
    expect(ctx.drinksTotal).toBe(0);
    const insights = buildInsights(ctx);
    expect(insights.find(r => r.id === 'alcohol_free')).toBeUndefined();
    expect(insights.find(r => r.id === 'alcohol_free_partial')).toBeUndefined();
  });

  // ── Partial insight (4–6 of 7 days logged) ───────────────────────────────

  it('alcohol_free_partial fires when 4–6 of 7 days logged zero (not full-period claim)', () => {
    const drinksLogged: (number | null)[] = [0, 0, 0, 0, 0, null, null]; // 5/7
    const ctx = buildPeriodContext(makeWeek(), drinksLogged, 0, 8000, '1w');
    expect(ctx.daysWithDrinkLog).toBe(5);
    const insights = buildInsights(ctx);
    expect(insights.find(r => r.id === 'alcohol_free')).toBeUndefined();
    const partial = insights.find(r => r.id === 'alcohol_free_partial');
    expect(partial).toBeDefined();
    expect(partial?.level).toBe('positive');
  });

  it('alcohol_free_partial headline scopes claim to logged days only — not "this week"', () => {
    const drinksLogged: (number | null)[] = [0, 0, 0, 0, null, null, null]; // 4/7
    const ctx = buildPeriodContext(makeWeek(), drinksLogged, 0, 8000, '1w');
    const insights = buildInsights(ctx);
    const partial = insights.find(r => r.id === 'alcohol_free_partial');
    // Must NOT imply the whole week was alcohol-free
    expect(partial?.headline).not.toMatch(/alcohol-free this week/i);
    expect(partial?.headline).not.toMatch(/alcohol-free this month/i);
    // Must name the actual logged count
    expect(partial?.headline).toContain('4 logged days');
  });

  it('alcohol_free_partial detail names the unlogged-day count as unknown', () => {
    const drinksLogged: (number | null)[] = [0, 0, 0, 0, null, null, null]; // 4/7
    const ctx = buildPeriodContext(makeWeek(), drinksLogged, 0, 8000, '1w');
    const insights = buildInsights(ctx);
    const partial = insights.find(r => r.id === 'alcohol_free_partial');
    expect(partial?.detail).toContain('3 days');
    expect(partial?.detail).toContain('unknown');
  });

  it('6 of 7 days logged → partial (1 day still unknown)', () => {
    const drinksLogged: (number | null)[] = [0, 0, 0, 0, 0, 0, null]; // 6/7
    const ctx = buildPeriodContext(makeWeek(), drinksLogged, 0, 8000, '1w');
    const insights = buildInsights(ctx);
    expect(insights.find(r => r.id === 'alcohol_free')).toBeUndefined();
    const partial = insights.find(r => r.id === 'alcohol_free_partial');
    expect(partial).toBeDefined();
    expect(partial?.headline).toContain('6 logged days');
    expect(partial?.detail).toContain('1 day');
    expect(partial?.detail).toContain('unknown');
  });

  // ── Full-period insight (all 7/7 logged zero) ─────────────────────────────

  it('alcohol_free (full-period) fires only when ALL 7 days logged zero (1W)', () => {
    const drinksLogged: (number | null)[] = [0, 0, 0, 0, 0, 0, 0]; // 7/7
    const ctx = buildPeriodContext(makeWeek(), drinksLogged, 0, 8000, '1w');
    expect(ctx.daysWithDrinkLog).toBe(7);
    const insights = buildInsights(ctx);
    const full = insights.find(r => r.id === 'alcohol_free');
    expect(full).toBeDefined();
    expect(full?.level).toBe('positive');
    expect(insights.find(r => r.id === 'alcohol_free_partial')).toBeUndefined();
  });

  it('alcohol_free full-period headline says "Alcohol-free this week" — no logged-day qualifier', () => {
    const drinksLogged: (number | null)[] = Array(7).fill(0);
    const ctx = buildPeriodContext(makeWeek(), drinksLogged, 0, 8000, '1w');
    const insights = buildInsights(ctx);
    const full = insights.find(r => r.id === 'alcohol_free');
    expect(full?.headline).toMatch(/alcohol-free this week/i);
    expect(full?.headline).not.toMatch(/\d+ logged days/i);
  });

  it('alcohol_free full-period detail is observational — no causal language', () => {
    const drinksLogged: (number | null)[] = Array(7).fill(0);
    const ctx = buildPeriodContext(makeWeek(), drinksLogged, 0, 8000, '1w');
    const insights = buildInsights(ctx);
    const full = insights.find(r => r.id === 'alcohol_free');
    expect(full?.detail).not.toMatch(/have benefited/i);
    expect(full?.detail).not.toMatch(/scores reflect it/i);
    expect(full?.detail).not.toMatch(/staying alcohol-free/i);
    expect(full?.detail).toContain('7 logged days');
  });

  // ── Null vs zero: missing days remain unknown ─────────────────────────────

  it('drinksTotal only sums logged entries — nulls are not counted as zero', () => {
    const drinksLogged: (number | null)[] = [2, null, 3, null, null, null, null];
    const ctx = buildPeriodContext(makeWeek(), drinksLogged, 0, 8000, '1w');
    expect(ctx.drinksTotal).toBe(5);
    expect(ctx.daysWithDrinkLog).toBe(2);
  });

  it('null entry on one day prevents full-period claim even with 6 zero days', () => {
    const drinksLogged: (number | null)[] = [0, 0, 0, 0, 0, 0, null]; // 6/7
    const ctx = buildPeriodContext(makeWeek(), drinksLogged, 0, 8000, '1w');
    const insights = buildInsights(ctx);
    // Not full-period
    expect(insights.find(r => r.id === 'alcohol_free')).toBeUndefined();
    // Partial fires (6 >= 4 threshold)
    expect(insights.find(r => r.id === 'alcohol_free_partial')).toBeDefined();
  });
});

// ─── Session bleed logic (oura.ts) — claimedSessionKeys contract ──────────────
// These tests verify the de-duplication logic without importing oura.ts
// by reproducing the exact algorithm from fetchOuraWeekly.

type Session = { day: string; total_sleep_duration: number; average_hrv: number };

function simulateSessionBleedFix(
  sessions: Session[],
  days: string[],
): Array<{ date: string; sleepHours: number; hrv: number }> {
  const sessionsByDay: Record<string, Session> = {};
  for (const s of sessions) {
    if (!sessionsByDay[s.day] ||
        s.total_sleep_duration > sessionsByDay[s.day].total_sleep_duration) {
      sessionsByDay[s.day] = s;
    }
  }

  const claimedSessionKeys = new Set<string>();
  return days.map((dateStr) => {
    const prevDateStr = new Date(new Date(dateStr + 'T12:00:00').getTime() - 86400000)
      .toISOString().split('T')[0];
    let sessionKey: string | null = null;
    if (sessionsByDay[dateStr]) {
      sessionKey = dateStr;
    } else if (sessionsByDay[prevDateStr] && !claimedSessionKeys.has(prevDateStr)) {
      sessionKey = prevDateStr;
    }
    if (sessionKey) claimedSessionKeys.add(sessionKey);
    const session = sessionKey ? sessionsByDay[sessionKey] : undefined;
    return {
      date: dateStr,
      sleepHours: session ? Math.round((session.total_sleep_duration / 3600) * 10) / 10 : 0,
      hrv: session?.average_hrv ? Math.round(session.average_hrv) : 0,
    };
  });
}

describe('Issue 1 — oura.ts session bleed: claimedSessionKeys de-duplication', () => {
  it('exact-match session is not reused by the following day via prevDate fallback', () => {
    // THE CORE BLEED SCENARIO:
    // Session key '2026-01-03' exists (Oura tagged with wakeup date Jan 03).
    // Without claimed-set: Jan 03 uses it (exact); Jan 04 tries prevDate=Jan 03 → steals it.
    // With claimed-set: Jan 03 claims it; Jan 04 tries Jan 03 → already claimed → 0hrs.
    const sessions: Session[] = [
      { day: '2026-01-03', total_sleep_duration: 25200, average_hrv: 42 }, // 7hrs
    ];
    const days = ['2026-01-03', '2026-01-04'];
    const result = simulateSessionBleedFix(sessions, days);

    expect(result[0]).toMatchObject({ date: '2026-01-03', sleepHours: 7 }); // exact match
    expect(result[1]).toMatchObject({ date: '2026-01-04', sleepHours: 0 }); // not stolen
  });

  it('a missed night followed by a present night produces correct values', () => {
    // Jan 03 session only. Days: Jan 02, Jan 03, Jan 04.
    // Jan 02: no exact, tries Jan 01 → no session → 0hrs (ring not worn or not synced)
    // Jan 03: exact match → 7hrs, claimed
    // Jan 04: no exact, tries Jan 03 → claimed → 0hrs
    const sessions: Session[] = [
      { day: '2026-01-03', total_sleep_duration: 25200, average_hrv: 42 },
    ];
    const days = ['2026-01-02', '2026-01-03', '2026-01-04'];
    const result = simulateSessionBleedFix(sessions, days);

    expect(result[0].sleepHours).toBe(0); // missed
    expect(result[1].sleepHours).toBe(7); // present
    expect(result[2].sleepHours).toBe(0); // not stolen from Jan 03
  });

  it('the old ?? fallback without claimed-set incorrectly reuses an exact-match session', () => {
    // Demonstrates the pre-fix bug explicitly.
    // Session '2026-01-03' should only count for Jan 03.
    // Old code: Jan 04 tries prevDate=Jan 03 → finds it → uses it again (bleed!).
    const sessions: Session[] = [
      { day: '2026-01-03', total_sleep_duration: 25200, average_hrv: 42 }, // 7hrs
    ];
    const days = ['2026-01-03', '2026-01-04'];

    // Old (buggy) logic — no claimed set
    function oldLogic(): Array<{ date: string; sleepHours: number }> {
      const sessionsByDay: Record<string, Session> = {};
      for (const s of sessions) sessionsByDay[s.day] = s;
      return days.map(dateStr => {
        const prevDateStr = new Date(new Date(dateStr + 'T12:00:00').getTime() - 86400000)
          .toISOString().split('T')[0];
        const session = sessionsByDay[dateStr] ?? sessionsByDay[prevDateStr];
        return {
          date: dateStr,
          sleepHours: session ? Math.round((session.total_sleep_duration / 3600) * 10) / 10 : 0,
        };
      });
    }

    const bugResult = oldLogic();
    // Old code: BOTH days show 7hrs — Jan 03 session was reused by Jan 04
    expect(bugResult[0].sleepHours).toBe(7);
    expect(bugResult[1].sleepHours).toBe(7); // bug confirmed: bleed

    // New code: Jan 04 correctly shows 0hrs
    const fixResult = simulateSessionBleedFix(sessions, days);
    expect(fixResult[0].sleepHours).toBe(7);
    expect(fixResult[1].sleepHours).toBe(0); // fix: not reused
  });
});

// ─── Midnight-split / late-bedtime fix (mergeContiguousSleepSessions) ─────────
// Oura Ring can create a short pre-midnight session (e.g. 11:30 PM to midnight)
// and a longer post-midnight session (midnight to 7:30 AM) for the SAME sleep period.
// Without merging, the weekly chart shows:
//   Jan N: 20 min (the pre-midnight fragment) — misleadingly non-zero
//   Jan N+1: 7.5 hrs (the main session)
// periodAvg then computes (0.33 + 7.5) / 2 = 3.9 hrs instead of 7.5 hrs.
//
// After merging: Jan N has no session (0 hrs), Jan N+1 has the combined 7.83 hr session.

type FullSession = {
  day: string;
  bedtime_start: string;
  bedtime_end: string;
  total_sleep_duration: number;
  average_hrv: number;
};

function mergeContiguousSleepSessions(sessions: FullSession[]): FullSession[] {
  if (sessions.length <= 1) return sessions;

  const sorted = [...sessions].sort((a, b) => {
    const ta = new Date(a.bedtime_start).getTime();
    const tb = new Date(b.bedtime_start).getTime();
    return ta - tb;
  });

  const merged: any[] = [];
  for (const s of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && prev.bedtime_end && s.bedtime_start) {
      const prevEndMs  = new Date(prev.bedtime_end).getTime();
      const curStartMs = new Date(s.bedtime_start).getTime();
      const gapMs = curStartMs - prevEndMs;
      if (gapMs >= 0 && gapMs < 5 * 60 * 1000) {
        prev.bedtime_end           = s.bedtime_end ?? prev.bedtime_end;
        prev.total_sleep_duration  = (prev.total_sleep_duration ?? 0) + (s.total_sleep_duration ?? 0);
        if (s.day) prev.day        = s.day;
        if (s.average_hrv) prev.average_hrv = s.average_hrv;
        continue;
      }
    }
    merged.push({ ...s });
  }
  return merged;
}

describe('Midnight-split: mergeContiguousSleepSessions', () => {
  it('pre-midnight fragment + overnight session are merged into one session on the wakeup date', () => {
    // Scenario from Sean: missed Night 1, Night 2 starts at 11:30 PM.
    // Oura creates:
    //   Session A: 11:30 PM Jan 5 → 11:50 PM Jan 5 (20 min fragment, day = Jan 5)
    //   Session B: 11:50 PM Jan 5 → 7:30 AM Jan 6  (7.67 hrs main sleep, day = Jan 6)
    const sessions: FullSession[] = [
      {
        day: '2026-01-05',
        bedtime_start: '2026-01-05T23:30:00+00:00',
        bedtime_end:   '2026-01-05T23:50:00+00:00',
        total_sleep_duration: 1200,   // 20 min
        average_hrv: 35,
      },
      {
        day: '2026-01-06',
        bedtime_start: '2026-01-05T23:50:00+00:00',
        bedtime_end:   '2026-01-06T07:30:00+00:00',
        total_sleep_duration: 27600,  // 7.67 hrs
        average_hrv: 48,
      },
    ];

    const result = mergeContiguousSleepSessions(sessions);

    // Sessions merged into one
    expect(result).toHaveLength(1);
    // Attributed to Jan 6 (wakeup date of the complete sleep period)
    expect(result[0].day).toBe('2026-01-06');
    // Duration = 20 min + 7.67 hrs = 7.83 hrs (28800 s)
    expect(result[0].total_sleep_duration).toBe(1200 + 27600);
    // HRV from the main block (later session)
    expect(result[0].average_hrv).toBe(48);
  });

  it('the weekly average uses the full merged duration, not the pre-midnight fragment', () => {
    // Without merging, Jan 5 would show 20 min → periodAvg includes it → avg drops.
    // With merging, Jan 5 shows 0 hrs (excluded from avg) → avg is correct.
    const sessions: FullSession[] = [
      {
        day: '2026-01-05',
        bedtime_start: '2026-01-05T23:30:00+00:00',
        bedtime_end:   '2026-01-05T23:50:00+00:00',
        total_sleep_duration: 1200, // 20 min fragment
        average_hrv: 35,
      },
      {
        day: '2026-01-06',
        bedtime_start: '2026-01-05T23:50:00+00:00',
        bedtime_end:   '2026-01-06T07:30:00+00:00',
        total_sleep_duration: 27600, // 7.67 hrs
        average_hrv: 48,
      },
    ];

    const merged = mergeContiguousSleepSessions(sessions);

    // After merging, only Jan 6 has a session — Jan 5 has nothing
    const sessionsByDay: Record<string, any> = {};
    for (const s of merged) {
      const day = s.day;
      if (!sessionsByDay[day] || s.total_sleep_duration > sessionsByDay[day].total_sleep_duration) {
        sessionsByDay[day] = s;
      }
    }

    expect(sessionsByDay['2026-01-05']).toBeUndefined(); // no fragment left on Jan 5
    expect(sessionsByDay['2026-01-06']).toBeDefined();
    expect(sessionsByDay['2026-01-06'].total_sleep_duration).toBe(1200 + 27600);

    // Weekly avg with a full 7-day window: only Jan 6 has data → avg = 7.83 hrs
    const sleepHours7days = ['2026-01-01','2026-01-02','2026-01-03','2026-01-04','2026-01-05','2026-01-06','2026-01-07'].map(d => {
      const s = sessionsByDay[d];
      return s ? Math.round((s.total_sleep_duration / 3600) * 10) / 10 : 0;
    });
    const avg = periodAvg(sleepHours7days);
    expect(avg).toBeCloseTo((1200 + 27600) / 3600, 1); // ≈ 7.8 hrs
    expect(avg).toBeGreaterThan(6.5); // does NOT falsely trigger sleep_low warning
  });

  it('two sessions with a gap > 30 min are NOT merged (e.g. nap + overnight)', () => {
    const sessions: FullSession[] = [
      {
        day: '2026-01-05',
        bedtime_start: '2026-01-05T14:00:00+00:00',
        bedtime_end:   '2026-01-05T14:45:00+00:00',
        total_sleep_duration: 2700,  // 45 min nap
        average_hrv: 40,
      },
      {
        day: '2026-01-06',
        bedtime_start: '2026-01-05T23:30:00+00:00',
        bedtime_end:   '2026-01-06T07:00:00+00:00',
        total_sleep_duration: 27000,  // 7.5 hrs overnight
        average_hrv: 46,
      },
    ];

    const result = mergeContiguousSleepSessions(sessions);

    // 8.75 hr gap between nap end (14:45) and overnight start (23:30) → not merged
    expect(result).toHaveLength(2);
    expect(result[0].day).toBe('2026-01-05');
    expect(result[1].day).toBe('2026-01-06');
  });

  it('a single overnight session (no split) is returned unchanged', () => {
    const sessions: FullSession[] = [
      {
        day: '2026-01-06',
        bedtime_start: '2026-01-05T23:30:00+00:00',
        bedtime_end:   '2026-01-06T07:30:00+00:00',
        total_sleep_duration: 27600,
        average_hrv: 48,
      },
    ];

    const result = mergeContiguousSleepSessions(sessions);
    expect(result).toHaveLength(1);
    expect(result[0].day).toBe('2026-01-06');
    expect(result[0].total_sleep_duration).toBe(27600);
  });

  it('the pre-midnight fragment does not cause sleep_low to fire incorrectly', () => {
    // Simulate a week where 6 nights are good (7.5 hrs) and one night has a
    // 20-min fragment on Jan 5 + a full session on Jan 6 (merged correctly).
    const sessionsByDay: Record<string, { total_sleep_duration: number }> = {
      '2026-01-01': { total_sleep_duration: 27000 }, // 7.5 hrs
      '2026-01-02': { total_sleep_duration: 27000 },
      '2026-01-03': { total_sleep_duration: 27000 },
      '2026-01-04': { total_sleep_duration: 27000 },
      // Jan 5: NOTHING after merge (fragment re-attributed to Jan 6)
      '2026-01-06': { total_sleep_duration: 28800 }, // 8 hrs (merged total)
      '2026-01-07': { total_sleep_duration: 27000 },
    };

    const sleepValues = ['2026-01-01','2026-01-02','2026-01-03','2026-01-04','2026-01-05','2026-01-06','2026-01-07'].map(d => {
      const s = sessionsByDay[d];
      return s ? Math.round((s.total_sleep_duration / 3600) * 10) / 10 : 0;
    });
    // Jan 5 = 0, Jan 6 = 8.0, others = 7.5
    expect(sleepValues[4]).toBe(0); // Jan 5 has no session
    expect(sleepValues[5]).toBe(8.0); // Jan 6 has the merged total

    const avg = periodAvg(sleepValues);
    // avg over 6 valid nights (zeros excluded): (7.5*5 + 8.0) / 6 ≈ 7.58 hrs
    expect(avg).toBeGreaterThan(6.5);  // no false sleep_low warning
    expect(avg).toBeGreaterThan(7.0);  // strong sleep — not even a nudge
  });

  it('two sessions with a gap > 5 min are NOT merged (e.g. nap + overnight)', () => {
    // Gap of 6 minutes between nap end and next session start — distinct sleep periods
    const sessions: FullSession[] = [
      {
        day: '2026-01-05',
        bedtime_start: '2026-01-05T14:00:00+00:00',
        bedtime_end:   '2026-01-05T14:45:00+00:00',
        total_sleep_duration: 2700,
        average_hrv: 40,
      },
      {
        day: '2026-01-05',
        bedtime_start: '2026-01-05T14:51:00+00:00', // 6-min gap
        bedtime_end:   '2026-01-05T16:00:00+00:00',
        total_sleep_duration: 3240,
        average_hrv: 41,
      },
    ];
    const result = mergeContiguousSleepSessions(sessions);
    expect(result).toHaveLength(2); // not merged
  });

  it('two sessions with a gap ≤ 5 min ARE merged (genuine midnight continuation)', () => {
    // Gap of exactly 4 minutes — within the 5-min window for genuine splits
    const sessions: FullSession[] = [
      {
        day: '2026-01-05',
        bedtime_start: '2026-01-05T23:30:00+00:00',
        bedtime_end:   '2026-01-05T23:56:00+00:00',
        total_sleep_duration: 1200,
        average_hrv: 35,
      },
      {
        day: '2026-01-06',
        bedtime_start: '2026-01-06T00:00:00+00:00', // 4-min gap
        bedtime_end:   '2026-01-06T07:30:00+00:00',
        total_sleep_duration: 27000,
        average_hrv: 48,
      },
    ];
    const result = mergeContiguousSleepSessions(sessions);
    expect(result).toHaveLength(1);
    expect(result[0].total_sleep_duration).toBe(1200 + 27000);
    expect(result[0].day).toBe('2026-01-06');
  });

  it('overlapping sessions are NOT merged — handled by longest-wins downstream', () => {
    // Session B starts before session A ends (B is nested inside A).
    // gapMs < 0: merge is skipped; sessionsByDay "longest wins" picks the right one.
    const sessions: FullSession[] = [
      {
        day: '2026-01-06',
        bedtime_start: '2026-01-05T22:00:00+00:00',
        bedtime_end:   '2026-01-06T07:00:00+00:00',
        total_sleep_duration: 32400, // 9 hrs (main session)
        average_hrv: 50,
      },
      {
        day: '2026-01-06',
        bedtime_start: '2026-01-05T23:00:00+00:00', // starts INSIDE A
        bedtime_end:   '2026-01-06T03:00:00+00:00',
        total_sleep_duration: 14400, // 4 hrs (duplicate sub-session)
        average_hrv: 45,
      },
    ];
    const merged = mergeContiguousSleepSessions(sessions);
    // Not merged (overlap) — two records remain
    expect(merged).toHaveLength(2);

    // Downstream: longest-wins picks the 9-hr session for Jan 6
    const sessionsByDay: Record<string, any> = {};
    for (const s of merged) {
      if (!sessionsByDay[s.day] || s.total_sleep_duration > sessionsByDay[s.day].total_sleep_duration) {
        sessionsByDay[s.day] = s;
      }
    }
    expect(sessionsByDay['2026-01-06'].total_sleep_duration).toBe(32400); // no double-count
  });

  it('exact-duplicate sessions are NOT merged — longest-wins prevents double-counting', () => {
    const dup: FullSession = {
      day: '2026-01-06',
      bedtime_start: '2026-01-05T23:30:00+00:00',
      bedtime_end:   '2026-01-06T07:30:00+00:00',
      total_sleep_duration: 27600,
      average_hrv: 48,
    };
    const sessions = [dup, { ...dup }]; // identical records
    const merged = mergeContiguousSleepSessions(sessions);
    // Both have same start → gapMs < 0 → not merged; both are separate records
    expect(merged).toHaveLength(2);

    // Downstream: longest-wins picks one; duration = 27600, not 55200
    const sessionsByDay: Record<string, any> = {};
    for (const s of merged) {
      if (!sessionsByDay[s.day] || s.total_sleep_duration > sessionsByDay[s.day].total_sleep_duration) {
        sessionsByDay[s.day] = s;
      }
    }
    expect(sessionsByDay['2026-01-06'].total_sleep_duration).toBe(27600); // not doubled
  });
});

// ─── Issue 4 — Home screen sleep discrepancy (stage-sum bug + silent fallback) ─
//
// Root causes of the 7.5 hrs vs 8h 57m discrepancy Sean reported on Oct 11:
//
//   A) fetchOuraDaily computed sleepHours by summing light + deep + rem stage fields.
//      While Oura is still processing overnight data, REM (and sometimes deep) may be
//      zero even though total_sleep_duration is already the authoritative full value.
//      The stage sum underestimates sleep; the fallback to total_sleep_duration was
//      blocked because (light + deep + 0) > 0.
//      Fix: use mainSession.total_sleep_duration directly.
//
//   B) fetchOuraDaily fell back to slice(-1)[0] when today's daily_sleep entry was
//      absent, silently carrying yesterday's sleepScore and readinessScore forward.
//      Fix: null when today's entry is absent.
//
// Tests here inline the logic to run without React Native native modules.

describe('Issue 4A — fetchOuraDaily uses total_sleep_duration, not stage sum', () => {
  // Inline the two implementations to compare outputs.
  function sleepHoursOld(session: {
    light_sleep_duration?: number;
    deep_sleep_duration?: number;
    rem_sleep_duration?: number;
    total_sleep_duration?: number;
  } | null): number {
    const sleepSeconds = session
      ? ((session.light_sleep_duration ?? 0) +
         (session.deep_sleep_duration ?? 0) +
         (session.rem_sleep_duration ?? 0)) || (session.total_sleep_duration ?? 0)
      : 0;
    return sleepSeconds > 0 ? Math.round((sleepSeconds / 3600) * 10) / 10 : 0;
  }

  function sleepHoursNew(session: {
    total_sleep_duration?: number;
  } | null): number {
    const sleepSeconds = session?.total_sleep_duration ?? 0;
    return sleepSeconds > 0 ? Math.round((sleepSeconds / 3600) * 10) / 10 : 0;
  }

  it('fully processed session: both implementations agree', () => {
    // All three stage fields present; total_sleep_duration matches sum.
    const session = {
      light_sleep_duration: 16200,
      deep_sleep_duration:   7200,
      rem_sleep_duration:    5400,  // REM processed
      total_sleep_duration: 28800,  // 8.0 hrs
    };
    expect(sleepHoursOld(session)).toBe(8.0);
    expect(sleepHoursNew(session)).toBe(8.0);
  });

  it('REM not yet processed: old code underestimates, new code is correct', () => {
    // Oura is still processing overnight data — REM field is absent/zero.
    // total_sleep_duration already reflects the correct 8 hrs.
    const session = {
      light_sleep_duration: 16200,
      deep_sleep_duration:   7200,
      rem_sleep_duration:    0,     // not yet processed
      total_sleep_duration: 28800,  // 8.0 hrs — already correct from ring
    };
    // Old: 16200 + 7200 + 0 = 23400 s = 6.5 hrs (undercount)
    expect(sleepHoursOld(session)).toBe(6.5);
    // New: 28800 s = 8.0 hrs (correct)
    expect(sleepHoursNew(session)).toBe(8.0);
  });

  it('synthetic: stage-sum undercount with rem=0 produces 7.5 hrs vs correct 9.0 hrs', () => {
    // SYNTHETIC FIXTURE — not retrieved from Sean's actual Oura payload.
    // Sean's screenshot at ~5 PM showed 8h 57m in Oura and 7.5 hrs in BellaHealth.
    // His Oura screenshot shows REM = 2h 17m, so rem_sleep_duration was NOT 0 at
    // screenshot time. The stage-sum bug is a valid independent correctness fix
    // (stage fields can be 0 during early-morning processing) but is not verified
    // as the cause of Sean's specific Oct 11 discrepancy.
    //
    // This fixture demonstrates the class of error: if rem were absent while
    // total_sleep_duration was already correct, the old code would undercount.
    const session = {
      light_sleep_duration: 18000, // 5 hrs
      deep_sleep_duration:   9000, // 2.5 hrs
      rem_sleep_duration:    0,    // hypothetical: not yet in stage fields
      total_sleep_duration: 32220, // authoritative: 8 hrs 57 min
    };
    // Old: 18000 + 9000 + 0 = 27000 → 7.5 hrs (undercount)
    expect(sleepHoursOld(session)).toBe(7.5);
    // New: 32220 s → 8.95 → Math.round × 10 / 10 = 9.0 hrs
    expect(sleepHoursNew(session)).toBe(9.0);
  });

  it('null session: both implementations return 0', () => {
    expect(sleepHoursOld(null)).toBe(0);
    expect(sleepHoursNew(null)).toBe(0);
  });

  it('session with only total_sleep_duration (no stage breakdown): new code correct', () => {
    // Early in the day, Oura may return a session with total but no stage fields yet.
    const session = { total_sleep_duration: 27000 }; // 7.5 hrs
    // Old: (0 + 0 + 0) || 27000 = 27000 → 7.5 (fallback works here)
    expect(sleepHoursOld(session)).toBe(7.5);
    // New: 27000 → 7.5
    expect(sleepHoursNew(session)).toBe(7.5);
  });
});

describe('Issue 4B — fetchOuraDaily does not fall back to yesterday\'s scores', () => {
  // Inline both implementations of the daily_sleep lookup.
  type DailySleepEntry = { day: string; score: number };

  function pickDailySleepOld(data: DailySleepEntry[], today: string): DailySleepEntry | undefined {
    return data.find((d) => d.day === today) ?? data.slice(-1)[0];
  }

  function pickDailySleepNew(data: DailySleepEntry[], today: string): DailySleepEntry | null {
    return data.find((d) => d.day === today) ?? null;
  }

  const yesterday = '2026-10-10';
  const today     = '2026-10-11';

  it('today\'s entry present: both implementations return today\'s score', () => {
    const data: DailySleepEntry[] = [
      { day: yesterday, score: 72 },
      { day: today,     score: 96 },
    ];
    expect(pickDailySleepOld(data, today)?.score).toBe(96);
    expect(pickDailySleepNew(data, today)?.score).toBe(96);
  });

  it('today\'s entry absent: old silently returns yesterday\'s score, new returns null', () => {
    // Today's daily_sleep not yet synced — only yesterday's in the response.
    const data: DailySleepEntry[] = [
      { day: yesterday, score: 72 },
    ];
    // Old: falls back to slice(-1)[0] = yesterday's entry
    expect(pickDailySleepOld(data, today)?.score).toBe(72);
    // New: null — Home screen renders 0 rather than the wrong day's score
    expect(pickDailySleepNew(data, today)).toBeNull();
  });

  it('empty response: old returns undefined, new returns null — both safe to ?? 0', () => {
    expect(pickDailySleepOld([], today)?.score ?? 0).toBe(0);
    expect(pickDailySleepNew([], today)?.score ?? 0).toBe(0);
  });

  it('only today present: both implementations return today\'s entry', () => {
    const data: DailySleepEntry[] = [{ day: today, score: 88 }];
    expect(pickDailySleepOld(data, today)?.score).toBe(88);
    expect(pickDailySleepNew(data, today)?.score).toBe(88);
  });
});

// ─── Issue 4C — score/readiness guards are date-scoped ────────────────────────
//
// The guard `oura.sleepScore > 0 ? oura.sleepScore : prev.sleep.score` preserves
// a cached score when today's data is missing. This is correct within the same
// calendar day (e.g. transient API failure at 5 PM when a valid score was fetched
// at 9 AM). But a cached score from a prior day must NOT carry forward: if the
// app runs continuously across midnight and Jan 2 has no score yet, Jan 1's cached
// value must not silently appear as today's.
//
// Fix: fetchOuraDaily returns `fetchDate` (the YYYY-MM-DD queried). Callers compare
// `oura.fetchDate` to `ouraFetchDateRef.current` (the date of the previous fetch).
// Only preserve prev when the two are the same calendar day.

describe('Issue 4C — score/readiness guard is date-scoped', () => {
  // Inline the date-aware guard logic used in index.tsx.
  function applyScoreGuard(
    newScore:    number,
    prevScore:   number,
    fetchDate:   string,
    prevFetchDate: string,
  ): number {
    const sameDay = fetchDate === prevFetchDate;
    return newScore > 0 ? newScore : (sameDay ? prevScore : 0);
  }

  it('new score available: always uses new score regardless of date match', () => {
    expect(applyScoreGuard(96, 82, '2026-01-01', '2026-01-01')).toBe(96);
    expect(applyScoreGuard(96, 82, '2026-01-02', '2026-01-01')).toBe(96);
  });

  it('same day, score missing (0): preserves cached value from same-day fetch', () => {
    // e.g. transient API failure at 5 PM; morning fetch had set score to 96
    expect(applyScoreGuard(0, 96, '2026-01-01', '2026-01-01')).toBe(96);
  });

  it('date changed, score missing (0): clears cached value — prior day must not carry over', () => {
    // e.g. app running since Dec 31, Jan 1 opens with no score yet
    expect(applyScoreGuard(0, 82, '2026-01-01', '2025-12-31')).toBe(0);
  });

  it('first fetch of session (prevFetchDate = ""): missing score gives 0, not stale prev', () => {
    // prevFetchDate = '' means no prior Oura fetch this session — nothing to preserve
    expect(applyScoreGuard(0, 0, '2026-01-01', '')).toBe(0);
    // If somehow a non-zero value was in state from another source, still clears it
    expect(applyScoreGuard(0, 55, '2026-01-01', '')).toBe(0);
  });

  it('first fetch returns valid score: uses it unconditionally', () => {
    expect(applyScoreGuard(78, 0, '2026-01-01', '')).toBe(78);
  });
});

// ─── Issue 5 — Session wakeup-date attribution (0.4h vs 6h 3m recording fix) ──
//
// Root cause: Oura's `sleep` endpoint tags an overnight session with the wakeup
// date (Day+1). A query with `end_date=today` never returns that session, so only
// a same-evening nap (day=today) is found and becomes the displayed sleep value.
//
// Recording evidence (Sean, Oct 11):
//   Evening nap:  7:30–8:31 PM Oct 10 → day=2026-10-10, ~26 min actual sleep
//   Overnight:   12:58–7:40 AM Oct 11 → day=2026-10-11 (wakeup date = tomorrow
//                relative to the query date of 2026-10-10, i.e. end_date=today
//                at the time the app ran = Oct 10 — but also applies on Oct 11
//                morning before midnight rolls over in Oura's processing)
//
// Fix:
//   1. fetchOuraDaily extends sleep query to end_date=tomorrow
//   2. pickMainSession compares today vs tomorrow sessions, picks the longer one
//
// Tests inline both pickMainSession and the session-building logic to run without
// React Native native modules.

describe('Issue 5 — pickMainSession: overnight beats evening nap', () => {
  // Inline pickMainSession exactly as implemented in oura.ts
  function pickMainSession(
    sessionsByDay: Record<string, { total_sleep_duration?: number; average_hrv?: number; day?: string }>,
    today: string,
    yesterday: string,
    tomorrow: string,
  ): { total_sleep_duration?: number; average_hrv?: number; day?: string } | null {
    const todayBest    = sessionsByDay[today]    ?? null;
    const tomorrowBest = sessionsByDay[tomorrow] ?? null;
    const primaryBest  =
      todayBest !== null && tomorrowBest !== null
        ? ((tomorrowBest.total_sleep_duration ?? 0) > (todayBest.total_sleep_duration ?? 0)
            ? tomorrowBest : todayBest)
        : (todayBest ?? tomorrowBest ?? null);
    return primaryBest ?? (sessionsByDay[yesterday] ?? null);
  }

  // Dates used in the recording scenario
  const oct10 = '2026-10-10';
  const oct11 = '2026-10-11';
  const oct12 = '2026-10-12';

  it('recording scenario: overnight (day=tomorrow) beats evening nap (day=today)', () => {
    // Sean's exact scenario: app runs on Oct 11 morning.
    // today=oct11, tomorrow=oct12.
    // Nap ended Oct 10 with day=oct10 (not in this lookup) — and one separate nap
    // record on Oct 11 for ~26 min.
    // Overnight session wakeup on Oct 11 → Oura tags it day=oct12 (tomorrow).
    const nap = { day: oct11, total_sleep_duration: 1560, average_hrv: 22 };       // 26 min
    const overnight = { day: oct12, total_sleep_duration: 21780, average_hrv: 48 }; // 6h 3m
    const sessionsByDay = { [oct11]: nap, [oct12]: overnight };

    const result = pickMainSession(sessionsByDay, oct11, oct10, oct12);
    expect(result).toBe(overnight);
    expect(result?.total_sleep_duration).toBe(21780); // 6h 3m, not 26 min
  });

  it('recording scenario: main sleep hours = 6.1h (≈6h 3m), not 0.4h', () => {
    const nap = { day: oct11, total_sleep_duration: 1560 };       // 26 min = 0.4h
    const overnight = { day: oct12, total_sleep_duration: 21780 }; // 6h 3m = 6.05 → rounds to 6.1
    const sessionsByDay = { [oct11]: nap, [oct12]: overnight };

    const session = pickMainSession(sessionsByDay, oct11, oct10, oct12);
    const sleepHours = session?.total_sleep_duration
      ? Math.round((session.total_sleep_duration / 3600) * 10) / 10
      : 0;
    expect(sleepHours).toBe(6.1);  // not 0.4
  });

  it('nap-only day: nap is the only session, becomes main sleep', () => {
    // User took a nap; no overnight session in response.
    const nap = { day: oct11, total_sleep_duration: 3600 }; // 1 hr
    const sessionsByDay = { [oct11]: nap };

    const result = pickMainSession(sessionsByDay, oct11, oct10, oct12);
    expect(result).toBe(nap);
    expect(result?.total_sleep_duration).toBe(3600);
  });

  it('no-nap day: single overnight session tagged tomorrow is found correctly', () => {
    // No nap; overnight wakeup tagged as tomorrow.
    const overnight = { day: oct12, total_sleep_duration: 28800 }; // 8h
    const sessionsByDay = { [oct12]: overnight };

    const result = pickMainSession(sessionsByDay, oct11, oct10, oct12);
    expect(result).toBe(overnight);
  });

  it('no-nap, no-overnight: falls back to yesterday when neither today nor tomorrow has data', () => {
    // Oura has not yet synced today's data; yesterday's session is available.
    const prev = { day: oct10, total_sleep_duration: 27000 }; // 7.5h
    const sessionsByDay = { [oct10]: prev };

    const result = pickMainSession(sessionsByDay, oct11, oct10, oct12);
    expect(result).toBe(prev);
  });

  it('no sessions at all: returns null', () => {
    expect(pickMainSession({}, oct11, oct10, oct12)).toBeNull();
  });

  it('both present, today longer than tomorrow: today wins', () => {
    // A rare case where a daytime sleep (today) is longer than overnight stub (tomorrow).
    const todaySession    = { day: oct11, total_sleep_duration: 7200 }; // 2h
    const tomorrowSession = { day: oct12, total_sleep_duration: 3600 }; // 1h
    const sessionsByDay   = { [oct11]: todaySession, [oct12]: tomorrowSession };

    const result = pickMainSession(sessionsByDay, oct11, oct10, oct12);
    expect(result).toBe(todaySession);
  });

  it('response order does not affect result: overnight first in array', () => {
    // When building sessionsByDay from an array, the iteration order should not matter.
    const sessions = [
      { day: oct12, total_sleep_duration: 21780, average_hrv: 48 }, // overnight — first in array
      { day: oct11, total_sleep_duration:  1560, average_hrv: 22 }, // nap — second in array
    ];
    const sessionsByDay: Record<string, any> = {};
    for (const s of sessions) {
      if (!sessionsByDay[s.day] || s.total_sleep_duration > sessionsByDay[s.day].total_sleep_duration) {
        sessionsByDay[s.day] = s;
      }
    }
    const result = pickMainSession(sessionsByDay, oct11, oct10, oct12);
    expect(result?.total_sleep_duration).toBe(21780);
  });

  it('response order does not affect result: nap first in array', () => {
    const sessions = [
      { day: oct11, total_sleep_duration:  1560, average_hrv: 22 }, // nap — first in array
      { day: oct12, total_sleep_duration: 21780, average_hrv: 48 }, // overnight — second in array
    ];
    const sessionsByDay: Record<string, any> = {};
    for (const s of sessions) {
      if (!sessionsByDay[s.day] || s.total_sleep_duration > sessionsByDay[s.day].total_sleep_duration) {
        sessionsByDay[s.day] = s;
      }
    }
    const result = pickMainSession(sessionsByDay, oct11, oct10, oct12);
    expect(result?.total_sleep_duration).toBe(21780);
  });
});

describe('Issue 5 — end_date extension: overnight session only visible with extended query', () => {
  // Simulate what Oura returns with end_date=today vs end_date=tomorrow.

  const oct10 = '2026-10-10';
  const oct11 = '2026-10-11';
  const oct12 = '2026-10-12';

  // Sessions in the raw API response (both sessions present in extended query)
  const allSessions = [
    { day: oct11, total_sleep_duration:  1560, average_hrv: 22,
      bedtime_start: '2026-10-10T19:30:00+00:00', bedtime_end: '2026-10-10T20:31:00+00:00' },
    { day: oct12, total_sleep_duration: 21780, average_hrv: 48,
      bedtime_start: '2026-10-11T00:58:00+00:00', bedtime_end: '2026-10-11T07:40:00+00:00' },
  ];

  function buildSessionsByDay(sessions: typeof allSessions) {
    const map: Record<string, any> = {};
    for (const s of sessions) {
      if (!map[s.day] || s.total_sleep_duration > map[s.day].total_sleep_duration) {
        map[s.day] = s;
      }
    }
    return map;
  }

  it('with end_date=today only: overnight session (day=tomorrow) is absent', () => {
    // Simulate Oura filtering: only sessions with day <= end_date are returned.
    const endDateToday = oct11;
    const filtered = allSessions.filter((s) => s.day <= endDateToday);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].day).toBe(oct11); // only nap
    expect(filtered[0].total_sleep_duration).toBe(1560); // 26 min
  });

  it('with end_date=tomorrow: overnight session is included', () => {
    const endDateTomorrow = oct12;
    const filtered = allSessions.filter((s) => s.day <= endDateTomorrow);
    expect(filtered).toHaveLength(2);
  });

  it('old query (end_date=today): pickMainSession returns nap — 0.4h bug reproduced', () => {
    const endDateToday = oct11;
    const filtered = allSessions.filter((s) => s.day <= endDateToday);
    const sessionsByDay = buildSessionsByDay(filtered);
    // With old query, overnight session is missing from sessionsByDay
    expect(sessionsByDay[oct12]).toBeUndefined();

    // pickMainSession falls through to nap
    function pickMainSession(map: Record<string, any>, today: string, yesterday: string, tomorrow: string) {
      const t = map[today] ?? null;
      const n = map[tomorrow] ?? null;
      const primary = t !== null && n !== null
        ? ((n.total_sleep_duration ?? 0) > (t.total_sleep_duration ?? 0) ? n : t)
        : (t ?? n ?? null);
      return primary ?? (map[yesterday] ?? null);
    }

    const result = pickMainSession(sessionsByDay, oct11, oct10, oct12);
    expect(result?.total_sleep_duration).toBe(1560); // 26 min — the bug
  });

  it('new query (end_date=tomorrow): pickMainSession returns overnight — bug fixed', () => {
    const endDateTomorrow = oct12;
    const filtered = allSessions.filter((s) => s.day <= endDateTomorrow);
    const sessionsByDay = buildSessionsByDay(filtered);
    expect(sessionsByDay[oct12]).toBeDefined(); // overnight now visible

    function pickMainSession(map: Record<string, any>, today: string, yesterday: string, tomorrow: string) {
      const t = map[today] ?? null;
      const n = map[tomorrow] ?? null;
      const primary = t !== null && n !== null
        ? ((n.total_sleep_duration ?? 0) > (t.total_sleep_duration ?? 0) ? n : t)
        : (t ?? n ?? null);
      return primary ?? (map[yesterday] ?? null);
    }

    const result = pickMainSession(sessionsByDay, oct11, oct10, oct12);
    expect(result?.total_sleep_duration).toBe(21780); // 6h 3m — fixed
  });
});

describe('Issue 5 — fetchOuraWeekly today slot: overnight attributed to tomorrow', () => {
  // Simulate the weekly loop logic for i=0 (today's slot).
  // The weekly loop now checks nextDateStr for i=0 to find overnight sessions
  // whose wakeup date falls on tomorrow.

  const oct10 = '2026-10-10';
  const oct11 = '2026-10-11';
  const oct12 = '2026-10-12';

  function weeklyPickForToday(
    sessionsByDay: Record<string, any>,
    dateStr: string,   // today = oct11
    prevDateStr: string, // oct10
    nextDateStr: string, // oct12
    claimedSessionKeys: Set<string>,
  ): any | undefined {
    const todayEntry = sessionsByDay[dateStr] ?? null;
    const nextEntry  = sessionsByDay[nextDateStr] && !claimedSessionKeys.has(nextDateStr)
      ? sessionsByDay[nextDateStr] : null;
    const prevEntry  = sessionsByDay[prevDateStr] && !claimedSessionKeys.has(prevDateStr)
      ? sessionsByDay[prevDateStr] : null;

    let sessionKey: string | null = null;
    if (todayEntry !== null && nextEntry !== null) {
      sessionKey = (nextEntry.total_sleep_duration ?? 0) > (todayEntry.total_sleep_duration ?? 0)
        ? nextDateStr : dateStr;
    } else if (todayEntry !== null) {
      sessionKey = dateStr;
    } else if (nextEntry !== null) {
      sessionKey = nextDateStr;
    } else if (prevEntry !== null) {
      sessionKey = prevDateStr;
    }
    if (sessionKey) claimedSessionKeys.add(sessionKey);
    return sessionKey ? sessionsByDay[sessionKey] : undefined;
  }

  it('recording scenario: weekly today slot picks overnight over nap', () => {
    const sessionsByDay = {
      [oct11]: { total_sleep_duration:  1560, average_hrv: 22 }, // nap
      [oct12]: { total_sleep_duration: 21780, average_hrv: 48 }, // overnight
    };
    const claimed = new Set<string>();
    const session = weeklyPickForToday(sessionsByDay, oct11, oct10, oct12, claimed);
    expect(session?.total_sleep_duration).toBe(21780);
    expect(claimed.has(oct12)).toBe(true); // tomorrow's key is claimed, not double-used
  });

  it('tomorrow session not reused by a subsequent slot after being claimed for today', () => {
    // Once oct12 is claimed by today's (i=0) slot, the previous day (i=1) must not
    // re-use it. This test verifies the claimedSessionKeys guard.
    const sessionsByDay = {
      [oct11]: { total_sleep_duration:  1560 },
      [oct12]: { total_sleep_duration: 21780 },
    };
    const claimed = new Set<string>();
    // i=0 (today) claims oct12
    weeklyPickForToday(sessionsByDay, oct11, oct10, oct12, claimed);
    expect(claimed.has(oct12)).toBe(true);

    // Simulate i=1 (oct11) — same date as the nap — checking for nextDate=oct12.
    // nextEntry must be null because oct12 is already claimed.
    const nextEntry = sessionsByDay[oct12] && !claimed.has(oct12) ? sessionsByDay[oct12] : null;
    expect(nextEntry).toBeNull();
  });

  it('no nap, overnight only: weekly today slot returns overnight via nextEntry path', () => {
    const sessionsByDay = {
      [oct12]: { total_sleep_duration: 28800 }, // no oct11 nap
    };
    const claimed = new Set<string>();
    const session = weeklyPickForToday(sessionsByDay, oct11, oct10, oct12, claimed);
    expect(session?.total_sleep_duration).toBe(28800);
  });
});
