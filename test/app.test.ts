import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const PASSWORD = 'correct horse battery staple';
const STATIC_TOKEN = 'static-token-static-token-static-token-0123';

/** A stand-in for api.sparebank1.no that records what the server sends to the bank. */
const bank = {
  calls: [] as { url: URL; method: string; headers: Headers; body: string }[],
  accessToken: 'bank-access-1',
  rejectAccessToken: undefined as string | undefined,
};

const fakeBank: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  const headers = new Headers(init?.headers);
  const body = init?.body === undefined || init.body === null ? '' : String(init.body);
  bank.calls.push({ url, method: init?.method ?? 'GET', headers, body });
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

  if (url.pathname === '/oauth/token') {
    const params = new URLSearchParams(body);
    if (params.get('grant_type') === 'refresh_token') bank.accessToken = 'bank-access-2';
    return json({ access_token: bank.accessToken, refresh_token: 'bank-refresh', expires_in: 600 });
  }
  if (headers.get('authorization') === `Bearer ${bank.rejectAccessToken}`) return json({ error: 'expired' }, 401);
  if (url.pathname === '/personal/banking/accounts') return json({ accounts: [{ key: 'k1', name: 'Brukskonto' }] });
  if (url.pathname === '/personal/banking/transfer/debit') return json({ paymentId: 'p1', warnings: [] });
  return json({ code: 'not.found' }, 404);
};

let base: string;
let dataDir: string;
let close: () => Promise<void>;

async function start(extraEnv: Record<string, string> = {}): Promise<void> {
  const config = loadConfig({
    SB1_CLIENT_ID: 'sb1-client',
    SB1_CLIENT_SECRET: 'sb1-secret-value',
    SB1_FIN_INST: 'fid-smn',
    PUBLIC_URL: 'http://localhost:3999',
    ADMIN_PASSWORD: PASSWORD,
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    MCP_STATIC_TOKEN: STATIC_TOKEN,
    DATA_DIR: dataDir,
    ...extraEnv,
  });
  const { app } = await createApp(config, fakeBank);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sb1-mcp-'));
  await start();
});
after(() => close());

const post = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: 'POST', body: new URLSearchParams(body), headers, redirect: 'manual' });

async function rpc(token: string, method: string, params: unknown = {}): Promise<any> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { result: unknown }).result;
}

const callTool = (token: string, name: string, args: unknown = {}) =>
  rpc(token, 'tools/call', { name, arguments: args });

test('the MCP endpoint rejects requests without a valid token', async () => {
  const none = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate') ?? '', /resource_metadata=".*oauth-protected-resource\/mcp"/);

  const wrong = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' });
  assert.equal(wrong.status, 401);
});

test('tools report that the bank is not connected before the BankID login', async () => {
  const result = await callTool(STATIC_TOKEN, 'sb1_list_accounts');
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not connected to SpareBank 1/);
});

test('transfer tools are hidden unless enabled', async () => {
  const { tools } = await rpc(STATIC_TOKEN, 'tools/list');
  const names = tools.map((t: { name: string }) => t.name);
  assert.ok(names.includes('sb1_list_transactions'));
  assert.ok(!names.some((n: string) => n.includes('transfer')));
});

test('connecting to the bank requires the admin password and a state this server issued', async () => {
  const denied = await post('/sparebank1/login', { password: 'wrong' });
  assert.equal(denied.status, 401);

  const forged = await fetch(`${base}/sparebank1/callback?code=abc&state=forged`);
  assert.equal(forged.status, 400);

  const login = await post('/sparebank1/login', { password: PASSWORD });
  assert.equal(login.status, 302);
  const authorize = new URL(login.headers.get('location')!);
  assert.equal(authorize.origin + authorize.pathname, 'https://api.sparebank1.no/oauth/authorize');
  assert.equal(authorize.searchParams.get('client_id'), 'sb1-client');
  assert.equal(authorize.searchParams.get('finInst'), 'fid-smn');
  assert.equal(authorize.searchParams.get('redirect_uri'), 'http://localhost:3999/sparebank1/callback');
  assert.equal(authorize.searchParams.get('client_secret'), null);
  const state = authorize.searchParams.get('state')!;

  const callback = await fetch(`${base}/sparebank1/callback?code=bankid-code&state=${state}`);
  assert.equal(callback.status, 200);
  const exchange = new URLSearchParams(bank.calls.at(-1)!.body);
  assert.equal(exchange.get('grant_type'), 'authorization_code');
  assert.equal(exchange.get('code'), 'bankid-code');
  assert.equal(exchange.get('client_secret'), 'sb1-secret-value');

  const replay = await fetch(`${base}/sparebank1/callback?code=bankid-code&state=${state}`);
  assert.equal(replay.status, 400);
});

test('bank tokens are encrypted at rest', async () => {
  const raw = await readFile(join(dataDir, 'store.json'), 'utf8');
  assert.ok(!raw.includes('bank-access-1'));
  assert.ok(!raw.includes('bank-refresh'));
});

