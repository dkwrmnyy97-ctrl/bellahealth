/**
 * widget-snapshot.ts
 *
 * Assembles the widget snapshot from the current in-memory health state and
 * forwards it to the native BellaHealthWidgetBridge, which persists it to the
 * shared App Group UserDefaults so WidgetKit can read it.
 *
 * All fields are optional — the widget displays "—" for any null field rather
 * than "0", preserving the null-vs-zero semantic of the main app.
 *
 * This module is a no-op on Android or when the native module is unavailable
 * (simulator without the module, Jest tests, etc.).
 */

import { NativeModules } from 'react-native';

const { BellaHealthWidgetBridge } = NativeModules;

export interface WidgetSnapshotInput {
  /** Today's step count — omit if unknown, NOT 0 */
  steps?: number;
  stepGoal?: number;
  /** Total water in oz (HealthKit + manual) — include 0 if genuinely logged */
  waterOz?: number;
  waterGoalOz?: number;
  /** Sleep duration in decimal hours, e.g. 7.7 = 7h 42m — omit if no data */
  sleepHours?: number;
  /** YYYY-MM-DD of the sleep session (used for "last night" label) */
  sleepDate?: string;
  /** CSS hex string, e.g. "#C17B8E" */
  accentHex?: string;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function writeWidgetSnapshot(input: WidgetSnapshotInput): Promise<void> {
  if (!BellaHealthWidgetBridge?.writeSnapshot) return;

  const snapshot: Record<string, unknown> = {
    date: todayStr(),
    lastUpdatedAt: new Date().toISOString(),
  };

  if (input.steps != null)       snapshot.steps       = input.steps;
  if (input.stepGoal != null)    snapshot.stepGoal    = input.stepGoal;
  if (input.waterOz != null)     snapshot.waterOz     = input.waterOz;
  if (input.waterGoalOz != null) snapshot.waterGoalOz = input.waterGoalOz;
  if (input.sleepHours != null && input.sleepHours > 0) snapshot.sleepHours = input.sleepHours;
  if (input.sleepDate != null)   snapshot.sleepDate   = input.sleepDate;
  if (input.accentHex != null)   snapshot.accentHex   = input.accentHex;

  await BellaHealthWidgetBridge.writeSnapshot(snapshot);
}
