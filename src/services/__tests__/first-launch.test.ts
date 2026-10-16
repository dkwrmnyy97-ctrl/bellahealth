/**
 * first-launch.test.ts
 *
 * Verifies that every function called during app startup returns a safe default
 * when AsyncStorage is completely empty (fresh install, no prior state).
 *
 * The contract: missing data is a valid state — never an error.
 * Run: npx jest first-launch --verbose
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MANUAL RELEASE GATE (required before every production submission)
 * ─────────────────────────────────────────────────────────────────────────────
 * Before submitting a new build to App Store Connect, verify on a real device:
 *
 *   1. Fully delete BellaHealth (Settings → General → iPhone Storage → Delete App)
 *   2. Install the new build via TestFlight or direct IPA install
 *   3. Cold-launch the app (tap icon; do NOT restore from backup)
 *   4. Do not interact — observe only
 *
 * PASS criteria:
 *   - Splash animation plays (~2.6 s)
 *   - Onboarding "Get Started" screen appears
 *   - App does not terminate, go blank, or crash-to-springboard
 *
 * FAIL action:
 *   - Capture crash log: Xcode → Devices and Simulators → View Device Logs
 *   - Filter by app name and timestamp
 *   - Do not submit the build until root cause is identified
 *
 * Validated clean on: build 90 (iPad, fresh install via Instagram bio link)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { loadContextEvents } from '../context-events';
import { buildHealthTimelineFromStorage, detectPatterns } from '../pattern-engine';

// ── Mock AsyncStorage ─────────────────────────────────────────────────────────

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// ── Mock HealthKit (not available in test environment) ────────────────────────

jest.mock('@kingstinct/react-native-healthkit', () => ({
  requestAuthorization:             jest.fn().mockResolvedValue(undefined),
  queryStatisticsForQuantity:       jest.fn().mockResolvedValue({ sumQuantity: null }),
  queryCategorySamples:             jest.fn().mockResolvedValue([]),
  getMostRecentQuantitySample:      jest.fn().mockResolvedValue(null),
  queryWorkoutSamples:              jest.fn().mockResolvedValue([]),
  getBiologicalSexAsync:            jest.fn().mockResolvedValue(null),
  getDateOfBirthAsync:              jest.fn().mockResolvedValue(null),
  BiologicalSex:                    {},
  WorkoutActivityType:              {},
}));

// ── Setup: ensure AsyncStorage is empty before each test ─────────────────────

beforeEach(async () => {
  await AsyncStorage.clear();
});

// ─── loadContextEvents ────────────────────────────────────────────────────────

describe('loadContextEvents — fresh install (no storage)', () => {
  it('returns empty array when no events have been saved', async () => {
    const events = await loadContextEvents();
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBe(0);
  });

  it('does not throw when CONTEXT_EVENTS key is absent', async () => {
    await expect(loadContextEvents()).resolves.not.toThrow();
  });
});

// ─── loadContextEvents — corrupted storage ────────────────────────────────────

describe('loadContextEvents — malformed storage', () => {
  it('throws (expected — callers must wrap in .catch)', async () => {
    await AsyncStorage.setItem('context_events', 'not valid json{{');
    // loadContextEvents does not guard internally — callers catch it
    await expect(loadContextEvents()).rejects.toBeDefined();
  });
});

// ─── buildHealthTimelineFromStorage ──────────────────────────────────────────

describe('buildHealthTimelineFromStorage — fresh install', () => {
  it('returns empty array when all lifestyle storage keys are absent', async () => {
    const timeline = await buildHealthTimelineFromStorage();
    expect(Array.isArray(timeline)).toBe(true);
    expect(timeline.length).toBe(0);
  });

  it('does not throw on completely empty storage', async () => {
    await expect(buildHealthTimelineFromStorage()).resolves.not.toThrow();
  });

  it('returns records when only drink_log is populated', async () => {
    await AsyncStorage.setItem('drink_log', JSON.stringify([
      { date: '2026-09-20', totalDrinks: 2 },
      { date: '2026-09-21', totalDrinks: 0 },
    ]));
    const timeline = await buildHealthTimelineFromStorage();
    expect(timeline.length).toBeGreaterThan(0);
    const day = timeline.find(d => d.date === '2026-09-20');
    expect(day?.totalAlcoholDrinks).toBe(2);
  });

  it('survives corrupted JSON in any storage key without crashing', async () => {
    await AsyncStorage.setItem('drink_log',             'CORRUPTED{{');
    await AsyncStorage.setItem('caffeine_history',      'CORRUPTED{{');
    await AsyncStorage.setItem('wellness_sessions_history', 'CORRUPTED{{');
    const timeline = await buildHealthTimelineFromStorage();
    // Partial failure — returns whatever was built before the error
    expect(Array.isArray(timeline)).toBe(true);
  });
});

// ─── First-launch computed state ─────────────────────────────────────────────

describe('DEFAULT_HEALTH equivalent — fresh install computed values', () => {
  it('buildHealthTimelineFromStorage returns [] with no drink log → detectPatterns safe', async () => {
    const timeline = await buildHealthTimelineFromStorage();
    // detectPatterns on empty timeline must not throw
    expect(() => detectPatterns([])).not.toThrow();
    expect(detectPatterns(timeline)).toEqual([]);
  });

  it('loadContextEvents returns [] → analyzeEventWindow never called on fresh install', async () => {
    const events = await loadContextEvents();
    // No events → no windows analyzed → context engine has nothing to crash on
    expect(events).toEqual([]);
  });
});
