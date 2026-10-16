/**
 * auth.test.ts
 *
 * Unit tests for the anonymous Supabase auth service.
 * Tests cover session creation, recovery, token retrieval, user ID, and
 * account deletion.
 *
 * The supabase-js client is mocked entirely — no network calls are made.
 * `jest.requireMock('@supabase/supabase-js')._testClient` exposes the
 * internal mock auth object so individual tests can configure it.
 */

// ── @supabase/supabase-js mock ─────────────────────────────────────────────────
// Must be declared before any imports. The factory runs at module evaluation
// time (after hoisting); jest.fn() is always available in that context.
jest.mock('@supabase/supabase-js', () => {
  const auth = {
    getSession:         jest.fn(),
    signInAnonymously:  jest.fn(),
    signOut:            jest.fn(),
  };
  return {
    createClient:  jest.fn(() => ({ auth })),
    _testClient:   { auth },  // exposed for test configuration
  };
});

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// ── Imports (evaluated after mocks are in place) ──────────────────────────────
import { initializeAuth, getAuthToken, getAuthUserId, deleteAccount, signOut, SIGN_OUT_KEYS } from '../auth';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Access the shared mock auth object created in the factory above.
const { _testClient } = jest.requireMock('@supabase/supabase-js') as {
  _testClient: {
    auth: {
      getSession:        jest.Mock;
      signInAnonymously: jest.Mock;
      signOut:           jest.Mock;
    };
  };
};
const mockAuth = _testClient.auth;

const MOCK_TOKEN  = 'eyJhbGciOiJIUzI1NiJ9.test-jwt-payload.signature';
const MOCK_UID    = 'a1b2c3d4-0000-4000-8000-e5f6a7b8c9d0';

const sessionWithToken = {
  data: { session: { access_token: MOCK_TOKEN, user: { id: MOCK_UID } } },
  error: null,
};

const noSession = {
  data: { session: null },
  error: null,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Re-add default implementations after clearAllMocks() resets them.
  mockAuth.getSession.mockResolvedValue(noSession);
  mockAuth.signInAnonymously.mockResolvedValue({ data: {}, error: null });
  mockAuth.signOut.mockResolvedValue({ error: null });
});

describe('initializeAuth', () => {
  it('calls signInAnonymously when no session exists', async () => {
    mockAuth.getSession.mockResolvedValue(noSession);

    await initializeAuth();

    expect(mockAuth.signInAnonymously).toHaveBeenCalledTimes(1);
  });

  it('does NOT call signInAnonymously when a valid session already exists', async () => {
    mockAuth.getSession.mockResolvedValue(sessionWithToken);

    await initializeAuth();

    expect(mockAuth.signInAnonymously).not.toHaveBeenCalled();
  });

  it('logs but does not throw when signInAnonymously fails', async () => {
    mockAuth.getSession.mockResolvedValue(noSession);
    mockAuth.signInAnonymously.mockResolvedValue({
      data: {},
      error: { message: 'Network error' },
    });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(initializeAuth()).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('[auth]'),
      expect.stringContaining('Network error'),
    );
    spy.mockRestore();
  });

  it('logs but does not throw when getSession itself throws', async () => {
    mockAuth.getSession.mockRejectedValue(new Error('storage unavailable'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(initializeAuth()).resolves.toBeUndefined();

    spy.mockRestore();
  });
});

describe('getAuthToken', () => {
  it('returns the JWT access token from the active session', async () => {
    mockAuth.getSession.mockResolvedValue(sessionWithToken);

    const token = await getAuthToken();

    expect(token).toBe(MOCK_TOKEN);
  });

  it('returns null when no session is established', async () => {
    mockAuth.getSession.mockResolvedValue(noSession);

    const token = await getAuthToken();

    expect(token).toBeNull();
  });

  it('returns null (does not throw) when getSession throws', async () => {
    mockAuth.getSession.mockRejectedValue(new Error('storage error'));

    const token = await getAuthToken();

    expect(token).toBeNull();
  });
});

describe('getAuthUserId', () => {
  it('returns the user UUID from the active session', async () => {
    mockAuth.getSession.mockResolvedValue(sessionWithToken);

    const uid = await getAuthUserId();

    expect(uid).toBe(MOCK_UID);
  });

  it('returns null when no session exists', async () => {
    mockAuth.getSession.mockResolvedValue(noSession);

    const uid = await getAuthUserId();

    expect(uid).toBeNull();
  });
});

describe('deleteAccount', () => {
  const mockFetch = jest.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = mockFetch;
    mockFetch.mockResolvedValue({ ok: true, status: 204 });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('calls delete-account Edge Function with the JWT, then signs out', async () => {
    mockAuth.getSession.mockResolvedValue(sessionWithToken);

    const result = await deleteAccount();

    expect(result).toBe(true);

    // Verify JWT sent to Edge Function
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('delete-account');
    expect((opts.headers as Record<string, string>)['Authorization']).toBe(
      `Bearer ${MOCK_TOKEN}`,
    );

    // Verify local session was cleared
    expect(mockAuth.signOut).toHaveBeenCalledTimes(1);
  });

  it('returns false (does not throw) when no session token is available', async () => {
    mockAuth.getSession.mockResolvedValue(noSession);

    const result = await deleteAccount();

    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockAuth.signOut).not.toHaveBeenCalled();
  });

  it('returns false when the Edge Function responds with an error status', async () => {
    mockAuth.getSession.mockResolvedValue(sessionWithToken);
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await deleteAccount();

    expect(result).toBe(false);
    expect(mockAuth.signOut).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does NOT expose the service-role key in the fetch call', async () => {
    mockAuth.getSession.mockResolvedValue(sessionWithToken);

    await deleteAccount();

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    // Only the anon key (project identifier) should appear here, never service-role key
    Object.values(headers).forEach((v) => {
      expect(v).not.toMatch(/service_role|SERVICE_ROLE/);
    });
  });
});

