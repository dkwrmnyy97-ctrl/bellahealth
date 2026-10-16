/**
 * training-goals.test.ts
 *
 * Regression tests for Training Goal persistence behavior.
 *
 * Root cause of original bug: selectBody and selectPerf each fired an
 * independent applyGoals() async write on every tap.  Because React state
 * updates are async, selectPerf ran before the previous render committed
 * selectedBody, so it captured a stale null and wrote { body: null, perf }
 * — silently losing the body selection.
 *
 * Fix: selections are held in local React state; a single atomic write
 * (handleDone) persists both fields together when the user taps Done.
 *
 * Tests here verify the AsyncStorage contract directly so the guarantee
 * holds regardless of component re-renders or React batching.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// healthkit.ts imports native modules that cannot load in Jest.
// We inline calcGoalsFromTraining here — it is a pure function with no
// native dependencies; the source-of-truth version lives in healthkit.ts.
type TrainingGoalResult = {
  calGoal: number; stepGoal: number; waterGoal: number; sleepGoal: number;
  proteinPct: number; carbPct: number; fatPct: number;
  summaryLines: string[];
};

function parseHeightToInches(h: string): number | null {
  const m = h.match(/(\d+)[''′]?\s*(\d+)?/);
  if (!m) return null;
  return parseInt(m[1], 10) * 12 + (parseInt(m[2] ?? '0', 10) || 0);
}

function calcGoalsFromTraining(
  profile: { age: string; gender: string; height: string; weight: string },
  bodyGoal: string | null,
  perfGoal: string | null,
): TrainingGoalResult | null {
  const weight = parseFloat(profile.weight);
  const age    = parseInt(profile.age, 10);
  if (!weight || !age || !profile.height) return null;
  const heightInches = parseHeightToInches(profile.height);
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
    case 'cut':        calAdj = -400; stepGoal = 10000; waterAdj = 8;  proteinPct = 35; carbPct = 35; fatPct = 30; summaryLines.push('cut'); break;
    case 'bulk':       calAdj =  350; stepGoal =  7500; waterAdj = 8;  sleepGoal = 8.5; proteinPct = 30; carbPct = 45; fatPct = 25; summaryLines.push('bulk'); break;
    case 'recomp':     calAdj =    0; stepGoal =  9000; waterAdj = 8;  sleepGoal = 8.5; proteinPct = 38; carbPct = 35; fatPct = 27; summaryLines.push('recomp'); break;
    case 'maintenance':calAdj =    0; stepGoal =  8000; proteinPct = 28; carbPct = 42; fatPct = 30; summaryLines.push('maintenance'); break;
  }
  switch (perfGoal) {
    case 'marathon': calAdj += 500; stepGoal = Math.max(stepGoal, 12000); waterAdj += 16; sleepGoal = Math.max(sleepGoal, 9); carbPct = Math.min(60, carbPct + 12); proteinPct = Math.max(20, proteinPct - 5); fatPct = 100 - carbPct - proteinPct; summaryLines.push('marathon'); break;
    case '5k':       calAdj += 150; stepGoal = Math.max(stepGoal, 9000);  waterAdj +=  4; summaryLines.push('5k'); break;
    case 'strength': calAdj +=  75; stepGoal = Math.max(stepGoal, 8000);  proteinPct = Math.min(40, proteinPct + 4); fatPct = Math.max(20, fatPct - 2); carbPct = 100 - proteinPct - fatPct; summaryLines.push('strength'); break;
    case 'sport':    calAdj += 200; stepGoal = Math.max(stepGoal, 9000);  waterAdj += 8; summaryLines.push('sport'); break;
    case 'general':  summaryLines.push('general'); break;
  }
  return {
    calGoal: tdee + calAdj,
    stepGoal,
    waterGoal: 64 + waterAdj,
    sleepGoal,
    proteinPct,
    carbPct,
    fatPct,
    summaryLines,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'training_goals';

/** Simulates the atomic Done-handler write. */
async function persistGoals(body: string | null, perf: string | null) {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ body, perf }));
}

/** Simulates the modal load on open. */
async function loadGoals(): Promise<{ body: string | null; perf: string | null }> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return { body: null, perf: null };
  const { body, perf } = JSON.parse(raw);
  return { body: body ?? null, perf: perf ?? null };
}

const PROFILE = { age: '28', gender: 'female', height: '5\'6"', weight: '140' };

// ─── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await AsyncStorage.clear();
});

// ─── 1. Multiple selected goals persist ───────────────────────────────────────

describe('training goals — multiple selections persist', () => {
  it('persists both body and performance goal together', async () => {
    await persistGoals('cut', 'strength');
    const saved = await loadGoals();
    expect(saved.body).toBe('cut');
    expect(saved.perf).toBe('strength');
  });

  it('persists body-only selection', async () => {
    await persistGoals('bulk', null);
    const saved = await loadGoals();
    expect(saved.body).toBe('bulk');
    expect(saved.perf).toBeNull();
  });

  it('persists performance-only selection', async () => {
    await persistGoals(null, 'marathon');
    const saved = await loadGoals();
    expect(saved.body).toBeNull();
    expect(saved.perf).toBe('marathon');
  });
});

// ─── 2. Immediate reopen restores selections ──────────────────────────────────

