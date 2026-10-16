/**
 * supabase.test.ts
 *
 * Unit tests for fetchTodayNutrition().
 * Verifies that:
 *   - An authenticated request uses Authorization: Bearer <jwt>
 *   - The anon key is still sent as `apikey` (project identifier)
 *   - An unauthenticated call throws without making a network request
 *   - Aggregation across multiple rows is correct
 */

jest.mock('@/services/auth', () => ({
  getAuthToken: jest.fn(),
}));

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import { getAuthToken } from '@/services/auth';
import { fetchTodayNutrition } from '../supabase';

const mockGetAuthToken = getAuthToken as jest.Mock;
const mockFetch        = jest.fn();
const originalFetch    = global.fetch;

const MOCK_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.valid-jwt.sig';

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = mockFetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

// ── Authenticated requests ────────────────────────────────────────────────────

describe('fetchTodayNutrition — authenticated', () => {
  it('sends Authorization: Bearer <jwt> and the anon key', async () => {
    mockGetAuthToken.mockResolvedValue(MOCK_TOKEN);
    mockFetch.mockResolvedValue({
      ok:   true,
      json: async () => [],
    });

    await fetchTodayNutrition();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;

    // JWT must appear in Authorization
    expect(headers['Authorization']).toBe(`Bearer ${MOCK_TOKEN}`);
    // Anon key must appear as project identifier
    expect(headers['apikey']).toBeTruthy();
    // URL must be the nutrition_log endpoint
    expect(url).toContain('nutrition_log');
  });

  it('does NOT fall back to the anon key as Authorization when authenticated', async () => {
    mockGetAuthToken.mockResolvedValue(MOCK_TOKEN);
    mockFetch.mockResolvedValue({ ok: true, json: async () => [] });

    await fetchTodayNutrition();

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const auth = (opts.headers as Record<string, string>)['Authorization'];
    // Authorization must be the JWT, not the anon key
    expect(auth).toBe(`Bearer ${MOCK_TOKEN}`);
    expect(auth).not.toContain('sb_publishable');
  });

  it('sums multiple nutrition rows correctly', async () => {
    mockGetAuthToken.mockResolvedValue(MOCK_TOKEN);
    mockFetch.mockResolvedValue({
      ok:   true,
      json: async () => [
        { water_oz: 12, calories: 400, protein_g: 30, carbs_g: 50, fat_g: 10, source: 'kahunas' },
        { water_oz: 8,  calories: 200, protein_g: 15, carbs_g: 20, fat_g: 5,  source: 'kahunas' },
      ],
    });

    const result = await fetchTodayNutrition();

    expect(result.water_oz).toBe(20);
    expect(result.calories).toBe(600);
    expect(result.protein_g).toBe(45);
    expect(result.carbs_g).toBe(70);
    expect(result.fat_g).toBe(15);
  });

  it('returns all-zero totals when no rows exist for today', async () => {
    mockGetAuthToken.mockResolvedValue(MOCK_TOKEN);
    mockFetch.mockResolvedValue({ ok: true, json: async () => [] });

    const result = await fetchTodayNutrition();

    expect(result).toEqual({ water_oz: 0, calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
  });

  it('throws when Supabase returns a non-OK status', async () => {
    mockGetAuthToken.mockResolvedValue(MOCK_TOKEN);
    mockFetch.mockResolvedValue({ ok: false, status: 403 });

    await expect(fetchTodayNutrition()).rejects.toThrow('Supabase error: 403');
  });
});

// ── Unauthenticated access ────────────────────────────────────────────────────

describe('fetchTodayNutrition — unauthenticated', () => {
  it('throws immediately without making a network request when token is null', async () => {
    mockGetAuthToken.mockResolvedValue(null);

    await expect(fetchTodayNutrition()).rejects.toThrow('Not authenticated');

    // Critical: no fetch call must occur — the anon key must NOT be used
    // as a fallback Authorization value
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
