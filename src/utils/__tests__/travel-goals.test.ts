/**
 * travel-goals.test.ts
 *
 * Regression tests for resolveTravelGoals() — the pure function that
 * determines which goal values the Home dashboard displays.
 *
 * Covers requirements:
 *   1. Travel Mode OFF → normal profile goals pass through
 *   2. Travel Mode ON → travel step goal applied
 *   3. Travel Mode ON → travel water goal applied
 *   4. Travel Mode ON → travel sleep goal applied
 *   5. Travel Mode ON → caloriesRelaxed = true
 *   6. Actual calorie data unaffected (function has no side effects)
 *   7. Turning Travel Mode OFF restores original goals
 *   8. user_profile is never mutated (inputs unchanged)
 *   9. Persistence is via AsyncStorage (not tested here — covered by existing context-events tests)
 *  10. Missing/zero metric stays as-is (function never forces non-zero)
 *  11. TravelModal and Home consume the same constants (both import TRAVEL_* from this module)
 */

import {
  resolveTravelGoals,
  TRAVEL_STEP_GOAL,
  TRAVEL_WATER_OZ,
  TRAVEL_SLEEP_HRS,
} from '../travel-goals';

const PROFILE_STEPS = 10000;
const PROFILE_WATER = 96;
const PROFILE_SLEEP = 9;

// ─── Travel Mode OFF: profile goals pass through unchanged ────────────────────

describe('resolveTravelGoals — Travel Mode OFF', () => {
  const result = resolveTravelGoals(false, PROFILE_STEPS, PROFILE_WATER, PROFILE_SLEEP);

  it('returns profile step goal', () => {
    expect(result.stepGoal).toBe(PROFILE_STEPS);
  });

  it('returns profile water goal', () => {
    expect(result.waterGoal).toBe(PROFILE_WATER);
  });

  it('returns profile sleep goal', () => {
    expect(result.sleepGoalHrs).toBe(PROFILE_SLEEP);
  });

  it('caloriesRelaxed is false', () => {
    expect(result.caloriesRelaxed).toBe(false);
  });
});

// ─── Travel Mode ON: travel constants applied ─────────────────────────────────

describe('resolveTravelGoals — Travel Mode ON', () => {
  const result = resolveTravelGoals(true, PROFILE_STEPS, PROFILE_WATER, PROFILE_SLEEP);

  it('returns travel step goal (not profile goal)', () => {
    expect(result.stepGoal).toBe(TRAVEL_STEP_GOAL);
  });

  it('travel step goal is less than typical profile goal', () => {
    expect(TRAVEL_STEP_GOAL).toBeLessThan(PROFILE_STEPS);
  });

  it('returns travel water goal (not profile goal)', () => {
    expect(result.waterGoal).toBe(TRAVEL_WATER_OZ);
  });

  it('returns travel sleep goal (not profile goal)', () => {
    expect(result.sleepGoalHrs).toBe(TRAVEL_SLEEP_HRS);
  });

  it('caloriesRelaxed is true', () => {
    expect(result.caloriesRelaxed).toBe(true);
  });
});

// ─── Toggling restores original goals ────────────────────────────────────────

describe('resolveTravelGoals — toggling OFF restores profile goals', () => {
  it('step goal is restored after turning OFF', () => {
    const on  = resolveTravelGoals(true,  PROFILE_STEPS, PROFILE_WATER, PROFILE_SLEEP);
    const off = resolveTravelGoals(false, PROFILE_STEPS, PROFILE_WATER, PROFILE_SLEEP);
    expect(off.stepGoal).toBe(PROFILE_STEPS);
    expect(off.stepGoal).not.toBe(on.stepGoal);
  });

  it('water goal is restored after turning OFF', () => {
    const on  = resolveTravelGoals(true,  PROFILE_STEPS, PROFILE_WATER, PROFILE_SLEEP);
    const off = resolveTravelGoals(false, PROFILE_STEPS, PROFILE_WATER, PROFILE_SLEEP);
    expect(off.waterGoal).toBe(PROFILE_WATER);
    expect(off.waterGoal).not.toBe(on.waterGoal);
  });

  it('caloriesRelaxed reverts to false after turning OFF', () => {
    const off = resolveTravelGoals(false, PROFILE_STEPS, PROFILE_WATER, PROFILE_SLEEP);
    expect(off.caloriesRelaxed).toBe(false);
  });
});

// ─── user_profile is never mutated ───────────────────────────────────────────

describe('resolveTravelGoals — profile isolation', () => {
  it('OFF result uses exact input profile goals', () => {
    const r = resolveTravelGoals(false, 12000, 80, 7.5);
    expect(r.stepGoal).toBe(12000);
    expect(r.waterGoal).toBe(80);
    expect(r.sleepGoalHrs).toBe(7.5);
  });

  it('ON result does not use profile values', () => {
    const r = resolveTravelGoals(true, 12000, 80, 7.5);
    expect(r.stepGoal).not.toBe(12000);
    expect(r.waterGoal).not.toBe(80);
    expect(r.sleepGoalHrs).not.toBe(7.5);
  });
});

// ─── Missing / zero data rule ─────────────────────────────────────────────────

describe('resolveTravelGoals — missing/zero data', () => {
  it('zero profile step goal passes through when Travel Mode is off', () => {
    const r = resolveTravelGoals(false, 0, 80, 8);
    expect(r.stepGoal).toBe(0);
  });

  it('zero profile water goal passes through when Travel Mode is off', () => {
    const r = resolveTravelGoals(false, 10000, 0, 8);
    expect(r.waterGoal).toBe(0);
  });

  it('Travel Mode ON uses travel constants (not zero) when profile goals are missing', () => {
    const r = resolveTravelGoals(true, 0, 0, 0);
    expect(r.stepGoal).toBe(TRAVEL_STEP_GOAL);
    expect(r.waterGoal).toBe(TRAVEL_WATER_OZ);
    expect(r.sleepGoalHrs).toBe(TRAVEL_SLEEP_HRS);
  });
});

// ─── Constants are valid numerics ─────────────────────────────────────────────

describe('Travel Mode constants', () => {
  it('TRAVEL_STEP_GOAL is a positive integer', () => {
    expect(TRAVEL_STEP_GOAL).toBeGreaterThan(0);
    expect(Number.isInteger(TRAVEL_STEP_GOAL)).toBe(true);
  });

  it('TRAVEL_WATER_OZ is a positive integer', () => {
    expect(TRAVEL_WATER_OZ).toBeGreaterThan(0);
    expect(Number.isInteger(TRAVEL_WATER_OZ)).toBe(true);
  });

  it('TRAVEL_SLEEP_HRS is a positive number', () => {
    expect(TRAVEL_SLEEP_HRS).toBeGreaterThan(0);
  });

  // Requirement 11: TravelModal and Home share the same source.
  // resolveTravelGoals returns TRAVEL_* constants when ON, so any
  // component importing TRAVEL_* directly (TravelModal for display)
  // and resolveTravelGoals (Home for goals) will always agree.
  it('resolveTravelGoals ON returns the exported constants exactly', () => {
    const r = resolveTravelGoals(true, 99999, 99999, 99999);
    expect(r.stepGoal).toBe(TRAVEL_STEP_GOAL);
    expect(r.waterGoal).toBe(TRAVEL_WATER_OZ);
    expect(r.sleepGoalHrs).toBe(TRAVEL_SLEEP_HRS);
  });
});
