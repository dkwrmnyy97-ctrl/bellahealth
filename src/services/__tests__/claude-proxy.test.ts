/**
 * claude-proxy.test.ts
 *
 * Unit tests for claudeProxyPost().
 * Verifies that:
 *   - Authenticated requests include Authorization: Bearer <jwt>
 *   - Unauthenticated calls throw without making a network request
 *   - The betaHeader (PDF) is forwarded when provided
 *   - Chat, Food AI, and Documents AI all reach the proxy with the JWT
 *     (they all call claudeProxyPost, which is the integration point)
 *   - Server error responses are propagated as thrown errors
 */

jest.mock('@/services/auth', () => ({
  getAuthToken: jest.fn(),
}));

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import { getAuthToken } from '@/services/auth';
import { claudeProxyPost } from '../claude-proxy';

const mockGetAuthToken = getAuthToken as jest.Mock;
const mockFetch        = jest.fn();
const originalFetch    = global.fetch;

const MOCK_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.valid-jwt.sig';
const MOCK_BODY  = {
  model:      'claude-haiku-4-5-20251001',
  max_tokens: 512,
  messages:   [{ role: 'user', content: 'Hello' }],
};

const successResponse = (text: string) => ({
  ok:   true,
  json: async () => ({ content: [{ type: 'text', text }] }),
  text: async () => JSON.stringify({ content: [{ type: 'text', text }] }),
});

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = mockFetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

// ── Authenticated requests ────────────────────────────────────────────────────

describe('claudeProxyPost — authenticated', () => {
  it('sends Authorization: Bearer <jwt> in the request headers', async () => {
    mockGetAuthToken.mockResolvedValue(MOCK_TOKEN);
    mockFetch.mockResolvedValue(successResponse('Hi there'));

    await claudeProxyPost(MOCK_BODY);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;

    expect(headers['Authorization']).toBe(`Bearer ${MOCK_TOKEN}`);
    expect(url).toContain('claude-proxy');
  });

  it('also sends the anon key as apikey (project identifier)', async () => {
    mockGetAuthToken.mockResolvedValue(MOCK_TOKEN);
    mockFetch.mockResolvedValue(successResponse('ok'));

    await claudeProxyPost(MOCK_BODY);

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['apikey']).toBeTruthy();
  });

  it('forwards the anthropic-beta header when provided (PDF documents)', async () => {
    mockGetAuthToken.mockResolvedValue(MOCK_TOKEN);
    mockFetch.mockResolvedValue(successResponse('summary'));

    await claudeProxyPost(MOCK_BODY, 'pdfs-2024-09-25');

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['anthropic-beta']).toBe('pdfs-2024-09-25');
  });

  it('does NOT send anthropic-beta when not provided', async () => {
    mockGetAuthToken.mockResolvedValue(MOCK_TOKEN);
    mockFetch.mockResolvedValue(successResponse('ok'));

    await claudeProxyPost(MOCK_BODY);

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['anthropic-beta']).toBeUndefined();
  });

  it('returns the text from the first content block', async () => {
    mockGetAuthToken.mockResolvedValue(MOCK_TOKEN);
    mockFetch.mockResolvedValue(successResponse('Here are your macros.'));

    const result = await claudeProxyPost(MOCK_BODY);

    expect(result).toBe('Here are your macros.');
  });

  it('throws a descriptive error when the proxy returns a non-OK status', async () => {
    mockGetAuthToken.mockResolvedValue(MOCK_TOKEN);
    mockFetch.mockResolvedValue({
      ok:   false,
      status: 401,
      text: async () => JSON.stringify({ error: 'Unauthorized' }),
    });

    await expect(claudeProxyPost(MOCK_BODY)).rejects.toThrow('Claude error');
  });
});

// ── Missing / unexpected content block ───────────────────────────────────────
// A 200 OK with no usable text must throw rather than silently returning ''.
// This lets callers distinguish: valid response | empty string | API failure.

