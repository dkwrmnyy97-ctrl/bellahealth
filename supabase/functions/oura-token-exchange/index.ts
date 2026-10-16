// Oura OAuth token exchange + refresh proxy
//
// Keeps OURA_CLIENT_SECRET server-side so it is never present in the app bundle.
//
// POST /functions/v1/oura-token-exchange
// Headers: apikey: <supabase-anon-key>
// Body JSON: { code, verifier, redirect_uri }                  — initial connect
//        or: { grant_type: 'refresh_token', refresh_token }    — token refresh
// Returns JSON: { access_token, refresh_token?, expires_in? }  or  { error }
// Status codes are documented in handler.ts.
//
// Required Supabase secrets (set via: supabase secrets set KEY=value):
//   OURA_CLIENT_ID     — the Oura OAuth app client ID
//   OURA_CLIENT_SECRET — the Oura OAuth app client secret

import { handleTokenRequest } from './handler.ts';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  try {
    let input: unknown = null;
    try { input = await req.json(); } catch { /* handled as missing fields */ }

    const { status, body } = await handleTokenRequest(input, {
      clientId:     Deno.env.get('OURA_CLIENT_ID'),
      clientSecret: Deno.env.get('OURA_CLIENT_SECRET'),
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('oura-token-exchange error:', e instanceof Error ? e.message : 'unknown');
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
