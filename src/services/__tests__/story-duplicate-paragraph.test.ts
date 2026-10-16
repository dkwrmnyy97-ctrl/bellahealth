/**
 * story-duplicate-paragraph.test.ts
 *
 * Regression: tester report (Oct 2026) — Your Story showed
 *   "Sleep is running lower than your usual range, while readiness looks favorable."
 * twice in a row, followed by the recovery closing line.
 *
 * Cause: renderStoryEpisode() rendered renderPhysiologicalStateLayer() in the
 * setup slot (no event context) AND again in slot 4 (conflicting physio state).
 *
 * Runs through buildEnhancedStoryWithKey() — the same call YourStory makes.
 */

import { buildEnhancedStoryWithKey, collapseRepeatedParagraphs } from '../../utils/pattern-language';
import type { HealthDayRecord } from '../pattern-engine';
import type { SynthesisResult } from '../context-synthesis';

const TODAY = '2026-09-23';
const NOW   = new Date(TODAY + 'T15:00:00');

function pastDate(daysAgo: number): string {
  const d = new Date(TODAY + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

const SYNTHESIS: SynthesisResult = {
  generatedAt:        TODAY + 'T00:00:00Z',
  primaryTheme:       { theme: 'mixed_signals', rationale: [] },
  supportingSignals:  [],
  concerningSignals:  [],
  conflictingSignals: [],
  relevantContext:    [],
  strongestConnection: null,
  allPatterns:        [],
  eventWindows:       [],
  eventTypePattern:   null,
  recoveryConstrained: false,
  sources:            [],
};

// 30-day baseline; HRV dipped last week and is climbing back (→ recovery nextFocus).
// Today: short sleep, high readiness → conflicting physiological state, no event.
function seanShapedDay(): { timeline: HealthDayRecord[]; today: HealthDayRecord } {
  const timeline: HealthDayRecord[] = Array.from({ length: 30 }, (_, i) => ({
    date: pastDate(30 - i), readiness: 74, hrv: 48, sleepScore: 78, sleepHours: 7.5,
  }));
  timeline.slice(-9, -2).forEach(d => { d.hrv = 35; });
  timeline.slice(-2).forEach(d => { d.hrv = 42; });
  const today: HealthDayRecord = { date: TODAY, readiness: 90, hrv: 48, sleepScore: 78, sleepHours: 5.4 };
  timeline.push(today);
  return { timeline, today };
}

const PHYSIO = 'Sleep is running lower than your usual range, while readiness looks favorable.';
const CLOSING = 'For now, keeping activity lighter while prioritizing sleep, hydration, and recovery may be worthwhile.';

describe('Your Story — conflicting physio state without event context', () => {
  const { timeline, today } = seanShapedDay();
  const story = buildEnhancedStoryWithKey(SYNTHESIS, timeline, today, undefined, undefined, NOW).story;

  it('renders the physiological sentence exactly once', () => {
    expect(story).not.toBeNull();
    expect(story!.split(PHYSIO).length - 1).toBe(1);
  });

  it('keeps the distinct closing paragraph', () => {
    expect(story).toBe(`${PHYSIO}\n\n${CLOSING}`);
  });

  it('has no consecutive identical paragraphs', () => {
    const paras = story!.split('\n\n');
    paras.forEach((p, i) => { if (i > 0) expect(p).not.toBe(paras[i - 1]); });
  });
});

describe('collapseRepeatedParagraphs — stories persisted by the affected build', () => {
  it('removes the repeated paragraph from the reported text', () => {
    expect(collapseRepeatedParagraphs(`${PHYSIO}\n\n${PHYSIO}\n\n${CLOSING}`)).toBe(`${PHYSIO}\n\n${CLOSING}`);
  });

  it('leaves distinct and non-adjacent paragraphs alone', () => {
    const s = `A.\n\nB.\n\nA.`;
    expect(collapseRepeatedParagraphs(s)).toBe(s);
  });
});
