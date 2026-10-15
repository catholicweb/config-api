// Worker entrypoint: adds the MCP endpoint and its OAuth routes in front of the
// existing API (src/index.js), which handles everything else unchanged.
import base from './index.js';
import { handleMcp, corsPreflight } from './mcp.js';
import * as oauth from './mcp-oauth.js';

export default {
  ...base,
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method.toUpperCase();
    const mcpPath = p === '/mcp' || p === '/oauth/authorize' || p === '/oauth/confirm' || p === '/oauth/token' ||
      p === '/oauth/register' || p.startsWith('/.well-known/oauth-');
    if (!mcpPath) return base.fetch(request, env, ctx);

    if (m === 'OPTIONS') return corsPreflight();
    try {
      if (p === '/mcp') return await handleMcp(request, env, ctx, (req) => base.fetch(req, env, ctx));
      if (p.startsWith('/.well-known/oauth-protected-resource') && m === 'GET') return oauth.protectedResourceMetadata(url.origin);
      if (p.startsWith('/.well-known/oauth-authorization-server') && m === 'GET') return oauth.authorizationServerMetadata(url.origin);
      if (p === '/oauth/register' && m === 'POST') return await oauth.register(env, request);
      if (p === '/oauth/authorize') return m === 'GET' ? await oauth.authorizeGet(env, request) : m === 'POST' ? await oauth.authorizePost(env, request) : new Response('Method Not Allowed', { status: 405 });
      if (p === '/oauth/confirm') return m === 'GET' ? await oauth.confirmGet(env, request) : m === 'POST' ? await oauth.confirmPost(env, request) : new Response('Method Not Allowed', { status: 405 });
      if (p === '/oauth/token' && m === 'POST') return await oauth.token(env, request);
      return new Response('Not Found', { status: 404 });
    } catch (e) {
      console.error('[mcp]', e);
      return Response.json({ error: 'internal error' }, { status: 500 });
    }
  },
};
