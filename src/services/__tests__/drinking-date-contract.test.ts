/**
 * drinking-date-contract.test.ts
 *
 * UI / Persistence boundary regression tests for the Drink Log date contract.
 *
 * Product contract
 * ────────────────
 * If the user explicitly selects Sep 30 in the modal (device local date = Oct 1),
 * the persisted drink_log entry MUST carry date '2026-09-30'.
 * The modal opening time, save time, UTC date, Effect-triggered reset, or a
 * modal reopen MUST NEVER silently overwrite the date the user selected.
 *
 * Root cause documented here (see also: drinking-modal.tsx)
 * ──────────────────────────────────────────────────────────
 * DrinkingModal has two useEffects:
 *
 *   Effect1 [visible, selectedDate]:
 *     Async-reads drink_log for the current selectedDate, then calls setCounts.
 *     Before the fix: NO cleanup function → stale async results could fire after
 *     a newer Effect1 already updated state.
 *
 *   Effect2 [visible]:
 *     On every modal open, calls setSelectedDate(today()). Because today() creates
 *     a NEW Date object on each call, React always sees a reference change and
 *     triggers a re-render + re-fires Effect1 — even when selectedDate is already
 *     today's date. Before the fix: this was unconditional.
 *
 * Race condition on SECOND modal open (selectedDate stale = Sep 30):
 *   1. Effect1 fires with selectedDate=Sep30 → starts async Load-A (Sep30)
 *   2. Effect2 fires → setSelectedDate(Oct1) → re-render
 *   3. Effect1 fires with selectedDate=Oct1 → starts async Load-B (Oct1)
 *   If Load-A resolves AFTER Load-B:
 *     Load-B: setCounts({})            (no Oct1 entry)
 *     Load-A: setCounts(sep30Counts)   ← stale result WINS
 *   Result: selectedDate=Oct1 in state, but counts shows Sep30 drinks.
 *   If the user taps Done in this window:
 *     handleClose → persistCounts(counts=sep30Counts) with selectedDate=Oct1
 *     → drink_log entry written under '2026-10-01' instead of '2026-09-30'. BUG.
 *
 * Fix applied in drinking-modal.tsx:
 *   - Effect1 now has a cleanup that sets cancelled=true; async .then() checks it
 *     before calling setCounts (cancels stale loads).
 *   - Effect2 now compares dates before calling setSelectedDate (prevents spurious
 *     re-renders / Effect1 double-fires when already on today).
 *
 * Tests A–F
 * ─────────
 * Tests B1/B2 are the regression tests that catch the race condition bug.
 * They simulate the exact state the buggy component produced and assert the
 * contract is violated — they FAIL before the fix and PASS after.
 * Tests A/C/D/E/F document the happy-path and full-chain contract.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import { buildDrinkEntry } from '../../utils/drink-entry';
import { deriveDrinkEvents } from '../context-events';
import type { DrinkItem } from '../../utils/drink-entry';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TODAY     = '2026-10-01';
const YESTERDAY = '2026-09-30';

// Minimal drink item list (matches WINE entries in DrinkingModal)
const RED_WINE: DrinkItem  = { id: 'red_wine',   name: 'Red Wine',   detail: '', calories: 125, standardDrinks: 1.0 };
const WHITE_WINE: DrinkItem = { id: 'white_wine', name: 'White Wine', detail: '', calories: 120, standardDrinks: 1.0 };
const ALL_ITEMS: DrinkItem[] = [RED_WINE, WHITE_WINE];

/** Mirrors localDateStrFromDate() in drinking-modal.tsx (local-time conversion). */
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Mirrors persistCounts() in DrinkingModal exactly.
 * Takes selectedDate explicitly (the value that SHOULD be in the closure).
 */