describe('Session isolation', () => {
  it('getAuthToken and getAuthUserId read from the same stored session', async () => {
    mockAuth.getSession.mockResolvedValue(sessionWithToken);

    const [token, uid] = await Promise.all([getAuthToken(), getAuthUserId()]);

    expect(token).toBe(MOCK_TOKEN);
    expect(uid).toBe(MOCK_UID);
  });
});

// ─── SIGN_OUT_KEYS ─────────────────────────────────────────────────────────────

describe('SIGN_OUT_KEYS — content classification', () => {
  it('includes account-personal keys', () => {
    expect(SIGN_OUT_KEYS).toContain('user_profile');
    expect(SIGN_OUT_KEYS).toContain('training_goals');
    expect(SIGN_OUT_KEYS).toContain('context_events');
    expect(SIGN_OUT_KEYS).toContain('drink_log');
    expect(SIGN_OUT_KEYS).toContain('onboarding_complete');
    expect(SIGN_OUT_KEYS).toContain('is_male');
    expect(SIGN_OUT_KEYS).toContain('cycle_profile');
    expect(SIGN_OUT_KEYS).toContain('cycle_journal');
    expect(SIGN_OUT_KEYS).toContain('gratitude_entries');
  });

  it('includes wearable credential', () => {
    expect(SIGN_OUT_KEYS).toContain('oura_access_token');
  });

  it('includes personal health logs', () => {
    expect(SIGN_OUT_KEYS).toContain('caffeine_log');
    expect(SIGN_OUT_KEYS).toContain('meal_log');
    expect(SIGN_OUT_KEYS).toContain('water_history');
    expect(SIGN_OUT_KEYS).toContain('wellness_log');
    expect(SIGN_OUT_KEYS).toContain('electrolytes_log');
  });

  it('includes sync state flag', () => {
    expect(SIGN_OUT_KEYS).toContain('sync_pending');
  });

  it('does NOT include device-level analytics keys', () => {
    expect(SIGN_OUT_KEYS).not.toContain('analytics_first_open_sent');
    expect(SIGN_OUT_KEYS).not.toContain('analytics_hk_connected_sent');
    expect(SIGN_OUT_KEYS).not.toContain('analytics_oura_catchup_sent');
    expect(SIGN_OUT_KEYS).not.toContain('open_chat_flag');
  });
});

// ─── signOut ───────────────────────────────────────────────────────────────────

describe('signOut', () => {
  // Spy on multiRemove once; re-apply implementation each test after clearAllMocks.
  const multiRemoveSpy = jest.spyOn(AsyncStorage, 'multiRemove');

  beforeEach(() => {
    multiRemoveSpy.mockResolvedValue(undefined as never);
  });

  afterAll(() => {
    multiRemoveSpy.mockRestore();
  });

  it('calls supabase.auth.signOut()', async () => {
    await signOut();
    expect(mockAuth.signOut).toHaveBeenCalledTimes(1);
  });

  it('calls AsyncStorage.multiRemove with all SIGN_OUT_KEYS', async () => {
    await signOut();
    expect(multiRemoveSpy).toHaveBeenCalledTimes(1);
    const [keys] = multiRemoveSpy.mock.calls[0] as [readonly string[]];
    SIGN_OUT_KEYS.forEach((k) => expect(keys).toContain(k));
  });

  it('does NOT call AsyncStorage.clear() — preserves analytics device identity', async () => {
    const clearSpy = jest.spyOn(AsyncStorage, 'clear');
    await signOut();
    expect(clearSpy).not.toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('re-initializes anonymous session after clearing keys', async () => {
    // initializeAuth is called at the end of signOut; with no session it
    // calls signInAnonymously to get a fresh anonymous JWT.
    mockAuth.getSession.mockResolvedValue(noSession);
    await signOut();
    expect(mockAuth.signInAnonymously).toHaveBeenCalledTimes(1);
  });

  it('does not throw when supabase.auth.signOut() throws', async () => {
    mockAuth.signOut.mockRejectedValue(new Error('network error'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(signOut()).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it('does not throw when AsyncStorage.multiRemove throws', async () => {
    multiRemoveSpy.mockRejectedValue(new Error('storage unavailable'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(signOut()).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
