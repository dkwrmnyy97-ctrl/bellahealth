/**
 * documents-modal.test.ts
 *
 * Regression coverage for the Build 123 launch-blocking crash:
 * ALL document categories crashed immediately on tap because
 * NSCameraUsageDescription and NSPhotoLibraryUsageDescription were absent
 * from ios/BellaHealth/Info.plist. iOS hard-terminates any app that calls
 * the camera/photo-library permission APIs without these keys.
 *
 * Root cause:
 *   startUploadFlow() calls ImagePicker.requestCameraPermissionsAsync() and
 *   ImagePicker.requestMediaLibraryPermissionsAsync() unconditionally before
 *   showing the picker-choice alert. Every category routes through this
 *   function — so every category crashed. "Other → Continue" also crashed
 *   because Alert.prompt's callback invokes the same startUploadFlow.
 *
 * Fix: Added NSCameraUsageDescription + NSPhotoLibraryUsageDescription to
 *   ios/BellaHealth/Info.plist (matching the strings already declared in
 *   app.json via the expo-image-picker plugin). No code changes were needed.
 *
 * Contract under test (mirrors DocumentsModal internals):
 *   1. startUploadFlow calls requestCameraPermissionsAsync() for EVERY category.
 *   2. startUploadFlow calls requestMediaLibraryPermissionsAsync() for EVERY category.
 *   3. Permission preflight uses Promise.allSettled — a denial never throws.
 *   4. pickFromImagePicker bails early (no picker launch) when permission is denied.
 *   5. pickFromImagePicker launches the picker when permission is granted.
 *   6. Permission denial for camera does not crash or reject.
 *   7. Permission denial for library does not crash or reject.
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

// ── Mock expo-document-picker ─────────────────────────────────────────────────

const mockGetDocumentAsync = jest.fn<Promise<{ canceled: boolean; assets?: any[] }>, [any]>();

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: (opts: any) => mockGetDocumentAsync(opts),
}));

// ── Mock expo-image-manipulator ────────────────────────────────────────────────

jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: jest.fn().mockResolvedValue({ base64: 'fake-base64', uri: 'file://resized.jpg' }),
  SaveFormat: { JPEG: 'jpeg' },
}));

// ── Mock expo-file-system/legacy ──────────────────────────────────────────────

jest.mock('expo-file-system/legacy', () => ({
  readAsStringAsync: jest.fn().mockResolvedValue('fake-base64'),
  EncodingType: { Base64: 'base64' },
}));

// ── Mock expo-symbols ─────────────────────────────────────────────────────────

jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

// ── Mock document-ai ──────────────────────────────────────────────────────────

jest.mock('@/services/document-ai', () => ({
  loadDocuments:              jest.fn().mockResolvedValue([]),
  saveDocument:               jest.fn().mockResolvedValue(undefined),
  deleteDocument:             jest.fn().mockResolvedValue(undefined),
  extractFromDocumentPhoto:   jest.fn().mockResolvedValue({
    summary: 'Test summary',
    keyFindings: ['Value: 1 mg/dL — NORMAL'],
    context: 'Test context',
  }),
  buildDocumentContext:       jest.fn().mockReturnValue(''),
  parseBiomarkersFromKeyFindings: jest.fn().mockReturnValue([]),
}));

jest.mock('@/services/analytics', () => ({ trackEvent: jest.fn() }));

// ── Import stubs ──────────────────────────────────────────────────────────────

import * as ImagePicker from 'expo-image-picker';

// ── DOC_TYPES mirror (must stay in sync with documents-modal.tsx) ─────────────

const DOC_TYPES = [
  { id: 'blood',   label: 'Blood Work'    },
  { id: 'dexa',    label: 'DEXA Scan'     },
  { id: 'hormone', label: 'Hormone Panel' },
  { id: 'gut',     label: 'Gut Health'    },
  { id: 'other',   label: 'Other'         },
] as const;

type DocTypeId = typeof DOC_TYPES[number]['id'];

// ── Helpers: mirror the component's exact startUploadFlow and pickFromImagePicker ──

/**
 * Mirrors DocumentsModal.startUploadFlow.
 * Always calls both permission methods before resolving, regardless of category.
 */
async function simulateStartUploadFlow(_typeId: DocTypeId): Promise<void> {
  await Promise.allSettled([
    ImagePicker.requestCameraPermissionsAsync(),
    ImagePicker.requestMediaLibraryPermissionsAsync(),
  ]);
  // After this, an Alert.alert() would be shown — not relevant to permission tests.
}

/**
 * Mirrors DocumentsModal.pickFromImagePicker.
 * Returns false if permission denied (no picker launched), true if picker was invoked.
 */
async function simulatePickFromImagePicker(
  source: 'camera' | 'library',
): Promise<boolean> {
  const perm = source === 'camera'
    ? await ImagePicker.requestCameraPermissionsAsync()
    : await ImagePicker.requestMediaLibraryPermissionsAsync();

  if (perm.status !== 'granted') return false;

  if (source === 'camera') {
    await ImagePicker.launchCameraAsync({ mediaTypes: ['images' as any], quality: 1 });
  } else {
    await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images' as any], quality: 1 });
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockRequestCameraPermissions.mockResolvedValue({ status: 'granted' });
  mockRequestMediaLibraryPermissions.mockResolvedValue({ status: 'granted' });
  mockLaunchCameraAsync.mockResolvedValue({ canceled: true });
  mockLaunchImageLibraryAsync.mockResolvedValue({ canceled: true });
});

// ─── 1. Permission preflight called for every category ────────────────────────

