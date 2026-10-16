/**
 * healthkit-preprompt.test.ts
 *
 * App Review Guideline 5.1.1(iv): the custom screen shown immediately before
 * the HealthKit authorization sheet must not let the user skip or delay the
 * request, and its only action must lead straight to Apple's native sheet.
 *
 * react-test-renderer is not available in this project, so the screen's
 * markup is checked from source and the step's behavior is exercised through
 * the exported requestHealthAccessThenContinue helper the screen calls.
 */

import * as fs from 'fs';
import * as path from 'path';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const mockRequestAuthorization = jest.fn<Promise<boolean>, [unknown]>();
jest.mock('@kingstinct/react-native-healthkit', () => ({
  requestAuthorization: (opts: unknown) => mockRequestAuthorization(opts),
  queryStatisticsForQuantity: jest.fn(),
  queryCategorySamples: jest.fn(),
  getMostRecentQuantitySample: jest.fn(),
  queryWorkoutSamples: jest.fn(),
  getBiologicalSexAsync: jest.fn(),
  getDateOfBirthAsync: jest.fn(),
  BiologicalSex: {},
  WorkoutActivityType: {},
}));

jest.mock('@/services/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/services/oura', () => ({ initiateOuraConnect: jest.fn() }));
jest.mock('@/services/apple-auth', () => ({ signInWithApple: jest.fn() }));
jest.mock('@/context/theme-context', () => ({ useAppTheme: jest.fn() }));
jest.mock('@/components/themed-text', () => ({ ThemedText: 'ThemedText' }));
jest.mock('@/constants/theme', () => ({ Fonts: {}, Spacing: {} }));
jest.mock('@/utils/modal-palette', () => ({ getModalPalette: jest.fn() }));

import { requestHealthAccessThenContinue } from '@/components/onboarding-flow';
import { initHealthKit } from '@/services/healthkit';

// ─── Screen markup ────────────────────────────────────────────────────────────

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'onboarding-flow.tsx'),
  'utf8',
);

/** The JSX rendered for the Apple Health step, up to the next step's case. */
function healthKitStepSource(): string {
  const start = SOURCE.indexOf("case 'healthkit':");
  const end = SOURCE.indexOf("case '", start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe('Apple Health pre-permission screen', () => {
  it('has a single action, labelled Continue, that requests authorization', () => {
    const step = healthKitStepSource();
    const presses = step.match(/onPress=\{[^}]*\}/g) ?? [];
    expect(presses).toEqual(['onPress={handleHealthKit}']);
    expect(step).toMatch(/>Continue</);
    expect(step).not.toMatch(/>Connect Apple Health</);
  });

  it('offers no skip, dismiss, or delay option', () => {
    const step = healthKitStepSource();
    expect(step).not.toMatch(/skip|not now|maybe later|dismiss|close/i);
    expect(step).not.toMatch(/skipRow|skipLabel/);
  });

  it('keeps the explanation factual (no claim that data is never shared)', () => {
    const step = healthKitStepSource();
    expect(step).not.toMatch(/never shared/i);
    expect(step).not.toMatch(/all on your device/i);
  });

  it('Continue invokes the native request directly, before advancing', () => {
    const handler = SOURCE.slice(
      SOURCE.indexOf('async function handleHealthKit()'),
      SOURCE.indexOf('function toggleApp('),
    );
    expect(handler).toMatch(/requestHealthAccessThenContinue\(initHealthKit,/);
  });

  it('the full-screen onboarding modal cannot be dismissed by gesture', () => {
    expect(SOURCE).toMatch(/<Modal visible=\{visible\} animationType="none" presentationStyle="fullScreen">/);
    expect(SOURCE).not.toMatch(/onRequestClose/);
  });
});

// ─── Step behavior ────────────────────────────────────────────────────────────

describe('requestHealthAccessThenContinue', () => {
  beforeEach(() => mockRequestAuthorization.mockReset());

  it('first-time authorization: shows the native sheet, then continues', async () => {
    const order: string[] = [];
    mockRequestAuthorization.mockImplementation(async () => { order.push('sheet'); return true; });

    await requestHealthAccessThenContinue(initHealthKit, () => order.push('advance'));

    expect(mockRequestAuthorization).toHaveBeenCalledTimes(1);
    expect(mockRequestAuthorization.mock.calls[0][0]).toEqual(
      expect.objectContaining({ toShare: [] }),
    );
    expect(order).toEqual(['sheet', 'advance']);
  });

  it('user grants no access: onboarding still continues', async () => {
    // iOS resolves the request even when every read type is turned off.
    mockRequestAuthorization.mockResolvedValue(true);
    const advance = jest.fn();

    await requestHealthAccessThenContinue(initHealthKit, advance);

    expect(advance).toHaveBeenCalledTimes(1);
  });

  it('HealthKit unavailable or the request fails: onboarding still continues', async () => {
    mockRequestAuthorization.mockRejectedValue(new Error('HealthKit is not available'));
    const advance = jest.fn();

    await expect(requestHealthAccessThenContinue(initHealthKit, advance)).resolves.toBeUndefined();

    expect(advance).toHaveBeenCalledTimes(1);
  });

  it('does not advance until the native sheet has been answered', async () => {
    let answer!: (v: boolean) => void;
    mockRequestAuthorization.mockImplementation(() => new Promise((r) => { answer = r; }));
    const advance = jest.fn();

    const done = requestHealthAccessThenContinue(initHealthKit, advance);
    await Promise.resolve();
    expect(advance).not.toHaveBeenCalled();

    answer(true);
    await done;
    expect(advance).toHaveBeenCalledTimes(1);
  });
});