test('tools call the bank with the right URL, token and media type', async () => {
  const result = await callTool(STATIC_TOKEN, 'sb1_list_accounts', { includeCreditCardAccounts: true });
  assert.deepEqual(JSON.parse(result.content[0].text), { accounts: [{ key: 'k1', name: 'Brukskonto' }] });
  const call = bank.calls.at(-1)!;
  assert.equal(call.url.href, 'https://api.sparebank1.no/personal/banking/accounts?includeCreditCardAccounts=true');
  assert.equal(call.headers.get('authorization'), 'Bearer bank-access-1');
  assert.equal(call.headers.get('accept'), 'application/vnd.sparebank1.v5+json; charset=utf-8');
});

test('list parameters are sent as repeated query parameters', async () => {
  await callTool(STATIC_TOKEN, 'sb1_list_transactions', {
    accountKeys: ['k1', 'k2'],
    fromDate: '2026-01-01',
    source: 'ALL',
  });
  assert.equal(bank.calls.at(-1)!.url.search, '?accountKey=k1&accountKey=k2&fromDate=2026-01-01&source=ALL');
});

test('invalid arguments never reach the bank', async () => {
  const before = bank.calls.length;
  const result = await callTool(STATIC_TOKEN, 'sb1_list_transactions', { accountKeys: ['k1'], fromDate: '01.01.2026' });
  assert.equal(result.isError, true);
  assert.equal(bank.calls.length, before);
});

test('an expired bank token is refreshed once and the call retried', async () => {
  bank.rejectAccessToken = 'bank-access-1';
  const result = await callTool(STATIC_TOKEN, 'sb1_list_accounts');
  assert.equal(result.isError, undefined);
  const [refresh, retry] = bank.calls.slice(-2);
  assert.equal(new URLSearchParams(refresh!.body).get('grant_type'), 'refresh_token');
  assert.equal(retry!.headers.get('authorization'), 'Bearer bank-access-2');
});

test('bank errors are returned to the model without leaking the token', async () => {
  const result = await callTool(STATIC_TOKEN, 'sb1_get_account', { accountKey: 'a/b' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /404/);
  assert.ok(!result.content[0].text.includes('bank-access'));
  assert.equal(bank.calls.at(-1)!.url.pathname, '/personal/banking/accounts/a%2Fb');
});

test('an MCP client gets tokens through OAuth only after the owner enters the password', async () => {
  const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
  const registered = (await (
    await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }),
    })
  ).json()) as { client_id: string };

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({
    client_id: registered.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
  });
  const consent = await fetch(`${base}/authorize?${query}`, { redirect: 'manual' });
  assert.equal(consent.status, 200);
  const html = await consent.text();
  assert.match(html, /Claude/);
  const request = /name="request" value="([^"]+)"/.exec(html)![1]!;

  const denied = await post('/authorize/approve', { request, password: 'wrong' });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('location'), null);

  const approved = await post('/authorize/approve', { request, password: PASSWORD });
  assert.equal(approved.status, 302);
  const back = new URL(approved.headers.get('location')!);
  assert.equal(back.origin + back.pathname, redirectUri);
  assert.equal(back.searchParams.get('state'), 'xyz');
  const code = back.searchParams.get('code')!;

  const exchange = (v: string) =>
    post('/token', {
      grant_type: 'authorization_code',
      client_id: registered.client_id,
      code,
      code_verifier: v,
      redirect_uri: redirectUri,
    });
  assert.equal((await exchange('wrong-verifier-wrong-verifier-wrong-verifier-wrong')).status, 400);
  const tokens = (await (await exchange(verifier)).json()) as { access_token: string; refresh_token: string };
  assert.equal((await exchange(verifier)).status, 400, 'codes are single use');

  const { tools } = await rpc(tokens.access_token, 'tools/list');
  assert.ok(tools.length > 10);

  const refresh = () =>
    post('/token', { grant_type: 'refresh_token', client_id: registered.client_id, refresh_token: tokens.refresh_token });
  const refreshed = (await (await refresh()).json()) as { access_token: string };
  await rpc(refreshed.access_token, 'tools/list');
  assert.equal((await refresh()).status, 400, 'refresh tokens rotate');
});

test('transfer tools appear when enabled and post to the transfer API', async () => {
  await close();
  await start({ SB1_ENABLE_TRANSFERS: 'true', ENCRYPTION_KEY: randomBytes(32).toString('base64'), DATA_DIR: await mkdtemp(join(tmpdir(), 'sb1-mcp-')) });
  const login = await post('/sparebank1/login', { password: PASSWORD });
  const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
  await fetch(`${base}/sparebank1/callback?code=c&state=${state}`);

  const result = await callTool(STATIC_TOKEN, 'sb1_transfer_between_accounts', {
    fromAccount: '1234.56.78903',
    toAccount: '12345678911',
    amount: '100.50',
  });
  assert.equal(result.isError, undefined);
  const call = bank.calls.at(-1)!;
  assert.equal(call.method, 'POST');
  assert.deepEqual(JSON.parse(call.body), { fromAccount: '12345678903', toAccount: '12345678911', amount: '100.50' });
});

test('repeated wrong passwords lock the admin forms', async () => {
  for (let i = 0; i < 5; i++) await post('/sparebank1/login', { password: 'wrong' });
  const locked = await post('/sparebank1/login', { password: PASSWORD });
  assert.equal(locked.status, 429);
});
