/**
 * local-date.ts
 *
 * Produces YYYY-MM-DD date strings using the device's LOCAL calendar date.
 *
 * DO NOT use `new Date().toISOString().split('T')[0]` for local calendar keys.
 * `toISOString()` returns a UTC timestamp — for users in UTC-offset timezones
 * (US Eastern = UTC-4/5, US Pacific = UTC-7/8), calling it after ~7pm–midnight
 * local time returns tomorrow's UTC date, placing logs and chart bars on the
 * wrong calendar day.
 *
 * Use `localDateString()` everywhere a YYYY-MM-DD key represents a local
 * calendar day (wellness logs, trends chart placeholders, grounding win windows,
 * drink logs, etc.).
 */

/**
 * Returns the YYYY-MM-DD string for the given Date in the device's local
 * timezone. Defaults to the current moment when no argument is provided.
 */
export function localDateString(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
