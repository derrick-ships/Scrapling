# Scrapling MCP on Cloudflare Workers

A remote OAuth MCP gateway for the existing Scrapling service on Contabo. Cloudflare authenticates clients and forwards MCP tool calls. Scrapling, Chromium, content extraction and scraping stay on the VPS.

**Status, 2026-10-11:** project built from Cloudflare's official GitHub OAuth template. Deployment, credential setup and publishing to `main` are authorized. Production deployment and the Scrapling update remain blocked by this session's network and browser credential restrictions. No production MCP URL has been deployed. Existing Scrapling was verified at version 0.4.9; the 0.4.15 image/digest is verified and its compatible Compose update is supplied. The gateway is stored under `cloudflare-mcp/` in `derrick-ships/Scrapling`.

## Project structure

```text
my-mcp/
  wrangler.toml             # Worker, KV, issuer and backend settings
  package.json              # npm scripts and dependencies
  package-lock.json         # reproducible versions
  tsconfig.json
  .gitignore
  .dev.vars.example         # examples only, no real secrets
  README.md
  src/
    index.ts                # OAuth provider v1 + Agents stateless MCP handler
    auth-handler.ts         # browser-bound consent and GitHub identity flow
    consent.ts              # dark Allow/Deny page
    types.ts                # Worker bindings and identity
    backend.ts              # authenticated MCP client to existing backend
    tools.ts                # bounded public gateway tools
  deploy/
    scrapling.compose.yaml  # pinned backend update, existing profiles mount
  tests/
    gateway.test.mjs        # local workerd OAuth/MCP integration tests
    fixture.ts              # test-only backend diagnostic route, never deployed
```

## Architecture and authentication

Client -> `/mcp` -> 401 challenge -> Protected Resource Metadata -> Authorization Server Metadata -> CIMD or `/register` -> `/authorize` -> Allow/Deny -> GitHub identity -> owner allowlist -> authorization code -> S256 PKCE `/token` exchange -> authenticated tools.

The token audience is exactly `PUBLIC_ORIGIN/mcp`. The library publishes both authorization-server metadata and path-bound protected-resource metadata; `index.ts` also provides the root `/.well-known/oauth-protected-resource` alias. DCR supports older clients. CIMD is enabled with `global_fetch_strictly_public`. PKCE uses S256. Implicit flow and plain PKCE are not enabled. Consent shows client identity, return hostname, requested scopes and a local-app warning; the official helpers bind single-use consent/state to the browser and prevent framing.

`ALLOWED_GITHUB_USERS` defaults to `derrick-ships`, verified as the authenticated GitHub connector account on 2026-10-11. Other GitHub users cannot authorize. The GitHub token is used for identity only and discarded. MCP clients never receive the VPS bearer token. Removing a user from the allowlist denies subsequent tool requests and refreshes.

## 1. Update the existing Scrapling service in Coolify

1. Open `self-hosted-stack` / `production` and the service containing `Scrapling`. Confirm Contabo is Ready and inspect the current image, logs and `/profiles` persistent mount. Preserve a backup of profiles and the running image digest for rollback.
2. Create a strong random bearer token in your password manager. Enter it into Coolify's secret environment field as `SCRAPLING_MCP_AUTH_TOKEN`. Keep this value out of Compose text, Git, logs and chat. Set the identical value later as the Worker secret `BACKEND_AUTH_TOKEN`.
3. Replace that service's Compose with `deploy/scrapling.compose.yaml`. It pins official `0.4.15` to the verified digest and preserves the existing host profile directory, port and domain. Save and redeploy only this service.
4. Verify startup and installed version in the selected container (`python -c "import importlib.metadata; print(importlib.metadata.version('scrapling'))"`). A request without a token to the backend `/mcp` must return 401. An authenticated initialize/tools-list and `make_request` call must work.
5. If update fails, restore the previous saved Compose/image digest, retain the profiles mount and inspect runtime logs. Do not clear storage. Update existing direct clients to use the bearer token; 0.4.15 renames `get` to `make_request` and changes session tools.

Authentication is required by Scrapling 0.4.15 HTTP mode. Do not just pull `latest` using the old unauthenticated command; it would fail startup. Do not use `--no-auth` on this publicly routed service.

