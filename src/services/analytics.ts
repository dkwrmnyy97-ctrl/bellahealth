/**
 * BellaHealth Analytics Service
 *
 * Lightweight product-usage analytics backed by a Supabase Edge Function.
 * Events are POSTed to /functions/v1/ingest-event, which validates the payload
 * server-side and writes using the service-role key. The mobile client never
 * has direct INSERT permission on the analytics_events table.
 *
 * PRIVACY RULES:
 *   - Track THAT an action happened, never WHAT the user entered.
 *   - No health values, no free text, no PII in any field.
 *   - All failures are swallowed — analytics must never break product actions.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEMO_MODE } from '@/config/demo';

const SUPABASE_URL  = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
const INGEST_URL    = `${SUPABASE_URL}/functions/v1/ingest-event`;
const DEVICE_ID_KEY = 'analytics_device_id';

// ─── Explore mode flag ────────────────────────────────────────────────────────

let _isExploreMode = false;

/** Set by ExploreProvider — suppresses all analytics while user is exploring sample data. */
export function setAnalyticsExploreMode(on: boolean): void {
  _isExploreMode = on;
}

// ─── Device ID ────────────────────────────────────────────────────────────────

let _cachedDeviceId: string | null = null;

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function getDeviceId(): Promise<string> {
  if (_cachedDeviceId) return _cachedDeviceId;
  try {
    const stored = await AsyncStorage.getItem(DEVICE_ID_KEY);
    if (stored) {
      _cachedDeviceId = stored;
      return stored;
    }
    const id = generateUUID();
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
    _cachedDeviceId = id;
    return id;
  } catch {
    // Storage unavailable — use an ephemeral ID for this session only
    if (!_cachedDeviceId) _cachedDeviceId = generateUUID();
    return _cachedDeviceId;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export type TrackOptions = {
  source_screen?: string;
  // metadata is intentionally absent — no generic metadata pipeline exists.
  // Track THAT an action happened. If a product question truly requires metadata,
  // add a new allowlisted field to the Edge Function after privacy review.
};

/**
 * Track a product usage event.
 *
 * Fire-and-forget — awaiting is optional. Failures are silently swallowed.
 * Never put sensitive health content or user-generated text in metadata.
 */
export async function trackEvent(
  eventName: string,
  options?: TrackOptions,
): Promise<void> {
  if (DEMO_MODE || _isExploreMode) return; // Never send analytics during demo or explore
  try {
    const deviceId = await getDeviceId();
    await fetch(INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        SUPABASE_ANON,
        'Authorization': `Bearer ${SUPABASE_ANON}`,
      },
      body: JSON.stringify({
        device_id:     deviceId,
        event_name:    eventName,
        source_screen: options?.source_screen ?? null,
      }),
    });
  } catch {
    // Analytics failure must NEVER propagate — product actions are unaffected.
  }
}
