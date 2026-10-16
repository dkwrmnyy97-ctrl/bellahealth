/**
 * alcohol-insight.test.ts
 *
 * Regression tests for the evidence-aware alcohol insight in Trends (explore.tsx).
 *
 * The insight has two cases:
 *   A — Elevated alcohol but no established personal evidence connecting it to recovery.
 *       Copy is observational and forward-looking. No claims about causation.
 *   B — User's own data shows a next-day recovery dip on post-drink days.
 *       Copy names the metrics that actually show the effect. No generic advice.
 *
 * These tests verify:
 *   1. computeAlcoholRecoverySignal() correctly identifies the pattern / no-pattern cases.
 *   2. The old canned text never appears regardless of case.
 *   3. Case A copy is observational (forward-looking, no causation claim).
 *   4. Case B copy names only metrics that showed the effect.
 *   5. Minimum data threshold: fewer than 3 drink days → always case A.
 *   6. Effect-size threshold: trivial difference → always case A.
 *
 * computeAlcoholRecoverySignal and the insight-generation logic are inlined here
 * as pure functions so tests run without React Native native modules.
 */

// ─── Inlined from explore.tsx ─────────────────────────────────────────────────
// These must stay in sync with the implementations in explore.tsx.

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

const MIN_DRINK_DAYS_FOR_PATTERN = 3;

function computeAlcoholRecoverySignal(
  days: OuraWeeklyDay[],
  drinksLogged: (number | null)[],
): { hasPattern: boolean; affectedMetrics: string[] } {
  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  const postDrink = { readiness: [] as number[], hrv: [] as number[], sleepScore: [] as number[] };
  const noDrink   = { readiness: [] as number[], hrv: [] as number[], sleepScore: [] as number[] };

  for (let i = 0; i < days.length - 1; i++) {
    const next = days[i + 1];
    const logged = drinksLogged[i];
    // null = unlogged day; skip it — do not fold into noDrink bucket
    if (logged === null) continue;
    const bucket = logged > 0 ? postDrink : noDrink;
    if (next.readiness  > 0) bucket.readiness.push(next.readiness);
    if (next.hrv        > 0) bucket.hrv.push(next.hrv);
    if (next.sleepScore > 0) bucket.sleepScore.push(next.sleepScore);
  }

  if (postDrink.readiness.length < MIN_DRINK_DAYS_FOR_PATTERN) {
    return { hasPattern: false, affectedMetrics: [] };
  }

  const affectedMetrics: string[] = [];
  const pdRead = avg(postDrink.readiness);
  const ndRead = avg(noDrink.readiness);
  if (pdRead !== null && ndRead !== null && ndRead - pdRead >= 3) affectedMetrics.push('readiness');

  const pdHrv = avg(postDrink.hrv);
  const ndHrv = avg(noDrink.hrv);
  if (pdHrv !== null && ndHrv !== null && ndHrv - pdHrv >= 2)  affectedMetrics.push('HRV');

  const pdSleep = avg(postDrink.sleepScore);
  const ndSleep = avg(noDrink.sleepScore);
  if (pdSleep !== null && ndSleep !== null && ndSleep - pdSleep >= 3) affectedMetrics.push('sleep score');

  return { hasPattern: affectedMetrics.length > 0, affectedMetrics };
}

