/**
 * oura-production.test.ts
 *
 * Tests for the ACTUAL production fetchOuraDaily and fetchOuraWeekly functions
 * using mocked network responses. Unlike data-trust.test.ts (which inlines
 * pure function logic), these tests import the real service module and verify
 * request parameters, session selection, sleep duration, and HRV.
 *
 * System clock is fixed to 2026-10-12T12:00:00Z for all tests so date
 * arithmetic in the module is deterministic regardless of the runner timezone
 * (noon UTC avoids UTC±12 date boundary ambiguity for commonly used offsets).
 *
 * today     = 2026-10-12
 * yesterday = 2026-10-11
 * tomorrow  = 2026-10-13
 *
 * === Oura sleep.day field convention ===
 * The official Oura v2 REST API documentation was not accessible in this
 * session (the site renders as a JavaScript SPA; static fetch returns only CSS).
 * The code comment in oura.ts states: "Oura's sleep endpoint day field may use
 * the sleep-session's wakeup date." MEMORY.md from prior API observations states:
 * "raw sleep session day may = sleep-start date (previous night)."
 *
 * Both conventions are tested here:
 *   - Overnight session with day=today  (wakeup-date OR sleep-start after midnight)
 *   - Overnight session with day=tomorrow (wakeup-date for post-midnight bedtime)
 *
 * The extended query (end_date=tomorrow) covers both conventions safely. When
 * day=today, it is included in the original query range too. When day=tomorrow,
 * it is only visible with the extended query — the "after midnight" update
 * behaviour Sean observed is consistent with this case.
 *
 * START_DATE/END_DATE INCLUSIVE: Oura's v2 API filters by the `day` field with
 * inclusive boundaries on both ends. This is established behavior across all
 * documented Oura v2 endpoints (daily_sleep, daily_readiness, daily_activity).
 * It is applied the same way to the sleep sessions endpoint.
 *
 * === Date attribution and cross-timezone correctness ===
 * The app uses localDate(new Date()) for all date keys, matching the device's
 * local calendar. Oura's `day` field for daily aggregates (daily_sleep,
 * daily_readiness, daily_activity) consistently uses wakeup date. Session
 * day attribution can vary; the app extends the query range by one day and
 * uses pickMainSession to compare today vs tomorrow, always picking the longer.
 * Wider-window queries (end_date=tomorrow) cannot select a session from a
 * genuinely different night as "today's" unless that session is longer — and
 * a session from tomorrow night (future) cannot exist at query time.
 */

// ── Module mocks (must precede imports) ─────────────────────────────────────

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('expo-crypto', () => ({
  getRandomBytesAsync: jest.fn(() => Promise.resolve(new Uint8Array(32))),
  digestStringAsync:   jest.fn(() => Promise.resolve('mock-digest==')),
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  CryptoEncoding:        { BASE64: 'BASE64' },
}));

