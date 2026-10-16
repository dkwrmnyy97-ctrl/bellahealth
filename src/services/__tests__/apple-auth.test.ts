/**
 * apple-auth.test.ts
 *
 * Phase 1 regression coverage for native Apple Sign In.
 *
 * Tests:
 *   1. generateNonce — rawNonce is a UUID, hashedNonce is 64-char hex (SHA-256).
 *   2. signInWithApple — 'unavailable' when isAvailableAsync returns false.
 *   3. signInWithApple — 'cancelled' when Apple throws ERR_REQUEST_CANCELED.
 *   4. signInWithApple — error when Apple returns no identityToken.
 *   5. signInWithApple — error when Supabase signInWithIdToken fails.
 *   6. signInWithApple — outcome 'new' when no prior session (uidBefore = null).
 *   7. signInWithApple — outcome 'linked' when uidBefore === uidAfter.
 *   8. signInWithApple — outcome 'collision' when UIDs differ.
 *   9. isAppleLinked — true when session has an apple identity.
 *  10. isAppleLinked — false when session has no identities.
 *  11. isAppleLinked — false when getSession throws.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// ── Mock expo-apple-authentication ────────────────────────────────────────────

const mockIsAvailable   = jest.fn<Promise<boolean>, []>();
const mockSignInAsync   = jest.fn<
  Promise<{ identityToken: string | null; authorizationCode?: string | null }>,
  [unknown]
>();

jest.mock('expo-apple-authentication', () => ({
  isAvailableAsync: (...args: unknown[]) => mockIsAvailable(...args),
  signInAsync:      (...args: unknown[]) => mockSignInAsync(...args),
  AppleAuthenticationScope: {
    FULL_NAME: 'FULL_NAME',
    EMAIL:     'EMAIL',
  },
}));

// ── Mock expo-crypto ──────────────────────────────────────────────────────────

const mockRandomUUID   = jest.fn<string, []>();
const mockDigestString = jest.fn<Promise<string>, [unknown, string]>();

jest.mock('expo-crypto', () => ({
  randomUUID:          (...args: unknown[]) => mockRandomUUID(...args as []),
  digestStringAsync:   (...args: unknown[]) => mockDigestString(...args as [unknown, string]),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}));

// ── Mock @/services/auth (supabase client) ────────────────────────────────────

const mockGetSession        = jest.fn();
const mockSignInWithIdToken = jest.fn();
const mockFunctionsInvoke   = jest.fn();

jest.mock('@/services/auth', () => ({
  supabase: {
    auth: {
      getSession:        (...args: unknown[]) => mockGetSession(...args),
      signInWithIdToken: (...args: unknown[]) => mockSignInWithIdToken(...args),
    },
    functions: {
      invoke: (...args: unknown[]) => mockFunctionsInvoke(...args),
    },
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { generateNonce, signInWithApple, isAppleLinked } from '../apple-auth';

// Ensure functions.invoke always returns a Promise so fire-and-forget .catch()
// never throws "Cannot read property of undefined" in any test.
beforeEach(() => {
  mockFunctionsInvoke.mockResolvedValue({ data: { ok: true }, error: null });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sessionOf(uid: string) {
  return {
    data: {
      session: {
        user: { id: uid, identities: [{ provider: 'apple' }] },
        access_token: 'tok',
      },
    },
    error: null,
  };
}

function noSession() {
  return { data: { session: null }, error: null };
}

// ─── 1. generateNonce ─────────────────────────────────────────────────────────

describe('generateNonce', () => {
  beforeEach(() => {
    mockRandomUUID.mockReturnValue('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    mockDigestString.mockResolvedValue('a'.repeat(64)); // fake 64-char hex
  });

  it('rawNonce is the UUID returned by Crypto.randomUUID', async () => {
    const { rawNonce } = await generateNonce();
    expect(rawNonce).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  });

  it('hashedNonce is the digest of rawNonce', async () => {
    const { rawNonce, hashedNonce } = await generateNonce();
    expect(mockDigestString).toHaveBeenCalledWith('SHA-256', rawNonce);
    expect(hashedNonce).toBe('a'.repeat(64));
  });

  it('rawNonce and hashedNonce are different strings', async () => {
    mockDigestString.mockResolvedValue('b'.repeat(64));
    const { rawNonce, hashedNonce } = await generateNonce();
    expect(rawNonce).not.toBe(hashedNonce);
  });
});

// ─── 2. unavailable ───────────────────────────────────────────────────────────

describe('signInWithApple — unavailable', () => {
  it('returns ok:false error:"unavailable" when isAvailableAsync is false', async () => {
    mockIsAvailable.mockResolvedValue(false);
    const result = await signInWithApple();
    expect(result).toEqual({ ok: false, error: 'unavailable' });
  });
});

// ─── 3. cancelled ─────────────────────────────────────────────────────────────

describe('signInWithApple — cancelled', () => {
  beforeEach(() => {
    mockIsAvailable.mockResolvedValue(true);
    mockGetSession.mockResolvedValue(noSession());
    mockRandomUUID.mockReturnValue('uuid-cancel');
    mockDigestString.mockResolvedValue('hash-cancel');
  });

  it('returns ok:false error:"cancelled" when Apple throws ERR_REQUEST_CANCELED', async () => {
    const cancelErr = Object.assign(new Error('User cancelled'), { code: 'ERR_REQUEST_CANCELED' });
    mockSignInAsync.mockRejectedValue(cancelErr);
    const result = await signInWithApple();
    expect(result).toEqual({ ok: false, error: 'cancelled' });
  });
});

// ─── 4. no identityToken ──────────────────────────────────────────────────────

describe('signInWithApple — no identityToken', () => {
  beforeEach(() => {
    mockIsAvailable.mockResolvedValue(true);
    mockGetSession.mockResolvedValue(noSession());
    mockRandomUUID.mockReturnValue('uuid-nit');
    mockDigestString.mockResolvedValue('hash-nit');
    mockSignInAsync.mockResolvedValue({ identityToken: null });
  });

  it('returns error when Apple returns null identityToken', async () => {
    const result = await signInWithApple();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('identity token');
    }
  });
});

// ─── 5. Supabase error ────────────────────────────────────────────────────────

describe('signInWithApple — Supabase error', () => {
  beforeEach(() => {
    mockIsAvailable.mockResolvedValue(true);
    mockGetSession.mockResolvedValue(noSession());
    mockRandomUUID.mockReturnValue('uuid-sb');
    mockDigestString.mockResolvedValue('hash-sb');
    mockSignInAsync.mockResolvedValue({ identityToken: 'valid-token' });
    mockSignInWithIdToken.mockResolvedValue({
      data: { session: null },
      error: { message: 'Invalid JWT' },
    });
  });

  it('returns ok:false with Supabase error message', async () => {
    const result = await signInWithApple();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('Invalid JWT');
  });
});

// ─── 6. outcome 'new' — no prior session ─────────────────────────────────────

describe('signInWithApple — outcome new', () => {
  const NEW_UID = 'uid-fresh-apple-user';

  beforeEach(() => {
    mockIsAvailable.mockResolvedValue(true);
    // First getSession call: no prior session
    mockGetSession.mockResolvedValue(noSession());
    mockRandomUUID.mockReturnValue('uuid-new');
    mockDigestString.mockResolvedValue('hash-new');
    mockSignInAsync.mockResolvedValue({ identityToken: 'apple-token-new' });
    mockSignInWithIdToken.mockResolvedValue(sessionOf(NEW_UID));
  });

  it('returns ok:true with outcome "new" when there was no prior session', async () => {
    const result = await signInWithApple();
    expect(result).toEqual({ ok: true, uid: NEW_UID, outcome: 'new' });
  });
});

// ─── 7. outcome 'linked' — UID preserved ─────────────────────────────────────

describe('signInWithApple — outcome linked', () => {
  const ANON_UID = 'uid-anonymous-preserved';

  beforeEach(() => {
    mockIsAvailable.mockResolvedValue(true);
    // Prior session has anonymous UID
    mockGetSession.mockResolvedValue({
      data: {
        session: {
          user: { id: ANON_UID, identities: [] },
          access_token: 'anon-tok',
        },
      },
      error: null,
    });
    mockRandomUUID.mockReturnValue('uuid-link');
    mockDigestString.mockResolvedValue('hash-link');
    mockSignInAsync.mockResolvedValue({ identityToken: 'apple-token-link' });
    // Supabase returns same UID → anonymous upgraded in-place
    mockSignInWithIdToken.mockResolvedValue(sessionOf(ANON_UID));
  });

  it('returns outcome "linked" when uidBefore === uidAfter', async () => {
    const result = await signInWithApple();
    expect(result).toEqual({ ok: true, uid: ANON_UID, outcome: 'linked' });
  });
});

// ─── 8. outcome 'collision' — different UIDs ──────────────────────────────────

describe('signInWithApple — outcome collision', () => {
  const ANON_UID  = 'uid-anon-device';
  const APPLE_UID = 'uid-existing-apple-account';

  beforeEach(() => {
    mockIsAvailable.mockResolvedValue(true);
    mockGetSession.mockResolvedValue({
      data: {
        session: {
          user: { id: ANON_UID, identities: [] },
          access_token: 'anon-tok',
        },
      },
      error: null,
    });
    mockRandomUUID.mockReturnValue('uuid-col');
    mockDigestString.mockResolvedValue('hash-col');
    mockSignInAsync.mockResolvedValue({ identityToken: 'apple-token-collision' });
    // Supabase returns a different UID (Apple account already existed)
    mockSignInWithIdToken.mockResolvedValue(sessionOf(APPLE_UID));
  });

  it('returns outcome "collision" when uidBefore !== uidAfter', async () => {
    const result = await signInWithApple();
    expect(result).toEqual({ ok: true, uid: APPLE_UID, outcome: 'collision' });
  });

  it('uid in result is the Apple account uid, not the anonymous uid', async () => {
    const result = await signInWithApple();
    if (result.ok) {
      expect(result.uid).toBe(APPLE_UID);
      expect(result.uid).not.toBe(ANON_UID);
    }
  });
});

// ─── 9. isAppleLinked — true ──────────────────────────────────────────────────

describe('isAppleLinked', () => {
  it('returns true when session has an apple identity', async () => {
    mockGetSession.mockResolvedValue({
      data: {
        session: {
          user: {
            id: 'some-uid',
            identities: [
              { provider: 'anonymous' },
              { provider: 'apple' },
            ],
          },
        },
      },
      error: null,
    });
    expect(await isAppleLinked()).toBe(true);
  });

  it('returns false when session has no identities', async () => {
    mockGetSession.mockResolvedValue({
      data: {
        session: {
          user: { id: 'some-uid', identities: [] },
        },
      },
      error: null,
    });
    expect(await isAppleLinked()).toBe(false);
  });

  it('returns false when there is no session', async () => {
    mockGetSession.mockResolvedValue(noSession());
    expect(await isAppleLinked()).toBe(false);
  });

  it('returns false (does not throw) when getSession throws', async () => {
    mockGetSession.mockRejectedValue(new Error('network error'));
    expect(await isAppleLinked()).toBe(false);
  });
});

// ─── 12. exchange-apple-code called after successful sign-in ──────────────────

describe('signInWithApple — exchange-apple-code fire-and-forget', () => {
  const UID = 'uid-with-auth-code';

  beforeEach(() => {
    mockIsAvailable.mockResolvedValue(true);
    mockGetSession.mockResolvedValue(noSession());
    mockRandomUUID.mockReturnValue('uuid-exch');
    mockDigestString.mockResolvedValue('hash-exch');
    mockSignInAsync.mockResolvedValue({
      identityToken:     'valid-id-token',
      authorizationCode: 'one-time-code-abc',
    });
    mockSignInWithIdToken.mockResolvedValue(sessionOf(UID));
    mockFunctionsInvoke.mockClear();
    mockFunctionsInvoke.mockResolvedValue({ data: { ok: true }, error: null });
  });

  it('calls exchange-apple-code with the authorizationCode after successful sign-in', async () => {
    await signInWithApple();
    await Promise.resolve(); // settle fire-and-forget microtask
    expect(mockFunctionsInvoke).toHaveBeenCalledTimes(1);
    expect(mockFunctionsInvoke).toHaveBeenCalledWith('exchange-apple-code', {
      body: { authorizationCode: 'one-time-code-abc' },
    });
  });

  it('sign-in still returns ok:true when exchange-apple-code call fails', async () => {
    mockFunctionsInvoke.mockRejectedValue(new Error('network error'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await signInWithApple();
    await Promise.resolve();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.uid).toBe(UID);
    spy.mockRestore();
  });

  it('logs a non-sensitive message (no code/token) when exchange call fails', async () => {
    mockFunctionsInvoke.mockRejectedValue(new Error('network error'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await signInWithApple();
    await Promise.resolve();
    const [msg] = spy.mock.calls[0] as [string];
    expect(msg).toContain('[apple-auth]');
    expect(msg).not.toContain('one-time-code-abc'); // authorizationCode never logged
    spy.mockRestore();
  });
});

// ─── 13. exchange-apple-code NOT called when authorizationCode absent ──────────

describe('signInWithApple — exchange not called without authorizationCode', () => {
  const UID = 'uid-no-code';

  beforeEach(() => {
    mockIsAvailable.mockResolvedValue(true);
    mockGetSession.mockResolvedValue(noSession());
    mockRandomUUID.mockReturnValue('uuid-nocode');
    mockDigestString.mockResolvedValue('hash-nocode');
    // Credential has no authorizationCode
    mockSignInAsync.mockResolvedValue({ identityToken: 'valid-id-token' });
    mockSignInWithIdToken.mockResolvedValue(sessionOf(UID));
    mockFunctionsInvoke.mockClear();
  });

  it('does not call exchange-apple-code when credential has no authorizationCode', async () => {
    await signInWithApple();
    await Promise.resolve();
    expect(mockFunctionsInvoke).not.toHaveBeenCalled();
  });

  it('sign-in still succeeds without authorizationCode', async () => {
    const result = await signInWithApple();
    expect(result.ok).toBe(true);
  });
});

// ─── 14. exchange-apple-code NOT called on sign-in failure ────────────────────

describe('signInWithApple — exchange not called when sign-in fails', () => {
  beforeEach(() => {
    mockIsAvailable.mockResolvedValue(true);
    mockGetSession.mockResolvedValue(noSession());
    mockRandomUUID.mockReturnValue('uuid-fail');
    mockDigestString.mockResolvedValue('hash-fail');
    mockSignInAsync.mockResolvedValue({
      identityToken:     'valid-id-token',
      authorizationCode: 'should-never-be-sent',
    });
    mockSignInWithIdToken.mockResolvedValue({
      data: { session: null },
      error: { message: 'Supabase rejected' },
    });
    mockFunctionsInvoke.mockClear();
  });

  it('does not call exchange-apple-code when Supabase sign-in fails', async () => {
    await signInWithApple();
    await Promise.resolve();
    expect(mockFunctionsInvoke).not.toHaveBeenCalled();
  });
});

// ─── 15. Anonymous UID preserved after Apple linking ──────────────────────────
//
// Regression for the migration path: existing anonymous user installs new build
// and links their Apple account for the first time. Their auth.uid() must be
// identical before and after the link — no new account created, no UID change.

describe('signInWithApple — anonymous UID preserved after Apple linking', () => {
  const ANON_UID = 'uid-anonymous-existing-tester';

  beforeEach(() => {
    mockIsAvailable.mockResolvedValue(true);
    // Pre-existing anonymous session
    mockGetSession.mockResolvedValue({
      data: {
        session: {
          user: { id: ANON_UID, identities: [] },
          access_token: 'anon-tok',
        },
      },
      error: null,
    });
    mockRandomUUID.mockReturnValue('uuid-link-migration');
    mockDigestString.mockResolvedValue('hash-link-migration');
    mockSignInAsync.mockResolvedValue({ identityToken: 'apple-id-token' });
    // Supabase upgrades anonymous user in-place — same UID returned
    mockSignInWithIdToken.mockResolvedValue(sessionOf(ANON_UID));
  });

  it('returns outcome "linked" — UID is identical before and after', async () => {
    const result = await signInWithApple();
    expect(result).toEqual({ ok: true, uid: ANON_UID, outcome: 'linked' });
  });

  it('returned uid matches the original anonymous uid', async () => {
    const result = await signInWithApple();
    if (result.ok) expect(result.uid).toBe(ANON_UID);
  });
});

// ─── 16. Local data not cleared during Apple linking ──────────────────────────
//
// signInWithApple() must never write to or remove from AsyncStorage.
// All local health data (meal_log, context_events, etc.) must survive linking.

describe('signInWithApple — local AsyncStorage is not modified during linking', () => {
  const ANON_UID = 'uid-local-data-safety';

  beforeEach(() => {
    mockIsAvailable.mockResolvedValue(true);
    mockGetSession.mockResolvedValue({
      data: {
        session: {
          user: { id: ANON_UID, identities: [] },
          access_token: 'anon-tok',
        },
      },
      error: null,
    });
    mockRandomUUID.mockReturnValue('uuid-data-safety');
    mockDigestString.mockResolvedValue('hash-data-safety');
    mockSignInAsync.mockResolvedValue({ identityToken: 'apple-id-token' });
    mockSignInWithIdToken.mockResolvedValue(sessionOf(ANON_UID));
  });

  it('does not call AsyncStorage.removeItem during a successful link', async () => {
    const AsyncStorage = require('@react-native-async-storage/async-storage');
    const spy = jest.spyOn(AsyncStorage, 'removeItem');
    await signInWithApple();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does not call AsyncStorage.multiRemove during a successful link', async () => {
    const AsyncStorage = require('@react-native-async-storage/async-storage');
    const spy = jest.spyOn(AsyncStorage, 'multiRemove');
    await signInWithApple();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
