/**
 * oura-trends.test.ts
 *
 * Trends weekly data path: loadOuraTrends() → fetchOuraWeekly() → ouraGet(),
 * with mocked Oura responses. Distinguishes a populated week, a failed fetch,
 * a partial endpoint failure, and legitimately missing days.
 *
 * Clock: Mon 2026-10-12, so the 7-day window is Tue Oct 6 → Mon Oct 12.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('expo-crypto', () => ({
  getRandomBytesAsync: jest.fn(() => Promise.resolve(new Uint8Array(32))),
  digestStringAsync:   jest.fn(() => Promise.resolve('mock-digest==')),
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  CryptoEncoding:        { BASE64: 'BASE64' },
}));
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
    getItemAsync:    jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync:    jest.fn(async (k: string, v: string) => { store.set(k, v); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});

import { fetchOuraWeekly, loadOuraTrends } from '../oura';

const TOKEN = 'test-token';
const WEEK = ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12'];
const LABELS = ['Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon'];

type Endpoint = 'daily_sleep' | 'daily_readiness' | 'sleep' | 'daily_activity' | 'daily_stress';
type Response = { data: any[] } | { status: number } | 'network';

function mockOura(responses: Partial<Record<Endpoint, Response>>): jest.Mock {
  const order: Endpoint[] = ['daily_sleep', 'daily_readiness', 'daily_activity', 'daily_stress', 'sleep'];
  return jest.fn((url: string) => {
    const key = order.find(k => url.includes(`/${k}?`));
    const r = (key && responses[key]) ?? { data: [] };
    if (r === 'network') return Promise.reject(new TypeError('Network request failed'));
    if ('status' in r) return Promise.resolve({ ok: false, status: r.status, json: () => Promise.resolve({}) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve(r) });
  });
}

const session = (day: string, hours: number) => ({
  day, total_sleep_duration: hours * 3600, average_hrv: 40,
  bedtime_start: `${day}T05:00:00+00:00`, bedtime_end: `${day}T05:00:00+00:00`,
});

const FULL_WEEK: Partial<Record<Endpoint, Response>> = {
  daily_sleep:     { data: WEEK.map((day, i) => ({ day, score: 70 + i })) },
  daily_readiness: { data: WEEK.map(day => ({ day, score: 80 })) },
  daily_activity:  { data: WEEK.map(day => ({ day, steps: 5000, active_calories: 300 })) },
  sleep:           { data: WEEK.map((day, i) => session(day, 6 + i * 0.5)) },
};

let originalFetch: typeof global.fetch;
beforeAll(() => {
  // advanceTimers: lets the bounded retry delays elapse during the test.
  jest.useFakeTimers({ advanceTimers: true });
  jest.setSystemTime(new Date('2026-10-12T12:00:00.000Z'));
  originalFetch = global.fetch;
});
afterAll(() => { jest.useRealTimers(); global.fetch = originalFetch; });
afterEach(() => { global.fetch = originalFetch; });

describe('populated week', () => {
  it('returns all seven days Tue → Mon with sleep duration and score', async () => {
    global.fetch = mockOura(FULL_WEEK);
    const r = await loadOuraTrends(TOKEN, 7);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.days.map(d => d.date)).toEqual(WEEK);
    expect(r.days.map(d => d.dayLabel)).toEqual(LABELS);
    expect(r.days.map(d => d.sleepScore)).toEqual([70, 71, 72, 73, 74, 75, 76]);
    expect(r.days.map(d => d.sleepHours)).toEqual([6, 6.5, 7, 7.5, 8, 8.5, 9]);
  });

  it('patches only today\'s steps from the real-time source', async () => {
    global.fetch = mockOura(FULL_WEEK);
    const r = await loadOuraTrends(TOKEN, 7, () => Promise.resolve(9000));
    if (!r.ok) throw new Error('expected ok');
    expect(r.days[6].steps).toBe(9000);
    expect(r.days[5].steps).toBe(5000);
    expect(r.days[6].sleepHours).toBe(9);
  });
});

describe('failed fetch', () => {
  it('reports 401 that cannot be refreshed as a failure, not an empty week', async () => {
    global.fetch = mockOura({ daily_sleep: { status: 401 }, daily_readiness: { status: 401 }, sleep: { status: 401 }, daily_activity: { status: 401 } });
    await expect(loadOuraTrends(TOKEN, 7)).resolves.toEqual({ ok: false, status: 401, kind: 'reconnect_required' });
  });

  it('reports a network failure with null status', async () => {
    global.fetch = mockOura({ daily_sleep: 'network', daily_readiness: 'network', sleep: 'network', daily_activity: 'network' });
    await expect(loadOuraTrends(TOKEN, 7)).resolves.toEqual({ ok: false, status: null, kind: 'network' });
  });

  it('fetchOuraWeekly rejects (does not resolve zeros) when every request fails', async () => {
    global.fetch = mockOura({ daily_sleep: { status: 401 }, daily_readiness: { status: 401 }, sleep: { status: 401 }, daily_activity: { status: 401 } });
    await expect(fetchOuraWeekly(TOKEN, 7)).rejects.toMatchObject({ status: 401 });
  });

  it('keeps sleep charts when only a non-sleep endpoint fails', async () => {
    global.fetch = mockOura({ ...FULL_WEEK, daily_readiness: { status: 429 }, daily_activity: { status: 500 } });
    const r = await loadOuraTrends(TOKEN, 7);
    if (!r.ok) throw new Error('expected ok');
    expect(r.days.map(d => d.sleepScore)).toEqual([70, 71, 72, 73, 74, 75, 76]);
    expect(r.days.every(d => d.readiness === 0)).toBe(true);
  });
});

describe('legitimate missing days', () => {
  const PRESENT = new Set(['2026-10-06', '2026-10-08', '2026-10-11', '2026-10-12']);
  const sparse: Partial<Record<Endpoint, Response>> = {
    daily_sleep: { data: WEEK.filter(d => PRESENT.has(d)).map(day => ({ day, score: 80 })) },
    sleep:       { data: WEEK.filter(d => PRESENT.has(d)).map(day => session(day, 7)) },
  };

  it('still returns all seven slots; missing days carry the no-data value (0), never a fabricated or borrowed night', async () => {
    global.fetch = mockOura(sparse);
    const r = await loadOuraTrends(TOKEN, 7);
    if (!r.ok) throw new Error('expected ok');
    expect(r.days).toHaveLength(7);
    for (const d of r.days) {
      if (PRESENT.has(d.date)) {
        expect(d.sleepScore).toBe(80);
        expect(d.sleepHours).toBe(7);
      } else {
        expect(d.sleepScore).toBe(0);
      }
    }
    // Each real session is attributed to exactly one day (no double counting
    // via the ±1-day fallback), so total hours = 4 nights × 7h.
    expect(r.days.reduce((s, d) => s + d.sleepHours, 0)).toBe(28);
  });

  it('an empty Oura response is a successful empty week, distinct from a failure', async () => {
    global.fetch = mockOura({});
    const r = await loadOuraTrends(TOKEN, 7);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.days.every(d => d.sleepHours === 0 && d.sleepScore === 0)).toBe(true);
  });
});