## 2. Deploy to Cloudflare

Use an existing Cloudflare account on Workers Free and Node 24 or newer. Do not upgrade billing.

```sh
npm ci
npm run type-check
npm test
npx wrangler login --scopes account:read user:read workers:write workers_kv:write workers_scripts:write offline_access
npx wrangler kv namespace create OAUTH_KV
```

Creating Wrangler credentials grants persistent Worker/KV write access; complete the Cloudflare authorization yourself or expressly approve that access. Replace `wrangler.toml`'s KV ID with the returned namespace ID. Set `PUBLIC_ORIGIN` to the exact expected URL `https://scrapling-mcp.<your-workers-subdomain>.workers.dev`, with no trailing slash. Keep the backend URL pointed at the existing VPS service. Set your intended GitHub username in `ALLOWED_GITHUB_USERS`.

Register a GitHub OAuth App under Developer settings / OAuth Apps. Use the Worker origin as Homepage URL and `https://scrapling-mcp.<your-workers-subdomain>.workers.dev/callback` as Authorization callback URL. Request only `read:user`. A separate local OAuth App is needed only for local browser sign-in, with callback `http://localhost:8788/callback`.

Set secrets using interactive prompts, never shell arguments:

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put BACKEND_AUTH_TOKEN
npm run deploy
```

Wrangler can prompt to create the Worker while setting its initial secrets. If necessary, run the first deploy before setting secrets, then set them and deploy again. Missing sign-in/backend secrets fail closed; the tools do not silently call an unprotected backend.

Your MCP URL is `https://scrapling-mcp.<your-workers-subdomain>.workers.dev/mcp`. Copy the deployed URL from Wrangler and ensure it matches `PUBLIC_ORIGIN`. No custom domain or DNS change is required.

For local development, copy `.dev.vars.example` to `.dev.vars`, replace placeholders privately and run `npm run dev`. `PUBLIC_ORIGIN=http://localhost:8788` must match the local port. Production GitHub credentials do not use the local callback.

## 3. Connect Claude, Cursor and Codex

### Claude Code

```sh
claude mcp add --transport http scrapling https://scrapling-mcp.<your-workers-subdomain>.workers.dev/mcp
```

Open `/mcp` in Claude Code, select the server and authenticate. Check the requesting client and return hostname, click Allow, sign in with your allowlisted GitHub account, then return to Claude. Deny returns `access_denied` and grants no access.

### Claude web/desktop

Open Settings / Connectors and add a custom remote connector, when supported by your account. Use the same `/mcp` URL, then connect and complete the consent/sign-in flow. Client UI and account availability vary; use Claude Code if your interface has no custom connector option. Do not paste the backend token into client settings.

### Cursor

Add this to `.cursor/mcp.json` for a project or `~/.cursor/mcp.json` globally:

```json
{
  "mcpServers": {
    "scrapling": {
      "url": "https://scrapling-mcp.<your-workers-subdomain>.workers.dev/mcp"
    }
  }
}
```

In Customize / MCP, connect/authenticate, complete Allow and GitHub sign-in, and enable the four tools. CIMD/DCR discovers client registration; no static OAuth credentials belong in the client config.

### Codex

Add a remote HTTP MCP server using the same URL through your installed Codex client's MCP settings. Complete its OAuth login. This server supports current MCP 2026-07-28 plus stateless legacy tool clients. Client-specific setup depends on your installed Codex version.

## 4. How tools call the existing app

| Public tool | Scrapling backend tool | Work performed on Contabo |
|---|---|---|
| `scrape_http` | `make_request`, GET only | fingerprinted HTTP + extraction |
| `scrape_dynamic` | `fetch` | Chromium rendering + extraction |
| `scrape_stealth` | `stealthy_fetch` | stealth browser + extraction |
| `scrape_bulk_http` | `bulk_get` | up to five page fetches |

Each Worker call opens an authenticated Streamable HTTP backend client, lists available tools, forwards validated arguments and returns the backend result. It closes its MCP connection afterward. During the upgrade `backend.ts` can map `make_request` to the previous `get` tool. Browser work never runs on Cloudflare.

