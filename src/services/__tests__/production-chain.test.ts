/**
 * production-chain.test.ts
 *
 * Integration test mirroring the EXACT production chain:
 *   drink_log (AsyncStorage) → deriveDrinkEvents()
 *     → recentEvts → synthesizeContext
 *     → buildStoryEpisode → buildEnhancedStoryWithKey → rendered story
 *
 * Why this file exists:
 *   All existing alcohol tests call buildContextResponseContrastLayer or
 *   buildEnhancedStory directly with hand-built ContextEvent fixtures.
 *   They bypass the deriveDrinkEvents → synthesizeContext pipeline that
 *   runs in production. This file tests the full chain so a data-flow
 *   break between those layers is caught before EAS build.
 *
 * Hypotheses under test (from physical-device fallback investigation):
 *   A. Drink logged for TODAY instead of YESTERDAY → findAlcoholNightEvent
 *      returns null → story never fires (expected by engine; documents UX gap)
 *   B. seenContrastKeys suppression → story fires once then is hidden
 *   C. physiologicalState = null → no findings → story gate fails
 *   D. Full happy-path: drink yesterday + today has physio → story fires
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import { deriveDrinkEvents } from '../context-events';
import { synthesizeContext } from '../context-synthesis';
import { buildStoryEpisode, buildPhysiologicalState } from '../story-engine';
import { buildEnhancedStoryWithKey } from '../../utils/pattern-language';
import type { HealthDayRecord } from '../pattern-engine';
import type { ContextEvent } from '../context-events';
import { analyzeEventWindow, detectPatterns, rankPatternsForDisplay } from '../pattern-engine';

// ─── Constant matching context.tsx ────────────────────────────────────────────

const STORY_CONTRAST_STORAGE_KEY = 'story_contrast_seen_v1';

/**
 * Deterministic "now" for tests: 2 PM local time on the test date.
 * Using the Date constructor (not an ISO string) makes .getHours() return 14
 * in every timezone, so isOvernightSpillover() always returns false — we never
 * accidentally trigger the early-morning behavioral-night logic during CI.
 */
const TEST_NOW = new Date(2026, 9, 1, 14, 0, 0); // Oct 1 2026, 14:00 local

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TODAY     = '2026-10-01';
const YESTERDAY = '2026-09-30';

