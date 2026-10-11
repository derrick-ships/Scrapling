import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Env } from './types';
export async function callBackend(env: Env, tool: string, args: Record<string, unknown>) {
  if (!env.BACKEND_AUTH_TOKEN) throw new Error('Backend authentication is not configured');
  const url = new URL(env.BACKEND_MCP_URL);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Backend must use HTTPS');
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${env.BACKEND_AUTH_TOKEN}` } }, fetch: async (input, init) => {
    const response = await fetch(input, { ...init, redirect: 'manual', signal: init?.signal || AbortSignal.timeout(45000) });
    if (response.status >= 300 && response.status < 400) throw new Error('Backend redirects are not allowed');
    return response;
  } });
  const client = new Client({ name: 'scrapling-cloudflare-gateway', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: 10000 });
    const tools = await client.listTools({}, { timeout: 10000 }), names = new Set(tools.tools.map(t => t.name));
    const name = tool === 'make_request' && !names.has(tool) ? 'get' : tool;
    if (!names.has(name)) throw new Error('Backend tool is unavailable');
    const cleanArgs = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
    if (name === 'get') delete cleanArgs.method;
    const result = await client.callTool({ name, arguments: cleanArgs }, { timeout: 45000 });
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 1024 * 1024) throw new Error('Result too large. Use a narrower CSS selector.');
    return result;
  } finally {
    try { await transport.terminateSession(); } catch { /* Backend may be stateless. */ }
    await client.close();
  }
}