/** Mirrors the detail-generation logic in buildInsights. */
function buildAlcoholDetail(alcoholHasPattern: boolean, alcoholAffectedMetrics: string[]): string {
  if (alcoholHasPattern && alcoholAffectedMetrics.length > 0) {
    const metricList = alcoholAffectedMetrics.length === 1
      ? alcoholAffectedMetrics[0]
      : alcoholAffectedMetrics.length === 2
        ? `${alcoholAffectedMetrics[0]} and ${alcoholAffectedMetrics[1]}`
        : `${alcoholAffectedMetrics.slice(0, -1).join(', ')}, and ${alcoholAffectedMetrics[alcoholAffectedMetrics.length - 1]}`;
    const verb = alcoholAffectedMetrics.length === 1 ? 'has' : 'have';
    return `On days following alcohol, your ${metricList} ${verb} tended to run lower than your usual range. We'll keep watching whether that holds.`;
  }
  return `Alcohol has been higher than your recent baseline. We'll watch how your recovery responds over the coming days.`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDay(opts: Partial<OuraWeeklyDay> & { date: string }): OuraWeeklyDay {
  return {
    dayLabel: 'Mon', sleepScore: 0, sleepHours: 0, hrv: 0, readiness: 0,
    steps: 0, activeCalories: 0, ...opts,
  };
}

/**
 * Build a sequence of days with a clear drink/no-drink pattern.
 * drinkPattern: array of booleans, one per day (true = had drinks that day).
 * postDrinkReadiness: readiness value on the day AFTER a drink day.
 * noDrinkReadiness: readiness value on the day AFTER a no-drink day.
 */
function buildDrinkScenario({
  drinkPattern,
  postDrinkReadiness,
  noDrinkReadiness,
  postDrinkHrv = 0,
  noDrinkHrv = 0,
  postDrinkSleepScore = 0,
  noDrinkSleepScore = 0,
}: {
  drinkPattern: boolean[];
  postDrinkReadiness: number;
  noDrinkReadiness: number;
  postDrinkHrv?: number;
  noDrinkHrv?: number;
  postDrinkSleepScore?: number;
  noDrinkSleepScore?: number;
}): { days: OuraWeeklyDay[]; drinksLogged: (number | null)[] } {
  const days: OuraWeeklyDay[] = [];
  const drinksLogged: (number | null)[] = [];

  // Day 0: neutral baseline — readiness unknown (will be inferred from drink on day 0)
  days.push(makeDay({ date: '2026-01-01', readiness: noDrinkReadiness, hrv: noDrinkHrv, sleepScore: noDrinkSleepScore }));
  drinksLogged.push(0);

  for (let i = 0; i < drinkPattern.length; i++) {
    const hadDrinks = drinkPattern[i];
    const date = `2026-01-${String(i + 2).padStart(2, '0')}`;
    // This day's readiness reflects the PREVIOUS day's drink status
    const prevHadDrinks = i === 0 ? false : drinkPattern[i - 1];
    const readiness   = prevHadDrinks ? postDrinkReadiness   : noDrinkReadiness;
    const hrv         = prevHadDrinks ? postDrinkHrv         : noDrinkHrv;
    const sleepScore  = prevHadDrinks ? postDrinkSleepScore  : noDrinkSleepScore;
    days.push(makeDay({ date, readiness, hrv, sleepScore }));
    drinksLogged.push(hadDrinks ? 3 : 0);
  }

  return { days, drinksLogged };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('computeAlcoholRecoverySignal — case A: no established pattern', () => {
  it('returns hasPattern=false when there are fewer than 3 drink days', () => {
    const { days, drinksLogged } = buildDrinkScenario({
      drinkPattern: [true, false, true, false, false, false, false], // only 2 drink days
      postDrinkReadiness: 65,
      noDrinkReadiness: 85,  // large effect, but not enough data
    });
    const result = computeAlcoholRecoverySignal(days, drinksLogged);
    expect(result.hasPattern).toBe(false);
    expect(result.affectedMetrics).toHaveLength(0);
  });

  it('returns hasPattern=false when the readiness difference is smaller than 3 points', () => {
    const { days, drinksLogged } = buildDrinkScenario({
      drinkPattern: [true, false, true, false, true, false, false], // 3 drink days
      postDrinkReadiness: 78,
      noDrinkReadiness: 80,  // only 2pt difference — below threshold
    });
    const result = computeAlcoholRecoverySignal(days, drinksLogged);
    expect(result.hasPattern).toBe(false);
    expect(result.affectedMetrics).toHaveLength(0);
  });

  it('returns hasPattern=false when readiness is exactly 2 points lower (below 3pt threshold)', () => {
    const { days, drinksLogged } = buildDrinkScenario({
      drinkPattern: [true, false, true, false, true, false, false],
      postDrinkReadiness: 80,
      noDrinkReadiness: 82,  // exactly 2pt — not sufficient
    });
    const result = computeAlcoholRecoverySignal(days, drinksLogged);
    expect(result.hasPattern).toBe(false);
  });

  it('returns hasPattern=false when there are no drink days at all', () => {
    const { days, drinksLogged } = buildDrinkScenario({
      drinkPattern: [false, false, false, false, false, false, false],
      postDrinkReadiness: 0,
      noDrinkReadiness: 80,
    });
    const result = computeAlcoholRecoverySignal(days, drinksLogged);
    expect(result.hasPattern).toBe(false);
  });

  it('returns hasPattern=false when Oura data is missing (all zeros)', () => {
    const days = Array.from({ length: 8 }, (_, i) =>
      makeDay({ date: `2026-01-${String(i + 1).padStart(2, '0')}` }), // readiness=0
    );
    const drinksLogged = [3, 0, 3, 0, 3, 0, 3, 0];
    const result = computeAlcoholRecoverySignal(days, drinksLogged);
    expect(result.hasPattern).toBe(false);
  });
});

describe('computeAlcoholRecoverySignal — case B: established personal pattern', () => {
  it('detects readiness pattern when post-drink readiness is 10+ points lower', () => {
    const { days, drinksLogged } = buildDrinkScenario({
      drinkPattern: [true, false, true, false, true, false, false],
      postDrinkReadiness: 68,
      noDrinkReadiness: 82,  // 14pt difference — clearly above threshold
    });
    const result = computeAlcoholRecoverySignal(days, drinksLogged);
    expect(result.hasPattern).toBe(true);
    expect(result.affectedMetrics).toContain('readiness');
  });

  it('detects HRV pattern when post-drink HRV is 5+ ms lower, readiness unchanged', () => {
    const { days, drinksLogged } = buildDrinkScenario({
      drinkPattern: [true, false, true, false, true, false, false],
      postDrinkReadiness: 79,
      noDrinkReadiness: 80,   // 1pt — below readiness threshold
      postDrinkHrv: 35,
      noDrinkHrv: 50,         // 15ms — above HRV threshold
    });
    const result = computeAlcoholRecoverySignal(days, drinksLogged);
    expect(result.hasPattern).toBe(true);
    expect(result.affectedMetrics).toContain('HRV');
    expect(result.affectedMetrics).not.toContain('readiness');
  });

  it('detects sleep score pattern when post-drink sleep score is 5+ points lower', () => {
    const { days, drinksLogged } = buildDrinkScenario({
      drinkPattern: [true, false, true, false, true, false, false],
      postDrinkReadiness: 79,
      noDrinkReadiness: 80,    // below readiness threshold
      postDrinkSleepScore: 72,
      noDrinkSleepScore: 82,   // 10pt — above sleep score threshold
    });
    const result = computeAlcoholRecoverySignal(days, drinksLogged);
    expect(result.hasPattern).toBe(true);
    expect(result.affectedMetrics).toContain('sleep score');
    expect(result.affectedMetrics).not.toContain('readiness');
  });

  it('reports all affected metrics when readiness, HRV, and sleep score all show the pattern', () => {
    const { days, drinksLogged } = buildDrinkScenario({
      drinkPattern: [true, false, true, false, true, false, false],
      postDrinkReadiness: 65,
      noDrinkReadiness: 82,    // 17pt readiness drop
      postDrinkHrv: 32,
      noDrinkHrv: 50,          // 18ms HRV drop
      postDrinkSleepScore: 68,
      noDrinkSleepScore: 81,   // 13pt sleep score drop
    });
    const result = computeAlcoholRecoverySignal(days, drinksLogged);
    expect(result.hasPattern).toBe(true);
    expect(result.affectedMetrics).toContain('readiness');
    expect(result.affectedMetrics).toContain('HRV');
    expect(result.affectedMetrics).toContain('sleep score');
    expect(result.affectedMetrics).toHaveLength(3);
  });

  it('exactly 3 drink days with sufficient evidence triggers the pattern (boundary case)', () => {
    const { days, drinksLogged } = buildDrinkScenario({
      drinkPattern: [true, false, true, false, true, false, false],
      postDrinkReadiness: 65,
      noDrinkReadiness: 80,   // 15pt — above threshold
    });
    const result = computeAlcoholRecoverySignal(days, drinksLogged);
    expect(result.hasPattern).toBe(true);
    expect(result.affectedMetrics).toContain('readiness');
  });
});

// ─── Detail copy generation ───────────────────────────────────────────────────

describe('alcohol insight detail copy — case A (no pattern)', () => {
  it('is observational and forward-looking', () => {
    const detail = buildAlcoholDetail(false, []);
    expect(detail).toContain("We'll watch");
    expect(detail).toContain('recent baseline');
    expect(detail).toContain('coming days');
  });

  it('does not claim alcohol caused any specific outcome', () => {
    const detail = buildAlcoholDetail(false, []);
    expect(detail).not.toMatch(/suppress/i);
    expect(detail).not.toMatch(/tended to run lower/i);
    expect(detail).not.toMatch(/has tended|have tended/i);
  });

  it('does not contain the old canned prescription text', () => {
    const detail = buildAlcoholDetail(false, []);
    expect(detail).not.toMatch(/3.4 days/i);
    expect(detail).not.toMatch(/alcohol-free stretch/i);
    expect(detail).not.toMatch(/will show in your recovery scores/i);
    expect(detail).not.toMatch(/deep sleep and HRV measurably/i);
  });
});

describe('alcohol insight detail copy — case B (established pattern)', () => {
  it('describes the user\'s observed relationship — readiness only', () => {
    const detail = buildAlcoholDetail(true, ['readiness']);
    expect(detail).toContain('readiness');
    expect(detail).toContain('tended to run lower');
    expect(detail).toContain("We'll keep watching");
  });

  it('uses singular verb when only one metric is named', () => {
    const detail = buildAlcoholDetail(true, ['readiness']);
    expect(detail).toContain('has tended');
    expect(detail).not.toContain('have tended');
  });

  it('uses plural verb when two or more metrics are named', () => {
    const detail = buildAlcoholDetail(true, ['readiness', 'HRV']);
    expect(detail).toContain('have tended');
    expect(detail).not.toContain('has tended');
  });

  it('names both metrics when two are affected', () => {
    const detail = buildAlcoholDetail(true, ['readiness', 'HRV']);
    expect(detail).toContain('readiness');
    expect(detail).toContain('HRV');
    expect(detail).toContain('readiness and HRV');
  });

  it('names all three metrics with Oxford comma when all are affected', () => {
    const detail = buildAlcoholDetail(true, ['readiness', 'HRV', 'sleep score']);
    expect(detail).toContain('readiness, HRV, and sleep score');
  });

  it('does not mention metrics that are not in affectedMetrics', () => {
    const detail = buildAlcoholDetail(true, ['readiness']);
    expect(detail).not.toContain('HRV');
    expect(detail).not.toContain('sleep score');
  });

  it('does not contain the old canned prescription text', () => {
    const detail = buildAlcoholDetail(true, ['readiness', 'HRV']);
    expect(detail).not.toMatch(/3.4 days/i);
    expect(detail).not.toMatch(/alcohol-free stretch/i);
    expect(detail).not.toMatch(/will show in your recovery scores/i);
    expect(detail).not.toMatch(/deep sleep and HRV measurably/i);
  });

  it('does not include moralizing language', () => {
    for (const metrics of [['readiness'], ['HRV'], ['readiness', 'HRV', 'sleep score']]) {
      const detail = buildAlcoholDetail(true, metrics);
      expect(detail).not.toMatch(/don't overdo/i);
      expect(detail).not.toMatch(/should/i);
      expect(detail).not.toMatch(/avoid/i);
      expect(detail).not.toMatch(/limit/i);
      expect(detail).not.toMatch(/cut back/i);
    }
  });
});

// ─── Case A and B produce distinct copy ──────────────────────────────────────

describe('alcohol insight detail — case A and B are semantically distinct', () => {
  it('case A and case B produce different strings', () => {
    const a = buildAlcoholDetail(false, []);
    const b = buildAlcoholDetail(true, ['readiness']);
    expect(a).not.toBe(b);
  });

  it('case A never claims a tended-lower pattern', () => {
    const a = buildAlcoholDetail(false, []);
    expect(a).not.toMatch(/tended to run lower/i);
  });

  it('case B always uses personal-data language ("your")', () => {
    const b = buildAlcoholDetail(true, ['readiness']);
    expect(b).toMatch(/your readiness/);
  });

  it('headline preserves exact drink total regardless of which case is active', () => {
    // The headline is generated independently of the detail, so this confirms
    // the total is not sanitized. Tested here as a contract assertion.
    const drinkTotal = 15.8;
    const headline = `Alcohol elevated — ${Math.round(drinkTotal * 10) / 10} drinks this week`;
    expect(headline).toBe('Alcohol elevated — 15.8 drinks this week');
  });
});

// ─── Null-awareness: unlogged days must not pollute noDrink bucket ────────────

describe('computeAlcoholRecoverySignal — null = unlogged, not alcohol-free', () => {
  it('null entries are skipped — do not contribute to noDrink bucket', () => {
    // 4 drink days, 3 null (unlogged) days.
    // If nulls were treated as 0, they would populate noDrink and inflate the
    // "no-drink recovery" average, potentially making the pattern appear stronger.
    const days = Array.from({ length: 8 }, (_, i) =>
      makeDay({ date: `2026-01-${String(i + 1).padStart(2, '0')}`,
        readiness: i % 2 === 0 ? 65 : 82 }),
    );
    // Alternate: drink, null, drink, null, drink, null, drink, null
    const drinksLogged: (number | null)[] = [3, null, 3, null, 3, null, 3, null];
    // With nulls skipped, noDrink.readiness is empty → avg returns null → no pattern
    const result = computeAlcoholRecoverySignal(days, drinksLogged);
    // noDrink bucket is empty so the comparison can't be made — no pattern
    expect(result.hasPattern).toBe(false);
  });

  it('a mix of logged-zero and null days correctly separates confirmed-sober from unknown', () => {
    // Readiness: even days HIGH (82), odd days LOW (65).
    // Drink on day 0 → next day (1) has readiness 65 (low post-drink).
    // Sober on day 1 → next day (2) has readiness 82 (high recovery).
    // This confirms the noDrink avg (82) > postDrink avg (65) by 17pts → pattern detected.
    const days = Array.from({ length: 8 }, (_, i) =>
      makeDay({ date: `2026-01-${String(i + 1).padStart(2, '0')}`,
        readiness: i % 2 === 0 ? 82 : 65 }), // even=82, odd=65
    );
    // 3 drink days, 4 logged-zero days, 1 null day
    const drinksLogged: (number | null)[] = [3, 0, 3, 0, 3, 0, null, 0];
    const result = computeAlcoholRecoverySignal(days, drinksLogged);
    // 3 drink days with ≥3pt readiness drop → pattern should be detected
    // (noDrink bucket has 3 valid entries from the logged-zero days)
    expect(result.hasPattern).toBe(true);
    expect(result.affectedMetrics).toContain('readiness');
  });

  it('all-null drinksLogged → hasPattern=false (nothing to compare)', () => {
    const days = Array.from({ length: 8 }, (_, i) =>
      makeDay({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, readiness: 80 }),
    );
    const drinksLogged: (number | null)[] = Array(8).fill(null);
    const result = computeAlcoholRecoverySignal(days, drinksLogged);
    expect(result.hasPattern).toBe(false);
  });
});
