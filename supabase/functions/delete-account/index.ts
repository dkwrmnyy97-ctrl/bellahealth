// Supabase Edge Function — delete-account
//
// Permanently deletes all of a user's BellaHealth server-side data:
//   1. Verifies the caller's Supabase session JWT.
//   2. Attempts Apple token revocation (best-effort — deletion proceeds regardless).
//   3. Deletes all nutrition_log rows for the user (via service role).
//   4. Deletes the auth.users entry — ON DELETE CASCADE removes all remaining
//      rows in public.* and private.apple_tokens automatically.
//
// Apple revocation policy:
//   - Attempted before deletion so the token is still readable.
//   - If Apple's API is unavailable or returns an error, deletion still completes.
//   - Only HTTP status codes and generic error types are logged.
//   - The refresh_token, client_secret, and Apple response body are never logged.
//
// Required Supabase secrets (automatically injected by the platform):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
//   APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_CLIENT_ID, APPLE_PRIVATE_KEY

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const APPLE_REVOKE_ENDPOINT = 'https://appleid.apple.com/auth/revoke';

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
// Never logged or returned to the client.

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
    exp: now + 300,
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

  // ── Verify JWT ─────────────────────────────────────────────────────────────
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

  const userId = user.id;

  // ── Service-role client ────────────────────────────────────────────────────
  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // ── Apple token revocation (best-effort) ───────────────────────────────────
  // Fetch token BEFORE deletion — CASCADE will remove it when auth.users is deleted.
  // Deletion proceeds regardless of whether revocation succeeds or Apple is reachable.
  // The refresh_token is read, used once, and never logged.
  const { data: appleRefreshToken } = await supabaseAdmin.rpc(
    'internal_get_apple_refresh_token',
    { p_user_id: userId },
  );

  if (typeof appleRefreshToken === 'string' && appleRefreshToken.length > 0) {
    try {
      const clientSecret = await generateClientSecret();

      const revokeParams = new URLSearchParams({
        client_id:       Deno.env.get('APPLE_CLIENT_ID')!,
        client_secret:   clientSecret,
        token:           appleRefreshToken,
        token_type_hint: 'refresh_token',
      });

      const revokeRes = await fetch(APPLE_REVOKE_ENDPOINT, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    revokeParams.toString(),
      });

      if (!revokeRes.ok) {
        // Log only HTTP status — not the token, client_secret, or response body
        console.error('[delete-account] Apple revocation HTTP', revokeRes.status, '— proceeding with deletion');
      }
      // revokeRes body is not read — contains no information we need and may
      // contain credential-adjacent data we must not log
    } catch (err) {
      console.error('[delete-account] Apple revocation error:', (err as Error).message, '— proceeding with deletion');
    }
    // Deletion always continues past this point
  }

  // ── Delete nutrition data ──────────────────────────────────────────────────
  const { error: nutritionError } = await supabaseAdmin
    .from('nutrition_log')
    .delete()
    .eq('user_id', userId);

  if (nutritionError) {
    console.error('[delete-account] nutrition_log delete failed:', nutritionError.message);
    return new Response(
      JSON.stringify({ error: 'Failed to delete nutrition data' }),
      { status: 500, headers: { 'content-type': 'application/json', ...CORS_HEADERS } },
    );
  }

  // ── Delete auth user ───────────────────────────────────────────────────────
  // ON DELETE CASCADE automatically removes rows in:
  //   public.user_profiles, public.training_goals, public.context_events,
  //   public.drink_log, private.apple_tokens
  const { error: userError } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (userError) {
    console.error('[delete-account] auth.admin.deleteUser failed:', userError.message);
    return new Response(
      JSON.stringify({ error: 'Failed to delete account' }),
      { status: 500, headers: { 'content-type': 'application/json', ...CORS_HEADERS } },
    );
  }

  return new Response(null, { status: 204, headers: CORS_HEADERS });
});