All tools accept `extraction_type` (`markdown`, `text`, `html`), optional `css_selector` and `main_content_only`. Browser tools accept bounded readiness controls. HTTP timeout is seconds; browser timeout is milliseconds. Bulk input is limited to five URLs, tool timeout to 45 seconds and returned data to 1 MiB. Use narrow selectors for larger pages. Tool failures give a bounded error without exposing backend credentials or raw exception details.

This gateway exposes one-shot extraction tools. Persistent session, screenshot, proxy/CDP configuration and arbitrary write methods remain backend capabilities and are not published by default. HTTP(S) input validation is not an egress firewall; enforce public-network-only egress on the VPS if untrusted users are added. The initial allowlist is for the owner only. Page contents remain untrusted even if Scrapling sanitizes hidden content.

## 5. Add more tools

In `src/tools.ts`, add `server.registerTool()` with a concrete Zod input schema, a clear description, bounded time/size limits and accurate annotations. Call `callBackend(env, '<native-tool-name>', args)`. Confirm the native schema with authenticated backend `tools/list`; do not guess its API. Add a forwarding assertion to the integration test, run checks and redeploy.

For persistent sessions, first bind session IDs to the signed-in user and implement cleanup; never publish a shared `list_sessions` across users. For write operations, add a separate OAuth scope and enforce it in the tool handler. Keep all real app logic on Contabo.

## Free-tier limits

Only one Worker and one OAuth KV namespace are used. No Workers AI, Durable Objects or paid bindings are required. The current Workers Free limits include 100,000 requests/day and 10 ms CPU/invocation. Waiting for Contabo is I/O, but JSON/schema processing and crypto use CPU. KV Free includes 100,000 reads/day and 1,000 each writes/deletes/list operations/day. OAuth authorization and client registration use multiple writes, so these are not counts of logins. Exceeding Free quotas fails requests; this project does not turn on a paid plan.

The bundle fits the Free Worker size limit. Production CPU usage and traffic quotas still need verification after deployment. Restrict the owner allowlist, keep responses small, and do not advertise unlimited scraping. DCR is public as required for client discovery and can consume the KV write allowance; use Cloudflare's available rate controls if traffic becomes abusive. No automatic paid upgrade is configured.

## Verification and dependencies

**Verified locally:** TypeScript checks pass; all five integration tests pass, including real SDK negotiation of `2026-07-28`, modern tool calls, legacy tools, OAuth refresh and mock backend forwarding. `npm install` audit reports zero vulnerabilities. This is not proof of live GitHub sign-in or production VPS update.

`npm test` uses local workerd with mocked GitHub and mocked Scrapling. It checks metadata/challenge, CIMD, DCR, escaped Allow/Deny consent, browser binding, PKCE failure, code replay, allowlist rejection, refresh and backend forwarding. Live deployment checks must separately cover real GitHub sign-in, both outcomes on consent and at least one Contabo scrape.

Agents 0.28.0 requires MCP server 2.0.0. Its original client pins had an OAuth advisory; npm overrides use patched client 2.3.1 and legacy SDK 1.31+, with compatibility verified by tests. `package-lock.json` fixes the dependency graph. The original official template was generated using:

```sh
npm create cloudflare@latest -- my-mcp --template=cloudflare/ai/demos/remote-mcp-github-oauth --no-deploy --no-git
```

The template's initial dependency install conflicted with current Workers types; this project upgrades to OAuth provider v1/current Workers types and replaces deprecated `McpAgent` with `agents/mcp/server`.

### Official references

- Template: https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/
- OAuth provider v1: https://github.com/cloudflare/workers-oauth-provider
- Handler API: https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
- MCP 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28
- Scrapling current MCP guide: https://scrapling.readthedocs.io/en/latest/ai/mcp-server.html
- Coolify operations: https://coolify.io/docs/applications/operations/overview
- Worker limits: https://developers.cloudflare.com/workers/platform/limits/
- KV limits: https://developers.cloudflare.com/kv/platform/limits/
- Claude Code: https://code.claude.com/docs/en/mcp
- Cursor: https://cursor.com/docs/mcp
