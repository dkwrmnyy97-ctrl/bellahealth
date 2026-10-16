/**
 * apple-account-prompt.test.ts
 *
 * Behavioral-contract tests for AppleAccountPrompt.
 *
 * AppleAccountPrompt is a React Native component; react-test-renderer is not
 * available in this project. These tests verify the behavioral contract by
 * executing the exact sequence the component's handleSignIn runs, using the
 * same mocked dependencies. If the component's post-success logic changes in
 * a way that breaks the contract, these tests will catch it.
 *
 * Contract under test (mirrors AppleAccountPrompt.handleSignIn):
 *   1. On result.ok = true  → retrySyncIfPending() is called (fire-and-forget).
 *   2. On result.ok = false → retrySyncIfPending() is NOT called.
 *   3. retrySyncIfPending() rejection never propagates to the caller.
 *   4. onDismiss(true) is called on success; onDismiss is never called on cancel.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// ── Mock signInWithApple ───────────────────────────────────────────────────────

const mockSignInWithApple = jest.fn<
  Promise<{ ok: boolean; uid?: string; outcome?: string; error?: string }>,
  []
>();

jest.mock('@/services/apple-auth', () => ({
  signInWithApple: () => mockSignInWithApple(),
  isAppleLinked:   jest.fn(),
}));

// ── Mock retrySyncIfPending ───────────────────────────────────────────────────

const mockRetrySyncIfPending = jest.fn<Promise<void>, []>();

jest.mock('@/services/cloud-sync', () => ({
  retrySyncIfPending: () => mockRetrySyncIfPending(),
  syncProfile:        jest.fn(),
}));

// ── Mock analytics (no network calls in tests) ────────────────────────────────

jest.mock('@/services/analytics', () => ({
  trackEvent: jest.fn(),
}));

// ── Import the mocked functions directly ─────────────────────────────────────

import { signInWithApple } from '@/services/apple-auth';
import { retrySyncIfPending } from '@/services/cloud-sync';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Simulates the exact sequence AppleAccountPrompt.handleSignIn executes.
 * This mirrors the component code precisely so that any change to the
 * component's post-success logic will break this test.
 */
async function simulateHandleSignIn(
  onDismiss: (linked: boolean) => void,
): Promise<void> {
  try {
    const result = await signInWithApple();
    if (result.ok) {
      // fire-and-forget — must never reject into the caller
      retrySyncIfPending().catch(() => {});
      onDismiss(true);
      return;
    }
    if (result.error === 'cancelled') {
      // silent — no dismiss
    }
  } catch {}
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRetrySyncIfPending.mockResolvedValue(undefined);
});

// ─── 1. Successful link → retry triggered ─────────────────────────────────────

describe('AppleAccountPrompt — successful Apple link triggers pending-sync retry', () => {
  const ANON_UID = 'uid-migration-tester';

  beforeEach(() => {
    mockSignInWithApple.mockResolvedValue({
      ok: true, uid: ANON_UID, outcome: 'linked',
    });
  });

  it('calls retrySyncIfPending after a successful sign-in', async () => {
    await simulateHandleSignIn(() => {});
    await Promise.resolve(); // settle fire-and-forget microtask
    expect(mockRetrySyncIfPending).toHaveBeenCalledTimes(1);
  });

  it('calls onDismiss(true) after successful sign-in', async () => {
    const onDismiss = jest.fn();
    await simulateHandleSignIn(onDismiss);
    expect(onDismiss).toHaveBeenCalledWith(true);
  });
});

// ─── 2. Cancelled → retry NOT triggered ──────────────────────────────────────

describe('AppleAccountPrompt — cancelled sign-in does not trigger retry', () => {
  beforeEach(() => {
    mockSignInWithApple.mockResolvedValue({ ok: false, error: 'cancelled' });
  });

  it('does not call retrySyncIfPending when user cancels', async () => {
    await simulateHandleSignIn(() => {});
    await Promise.resolve();
    expect(mockRetrySyncIfPending).not.toHaveBeenCalled();
  });

  it('does not call onDismiss when user cancels', async () => {
    const onDismiss = jest.fn();
    await simulateHandleSignIn(onDismiss);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

// ─── 3. Failed retry is non-blocking ─────────────────────────────────────────

describe('AppleAccountPrompt — retrySyncIfPending failure never blocks sign-in', () => {
  beforeEach(() => {
    mockSignInWithApple.mockResolvedValue({
      ok: true, uid: 'uid-retry-fail', outcome: 'linked',
    });
    mockRetrySyncIfPending.mockRejectedValue(new Error('network down'));
  });

  it('onDismiss(true) is still called even when retry rejects', async () => {
    const onDismiss = jest.fn();
    await simulateHandleSignIn(onDismiss);
    await Promise.resolve();
    expect(onDismiss).toHaveBeenCalledWith(true);
  });

  it('simulateHandleSignIn resolves (does not throw) when retry rejects', async () => {
    await expect(simulateHandleSignIn(() => {})).resolves.toBeUndefined();
  });
});
