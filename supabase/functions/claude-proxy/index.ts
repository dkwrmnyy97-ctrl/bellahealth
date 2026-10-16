// Supabase Edge Function — Claude API proxy
//
// SECURITY: All requests must carry a valid Supabase session JWT in the
// Authorization: Bearer header. The JWT is verified against Supabase Auth
// before any request is forwarded to Anthropic. Unauthenticated requests
// are rejected with 401.
//
// The Anthropic API key never leaves this server. It is read from a Supabase
// secret (ANTHROPIC_API_KEY) and is never present in the client app bundle.
//
// Additional server-side controls (defense-in-depth):
//   - Only the specific Claude models used by BellaHealth are forwarded.
//   - max_tokens is capped server-side regardless of client value.
//   - The request body must be a valid JSON object with required fields.
//   - anthropic-beta is only forwarded for the one allowed value.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// Allowlist: only models actually used by BellaHealth
const ALLOWED_MODELS = new Set([
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
]);

// Hard cap: server enforces this regardless of what the client requests.
// Chat uses 512, food-ai uses 1024, document-ai uses 4096.
const MAX_TOKENS_CAP = 4096;

// Only the PDF beta header is forwarded; all others are dropped.
const ALLOWED_BETA = 'pdfs-2024-09-25';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, anthropic-beta',
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
  }

  // ── Verify Supabase JWT ───────────────────────────────────────────────────────
  // Reject any request that does not carry a valid signed session JWT.
  // This prevents unauthenticated callers from reaching Anthropic at all.
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(
      JSON.stringify({ error: 'Authorization required' }),
      { status: 401, headers: { 'content-type': 'application/json', ...CORS_HEADERS } },
    );
  }

  const supabaseUser = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: { user }, error: authError } = await supabaseUser.auth.getUser();
  if (authError || !user) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'content-type': 'application/json', ...CORS_HEADERS } },
    );
  }
  // ─────────────────────────────────────────────────────────────────────────────

  if (!ANTHROPIC_API_KEY) {
    console.error('[claude-proxy] ANTHROPIC_API_KEY secret is not set');
    return new Response(
      JSON.stringify({ error: 'Proxy misconfigured: missing API key' }),
      { status: 500, headers: { 'content-type': 'application/json', ...CORS_HEADERS } },
    );
  }

  // ── Parse and validate the request body ──────────────────────────────────────
  let parsed: Record<string, unknown>;
  try {
    const raw = await req.text();
    parsed = JSON.parse(raw);
  } catch {
    return new Response(
      JSON.stringify({ error: 'Request body must be valid JSON' }),
      { status: 400, headers: { 'content-type': 'application/json', ...CORS_HEADERS } },
    );
  }

  // Require model and messages fields
  if (typeof parsed.model !== 'string' || !Array.isArray(parsed.messages)) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields: model, messages' }),
      { status: 400, headers: { 'content-type': 'application/json', ...CORS_HEADERS } },
    );
  }

  // Model allowlist — reject anything other than BellaHealth's own models
  if (!ALLOWED_MODELS.has(parsed.model)) {
    return new Response(
      JSON.stringify({ error: 'Model not permitted' }),
      { status: 400, headers: { 'content-type': 'application/json', ...CORS_HEADERS } },
    );
  }

  // Cap max_tokens server-side — ignore whatever the client sent if it exceeds the cap
  const requestedTokens = typeof parsed.max_tokens === 'number' ? parsed.max_tokens : MAX_TOKENS_CAP;
  parsed.max_tokens = Math.min(requestedTokens, MAX_TOKENS_CAP);

  try {
    // Build upstream Anthropic headers.
    // Only forward anthropic-beta for the known PDF processing value.
    const anthropicHeaders: Record<string, string> = {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    };
    const betaHeader = req.headers.get('anthropic-beta');
    if (betaHeader === ALLOWED_BETA) anthropicHeaders['anthropic-beta'] = betaHeader;

    const upstream = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: anthropicHeaders,
      body: JSON.stringify(parsed),
    });

    const responseText = await upstream.text();

    return new Response(responseText, {
      status: upstream.status,
      headers: { 'content-type': 'application/json', ...CORS_HEADERS },
    });
  } catch (err) {
    console.error('[claude-proxy] Unexpected error:', err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { 'content-type': 'application/json', ...CORS_HEADERS } },
    );
  }
});
