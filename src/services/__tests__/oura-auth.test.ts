/**
 * oura-auth.test.ts
 *
 * Oura token lifecycle through the production paths in oura.ts:
 * getOuraToken → loadOuraTrends/fetchOuraWeekly/fetchOuraDaily → ouraGet →
 * refresh via the oura-token-exchange Edge Function.
 *
 * Covers: successful refresh + rotation, concurrent requests sharing one
 * refresh, revoked credentials, transient failures with bounded retries,
 * legacy access-token-only installs, 403 vs 401, proactive expiry refresh,
 * connect storing refresh credentials, and data preservation.
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
    __store: store,
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
    getItemAsync:    jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync:    jest.fn(async (k: string, v: string) => { store.set(k, v); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import {
  clearOuraToken, fetchOuraDaily, getOuraAuthStatus, getOuraToken,
  initiateOuraConnect, loadOuraTrends, OURA_RECONNECT_KEY,
} from '../oura';

const keychain = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const EXCHANGE = 'functions/v1/oura-token-exchange';

// ── Fake network ──────────────────────────────────────────────────────────────

type ExchangeReply = { status: number; body?: any } | 'network';

/**
 * Oura data API accepts only `validTokens`; exchange replies are consumed in
 * order (last one repeats). Records every exchange request body.
 */
function network(opts: {
  validTokens: string[];
  exchange?: ExchangeReply[];
  dataStatus?: number;            // force a status for valid-token data requests
  dataNetworkFailures?: number;   // first N data requests reject
}) {
  const exchangeBodies: any[] = [];
  const dataTokens: string[] = [];
  let exchangeIdx = 0;
  let dataFailuresLeft = opts.dataNetworkFailures ?? 0;
  const valid = new Set(opts.validTokens);

  const fn = jest.fn(async (url: string, init?: any) => {
    if (url.includes(EXCHANGE)) {
      exchangeBodies.push(JSON.parse(init.body));
      const replies = opts.exchange ?? [];
      const r = replies[Math.min(exchangeIdx++, replies.length - 1)];
      if (!r || r === 'network') throw new TypeError('Network request failed');
      if (r.status === 200 && r.body?.access_token) valid.add(r.body.access_token);
      return { ok: r.status === 200, status: r.status, json: async () => r.body ?? {} };
    }
    if (dataFailuresLeft > 0) { dataFailuresLeft--; throw new TypeError('Network request failed'); }
    const token = String(init?.headers?.Authorization ?? '').replace('Bearer ', '');
    dataTokens.push(token);
    if (!valid.has(token)) return { ok: false, status: 401, json: async () => ({}) };
    if (opts.dataStatus && opts.dataStatus !== 200) {
      return { ok: false, status: opts.dataStatus, json: async () => ({}) };
    }
    const day = '2026-10-12';
    const body = url.includes('/daily_sleep?') ? { data: [{ day, score: 81 }] }
      : url.includes('/daily_readiness?') ? { data: [{ day, score: 77 }] }
      : url.includes('/sleep?') ? { data: [{ day, total_sleep_duration: 7 * 3600, average_hrv: 40 }] }
      : { data: [] };
    return { ok: true, status: 200, json: async () => body };
  });
  global.fetch = fn as any;
  return { fn, exchangeBodies, dataTokens };
}

const ROTATED = { status: 200, body: { access_token: 'T2', refresh_token: 'R2', expires_in: 86400 } };

async function connectedInstall(opts: { refresh?: string | null; expiresAt?: number | null } = {}) {
  await AsyncStorage.setItem('oura_access_token', 'T1');
  if (opts.refresh !== null) {
    keychain.set('oura_refresh_credentials', JSON.stringify({
      refreshToken: opts.refresh ?? 'R1', expiresAt: opts.expiresAt ?? null,
    }));
  }
}

const storedCreds = () => {
  const raw = keychain.get('oura_refresh_credentials');
  return raw ? JSON.parse(raw) : null;
};

let originalFetch: typeof global.fetch;
beforeAll(() => {
  jest.useFakeTimers({ advanceTimers: true });
  jest.setSystemTime(new Date('2026-10-12T12:00:00.000Z'));
  originalFetch = global.fetch;
});
afterAll(() => { jest.useRealTimers(); global.fetch = originalFetch; });
beforeEach(async () => {
  await clearOuraToken(); // resets module-level refresh state (cooldown, epoch)
  await AsyncStorage.clear();
  keychain.clear();
  jest.clearAllMocks();
});

// ── Successful refresh ────────────────────────────────────────────────────────

