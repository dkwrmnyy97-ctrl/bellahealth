/**
 * cycle-context.ts
 *
 * Pure helper that builds the cycle journal section of the Chat system prompt.
 * No React Native imports — safe to unit-test in Jest without native mocks.
 *
 * PRIVACY: Only structured fields (date, energy, stress, signs) are included.
 * Free-text notes entered by the user NEVER appear in the AI context string.
 */

export type CycleEntry = {
  date: string;         // YYYY-MM-DD
  energy: number;       // 1–5
  stress: number;       // 1–5
  signs: string[];
  notes: string;        // stored locally; NEVER sent to AI
};

export type CycleProfile = {
  lastPeriodDate: string | null; // YYYY-MM-DD
};

/** Returns last 7 days of cycle entries as a formatted context string for Chat. */
export function buildCycleContext(entries: CycleEntry[], profile: CycleProfile): string {
  const energyLabel = (e: number) => ['', 'Drained', 'Tired', 'Okay', 'Good', 'Great'][e] ?? '';
  const stressLabel = (s: number) => ['', 'Calm', 'Mild', 'Moderate', 'High', 'Very High'][s] ?? '';

  const daysSince = profile.lastPeriodDate
    ? Math.floor((Date.now() - new Date(profile.lastPeriodDate).getTime()) / 86400000)
    : null;

  const recentEntries = entries.slice(-7);
  if (recentEntries.length === 0 && daysSince === null) return '';

  const lines: string[] = [];
  if (daysSince !== null) {
    lines.push(`CYCLE STATUS: Currently on Cycle Day ${daysSince + 1} (period started ${profile.lastPeriodDate}). She is working to understand and recover her menstrual cycle.`);
  } else {
    lines.push(`CYCLE STATUS: No period date recorded. She is tracking cycle patterns and lifestyle factors.`);
  }

  if (recentEntries.length > 0) {
    lines.push(`\nRECENT DAILY CHECK-INS (last ${recentEntries.length} days):`);
    recentEntries.forEach((e) => {
      const signs = e.signs.length > 0 ? ` | Signs: ${e.signs.join(', ')}` : '';
      // Free-text notes are private and NEVER included in AI context.
      // Structured fields (energy, stress, signs) are intentionally included.
      lines.push(`${e.date}: Energy ${energyLabel(e.energy)} (${e.energy}/5), Stress ${stressLabel(e.stress)} (${e.stress}/5)${signs}`);
    });
  }

  return lines.join('\n');
}