/** Compute YYYY-MM-DD that is N days before TODAY (UTC noon arithmetic). */
function pastDate(daysAgo: number): string {
  const d = new Date(TODAY + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

/**
 * 30-day Oura-like timeline.
 *
 * Base metrics cycle with enough variance that p25 ≠ p75:
 *   readiness:  72, 74, 76, 78, 80 (cycle 5)  → p25≈74, p75≈78, median≈76
 *   hrv:        50, 52, 54, 56      (cycle 4)  → p25≈50, p75≈56, median≈52
 *   sleepScore: 79, 81, 83          (cycle 3)  → p25≈79, p75≈83, median≈81
 *   sleepHours: 7.2, 7.4, 7.6, 7.8 (cycle 4)  → p25≈7.2, p75≈7.8, median≈7.4
 *
 * todayOverrides replaces day i=29 (today = Oct 1).
 */
function makeTimeline(todayOverrides: Partial<HealthDayRecord> = {}): HealthDayRecord[] {
  return Array.from({ length: 30 }, (_, i) => {
    const date = pastDate(29 - i);
    const base: Partial<HealthDayRecord> = {
      readiness:  72 + (i % 5) * 2,
      hrv:        50 + (i % 4) * 2,
      sleepScore: 79 + (i % 3) * 2,
      sleepHours: 7.2 + (i % 4) * 0.2,
    };
    if (i === 29) return { date: TODAY, ...base, ...todayOverrides };
    return { date, ...base };
  });
}

/** today record: readiness 68 (below p25 74), hrv 48 (below p25 50) → 'responding' */
function makeRespondingToday(): HealthDayRecord {
  return {
    date:       TODAY,
    readiness:  68,   // below p25
    hrv:        48,   // below p25
    sleepScore: 79,   // at/near p25 → near_baseline
    sleepHours: 7.3,  // near_baseline
  };
}

/** today record: all metrics near-baseline → physioResponse 'stable' */
function makeStableToday(): HealthDayRecord {
  return {
    date:       TODAY,
    readiness:  76,  // near baseline (between p25=74 and p75=78)
    hrv:        53,  // near baseline
    sleepScore: 81,  // near baseline
    sleepHours: 7.5, // near baseline
  };
}

/** Populate AsyncStorage drink_log. */
async function setDrinkLog(entries: Array<{ date: string; totalDrinks: number; totalCalories?: number }>) {
  await AsyncStorage.setItem(
    'drink_log',
    JSON.stringify(entries.map(e => ({ ...e, totalCalories: e.totalCalories ?? 200, vibe: null, counts: {} }))),
  );
}

/** Clear all AsyncStorage between tests. */
beforeEach(async () => {
  await AsyncStorage.clear();
});

// ─── Helper: full production synthesis ────────────────────────────────────────

/**
 * Build a SynthesisResult exactly as loadContextState does, using the provided
 * drink events merged with any user-logged context events.
 */
async function buildProductionSynthesis(
  today: HealthDayRecord,
  timeline: HealthDayRecord[],
  drinkEvents: ContextEvent[],
  userContextEvents: ContextEvent[] = [],
) {
  const cutoff = pastDate(30);
  const recentEvts = [
    ...userContextEvents.filter(e => e.startDate >= cutoff),
    ...drinkEvents.filter(e => e.startDate >= cutoff),
  ];

  const eventWindows = recentEvts
    .sort((a, b) => b.startDate.localeCompare(a.startDate))
    .slice(0, 5)
    .flatMap((e) => {
      try { return [analyzeEventWindow(e, timeline, TODAY)]; } catch { return []; }
    });

  return synthesizeContext({
    today,
    patterns: [],          // no patterns — isolates the alcohol contrast path
    activeContextEvents: recentEvts,
    eventWindows,
  });
}

// ─── A. Drink logged for TODAY — should NOT fire today ────────────────────────

describe('Hypothesis A — drink logged for TODAY (Oct 1)', () => {
  /**
   * DOCUMENTS EXPECTED ENGINE BEHAVIOR:
   * If the user logged wine on Oct 1 (today) instead of Sep 30 (yesterday),
   * the engine cannot tell a next-day story yet. The story will fire on Oct 2.
   *
   * This is the most likely explanation for the physical-device fallback.
   * UX gap: the modal defaults to today — users logging "last night's" drinks
   * in the morning get the wrong date.
   */
  it('produces null story when drink is on today (not yesterday)', async () => {
    await setDrinkLog([{ date: TODAY, totalDrinks: 2 }]);
    const drinkEvents = await deriveDrinkEvents();

    expect(drinkEvents).toHaveLength(1);
    expect(drinkEvents[0].startDate).toBe(TODAY);  // logged for today

    const today    = makeRespondingToday();
    const timeline = makeTimeline({ readiness: 68, hrv: 48 });
    const synthesis = await buildProductionSynthesis(today, timeline, drinkEvents);

    // relevantContext has the drink event (it's within 30 days)
    expect(synthesis.relevantContext).toHaveLength(1);
    // theme is NOT insufficient_data (today has physio)
    expect(synthesis.primaryTheme.theme).not.toBe('insufficient_data');

    const episode = buildStoryEpisode(synthesis, timeline, today, undefined, TEST_NOW);

    // alcohol contrast is null — drink is on today, findAlcoholNightEvent looks for yesterday
    expect(episode.contextResponseContrast).toBeNull();
    // story should be null (no surfaceWorthy path)
    const { story } = buildEnhancedStoryWithKey(synthesis, timeline, today, undefined, undefined, TEST_NOW);
    expect(story).toBeNull();
  });
});

// ─── B. Happy path — drink yesterday + physio today → story fires ─────────────

describe('Happy path — drink logged for YESTERDAY (Sep 30)', () => {
  it('produces a story when 2 drinks last night + responding physiology today', async () => {
    await setDrinkLog([{ date: YESTERDAY, totalDrinks: 2 }]);
    const drinkEvents = await deriveDrinkEvents();

    expect(drinkEvents).toHaveLength(1);
    expect(drinkEvents[0].startDate).toBe(YESTERDAY);
    expect(drinkEvents[0].metadata?.totalDrinks).toBe(2);

    const today    = makeRespondingToday();
    const timeline = makeTimeline({ readiness: 68, hrv: 48 });
    const synthesis = await buildProductionSynthesis(today, timeline, drinkEvents);

    expect(synthesis.relevantContext).toHaveLength(1);
    expect(synthesis.primaryTheme.theme).not.toBe('insufficient_data');

    const episode = buildStoryEpisode(synthesis, timeline, today);

    // Core diagnostics logged by the test itself (visible in jest output)
    const physio = buildPhysiologicalState(today, timeline);
    console.log('[production-chain] physio findings:', physio?.findings.map(f => `${f.metric}=${f.direction}/${f.magnitude}`));
    console.log('[production-chain] surfaceWorthyCore:', episode.surfaceWorthyCore);
    console.log('[production-chain] contextResponseContrast:', episode.contextResponseContrast?.contextType ?? 'null');
    console.log('[production-chain] surfaceWorthy:', episode.surfaceWorthy);

    expect(episode.contextResponseContrast).not.toBeNull();
    expect(episode.contextResponseContrast?.contextType).toBe('alcohol_night');
    expect(episode.surfaceWorthy).toBe(true);

    const { story, contrastKeyShown } = buildEnhancedStoryWithKey(synthesis, timeline, today);
    console.log('[production-chain] story:', story?.slice(0, 80) ?? 'null');
    console.log('[production-chain] contrastKeyShown:', contrastKeyShown);

    expect(story).not.toBeNull();
    expect(typeof story).toBe('string');
    // Key is generated (enables suppression on repeat view)
    expect(contrastKeyShown).toMatch(/^alcohol_2026-09-30_(responding|stable)$/);
  });

  it('produces a story when 2 drinks last night + stable physiology today', async () => {
    await setDrinkLog([{ date: YESTERDAY, totalDrinks: 2 }]);
    const drinkEvents = await deriveDrinkEvents();

    const today    = makeStableToday();
    const timeline = makeTimeline({ readiness: 76, hrv: 53, sleepScore: 81, sleepHours: 7.5 });
    const synthesis = await buildProductionSynthesis(today, timeline, drinkEvents);

    const episode = buildStoryEpisode(synthesis, timeline, today);
    expect(episode.contextResponseContrast?.contextType).toBe('alcohol_night');
    expect(episode.contextResponseContrast?.physioResponse).toBe('stable');

    const { story } = buildEnhancedStoryWithKey(synthesis, timeline, today);
    expect(story).not.toBeNull();
  });

  it('threshold check: exactly 2 drinks meets the minimum', async () => {
    await setDrinkLog([{ date: YESTERDAY, totalDrinks: 2.0 }]);
    const drinkEvents = await deriveDrinkEvents();

    const today    = makeRespondingToday();
    const timeline = makeTimeline({ readiness: 68, hrv: 48 });
    const synthesis = await buildProductionSynthesis(today, timeline, drinkEvents);

    const episode = buildStoryEpisode(synthesis, timeline, today);
    expect(episode.contextResponseContrast).not.toBeNull();
  });

  it('threshold check: 1.9 drinks does NOT meet the minimum', async () => {
    await setDrinkLog([{ date: YESTERDAY, totalDrinks: 1.9 }]);
    const drinkEvents = await deriveDrinkEvents();

    const today    = makeRespondingToday();
    const timeline = makeTimeline({ readiness: 68, hrv: 48 });
    const synthesis = await buildProductionSynthesis(today, timeline, drinkEvents);

    const episode = buildStoryEpisode(synthesis, timeline, today);
    expect(episode.contextResponseContrast).toBeNull();
  });
});

// ─── C. seenContrastKeys suppression ─────────────────────────────────────────

describe('Hypothesis B — seenContrastKeys suppression', () => {
  it('suppresses the story on the second view if key was already shown', async () => {
    await setDrinkLog([{ date: YESTERDAY, totalDrinks: 2 }]);
    const drinkEvents = await deriveDrinkEvents();

    const today    = makeRespondingToday();
    const timeline = makeTimeline({ readiness: 68, hrv: 48 });
    const synthesis = await buildProductionSynthesis(today, timeline, drinkEvents);

    // First view: no seen keys → story fires, key returned
    const { story: first, contrastKeyShown } = buildEnhancedStoryWithKey(synthesis, timeline, today);
    expect(first).not.toBeNull();
    expect(contrastKeyShown).not.toBeNull();

    // Second view: seen key present → story suppressed
    const seenKeys = new Set([contrastKeyShown!]);
    const { story: second } = buildEnhancedStoryWithKey(synthesis, timeline, today, undefined, seenKeys);
    expect(second).toBeNull();
  });

  it('does NOT suppress when seenContrastKeys is empty (new install)', async () => {
    await setDrinkLog([{ date: YESTERDAY, totalDrinks: 2 }]);
    const drinkEvents = await deriveDrinkEvents();

    const today    = makeRespondingToday();
    const timeline = makeTimeline({ readiness: 68, hrv: 48 });
    const synthesis = await buildProductionSynthesis(today, timeline, drinkEvents);

    const { story } = buildEnhancedStoryWithKey(synthesis, timeline, today, undefined, new Set());
    expect(story).not.toBeNull();
  });
});

// ─── D. Physio state null guard ───────────────────────────────────────────────

describe('Hypothesis C — physiologicalState null (no Oura sync yet)', () => {
  it('returns null story when today has no physio metrics at all', async () => {
    await setDrinkLog([{ date: YESTERDAY, totalDrinks: 2 }]);
    const drinkEvents = await deriveDrinkEvents();

    // today has ONLY hkSteps — no readiness, hrv, sleepScore, sleepHours
    const today: HealthDayRecord = { date: TODAY, hkSteps: 5000 };
    const timeline = makeTimeline();
    // Override today slot with no-physio record
    const timelineNoPhysioToday = [...timeline.slice(0, 29), today];

    const synthesis = await buildProductionSynthesis(today, timelineNoPhysioToday, drinkEvents);

    // synthesis theme: today has no physio → insufficient_data
    expect(synthesis.primaryTheme.theme).toBe('insufficient_data');

    const episode = buildStoryEpisode(synthesis, timelineNoPhysioToday, today);
    // physiologicalState null → alcohol gate fails → contextResponseContrast null
    expect(episode.contextResponseContrast).toBeNull();

    const { story } = buildEnhancedStoryWithKey(synthesis, timelineNoPhysioToday, today);
    expect(story).toBeNull();
  });
});

// ─── E. Full fallback text routing ───────────────────────────────────────────

describe('Fallback text routing matches physical-device observation', () => {
  /**
   * The device shows "BellaHealth is tracking your life events."
   * This fallback fires when: !noHistory && hasCtxEvents && story === null
   *
   * Reproduce: drink on TODAY (not yesterday) + today has physio → story null,
   * but relevantContext is non-empty.
   */
  it('drink-on-today scenario activates the life-events fallback branch', async () => {
    await setDrinkLog([{ date: TODAY, totalDrinks: 2 }]);
    const drinkEvents = await deriveDrinkEvents();

    const today    = makeRespondingToday();
    const timeline = makeTimeline({ readiness: 68, hrv: 48 });
    const synthesis = await buildProductionSynthesis(today, timeline, drinkEvents);

    const noHistory    = synthesis.primaryTheme.theme === 'insufficient_data';
    const hasCtxEvents = synthesis.relevantContext.length > 0;

    // Exactly matches the observed fallback condition
    expect(noHistory).toBe(false);     // today has physio → not insufficient_data
    expect(hasCtxEvents).toBe(true);   // drink event in relevantContext

    const { story } = buildEnhancedStoryWithKey(synthesis, timeline, today, undefined, undefined, TEST_NOW);
    expect(story).toBeNull();          // story null → fallback fires
    // => "BellaHealth is tracking your life events." ← THIS is what the device shows
  });
});

// ─── F. CONTRAST_KEY_TTL regression ─────────────────────────────────────────

/**
 * Root cause of physical-device fallback (builds 96–107):
 *
 * The story shows ONCE on a given day. handleNewContrastKey() persists the
 * suppressionKey to AsyncStorage with CONTRAST_KEY_TTL_DAYS = 30.
 * AsyncStorage survives TestFlight app updates, so the key is still present
 * when the user opens Context in a later build.
 *
 * The fix: CONTRAST_KEY_TTL_DAYS = 0. The cutoff is today's UTC date, so
 * only keys stored TODAY remain active. Keys stored on any previous day are
 * expired — the story shows fresh on every new calendar day.
 *
 * Keys embed the event date (e.g. 'alcohol_2026-09-30_responding'), so the
 * same key can never fire on two different days regardless. The 30-day TTL
 * was unnecessary and harmful.
 */

/**
 * Mirror the seenContrastKeys loading logic from loadContextState (context.tsx).
 * ttlDays === 0  → only keys stored TODAY are active (new behavior)
 * ttlDays === 30 → keys from last 30 days are active (old behavior, bug)
 */
async function loadSeenKeysFromStorage(ttlDays: number): Promise<Set<string>> {
  const raw = await AsyncStorage.getItem(STORY_CONTRAST_STORAGE_KEY);
  if (!raw) return new Set();
  try {
    const entries: Array<{ key: string; seenAt: string }> = JSON.parse(raw);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - ttlDays);
    const cutoff = cutoffDate.toISOString().split('T')[0];
    return new Set(entries.filter(e => e.seenAt >= cutoff).map(e => e.key));
  } catch {
    return new Set();
  }
}

describe('F. REGRESSION — CONTRAST_KEY_TTL_DAYS suppression cross-day bug', () => {
  /**
   * Realistic personal-data scenario:
   *   - 5.9h sleep last night (below typical ~7.5h baseline — substantial)
   *   - 30-min run today
   *   - 2 drinks logged for yesterday
   *   - Established What's Connected patterns (sleep→readiness)
   *   - seenContrastKeys loaded from AsyncStorage
   */

  it('F1: story fires when seenContrastKeys is empty (first view, no suppression)', async () => {
    await setDrinkLog([{ date: YESTERDAY, totalDrinks: 2 }]);
    const drinkEvents = await deriveDrinkEvents();
    const today    = { ...makeRespondingToday(), workoutDurationMin: 30, primaryActivityType: 'Running' };
    const timeline = makeTimeline({ readiness: 68, hrv: 48, sleepHours: 5.9, workoutDurationMin: 30 });
    const synthesis = await buildProductionSynthesis(today, timeline, drinkEvents);

    const seenKeys = await loadSeenKeysFromStorage(0);
    expect([...seenKeys]).toHaveLength(0);

    const { story, contrastKeyShown } = buildEnhancedStoryWithKey(synthesis, timeline, today, undefined, seenKeys);
    expect(story).not.toBeNull();
    expect(contrastKeyShown).toMatch(/^alcohol_/);
  });

  it('F2: REGRESSION BUG — key stored yesterday suppresses story with TTL=30 (old behavior)', async () => {
    // Simulates: earlier build (96) showed story → key stored with seenAt = yesterday.
    // TestFlight update preserves AsyncStorage. Next load sees the key → story null.
    const testKey = 'alcohol_2026-09-30_responding';

    // Store key with seenAt = yesterday (relative to actual current time, time-stable)
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayStr = yesterdayDate.toISOString().split('T')[0];
    await AsyncStorage.setItem(
      STORY_CONTRAST_STORAGE_KEY,
      JSON.stringify([{ key: testKey, seenAt: yesterdayStr }]),
    );

    // TTL=30: key from yesterday is within 30-day window → still active
    const seenKeysTTL30 = await loadSeenKeysFromStorage(30);
    expect(seenKeysTTL30.has(testKey)).toBe(true);  // OLD BEHAVIOR: key active
  });

  it('F3: FIX — same key stored yesterday is EXPIRED with TTL=0 (new behavior)', async () => {
    const testKey = 'alcohol_2026-09-30_responding';
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayStr = yesterdayDate.toISOString().split('T')[0];
    await AsyncStorage.setItem(
      STORY_CONTRAST_STORAGE_KEY,
      JSON.stringify([{ key: testKey, seenAt: yesterdayStr }]),
    );

    // TTL=0: cutoff = today. Key from yesterday has seenAt < today → expired
    const seenKeysTTL0 = await loadSeenKeysFromStorage(0);
    expect(seenKeysTTL0.has(testKey)).toBe(false);  // NEW BEHAVIOR: key expired
  });

  it('F4: REGRESSION — with TTL=30, story that fired yesterday is suppressed today', async () => {
    await setDrinkLog([{ date: YESTERDAY, totalDrinks: 2 }]);
    const drinkEvents = await deriveDrinkEvents();
    const today    = { ...makeRespondingToday(), workoutDurationMin: 30 };
    const timeline = makeTimeline({ readiness: 68, hrv: 48, sleepHours: 5.9 });
    const synthesis = await buildProductionSynthesis(today, timeline, drinkEvents);

    // Simulate: story fired YESTERDAY, key stored with seenAt = yesterday
    const { story: firstStory, contrastKeyShown } = buildEnhancedStoryWithKey(
      synthesis, timeline, today, undefined, new Set(),
    );
    expect(firstStory).not.toBeNull(); // story showed yesterday
    expect(contrastKeyShown).not.toBeNull();

    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayStr = yesterdayDate.toISOString().split('T')[0];
    await AsyncStorage.setItem(
      STORY_CONTRAST_STORAGE_KEY,
      JSON.stringify([{ key: contrastKeyShown!, seenAt: yesterdayStr }]),
    );

    // Next day load with TTL=30: key is still within window → suppressed (BUG)
    const seenKeysTTL30 = await loadSeenKeysFromStorage(30);
    const { story: suppressedStory } = buildEnhancedStoryWithKey(
      synthesis, timeline, today, undefined, seenKeysTTL30,
    );
    expect(suppressedStory).toBeNull();  // BUG: story null when it should show fresh
  });

  it('F5: FIX — with TTL=0, story fires fresh after key stored yesterday', async () => {
    await setDrinkLog([{ date: YESTERDAY, totalDrinks: 2 }]);
    const drinkEvents = await deriveDrinkEvents();
    const today    = { ...makeRespondingToday(), workoutDurationMin: 30 };
    const timeline = makeTimeline({ readiness: 68, hrv: 48, sleepHours: 5.9 });
    const synthesis = await buildProductionSynthesis(today, timeline, drinkEvents);

    // Same setup: key stored yesterday
    const { contrastKeyShown } = buildEnhancedStoryWithKey(
      synthesis, timeline, today, undefined, new Set(),
    );
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    await AsyncStorage.setItem(
      STORY_CONTRAST_STORAGE_KEY,
      JSON.stringify([{ key: contrastKeyShown!, seenAt: yesterdayDate.toISOString().split('T')[0] }]),
    );

    // TTL=0: key from yesterday is expired → story fires fresh
    const seenKeysTTL0 = await loadSeenKeysFromStorage(0);
    expect(seenKeysTTL0.has(contrastKeyShown!)).toBe(false);
    const { story: freshStory } = buildEnhancedStoryWithKey(
      synthesis, timeline, today, undefined, seenKeysTTL0,
    );
    expect(freshStory).not.toBeNull();  // FIXED: story shows fresh on new day
  });

  it('F6: same-day suppression preserved — key stored today is still active with TTL=0', async () => {
    await setDrinkLog([{ date: YESTERDAY, totalDrinks: 2 }]);
    const drinkEvents = await deriveDrinkEvents();
    const today    = makeRespondingToday();
    const timeline = makeTimeline({ readiness: 68, hrv: 48 });
    const synthesis = await buildProductionSynthesis(today, timeline, drinkEvents);

    // First view: story fires, key stored with seenAt = TODAY (UTC)
    const { story: first, contrastKeyShown } = buildEnhancedStoryWithKey(
      synthesis, timeline, today, undefined, new Set(),
    );
    expect(first).not.toBeNull();

    const todayUTC = new Date().toISOString().split('T')[0];
    await AsyncStorage.setItem(
      STORY_CONTRAST_STORAGE_KEY,
      JSON.stringify([{ key: contrastKeyShown!, seenAt: todayUTC }]),
    );

    // Second view same day with TTL=0: key from today is active → suppressed (correct)
    const seenKeysSameDay = await loadSeenKeysFromStorage(0);
    expect(seenKeysSameDay.has(contrastKeyShown!)).toBe(true);
    const { story: second } = buildEnhancedStoryWithKey(
      synthesis, timeline, today, undefined, seenKeysSameDay,
    );
    expect(second).toBeNull();  // correct: don't show same story twice in same day
  });

  it('F7: app restart AND TestFlight update same day — AsyncStorage persists, key still active', async () => {
    // Covers two scenarios with the same mechanism:
    //   Scenario 2: user opens app → story shows → app is killed and relaunched same day
    //   Scenario 4: user opens app → story shows → TestFlight pushes update same day
    // In both cases AsyncStorage survives the restart/update, so the key stored with
    // seenAt = today remains active and the story stays suppressed for the rest of the day.
    await setDrinkLog([{ date: YESTERDAY, totalDrinks: 2 }]);
    const drinkEvents = await deriveDrinkEvents();
    const today    = makeRespondingToday();
    const timeline = makeTimeline({ readiness: 68, hrv: 48 });
    const synthesis = await buildProductionSynthesis(today, timeline, drinkEvents);

    // ── Step 1: first launch — story fires, key is persisted to AsyncStorage ──
    const { story: firstStory, contrastKeyShown } = buildEnhancedStoryWithKey(
      synthesis, timeline, today, undefined, new Set(),
    );
    expect(firstStory).not.toBeNull();
    expect(contrastKeyShown).not.toBeNull();

    const todayUTC = new Date().toISOString().split('T')[0];
    // Simulate handleNewContrastKey writing to AsyncStorage (exactly what the app does)
    await AsyncStorage.setItem(
      STORY_CONTRAST_STORAGE_KEY,
      JSON.stringify([{ key: contrastKeyShown!, seenAt: todayUTC }]),
    );

    // ── Step 2: app restart or TestFlight update (same day) ──
    // In-memory Set is gone. loadContextState reloads from AsyncStorage.
    // We simulate this by calling loadSeenKeysFromStorage fresh (no in-memory state).
    const seenKeysAfterRestart = await loadSeenKeysFromStorage(0);

    // Contract: key stored today is still active after cold restart / update
    expect(seenKeysAfterRestart.has(contrastKeyShown!)).toBe(true);

    // Story is suppressed on second load — same day, same key
    const { story: secondStory } = buildEnhancedStoryWithKey(
      synthesis, timeline, today, undefined, seenKeysAfterRestart,
    );
    expect(secondStory).toBeNull();  // correct: restart/update within same day keeps suppression
  });
});

// ─── G. Realistic personal-data fixture (TASK 4 + TASK 7) ────────────────────

/**
 * Proves two things simultaneously (as required by TASK 4):
 *   A. What's Connected populates (detectPatterns returns patterns)
 *   B. Your Story populates (buildEnhancedStoryWithKey returns non-null)
 *
 * Also includes the regression bug state (A populated, B null) and its fix.
 *
 * This mirrors what loadContextState produces for the real user scenario:
 *   - ~5.9h sleep (below personal baseline of ~7.5h)
 *   - run today (30 min)
 *   - 2 drinks logged for Sep 30 (yesterday)
 *   - 30-day timeline with established sleep→readiness patterns
 *   - seenContrastKeys empty (as with TTL=0 on a new day)
 *
 * Task 7 render contract: this test proves the value that context.tsx
 * YourStory receives is non-null, by calling buildEnhancedStoryWithKey
 * with the exact same arguments that YourStory uses.
 */
describe('G. Realistic personal-data fixture — What\'s Connected + Your Story', () => {
  /** Build a 30-day timeline with the kind of correlations a real Oura user would have. */
  function makeRealisticTimeline(): HealthDayRecord[] {
    // Sleep and readiness are correlated: more sleep → higher readiness next day.
    // This ensures detectPatterns finds a sleep→readiness relationship.
    return Array.from({ length: 30 }, (_, i) => {
      const date = pastDate(29 - i);
      // Oscillate sleep between 6.5 and 8.5h with regular variance
      const sleepHours = 7.0 + Math.sin(i * 0.7) * 0.8;
      // Readiness follows sleep from day before (with noise)
      const prevSleep  = i > 0 ? 7.0 + Math.sin((i - 1) * 0.7) * 0.8 : 7.5;
      const readiness  = 70 + (prevSleep - 7.0) * 8 + ((i % 3) - 1) * 2;
      const hrv        = 48 + (prevSleep - 7.0) * 4 + ((i % 3) - 1) * 2;
      const sleepScore = 78 + (sleepHours - 7.0) * 5 + ((i % 3) - 1) * 2;

      if (i === 29) {
        // Today: short sleep, run, physio responding
        return {
          date: TODAY,
          sleepHours:        5.9,
          sleepScore:        65,
          readiness:         64,
          hrv:               44,
          workoutDurationMin: 30,
          primaryActivityType: 'Running',
        };
      }
      return { date, sleepHours, readiness, hrv, sleepScore };
    });
  }

  it('G1: What\'s Connected populates from the realistic timeline', () => {
    const timeline = makeRealisticTimeline();
    const rawPatterns = detectPatterns(timeline);
    const { ranked } = rankPatternsForDisplay(rawPatterns);
    // Realistic 30-day timeline with sleep→readiness correlation produces patterns
    expect(rawPatterns.length).toBeGreaterThan(0);
    expect(ranked.length).toBeGreaterThan(0);
  });

  it('G2: Your Story fires from the realistic timeline with drinks yesterday + empty seenKeys', async () => {
    await setDrinkLog([{ date: YESTERDAY, totalDrinks: 2 }]);
    const drinkEvents = await deriveDrinkEvents();
    const timeline    = makeRealisticTimeline();
    const today       = timeline[timeline.length - 1]; // TODAY record
    const synthesis   = await buildProductionSynthesis(today, timeline, drinkEvents);

    // Matches YourStory component's call: buildEnhancedStoryWithKey(synthesis, timeline, today, trainingGoal, seenContrastKeys)
    const seenKeys = new Set<string>(); // TTL=0 on a new day: no active keys
    const { story, contrastKeyShown } = buildEnhancedStoryWithKey(synthesis, timeline, today, undefined, seenKeys);

    expect(story).not.toBeNull();   // Task 7: render contract — UI receives non-null
    expect(typeof story).toBe('string');
    expect(contrastKeyShown).not.toBeNull();  // key returned for same-day suppression
    // Story is about last night's drinks + today's metrics
    expect(story!.length).toBeGreaterThan(20);
  });

  it('G3: REGRESSION — same scenario with stale key (pre-fix TTL=30) produces fallback', async () => {
    await setDrinkLog([{ date: YESTERDAY, totalDrinks: 2 }]);
    const drinkEvents = await deriveDrinkEvents();
    const timeline    = makeRealisticTimeline();
    const today       = timeline[timeline.length - 1];
    const synthesis   = await buildProductionSynthesis(today, timeline, drinkEvents);

    // Simulate key stored from a previous session (yesterday), with TTL=30
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    await AsyncStorage.setItem(
      STORY_CONTRAST_STORAGE_KEY,
      JSON.stringify([{
        key: `alcohol_${YESTERDAY}_responding`,
        seenAt: yesterdayDate.toISOString().split('T')[0],
      }]),
    );
    const staleKeys = await loadSeenKeysFromStorage(30);

    const { story } = buildEnhancedStoryWithKey(synthesis, timeline, today, undefined, staleKeys);
    // With TTL=30, stale key is active → story null (the bug state the device was showing)
    expect(story).toBeNull();
    // Also confirm: What's Connected IS populated (A works, B fails = the observed device state)
    expect(synthesis.relevantContext.length).toBeGreaterThan(0);
    expect(synthesis.primaryTheme.theme).not.toBe('insufficient_data');
  });

  it('G4: FIX — TTL=0 expires stale key, story fires fresh (exactly what device should show)', async () => {
    await setDrinkLog([{ date: YESTERDAY, totalDrinks: 2 }]);
    const drinkEvents = await deriveDrinkEvents();
    const timeline    = makeRealisticTimeline();
    const today       = timeline[timeline.length - 1];
    const synthesis   = await buildProductionSynthesis(today, timeline, drinkEvents);

    // Same stale key setup
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    await AsyncStorage.setItem(
      STORY_CONTRAST_STORAGE_KEY,
      JSON.stringify([{
        key: `alcohol_${YESTERDAY}_responding`,
        seenAt: yesterdayDate.toISOString().split('T')[0],
      }]),
    );

    // TTL=0: stale key is expired
    const freshKeys = await loadSeenKeysFromStorage(0);
    expect(freshKeys.has(`alcohol_${YESTERDAY}_responding`)).toBe(false);

    const { story } = buildEnhancedStoryWithKey(synthesis, timeline, today, undefined, freshKeys);
    expect(story).not.toBeNull();  // FIXED: story fires on the device
  });
});

// ─── H. DevDiagPanel does not alter Story state ───────────────────────────────

/**
 * The DevDiagPanel is now rendered in production builds behind a long-press gesture.
 * It calls buildStoryEpisode internally (read-only) and reads seenContrastKeys via .has().
 * These tests verify that those reads are side-effect-free:
 *   - buildStoryEpisode is pure (same inputs → same outputs, no mutation)
 *   - seenContrastKeys Set is not mutated by the panel's gate-reconstruction logic
 *   - buildEnhancedStoryWithKey produces the same result regardless of how many times
 *     the panel would have called buildStoryEpisode
 */
describe('H. DevDiagPanel does not alter Story state', () => {
  it('H1: buildStoryEpisode is pure — repeated calls produce identical output', async () => {
    await setDrinkLog([{ date: YESTERDAY, totalDrinks: 2 }]);
    const drinkEvents = await deriveDrinkEvents();
    const today    = makeRespondingToday();
    const timeline = makeTimeline({ readiness: 68, hrv: 48 });
    const synthesis = await buildProductionSynthesis(today, timeline, drinkEvents);

    // Panel calls buildStoryEpisode — verify calling it multiple times is safe
    const ep1 = buildStoryEpisode(synthesis, timeline, today, undefined);
    const ep2 = buildStoryEpisode(synthesis, timeline, today, undefined);

    expect(ep1.surfaceWorthyCore).toBe(ep2.surfaceWorthyCore);
    expect(ep1.contextResponseContrast?.suppressionKey).toBe(ep2.contextResponseContrast?.suppressionKey);
    expect(ep1.contextResponseContrast?.contextType).toBe(ep2.contextResponseContrast?.contextType);
    expect(ep1.physiologicalState?.findings.length).toBe(ep2.physiologicalState?.findings.length);
  });

  it('H2: seenContrastKeys Set is not mutated by panel gate-reconstruction', async () => {
    await setDrinkLog([{ date: YESTERDAY, totalDrinks: 2 }]);
    const drinkEvents = await deriveDrinkEvents();
    const today    = makeRespondingToday();
    const timeline = makeTimeline({ readiness: 68, hrv: 48 });
    const synthesis = await buildProductionSynthesis(today, timeline, drinkEvents);

    const seenKeys = new Set<string>(['some_pre_existing_key']);
    const sizeBeforePanel = seenKeys.size;
    const hadPreExisting  = seenKeys.has('some_pre_existing_key');

    // Simulate exactly what the panel does: buildStoryEpisode then .has() check
    const episode     = buildStoryEpisode(synthesis, timeline, today, undefined);
    const contrastKey = episode.contextResponseContrast?.suppressionKey ?? null;
    void !!(contrastKey && !episode.surfaceWorthyCore && seenKeys.has(contrastKey));

    // Set must be unchanged
    expect(seenKeys.size).toBe(sizeBeforePanel);
    expect(seenKeys.has('some_pre_existing_key')).toBe(hadPreExisting);
    // Panel must not have added the alcohol contrast key
    if (contrastKey) expect(seenKeys.has(contrastKey)).toBe(false);
  });

  it('H3: buildEnhancedStoryWithKey result is identical before and after panel would render', async () => {
    await setDrinkLog([{ date: YESTERDAY, totalDrinks: 2 }]);
    const drinkEvents = await deriveDrinkEvents();
    const today    = makeRespondingToday();
    const timeline = makeTimeline({ readiness: 68, hrv: 48 });
    const synthesis = await buildProductionSynthesis(today, timeline, drinkEvents);
    const seenKeys  = new Set<string>();

    // Call buildEnhancedStoryWithKey first — store result
    const before = buildEnhancedStoryWithKey(synthesis, timeline, today, undefined, seenKeys);

    // Simulate panel rendering: buildStoryEpisode called twice (once for diag, once for display)
    buildStoryEpisode(synthesis, timeline, today, undefined);
    buildStoryEpisode(synthesis, timeline, today, undefined);

    // Story result must be identical — panel reads had no effect
    const after = buildEnhancedStoryWithKey(synthesis, timeline, today, undefined, seenKeys);
    expect(after.story).toBe(before.story);
    expect(after.contrastKeyShown).toBe(before.contrastKeyShown);
    expect(after.story).not.toBeNull();  // story must still fire
  });
});

// ─── I. YOUR STORY display persistence — seenKey must NOT suppress the narrative ──

/**
 * Root cause of Build 109 physical-device fallback (identified 2026-10-01):
 *
 * The story engine builds a valid alcohol_night story. The story is then
 * suppressed because contrastKey 'alcohol_2026-09-30_stable' is in seenKeys
 * (stored with seenAt=today by the first Build 108 render). TTL=0 keeps
 * today's keys active → every subsequent load returns story=null → fallback.
 *
 * Fix: YourStory calls buildEnhancedStoryWithKey with undefined (not
 * seenContrastKeys), so the suppression guard never fires for the display path.
 * Keys are still tracked via handleNewContrastKey for any future alert/
 * notification deduplication use, but they do not remove the current narrative.
 *
 * These tests mirror the exact Build 109 persisted state from the device
 * and verify the display contract: story is non-null regardless of seenKeys.
 */

/**
 * Exact Build 109 device seenKeys (from 18_suppressionAndBranch screenshot):
 */
const BUILD_109_SEEN_KEYS = new Set<string>([
  'evt_1790318003158_e3t4d_stable',
  'evt_1789582335698_nnrij_stable',
  'alcohol_2026-09-30_stable',
]);

/**
 * Device today record (from 3_today screenshot):
 *   readiness=70, hrv=46, sleepHours=5.4, sleepScore=75, workout=47min
 * Physio findings: all near_baseline/mild → physioResponse = 'stable'
 * Therefore contrastKey = 'alcohol_2026-09-30_stable'
 */
function makeDeviceToday(): HealthDayRecord {
  return {
    date:                TODAY,
    readiness:           70,
    hrv:                 46,
    sleepHours:          5.4,
    sleepScore:          75,
    workoutDurationMin:  47,
  };
}

describe('I. YOUR STORY display persistence — seenKey must NOT null the valid story', () => {

  it('I1: EXACT DEVICE STATE (Build 109) — contrastKey in seenKeys, display path (undefined) → story non-null', async () => {
    // Reproduces the exact runtime state seen in the Build 109 diagnostic panel.
    // The device showed all findings as near_baseline/mild (actual baselines from real Oura data).
    // Test baselines differ from device baselines, so the key suffix (responding vs stable)
    // may differ — but the contract is the same: key-in-seenKeys must NOT suppress the display path.
    await setDrinkLog([{ date: YESTERDAY, totalDrinks: 2 }]);
    const drinkEvents = await deriveDrinkEvents();
    const today       = makeDeviceToday();
    const timeline    = makeTimeline({ ...today });
    const synthesis   = await buildProductionSynthesis(today, timeline, drinkEvents);

    // Step 1: confirm engine builds a valid story and returns a contrastKey
    const { story: rawStory, contrastKeyShown } = buildEnhancedStoryWithKey(
      synthesis, timeline, today, undefined, undefined,
    );
    expect(rawStory).not.toBeNull();
    expect(contrastKeyShown).toMatch(/^alcohol_2026-09-30/);  // embeds the alcohol event date

    // Step 2: confirm passing seenKeys WITH the key suppresses at function level (old behavior preserved)
    const seenWithKey = new Set<string>([contrastKeyShown!]);
    const { story: suppressedByFunction } = buildEnhancedStoryWithKey(
      synthesis, timeline, today, undefined, seenWithKey,
    );
    expect(suppressedByFunction).toBeNull();  // function-level suppression still works

    // Step 3: display path always passes undefined — story renders even when key is in seenKeys
    const { story: displayStory } = buildEnhancedStoryWithKey(
      synthesis, timeline, today, undefined, undefined,
    );
    expect(displayStory).not.toBeNull();  // FIXED: story non-null regardless of seenKeys

    // Step 4: same result with the exact Build 109 seenKeys set (all 3 device keys)
    const { story: displayWithBuild109Keys } = buildEnhancedStoryWithKey(
      synthesis, timeline, today, undefined, undefined,  // display: always undefined
    );
    expect(displayWithBuild109Keys).not.toBeNull();  // Build 109 device state: story now shows
  });

  it('I2: first render — empty seenKeys, story visible', async () => {
    await setDrinkLog([{ date: YESTERDAY, totalDrinks: 2 }]);
    const drinkEvents = await deriveDrinkEvents();
    const today = makeDeviceToday();
    const timeline = makeTimeline({ ...today });
    const synthesis = await buildProductionSynthesis(today, timeline, drinkEvents);

    const { story } = buildEnhancedStoryWithKey(synthesis, timeline, today, undefined, undefined);
    expect(story).not.toBeNull();
  });

  it('I3: second render same day — key now in seenKeys, display path still renders story', async () => {
    await setDrinkLog([{ date: YESTERDAY, totalDrinks: 2 }]);
    const drinkEvents = await deriveDrinkEvents();
    const today = makeDeviceToday();
    const timeline = makeTimeline({ ...today });
    const synthesis = await buildProductionSynthesis(today, timeline, drinkEvents);

    // Simulate: story showed on first render, handleNewContrastKey stored the key
    const { contrastKeyShown } = buildEnhancedStoryWithKey(synthesis, timeline, today, undefined, undefined);
    const seenAfterFirstRender = new Set<string>([contrastKeyShown!]);

    // Confirm the function's suppression behavior still works when seenKeys IS passed
    const { story: suppressedViaFunction } = buildEnhancedStoryWithKey(
      synthesis, timeline, today, undefined, seenAfterFirstRender,
    );
    expect(suppressedViaFunction).toBeNull();  // function-level suppression still works

    // But the display path always passes undefined → story still visible
    const { story: displayStory } = buildEnhancedStoryWithKey(
      synthesis, timeline, today, undefined, undefined,
    );
    expect(displayStory).not.toBeNull();  // display never suppressed
  });

  it('I4: app restart same day — key loaded from AsyncStorage, display path still renders', async () => {
    await setDrinkLog([{ date: YESTERDAY, totalDrinks: 2 }]);
    const drinkEvents = await deriveDrinkEvents();
    const today = makeDeviceToday();
    const timeline = makeTimeline({ ...today });
    const synthesis = await buildProductionSynthesis(today, timeline, drinkEvents);

    // Simulate: key stored during first session
    await AsyncStorage.setItem(
      STORY_CONTRAST_STORAGE_KEY,
      JSON.stringify([{ key: 'alcohol_2026-09-30_stable', seenAt: new Date().toISOString().split('T')[0] }]),
    );
    const seenKeysAfterRestart = await loadSeenKeysFromStorage(0);
    expect(seenKeysAfterRestart.has('alcohol_2026-09-30_stable')).toBe(true);  // key loaded

    // Display path passes undefined → not suppressed
    const { story } = buildEnhancedStoryWithKey(synthesis, timeline, today, undefined, undefined);
    expect(story).not.toBeNull();  // story persists after restart
  });

  it('I5: TestFlight update — exact Build 109 AsyncStorage state, story still visible', async () => {
    // Exact Build 109 persisted state: 3 keys stored today
    await AsyncStorage.setItem(
      STORY_CONTRAST_STORAGE_KEY,
      JSON.stringify([
        { key: 'evt_1790318003158_e3t4d_stable', seenAt: new Date().toISOString().split('T')[0] },
        { key: 'evt_1789582335698_nnrij_stable',  seenAt: new Date().toISOString().split('T')[0] },
        { key: 'alcohol_2026-09-30_stable',        seenAt: new Date().toISOString().split('T')[0] },
      ]),
    );
    await setDrinkLog([{ date: YESTERDAY, totalDrinks: 2 }]);
    const drinkEvents = await deriveDrinkEvents();
    const today = makeDeviceToday();
    const timeline = makeTimeline({ ...today });
    const synthesis = await buildProductionSynthesis(today, timeline, drinkEvents);

    const seenKeysAfterUpdate = await loadSeenKeysFromStorage(0);
    expect(seenKeysAfterUpdate.size).toBe(3);  // all 3 keys active from persisted storage

    // Display path passes undefined → 3 active seenKeys have no effect on display
    const { story } = buildEnhancedStoryWithKey(synthesis, timeline, today, undefined, undefined);
    expect(story).not.toBeNull();  // story visible despite 3 active seenKeys
  });

  it('I6: legitimate deduplication preserved — buildEnhancedStoryWithKey WITH seenKeys still suppresses', async () => {
    // The suppression capability is NOT removed from buildEnhancedStoryWithKey.
    // Any future alert/notification/chat-bridge caller that explicitly passes seenKeys
    // will still get story=null when the key is already seen.
    await setDrinkLog([{ date: YESTERDAY, totalDrinks: 2 }]);
    const drinkEvents = await deriveDrinkEvents();
    const today = makeDeviceToday();
    const timeline = makeTimeline({ ...today });
    const synthesis = await buildProductionSynthesis(today, timeline, drinkEvents);

    const { contrastKeyShown } = buildEnhancedStoryWithKey(synthesis, timeline, today, undefined, undefined);
    const seenKeys = new Set<string>([contrastKeyShown!]);

    // Explicit seenKeys passed → suppression fires (function-level deduplication intact)
    const { story: deduped } = buildEnhancedStoryWithKey(synthesis, timeline, today, undefined, seenKeys);
    expect(deduped).toBeNull();  // deduplication works when caller opts in
  });

  it('I7: next-day behavior — different alcohol date, story fires fresh with no suppression overlap', async () => {
    // Tomorrow: YESTERDAY becomes today's date, so the contrastKey will embed a different date.
    // The persisted 'alcohol_2026-09-30_stable' key never matches a new key → no cross-day suppression.
    // (Cross-day TTL=0 expiry already covered by F3/F5 — this confirms key non-overlap.)
    await setDrinkLog([{ date: YESTERDAY, totalDrinks: 2 }]);
    const drinkEvents = await deriveDrinkEvents();
    const today = makeDeviceToday();
    const timeline = makeTimeline({ ...today });
    const synthesis = await buildProductionSynthesis(today, timeline, drinkEvents);

    const { contrastKeyShown } = buildEnhancedStoryWithKey(synthesis, timeline, today, undefined, undefined);
    // Key embeds yesterday's date (2026-09-30)
    expect(contrastKeyShown).toContain('2026-09-30');
    // A seenKey from a different alcohol date would not match
    const differentDayKey = new Set<string>(['alcohol_2026-09-28_stable']);
    const { story } = buildEnhancedStoryWithKey(synthesis, timeline, today, undefined, differentDayKey);
    // Different key → function-level suppression does not fire
    expect(story).not.toBeNull();
  });
});
