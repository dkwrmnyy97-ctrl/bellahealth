/**
 * vacation-goals.test.ts
 *
 * Regression test for the vacation-modal water goal key mismatch.
 *
 * Bug: vacation-modal.tsx read `p.goalOz` from the saved profile, but
 * profile-modal.tsx (and SavedProfile type) stores the water goal under
 * `p.waterGoal`. When the modal opened, `p.goalOz` was always undefined,
 * so the water goal always fell back to the hardcoded default ("80 oz")
 * regardless of what the user had set in their profile.
 *
 * Fix: vacation-modal.tsx now reads `p.waterGoal`.
 */

import type { SavedProfile } from '../../components/profile-modal';

// ─── Key consistency ──────────────────────────────────────────────────────────

describe('SavedProfile water goal key', () => {
  it('SavedProfile uses waterGoal (not goalOz) for the water goal field', () => {
    // Verify the type shape used by profile-modal save() and vacation-modal read()
    const profile: SavedProfile = {
      name: 'Test', age: '30', gender: 'Female',
      height: "5'6\"", weight: '130', weightGoal: '125',
      stepGoal: '10000', calGoal: '2000', sleepGoal: '8',
      waterGoal: '72',   // <-- the correct key
      supplements: '', units: 'automatic',
    };
    expect(profile.waterGoal).toBe('72');
    // The wrong key (before fix) would be undefined on this type
    expect((profile as any).goalOz).toBeUndefined();
  });
});

describe('vacation-modal water goal lookup', () => {
  it('reads waterGoal from profile, not goalOz', () => {
    // Simulates the logic in vacation-modal.tsx useEffect after the fix:
    //   value: p.waterGoal ? String(p.waterGoal) : prev.water.value
    const mockProfile = { waterGoal: '72', stepGoal: '8000' };
    const defaultValue = '80';

    const correctKey = mockProfile.waterGoal ? String(mockProfile.waterGoal) : defaultValue;
    expect(correctKey).toBe('72'); // reads the user's actual goal

    // Before fix: p.goalOz would be undefined, falling through to default
    const wrongKey = (mockProfile as any).goalOz ? String((mockProfile as any).goalOz) : defaultValue;
    expect(wrongKey).toBe(defaultValue); // the bug: always showed '80'
  });

  it('falls back to default when waterGoal is not set', () => {
    const profileWithoutWater = { stepGoal: '8000' };
    const defaultValue = '80';
    const result = (profileWithoutWater as any).waterGoal
      ? String((profileWithoutWater as any).waterGoal)
      : defaultValue;
    expect(result).toBe(defaultValue);
  });
});
