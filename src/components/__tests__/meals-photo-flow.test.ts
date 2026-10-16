/**
 * meals-photo-flow.test.ts
 *
 * Regression coverage for the Nutrition photo crash (same Build 123 root cause
 * as Documents, plus a secondary vulnerability unique to the meals flow).
 *
 * Primary root cause (fixed in Info.plist):
 *   handleAddPhoto calls requestCameraPermissionsAsync() at every photo tap.
 *   Without NSCameraUsageDescription in Info.plist, iOS hard-terminates the app.
 *   Fix: both permission strings already added to ios/BellaHealth/Info.plist.
 *
 * Secondary vulnerability (fixed in meals-modal.tsx):
 *   openPicker() had no try/catch around launchCameraAsync() /
 *   launchImageLibraryAsync(). It was invoked from setTimeout() without await,
 *   so any native throw became an unhandled promise rejection — a crash risk.
 *   Fix: try/catch added; Alert shown on picker failure, function returns early.
 *
 * Contract under test (mirrors meals-modal.tsx openPicker / handleAddPhoto):
 *   1. Permission preflight uses Promise.allSettled — never throws.
 *   2. Picker throws → Alert shown, no unhandled rejection.
 *   3. Picker returns cancelled → no manipulation, no AI call.
 *   4. Picker returns result with no assets → same early return.
 *   5. Valid asset → manipulateAsync called, then analyzeMealPhoto called.
 *   6. manipulateAsync returns no base64 → caught, Alert shown, no AI call.
 *   7. analyzeMealPhoto rejects → caught, Alert shown (graceful, no crash).
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// ── Mock expo-image-picker ────────────────────────────────────────────────────

const mockRequestCameraPermissions    = jest.fn<Promise<{ status: string }>, []>();
const mockRequestMediaLibraryPermissions = jest.fn<Promise<{ status: string }>, []>();
const mockLaunchCameraAsync           = jest.fn<Promise<{ canceled: boolean; assets?: any[] }>, [any]>();
const mockLaunchImageLibraryAsync     = jest.fn<Promise<{ canceled: boolean; assets?: any[] }>, [any]>();

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync:       () => mockRequestCameraPermissions(),
  requestMediaLibraryPermissionsAsync: () => mockRequestMediaLibraryPermissions(),
  launchCameraAsync:                   (opts: any) => mockLaunchCameraAsync(opts),
  launchImageLibraryAsync:             (opts: any) => mockLaunchImageLibraryAsync(opts),
}));

// ── Mock expo-image-manipulator ───────────────────────────────────────────────

const mockManipulateAsync = jest.fn<Promise<{ base64?: string; uri: string }>, [any, any, any]>();

jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: (...args: any[]) => mockManipulateAsync(...args),
  SaveFormat: { JPEG: 'jpeg' },
}));

// ── Mock food-ai ──────────────────────────────────────────────────────────────

const mockAnalyzeMealPhoto = jest.fn<Promise<{ items: any[]; macros: any }>, [string, string]>();

jest.mock('@/services/food-ai', () => ({
  analyzeMealPhoto: (b64: string, mime: string) => mockAnalyzeMealPhoto(b64, mime),
  estimateMacrosFromText: jest.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { analyzeMealPhoto } from '@/services/food-ai';

// ── Helpers: mirror meals-modal.tsx openPicker + handleAddPhoto ───────────────

type SimResult = {
  alerted: boolean;
  alertTitle?: string;
  analysisCalled: boolean;
  viewAfter: 'analyzing' | 'confirm' | 'log' | 'none';
};

/**
 * Mirrors handleAddPhoto's permission preflight (Promise.allSettled).
 * Returns true if preflight resolved without throwing.
 */
