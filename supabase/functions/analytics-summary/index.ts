// Supabase Edge Function — founder analytics summary
//
// Returns pre-aggregated analytics metrics for the private founder dashboard.
// This function NEVER returns raw rows — only aggregated counts.
//
// Authentication:
//   Callers must include the header:
//     X-Dashboard-Secret: <value of DASHBOARD_SECRET env var>
//   The anon key in the Authorization header identifies the Supabase project
//   but does NOT grant access — only the dashboard secret does.
//
// The DASHBOARD_SECRET env var is set in the Supabase dashboard under
//   Project → Edge Functions → analytics-summary → Secrets
//   It is never stored client-side or in the iOS app.
//
// Query parameter: ?range=today|7d|30d|all  (default: 7d)

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dashboard-secret',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== 'GET') {
    return new Response(null, { status: 405, headers: CORS_HEADERS });
  }

  // ── Authentication ─────────────────────────────────────────────────────────
  const expectedSecret = Deno.env.get('DASHBOARD_SECRET');
  if (!expectedSecret) {
    // Misconfiguration — DASHBOARD_SECRET not set in Supabase secrets
    console.error('[analytics-summary] DASHBOARD_SECRET env var not configured');
    return new Response(JSON.stringify({ error: 'Server misconfiguration' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const providedSecret = req.headers.get('x-dashboard-secret');
  if (providedSecret !== expectedSecret) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  // ── Time range ─────────────────────────────────────────────────────────────
  const url   = new URL(req.url);
  const range = url.searchParams.get('range') ?? '7d';

  let since: string | null = null;
  if (range !== 'all') {
    const now = new Date();
    if (range === 'today') {
      // Start of today UTC
      const d = new Date(now);
      d.setUTCHours(0, 0, 0, 0);
      since = d.toISOString();
    } else if (range === '7d') {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - 7);
      since = d.toISOString();
    } else if (range === '30d') {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - 30);
      since = d.toISOString();
    }
  }

  // ── Query ──────────────────────────────────────────────────────────────────
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data, error } = await supabase.rpc('get_analytics_v2', {
    p_since: since,
  });

  if (error) {
    console.error('[analytics-summary] rpc error:', error.message);
    return new Response(JSON.stringify({ error: 'Query failed' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ range, data }), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
});
