import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
export interface Env {
  OAUTH_KV: KVNamespace; OAUTH_PROVIDER: OAuthHelpers;
  PUBLIC_ORIGIN: string; BACKEND_MCP_URL: string; BACKEND_AUTH_TOKEN: string;
  GITHUB_CLIENT_ID: string; GITHUB_CLIENT_SECRET: string;
  ALLOWED_GITHUB_USERS: string; APP_NAME: string;
}
export interface Identity { login: string; userId: string }