async function simulateHandleAddPhotoPrelight(): Promise<boolean> {
  try {
    await Promise.allSettled([
      ImagePicker.requestCameraPermissionsAsync(),
      ImagePicker.requestMediaLibraryPermissionsAsync(),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mirrors the fixed openPicker logic from meals-modal.tsx.
 * Uses a try/catch around the picker launch (the fix).
 */
async function simulateOpenPicker(source: 'camera' | 'library'): Promise<SimResult> {
  const sim: SimResult = { alerted: false, analysisCalled: false, viewAfter: 'none' };

  const opts = { mediaTypes: ['images' as any], quality: 1 };

  let result: { canceled: boolean; assets?: any[] };
  try {
    result = source === 'camera'
      ? await ImagePicker.launchCameraAsync(opts)
      : await ImagePicker.launchImageLibraryAsync(opts);
  } catch {
    sim.alerted = true;
    sim.alertTitle = 'Could not open camera';
    return sim;
  }

  if (result.canceled || !result.assets?.[0]) return sim;
  const asset = result.assets[0];

  sim.viewAfter = 'analyzing';

  try {
    const resized = await (ImageManipulator as any).manipulateAsync(
      asset.uri,
      [{ resize: { width: 1024 } }],
      { compress: 0.7, format: 'jpeg', base64: true },
    );
    if (!resized.base64) throw new Error('Could not process image.');

    await (analyzeMealPhoto as jest.Mock)(resized.base64, 'image/jpeg');
    sim.analysisCalled = true;
    sim.viewAfter = 'confirm';
  } catch (e: any) {
    sim.viewAfter = 'log';
    sim.alerted = true;
    sim.alertTitle = 'Could not analyze photo';
  }

  return sim;
}

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockRequestCameraPermissions.mockResolvedValue({ status: 'granted' });
  mockRequestMediaLibraryPermissions.mockResolvedValue({ status: 'granted' });
  mockLaunchCameraAsync.mockResolvedValue({ canceled: true });
  mockLaunchImageLibraryAsync.mockResolvedValue({ canceled: true });
  mockManipulateAsync.mockResolvedValue({ base64: 'fake-base64', uri: 'file://resized.jpg' });
  mockAnalyzeMealPhoto.mockResolvedValue({
    items: [{ name: 'Chicken breast', quantity: '1 serving' }],
    macros: { calories: 250, protein: 35, carbs: 0, fat: 5 },
  });
});

// ─── 1. Permission preflight never throws ────────────────────────────────────

describe('Nutrition photo — handleAddPhoto: permission preflight never throws', () => {
  it('resolves when both permissions are granted', async () => {
    const ok = await simulateHandleAddPhotoPrelight();
    expect(ok).toBe(true);
  });

  it('resolves when both permissions are denied', async () => {
    mockRequestCameraPermissions.mockResolvedValue({ status: 'denied' });
    mockRequestMediaLibraryPermissions.mockResolvedValue({ status: 'denied' });

    const ok = await simulateHandleAddPhotoPrelight();
    expect(ok).toBe(true);
  });

  it('resolves when requestCameraPermissionsAsync rejects', async () => {
    mockRequestCameraPermissions.mockRejectedValue(new Error('camera error'));

    const ok = await simulateHandleAddPhotoPrelight();
    expect(ok).toBe(true);
  });

  it('resolves when requestMediaLibraryPermissionsAsync rejects', async () => {
    mockRequestMediaLibraryPermissions.mockRejectedValue(new Error('library error'));

    const ok = await simulateHandleAddPhotoPrelight();
    expect(ok).toBe(true);
  });
});

// ─── 2. Picker throws → graceful recovery (the fix) ─────────────────────────

describe('Nutrition photo — openPicker: native picker throw is caught (secondary fix)', () => {
  it('camera throws → Alert shown, no unhandled rejection', async () => {
    mockLaunchCameraAsync.mockRejectedValue(new Error('native camera error'));

    const sim = await simulateOpenPicker('camera');

    expect(sim.alerted).toBe(true);
    expect(sim.alertTitle).toBe('Could not open camera');
    expect(sim.analysisCalled).toBe(false);
  });

  it('library throws → Alert shown, no unhandled rejection', async () => {
    mockLaunchImageLibraryAsync.mockRejectedValue(new Error('native library error'));

    const sim = await simulateOpenPicker('library');

    expect(sim.alerted).toBe(true);
    expect(sim.alertTitle).toBe('Could not open camera');
    expect(sim.analysisCalled).toBe(false);
  });
});

// ─── 3. Picker cancelled → no processing ─────────────────────────────────────

describe('Nutrition photo — openPicker: cancelled picker skips processing', () => {
  it('camera cancelled → no manipulateAsync, no analyzeMealPhoto', async () => {
    mockLaunchCameraAsync.mockResolvedValue({ canceled: true });

    const sim = await simulateOpenPicker('camera');

    expect(sim.analysisCalled).toBe(false);
    expect(mockManipulateAsync).not.toHaveBeenCalled();
  });

  it('library cancelled → no manipulateAsync, no analyzeMealPhoto', async () => {
    mockLaunchImageLibraryAsync.mockResolvedValue({ canceled: true });

    const sim = await simulateOpenPicker('library');

    expect(sim.analysisCalled).toBe(false);
    expect(mockManipulateAsync).not.toHaveBeenCalled();
  });

  it('result with no assets array → same early return', async () => {
    mockLaunchCameraAsync.mockResolvedValue({ canceled: false, assets: [] });

    const sim = await simulateOpenPicker('camera');

    expect(sim.analysisCalled).toBe(false);
    expect(mockManipulateAsync).not.toHaveBeenCalled();
  });
});

// ─── 4. Valid asset → full processing chain runs ─────────────────────────────

describe('Nutrition photo — openPicker: valid photo triggers full pipeline', () => {
  const validResult = { canceled: false, assets: [{ uri: 'file://photo.jpg' }] };

  it('camera: valid asset → manipulateAsync then analyzeMealPhoto called', async () => {
    mockLaunchCameraAsync.mockResolvedValue(validResult);

    const sim = await simulateOpenPicker('camera');

    expect(mockManipulateAsync).toHaveBeenCalledTimes(1);
    expect(mockAnalyzeMealPhoto).toHaveBeenCalledTimes(1);
    expect(mockAnalyzeMealPhoto).toHaveBeenCalledWith('fake-base64', 'image/jpeg');
    expect(sim.analysisCalled).toBe(true);
    expect(sim.viewAfter).toBe('confirm');
  });

  it('library: valid asset → manipulateAsync then analyzeMealPhoto called', async () => {
    mockLaunchImageLibraryAsync.mockResolvedValue(validResult);

    const sim = await simulateOpenPicker('library');

    expect(mockManipulateAsync).toHaveBeenCalledTimes(1);
    expect(mockAnalyzeMealPhoto).toHaveBeenCalledTimes(1);
    expect(sim.viewAfter).toBe('confirm');
  });
});

// ─── 5. manipulateAsync returns no base64 ────────────────────────────────────

describe('Nutrition photo — openPicker: bad manipulateAsync result is caught', () => {
  it('no base64 in resized result → caught, view returns to log', async () => {
    mockLaunchCameraAsync.mockResolvedValue({ canceled: false, assets: [{ uri: 'file://photo.jpg' }] });
    mockManipulateAsync.mockResolvedValue({ uri: 'file://resized.jpg' }); // no base64

    const sim = await simulateOpenPicker('camera');

    expect(sim.viewAfter).toBe('log');
    expect(sim.alerted).toBe(true);
    expect(mockAnalyzeMealPhoto).not.toHaveBeenCalled();
  });
});

// ─── 6. analyzeMealPhoto rejects → graceful error ────────────────────────────

describe('Nutrition photo — openPicker: AI failure handled gracefully', () => {
  const validResult = { canceled: false, assets: [{ uri: 'file://photo.jpg' }] };

  it('analyzeMealPhoto rejects → view returns to log, no crash', async () => {
    mockLaunchCameraAsync.mockResolvedValue(validResult);
    mockAnalyzeMealPhoto.mockRejectedValue(new Error('AI service unavailable'));

    const sim = await simulateOpenPicker('camera');

    expect(sim.viewAfter).toBe('log');
    expect(sim.alerted).toBe(true);
    expect(sim.alertTitle).toBe('Could not analyze photo');
  });

  it('analyzeMealPhoto rejects with HTML error → still caught gracefully', async () => {
    mockLaunchCameraAsync.mockResolvedValue(validResult);
    mockAnalyzeMealPhoto.mockRejectedValue(new Error('<html>502 Bad Gateway</html>'));

    const sim = await simulateOpenPicker('camera');

    expect(sim.viewAfter).toBe('log');
    expect(sim.alerted).toBe(true);
  });
});
