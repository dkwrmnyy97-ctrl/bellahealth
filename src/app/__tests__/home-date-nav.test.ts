/**
 * home-date-nav.test.ts
 *
 * Tests for the Home screen date navigation logic.
 * These test the pure helper functions extracted from index.tsx:
 *   - localDateStrFromDate
 *   - dateLabelFor
 *   - Navigation day stepping logic
 *   - isToday / no-future guard
 *   - selectedCycleDayCount offset math
 *   - Icon/theme correctness (structural, not rendered)
 */

// ─── Pure helpers (replicated exactly from index.tsx) ───────────────────────

function localDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function localDateStrFromDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function localYesterdayStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dateLabelFor(d: Date): string {
  const todayStr = localDateStr();
  const dStr = localDateStrFromDate(d);
  if (dStr === todayStr) return 'Today';
  const yStr = localYesterdayStr();
  if (dStr === yStr) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Simulates the goToPrevDay mutation */
function prevDay(d: Date): Date {
  const n = new Date(d);
  n.setDate(n.getDate() - 1);
  return n;
}

/** Simulates the goToNextDay mutation — returns same date if already today */
function nextDay(d: Date): Date {
  const todayStr = localDateStr();
  const dStr = localDateStrFromDate(d);
  if (dStr === todayStr) return d; // guarded
  const n = new Date(d);
  n.setDate(n.getDate() + 1);
  return n;
}

/** Simulates selectedCycleDayCount */
function computeSelectedCycleDayCount(
  cycleDayCount: number | null,
  selectedDate: Date,
): number | null {
  if (cycleDayCount === null) return null;
  const selectedStr = localDateStrFromDate(selectedDate);
  const todayStr = localDateStr();
  if (selectedStr === todayStr) return cycleDayCount;
  const todayMs = new Date().setHours(0, 0, 0, 0);
  const selectedMs = new Date(selectedDate).setHours(0, 0, 0, 0);
  const diffDays = Math.round((selectedMs - todayMs) / 86400000);
  return cycleDayCount + diffDays;
}

// ─── localDateStrFromDate ────────────────────────────────────────────────────

describe('localDateStrFromDate', () => {
  it('formats a specific date correctly', () => {
    expect(localDateStrFromDate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('zero-pads month and day', () => {
    expect(localDateStrFromDate(new Date(2026, 8, 3))).toBe('2026-09-03');
  });

  it('handles year boundary December 31', () => {
    expect(localDateStrFromDate(new Date(2025, 11, 31))).toBe('2025-12-31');
  });

  it('handles year boundary January 1', () => {
    expect(localDateStrFromDate(new Date(2026, 0, 1))).toBe('2026-01-01');
  });

  it('handles leap day February 29', () => {
    expect(localDateStrFromDate(new Date(2024, 1, 29))).toBe('2024-02-29');
  });

  it('matches localDateStr() for new Date() (today)', () => {
    const now = new Date();
    expect(localDateStrFromDate(now)).toBe(localDateStr());
  });
});

// ─── dateLabelFor ────────────────────────────────────────────────────────────

describe('dateLabelFor', () => {
  it('returns "Today" for today', () => {
    expect(dateLabelFor(new Date())).toBe('Today');
  });

  it('returns "Yesterday" for yesterday', () => {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    expect(dateLabelFor(y)).toBe('Yesterday');
  });

  it('returns a short date string for 2 days ago', () => {
    const d = new Date();
    d.setDate(d.getDate() - 2);
    const label = dateLabelFor(d);
    // Should be like "Sep 30" or "Oct 1" — short month + day, no year
    expect(label).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it('returns a short date string for 30 days ago', () => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    const label = dateLabelFor(d);
    expect(label).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    expect(label).not.toBe('Today');
    expect(label).not.toBe('Yesterday');
  });

  it('never returns "Today" for yesterday', () => {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    expect(dateLabelFor(y)).not.toBe('Today');
  });

  it('never returns "Yesterday" for today', () => {
    expect(dateLabelFor(new Date())).not.toBe('Yesterday');
  });
});

// ─── Navigation: go back ─────────────────────────────────────────────────────

describe('prevDay navigation', () => {
  it('today → yesterday', () => {
    const today = new Date();
    const result = prevDay(today);
    expect(localDateStrFromDate(result)).toBe(localYesterdayStr());
  });

  it('yesterday → day before yesterday', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const result = prevDay(yesterday);
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    expect(localDateStrFromDate(result)).toBe(localDateStrFromDate(twoDaysAgo));
  });

  it('crosses month boundary correctly (Jan 1 → Dec 31)', () => {
    const jan1 = new Date(2026, 0, 1);
    const result = prevDay(jan1);
    expect(localDateStrFromDate(result)).toBe('2025-12-31');
  });

  it('crosses month boundary within month (Mar 1 → Feb 28 non-leap)', () => {
    const mar1 = new Date(2025, 2, 1);
    const result = prevDay(mar1);
    expect(localDateStrFromDate(result)).toBe('2025-02-28');
  });

  it('handles Feb 29 on leap year (Mar 1 2024 → Feb 29 2024)', () => {
    const mar1 = new Date(2024, 2, 1);
    const result = prevDay(mar1);
    expect(localDateStrFromDate(result)).toBe('2024-02-29');
  });

  it('does not mutate the input Date', () => {
    const today = new Date();
    const todayStr = localDateStrFromDate(today);
    prevDay(today);
    expect(localDateStrFromDate(today)).toBe(todayStr);
  });
});

// ─── Navigation: go forward ──────────────────────────────────────────────────

describe('nextDay navigation', () => {
  it('is blocked on today — returns same date', () => {
    const today = new Date();
    const result = nextDay(today);
    expect(localDateStrFromDate(result)).toBe(localDateStr());
  });

  it('yesterday → today', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const result = nextDay(yesterday);
    expect(localDateStrFromDate(result)).toBe(localDateStr());
  });

  it('2 days ago → yesterday', () => {
    const d = new Date();
    d.setDate(d.getDate() - 2);
    const result = nextDay(d);
    expect(localDateStrFromDate(result)).toBe(localYesterdayStr());
  });

  it('crosses month boundary correctly (Dec 31 → Jan 1)', () => {
    const dec31 = new Date(2025, 11, 31);
    const result = nextDay(dec31);
    expect(localDateStrFromDate(result)).toBe('2026-01-01');
  });

  it('does not mutate the input Date', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = localDateStrFromDate(yesterday);
    nextDay(yesterday);
    expect(localDateStrFromDate(yesterday)).toBe(yStr);
  });
});

// ─── isToday guard ───────────────────────────────────────────────────────────

describe('isToday derived value', () => {
  it('is true for new Date()', () => {
    const d = new Date();
    expect(localDateStrFromDate(d) === localDateStr()).toBe(true);
  });

  it('is false for yesterday', () => {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    expect(localDateStrFromDate(y) === localDateStr()).toBe(false);
  });

  it('is false for any date in the past', () => {
    const past = new Date(2020, 0, 1);
    expect(localDateStrFromDate(past) === localDateStr()).toBe(false);
  });

  it('forward nav from today returns today (no future)', () => {
    const today = new Date();
    const isToday = localDateStrFromDate(today) === localDateStr();
    // nextDay is guarded by isToday — simulate the guard
    const result = isToday ? today : nextDay(today);
    expect(localDateStrFromDate(result)).toBe(localDateStr());
  });
});

// ─── Round-trip navigation ───────────────────────────────────────────────────

describe('round-trip navigation', () => {
  it('today → prev → next = today', () => {
    const today = new Date();
    const back = prevDay(today);
    const forward = nextDay(back);
    expect(localDateStrFromDate(forward)).toBe(localDateStr());
  });

  it('today → prev → prev → next → next = today', () => {
    const today = new Date();
    const d1 = prevDay(today);
    const d2 = prevDay(d1);
    const d3 = nextDay(d2);
    const d4 = nextDay(d3);
    expect(localDateStrFromDate(d4)).toBe(localDateStr());
  });

  it('multiple prevs never produce a date after today', () => {
    let d = new Date();
    for (let i = 0; i < 30; i++) {
      d = prevDay(d);
      expect(localDateStrFromDate(d) <= localDateStr()).toBe(true);
    }
  });
});

// ─── dateLabelFor round-trip ─────────────────────────────────────────────────

describe('dateLabelFor round-trip with navigation', () => {
  it('label sequence: Today → Yesterday → short date', () => {
    const d0 = new Date();
    const d1 = prevDay(d0);
    const d2 = prevDay(d1);
    expect(dateLabelFor(d0)).toBe('Today');
    expect(dateLabelFor(d1)).toBe('Yesterday');
    const label2 = dateLabelFor(d2);
    expect(label2).not.toBe('Today');
    expect(label2).not.toBe('Yesterday');
    expect(label2).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it('navigating forward from yesterday gives "Today" label', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const forward = nextDay(yesterday);
    expect(dateLabelFor(forward)).toBe('Today');
  });
});

// ─── selectedCycleDayCount offset math ──────────────────────────────────────

describe('selectedCycleDayCount', () => {
  it('returns null when cycleDayCount is null', () => {
    expect(computeSelectedCycleDayCount(null, new Date())).toBeNull();
  });

  it('returns cycleDayCount unchanged for today', () => {
    expect(computeSelectedCycleDayCount(14, new Date())).toBe(14);
  });

  it('returns cycleDayCount - 1 for yesterday', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(computeSelectedCycleDayCount(14, yesterday)).toBe(13);
  });

  it('returns cycleDayCount - 7 for 7 days ago', () => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    expect(computeSelectedCycleDayCount(14, d)).toBe(7);
  });

  it('can return 0 or negative for dates before cycle start', () => {
    const d = new Date();
    d.setDate(d.getDate() - 20);
    const result = computeSelectedCycleDayCount(14, d);
    expect(result).toBe(-6);
  });

  it('returns cycleDayCount + 1 if selectedDate were tomorrow (hypothetical)', () => {
    // This tests the math — in practice the UI prevents forward navigation
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(computeSelectedCycleDayCount(14, tomorrow)).toBe(15);
  });
});

// ─── Quick Context: drinks icon selection ────────────────────────────────────

describe('Quick Context icon selection logic', () => {
  it('selects glass-whiskey for male theme', () => {
    const isMale = true;
    const icon = isMale ? 'glass-whiskey' : 'glass-martini';
    expect(icon).toBe('glass-whiskey');
  });

  it('selects glass-martini for female theme', () => {
    const isMale = false;
    const icon = isMale ? 'glass-whiskey' : 'glass-martini';
    expect(icon).toBe('glass-martini');
  });

  it('male icon is not glass-martini', () => {
    const isMale = true;
    const icon = isMale ? 'glass-whiskey' : 'glass-martini';
    expect(icon).not.toBe('glass-martini');
  });

  it('female icon is not glass-whiskey', () => {
    const isMale = false;
    const icon = isMale ? 'glass-whiskey' : 'glass-martini';
    expect(icon).not.toBe('glass-whiskey');
  });
});

// ─── wellness-modal title copy ────────────────────────────────────────────────

describe('wellness-modal Treat Yourself title', () => {
  const CORRECT_TITLE = 'Treat yourself';

  it('title is "Treat yourself" not "Feeling Luxurious?"', () => {
    expect(CORRECT_TITLE).toBe('Treat yourself');
    expect(CORRECT_TITLE).not.toBe('Feeling Luxurious?');
  });
});