describe('successful refresh', () => {
  it('refreshes once on 401, retries with the new token, and stores the rotated refresh token', async () => {
    await connectedInstall();
    const net = network({ validTokens: [], exchange: [ROTATED] });

    const r = await loadOuraTrends((await getOuraToken())!, 7);

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.days[6].sleepScore).toBe(81);
    expect(net.exchangeBodies).toEqual([{ grant_type: 'refresh_token', refresh_token: 'R1' }]);
    expect(await AsyncStorage.getItem('oura_access_token')).toBe('T2');
    expect(storedCreds()).toEqual({ refreshToken: 'R2', expiresAt: Date.now() + 86400 * 1000 });
    expect(await getOuraAuthStatus()).toBe('connected');
  });

  it('never sends a client secret from the app', async () => {
    await connectedInstall();
    const net = network({ validTokens: [], exchange: [ROTATED] });
    await loadOuraTrends('T1', 7);
    expect(JSON.stringify(net.exchangeBodies)).not.toMatch(/client_secret/);
  });

  it('refreshes proactively when the stored expiry has passed', async () => {
    await connectedInstall({ expiresAt: Date.now() - 1000 });
    const net = network({ validTokens: ['T1'], exchange: [ROTATED] });
    expect(await getOuraToken()).toBe('T2');
    expect(net.exchangeBodies).toHaveLength(1);
  });

  it('does not refresh a token that is not near expiry', async () => {
    await connectedInstall({ expiresAt: Date.now() + 24 * 3600 * 1000 });
    const net = network({ validTokens: ['T1'] });
    expect(await getOuraToken()).toBe('T1');
    expect(net.exchangeBodies).toHaveLength(0);
  });
});

// ── Concurrency ───────────────────────────────────────────────────────────────

describe('concurrent requests', () => {
  it('parallel 401s across endpoints and screens share a single refresh', async () => {
    await connectedInstall();
    const net = network({ validTokens: [], exchange: [ROTATED] });

    // Trends (4 endpoints + stress) and Home (5 endpoints) at once, all with T1.
    const [trends, home] = await Promise.all([loadOuraTrends('T1', 7), fetchOuraDaily('T1')]);

    expect(trends.ok).toBe(true);
    expect(home.sleepScore).toBe(81);
    expect(net.exchangeBodies).toHaveLength(1);
  });

  it('a late 401 for an already-rotated token reuses the new token instead of spending the refresh token again', async () => {
    await connectedInstall();
    const net = network({ validTokens: [], exchange: [ROTATED, { status: 401, body: { error: 'invalid_grant' } }] });

    await loadOuraTrends('T1', 7);             // rotates T1/R1 → T2/R2
    const late = await loadOuraTrends('T1', 7); // stale caller still holding T1

    expect(late.ok).toBe(true);
    expect(net.exchangeBodies).toHaveLength(1);
    expect(await getOuraAuthStatus()).toBe('connected');
  });
});

// ── Revoked credentials ───────────────────────────────────────────────────────

describe('revoked credentials', () => {
  it('invalid_grant → reconnect_required; dead refresh token removed; app data preserved', async () => {
    await connectedInstall();
    await AsyncStorage.setItem('drink_log', '[{"date":"2026-10-11","totalDrinks":1}]');
    await AsyncStorage.setItem('meal_log', '[1]');
    const net = network({ validTokens: [], exchange: [{ status: 401, body: { error: 'invalid_grant' } }] });

    const r = await loadOuraTrends('T1', 7);

    expect(r).toEqual({ ok: false, status: 401, kind: 'reconnect_required' });
    expect(net.exchangeBodies).toHaveLength(1);             // not retried
    expect(storedCreds()).toBeNull();
    expect(await AsyncStorage.getItem(OURA_RECONNECT_KEY)).toBe('1');
    expect(await getOuraAuthStatus()).toBe('reconnect_required');
    // Connection state and user data untouched — no silent disconnect, no data loss.
    expect(await AsyncStorage.getItem('oura_access_token')).toBe('T1');
    expect(await AsyncStorage.getItem('drink_log')).toBe('[{"date":"2026-10-11","totalDrinks":1}]');
    expect(await AsyncStorage.getItem('meal_log')).toBe('[1]');
  });

  it('401 with a freshly refreshed token is reported as unauthorized without looping', async () => {
    await connectedInstall();
    // Exchange "succeeds" but Oura still rejects the new token.
    const net = network({ validTokens: [], exchange: [{ status: 200, body: { access_token: 'T2', refresh_token: 'R2' } }] });
    (global.fetch as jest.Mock).mockImplementation(async (url: string, init?: any) => {
      if (url.includes(EXCHANGE)) {
        net.exchangeBodies.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ access_token: 'T2', refresh_token: 'R2' }) };
      }
      return { ok: false, status: 401, json: async () => ({}) };
    });

    const r = await loadOuraTrends('T1', 7);
    expect(r).toEqual({ ok: false, status: 401, kind: 'unauthorized' });
    expect(net.exchangeBodies).toHaveLength(1);
  });
});

