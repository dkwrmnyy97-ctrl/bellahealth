/**
 * chat-prompt.test.ts
 *
 * Unit tests for buildTodaySection — the health data section of the Chat system prompt.
 * Verifies that zero/missing values are omitted and real values are included.
 */

import { buildTodaySection, type HealthSnapshot } from '../../utils/chat-prompt';

function makeSnapshot(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    sleep:   { hours: 0, score: 0, hrv: 0, readiness: 0 },
    steps:   { count: 0, goal: 10000 },
    macros:  { calories: 0, protein: 0, carbs: 0, fat: 0, calGoal: 2000 },
    workout: { type: '', duration: 0, calories: 0, done: false },
    water:   { oz: 0, goalOz: 64 },
    hadAlcoholLastNight: false,
    ...overrides,
  };
}

// ─── Sleep field omission ──────────────────────────────────────────────────────

describe('buildTodaySection — sleep fields', () => {
  it('shows "not yet synced" when all sleep fields are zero', () => {
    const result = buildTodaySection(makeSnapshot());
    expect(result).toContain('Sleep: not yet synced for today');
    expect(result).not.toContain('0 hrs');
    expect(result).not.toContain('Score: 0');
    expect(result).not.toContain('HRV: 0 ms');
    expect(result).not.toContain('Readiness: 0');
  });

  it('includes only the sleep sub-fields that have real values', () => {
    const result = buildTodaySection(makeSnapshot({
      sleep: { hours: 7.5, score: 0, hrv: 0, readiness: 82 },
    }));
    expect(result).toContain('7.5 hrs');
    expect(result).toContain('Readiness: 82/100');
    expect(result).not.toContain('Score: 0');
    expect(result).not.toContain('HRV: 0 ms');
  });

  it('includes all sleep sub-fields when all have real values', () => {
    const result = buildTodaySection(makeSnapshot({
      sleep: { hours: 8.1, score: 88, hrv: 54, readiness: 91 },
    }));
    expect(result).toContain('8.1 hrs');
    expect(result).toContain('Score: 88/100');
    expect(result).toContain('HRV: 54 ms');
    expect(result).toContain('Readiness: 91/100');
  });
});

// ─── Water omission ────────────────────────────────────────────────────────────

describe('buildTodaySection — water', () => {
  it('omits hydration line when water is 0', () => {
    const result = buildTodaySection(makeSnapshot({ water: { oz: 0, goalOz: 64 } }));
    expect(result).not.toContain('Hydration');
  });

  it('includes hydration line when water has been logged', () => {
    const result = buildTodaySection(makeSnapshot({ water: { oz: 32, goalOz: 64 } }));
    expect(result).toContain('Hydration: 32 oz / 64 oz goal');
  });
});

// ─── Nutrition omission ────────────────────────────────────────────────────────

describe('buildTodaySection — nutrition', () => {
  it('omits nutrition line when calories are 0', () => {
    const result = buildTodaySection(makeSnapshot());
    expect(result).not.toContain('Nutrition logged');
    expect(result).not.toContain('0 kcal');
  });

  it('includes nutrition line when calories have been logged', () => {
    const result = buildTodaySection(makeSnapshot({
      macros: { calories: 1800, protein: 140, carbs: 180, fat: 70, calGoal: 2000 },
    }));
    expect(result).toContain('Nutrition logged: 1800 kcal');
    expect(result).toContain('Protein: 140g');
    expect(result).toContain('Carbs: 180g');
    expect(result).toContain('Fat: 70g');
  });
});

// ─── Valid zero / false values must be preserved ───────────────────────────────

describe('buildTodaySection — valid zero/false values', () => {
  it('includes "none logged" workout when done=false (not omitted)', () => {
    const result = buildTodaySection(makeSnapshot({ workout: { type: '', duration: 0, calories: 0, done: false } }));
    expect(result).toContain('Workout today: none logged');
  });

  it('includes "no" alcohol when hadAlcoholLastNight=false (not omitted)', () => {
    const result = buildTodaySection(makeSnapshot({ hadAlcoholLastNight: false }));
    expect(result).toContain('Alcohol last night: no');
  });

  it('includes "yes" alcohol when hadAlcoholLastNight=true', () => {
    const result = buildTodaySection(makeSnapshot({ hadAlcoholLastNight: true }));
    expect(result).toContain('Alcohol last night: yes');
  });

  it('includes 0 steps — early-day zero is a valid measurement', () => {
    const result = buildTodaySection(makeSnapshot({ steps: { count: 0, goal: 10000 } }));
    expect(result).toContain('Steps:');
    expect(result).toContain('/ 10,000 goal');
  });

  it('includes workout details when done=true', () => {
    const result = buildTodaySection(makeSnapshot({
      workout: { type: 'Run', duration: 45, calories: 380, done: true },
    }));
    expect(result).toContain('Run, 45 min, 380 kcal burned');
  });
});