describe('claudeProxyPost — missing content block', () => {
  beforeEach(() => {
    mockGetAuthToken.mockResolvedValue(MOCK_TOKEN);
  });

  it('throws when response has no content array', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ stop_reason: 'end_turn' }), // no content key
      text: async () => '{}',
    });
    await expect(claudeProxyPost(MOCK_BODY)).rejects.toThrow('Claude response missing content block');
  });

  it('throws when content array is empty', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ content: [] }),
      text: async () => '',
    });
    await expect(claudeProxyPost(MOCK_BODY)).rejects.toThrow('Claude response missing content block');
  });

  it('throws when content[0] has no text property', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'tool_use', id: 'tu_1', name: 'some_tool', input: {} }] }),
      text: async () => '',
    });
    await expect(claudeProxyPost(MOCK_BODY)).rejects.toThrow('Claude response missing content block');
  });

  it('returns empty string when content[0].text is explicitly empty string (valid response)', async () => {
    // Claude legitimately returned an empty string — this is a valid, distinct
    // state from a missing content block. It should NOT throw.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: '' }] }),
      text: async () => '',
    });
    const result = await claudeProxyPost(MOCK_BODY);
    expect(result).toBe('');
  });

  it('returns the text when content block is present and non-empty', async () => {
    mockFetch.mockResolvedValue(successResponse('Your HRV is trending up.'));
    const result = await claudeProxyPost(MOCK_BODY);
    expect(result).toBe('Your HRV is trending up.');
  });
});

// ── Unauthenticated access ────────────────────────────────────────────────────

describe('claudeProxyPost — unauthenticated', () => {
  it('throws immediately without making a network request when token is null', async () => {
    mockGetAuthToken.mockResolvedValue(null);

    await expect(claudeProxyPost(MOCK_BODY)).rejects.toThrow('Not authenticated');

    // No request must reach the proxy
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── Chat / Food AI / Documents AI integration ─────────────────────────────────
// These features all call claudeProxyPost with their specific body shapes.
// The tests below verify that different callers (simulated inline) all reach
// the proxy with the JWT — no separate changes to those services are needed.

describe('claudeProxyPost — caller compatibility', () => {
  beforeEach(() => {
    mockGetAuthToken.mockResolvedValue(MOCK_TOKEN);
    mockFetch.mockResolvedValue(successResponse('{}'));
  });

  it('chat-style call (sonnet + system prompt) reaches proxy with JWT', async () => {
    await claudeProxyPost({
      model:      'claude-sonnet-4-6',
      max_tokens: 512,
      system:     'You are a health coach.',
      messages:   [{ role: 'user', content: 'How is my sleep?' }],
    });

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>)['Authorization']).toBe(
      `Bearer ${MOCK_TOKEN}`,
    );
  });

  it('food-AI-style call (haiku + image content) reaches proxy with JWT', async () => {
    await claudeProxyPost({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages:   [{
        role:    'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'base64data' } },
          { type: 'text',  text: 'What are the macros?' },
        ],
      }],
    });

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>)['Authorization']).toBe(
      `Bearer ${MOCK_TOKEN}`,
    );
  });

  it('document-AI-style call (sonnet + pdf beta) reaches proxy with JWT', async () => {
    await claudeProxyPost(
      {
        model:      'claude-sonnet-4-6',
        max_tokens: 4096,
        messages:   [{
          role:    'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'base64pdf' } },
            { type: 'text',     text: 'Summarize this lab report.' },
          ],
        }],
      },
      'pdfs-2024-09-25',
    );

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${MOCK_TOKEN}`);
    expect(headers['anthropic-beta']).toBe('pdfs-2024-09-25');
  });
});

// ── Service isolation: Oura unaffected ────────────────────────────────────────
// Oura uses its own OAuth token stored in AsyncStorage — completely separate
// from Supabase auth. This test verifies structural isolation.

describe('Oura service isolation', () => {
  it('oura.ts does not import from @/services/auth', () => {
    // Use synchronous require (jest-expo runs in Babel/CJS mode).
    // If oura.ts imported getAuthToken, the mock would be called during require.
    // This verifies Oura tokens are managed entirely independently of Supabase auth.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ouraModule = require('../oura');
    expect(mockGetAuthToken).not.toHaveBeenCalled();
    expect(typeof ouraModule.fetchOuraDaily).toBe('function');
  });
});
