import { AuthorizationError, CimdFetchError, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';
import { consentPage, page, escape } from './consent';
import type { Env, Identity } from './types';
export const isAllowed = (login: unknown, env: Env) => typeof login === 'string' && env.ALLOWED_GITHUB_USERS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).includes(login.toLowerCase());
const redirect = (headers: Headers, location: string) => { headers.set('Location', location); return new Response(null, { status: 302, headers }); };
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function authHandler(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url), oauth = env.OAUTH_PROVIDER;
  try {
    if (url.pathname === '/' && req.method === 'GET') return new Response(page(env.APP_NAME, `<div class="mark">${escape(env.APP_NAME)}</div><h1>Scrapling for your agents</h1><p>Use <code>${escape(url.origin)}/mcp</code> in your MCP client. Sign in and approve access to connect.</p>`), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    if (!['/authorize', '/callback'].includes(url.pathname)) return new Response('Not found', { status: 404 });
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.ALLOWED_GITHUB_USERS) return new Response('Sign-in is not configured', { status: 503 });
    if (url.pathname === '/authorize' && req.method === 'GET') {
      const request = await oauth.parseAuthRequest(req);
      if (!request.codeChallenge || request.codeChallengeMethod !== 'S256') return new Response('S256 PKCE is required', { status: 400 });
      const details = await oauth.describeConsent(request), consent = await oauth.beginConsent(request);
      consent.headers.set('Content-Type', 'text/html; charset=utf-8');
      return new Response(consentPage(details, consent.handle, env.APP_NAME), { headers: consent.headers });
    }
    if (url.pathname === '/authorize' && req.method === 'POST') {
      const form = await req.formData(), handle = String(form.get('handle') || '');
      if (form.get('decision') !== 'approve') { const denied = await oauth.denyConsent(req, handle); return new Response(null, { status: 302, headers: denied.headers }); }
      const approved = await oauth.approveConsent(req, handle);
      const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
      const upstream = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
      const github = new URL('https://github.com/login/oauth/authorize');
      github.search = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: `${url.origin}/callback`, scope: 'read:user', state: upstream.state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
      return redirect(upstream.headers, github.href);
    }
    if (url.pathname === '/callback' && req.method === 'GET') {
      const upstream = await oauth.finishUpstream<{ verifier: string }>(req);
      const denied = () => redirect(upstream.headers, authorizationErrorRedirect(upstream.request, 'access_denied'));
      if (url.searchParams.has('error') || !url.searchParams.get('code')) return denied();
      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code: url.searchParams.get('code')!, redirect_uri: `${url.origin}/callback`, code_verifier: upstream.data.verifier }) });
      const token = await tokenResponse.json() as { access_token?: string };
      if (!tokenResponse.ok || !token.access_token) return denied();
      const userResponse = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'scrapling-mcp' } });
      const user = await userResponse.json() as { id: number; login: string };
      if (!userResponse.ok || !isAllowed(user.login, env)) return denied();
      // GitHub is used only for identity. Discard its access token; never pass it to MCP clients.
      const identity: Identity = { login: user.login, userId: String(user.id) };
      const result = await oauth.completeAuthorization({ request: upstream.request, userId: identity.userId, metadata: { label: user.login }, scope: upstream.request.scope, props: identity });
      return redirect(upstream.headers, result.redirectTo);
    }
    return new Response('Method not allowed', { status: 405 });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) return new Response('Authorization expired or invalid. Start the connection again.', { status: 400 });
    console.error('Authorization unavailable');
    return new Response('Authorization temporarily unavailable', { status: 503 });
  }
}
