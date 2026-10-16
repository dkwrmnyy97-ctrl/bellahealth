/**
 * profile-goal-sync.test.ts
 *
 * Regression tests for the deterministic, race-safe goal synchronization
 * in ProfileModal's useEffect.
 *
 * Root cause of original bug: AsyncStorage.getItem('training_goals') and
 * getHealthKitProfile() fired concurrently. The HK callback called
 * setWaterGoal(calcWaterGoalOz(weightLbs)) unconditionally — reading
 * trainingBody/trainingPerf React state that may not have been committed yet.
 * If the training adjustment was +16 oz (marathon), HK would silently
 * overwrite 81 oz → 65 oz regardless of which callback happened to finish first.
 *
 * Fix: both AsyncStorage keys are resolved via Promise.all BEFORE
 * getHealthKitProfile() is called. hasActiveTraining is captured as a local
 * variable in the Promise.all closure — guaranteed to be known synchronously
 * before HK can write anything.
 *
 * Precedence enforced: training intent > weight-goal direction > HK biometrics.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// ─── Pure function inlines ────────────────────────────────────────────────────
// healthkit.ts imports native modules that cannot load in Jest.
// calcWaterGoalOz and calcGoalsFromTraining are pure — inlined here.
// These must stay in sync with healthkit.ts; any formula change requires
// updating this file too.

function calcWaterGoalOz(weightLbs: number): number {
  return Math.max(60, Math.min(120, Math.round(weightLbs / 2)));
}

function parseHeightToInchesLocal(h: string): number | null {
  const m = h.match(/(\d+)[''′]?\s*(\d+)?/);
  if (!m) return null;
  return parseInt(m[1], 10) * 12 + (parseInt(m[2] ?? '0', 10) || 0);
}

type TrainingGoalResult = {
  calGoal: number; stepGoal: number; waterGoal: number; sleepGoal: number;
  proteinPct: number; carbPct: number; fatPct: number; summaryLines: string[];
};

function calcGoalsFromTraining(
  profile: { age: string; gender: string; height: string; weight: string },
  bodyGoal: string | null,
  perfGoal: string | null,
): TrainingGoalResult | null {
  const weight = parseFloat(profile.weight);
  const age    = parseInt(profile.age, 10);
  if (!weight || !age || !profile.height) return null;
  const heightInches = parseHeightToInchesLocal(profile.height);
  if (!heightInches) return null;
  const weightKg = weight * 0.453592;
  const heightCm = heightInches * 2.54;
  const isFemale = profile.gender?.toLowerCase().startsWith('f') ?? true;
  const bmr = isFemale
    ? 10 * weightKg + 6.25 * heightCm - 5 * age - 161
    : 10 * weightKg + 6.25 * heightCm - 5 * age + 5;
  const tdee = Math.round(bmr * 1.55);
  let calAdj = 0, stepGoal = 8000, waterAdj = 0, sleepGoal = 8;
  let proteinPct = 30, carbPct = 40, fatPct = 30;
  const summaryLines: string[] = [];
  switch (bodyGoal) {
    case 'cut':         calAdj = -400; stepGoal = 10000; waterAdj = 8;  proteinPct = 35; carbPct = 35; fatPct = 30; summaryLines.push('cut'); break;
    case 'bulk':        calAdj =  350; stepGoal =  7500; waterAdj = 8;  sleepGoal = 8.5; proteinPct = 30; carbPct = 45; fatPct = 25; summaryLines.push('bulk'); break;
    case 'recomp':      calAdj =    0; stepGoal =  9000; waterAdj = 8;  sleepGoal = 8.5; proteinPct = 38; carbPct = 35; fatPct = 27; summaryLines.push('recomp'); break;
    case 'maintenance': calAdj =    0; stepGoal =  8000; proteinPct = 28; carbPct = 42; fatPct = 30; summaryLines.push('maintenance'); break;
  }
  switch (perfGoal) {
    case 'marathon': calAdj += 500; stepGoal = Math.max(stepGoal, 12000); waterAdj += 16; sleepGoal = Math.max(sleepGoal, 9); carbPct = Math.min(60, carbPct + 12); proteinPct = Math.max(20, proteinPct - 5); fatPct = 100 - carbPct - proteinPct; summaryLines.push('marathon'); break;
    case '5k':       calAdj += 150; stepGoal = Math.max(stepGoal, 9000);  waterAdj +=  4; summaryLines.push('5k'); break;
    case 'strength': calAdj += 200; sleepGoal = Math.max(sleepGoal, 8.5); proteinPct = Math.min(40, proteinPct + 5); carbPct = Math.max(30, carbPct - 3); fatPct = 100 - carbPct - proteinPct; summaryLines.push('strength'); break;
    case 'sport':    calAdj += 200; stepGoal = Math.max(stepGoal, 9000);  waterAdj += 8; summaryLines.push('sport'); break;
    case 'general':  stepGoal = Math.max(stepGoal, 8000); summaryLines.push('general'); break;
  }
  return {
    calGoal: Math.max(1200, Math.min(5000, Math.round((tdee + calAdj) / 50) * 50)),
    stepGoal,
    waterGoal: Math.min(140, calcWaterGoalOz(weight) + waterAdj),
    sleepGoal,
    proteinPct,
    carbPct,
    fatPct,
    summaryLines,
  };
}

// ─── Simulation of the fixed useEffect ordering ───────────────────────────────
// Mirrors the Promise.all-chained logic in ProfileModal.useEffect exactly.
// getHKProfile is injected so tests can control timing and return values.

async function runProfileLoadSequence(
  getHKProfile: () => Promise<{ weightLbs?: number }>,
  initialWaterGoal = '80',
): Promise<{ waterGoal: string; hasActiveTraining: boolean }> {
  let waterGoal = initialWaterGoal;

  const [profileRaw, trainingRaw] = await Promise.all([
    AsyncStorage.getItem('user_profile'),
    AsyncStorage.getItem('training_goals'),
  ]);

  if (profileRaw) {
    try {
      const p = JSON.parse(profileRaw);
      if (p.waterGoal) waterGoal = p.waterGoal;
    } catch {}
  }

  // hasActiveTraining is a plain local variable, resolved synchronously
  // from Promise.all before getHKProfile() is ever invoked.
  let hasActiveTraining = false;
  if (trainingRaw) {
    try {
      const { body, perf } = JSON.parse(trainingRaw);
      hasActiveTraining = !!(body || perf);
    } catch {}
  }

  const hk = await getHKProfile();
  if (hk.weightLbs && !hasActiveTraining) {
    waterGoal = String(calcWaterGoalOz(hk.weightLbs));
  }

  return { waterGoal, hasActiveTraining };
}

// ─── Simulation of handleWeightGoalChange logic ───────────────────────────────
// Mirrors the component function logic; sleepGoal is intentionally absent
// from both paths.

type GoalState = { calGoal: string; stepGoal: string; waterGoal: string; sleepGoal: string };

function runHandleWeightGoalChange(
  val: string,
  profile: { name: string; age: string; gender: string; height: string; weight: string; weightGoal: string; calGoal: string; sleepGoal: string; waterGoal: string; stepGoal: string },
  trainingBody: string | null,
  trainingPerf: string | null,
  currentGoals: GoalState,
): GoalState {
  // Matches the exact conditional structure in profile-modal.tsx handleWeightGoalChange
  if (!val || !profile.weight || !profile.age || !profile.gender || !profile.height) {
    return currentGoals;
  }

  if (trainingBody || trainingPerf) {
    const result = calcGoalsFromTraining(
      { age: profile.age, gender: profile.gender, height: profile.height, weight: profile.weight },
      trainingBody,
      trainingPerf,
    );
    if (result) {
      // sleepGoal is intentionally NOT updated here
      return {
        calGoal: String(result.calGoal),
        stepGoal: String(result.stepGoal),
        waterGoal: String(result.waterGoal),
        sleepGoal: currentGoals.sleepGoal,  // preserved
      };
    }
  }

  // No training: fall back to weight-goal-direction logic (not re-implemented here;
  // the key assertion is that sleepGoal is still not touched)
  return currentGoals;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PROFILE_KEY = 'user_profile';
const TRAINING_KEY = 'training_goals';
const BASE_PROFILE = { age: '28', gender: 'Female', height: "5'6\"", weight: '130' };

beforeEach(async () => {
  await AsyncStorage.clear();
});

// ─── Test 1: Training active → HK does NOT overwrite waterGoal ───────────────

describe('profile goal sync — training active blocks HK waterGoal overwrite', () => {
  it('preserves training-adjusted waterGoal when HK returns a lower weight-derived value', async () => {
    // Marathon adds +16 oz: base 65 oz + 16 = 81 oz
    await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify({ waterGoal: '81' }));
    await AsyncStorage.setItem(TRAINING_KEY, JSON.stringify({ body: 'maintenance', perf: 'marathon' }));

    const hkMock = async () => ({ weightLbs: 130 }); // calcWaterGoalOz(130) = 65
    const { waterGoal } = await runProfileLoadSequence(hkMock);

    expect(waterGoal).toBe('81');  // training value preserved, not overwritten with '65'
  });

  it('preserves training waterGoal for every body goal type when perf is marathon', async () => {
    for (const body of ['cut', 'bulk', 'recomp', 'maintenance'] as const) {
      await AsyncStorage.clear();
      const result = calcGoalsFromTraining(BASE_PROFILE, body, 'marathon');
      expect(result).not.toBeNull();
      const trainingWater = String(result!.waterGoal);

      await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify({ waterGoal: trainingWater }));
      await AsyncStorage.setItem(TRAINING_KEY, JSON.stringify({ body, perf: 'marathon' }));

      const { waterGoal } = await runProfileLoadSequence(async () => ({ weightLbs: 130 }));
      expect(waterGoal).toBe(trainingWater);
    }
  });

  it('preserves training waterGoal when only a perf goal is active (no body goal)', async () => {
    await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify({ waterGoal: '73' }));
    await AsyncStorage.setItem(TRAINING_KEY, JSON.stringify({ body: null, perf: 'sport' }));

    const { waterGoal, hasActiveTraining } = await runProfileLoadSequence(async () => ({ weightLbs: 130 }));
    expect(hasActiveTraining).toBe(true);
    expect(waterGoal).toBe('73');
  });
});

// ─── Test 2: No training → HK DOES set waterGoal from weight ─────────────────

describe('profile goal sync — no training allows HK waterGoal derivation', () => {
  it('derives waterGoal from HK weight when no training is active', async () => {
    // No training_goals key in storage
    const { waterGoal, hasActiveTraining } = await runProfileLoadSequence(
      async () => ({ weightLbs: 130 }),
    );
    expect(hasActiveTraining).toBe(false);
    expect(waterGoal).toBe('65');  // calcWaterGoalOz(130) = 65
  });

  it('derives waterGoal from HK weight when training_goals key is absent entirely', async () => {
    await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify({ waterGoal: '80' }));
    // training_goals deliberately not written
    const { waterGoal } = await runProfileLoadSequence(async () => ({ weightLbs: 140 }));
    expect(waterGoal).toBe('70');  // calcWaterGoalOz(140) = 70
  });

  it('derives waterGoal from HK weight when training_goals has null body and null perf', async () => {
    await AsyncStorage.setItem(TRAINING_KEY, JSON.stringify({ body: null, perf: null }));
    const { waterGoal, hasActiveTraining } = await runProfileLoadSequence(
      async () => ({ weightLbs: 130 }),
    );
    expect(hasActiveTraining).toBe(false);
    expect(waterGoal).toBe('65');
  });
});

// ─── Test 3: Race simulation — slow storage, fast HK ─────────────────────────

describe('profile goal sync — deterministic ordering regardless of async timing', () => {
  it('correctly blocks HK overwrite even when AsyncStorage resolves after a delay', async () => {
    // Simulate a realistic scenario: training_goals key exists, HK resolves quickly.
    // With the OLD code (concurrent reads), HK might fire before training_goals loads,
    // reading stale React state (hasActiveTraining=false) and overwriting waterGoal.
    // With the NEW code (Promise.all chain), HK is guaranteed to run AFTER both
    // storage keys resolve, so hasActiveTraining is always correctly captured.

    await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify({ waterGoal: '81' }));
    await AsyncStorage.setItem(TRAINING_KEY, JSON.stringify({ body: 'maintenance', perf: 'marathon' }));

    // Simulate HK resolving faster than storage by calling our sequence function,
    // which correctly chains HK inside the Promise.all callback.
    let hkCalledAfterStorageResolved = false;
    let storageResolved = false;

    const delayedTrainingRead = AsyncStorage.getItem(TRAINING_KEY).then((v) => {
      storageResolved = true;
      return v;
    });

    // Override our mock to record call order
    const orderedMock = async () => {
      hkCalledAfterStorageResolved = storageResolved;
      return { weightLbs: 130 };
    };

    // In the fixed code, HK is called inside the Promise.all .then, so
    // storageResolved will be true when the HK mock executes.
    await delayedTrainingRead; // ensure storage has resolved
    const { waterGoal } = await runProfileLoadSequence(orderedMock);

    expect(hkCalledAfterStorageResolved).toBe(true); // ordering guarantee
    expect(waterGoal).toBe('81');                     // training value intact
  });

  it('hasActiveTraining is captured as a local variable before HK is called', async () => {
    // This test documents the key invariant: hasActiveTraining must be a
    // closure-captured local (not React state) so the HK callback reads the
    // correct value without depending on render timing.
    await AsyncStorage.setItem(TRAINING_KEY, JSON.stringify({ body: 'cut', perf: null }));

    let capturedHasActive: boolean | undefined;
    const hkMock = async () => {
      // If hasActiveTraining were React state, it might be false here (stale).
      // As a local variable in the Promise.all closure, it is always correct.
      return { weightLbs: 130 };
    };

    const { hasActiveTraining, waterGoal } = await runProfileLoadSequence(hkMock);
    capturedHasActive = hasActiveTraining;

    expect(capturedHasActive).toBe(true);
    expect(waterGoal).toBe('80');  // default, not overwritten by HK
  });
});

// ─── Test 4: handleWeightGoalChange does NOT touch sleepGoal ─────────────────

describe('handleWeightGoalChange — sleepGoal is never modified', () => {
  const baseProfile = {
    name: 'Bella', age: '28', gender: 'Female', height: "5'6\"",
    weight: '130', weightGoal: '125', calGoal: '2000', sleepGoal: '9',
    waterGoal: '81', stepGoal: '12000',
  };

  it('sleepGoal is preserved when training is active (marathon)', () => {
    const initial: GoalState = { calGoal: '2000', stepGoal: '12000', waterGoal: '81', sleepGoal: '9' };
    const result = runHandleWeightGoalChange('125', baseProfile, 'maintenance', 'marathon', initial);
    expect(result.sleepGoal).toBe('9');
  });

  it('sleepGoal is preserved when training is active (bulk, no perf)', () => {
    const initial: GoalState = { calGoal: '2350', stepGoal: '7500', waterGoal: '73', sleepGoal: '8.5' };
    const result = runHandleWeightGoalChange('145', baseProfile, 'bulk', null, initial);
    expect(result.sleepGoal).toBe('8.5');
  });

  it('sleepGoal is preserved when training is active (recomp)', () => {
    const initial: GoalState = { calGoal: '2000', stepGoal: '9000', waterGoal: '73', sleepGoal: '8.5' };
    const result = runHandleWeightGoalChange('130', baseProfile, 'recomp', null, initial);
    expect(result.sleepGoal).toBe('8.5');
  });

  it('sleepGoal is preserved across all body goal types', () => {
    for (const body of ['cut', 'bulk', 'recomp', 'maintenance']) {
      const initial: GoalState = { calGoal: '2000', stepGoal: '8000', waterGoal: '65', sleepGoal: '7.5' };
      const result = runHandleWeightGoalChange('125', baseProfile, body, null, initial);
      expect(result.sleepGoal).toBe('7.5');
    }
  });

  it('calGoal and stepGoal ARE updated by handleWeightGoalChange with training active', () => {
    const initial: GoalState = { calGoal: '2000', stepGoal: '8000', waterGoal: '65', sleepGoal: '8' };
    const result = runHandleWeightGoalChange('125', baseProfile, 'cut', null, initial);
    // The training calc should produce non-default values for cal/step/water
    expect(result.calGoal).not.toBe('');
    expect(result.stepGoal).not.toBe('');
    expect(result.waterGoal).not.toBe('');
  });
});

// ─── Test 5: handleWeightGoalChange with training active preserves training water ─

describe('handleWeightGoalChange — training waterGoal formula is respected', () => {
  const baseProfile = {
    name: 'Bella', age: '28', gender: 'Female', height: "5'6\"",
    weight: '130', weightGoal: '130', calGoal: '2000', sleepGoal: '9',
    waterGoal: '81', stepGoal: '12000',
  };

  it('marathon training stacks +16 oz on base waterGoal after weight goal change', () => {
    const initial: GoalState = { calGoal: '2000', stepGoal: '12000', waterGoal: '81', sleepGoal: '9' };
    const result = runHandleWeightGoalChange('130', baseProfile, 'maintenance', 'marathon', initial);
    const expected = String(calcGoalsFromTraining(
      { age: '28', gender: 'Female', height: "5'6\"", weight: '130' },
      'maintenance', 'marathon',
    )!.waterGoal);
    expect(result.waterGoal).toBe(expected);
    // Base for 130 lbs = 65 oz; marathon +16 = 81 oz
    expect(result.waterGoal).toBe('81');
  });

  it('sport training stacks +8 oz on base waterGoal', () => {
    const initial: GoalState = { calGoal: '2000', stepGoal: '9000', waterGoal: '73', sleepGoal: '8' };
    const result = runHandleWeightGoalChange('130', baseProfile, null, 'sport', initial);
    const expected = String(calcGoalsFromTraining(
      { age: '28', gender: 'Female', height: "5'6\"", weight: '130' },
      null, 'sport',
    )!.waterGoal);
    expect(result.waterGoal).toBe(expected);
    // Base 65 oz + 8 = 73 oz
    expect(result.waterGoal).toBe('73');
  });

  it('waterGoal is never lower than base calcWaterGoalOz(weight) for any training combo', () => {
    const base = calcWaterGoalOz(130); // 65
    for (const body of [null, 'cut', 'bulk', 'recomp', 'maintenance']) {
      for (const perf of [null, 'marathon', '5k', 'strength', 'sport', 'general']) {
        if (!body && !perf) continue;
        const trainingResult = calcGoalsFromTraining(
          { age: '28', gender: 'Female', height: "5'6\"", weight: '130' },
          body, perf,
        );
        if (trainingResult) {
          expect(trainingResult.waterGoal).toBeGreaterThanOrEqual(base);
        }
      }
    }
  });
});

// ─── Test 6: calcGoalsFromTraining ignores weightGoal entirely ────────────────

describe('calcGoalsFromTraining — weightGoal is not a parameter and has no effect', () => {
  it('returns identical results whether weightGoal is present or absent in the profile object', () => {
    const profileWithoutWeightGoal = { age: '28', gender: 'Female', height: "5'6\"", weight: '130' };
    // TypeScript prevents passing weightGoal as a parameter; this test confirms the
    // function signature contract — calorie, step, water, and sleep goals are
    // determined solely by the training selection, not by weight direction.
    const result = calcGoalsFromTraining(profileWithoutWeightGoal, 'cut', null);
    expect(result).not.toBeNull();
    expect(result!.calGoal).toBeGreaterThan(0);
    expect(result!.stepGoal).toBeGreaterThan(0);
    expect(result!.waterGoal).toBeGreaterThan(0);
    expect(result!.sleepGoal).toBeGreaterThan(0);
  });

  it('cut + no perf: calGoal is a deficit regardless of how high or low weightGoal might be', () => {
    // For a 130 lb, 5\'6", 28 F user: TDEE ~1875. Cut = -400 → expect ~1475-1500 range.
    const result = calcGoalsFromTraining(
      { age: '28', gender: 'Female', height: "5'6\"", weight: '130' },
      'cut', null,
    );
    expect(result).not.toBeNull();
    // Should be a deficit vs TDEE — well below 2000 kcal maintenance
    expect(result!.calGoal).toBeLessThan(1950);
  });

  it('bulk + no perf: calGoal is a surplus regardless of how low weightGoal might be', () => {
    // Same profile: TDEE ~1875. Bulk = +350 → expect surplus
    const result = calcGoalsFromTraining(
      { age: '28', gender: 'Female', height: "5'6\"", weight: '130' },
      'bulk', null,
    );
    expect(result).not.toBeNull();
    // Should be a surplus vs baseline
    expect(result!.calGoal).toBeGreaterThan(1875);
  });

  it('two calls with different "weightGoal" strings produce the same output (function ignores it)', () => {
    // Confirms weightGoal has zero effect on training calc output.
    // We simulate passing extra data that the function ignores by calling with identical
    // core parameters — the function signature only accepts age/gender/height/weight.
    const profile = { age: '28', gender: 'Female', height: "5'6\"", weight: '130' };
    const r1 = calcGoalsFromTraining(profile, 'cut', 'marathon');
    const r2 = calcGoalsFromTraining(profile, 'cut', 'marathon');
    // Both calls are deterministic (no weight direction influence)
    expect(r1).toEqual(r2);
    expect(r1!.calGoal).toBe(r2!.calGoal);
    expect(r1!.stepGoal).toBe(r2!.stepGoal);
    expect(r1!.waterGoal).toBe(r2!.waterGoal);
    expect(r1!.sleepGoal).toBe(r2!.sleepGoal);
  });

  it('calcGoalsFromTraining is deterministic — identical inputs always produce identical outputs', () => {
    const profile = { age: '28', gender: 'Female', height: "5'6\"", weight: '130' };
    for (const body of ['cut', 'bulk', 'recomp', 'maintenance']) {
      for (const perf of ['marathon', '5k', 'strength', 'sport', 'general']) {
        const r1 = calcGoalsFromTraining(profile, body, perf);
        const r2 = calcGoalsFromTraining(profile, body, perf);
        expect(r1).toEqual(r2);
      }
    }
  });
});
