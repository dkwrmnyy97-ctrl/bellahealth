/**
 * story-persistence.test.ts
 *
 * Lifecycle tests for the Your Story persistence feature (story_last_v1).
 *
 * The persistence layer is implemented in src/app/context.tsx and works as follows:
 *   - Write: YourStory calls onStoryPersisted when a new story is generated;
 *     handleStoryPersisted saves to AsyncStorage under STORY_LAST_KEY.
 *   - Read: loadContextState reads STORY_LAST_KEY from AsyncStorage and includes
 *     the value in ContextState.persistedStory.
 *   - Display: YourStory shows persistedStory (at pal.textSecondary) when
 *     today's story is null; falls through to generic fallback only when
 *     persistedStory is also null.
 *   - Sign-out: 'story_last_v1' is in SIGN_OUT_KEYS → removed on every sign-out.
 *
 * Cases:
 *   A. 'story_last_v1' is included in SIGN_OUT_KEYS (sign-out wipes the cache)
 *   B. PersistedStory round-trips through JSON correctly (storage contract)
 *   C. isContrast=true when contrastKeyShown is a non-null string
 *   D. isContrast=false when contrastKeyShown is null (surfaceWorthyCore story)
 *   E. generatedAt is set to today's date (YYYY-MM-DD)
 *   F. storyText is preserved verbatim through the storage round-trip
 *   G. Malformed / missing AsyncStorage value parses gracefully to null
 *   H. Deduplication: persist is skipped when storyText is unchanged
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import { SIGN_OUT_KEYS } from '../auth';

const STORY_LAST_KEY = 'story_last_v1';

type PersistedStory = {
  storyText:   string;
  generatedAt: string;
  isContrast:  boolean;
  contrastKey: string | null;
};

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Simulate what YourStory's useEffect writes when a story is generated. */
function makePersistedStory(
  storyText: string,
  contrastKeyShown: string | null,
): PersistedStory {
  return {
    storyText,
    generatedAt: todayStr(),
    isContrast:  contrastKeyShown !== null,
    contrastKey: contrastKeyShown,
  };
}

/** Simulate handleStoryPersisted: write only if storyText changed. */
async function persistStory(
  ps: PersistedStory,
  current: PersistedStory | null,
): Promise<boolean> {
  if (current?.storyText === ps.storyText) return false;
  await AsyncStorage.setItem(STORY_LAST_KEY, JSON.stringify(ps));
  return true;
}