// ── Transient failures ────────────────────────────────────────────────────────

describe('transient failures', () => {
  it('refresh retries network errors (bounded) and then succeeds', async () => {
    await connectedInstall();
    const net = network({ validTokens: [], exchange: ['network', 'network', ROTATED] });
    const r = await loadOuraTrends('T1', 7);
    expect(r.ok).toBe(true);
    expect(net.exchangeBodies).toHaveLength(3);
  });

  it('refresh gives up after 3 attempts on 5xx — failure is not treated as revoked', async () => {
    await connectedInstall();
    const net = network({ validTokens: [], exchange: [{ status: 502, body: { error: 'x' } }] });
    const r = await loadOuraTrends('T1', 7);
    expect(r).toEqual({ ok: false, status: 502, kind: 'http' });
    expect(net.exchangeBodies).toHaveLength(3);
    expect(storedCreds()).toEqual({ refreshToken: 'R1', expiresAt: null }); // kept for next time
    expect(await getOuraAuthStatus()).toBe('connected');
  });

  it('a data request network blip is retried once', async () => {
    await connectedInstall();
    network({ validTokens: ['T1'], dataNetworkFailures: 2 });
    const r = await loadOuraTrends('T1', 7);
    expect(r.ok).toBe(true);
  });

  it('a persistent network failure is reported as network, not auth', async () => {
    await connectedInstall();
    global.fetch = jest.fn(async () => { throw new TypeError('Network request failed'); }) as any;
    expect(await loadOuraTrends('T1', 7)).toEqual({ ok: false, status: null, kind: 'network' });
    expect(await getOuraAuthStatus()).toBe('connected');
  });
});

// ── 403 vs 401 ────────────────────────────────────────────────────────────────

describe('403 (scope/membership)', () => {
  it('does not trigger a refresh or a reconnect flag', async () => {
    await connectedInstall();
    const net = network({ validTokens: ['T1'], dataStatus: 403 });
    expect(await loadOuraTrends('T1', 7)).toEqual({ ok: false, status: 403, kind: 'http' });
    expect(net.exchangeBodies).toHaveLength(0);
    expect(await getOuraAuthStatus()).toBe('connected');
  });
});

// ── Legacy installs (access token only) ───────────────────────────────────────

describe('legacy access-token-only installs', () => {
  it('report legacy status and keep working while the token is valid', async () => {
    await connectedInstall({ refresh: null });
    const net = network({ validTokens: ['T1'] });
    expect(await getOuraAuthStatus()).toBe('legacy_no_refresh');
    expect((await loadOuraTrends((await getOuraToken())!, 7)).ok).toBe(true);
    expect(net.exchangeBodies).toHaveLength(0);
  });

  it('on 401 cannot be recovered by refresh → reconnect_required, no exchange call', async () => {
    await connectedInstall({ refresh: null });
    await AsyncStorage.setItem('context_events', '[{"id":"e1"}]');
    const net = network({ validTokens: [] });
    expect(await loadOuraTrends('T1', 7)).toEqual({ ok: false, status: 401, kind: 'reconnect_required' });
    expect(net.exchangeBodies).toHaveLength(0);
    expect(await getOuraAuthStatus()).toBe('reconnect_required');
    expect(await AsyncStorage.getItem('context_events')).toBe('[{"id":"e1"}]');
  });

  it('reconnecting stores refresh credentials and clears the reconnect flag', async () => {
    await connectedInstall({ refresh: null });
    await AsyncStorage.setItem(OURA_RECONNECT_KEY, '1');
    (WebBrowser.openAuthSessionAsync as jest.Mock).mockResolvedValue({
      type: 'success', url: 'bellahealth://oura-callback?code=abc',
    });
    const net = network({ validTokens: [], exchange: [{ status: 200, body: { access_token: 'T9', refresh_token: 'R9', expires_in: 86400 } }] });

    expect(await initiateOuraConnect()).toBe(true);
    expect(net.exchangeBodies[0]).toMatchObject({ code: 'abc', redirect_uri: 'bellahealth://oura-callback' });
    expect(await AsyncStorage.getItem('oura_access_token')).toBe('T9');
    expect(storedCreds()?.refreshToken).toBe('R9');
    expect(await getOuraAuthStatus()).toBe('connected');
  });
});

// ── Disconnect ────────────────────────────────────────────────────────────────

describe('disconnect', () => {
  it('removes Oura credentials (incl. Keychain) and nothing else', async () => {
    await connectedInstall();
    await AsyncStorage.setItem('water_history', '[1]');
    await clearOuraToken();
    expect(await getOuraAuthStatus()).toBe('not_connected');
    expect(storedCreds()).toBeNull();
    expect(await AsyncStorage.getItem('water_history')).toBe('[1]');
  });
});