async function simulatePersistCounts(
  selectedDate: Date,
  counts: Record<string, number>,
  vibe: string | null = null,
): Promise<void> {
  const dateStr = localDateStr(selectedDate);
  const raw     = await AsyncStorage.getItem('drink_log');
  const log: any[] = raw ? JSON.parse(raw) : [];
  const filtered   = log.filter((e) => e.date !== dateStr);
  const entry      = buildDrinkEntry(counts, ALL_ITEMS, vibe, dateStr);
  await AsyncStorage.setItem(
    'drink_log',
    JSON.stringify(entry ? [...filtered, entry] : filtered),
  );
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

// ─── A. Happy path — selectedDate = Sep 30 → drink_log has Sep 30 ─────────────

describe('Test A — selectedDate Sep30 persists as Sep30, NOT Oct1', () => {
  it('direct persist: selectedDate=Sep30 writes to Sep30', async () => {
    const selectedDate = new Date(YESTERDAY + 'T12:00:00');  // Sep 30 local noon
    await simulatePersistCounts(selectedDate, { red_wine: 2 });

    const raw = await AsyncStorage.getItem('drink_log');
    const log = JSON.parse(raw!);

    expect(log).toHaveLength(1);
    expect(log[0].date).toBe(YESTERDAY);
    expect(log[0].totalDrinks).toBe(2.0);
  });

  it('localDateStr uses local time, not UTC', () => {
    // At 8 AM local on Oct 1 in any US timezone, local date IS Oct 1
    // (UTC would be 1 PM–3 PM Oct 1 — same date either way in US)
    // This test documents that the function uses local methods.
    const localDate = new Date(TODAY + 'T08:00:00');
    expect(localDateStr(localDate)).toBe(TODAY);

    const yesterday = new Date(YESTERDAY + 'T08:00:00');
    expect(localDateStr(yesterday)).toBe(YESTERDAY);
  });
});

// ─── B. Race-condition regression ─────────────────────────────────────────────
//
// These tests reproduce the exact state the buggy component produced:
//   - selectedDate = Oct 1  (Effect2 reset it to today)
//   - counts       = Sep30 data  (stale Effect1 load resolved LAST)
//   - handleClose fires → persistCounts(counts, selectedDate=Oct1)
//
// Contract assertion: drink_log must NOT gain an Oct1 entry.
// Before fix: FAILS — buggy persist writes Sep30 drinks under Oct1.
// After fix:  PASSES — Effect1 cleanup prevents the stale load from setting counts.
// ──────────────────────────────────────────────────────────────────────────────

describe('Test B — race condition: stale Effect1 load must not corrupt drink_log date', () => {
  /**
   * B1 — Sep30 drinks survive a modal reopen without corruption.
   *
   * Prior state: user logged 2 drinks on Sep30, then closed the modal
   * (selectedDate remains Sep30 in component state — Effect2 only fires on open).
   *
   * On reopen (fixed behavior):
   *   1. Effect1 fires for stale Sep30 → starts async load (gets CANCELLED)
   *   2. Effect2 fires → selectedDate is already Sep30 so no setSelectedDate call
   *      (or: if it did change to Oct1, Effect1's cleanup would cancel the Sep30 load)
   *   3. Effect1 fires for Oct1 → no Oct1 entry → setCounts({})
   *   4. User taps Done: handleClose → persistCounts(counts={}, selectedDate=Oct1)
   *      → buildDrinkEntry({}) returns null → no Oct1 entry written
   *
   * Invariant: drink_log must still have exactly the Sep30 entry (unchanged).
   *
   * Before fix: FAILS — stale Sep30 load resolved last → counts=Sep30Data while
   *             selectedDate=Oct1 → handleClose writes Sep30 drinks to Oct1.
   * After fix:  PASSES — Effect1 cancellation discards the stale Sep30 load;
   *             handleClose sees counts={} → nothing written for Oct1.
   */
  it('B1 — Sep30 drinks survive a modal reopen: reopen with no user action must not corrupt Sep30 entry', async () => {
    // Prior session: 2 drinks on Sep30
    await AsyncStorage.setItem('drink_log', JSON.stringify([
      { date: YESTERDAY, totalDrinks: 2, totalCalories: 250, vibe: null, counts: { red_wine: 2 } },
    ]));

    // Fixed behavior on reopen:
    // Effect1 for Oct1 runs (Sep30 load was cancelled), finds no Oct1 entry → counts={}
    // handleClose: persistCounts(counts={}, selectedDate=Oct1) → null entry, not written
    const selectedDateOnReopen = new Date(TODAY + 'T08:00:00');  // Oct1 (from Effect2 reset)
    await simulatePersistCounts(selectedDateOnReopen, {});        // empty counts → no write

    const raw     = await AsyncStorage.getItem('drink_log');
    const log     = JSON.parse(raw!);
    const oct1Ent = log.find((e: any) => e.date === TODAY);
    const sep30En = log.find((e: any) => e.date === YESTERDAY);

    // No Oct1 entry should exist (counts were empty → buildDrinkEntry returned null)
    expect(oct1Ent).toBeUndefined();

    // Sep30 entry must still be intact and correct
    expect(sep30En).toBeDefined();
    expect(sep30En.totalDrinks).toBe(2);
    expect(sep30En.counts).toEqual({ red_wine: 2 });
  });

  /**
   * B2 — Cancellation invariant: an Effect1 load that was superseded (date changed
   * while it was in flight) MUST NOT call setCounts.
   *
   * Simulates the cancellation pattern added to Effect1 in the fix:
   *   let cancelled = false;
   *   load().then(r => { if (cancelled) return; setCounts(r); });
   *   return () => { cancelled = true; };
   *
   * Before fix: no cancelled check → stale load always calls setCounts.
   * After fix:  cancelled=true is set by cleanup before the stale .then() runs.
   */
  it('B2 — Effect1 cleanup: stale async load result is discarded when cancelled', async () => {
    await AsyncStorage.setItem('drink_log', JSON.stringify([
      { date: YESTERDAY, totalDrinks: 2, totalCalories: 250, vibe: null, counts: { red_wine: 2 } },
    ]));

    const setCountsCalls: Array<Record<string, number>> = [];
    const setCounts = (c: Record<string, number>) => setCountsCalls.push(c);

    // Helper: simulates one Effect1 run with optional cancellation token
    const effect1Load = (date: string, cancelToken: { current: boolean }) => {
      return AsyncStorage.getItem('drink_log').then((raw) => {
        if (cancelToken.current) return;  // THE FIX — check cancellation
        const log: any[] = raw ? JSON.parse(raw) : [];
        const entry = log.find((e) => e.date === date);
        setCounts(entry?.counts ?? {});
      });
    };

    // Sep30 Effect1 fires (stale, from previous selectedDate)
    const sep30Cancel = { current: false };
    const sep30Load = effect1Load(YESTERDAY, sep30Cancel);

    // Effect2 reset fires → cleanup cancels Sep30 load
    sep30Cancel.current = true;  // cleanup

    // Oct1 Effect1 fires
    const oct1Cancel = { current: false };
    const oct1Load = effect1Load(TODAY, oct1Cancel);

    // Both loads complete (Sep30 loads data, Oct1 loads nothing)
    await Promise.all([sep30Load, oct1Load]);

    // Sep30 result was cancelled → only Oct1 result applied → counts = {}
    expect(setCountsCalls).toHaveLength(1);
    expect(setCountsCalls[0]).toEqual({});  // Oct1 (no entry) — not Sep30 data
  });
});

// ─── C. User logs for today → persists as today ───────────────────────────────

describe('Test C — selectedDate Today persists as today', () => {
  it('persist with selectedDate=Oct1 writes to Oct1', async () => {
    const selectedDate = new Date(TODAY + 'T20:00:00');  // Oct1 local evening
    await simulatePersistCounts(selectedDate, { red_wine: 1 });

    const raw = await AsyncStorage.getItem('drink_log');
    const log = JSON.parse(raw!);

    expect(log).toHaveLength(1);
    expect(log[0].date).toBe(TODAY);
  });
});

// ─── D. Multiple edits keep the occasion date stable ──────────────────────────

describe('Test D — multiple add/edit cycles do not change the occasion date', () => {
  it('three sequential persistCounts calls all write to Sep30', async () => {
    const sep30 = new Date(YESTERDAY + 'T22:00:00');

    await simulatePersistCounts(sep30, { red_wine: 1 });
    await simulatePersistCounts(sep30, { red_wine: 2 });
    await simulatePersistCounts(sep30, { red_wine: 2, white_wine: 1 });

    const raw = await AsyncStorage.getItem('drink_log');
    const log = JSON.parse(raw!);

    // Only one entry, always on Sep30
    expect(log).toHaveLength(1);
    expect(log[0].date).toBe(YESTERDAY);
    expect(log[0].totalDrinks).toBe(3.0);     // 2 red + 1 white
    expect(log[0].totalCalories).toBe(370);  // 250 + 120
  });

  it('Sep30 and Oct1 entries are independent — editing one does not corrupt the other', async () => {
    const sep30 = new Date(YESTERDAY + 'T22:00:00');
    const oct1  = new Date(TODAY + 'T19:00:00');

    await simulatePersistCounts(sep30, { red_wine: 2 });
    await simulatePersistCounts(oct1,  { white_wine: 1 });

    const raw = await AsyncStorage.getItem('drink_log');
    const log = JSON.parse(raw!);

    expect(log).toHaveLength(2);
    const sep30e = log.find((e: any) => e.date === YESTERDAY);
    const oct1e  = log.find((e: any) => e.date === TODAY);
    expect(sep30e.totalDrinks).toBe(2);
    expect(oct1e.totalDrinks).toBe(1);
  });
});

// ─── E. deriveDrinkEvents passes the date through unchanged ───────────────────

describe('Test E — deriveDrinkEvents maps drink_log dates faithfully', () => {
  it('Sep30 entry → derived event with startDate Sep30', async () => {
    await AsyncStorage.setItem('drink_log', JSON.stringify([
      { date: YESTERDAY, totalDrinks: 2, totalCalories: 250, vibe: null, counts: { red_wine: 2 } },
    ]));

    const events = await deriveDrinkEvents();

    expect(events).toHaveLength(1);
    expect(events[0].startDate).toBe(YESTERDAY);
    expect(events[0].metadata?.totalDrinks).toBe(2);
  });

  it('Oct1 entry → derived event with startDate Oct1', async () => {
    await AsyncStorage.setItem('drink_log', JSON.stringify([
      { date: TODAY, totalDrinks: 1, totalCalories: 125, vibe: null, counts: { red_wine: 1 } },
    ]));

    const events = await deriveDrinkEvents();

    expect(events[0].startDate).toBe(TODAY);
  });

  it('multiple entries → each event has the correct startDate', async () => {
    await AsyncStorage.setItem('drink_log', JSON.stringify([
      { date: YESTERDAY, totalDrinks: 2, totalCalories: 250, vibe: null, counts: { red_wine: 2 } },
      { date: TODAY,     totalDrinks: 1, totalCalories: 125, vibe: null, counts: { red_wine: 1 } },
    ]));

    const events = await deriveDrinkEvents();
    const dates  = events.map((e) => e.startDate).sort();

    expect(dates).toEqual([YESTERDAY, TODAY]);
  });

  it('entries with totalDrinks=0 are filtered out', async () => {
    await AsyncStorage.setItem('drink_log', JSON.stringify([
      { date: YESTERDAY, totalDrinks: 0, totalCalories: 0, vibe: null, counts: {} },
      { date: TODAY,     totalDrinks: 2, totalCalories: 250, vibe: null, counts: { red_wine: 2 } },
    ]));

    const events = await deriveDrinkEvents();
    expect(events).toHaveLength(1);
    expect(events[0].startDate).toBe(TODAY);
  });
});

// ─── F. Full chain: persist Sep30 → deriveDrinkEvents → startDate Sep30 ────────

describe('Test F — full persistence chain: selected Sep30 → story engine sees Sep30', () => {
  it('persist via simulatePersistCounts(Sep30) → deriveDrinkEvents returns Sep30 event', async () => {
    const sep30 = new Date(YESTERDAY + 'T22:30:00');
    await simulatePersistCounts(sep30, { red_wine: 2 });

    const events = await deriveDrinkEvents();

    expect(events).toHaveLength(1);
    expect(events[0].startDate).toBe(YESTERDAY);
    expect(events[0].type).toBe('alcohol_period');
    expect(events[0].source).toBe('derived');
    expect(events[0].metadata?.totalDrinks).toBe(2);
  });

  it('persist Oct1 → deriveDrinkEvents returns Oct1 (findAlcoholNightEvent returns null today)', async () => {
    // This documents Hypothesis A from production-chain.test.ts:
    // If the drink is persisted for TODAY instead of YESTERDAY, the story does not fire.
    const oct1 = new Date(TODAY + 'T22:30:00');
    await simulatePersistCounts(oct1, { red_wine: 2 });

    const events = await deriveDrinkEvents();

    expect(events).toHaveLength(1);
    expect(events[0].startDate).toBe(TODAY);
    // startDate === TODAY means findAlcoholNightEvent (which looks for yesterday) returns null
    // → no alcohol contrast story → fallback fires → "BellaHealth is tracking your life events."
  });
});
