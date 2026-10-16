/**
 * Unit formatting helpers for BellaHealth.
 *
 * UnitSystem:
 *   'automatic' — follows device locale (US locale → imperial; others → metric)
 *   'imperial'  — lbs, miles, fl oz, feet/inches
 *   'metric'    — kg, km, ml, cm
 *
 * Canonical internal representation (what HealthKit returns on US devices):
 *   weight → lbs, height → inches, distance → meters, water → fl oz
 */

export type UnitSystem = 'automatic' | 'imperial' | 'metric';

function effective(system: UnitSystem): 'imperial' | 'metric' {
  if (system !== 'automatic') return system;
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    return locale === 'en-US' || locale.endsWith('-US') ? 'imperial' : 'metric';
  } catch {
    return 'imperial';
  }
}

/** Format weight. Input: lbs (as stored by HealthKit). */
export function formatWeight(lbs: number, system: UnitSystem): string {
  if (effective(system) === 'metric') {
    return `${Math.round(lbs * 0.453592)} kg`;
  }
  return `${Math.round(lbs)} lbs`;
}

/** Format distance. Input: meters (as returned by HealthKit workout distance). */
export function formatDistance(meters: number, system: UnitSystem): string {
  if (effective(system) === 'metric') {
    const km = meters / 1000;
    return `${km.toFixed(km >= 10 ? 1 : 2)} km`;
  }
  const miles = meters / 1609.34;
  return `${miles.toFixed(miles >= 10 ? 1 : 2)} mi`;
}

/** Format height. Input: total inches (as stored by HealthKit). */
export function formatHeight(inches: number, system: UnitSystem): string {
  if (effective(system) === 'metric') {
    return `${Math.round(inches * 2.54)} cm`;
  }
  const ft = Math.floor(inches / 12);
  const inn = inches % 12;
  return `${ft}'${inn}"`;
}

/** Format water volume. Input: fl oz (as returned by HealthKit on US devices). */
export function formatWater(oz: number, system: UnitSystem): string {
  if (effective(system) === 'metric') {
    return `${Math.round(oz * 29.5735)} ml`;
  }
  return `${Math.round(oz)} oz`;
}