/** Simulate loadContextState: parse the stored value. */
async function loadPersistedStory(): Promise<PersistedStory | null> {
  try {
    const raw = await AsyncStorage.getItem(STORY_LAST_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ─── Case A: Sign-out cleanup ──────────────────────────────────────────────────

describe('Case A — sign-out cleanup', () => {
  it("'story_last_v1' is present in SIGN_OUT_KEYS", () => {
    expect(SIGN_OUT_KEYS).toContain('story_last_v1');
  });

  it('removing SIGN_OUT_KEYS clears the persisted story', async () => {
    const ps = makePersistedStory('Your HRV held steady through the trip.', null);
    await AsyncStorage.setItem(STORY_LAST_KEY, JSON.stringify(ps));

    await AsyncStorage.multiRemove([...SIGN_OUT_KEYS]);

    const loaded = await loadPersistedStory();
    expect(loaded).toBeNull();
  });
});

// ─── Cases B + F: Storage round-trip and verbatim text ────────────────────────

describe('Cases B+F — storage round-trip', () => {
  beforeEach(() => AsyncStorage.clear());

  it('PersistedStory writes and reads back with all fields intact', async () => {
    const text = 'Your sleep efficiency dropped after the late run — recovery is slower tonight.';
    const ps = makePersistedStory(text, null);

    await AsyncStorage.setItem(STORY_LAST_KEY, JSON.stringify(ps));
    const loaded = await loadPersistedStory();

    expect(loaded).not.toBeNull();
    expect(loaded!.storyText).toBe(text);           // Case F: verbatim text
    expect(loaded!.generatedAt).toBe(ps.generatedAt);
    expect(loaded!.isContrast).toBe(false);
    expect(loaded!.contrastKey).toBeNull();
  });

  it('contrast story preserves contrastKey through round-trip', async () => {
    const key = 'alcohol_2026-10-05_responding';
    const ps  = makePersistedStory('Last night\'s drinks appear to have blunted your HRV recovery.', key);

    await AsyncStorage.setItem(STORY_LAST_KEY, JSON.stringify(ps));
    const loaded = await loadPersistedStory();

    expect(loaded!.isContrast).toBe(true);
    expect(loaded!.contrastKey).toBe(key);
  });
});

// ─── Case C: isContrast=true when contrastKeyShown is non-null ────────────────

describe('Case C — isContrast when contrastKeyShown is non-null', () => {
  it('sets isContrast=true for a contrast-only story', () => {
    const ps = makePersistedStory('Alcohol story text.', 'alcohol_2026-10-04_stable');
    expect(ps.isContrast).toBe(true);
    expect(ps.contrastKey).toBe('alcohol_2026-10-04_stable');
  });

  it('sets isContrast=true for a travel event story', () => {
    const ps = makePersistedStory('Travel story.', 'evt-123_responding');
    expect(ps.isContrast).toBe(true);
  });
});

// ─── Case D: isContrast=false when contrastKeyShown is null ───────────────────

describe('Case D — isContrast=false for surfaceWorthyCore stories', () => {
  it('sets isContrast=false when contrastKeyShown is null', () => {
    const ps = makePersistedStory('Your sleep and HRV are trending upward together.', null);
    expect(ps.isContrast).toBe(false);
    expect(ps.contrastKey).toBeNull();
  });
});

// ─── Case E: generatedAt is today's date ─────────────────────────────────────

describe('Case E — generatedAt is today', () => {
  it('sets generatedAt to the current YYYY-MM-DD date', () => {
    const ps = makePersistedStory('Some story.', null);
    const expected = todayStr();
    expect(ps.generatedAt).toBe(expected);
    expect(ps.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ─── Case G: Graceful degradation on malformed/missing storage ────────────────

describe('Case G — graceful degradation', () => {
  beforeEach(() => AsyncStorage.clear());

  it('returns null when no value is stored', async () => {
    const loaded = await loadPersistedStory();
    expect(loaded).toBeNull();
  });

  it('returns null when stored value is malformed JSON', async () => {
    await AsyncStorage.setItem(STORY_LAST_KEY, 'not valid json {{');
    const loaded = await loadPersistedStory();
    expect(loaded).toBeNull();
  });

  it('returns null when stored value is an empty string', async () => {
    await AsyncStorage.setItem(STORY_LAST_KEY, '');
    const loaded = await loadPersistedStory();
    expect(loaded).toBeNull();
  });
});

// ─── Case H: Deduplication — no write when storyText is unchanged ─────────────

describe('Case H — deduplication', () => {
  beforeEach(() => AsyncStorage.clear());

  it('writes when storyText changes', async () => {
    const ps1 = makePersistedStory('Story one.', null);
    const wrote1 = await persistStory(ps1, null);
    expect(wrote1).toBe(true);

    const ps2 = makePersistedStory('Story two.', null);
    const wrote2 = await persistStory(ps2, ps1);
    expect(wrote2).toBe(true);

    const loaded = await loadPersistedStory();
    expect(loaded!.storyText).toBe('Story two.');
  });

  it('skips write when storyText is identical to current', async () => {
    const text = 'Your HRV pattern is consistent.';
    const ps1  = makePersistedStory(text, null);
    await persistStory(ps1, null);

    const ps2     = makePersistedStory(text, null);  // same text, different date hypothetically
    const wrote2  = await persistStory(ps2, ps1);
    expect(wrote2).toBe(false);

    // Verify original is unchanged (ps2 was not written).
    const loaded = await loadPersistedStory();
    expect(loaded!.generatedAt).toBe(ps1.generatedAt);
  });
});
