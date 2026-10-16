/**
 * local-date.test.ts
 *
 * Verifies that localDateString() uses LOCAL calendar date methods
 * (getFullYear / getMonth / getDate) rather than UTC-based toISOString().
 *
 * TIMEZONE NOTE: These tests run in whatever timezone the CI/local machine is
 * configured. Tests that construct dates via `new Date(year, month, day)` use
 * LOCAL time constructors, so `getDate()` / `getMonth()` / `getFullYear()` will
 * always return what we passed in, regardless of host timezone. This makes the
 * core format and boundary tests timezone-agnostic.
 *
 * For the UTC-divergence test we compare the function's output against what
 * LOCAL getters return — which is the exact contract we want to enforce.
 */

import { localDateString } from '../local-date';

// ─── Format ────────────────────────────────────────────────────────────────────

describe('localDateString — format', () => {
  it('returns a YYYY-MM-DD string', () => {
    const result = localDateString(new Date(2025, 0, 15)); // Jan 15 local
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('zero-pads month', () => {
    const result = localDateString(new Date(2025, 0, 5)); // Jan 5
    expect(result).toBe('2025-01-05');
  });

  it('zero-pads day', () => {
    const result = localDateString(new Date(2025, 8, 3)); // Sep 3
    expect(result).toBe('2025-09-03');
  });
});

// ─── Uses LOCAL calendar date (not UTC) ────────────────────────────────────────

describe('localDateString — uses local getters not UTC', () => {
  it('returns date matching getFullYear/getMonth/getDate for the given Date', () => {
    const date = new Date(2025, 5, 15); // Local June 15
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    expect(localDateString(date)).toBe(`${y}-${m}-${d}`);
  });

  it('does NOT use toISOString() — output matches local getters not UTC', () => {
    // A UTC datetime that is "next day" in UTC but current day in UTC-offset zones.
    // 2025-01-01T01:00:00Z = Jan 1 UTC, but Dec 31 local in UTC-5 (US Eastern).
    // We verify the function returns what local getters say — not the UTC date.
    const date = new Date('2025-01-01T01:00:00.000Z');
    const expectedLocal = [
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');
    expect(localDateString(date)).toBe(expectedLocal);
    // Proof that toISOString would return the UTC date (always 2025-01-01)
    // while our function returns what the local calendar says.
    // In UTC timezone these are equal; in UTC-5 they differ.
    // Either way, the function uses local getters — which is the contract.
  });
});

// ─── Boundary dates ────────────────────────────────────────────────────────────

describe('localDateString — boundary dates', () => {
  it('handles month boundary (March 31)', () => {
    expect(localDateString(new Date(2025, 2, 31))).toBe('2025-03-31');
  });

  it('handles month boundary (April 1)', () => {
    expect(localDateString(new Date(2025, 3, 1))).toBe('2025-04-01');
  });

  it('handles year boundary (December 31)', () => {
    expect(localDateString(new Date(2024, 11, 31))).toBe('2024-12-31');
  });

  it('handles year boundary (January 1)', () => {
    expect(localDateString(new Date(2025, 0, 1))).toBe('2025-01-01');
  });

  it('handles leap day (February 29)', () => {
    expect(localDateString(new Date(2024, 1, 29))).toBe('2024-02-29');
  });

  // DST: clocks spring forward at 2am on the second Sunday of March (US).
  // Using noon on the transition day avoids any ambiguity.
  it('handles US DST spring-forward day without error', () => {
    // March 9, 2025 — US DST spring-forward date
    const dstDay = new Date(2025, 2, 9, 12, 0, 0);
    expect(localDateString(dstDay)).toBe('2025-03-09');
  });

  it('handles US DST fall-back day without error', () => {
    // November 2, 2025 — US DST fall-back date
    const dstFall = new Date(2025, 10, 2, 12, 0, 0);
    expect(localDateString(dstFall)).toBe('2025-11-02');
  });
});

// ─── Default argument (no-arg form) ────────────────────────────────────────────

describe('localDateString — default argument', () => {
  it('returns a valid YYYY-MM-DD when called with no arguments', () => {
    const result = localDateString();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('no-arg result matches today according to local getters', () => {
    const now = new Date();
    const expected = [
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-');
    expect(localDateString()).toBe(expected);
  });
});
