/**
 * cycle-context.test.ts
 *
 * Regression tests for buildCycleContext().
 *
 * Privacy requirement: free-text notes entered by the user in the cycle
 * journal MUST NOT appear in the AI context string. Only structured fields
 * (date, energy label/score, stress label/score, signs) are permitted.
 *
 * See context-events.ts documentation and the privacy policy.
 */

import { buildCycleContext, type CycleEntry, type CycleProfile } from '../../utils/cycle-context';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<CycleEntry> = {}): CycleEntry {
  return {
    date: '2025-09-10',
    energy: 3,
    stress: 2,
    signs: [],
    notes: '',
    ...overrides,
  };
}

const NO_PROFILE: CycleProfile = { lastPeriodDate: null };
const WITH_PERIOD: CycleProfile = { lastPeriodDate: '2025-09-01' };

// ─── Privacy: notes must never appear in AI context ───────────────────────────

describe('buildCycleContext — notes privacy', () => {
  it('does not include free-text notes in the context string', () => {
    const entry = makeEntry({ notes: 'Had a terrible headache all day' });
    const result = buildCycleContext([entry], NO_PROFILE);
    expect(result).not.toContain('terrible headache');
    expect(result).not.toContain('Notes:');
  });

  it('does not include notes even when signs are also present', () => {
    const entry = makeEntry({
      signs: ['Cramping'],
      notes: 'Worst cramps this cycle, took ibuprofen',
    });
    const result = buildCycleContext([entry], NO_PROFILE);
    expect(result).not.toContain('Worst cramps');
    expect(result).not.toContain('ibuprofen');
    expect(result).not.toContain('Notes:');
    // Signs should still appear
    expect(result).toContain('Cramping');
  });

  it('does not include notes when the profile has a period date', () => {
    const entry = makeEntry({ notes: 'Feeling off today' });
    const result = buildCycleContext([entry], WITH_PERIOD);
    expect(result).not.toContain('Feeling off');
    expect(result).not.toContain('Notes:');
  });

  it('does not include notes with special characters or quotes', () => {
    const entry = makeEntry({ notes: '"Sensitive" personal detail here' });
    const result = buildCycleContext([entry], NO_PROFILE);
    expect(result).not.toContain('Sensitive');
    expect(result).not.toContain('personal detail');
  });

  it('handles multiple entries — none of their notes appear', () => {
    const entries = [
      makeEntry({ date: '2025-09-08', notes: 'Private note one' }),
      makeEntry({ date: '2025-09-09', notes: 'Private note two' }),
      makeEntry({ date: '2025-09-10', notes: 'Private note three' }),
    ];
    const result = buildCycleContext(entries, NO_PROFILE);
    expect(result).not.toContain('Private note');
    expect(result).not.toContain('Notes:');
  });
});

// ─── Structured fields ARE included ───────────────────────────────────────────

describe('buildCycleContext — structured fields included', () => {
  it('includes date, energy label and score', () => {
    const entry = makeEntry({ date: '2025-09-10', energy: 4, stress: 2 });
    const result = buildCycleContext([entry], NO_PROFILE);
    expect(result).toContain('2025-09-10');
    expect(result).toContain('Good');     // energy label for 4
    expect(result).toContain('4/5');
  });

  it('includes stress label and score', () => {
    const entry = makeEntry({ energy: 3, stress: 4 });
    const result = buildCycleContext([entry], NO_PROFILE);
    expect(result).toContain('High');   // stress label for 4
    expect(result).toContain('4/5');
  });

  it('includes signs when present', () => {
    const entry = makeEntry({ signs: ['Bloating', 'Mood shifts'] });
    const result = buildCycleContext([entry], NO_PROFILE);
    expect(result).toContain('Bloating');
    expect(result).toContain('Mood shifts');
  });

  it('omits signs section when signs array is empty', () => {
    const entry = makeEntry({ signs: [] });
    const result = buildCycleContext([entry], NO_PROFILE);
    expect(result).not.toContain('Signs:');
  });

  it('includes cycle day when period date is set', () => {
    const result = buildCycleContext([], WITH_PERIOD);
    expect(result).toContain('Cycle Day');
    expect(result).toContain('2025-09-01');
  });

  it('returns empty string when no entries and no profile', () => {
    const result = buildCycleContext([], NO_PROFILE);
    expect(result).toBe('');
  });
});
