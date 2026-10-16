// Claude API proxy client
//
// All Claude API calls route through the Supabase Edge Function at PROXY_URL.
// The proxy requires a valid Supabase session JWT (Authorization: Bearer <jwt>)
// and rejects unauthenticated requests with 401 before forwarding anything to
// Anthropic. The Anthropic API key lives as a Supabase server-side secret and
// is never present in the app bundle.
//
// The Supabase anon key is intentionally public — it identifies the project but
// grants no access to user data (protected by RLS).

import { getAuthToken } from '@/services/auth';

const PROXY_URL =
  `${process.env.EXPO_PUBLIC_SUPABASE_URL ?? ''}/functions/v1/claude-proxy`;
const SUPABASE_ANON_KEY =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

/**
 * POST a request to the Claude proxy Edge Function.
 *
 * Requires an active Supabase session — throws immediately if not
 * authenticated. The JWT is included as Authorization: Bearer so the
 * Edge Function can verify it before forwarding to Anthropic.
 *
 * @param body       Full Anthropic messages API body (`model`, `max_tokens`,
 *                   `messages` required; `system` and other fields forwarded).
 * @param betaHeader Optional `anthropic-beta` header value, e.g.
 *                   `'pdfs-2024-09-25'` for PDF document processing.
 * @returns          The text content of Claude's first response block.
 */
export async function claudeProxyPost(
  body:        object,
  betaHeader?: string,
): Promise<string> {
  const token = await getAuthToken();
  if (!token) throw new Error('Not authenticated');

  const headers: Record<string, string> = {
    apikey:          SUPABASE_ANON_KEY,
    Authorization:   `Bearer ${token}`,
    'content-type':  'application/json',
  };
  if (betaHeader) headers['anthropic-beta'] = betaHeader;

  const res = await fetch(PROXY_URL, {
    method:  'POST',
    headers,
    body:    JSON.stringify(body),
  });

  if (!res.ok) {
    const text  = await res.text();
    const clean = text.includes('<') ? `(${res.status})` : text;
    throw new Error(`Claude error ${clean}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text;
  if (text === undefined) {
    // The proxy returned HTTP 200 but no text content block — this is an
    // unexpected shape (content-filtered, quota exceeded, model error, etc.).
    // Throw so callers can surface a real error rather than silently showing
    // an empty response to the user.
    throw new Error('Claude response missing content block');
  }
  return text;
}
