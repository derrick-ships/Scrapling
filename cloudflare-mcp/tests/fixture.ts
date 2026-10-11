import worker from '../src/index';
import { callBackend } from '../src/backend';
export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === '/test-backend') {
      try { return Response.json(await callBackend(env, 'make_request', {url:'https://example.com',method:'GET'})); }
      catch(e) { return Response.json({error: String(e)}, {status:500}); }
    }
    return worker.fetch(request, env, ctx);
  },
};
