/**
 * oura-auth-races.test.ts
 *
 * Release checks for the Oura refresh path:
 *   - Disconnect, sign-out, or reconnect while a refresh is in flight must not
 *     restore cleared (or overwrite newer) credentials.
 *   - A failing refresh must not retry indefinitely across requests.
 * Uses the real oura.ts and the real auth.signOut().
 */

jest.mock('@supabase/supabase-js', () => {
  const auth = {
    getSession:        jest.fn(async () => ({ data: { session: null } })),
    signInAnonymously: jest.fn(async () => ({ data: { session: null }, error: null })),
    signOut:           jest.fn(async () => ({ error: null })),
  };
  return { createClient: jest.fn(() => ({ auth })) };
});
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
  clearOuraToken, getOuraAuthStatus, initiateOuraConnect, loadOuraTrends, OURA_RECONNECT_KEY,
} from '../oura';
import { signOut } from '../auth';

const keychain = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const EXCHANGE = 'functions/v1/oura-token-exchange';

type Reply = { status: number; body?: any };

/**
 * Data API accepts only tokens in `valid`. Exchange requests are answered by
 * `onExchange`, which may return a deferred promise the test resolves later.
 */
function network(onExchange: (body: any) => Promise<Reply>, valid = new Set<string>()) {
  const exchangeBodies: any[] = [];
  global.fetch = jest.fn(async (url: string, init?: any) => {
    if (url.includes(EXCHANGE)) {
      const body = JSON.parse(init.body);
      exchangeBodies.push(body);
      const r = await onExchange(body);
      if (r.status === 200 && r.body?.access_token) valid.add(r.body.access_token);
      return { ok: r.status === 200, status: r.status, json: async () => r.body ?? {} };
    }
    const token = String(init?.headers?.Authorization ?? '').replace('Bearer ', '');
    if (!valid.has(token)) return { ok: false, status: 401, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  }) as any;
  return { exchangeBodies };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

async function waitFor(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setTimeout(r, 5));
  if (!cond()) throw new Error('condition not reached');
}

async function connectedInstall() {
  await AsyncStorage.setItem('oura_access_token', 'T1');
  keychain.set('oura_refresh_credentials', JSON.stringify({ refreshToken: 'R1', expiresAt: null }));
}

const ROTATED: Reply = { status: 200, body: { access_token: 'T2', refresh_token: 'R2', expires_in: 86400 } };

let originalFetch: typeof global.fetch;
beforeAll(() => {
  jest.useFakeTimers({ advanceTimers: true });
  jest.setSystemTime(new Date('2026-10-12T12:00:00.000Z'));
  originalFetch = global.fetch;
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => { jest.useRealTimers(); global.fetch = originalFetch; });
beforeEach(async () => {
  await clearOuraToken(); // also resets module-level refresh state
  await AsyncStorage.clear();
  keychain.clear();
  jest.clearAllMocks();
});

describe('in-flight refresh vs. user actions', () => {
  it('disconnect during refresh: the refresh result is discarded and nothing is restored', async () => {
    await connectedInstall();
    const gate = deferred<Reply>();
    const net = network(() => gate.promise);

    const load = loadOuraTrends('T1', 7);
    await waitFor(() => net.exchangeBodies.length === 1);
    await clearOuraToken();
    gate.resolve(ROTATED);

    expect((await load).ok).toBe(false);
    expect(await AsyncStorage.getItem('oura_access_token')).toBeNull();
    expect(keychain.get('oura_refresh_credentials')).toBeUndefined();
    expect(await getOuraAuthStatus()).toBe('not_connected');
  });

  it('sign-out during refresh: credentials stay cleared, user data cleared as before', async () => {
    await connectedInstall();
    await AsyncStorage.setItem('drink_log', '[1]');
    const gate = deferred<Reply>();
    const net = network(() => gate.promise);

    const load = loadOuraTrends('T1', 7);
    await waitFor(() => net.exchangeBodies.length === 1);
    await signOut();
    gate.resolve(ROTATED);
    await load;

    expect(await AsyncStorage.getItem('oura_access_token')).toBeNull();
    expect(keychain.get('oura_refresh_credentials')).toBeUndefined();
    expect(await AsyncStorage.getItem('drink_log')).toBeNull();
  });

  it('sign-out after the response but while tokens are being written: still cleared', async () => {
    await connectedInstall();
    network(async () => ROTATED);
    // Slow Keychain write so sign-out lands mid-save.
    const gate = deferred<void>();
    (SecureStore.setItemAsync as jest.Mock).mockImplementationOnce(async (k: string, v: string) => {
      await gate.promise; keychain.set(k, v);
    });

    const load = loadOuraTrends('T1', 7);
    await waitFor(() => (SecureStore.setItemAsync as jest.Mock).mock.calls.length === 1);
    const out = signOut();
    gate.resolve();
    await Promise.all([load, out]);

    expect(await AsyncStorage.getItem('oura_access_token')).toBeNull();
    expect(keychain.get('oura_refresh_credentials')).toBeUndefined();
  });

  it('reconnect during refresh: the new authorization wins over the stale refresh', async () => {
    await connectedInstall();
    const gate = deferred<Reply>();
    const net = network(body => body.grant_type === 'refresh_token'
      ? gate.promise
      : Promise.resolve({ status: 200, body: { access_token: 'T9', refresh_token: 'R9', expires_in: 86400 } }));
    (WebBrowser.openAuthSessionAsync as jest.Mock).mockResolvedValue({ type: 'success', url: 'bellahealth://oura-callback?code=abc' });

    const load = loadOuraTrends('T1', 7);
    await waitFor(() => net.exchangeBodies.length === 1);
    expect(await initiateOuraConnect()).toBe(true);
    gate.resolve(ROTATED);
    await load;

    expect(await AsyncStorage.getItem('oura_access_token')).toBe('T9');
    expect(JSON.parse(keychain.get('oura_refresh_credentials')!).refreshToken).toBe('R9');
  });

  it('a revoked-grant response arriving after disconnect does not set a stale reconnect flag', async () => {
    await connectedInstall();
    const gate = deferred<Reply>();
    const net = network(() => gate.promise);

    const load = loadOuraTrends('T1', 7);
    await waitFor(() => net.exchangeBodies.length === 1);
    await clearOuraToken();
    gate.resolve({ status: 401, body: { error: 'invalid_grant' } });
    await load;

    expect(await AsyncStorage.getItem(OURA_RECONNECT_KEY)).toBeNull();
  });
});

describe('failed refresh is bounded', () => {
  it('transient failure: at most 3 attempts, then later loads fail fast without new attempts', async () => {
    await connectedInstall();
    const net = network(async () => ({ status: 503 }));

    const first = await loadOuraTrends('T1', 7);
    expect(first).toMatchObject({ ok: false });
    expect(net.exchangeBodies).toHaveLength(3);

    for (let i = 0; i < 5; i++) await loadOuraTrends('T1', 7);
    expect(net.exchangeBodies).toHaveLength(3); // cooldown — no further attempts
    expect(await getOuraAuthStatus()).toBe('connected'); // still recoverable

    jest.advanceTimersByTime(61 * 1000);
    await loadOuraTrends('T1', 7);
    expect(net.exchangeBodies).toHaveLength(6); // one more bounded round after cooldown
  });

  it('unexpected non-transient refresh error (400): one attempt, then cooldown', async () => {
    await connectedInstall();
    const net = network(async () => ({ status: 400, body: { error: 'invalid_client' } }));
    expect(await loadOuraTrends('T1', 7)).toMatchObject({ ok: false, kind: 'http', status: 400 });
    // Cooldown: fail fast (reported as temporarily unavailable) without new attempts.
    for (let i = 0; i < 3; i++) expect(await loadOuraTrends('T1', 7)).toMatchObject({ ok: false });
    expect(net.exchangeBodies).toHaveLength(1);
    expect(await getOuraAuthStatus()).toBe('connected');
  });

  it('revoked grant: exactly one exchange call, later loads make none', async () => {
    await connectedInstall();
    const net = network(async () => ({ status: 401, body: { error: 'invalid_grant' } }));
    for (let i = 0; i < 4; i++) {
      expect(await loadOuraTrends('T1', 7)).toMatchObject({ ok: false, kind: 'reconnect_required' });
    }
    expect(net.exchangeBodies).toHaveLength(1);
  });

  it('every load terminates (no unbounded request loop) when Oura keeps rejecting refreshed tokens', async () => {
    await connectedInstall();
    let n = 0;
    const net = network(async () => ({ status: 200, body: { access_token: `X${n++}`, refresh_token: `RX${n}` } }));
    // Data API rejects everything, including refreshed tokens.
    (global.fetch as jest.Mock).mockImplementation(async (url: string, init?: any) => {
      if (url.includes(EXCHANGE)) {
        net.exchangeBodies.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ access_token: `X${n++}`, refresh_token: `RX${n}` }) };
      }
      return { ok: false, status: 401, json: async () => ({}) };
    });
    const r = await loadOuraTrends('T1', 7);
    expect(r).toMatchObject({ ok: false, kind: 'unauthorized' });
    // 5 parallel requests share refreshes; each request refreshes at most once.
    expect(net.exchangeBodies.length).toBeLessThanOrEqual(5);
    expect((global.fetch as jest.Mock).mock.calls.length).toBeLessThanOrEqual(5 * 2 + 5);
  });
});
