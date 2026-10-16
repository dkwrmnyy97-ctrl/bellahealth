/**
 * Centralized health-source and companion-app navigation for BellaHealth.
 *
 * DATA SOURCES — apps BellaHealth directly reads data from:
 *   Apple Health  HealthKit integration (no public deep link to specific views)
 *   Apple Fitness No documented public URL scheme; informational fallback
 *   Oura Ring     OAuth2 REST API; opens via Universal Link
 *
 * COMPANION APPS — third-party apps the user may use independently.
 *   BellaHealth does NOT integrate with these apps. These helpers simply
 *   navigate the user to the app (via Universal Links) or its website.
 *   Strava, WHOOP, Garmin Connect
 *
 * Universal Links (https://) are used throughout — no private URL schemes,
 * no canOpenURL checks, no LSApplicationQueriesSchemes entries required.
 */

import { Alert, Linking } from 'react-native';

// ─── Data Sources ─────────────────────────────────────────────────────────────

/**
 * Opens the Oura native app via Universal Link.
 *
 * Why this URL:
 *   cloud.ouraring.com hosts a valid apple-app-site-association file
 *   (appID: CC7T4AQ3E5.com.ouraring.oura) with the path /app/* registered.
 *   iOS Universal Links route this to the native Oura app when installed,
 *   or to Oura's web dashboard in Safari if the app is not present.
 *
 *   ouraring.com (without 'cloud.') has NO AASA file → always opens Safari.
 *   That was the previous bug.
 */
export async function openOura(): Promise<void> {
  await Linking.openURL('https://cloud.ouraring.com/app/home').catch(() => {});
}

/**
 * Apple Health has no public API for deep-linking into specific views.
 * Shows a navigation path guide.
 */
export type AppleHealthDestination = 'sleep' | 'hrv' | 'steps' | 'workouts' | 'heartRate';

const HEALTH_PATHS: Record<AppleHealthDestination, string> = {
  sleep:     'Health → Browse → Sleep → Sleep',
  hrv:       'Health → Browse → Heart → Heart Rate Variability',
  steps:     'Health → Browse → Activity → Steps',
  workouts:  'Health → Browse → Activity → Workouts',
  heartRate: 'Health → Browse → Heart → Resting Heart Rate',
};

export function showAppleHealthPath(dest: AppleHealthDestination): void {
  Alert.alert(
    'Open in Apple Health',
    `Apple doesn't allow apps to open specific Health views directly.\n\nYou can find this in:\n\n${HEALTH_PATHS[dest]}`,
    [{ text: 'Got it' }],
  );
}

// ─── Companion Apps ────────────────────────────────────────────────────────────
//
// BellaHealth does NOT read data from these apps.
// These helpers open the companion app (via Universal Links / iOS handoff)
// or their public website if the app is not installed.

/**
 * Opens the Strava native app or website.
 *
 * strava:// is officially documented in Strava's developer authentication
 * documentation (developers.strava.com/docs/authentication/) — they instruct
 * third-party apps to open strava://oauth/mobile/authorize, confirming the
 * strava:// scheme is their registered and supported iOS URL scheme.
 *
 * No LSApplicationQueriesSchemes entry is needed: we call openURL directly
 * and catch the error (app not installed) rather than using canOpenURL.
 */
export async function openStrava(): Promise<void> {
  try {
    await Linking.openURL('strava://');
  } catch {
    await Linking.openURL('https://www.strava.com').catch(() => {});
  }
}

/**
 * Opens the WHOOP native app or website.
 *
 * app.whoop.com has a valid apple-app-site-association file
 * (appID: 4CGC3U5KG3.com.whoop.iphone) with the path "/home*" registered.
 * iOS Universal Links route this to the native WHOOP app when installed,
 * or to WHOOP's web app in Safari if not present.
 */
export async function openWhoop(): Promise<void> {
  await Linking.openURL('https://app.whoop.com/home').catch(() => {});
}

/**
 * Opens the Garmin Connect native app or website.
 *
 * connect.garmin.com has a valid apple-app-site-association file
 * (appID: 72ES32VZUA.com.garmin.connect.mobile) with the path "modern/activities"
 * registered. iOS Universal Links route this to the native Garmin Connect app
 * when installed, or to the Garmin website in Safari if not present.
 */
export async function openGarminConnect(): Promise<void> {
  await Linking.openURL('https://connect.garmin.com/modern/activities').catch(() => {});
}

// ─── Metric Relevance Mapping ─────────────────────────────────────────────────

export type MetricType = 'sleep' | 'hrv' | 'readiness' | 'steps' | 'workout' | 'restingHR';
export type CompanionApp = 'strava' | 'whoop' | 'garmin';

/** Which companion apps are meaningful for each metric. */
export const COMPANION_RELEVANCE: Record<MetricType, CompanionApp[]> = {
  sleep:     ['whoop', 'garmin'],
  hrv:       ['whoop', 'garmin'],
  readiness: ['whoop', 'garmin'],
  steps:     ['garmin'],
  workout:   ['strava', 'whoop', 'garmin'],
  restingHR: ['whoop', 'garmin'],
};

export const COMPANION_LABELS: Record<CompanionApp, string> = {
  strava: 'Strava',
  whoop:  'WHOOP',
  garmin: 'Garmin Connect',
};

export const COMPANION_OPENERS: Record<CompanionApp, () => Promise<void>> = {
  strava: openStrava,
  whoop:  openWhoop,
  garmin: openGarminConnect,
};
