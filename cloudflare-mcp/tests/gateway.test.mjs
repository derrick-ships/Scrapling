import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mkdir, writeFile } from 'node:fs/promises';
let mf, backendCalls = [], githubLogin = 'derrick-ships';
const origin = 'http://127.0.0.1';
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
before(async () => {
  await mkdir('.wrangler/tests', { recursive: true });
  await build({ entryPoints: ['tests/fixture.ts'], bundle: true, format: 'esm', platform: 'browser', conditions: ['workerd','browser'], outfile: '.wrangler/tests/worker.js', external: ['cloudflare:workers', 'node:*'] });
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, scriptPath: '.wrangler/tests/worker.js', compatibilityDate: '2026-10-10', compatibilityFlags: ['nodejs_compat','global_fetch_strictly_public'], kvNamespaces: ['OAUTH_KV'], bindings: { PUBLIC_ORIGIN: origin, APP_NAME: 'Scrapling MCP', GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret', BACKEND_MCP_URL: 'https://backend.example/mcp', BACKEND_AUTH_TOKEN: 'test-backend-token', ALLOWED_GITHUB_USERS: 'derrick-ships' }, outboundService: async request => {
    const u = new URL(request.url);
    if (u.hostname === 'github.com') return json({ access_token: 'test-github-token' });
    if (u.hostname === 'api.github.com') return json({ id: 1234, login: githubLogin });
    if (u.hostname === 'backend.example') {
      assert.equal(request.headers.get('Authorization'), 'Bearer test-backend-token');
      if (request.method === 'DELETE') return new Response(null, { status: 200 });
      if (request.method === 'GET') return new Response(null, { status: 405 });
      const rpc = await request.json();
      if (rpc.method.startsWith('notifications/')) return new Response(null, { status: 202 });
      let result;
      if (rpc.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'Scrapling', version: 'mock' } };
      else if (rpc.method === 'tools/list') result = { tools: ['make_request','fetch','stealthy_fetch','bulk_get'].map(name => ({ name, inputSchema: { type: 'object', additionalProperties: true } })) };
      else if (rpc.method === 'tools/call') { backendCalls.push(rpc.params); result = { content: [{ type: 'text', text: 'Example Domain' }] }; }
      else throw new Error(`Unexpected method ${rpc.method}`);
      return json({ jsonrpc: '2.0', id: rpc.id, result });
    }
    if (u.hostname === 'client.example') return json({ client_id: 'https://client.example/client.json', client_name: 'CIMD Client', redirect_uris: ['http://localhost:9999/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code','refresh_token'], response_types: ['code'] });
    throw new Error('Unexpected outbound host');
  } }));
});
after(async () => { await mf?.dispose(); });
const request = (path, options) => { const headers = new Headers(options?.headers); headers.set('Host','127.0.0.1'); return mf.dispatchFetch(`${origin}${path}`, {redirect:'manual', ...options, headers}); };
async function start(clientId) {
  if (!clientId) {
    const registered = await request('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Test Agent <script>', redirect_uris: ['http://localhost:9999/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code','refresh_token'], response_types: ['code'] }) });
    assert.equal(registered.status, 201); clientId = (await registered.json()).client_id;
  }
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'http://localhost:9999/callback', resource: `${origin}/mcp`, scope: 'scrape:read offline_access', state: 'client-state', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
  const response = await request(`/authorize?${params}`); assert.equal(response.status, 200);
  const html = await response.text(), handle = html.match(/name="handle" value="([^"]+)"/)[1];
  return { clientId, verifier, params, html, handle, cookie: response.headers.get('set-cookie').split(';')[0] };
}
const postConsent = (a, decision, cookie=a.cookie) => request('/authorize', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }, body: new URLSearchParams({ handle: a.handle, decision }) });
async function authorize() {
  const a = await start(), allowed = await postConsent(a, 'approve');
  assert.equal(allowed.status, 302);
  const redirect = new URL(allowed.headers.get('location')); assert.equal(redirect.hostname, 'github.com'); assert.equal(redirect.searchParams.get('code_challenge_method'), 'S256');
  const cookie = allowed.headers.getSetCookie().filter(c=>c.includes('upstream')).map(c=>c.split(';')[0]).join('; ');
  const callback = await request(`/callback?state=${redirect.searchParams.get('state')}&code=mock-code`, { headers: { Cookie: cookie } });
  assert.equal(callback.status, 302);
  const clientReturn = new URL(callback.headers.get('location'));
  return { ...a, code: clientReturn.searchParams.get('code'), clientReturn };
}
const readRPC = async response => { const text = await response.text(); return JSON.parse(text.startsWith('event:') ? text.split('\n').find(s=>s.startsWith('data: ')).slice(6) : text); };
const exchange = a => request('/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: a.clientId, code: a.code, redirect_uri: 'http://localhost:9999/callback', code_verifier: a.verifier, resource: `${origin}/mcp` }) });
test('OAuth metadata, canonical audience, root alias and unauthenticated challenge', async () => {
  const denied = await request('/mcp'); assert.equal(denied.status, 401); assert.match(denied.headers.get('www-authenticate'), /oauth-protected-resource\/mcp/);
  for (const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp']) { const metadata = await (await request(path)).json(); assert.equal(metadata.resource, `${origin}/mcp`); }
  const auth = await (await request('/.well-known/oauth-authorization-server')).json(); assert.equal(auth.token_endpoint, `${origin}/token`); assert.ok(auth.code_challenge_methods_supported.includes('S256')); assert.equal(auth.client_id_metadata_document_supported, true);
});
test('Escaped dark consent, PKCE, browser binding, deny and replay rejection', async () => {
  const a = await start(); await writeFile('.wrangler/tests/consent.html', a.html); assert.ok(a.html.includes('&#60;script&#62;')); assert.match(a.html, />Allow</); assert.match(a.html, />Deny</);
  assert.equal((await postConsent(a,'approve','')).status, 400);
  const denied = await postConsent(a,'deny'); assert.equal(denied.status,302); const u = new URL(denied.headers.get('location')); assert.equal(u.searchParams.get('error'),'access_denied'); assert.equal(u.searchParams.get('state'),'client-state'); assert.equal(u.searchParams.get('iss'),origin);
  assert.equal((await postConsent(a,'approve')).status,400);
  a.params.delete('code_challenge'); a.params.delete('code_challenge_method'); assert.notEqual((await request(`/authorize?${a.params}`)).status,200);
});
test('CIMD client identity appears on consent page', async () => { const a = await start('https://client.example/client.json'); assert.match(a.html,/client.example/); });
test('Full OAuth exchange, wrong PKCE, code replay, tools and backend forwarding', async () => {
  const wrong = await authorize(); const saved = wrong.verifier; wrong.verifier = 'wrong'.repeat(12); assert.equal((await exchange(wrong)).status,400); wrong.verifier=saved;
  const probe = await request('/test-backend'); assert.equal(probe.status,200,await probe.clone().text());
  const a = await authorize(); assert.equal(a.clientReturn.searchParams.get('state'),'client-state');
  const exchanged = await exchange(a); assert.equal(exchanged.status,200); const token = await exchanged.json(); assert.ok(token.access_token); assert.ok(token.refresh_token);
  const rpc = async (method, params) => request('/mcp',{method:'POST',headers:{Authorization:`Bearer ${token.access_token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  const initialized = await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'Test Agent',version:'1'}}); assert.equal(initialized.status,200, await initialized.clone().text());
  const listed = await readRPC(await rpc('tools/list',{})); assert.equal(listed.result.tools.length,4);
  const called = await readRPC(await rpc('tools/call',{name:'scrape_http',arguments:{url:'https://example.com',css_selector:'h1'}})); assert.equal(called.result.content[0].text,'Example Domain'); assert.equal(backendCalls.at(-1).name,'make_request'); assert.equal(backendCalls.at(-1).arguments.method,'GET');
  const modern = new Client({name:'Modern Test',version:'1'}, {versionNegotiation:{mode:'auto'}});
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {requestInit:{headers:{Authorization:`Bearer ${token.access_token}`}},fetch:(input,init)=>request('/mcp',init)});
  await modern.connect(transport);
  assert.equal(modern.getNegotiatedProtocolVersion(),'2026-07-28');
  assert.equal(modern.getProtocolEra(),'modern');
  assert.equal((await modern.listTools()).tools.length,4);
  assert.equal((await modern.callTool({name:'scrape_dynamic',arguments:{url:'https://example.com'}})).content[0].text,'Example Domain');
  await modern.close();
  const refreshed = await request('/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:token.refresh_token,client_id:a.clientId,resource:`${origin}/mcp`})}); assert.equal(refreshed.status,200);
  assert.equal((await exchange(a)).status,400);
});
test('An unapproved GitHub account gets no MCP authorization code', async () => {
  githubLogin = 'other-user'; const a = await authorize(); assert.equal(a.clientReturn.searchParams.get('error'),'access_denied'); assert.equal(a.code,null); githubLogin='derrick-ships';
});
