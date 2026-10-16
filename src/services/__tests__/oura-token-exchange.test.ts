/**
 * oura-token-exchange.test.ts
 *
 * Edge Function logic (supabase/functions/oura-token-exchange/handler.ts):
 * initial code exchange stays backward compatible; refresh keeps the client
 * secret server-side, passes rotated tokens through, and maps Oura failures
 * to statuses the app classifies (401 revoked, 502 transient).
 */

import { handleTokenRequest, OURA_TOKEN_URL } from '../../../supabase/functions/oura-token-exchange/handler';

const ENV = { clientId: 'cid', clientSecret: 'secret' };

function oura(status: number, body: any) {
  return jest.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as any;
}
const formOf = (f: jest.Mock) => Object.fromEntries(new URLSearchParams(f.mock.calls[0][1].body));

beforeAll(() => jest.spyOn(console, 'error').mockImplementation(() => {}));

describe('refresh grant', () => {
  it('sends refresh_token + client credentials form-encoded to Oura and returns rotated tokens', async () => {
    const f = oura(200, { access_token: 'T2', refresh_token: 'R2', expires_in: 86400, token_type: 'bearer' });
    const r = await handleTokenRequest({ grant_type: 'refresh_token', refresh_token: 'R1' }, ENV, f);
    expect(f.mock.calls[0][0]).toBe(OURA_TOKEN_URL);
    expect(f.mock.calls[0][1].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(formOf(f)).toEqual({ grant_type: 'refresh_token', refresh_token: 'R1', client_id: 'cid', client_secret: 'secret' });
    expect(r).toEqual({ status: 200, body: { access_token: 'T2', refresh_token: 'R2', expires_in: 86400 } });
  });

  it('invalid_grant → 401 (reconnect required)', async () => {
    const r = await handleTokenRequest({ grant_type: 'refresh_token', refresh_token: 'R1' }, ENV, oura(400, { error: 'invalid_grant' }));
    expect(r).toEqual({ status: 401, body: { error: 'invalid_grant' } });
  });

  it('Oura 400 invalid_request for an unrecognised refresh token → 401 (observed live behavior)', async () => {
    const r = await handleTokenRequest({ grant_type: 'refresh_token', refresh_token: 'R1' }, ENV, oura(400, { error: 'invalid_request' }));
    expect(r).toEqual({ status: 401, body: { error: 'invalid_grant' } });
  });

  it('invalid_request on the code grant stays 400 (unchanged for build 135)', async () => {
    const r = await handleTokenRequest({ code: 'c', verifier: 'v', redirect_uri: 'x' }, ENV, oura(400, { error: 'invalid_request' }));
    expect(r).toEqual({ status: 400, body: { error: 'invalid_request' } });
  });

  it('client misconfiguration (invalid_client) is not reported as a revoked grant', async () => {
    const r = await handleTokenRequest({ grant_type: 'refresh_token', refresh_token: 'R1' }, ENV, oura(400, { error: 'invalid_client' }));
    expect(r.status).toBe(400);
  });

  it('Oura 5xx or unreachable → 502 (transient)', async () => {
    expect((await handleTokenRequest({ grant_type: 'refresh_token', refresh_token: 'R1' }, ENV, oura(503, {}))).status).toBe(502);
    const down = jest.fn(async () => { throw new TypeError('fetch failed'); }) as any;
    expect((await handleTokenRequest({ grant_type: 'refresh_token', refresh_token: 'R1' }, ENV, down)).status).toBe(502);
  });

  it('missing refresh_token → 400 without calling Oura', async () => {
    const f = oura(200, {});
    expect((await handleTokenRequest({ grant_type: 'refresh_token' }, ENV, f)).status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('authorization code grant (existing builds)', () => {
  it('still accepts { code, verifier, redirect_uri } and now also returns refresh_token/expires_in', async () => {
    const f = oura(200, { access_token: 'T1', refresh_token: 'R1', expires_in: 86400 });
    const r = await handleTokenRequest({ code: 'c', verifier: 'v', redirect_uri: 'bellahealth://oura-callback' }, ENV, f);
    expect(formOf(f)).toMatchObject({ grant_type: 'authorization_code', code: 'c', code_verifier: 'v', client_secret: 'secret' });
    expect(r.body.access_token).toBe('T1');
    expect(r.body.refresh_token).toBe('R1');
  });

  it('missing secrets → 500', async () => {
    const r = await handleTokenRequest({ code: 'c', verifier: 'v', redirect_uri: 'x' }, {}, oura(200, {}));
    expect(r.status).toBe(500);
  });
});
