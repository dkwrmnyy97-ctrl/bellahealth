/**
 * cloud-sync.test.ts
 *
 * Unit tests for the V1 cloud persistence layer.
 *
 * Tests:
 *   1. syncProfile — calls upsert with mapped fields; returns true on success.
 *   2. syncProfile — returns false when no session.
 *   3. syncProfile — returns false on Supabase error.
 *   4. pullProfile — maps cloud row back to SavedProfile shape.
 *   5. pullProfile — returns null when no row.
 *   6. syncTrainingGoals — upserts body + perf.
 *   7. syncContextEvents — omits 'notes' field (privacy invariant).
 *   8. syncContextEvents — returns true for empty array without calling Supabase.
 *   9. syncDrinkLog — upserts with (user_id, date) conflict key.
 *  10. syncDrinkLog — returns true for empty array without calling Supabase.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Mock Supabase ─────────────────────────────────────────────────────────────

const mockUpsert  = jest.fn();
const mockSelect  = jest.fn();
const mockEq      = jest.fn();
const mockSingle  = jest.fn();
const mockGetSession = jest.fn();

const mockFrom = jest.fn(() => ({
  upsert:  mockUpsert,
  select:  mockSelect,
}));

mockSelect.mockReturnValue({ eq: mockEq });
mockEq.mockReturnValue({ single: mockSingle });

jest.mock('@/services/auth', () => ({
  supabase: {
    auth: { getSession: (...args: unknown[]) => mockGetSession(...args) },
    from:  (...args: unknown[]) => mockFrom(...args),
  },
}));

import {
  syncProfile,
  pullProfile,
  syncTrainingGoals,
  syncContextEvents,
  syncDrinkLog,
  retrySyncIfPending,
} from '../cloud-sync';

beforeEach(() => jest.clearAllMocks());
import type { SavedProfile } from '@/components/profile-modal';
import type { ContextEvent } from '@/services/context-events';
import type { DrinkEntry } from '@/utils/drink-entry';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const UID = 'test-uid-abc123';

function withSession() {
  mockGetSession.mockResolvedValue({
    data: { session: { user: { id: UID } } },
    error: null,
  });
}

function withNoSession() {
  mockGetSession.mockResolvedValue({
    data: { session: null },
    error: null,
  });
}

const BASE_PROFILE: SavedProfile = {
  name: 'Isabella', age: '28', gender: 'Female',
  height: "5'6\"", weight: '140', weightGoal: '135',
  stepGoal: '10000', calGoal: '2000', sleepGoal: '8', waterGoal: '80',
  supplements: 'Vitamin D', companionApps: ['strava'], units: 'imperial',
};

// ─── 1. syncProfile — success ─────────────────────────────────────────────────

describe('syncProfile — success', () => {
  beforeEach(() => {
    withSession();
    mockUpsert.mockResolvedValue({ error: null });
  });

  it('returns true on success', async () => {
    expect(await syncProfile(BASE_PROFILE)).toBe(true);
  });

  it('calls from("user_profiles")', async () => {
    await syncProfile(BASE_PROFILE);
    expect(mockFrom).toHaveBeenCalledWith('user_profiles');
  });

  it('upserts with correct id = uid', async () => {
    await syncProfile(BASE_PROFILE);
    const row = mockUpsert.mock.calls[0][0];
    expect(row.id).toBe(UID);
  });

  it('maps numeric fields correctly', async () => {
    await syncProfile(BASE_PROFILE);
    const row = mockUpsert.mock.calls[0][0];
    expect(row.age).toBe(28);
    expect(row.weight_lbs).toBe(140);
    expect(row.step_goal).toBe(10000);
    expect(row.sleep_goal).toBe(8);
    expect(row.water_goal_oz).toBe(80);
  });

  it('uses onConflict: "id"', async () => {
    await syncProfile(BASE_PROFILE);
    const opts = mockUpsert.mock.calls[0][1];
    expect(opts.onConflict).toBe('id');
  });
});

// ─── 2. syncProfile — no session ─────────────────────────────────────────────

describe('syncProfile — no session', () => {
  it('returns false without calling upsert', async () => {
    withNoSession();
    mockUpsert.mockClear();
    const result = await syncProfile(BASE_PROFILE);
    expect(result).toBe(false);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

// ─── 3. syncProfile — Supabase error ─────────────────────────────────────────

describe('syncProfile — Supabase error', () => {
  it('returns false when upsert returns an error', async () => {
    withSession();
    mockUpsert.mockResolvedValue({ error: { message: 'RLS denied' } });
    expect(await syncProfile(BASE_PROFILE)).toBe(false);
  });
});

// ─── 4. pullProfile — maps row to SavedProfile ────────────────────────────────

describe('pullProfile — maps cloud row', () => {
  beforeEach(() => {
    withSession();
    mockSingle.mockResolvedValue({
      data: {
        id: UID,
        name: 'Isabella', age: 28, gender: 'Female',
        height_display: "5'6\"", weight_lbs: 140, weight_goal_lbs: 135,
        step_goal: 10000, cal_goal: 2000, sleep_goal: 8, water_goal_oz: 80,
        supplements: 'Vitamin D', companion_apps: ['strava'], units: 'imperial',
      },
      error: null,
    });
  });

  it('returns a SavedProfile with correct string fields', async () => {
    const result = await pullProfile();
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Isabella');
    expect(result!.age).toBe('28');
    expect(result!.weight).toBe('140');
    expect(result!.stepGoal).toBe('10000');
  });

  it('returns companionApps as array', async () => {
    const result = await pullProfile();
    expect(Array.isArray(result!.companionApps)).toBe(true);
    expect(result!.companionApps).toContain('strava');
  });
});

// ─── 5. pullProfile — no row ──────────────────────────────────────────────────

describe('pullProfile — no row', () => {
  it('returns null when single() returns an error', async () => {
    withSession();
    mockSingle.mockResolvedValue({ data: null, error: { message: 'PGRST116' } });
    expect(await pullProfile()).toBeNull();
  });
});

// ─── 6. syncTrainingGoals ─────────────────────────────────────────────────────

describe('syncTrainingGoals', () => {
  beforeEach(() => {
    withSession();
    mockUpsert.mockResolvedValue({ error: null });
  });

  it('returns true and calls from("training_goals")', async () => {
    const result = await syncTrainingGoals({ body: 'cut', perf: 'strength' });
    expect(result).toBe(true);
    expect(mockFrom).toHaveBeenCalledWith('training_goals');
  });

  it('upserts correct body and perf values', async () => {
    await syncTrainingGoals({ body: 'bulk', perf: 'marathon' });
    const row = mockUpsert.mock.calls[0][0];
    expect(row.body).toBe('bulk');
    expect(row.perf).toBe('marathon');
    expect(row.user_id).toBe(UID);
  });

  it('uses onConflict: "user_id"', async () => {
    await syncTrainingGoals({ body: null, perf: null });
    const opts = mockUpsert.mock.calls[0][1];
    expect(opts.onConflict).toBe('user_id');
  });
});

// ─── 7. syncContextEvents — privacy invariant ─────────────────────────────────

describe('syncContextEvents — notes field omitted', () => {
  beforeEach(() => {
    withSession();
    mockUpsert.mockResolvedValue({ error: null });
  });

  const events: ContextEvent[] = [
    {
      id:        'evt-001',
      type:      'travel',
      source:    'user',
      label:     'NY trip',
      startDate: '2026-09-01',
      endDate:   '2026-09-07',
      notes:     'Felt stressed — private note that must not go to cloud',
      metadata:  { destination: 'New York' },
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    },
  ];

  it('returns true on success', async () => {
    expect(await syncContextEvents(events)).toBe(true);
  });

  it('does NOT include notes in the upserted row', async () => {
    await syncContextEvents(events);
    const rows: unknown[] = mockUpsert.mock.calls[0][0];
    const row = rows[0] as Record<string, unknown>;
    expect('notes' in row).toBe(false);
  });

  it('includes all other structured fields', async () => {
    await syncContextEvents(events);
    const rows: unknown[] = mockUpsert.mock.calls[0][0];
    const row = rows[0] as Record<string, unknown>;
    expect(row.id).toBe('evt-001');
    expect(row.type).toBe('travel');
    expect(row.label).toBe('NY trip');
    expect(row.start_date).toBe('2026-09-01');
    expect(row.user_id).toBe(UID);
  });
});

// ─── 8. syncContextEvents — empty array ──────────────────────────────────────

describe('syncContextEvents — empty', () => {
  it('returns true immediately without calling Supabase', async () => {
    withSession();
    mockUpsert.mockClear();
    const result = await syncContextEvents([]);
    expect(result).toBe(true);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

// ─── 9. syncDrinkLog ──────────────────────────────────────────────────────────

describe('syncDrinkLog', () => {
  beforeEach(() => {
    withSession();
    mockUpsert.mockResolvedValue({ error: null });
  });

  const entries: DrinkEntry[] = [
    { date: '2026-09-15', totalDrinks: 2.5, totalCalories: 280, vibe: 'social', counts: { wine: 2 } },
    { date: '2026-09-18', totalDrinks: 1,   totalCalories: 140, vibe: null,     counts: { beer: 1 } },
  ];

  it('returns true and calls from("drink_log")', async () => {
    expect(await syncDrinkLog(entries)).toBe(true);
    expect(mockFrom).toHaveBeenCalledWith('drink_log');
  });

  it('maps entries with user_id and date', async () => {
    await syncDrinkLog(entries);
    const rows: unknown[] = mockUpsert.mock.calls[0][0];
    const row = rows[0] as Record<string, unknown>;
    expect(row.user_id).toBe(UID);
    expect(row.date).toBe('2026-09-15');
    expect(row.total_drinks).toBe(2.5);
    expect(row.vibe).toBe('social');
  });

  it('maps null vibe as null', async () => {
    await syncDrinkLog(entries);
    const rows: unknown[] = mockUpsert.mock.calls[0][0];
    const row = rows[1] as Record<string, unknown>;
    expect(row.vibe).toBeNull();
  });

  it('uses onConflict: "user_id,date"', async () => {
    await syncDrinkLog(entries);
    const opts = mockUpsert.mock.calls[0][1];
    expect(opts.onConflict).toBe('user_id,date');
  });
});

// ─── 10. syncDrinkLog — empty array ──────────────────────────────────────────

describe('syncDrinkLog — empty', () => {
  it('returns true immediately without calling Supabase', async () => {
    withSession();
    mockUpsert.mockClear();
    expect(await syncDrinkLog([])).toBe(true);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

// ─── 11–14. sync_pending durability ───────────────────────────────────────────
//
// Simulates: local write succeeds → cloud fails → app killed → app reopened →
// pending flag exists → retry succeeds → exactly one upsert per entity.

describe('sync_pending — written on cloud failure', () => {
  // Spy on AsyncStorage once at describe scope; re-apply implementation
  // in beforeEach (after the global clearAllMocks resets call history).
  let store: Record<string, string | null> = {};
  const spyGetItem    = jest.spyOn(AsyncStorage, 'getItem');
  const spySetItem    = jest.spyOn(AsyncStorage, 'setItem');
  const spyRemoveItem = jest.spyOn(AsyncStorage, 'removeItem');
  const spyMultiGet   = jest.spyOn(AsyncStorage, 'multiGet');

  beforeEach(() => {
    store = {};
    spyGetItem.mockImplementation((k)         => Promise.resolve(store[k as string] ?? null));
    spySetItem.mockImplementation((k, v)      => { store[k as string] = v as string; return Promise.resolve(null); });
    spyRemoveItem.mockImplementation((k)      => { delete store[k as string]; return Promise.resolve(null); });
    spyMultiGet.mockImplementation((keys)     => Promise.resolve((keys as string[]).map((k) => [k, store[k] ?? null])));
    withSession();
  });

  afterAll(() => {
    spyGetItem.mockRestore();
    spySetItem.mockRestore();
    spyRemoveItem.mockRestore();
    spyMultiGet.mockRestore();
  });

  it('sets sync_pending = "true" when syncProfile cloud write fails', async () => {
    mockUpsert.mockResolvedValue({ error: { message: 'offline' } });
    const result = await syncProfile(BASE_PROFILE);
    expect(result).toBe(false);
    expect(store['sync_pending']).toBe('true');
  });

  it('sets sync_pending = "true" when syncTrainingGoals cloud write fails', async () => {
    mockUpsert.mockResolvedValue({ error: { message: 'offline' } });
    const result = await syncTrainingGoals({ body: 'cut', perf: 'strength' });
    expect(result).toBe(false);
    expect(store['sync_pending']).toBe('true');
  });

  it('sets sync_pending = "true" when syncContextEvents cloud write fails', async () => {
    mockUpsert.mockResolvedValue({ error: { message: 'offline' } });
    const events: import('@/services/context-events').ContextEvent[] = [
      { id: 'e1', type: 'travel', source: 'user', label: 'Trip', startDate: '2026-09-01', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
    ];
    const result = await syncContextEvents(events);
    expect(result).toBe(false);
    expect(store['sync_pending']).toBe('true');
  });

  it('sets sync_pending = "true" when syncDrinkLog cloud write fails', async () => {
    mockUpsert.mockResolvedValue({ error: { message: 'offline' } });
    const entries: import('@/utils/drink-entry').DrinkEntry[] = [
      { date: '2026-09-15', totalDrinks: 1, totalCalories: 140, vibe: null, counts: {} },
    ];
    const result = await syncDrinkLog(entries);
    expect(result).toBe(false);
    expect(store['sync_pending']).toBe('true');
  });
});

describe('retrySyncIfPending — no-op when flag absent', () => {
  let store: Record<string, string | null> = {};
  const spyGetItem  = jest.spyOn(AsyncStorage, 'getItem');
  const spyMultiGet = jest.spyOn(AsyncStorage, 'multiGet');

  beforeEach(() => {
    store = {};
    spyGetItem.mockImplementation((k)     => Promise.resolve(store[k as string] ?? null));
    spyMultiGet.mockImplementation((keys) => Promise.resolve((keys as string[]).map((k) => [k, store[k] ?? null])));
  });

  afterAll(() => {
    spyGetItem.mockRestore();
    spyMultiGet.mockRestore();
  });

  it('does not call Supabase when sync_pending is not set', async () => {
    await retrySyncIfPending();
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe('retrySyncIfPending — retries and clears flag on success', () => {
  let store: Record<string, string | null> = {};
  const spyGetItem    = jest.spyOn(AsyncStorage, 'getItem');
  const spySetItem    = jest.spyOn(AsyncStorage, 'setItem');
  const spyRemoveItem = jest.spyOn(AsyncStorage, 'removeItem');
  const spyMultiGet   = jest.spyOn(AsyncStorage, 'multiGet');

  beforeEach(() => {
    store = {};
    spyGetItem.mockImplementation((k)         => Promise.resolve(store[k as string] ?? null));
    spySetItem.mockImplementation((k, v)      => { store[k as string] = v as string; return Promise.resolve(null); });
    spyRemoveItem.mockImplementation((k)      => { delete store[k as string]; return Promise.resolve(null); });
    spyMultiGet.mockImplementation((keys)     => Promise.resolve((keys as string[]).map((k) => [k, store[k] ?? null])));
    withSession();
    mockUpsert.mockResolvedValue({ error: null });
  });

  afterAll(() => {
    spyGetItem.mockRestore();
    spySetItem.mockRestore();
    spyRemoveItem.mockRestore();
    spyMultiGet.mockRestore();
  });

  it('retries profile upsert and clears sync_pending on success', async () => {
    // Simulate: app was killed with pending flag and local profile
    store['sync_pending'] = 'true';
    store['user_profile'] = JSON.stringify(BASE_PROFILE);

    await retrySyncIfPending();

    // Exactly one upsert call for user_profiles (idempotent — only one row created)
    const profileCalls = (mockFrom.mock.calls as [string][]).filter(([t]) => t === 'user_profiles');
    expect(profileCalls).toHaveLength(1);

    // Flag cleared after success
    expect(store['sync_pending']).toBeUndefined();
  });

  it('keeps sync_pending when retry still fails', async () => {
    store['sync_pending'] = 'true';
    store['user_profile'] = JSON.stringify(BASE_PROFILE);
    // Cloud still down
    mockUpsert.mockResolvedValue({ error: { message: 'still offline' } });

    await retrySyncIfPending();

    // Flag remains set
    expect(store['sync_pending']).toBe('true');
  });

  it('does not throw when retrySyncIfPending encounters an error', async () => {
    store['sync_pending'] = 'true';
    spyMultiGet.mockRejectedValue(new Error('storage error'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(retrySyncIfPending()).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

// ─── App-startup sequence ──────────────────────────────────────────────────────
//
// Regression tests for the _layout.tsx wiring:
//   initializeAuth().then(() => retrySyncIfPending())
//
// Verifies that when a valid session is available (post-initializeAuth) and
// sync_pending is set, the retry runs and clears the flag — and that failure
// remains non-blocking.

describe('retrySyncIfPending — startup: clears pending flag when session is ready', () => {
  let store: Record<string, string | null> = {};
  const spyGetItem    = jest.spyOn(AsyncStorage, 'getItem');
  const spySetItem    = jest.spyOn(AsyncStorage, 'setItem');
  const spyRemoveItem = jest.spyOn(AsyncStorage, 'removeItem');
  const spyMultiGet   = jest.spyOn(AsyncStorage, 'multiGet');

  beforeEach(() => {
    store = {};
    spyGetItem.mockImplementation((k)     => Promise.resolve(store[k as string] ?? null));
    spySetItem.mockImplementation((k, v)  => { store[k as string] = v as string; return Promise.resolve(null); });
    spyRemoveItem.mockImplementation((k)  => { delete store[k as string]; return Promise.resolve(null); });
    spyMultiGet.mockImplementation((keys) => Promise.resolve((keys as string[]).map((k) => [k, store[k] ?? null])));
    withSession();
    mockUpsert.mockResolvedValue({ error: null });
  });

  afterAll(() => {
    spyGetItem.mockRestore();
    spySetItem.mockRestore();
    spyRemoveItem.mockRestore();
    spyMultiGet.mockRestore();
  });

  it('retries all pending writes and clears flag when called after auth', async () => {
    store['sync_pending']   = 'true';
    store['user_profile']   = JSON.stringify(BASE_PROFILE);
    store['training_goals'] = JSON.stringify({ body: 'maintain', perf: 'endurance' });

    // Simulate: initializeAuth() resolved → retrySyncIfPending() runs
    await retrySyncIfPending();

    expect(store['sync_pending']).toBeUndefined();
    const profileCalls = (mockFrom.mock.calls as [string][]).filter(([t]) => t === 'user_profiles');
    const goalsCalls   = (mockFrom.mock.calls as [string][]).filter(([t]) => t === 'training_goals');
    expect(profileCalls.length).toBeGreaterThanOrEqual(1);
    expect(goalsCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('resolves without throwing even when every upsert fails (non-blocking)', async () => {
    store['sync_pending'] = 'true';
    store['user_profile'] = JSON.stringify(BASE_PROFILE);
    mockUpsert.mockResolvedValue({ error: { message: 'network unreachable' } });

    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(retrySyncIfPending()).resolves.toBeUndefined();
    spy.mockRestore();

    // Flag remains — will retry on next launch
    expect(store['sync_pending']).toBe('true');
  });

  it('is a no-op (does not call Supabase) when sync_pending is absent', async () => {
    // No flag set — simulates a user who has never had a failed sync
    await retrySyncIfPending();
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
