// Oura token endpoint proxy logic — no Deno APIs, so it can be unit-tested.
//
// Two request shapes (JSON body):
//   Authorization code (initial connect):
//     { code, verifier, redirect_uri }
//   Refresh (app builds with token refresh):
//     { grant_type: 'refresh_token', refresh_token }
//
// Success → 200 { access_token, refresh_token?, expires_in? }
//   Older app builds read only access_token; the extra fields are additive.
//
// Failure → { error } with a status the app uses to classify the failure:
//   400 — malformed request from the app
//   401 — Oura rejected the refresh token (revoked, expired, already used,
//         or unrecognised). The user must reconnect Oura.
//         Observed live (Oct 2026): Oura answers an unrecognised refresh
//         token with 400 invalid_request, not invalid_grant.
//   500 — server misconfiguration (secrets missing)
//   502 — Oura token endpoint unavailable / unexpected response (transient)
//
// Oura refresh tokens are single-use: every successful refresh returns a new
// refresh_token that replaces the old one. The client secret never leaves the
// server. Tokens are passed through, never logged or stored here.

export const OURA_TOKEN_URL = 'https://api.ouraring.com/oauth/token';

export type TokenEnv = { clientId?: string; clientSecret?: string };
export type TokenResult = { status: number; body: Record<string, unknown> };

export async function handleTokenRequest(
  input: unknown,
  env: TokenEnv,
  fetchFn: typeof fetch = fetch,
): Promise<TokenResult> {
  const req = (input ?? {}) as Record<string, unknown>;
  const isRefresh = req.grant_type === 'refresh_token';

  if (isRefresh) {
    if (typeof req.refresh_token !== 'string' || !req.refresh_token) {
      return { status: 400, body: { error: 'Missing required field: refresh_token' } };
    }
  } else if (!req.code || !req.verifier || !req.redirect_uri) {
    return { status: 400, body: { error: 'Missing required fields: code, verifier, redirect_uri' } };
  }

  if (!env.clientId || !env.clientSecret) {
    console.error('OURA_CLIENT_ID or OURA_CLIENT_SECRET not configured in Supabase secrets');
    return { status: 500, body: { error: 'Server configuration error' } };
  }

  const params: Record<string, string> = isRefresh
    ? {
        grant_type:    'refresh_token',
        refresh_token: req.refresh_token as string,
        client_id:     env.clientId,
        client_secret: env.clientSecret,
      }
    : {
        grant_type:    'authorization_code',
        code:          String(req.code),
        redirect_uri:  String(req.redirect_uri),
        client_id:     env.clientId,
        client_secret: env.clientSecret,
        code_verifier: String(req.verifier),
      };

  let tokenRes: Response;
  try {
    tokenRes = await fetchFn(OURA_TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams(params).toString(),
    });
  } catch {
    return { status: 502, body: { error: 'Oura token endpoint unreachable' } };
  }

  let data: Record<string, unknown> = {};
  try { data = await tokenRes.json(); } catch { /* non-JSON body */ }

  if (tokenRes.ok && typeof data.access_token === 'string') {
    const body: Record<string, unknown> = { access_token: data.access_token };
    if (typeof data.refresh_token === 'string') body.refresh_token = data.refresh_token;
    if (typeof data.expires_in === 'number')    body.expires_in    = data.expires_in;
    return { status: 200, body };
  }

  if (tokenRes.status >= 500 || tokenRes.ok) {
    return { status: 502, body: { error: 'Token exchange failed' } };
  }

  // 4xx from Oura. For a refresh, the request shape is fixed, so a rejected
  // refresh token (invalid_grant / invalid_request / 401) means the grant is
  // unusable and only a reconnect can recover. Client errors (invalid_client,
  // unauthorized_client) are configuration problems — not the user's.
  const oauthError = typeof data.error === 'string' ? data.error : null;
  const CONFIG_ERRORS = new Set(['invalid_client', 'unauthorized_client', 'unsupported_grant_type']);
  if (isRefresh && !CONFIG_ERRORS.has(oauthError ?? '') &&
      (oauthError === 'invalid_grant' || oauthError === 'invalid_request' || tokenRes.status === 401)) {
    return { status: 401, body: { error: 'invalid_grant' } };
  }
  return { status: 400, body: { error: oauthError ?? 'Token exchange failed' } };
}
