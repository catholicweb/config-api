// Worker entrypoint: adds the MCP endpoint and its OAuth routes, and the event
// registration routes, in front of the existing API (src/index.js), which
// handles everything else unchanged.
import base, { validateSlug, authorizeAdminOrEditor } from './index.js';
import { handleMcp, corsPreflight } from './mcp.js';
import * as oauth from './mcp-oauth.js';
import { handleRegister, listRegistrations, purgeRegistrations } from './registration.js';

// Decode each path segment like index.js does (a decoded segment may not contain '/').
function decodeSegments(pathname) {
  const out = [];
  for (const seg of pathname.split('/').filter(Boolean)) {
    const d = decodeURIComponent(seg);
    if (d.includes('/')) throw new Error('bad path');
    out.push(d);
  }
  return out;
}

export default {
  ...base,
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method.toUpperCase();

    // Event registrations (src/registration.js). OPTIONS falls through to base.
    if (m !== 'OPTIONS') {
      const isRegister = p === '/api/register' || p.startsWith('/api/register/');
      const isRegList = m === 'GET' && /^\/sites\/[^/]+\/registrations\/?$/.test(p);
      if (isRegister || isRegList) {
        try {
          const segments = decodeSegments(p);
          if (isRegister) {
            const res = await handleRegister(env, request, segments, url);
            if (res) return res;
          } else {
            const slug = segments[1];
            if (!validateSlug(slug)) return new Response('Invalid slug', { status: 400 });
            const auth = await authorizeAdminOrEditor(env, slug, request);
            if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
            return await listRegistrations(env, slug, url);
          }
        } catch (e) {
          console.error('[registration]', e);
          return Response.json({ error: 'internal error' }, { status: 500 });
        }
      }
    }

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

  // Daily cron: the existing jobs (notifications, YouTube renewal), then the
  // registrations retention purge. Independent, so one failing never skips another.
  async scheduled(controller, env, ctx) {
    await base.scheduled(controller, env, ctx);
    try {
      const r = await purgeRegistrations(env);
      console.log('scheduled: registrations purged:', r.deleted);
    } catch (err) {
      console.error('scheduled: purgeRegistrations failed:', err);
    }
  },
};