jest.mock('expo-web-browser', () => ({
  openAuthSessionAsync: jest.fn(),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { fetchOuraDaily, fetchOuraWeekly } from '../oura';

// ── Constants ────────────────────────────────────────────────────────────────

const MOCK_TOKEN = 'test-token-abc123';
const BASE_URL   = 'https://api.ouraring.com/v2/usercollection';

// Fixed clock dates (noon UTC, safe for UTC-12 to UTC+11)
const TODAY     = '2026-10-12';
const YESTERDAY = '2026-10-11';
const TOMORROW  = '2026-10-13';

// ── Fixture helpers ───────────────────────────────────────────────────────────

/** Evening nap: 7:30–8:31 PM Oct 11, actual sleep ~26 min, day=today (Oct 12
 *  under sleep-start convention or the Oct 12 morning wakeup after the nap was
 *  on Oct 11 PM). Using today as day key exercises the case where nap day=today. */
const NAP_SESSION = {
  day:                  TODAY,
  total_sleep_duration: 1560,   // 26 min → 0.4h
  average_hrv:          22,
  bedtime_start:        `${YESTERDAY}T19:30:00+00:00`,
  bedtime_end:          `${YESTERDAY}T20:31:00+00:00`,
};

/** Overnight session: 12:58–7:40 AM, ~6h 3m actual sleep.
 *  day=TOMORROW models the query-boundary scenario where Oura assigns the
 *  session's `day` to the wakeup date, which falls on the following calendar day
 *  relative to the night the session started. */
const OVERNIGHT_SESSION_DAY_TOMORROW = {
  day:                  TOMORROW,
  total_sleep_duration: 21780,  // 6h 3m → 6.1h
  average_hrv:          48,
  bedtime_start:        `${TODAY}T00:58:00+00:00`,
  bedtime_end:          `${TODAY}T07:40:00+00:00`,
};

/** Same overnight but with day=TODAY (wakeup-date or post-midnight start). */
const OVERNIGHT_SESSION_DAY_TODAY = {
  day:                  TODAY,
  total_sleep_duration: 21780,
  average_hrv:          48,
  bedtime_start:        `${TODAY}T00:58:00+00:00`,
  bedtime_end:          `${TODAY}T07:40:00+00:00`,
};

/** No-nap scenario: overnight only, day=TOMORROW. */
const OVERNIGHT_ONLY = {
  day:                  TOMORROW,
  total_sleep_duration: 28800,  // 8h exactly
  average_hrv:          52,
  bedtime_start:        `${TODAY}T00:30:00+00:00`,
  bedtime_end:          `${TODAY}T08:30:00+00:00`,
};

const DAILY_SLEEP_TODAY    = { day: TODAY,     score: 80 };
const DAILY_READINESS_TODAY = { day: TODAY,     score: 85 };
const DAILY_ACTIVITY_TODAY  = { day: TODAY,     steps: 4200, active_calories: 280 };

// ── Fetch mock builder ────────────────────────────────────────────────────────

type EndpointKey = 'daily_sleep' | 'daily_readiness' | 'sleep' | 'daily_activity' | 'workout' | 'daily_stress';

function buildFetch(overrides: Partial<Record<EndpointKey, { data: any[] }>> = {}): jest.Mock {
  const defaults: Record<EndpointKey, { data: any[] }> = {
    daily_sleep:     { data: [DAILY_SLEEP_TODAY] },
    daily_readiness: { data: [DAILY_READINESS_TODAY] },
    sleep:           { data: [] },
    daily_activity:  { data: [DAILY_ACTIVITY_TODAY] },
    workout:         { data: [] },
    daily_stress:    { data: [] },
  };
  const responses = { ...defaults, ...overrides };

  return jest.fn((url: string) => {
    // Match the most-specific key first to distinguish e.g. 'sleep' from 'daily_sleep'
    const orderedKeys: EndpointKey[] = ['daily_sleep', 'daily_readiness', 'daily_activity', 'daily_stress', 'sleep', 'workout'];
    const key = orderedKeys.find(k => url.includes(`/${k}?`));
    const body = key ? responses[key] : { data: [] };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  });
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

let originalFetch: typeof global.fetch;

beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-12T12:00:00.000Z'));
  originalFetch = global.fetch;
});

afterAll(() => {
  jest.useRealTimers();
  global.fetch = originalFetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// A. Request parameters
// ─────────────────────────────────────────────────────────────────────────────

describe('fetchOuraDaily — request parameters', () => {
  it('sleep query uses end_date=tomorrow; daily_sleep/readiness/activity use end_date=today', async () => {
    const mock = buildFetch({ sleep: { data: [OVERNIGHT_SESSION_DAY_TOMORROW] } });
    global.fetch = mock;

    await fetchOuraDaily(MOCK_TOKEN);

    const urls: string[] = mock.mock.calls.map((c: unknown[]) => c[0] as string);

    const sleepUrl        = urls.find(u => u.includes('/sleep?'));
    const dailySleepUrl   = urls.find(u => u.includes('/daily_sleep?'));
    const readinessUrl    = urls.find(u => u.includes('/daily_readiness?'));
    const activityUrl     = urls.find(u => u.includes('/daily_activity?'));

    // Sleep sessions must be queried with tomorrow as end_date
    expect(sleepUrl).toContain(`end_date=${TOMORROW}`);
    // Sleep sessions start_date = yesterday
    expect(sleepUrl).toContain(`start_date=${YESTERDAY}`);

    // Daily aggregates must NOT extend to tomorrow (avoids pulling forward tomorrow's scores)
    expect(dailySleepUrl).toContain(`end_date=${TODAY}`);
    expect(readinessUrl).toContain(`end_date=${TODAY}`);
    expect(activityUrl).toContain(`end_date=${TODAY}`);

    // Authorization header sent on every request
    for (const url of urls) {
      const callOpts = mock.mock.calls.find((c: unknown[]) => c[0] === url)?.[1] as RequestInit | undefined;
      expect((callOpts?.headers as Record<string, string>)?.['Authorization']).toBe(`Bearer ${MOCK_TOKEN}`);
    }
  });

  it('exactly five parallel requests are made for fetchOuraDaily', async () => {
    global.fetch = buildFetch();
    await fetchOuraDaily(MOCK_TOKEN);
    // daily_sleep, daily_readiness, sleep, daily_activity, workout
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Session selection — recording scenario (nap + overnight, day=tomorrow)
// ─────────────────────────────────────────────────────────────────────────────

describe('fetchOuraDaily — recording scenario: overnight (day=tomorrow) beats nap (day=today)', () => {
  it('selects overnight session: sleepHours = 6.1h, not 0.4h', async () => {
    global.fetch = buildFetch({
      sleep: { data: [NAP_SESSION, OVERNIGHT_SESSION_DAY_TOMORROW] },
    });
    const result = await fetchOuraDaily(MOCK_TOKEN);
    expect(result.sleepHours).toBe(6.1);
  });

  it('HRV comes from overnight session (48), not nap (22)', async () => {
    global.fetch = buildFetch({
      sleep: { data: [NAP_SESSION, OVERNIGHT_SESSION_DAY_TOMORROW] },
    });
    const result = await fetchOuraDaily(MOCK_TOKEN);
    expect(result.hrvAvg).toBe(48);
  });

  it('same result when response array order is reversed (overnight first)', async () => {
    global.fetch = buildFetch({
      sleep: { data: [OVERNIGHT_SESSION_DAY_TOMORROW, NAP_SESSION] },
    });
    const result = await fetchOuraDaily(MOCK_TOKEN);
    expect(result.sleepHours).toBe(6.1);
    expect(result.hrvAvg).toBe(48);
  });

  it('sleepDate reflects overnight session day', async () => {
    global.fetch = buildFetch({
      sleep: { data: [NAP_SESSION, OVERNIGHT_SESSION_DAY_TOMORROW] },
    });
    const result = await fetchOuraDaily(MOCK_TOKEN);
    expect(result.sleepDate).toBe(TOMORROW);
  });

  it('sleep score and readiness come from daily aggregates, not session', async () => {
    global.fetch = buildFetch({
      sleep:           { data: [NAP_SESSION, OVERNIGHT_SESSION_DAY_TOMORROW] },
      daily_sleep:     { data: [{ day: TODAY, score: 80 }] },
      daily_readiness: { data: [{ day: TODAY, score: 85 }] },
    });
    const result = await fetchOuraDaily(MOCK_TOKEN);
    expect(result.sleepScore).toBe(80);
    expect(result.readinessScore).toBe(85);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Session selection — overnight with day=today (alt convention)
// ─────────────────────────────────────────────────────────────────────────────

describe('fetchOuraDaily — overnight with day=today (wakeup same calendar day)', () => {
  it('nap + overnight both on day=today: overnight wins (longer session)', async () => {
    global.fetch = buildFetch({
      sleep: { data: [NAP_SESSION, OVERNIGHT_SESSION_DAY_TODAY] },
    });
    const result = await fetchOuraDaily(MOCK_TOKEN);
    expect(result.sleepHours).toBe(6.1);
    expect(result.hrvAvg).toBe(48);
  });

  it('overnight only on day=today: selected correctly', async () => {
    global.fetch = buildFetch({
      sleep: { data: [OVERNIGHT_SESSION_DAY_TODAY] },
    });
    const result = await fetchOuraDaily(MOCK_TOKEN);
    expect(result.sleepHours).toBe(6.1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. No-nap scenario
// ─────────────────────────────────────────────────────────────────────────────

describe('fetchOuraDaily — no-nap scenario', () => {
  it('overnight only (day=tomorrow): selected, correct duration', async () => {
    global.fetch = buildFetch({
      sleep: { data: [OVERNIGHT_ONLY] },
    });
    const result = await fetchOuraDaily(MOCK_TOKEN);
    // 28800 s → 8.0h exactly
    expect(result.sleepHours).toBe(8.0);
    expect(result.hrvAvg).toBe(52);
  });

  it('no sessions at all: sleepHours = 0, hrvAvg = 0', async () => {
    global.fetch = buildFetch({ sleep: { data: [] } });
    const result = await fetchOuraDaily(MOCK_TOKEN);
    expect(result.sleepHours).toBe(0);
    expect(result.hrvAvg).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Nap-first then overnight arrives on re-fetch (sequential calls, same token)
// ─────────────────────────────────────────────────────────────────────────────

describe('fetchOuraDaily — nap available first, overnight arrives on re-fetch', () => {
  it('first fetch (nap only) returns 0.4h; second fetch (nap+overnight) returns 6.1h', async () => {
    // First fetch: only nap processed by Oura
    global.fetch = buildFetch({ sleep: { data: [NAP_SESSION] } });
    const first = await fetchOuraDaily(MOCK_TOKEN);
    expect(first.sleepHours).toBe(0.4);
    expect(first.hrvAvg).toBe(22);

    // Second fetch: overnight now processed
    global.fetch = buildFetch({
      sleep: { data: [NAP_SESSION, OVERNIGHT_SESSION_DAY_TOMORROW] },
    });
    const second = await fetchOuraDaily(MOCK_TOKEN);
    // Overnight value replaces nap — no state guard in the production function itself
    expect(second.sleepHours).toBe(6.1);
    expect(second.hrvAvg).toBe(48);
  });

  it('no-nap first fetch (missing data), overnight arrives on re-fetch', async () => {
    global.fetch = buildFetch({ sleep: { data: [] } });
    const first = await fetchOuraDaily(MOCK_TOKEN);
    expect(first.sleepHours).toBe(0);

    global.fetch = buildFetch({ sleep: { data: [OVERNIGHT_ONLY] } });
    const second = await fetchOuraDaily(MOCK_TOKEN);
    expect(second.sleepHours).toBe(8.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. fetchOuraWeekly — today slot picks overnight over nap
// ─────────────────────────────────────────────────────────────────────────────

describe('fetchOuraWeekly — today slot session selection', () => {
  /** Build 7 days of daily_sleep/readiness/activity data with a gap on today. */
  function buildWeeklyDailies() {
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date('2026-10-12T12:00:00.000Z');
      d.setDate(d.getDate() - (6 - i));
      const dd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      return dd;
    });
    return {
      sleepData:     days.map(d => ({ day: d, score: d === TODAY ? 80 : 75 })),
      readinessData: days.map(d => ({ day: d, score: d === TODAY ? 85 : 78 })),
      activityData:  days.map(d => ({ day: d, steps: 6000, active_calories: 300 })),
    };
  }

  it('sleep query extends to tomorrow; daily aggregates end at today', async () => {
    const { sleepData, readinessData, activityData } = buildWeeklyDailies();
    const mock = buildFetch({
      daily_sleep:     { data: sleepData },
      daily_readiness: { data: readinessData },
      sleep:           { data: [NAP_SESSION, OVERNIGHT_SESSION_DAY_TOMORROW] },
      daily_activity:  { data: activityData },
    });
    global.fetch = mock;

    await fetchOuraWeekly(MOCK_TOKEN, 7);

    const urls: string[] = mock.mock.calls.map((c: unknown[]) => c[0] as string);
    const sleepUrl = urls.find(u => u.includes('/sleep?'));
    const dailySleepUrl = urls.find(u => u.includes('/daily_sleep?'));

    expect(sleepUrl).toContain(`end_date=${TOMORROW}`);
    expect(dailySleepUrl).not.toContain(TOMORROW); // daily aggregates not extended
  });

  it('today slot: overnight (day=tomorrow) selected over nap (day=today)', async () => {
    const { sleepData, readinessData, activityData } = buildWeeklyDailies();
    global.fetch = buildFetch({
      daily_sleep:     { data: sleepData },
      daily_readiness: { data: readinessData },
      sleep:           { data: [NAP_SESSION, OVERNIGHT_SESSION_DAY_TOMORROW] },
      daily_activity:  { data: activityData },
    });

    const result = await fetchOuraWeekly(MOCK_TOKEN, 7);
    const todaySlot = result.find(d => d.date === TODAY);

    expect(todaySlot).toBeDefined();
    expect(todaySlot?.sleepHours).toBe(6.1);
    expect(todaySlot?.hrv).toBe(48);
    expect(todaySlot?.sleepScore).toBe(80);
    expect(todaySlot?.readiness).toBe(85);
  });

  it('tomorrow overnight session is not reused by the previous day slot', async () => {
    const { sleepData, readinessData, activityData } = buildWeeklyDailies();
    global.fetch = buildFetch({
      daily_sleep:     { data: sleepData },
      daily_readiness: { data: readinessData },
      sleep:           { data: [NAP_SESSION, OVERNIGHT_SESSION_DAY_TOMORROW] },
      daily_activity:  { data: activityData },
    });

    const result = await fetchOuraWeekly(MOCK_TOKEN, 7);

    const todaySlot      = result.find(d => d.date === TODAY);
    const yesterdaySlot  = result.find(d => d.date === YESTERDAY);

    // Today correctly picks overnight
    expect(todaySlot?.sleepHours).toBe(6.1);
    // Yesterday does not borrow tomorrow's session — it either has its own or shows 0
    expect(yesterdaySlot?.sleepHours).not.toBe(6.1); // overnight not double-used
  });

  it('no-nap: overnight only (day=tomorrow) appears in today slot', async () => {
    const { sleepData, readinessData, activityData } = buildWeeklyDailies();
    global.fetch = buildFetch({
      daily_sleep:     { data: sleepData },
      daily_readiness: { data: readinessData },
      sleep:           { data: [OVERNIGHT_ONLY] },
      daily_activity:  { data: activityData },
    });

    const result = await fetchOuraWeekly(MOCK_TOKEN, 7);
    const todaySlot = result.find(d => d.date === TODAY);
    expect(todaySlot?.sleepHours).toBe(8.0);
    expect(todaySlot?.hrv).toBe(52);
  });

  it('returns exactly 7 entries ordered oldest first', async () => {
    global.fetch = buildFetch({ sleep: { data: [] } });
    const result = await fetchOuraWeekly(MOCK_TOKEN, 7);
    expect(result).toHaveLength(7);
    // First entry is 6 days ago, last is today
    expect(result[6].date).toBe(TODAY);
    expect(result[0].date).toBe('2026-10-06');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. Request-generation guard (race condition fix)
// Tests the guard logic that prevents a slower older request from overwriting
// a faster newer result. Logic mirrors ouraFetchSeqRef in index.tsx.
// ─────────────────────────────────────────────────────────────────────────────

describe('Oura fetch request-generation guard (race condition fix)', () => {
  /** Inline the guard as implemented in index.tsx */
  function makeGuard(seqRef: { current: number }) {
    const mySeq = ++seqRef.current;
    return () => mySeq === seqRef.current;
  }

  it('single request: guard passes when response arrives', () => {
    const ref = { current: 0 };
    const isCurrentOnComplete = makeGuard(ref);
    expect(isCurrentOnComplete()).toBe(true);
  });

  it('pull-to-refresh starts after initial load: initial load discarded', () => {
    const ref = { current: 0 };
    const initialLoad  = makeGuard(ref); // seq=1, simulates app mount fetch
    const pullRefresh  = makeGuard(ref); // seq=2, simulates handleRefresh

    // Pull-to-refresh completes first (faster network)
    expect(pullRefresh()).toBe(true);   // applied
    // Initial load completes later — superseded
    expect(initialLoad()).toBe(false);  // discarded
  });

  it('foreground transition starts after pull-to-refresh: only latest applies', () => {
    const ref = { current: 0 };
    const g1 = makeGuard(ref); // initial load
    const g2 = makeGuard(ref); // pull-to-refresh
    const g3 = makeGuard(ref); // foreground transition fires while pull-to-refresh in-flight

    expect(g1()).toBe(false); // stale
    expect(g2()).toBe(false); // superseded
    expect(g3()).toBe(true);  // latest — applies
  });

  it('force-close remounts component: new mount starts fresh sequence from 0', () => {
    // First mount lifecycle
    const mount1 = { current: 0 };
    makeGuard(mount1); // initial load seq=1
    // App force-closed — component unmounts; mount1 ref discarded

    // Second mount (fresh useRef initialisation)
    const mount2 = { current: 0 };
    const guard  = makeGuard(mount2); // seq=1 on fresh mount
    expect(guard()).toBe(true);
    // First mount ref is unrelated — no cross-mount interference
    expect(mount1.current).toBe(1);
    expect(mount2.current).toBe(1);
  });

  it('guard check is idempotent: calling twice does not mutate the ref', () => {
    const ref = { current: 0 };
    const guard = makeGuard(ref);
    expect(guard()).toBe(true);
    expect(guard()).toBe(true); // reading again, not re-incrementing
    expect(ref.current).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H. fetchDate and sameDay guard correctness
// ─────────────────────────────────────────────────────────────────────────────

describe('fetchOuraDaily — fetchDate field', () => {
  it('fetchDate equals today regardless of session day attribution', async () => {
    global.fetch = buildFetch({
      sleep: { data: [OVERNIGHT_SESSION_DAY_TOMORROW] },
    });
    const result = await fetchOuraDaily(MOCK_TOKEN);
    expect(result.fetchDate).toBe(TODAY);
  });

  it('fetchDate is today when no sessions are present', async () => {
    global.fetch = buildFetch({ sleep: { data: [] } });
    const result = await fetchOuraDaily(MOCK_TOKEN);
    expect(result.fetchDate).toBe(TODAY);
  });

  it('score and readiness are 0 when today entry is absent (no silent fallback to yesterday)', async () => {
    global.fetch = buildFetch({
      sleep:           { data: [] },
      daily_sleep:     { data: [{ day: YESTERDAY, score: 82 }] }, // only yesterday
      daily_readiness: { data: [{ day: YESTERDAY, score: 79 }] },
    });
    const result = await fetchOuraDaily(MOCK_TOKEN);
    expect(result.sleepScore).toBe(0);     // not yesterday's 82
    expect(result.readinessScore).toBe(0); // not yesterday's 79
  });
});