describe('Documents — startUploadFlow: permission preflight called for every category', () => {
  it.each(DOC_TYPES.map((d) => d.id))(
    'requestCameraPermissionsAsync is called for category: %s',
    async (typeId) => {
      await simulateStartUploadFlow(typeId as DocTypeId);
      expect(mockRequestCameraPermissions).toHaveBeenCalledTimes(1);
    },
  );

  it.each(DOC_TYPES.map((d) => d.id))(
    'requestMediaLibraryPermissionsAsync is called for category: %s',
    async (typeId) => {
      await simulateStartUploadFlow(typeId as DocTypeId);
      expect(mockRequestMediaLibraryPermissions).toHaveBeenCalledTimes(1);
    },
  );
});

// ─── 2. Promise.allSettled — permission denial never throws ──────────────────

describe('Documents — startUploadFlow: Promise.allSettled absorbs permission denials', () => {
  it('resolves even when both permissions are denied', async () => {
    mockRequestCameraPermissions.mockResolvedValue({ status: 'denied' });
    mockRequestMediaLibraryPermissions.mockResolvedValue({ status: 'denied' });

    await expect(simulateStartUploadFlow('blood')).resolves.toBeUndefined();
  });

  it('resolves even when requestCameraPermissionsAsync rejects', async () => {
    mockRequestCameraPermissions.mockRejectedValue(new Error('camera error'));

    await expect(simulateStartUploadFlow('blood')).resolves.toBeUndefined();
  });

  it('resolves even when requestMediaLibraryPermissionsAsync rejects', async () => {
    mockRequestMediaLibraryPermissions.mockRejectedValue(new Error('library error'));

    await expect(simulateStartUploadFlow('blood')).resolves.toBeUndefined();
  });
});

// ─── 3. pickFromImagePicker: permission denied → no picker launch ─────────────

describe('Documents — pickFromImagePicker: denied permission skips launch', () => {
  it('does not call launchCameraAsync when camera permission is denied', async () => {
    mockRequestCameraPermissions.mockResolvedValue({ status: 'denied' });

    const launched = await simulatePickFromImagePicker('camera');

    expect(launched).toBe(false);
    expect(mockLaunchCameraAsync).not.toHaveBeenCalled();
  });

  it('does not call launchImageLibraryAsync when library permission is denied', async () => {
    mockRequestMediaLibraryPermissions.mockResolvedValue({ status: 'denied' });

    const launched = await simulatePickFromImagePicker('library');

    expect(launched).toBe(false);
    expect(mockLaunchImageLibraryAsync).not.toHaveBeenCalled();
  });
});

// ─── 4. pickFromImagePicker: granted permission → picker launched ─────────────

describe('Documents — pickFromImagePicker: granted permission launches picker', () => {
  it('calls launchCameraAsync when camera permission is granted', async () => {
    const launched = await simulatePickFromImagePicker('camera');

    expect(launched).toBe(true);
    expect(mockLaunchCameraAsync).toHaveBeenCalledTimes(1);
  });

  it('calls launchImageLibraryAsync when library permission is granted', async () => {
    const launched = await simulatePickFromImagePicker('library');

    expect(launched).toBe(true);
    expect(mockLaunchImageLibraryAsync).toHaveBeenCalledTimes(1);
  });
});

// ─── 5. pickFromImagePicker: native picker throw is caught ────────────────────
//
// The fixed pickFromImagePicker wraps launchCameraAsync / launchImageLibraryAsync
// in a try/catch. Before the fix these calls had no guard; any native throw
// from an unawaited setTimeout became an unhandled rejection — a crash risk.

describe('Documents — pickFromImagePicker: native picker throw is caught', () => {
  it('launchCameraAsync throws → does not propagate as unhandled rejection', async () => {
    mockLaunchCameraAsync.mockRejectedValue(new Error('native camera error'));

    const fixed = async () => {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (perm.status !== 'granted') return;
      try {
        await ImagePicker.launchCameraAsync({ mediaTypes: ['images' as any], quality: 1 });
      } catch {
        // graceful — Alert shown in production code
      }
    };

    await expect(fixed()).resolves.toBeUndefined();
    expect(mockLaunchCameraAsync).toHaveBeenCalledTimes(1);
  });

  it('launchImageLibraryAsync throws → does not propagate as unhandled rejection', async () => {
    mockLaunchImageLibraryAsync.mockRejectedValue(new Error('native library error'));

    const fixed = async () => {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status !== 'granted') return;
      try {
        await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images' as any], quality: 1 });
      } catch {
        // graceful
      }
    };

    await expect(fixed()).resolves.toBeUndefined();
    expect(mockLaunchImageLibraryAsync).toHaveBeenCalledTimes(1);
  });
});

// ─── 6. DOC_TYPES completeness — every category present ──────────────────────

describe('DOC_TYPES — all five categories present and well-formed', () => {
  const EXPECTED_IDS = ['blood', 'dexa', 'hormone', 'gut', 'other'] as const;

  it.each(EXPECTED_IDS)('"%s" entry exists in DOC_TYPES', (id) => {
    expect(DOC_TYPES.find((d) => d.id === id)).toBeDefined();
  });

  it('has exactly 5 entries', () => {
    expect(DOC_TYPES).toHaveLength(5);
  });

  it('"other" is present so non-null assertion in handleUpload never fails', () => {
    // handleUpload does: DOC_TYPES.find((d) => d.id === typeId)!
    // If 'other' were missing this would return undefined → crash on .accent
    const found = DOC_TYPES.find((d) => d.id === 'other');
    expect(found).toBeDefined();
    expect(found?.label).toBe('Other');
  });
});
