import { OAuthProvider, insufficientScope, OAuthError, type OAuthResourceContext } from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from 'agents/mcp/server';
import { authHandler, isAllowed } from './auth-handler';
import { createServer } from './tools';
import type { Env, Identity } from './types';
export function makeProvider(origin: string) {
  return new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: { async fetch(request, env, context) {
      const ctx = context as OAuthResourceContext<Identity>;
      if (!ctx.auth.scope.includes('scrape:read')) return insufficientScope(ctx.auth, ['scrape:read']);
      if (!isAllowed(ctx.props?.login, env)) return new Response('Access denied', { status: 403 });
      if (new URL(request.url).pathname !== '/mcp') return new Response('Not found', { status: 404 });
      return createMcpHandler(() => createServer(env), { route: '/mcp', legacy: 'stateless', responseMode: 'json', allowedHostnames: [new URL(origin).hostname], allowedOriginHostnames: [new URL(origin).hostname, 'localhost', '127.0.0.1'] })(request, env, ctx);
    } },
    defaultHandler: { fetch: authHandler },
    authorizeEndpoint: '/authorize', tokenEndpoint: '/token', clientRegistrationEndpoint: '/register',
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], resource_name: 'Scrapling MCP' },
    scopesSupported: ['scrape:read', 'offline_access'], requiredScopes: ['scrape:read'],
    clientIdMetadataDocumentEnabled: true, accessTokenTTL: 3600, refreshTokenTTL: 2592000,
    tokenExchangeCallback: ({ props, env }) => {
      if (!isAllowed(props.login, env)) throw new OAuthError('invalid_grant', { description: 'Access was revoked' });
    },
  });
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const origin = env.PUBLIC_ORIGIN || new URL(request.url).origin;
    if (new URL(request.url).origin !== origin) return new Response('Invalid host', { status: 421 });
    if (new URL(request.url).pathname === '/.well-known/oauth-protected-resource') request = new Request(`${origin}/.well-known/oauth-protected-resource/mcp`, request);
    return makeProvider(origin).fetch(request, env, ctx);
  },
};