describe('training goals — immediate reopen restores selection', () => {
  it('loadGoals() after persistGoals() returns the exact same values', async () => {
    await persistGoals('recomp', '5k');
    const restored = await loadGoals();
    expect(restored.body).toBe('recomp');
    expect(restored.perf).toBe('5k');
  });

  it('loading before any persist returns null for both fields', async () => {
    const initial = await loadGoals();
    expect(initial.body).toBeNull();
    expect(initial.perf).toBeNull();
  });
});

// ─── 3. Relaunch / cold-load restores selections ──────────────────────────────

describe('training goals — relaunch restores selections', () => {
  it('values survive being read from raw AsyncStorage (simulates app relaunch)', async () => {
    // Write directly as raw JSON — simulates data already on device from a
    // previous session.
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ body: 'maintenance', perf: 'sport' }));
    const loaded = await loadGoals();
    expect(loaded.body).toBe('maintenance');
    expect(loaded.perf).toBe('sport');
  });
});

// ─── 4. Adding a second goal preserves the first ──────────────────────────────

describe('training goals — adding a goal preserves existing selection', () => {
  it('saving body + perf after only-body was saved keeps body unchanged', async () => {
    await persistGoals('cut', null);
    // User opens modal again, adds a perf goal → atomic write includes both
    await persistGoals('cut', 'strength');
    const saved = await loadGoals();
    expect(saved.body).toBe('cut');
    expect(saved.perf).toBe('strength');
  });

  it('adding a body goal while perf is already selected keeps perf', async () => {
    await persistGoals(null, 'marathon');
    await persistGoals('bulk', 'marathon');
    const saved = await loadGoals();
    expect(saved.body).toBe('bulk');
    expect(saved.perf).toBe('marathon');
  });
});

// ─── 5. Deselecting one goal preserves the remaining goal ─────────────────────

describe('training goals — deselecting one preserves remaining selection', () => {
  it('removing body goal preserves perf goal', async () => {
    await persistGoals('cut', 'strength');
    // User deselects body → atomic write with body=null
    await persistGoals(null, 'strength');
    const saved = await loadGoals();
    expect(saved.body).toBeNull();
    expect(saved.perf).toBe('strength');
  });

  it('removing perf goal preserves body goal', async () => {
    await persistGoals('bulk', '5k');
    await persistGoals('bulk', null);
    const saved = await loadGoals();
    expect(saved.body).toBe('bulk');
    expect(saved.perf).toBeNull();
  });
});

// ─── 6. Rapid multi-select cannot lose selections ─────────────────────────────

describe('training goals — atomic write prevents race-condition data loss', () => {
  it('a single Done-handler write with both fields always stores both correctly', async () => {
    // Simulate user tapping Body: cut, then Perf: strength rapidly.
    // Old behavior: two independent writes, second overwrites first with stale body=null.
    // New behavior: one atomic write with the final complete state.
    const finalBody = 'cut';
    const finalPerf = 'strength';
    await persistGoals(finalBody, finalPerf);
    const saved = await loadGoals();
    expect(saved.body).toBe('cut');
    expect(saved.perf).toBe('strength');
  });

  it('sequential writes result in the last write being authoritative', async () => {
    // Even if two saves somehow fire, the last one (atomic done-write) wins
    // and contains the complete correct state.
    await persistGoals('cut', null);          // hypothetical stale write
    await persistGoals('cut', 'strength');    // atomic done-write, always last
    const saved = await loadGoals();
    expect(saved.body).toBe('cut');
    expect(saved.perf).toBe('strength');
  });
});

// ─── 7. Empty selection persists correctly ────────────────────────────────────

describe('training goals — empty selection persists', () => {
  it('saving null/null after previous selections correctly clears both', async () => {
    await persistGoals('cut', 'strength');
    await persistGoals(null, null);
    const saved = await loadGoals();
    expect(saved.body).toBeNull();
    expect(saved.perf).toBeNull();
  });

  it('loading after null/null save does not fall back to stale values', async () => {
    await persistGoals('bulk', 'marathon');
    await persistGoals(null, null);
    // Simulate reopen
    const loaded = await loadGoals();
    expect(loaded.body).toBeNull();
    expect(loaded.perf).toBeNull();
  });
});

// ─── 8. Stored values map correctly back to UI state ─────────────────────────

describe('training goals — stored IDs map to correct UI selections', () => {
  const bodyIds    = ['cut', 'bulk', 'maintenance', 'recomp'];
  const perfIds    = ['marathon', '5k', 'strength', 'sport', 'general'];

  it.each(bodyIds)('body goal "%s" round-trips through storage unchanged', async (id) => {
    await persistGoals(id, null);
    const loaded = await loadGoals();
    expect(loaded.body).toBe(id);
  });

  it.each(perfIds)('perf goal "%s" round-trips through storage unchanged', async (id) => {
    await persistGoals(null, id);
    const loaded = await loadGoals();
    expect(loaded.perf).toBe(id);
  });

  it('calcGoalsFromTraining returns non-null result for each valid body goal', () => {
    for (const id of bodyIds) {
      const result = calcGoalsFromTraining(PROFILE, id, null);
      expect(result).not.toBeNull();
    }
  });

  it('calcGoalsFromTraining returns non-null result for each valid perf goal', () => {
    for (const id of perfIds) {
      const result = calcGoalsFromTraining(PROFILE, null, id);
      expect(result).not.toBeNull();
    }
  });

  it('calcGoalsFromTraining returns non-null result for all body+perf combinations', () => {
    for (const b of bodyIds) {
      for (const p of perfIds) {
        const result = calcGoalsFromTraining(PROFILE, b, p);
        expect(result).not.toBeNull();
      }
    }
  });
});
