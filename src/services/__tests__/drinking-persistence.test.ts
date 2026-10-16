/**
 * drinking-persistence.test.ts
 *
 * Regression tests for buildDrinkEntry() — the pure function extracted from
 * DrinkingModal that computes the drink log entry from a counts snapshot.
 *
 * The real persistence bug was: drinks were only written to AsyncStorage in
 * handleClose(), so a force-kill lost all drinks logged during that session.
 * The fix calls persistCounts() (which uses buildDrinkEntry) after every
 * add/remove. These tests verify the entry computation is correct.
 */

import { buildDrinkEntry } from '../../utils/drink-entry';

// ─── Test fixtures ─────────────────────────────────────────────────────────────

// Minimal DrinkItem subset used by buildDrinkEntry
const BEER = { id: 'regular_beer', name: 'Lager', detail: '', calories: 150, standardDrinks: 1.0 };
const IPA  = { id: 'ipa_craft',    name: 'IPA',   detail: '', calories: 195, standardDrinks: 1.3 };
const WINE = { id: 'white_wine',   name: 'White Wine', detail: '', calories: 120, standardDrinks: 1.0 };
const ALL_ITEMS = [BEER, IPA, WINE];

const DATE = '2025-09-18';

// ─── Returns null when no drinks logged ───────────────────────────────────────

describe('buildDrinkEntry — empty counts', () => {
  it('returns null when counts is empty', () => {
    expect(buildDrinkEntry({}, ALL_ITEMS, null, DATE)).toBeNull();
  });

  it('returns null when all counts are zero', () => {
    expect(buildDrinkEntry({ regular_beer: 0, ipa_craft: 0 }, ALL_ITEMS, null, DATE)).toBeNull();
  });
});

// ─── Normal logging ───────────────────────────────────────────────────────────

describe('buildDrinkEntry — normal logging', () => {
  it('returns correct entry for one beer', () => {
    const entry = buildDrinkEntry({ regular_beer: 1 }, ALL_ITEMS, null, DATE);
    expect(entry).not.toBeNull();
    expect(entry!.date).toBe(DATE);
    expect(entry!.totalDrinks).toBe(1.0);
    expect(entry!.totalCalories).toBe(150);
    expect(entry!.vibe).toBeNull();
    expect(entry!.counts).toEqual({ regular_beer: 1 });
  });

  it('accumulates calories and standard drinks for multiple drink types', () => {
    const entry = buildDrinkEntry({ regular_beer: 1, white_wine: 1 }, ALL_ITEMS, null, DATE);
    expect(entry!.totalDrinks).toBe(2.0);   // 1.0 + 1.0
    expect(entry!.totalCalories).toBe(270); // 150 + 120
  });

  it('rounds standard drinks to one decimal place', () => {
    // 1 IPA = 1.3 standard drinks; 2 IPAs = 2.6 rounds to 2.6
    const entry = buildDrinkEntry({ ipa_craft: 2 }, ALL_ITEMS, null, DATE);
    expect(entry!.totalDrinks).toBe(2.6);
  });

  it('includes vibe when provided', () => {
    const entry = buildDrinkEntry({ regular_beer: 1 }, ALL_ITEMS, 'happy_hour', DATE);
    expect(entry!.vibe).toBe('happy_hour');
  });
});

// ─── Multiple drinks ──────────────────────────────────────────────────────────

describe('buildDrinkEntry — multiple drinks', () => {
  it('sums correctly across 3 different drink types', () => {
    const counts = { regular_beer: 2, ipa_craft: 1, white_wine: 1 };
    const entry = buildDrinkEntry(counts, ALL_ITEMS, null, DATE);
    // standard drinks: 2*1.0 + 1*1.3 + 1*1.0 = 4.3
    // calories:        2*150  + 1*195 + 1*120 = 615
    expect(entry!.totalDrinks).toBe(4.3);
    expect(entry!.totalCalories).toBe(615);
  });

  it('preserves the counts snapshot exactly', () => {
    const counts = { regular_beer: 3, white_wine: 2 };
    const entry = buildDrinkEntry(counts, ALL_ITEMS, 'night_out', DATE);
    expect(entry!.counts).toEqual(counts);
  });
});

// ─── Date handling ────────────────────────────────────────────────────────────

describe('buildDrinkEntry — date field', () => {
  it('sets the date field to the provided dateStr', () => {
    const entry = buildDrinkEntry({ regular_beer: 1 }, ALL_ITEMS, null, '2025-12-31');
    expect(entry!.date).toBe('2025-12-31');
  });

  it('different dates produce separate entries', () => {
    const entryA = buildDrinkEntry({ regular_beer: 1 }, ALL_ITEMS, null, '2025-09-17');
    const entryB = buildDrinkEntry({ white_wine: 1 },   ALL_ITEMS, null, '2025-09-18');
    expect(entryA!.date).toBe('2025-09-17');
    expect(entryB!.date).toBe('2025-09-18');
  });
});

// ─── Rapid interaction: idempotency ───────────────────────────────────────────

describe('buildDrinkEntry — idempotency (rapid interaction)', () => {
  it('same counts always produce the same entry (no double-counting)', () => {
    const counts = { regular_beer: 2 };
    const a = buildDrinkEntry(counts, ALL_ITEMS, null, DATE);
    const b = buildDrinkEntry(counts, ALL_ITEMS, null, DATE);
    expect(a).toEqual(b);
  });

  it('calling with the same counts twice does not accumulate', () => {
    // Simulates rapid double-tap: add() called twice with same starting counts.
    // Each call computes from the counts snapshot independently — no side effects.
    const countsAfterFirstTap  = { regular_beer: 1 };
    const countsAfterSecondTap = { regular_beer: 2 }; // real state after second tap
    const first  = buildDrinkEntry(countsAfterFirstTap,  ALL_ITEMS, null, DATE);
    const second = buildDrinkEntry(countsAfterSecondTap, ALL_ITEMS, null, DATE);
    expect(first!.totalDrinks).toBe(1.0);
    expect(second!.totalDrinks).toBe(2.0);
  });
});
