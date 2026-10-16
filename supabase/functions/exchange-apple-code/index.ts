// Supabase Edge Function — exchange-apple-code
//
// Exchanges Apple's one-time authorizationCode for a long-lived refresh_token
// and stores it in private.apple_tokens via a SECURITY DEFINER function.
//
// Called immediately after successful Sign in with Apple in the mobile app.
// The refresh_token is used at account-deletion time to revoke Apple access.
//
// Security invariants:
//   - authorizationCode, refresh_token, client_secret are NEVER logged.
//   - Only HTTP status codes and generic error types appear in logs.
//   - refresh_token is never returned to the client.
//   - The private schema table is accessed only via service_role RPC.
//   - Caller identity is verified via JWT before any Apple API call.
//
// Required Supabase secrets (injected by the platform):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
//   APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_CLIENT_ID, APPLE_PRIVATE_KEY

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const APPLE_TOKEN_ENDPOINT = 'https://appleid.apple.com/auth/token';

// ── base64url ─────────────────────────────────────────────────────────────────

function base64url(data: string | ArrayBuffer): string {
  const bytes = typeof data === 'string'
    ? new TextEncoder().encode(data)
    : new Uint8Array(data);
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ── Apple client_secret ───────────────────────────────────────────────────────
//
// Generates a short-lived ES256 JWT signed with the .p8 private key.
// The resulting client_secret is used in the Apple token and revoke endpoints.
// It is NEVER logged or returned to the client.

async function generateClientSecret(): Promise<string> {
  const teamId   = Deno.env.get('APPLE_TEAM_ID')!;
  const keyId    = Deno.env.get('APPLE_KEY_ID')!;
  const clientId = Deno.env.get('APPLE_CLIENT_ID')!;
  const pemKey   = Deno.env.get('APPLE_PRIVATE_KEY')!;

  const now = Math.floor(Date.now() / 1000);

  const header  = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const payload = base64url(JSON.stringify({
    iss: teamId,
    iat: now,
    exp: now + 300,   // 5-minute expiry — minimum viable window
    aud: 'https://appleid.apple.com',
    sub: clientId,
  }));
  const signingInput = `${header}.${payload}`;

  const pemContents = pemKey
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');

  const keyBytes = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes.buffer,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64url(signature)}`;
}

// ── Handler ───────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return new Response(null, { status: 405, headers: CORS_HEADERS });
  }

  // ── Verify caller identity ─────────────────────────────────────────────────
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

  // ── Parse request body ─────────────────────────────────────────────────────
  // authorizationCode is single-use and expires in ~5 minutes.
  // It is never logged here or anywhere in this function.
  let authorizationCode: string;
  try {
    const body = await req.json();
    if (typeof body.authorizationCode !== 'string' || !body.authorizationCode) {
      return new Response(
        JSON.stringify({ error: 'Missing authorizationCode' }),
        { status: 400, headers: { 'content-type': 'application/json', ...CORS_HEADERS } },
      );
    }
    authorizationCode = body.authorizationCode;
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid request body' }),
      { status: 400, headers: { 'content-type': 'application/json', ...CORS_HEADERS } },
    );
  }

  // ── Generate client_secret ─────────────────────────────────────────────────
  let clientSecret: string;
  try {
    clientSecret = await generateClientSecret();
  } catch (err) {
    console.error('[exchange-apple-code] client_secret generation error:', (err as Error).message);
    return new Response(
      JSON.stringify({ error: 'Server configuration error' }),
      { status: 500, headers: { 'content-type': 'application/json', ...CORS_HEADERS } },
    );
  }

  // ── Exchange code for refresh_token with Apple ─────────────────────────────
  // The request body, Apple response body, and resulting tokens are never logged.
  // Only the HTTP status code is logged on failure.
  let refreshToken: string;
  try {
    const params = new URLSearchParams({
      client_id:     Deno.env.get('APPLE_CLIENT_ID')!,
      client_secret: clientSecret,
      code:          authorizationCode,
      grant_type:    'authorization_code',
    });

    const appleRes = await fetch(APPLE_TOKEN_ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString(),
    });

    if (!appleRes.ok) {
      console.error('[exchange-apple-code] Apple token endpoint HTTP', appleRes.status);
      return new Response(
        JSON.stringify({ error: 'Apple token exchange failed' }),
        { status: 502, headers: { 'content-type': 'application/json', ...CORS_HEADERS } },
      );
    }

    const appleJson = await appleRes.json();
    if (typeof appleJson.refresh_token !== 'string' || !appleJson.refresh_token) {
      console.error('[exchange-apple-code] Apple response missing refresh_token');
      return new Response(
        JSON.stringify({ error: 'Apple token exchange incomplete' }),
        { status: 502, headers: { 'content-type': 'application/json', ...CORS_HEADERS } },
      );
    }

    refreshToken = appleJson.refresh_token;
    // appleJson goes out of scope — refresh_token lives only in refreshToken variable
  } catch (err) {
    console.error('[exchange-apple-code] Apple fetch error:', (err as Error).message);
    return new Response(
      JSON.stringify({ error: 'Server error contacting Apple' }),
      { status: 500, headers: { 'content-type': 'application/json', ...CORS_HEADERS } },
    );
  }

  // ── Store refresh_token server-side via SECURITY DEFINER function ──────────
  // Uses service_role to call internal_upsert_apple_token, which writes to
  // private.apple_tokens — a schema not accessible via PostgREST to clients.
  // The refresh_token is never returned to the caller.
  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { error: dbError } = await supabaseAdmin.rpc('internal_upsert_apple_token', {
    p_user_id:       user.id,
    p_refresh_token: refreshToken,
  });

  if (dbError) {
    console.error('[exchange-apple-code] token storage failed:', dbError.message);
    return new Response(
      JSON.stringify({ error: 'Token storage failed' }),
      { status: 500, headers: { 'content-type': 'application/json', ...CORS_HEADERS } },
    );
  }

  return new Response(
    JSON.stringify({ ok: true }),
    { status: 200, headers: { 'content-type': 'application/json', ...CORS_HEADERS } },
  );
});
