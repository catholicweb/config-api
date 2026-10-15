import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker from '../../src/worker.js';
import { MockR2, makeCtx, makeTestEnv, seedEditor } from '../helpers/integration.js';
import { resetSchemaCache } from '../../src/mcp.js';
import { validate, newErrors, fillIds } from '../../src/mcp-schema.js';

const ORIGIN = 'https://api.parroquia.app';
const SCHEMA = {
  'x-schema-version': 'test1',
  type: 'object',
  properties: {
    theme: { type: 'object', title: 'Theme', properties: { accentHue: { oneOf: [{ type: 'number', minimum: 0, maximum: 360 }, { const: '' }] }, navStyle: { type: 'string', enum: ['', 'sticky', 'static'] } }, additionalProperties: true },
    pages: { type: 'object', title: 'Pages', properties: { list: { type: 'array', items: {
      type: 'object', required: ['id'], additionalProperties: false,
      properties: { id: { type: 'string', minLength: 1 }, title: { type: 'string' }, sections: { type: 'array', items: {
        type: 'object', required: ['type'], properties: { type: { enum: ['text', 'gallery'] } },
        allOf: [
          { if: { properties: { type: { const: 'text' } }, required: ['type'] }, then: { type: 'object', required: ['type', 'id'], additionalProperties: false, properties: { type: { type: 'string' }, id: { type: 'string' }, html: { type: 'string' } } } },
          { if: { properties: { type: { const: 'gallery' } }, required: ['type'] }, then: { type: 'object', required: ['type', 'id'], additionalProperties: false, properties: { type: { type: 'string' }, id: { type: 'string' }, images: { type: 'array', items: { type: 'string' } } } } },
        ] } } },
    } } }, additionalProperties: true },
  },
  additionalProperties: true,
};

const rpc = (token, method, params, id = 1) =>
  worker.fetch(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }), env, ctx);
const call = async (token, name, args) => (await (await rpc(token, 'tools/call', { name, arguments: args })).json()).result;
const txt = (r) => r.content[0].text;

let r2, env, ctx, emails;
beforeEach(async () => {
  resetSchemaCache();
  r2 = new MockR2(); env = await makeTestEnv(r2); ctx = makeCtx(); emails = [];
  env.RESEND_API_KEY = 'k';
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (String(url).includes('config.schema.json')) return Response.json(SCHEMA);
    if (String(url).includes('resend.com')) { emails.push(JSON.parse(init.body)); return new Response('{}'); }
    return new Response('nope', { status: 404 });
  }));
});

async function seedSite(slug = 'abc', config = { theme: { accentHue: 10, navStyle: '' }, pages: { list: [{ id: 'p1', title: 'Home', sections: [] }] } }) {
  await r2.put(`${slug}/config.json`, JSON.stringify(config));
}
async function login(email = 'ed@example.com', slug = 'abc') {
  await seedSite(slug);
  await seedEditor(r2, env, email, slug);
  const reg = await (await worker.fetch(new Request(`${ORIGIN}/oauth/register`, { method: 'POST', body: JSON.stringify({ client_name: 'TestAI', redirect_uris: ['https://client.example/cb'] }) }), env, ctx)).json();
  const verifier = 'v'.repeat(50);
  const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://client.example/cb', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' });
  const form = await (await worker.fetch(new Request(`${ORIGIN}/oauth/authorize?${q}`), env, ctx)).text();
  const req = /name="req" value="([^"]+)"/.exec(form)[1].replace(/&amp;/g, '&');
  await worker.fetch(new Request(`${ORIGIN}/oauth/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, req }) }), env, ctx);
  const link = /https:\/\/api\.parroquia\.app\/oauth\/confirm\?[^\s"<]+/.exec(emails.at(-1).text)[0];
  const consent = await worker.fetch(new Request(link), env, ctx);
  expect(consent.status).toBe(200);
  const code = new URL(link).searchParams.get('code');
  const done = await worker.fetch(new Request(`${ORIGIN}/oauth/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, req, decision: 'allow' }) }), env, ctx);
  expect(done.status).toBe(302);
  const loc = new URL(done.headers.get('Location'));
  expect(loc.searchParams.get('state')).toBe('xyz');
  const tok = async (verif) => worker.fetch(new Request(`${ORIGIN}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: loc.searchParams.get('code'), code_verifier: verif, client_id: reg.client_id, redirect_uri: 'https://client.example/cb' }) }), env, ctx);
  return { tok, verifier, link };
}

describe('MCP OAuth + magic link', () => {
  it('serves discovery metadata and 401 with resource_metadata', async () => {
    const m = await (await worker.fetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), env, ctx)).json();
    expect(m.code_challenge_methods_supported).toEqual(['S256']);
    const r = await worker.fetch(new Request(`${ORIGIN}/mcp`, { method: 'POST', body: '{}' }), env, ctx);
    expect(r.status).toBe(401);
    expect(r.headers.get('WWW-Authenticate')).toContain('oauth-protected-resource');
  });

  it('completes the full flow and mints a working token; wrong PKCE verifier and code reuse fail', async () => {
    const { tok, verifier } = await login();
    const bad = await tok('w'.repeat(50));
    expect(bad.status).toBe(400); // wrong verifier (and burns the code)
    expect((await tok(verifier)).status).toBe(400); // already used

    const f = await login('ed2@example.com', 'def');
    const ok = await (await f.tok(f.verifier)).json();
    expect(ok.token_type).toBe('Bearer');
    const init = await (await rpc(ok.access_token, 'initialize', { protocolVersion: '2025-06-18' })).json();
    expect(init.result.serverInfo.name).toBe('parroquia-config');
  });

  it('does not email or reveal anything for an address without access', async () => {
    const reg = await (await worker.fetch(new Request(`${ORIGIN}/oauth/register`, { method: 'POST', body: JSON.stringify({ redirect_uris: ['https://c.example/cb'] }) }), env, ctx)).json();
    const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://c.example/cb', code_challenge: 'abc', code_challenge_method: 'S256' });
    const form = await (await worker.fetch(new Request(`${ORIGIN}/oauth/authorize?${q}`), env, ctx)).text();
    const req = /name="req" value="([^"]+)"/.exec(form)[1].replace(/&amp;/g, '&');
    const r = await worker.fetch(new Request(`${ORIGIN}/oauth/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'nobody@example.com', req }) }), env, ctx);
    expect(r.status).toBe(200);
    expect(emails.length).toBe(0);
  });

  it('rejects unregistered redirect URIs and missing PKCE', async () => {
    const reg = await (await worker.fetch(new Request(`${ORIGIN}/oauth/register`, { method: 'POST', body: JSON.stringify({ redirect_uris: ['https://c.example/cb'] }) }), env, ctx)).json();
    const r = await worker.fetch(new Request(`${ORIGIN}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(reg.client_id)}&redirect_uri=https://evil.example/cb`), env, ctx);
    expect(r.status).toBe(400);
    const bad = await worker.fetch(new Request(`${ORIGIN}/oauth/register`, { method: 'POST', body: JSON.stringify({ redirect_uris: ['javascript:alert(1)'] }) }), env, ctx);
    expect(bad.status).toBe(400);
  });
});

describe('MCP tools', () => {
  let token;
  beforeEach(async () => { const f = await login(); token = (await (await f.tok(f.verifier)).json()).access_token; });

  it('lists tools and sites', async () => {
    const tools = (await (await rpc(token, 'tools/list')).json()).result.tools.map((t) => t.name);
    expect(tools).toEqual(['list_sites', 'get_schema', 'get_config', 'validate_config', 'patch_config']);
    expect(JSON.parse(txt(await call(token, 'list_sites', {}))).sites[0].slug).toBe('abc');
  });

  it('get_schema overview and drill-down into a block variant', async () => {
    const o = JSON.parse(txt(await call(token, 'get_schema', {})));
    expect(o.sections.map((s) => s.name)).toEqual(['theme', 'pages']);
    const v = JSON.parse(txt(await call(token, 'get_schema', { section: 'pages', path: 'list.sections.gallery' })));
    expect(v.schema.properties.images).toBeTruthy();
  });

  it('get_config reads a path and refuses sites you cannot edit', async () => {
    expect(JSON.parse(txt(await call(token, 'get_config', { slug: 'abc', path: 'pages.list.p1.title' })))).toBe('Home');
    const r = await call(token, 'get_config', { slug: 'other' });
    expect(r.isError).toBe(true);
  });

  it('patch_config adds a block (server fills ids), saves, and rebuilds', async () => {
    const r = await call(token, 'patch_config', { slug: 'abc', ops: [{ op: 'listAdd', path: ['pages', 'list', { id: 'p1' }, 'sections'], value: { type: 'text', html: '**hola**' } }] });
    expect(r.isError).toBeUndefined();
    const saved = JSON.parse(await (await r2.get('abc/config.json')).text());
    expect(saved.pages.list[0].sections[0]).toMatchObject({ type: 'text', html: '**hola**' });
    expect(saved.pages.list[0].sections[0].id).toBeTruthy();
  });

  it('rejects invalid edits without saving', async () => {
    const before = await (await r2.get('abc/config.json')).text();
    for (const ops of [
      [{ op: 'set', path: ['theme', 'accentHue'], value: 999 }],
      [{ op: 'set', path: ['theme', 'navStyle'], value: 'floating' }],
      [{ op: 'listAdd', path: ['pages', 'list', { id: 'p1' }, 'sections'], value: { type: 'text', bogus: 1 } }],
      [{ op: 'set', path: ['dev', 'x'], value: 1 }],
      [{ op: 'set', path: ['pages', 'nope'], value: 1 }],
      [{ op: 'remove', path: ['pages', 'list', { id: 'missing' }] }],
    ]) {
      const r = await call(token, 'patch_config', { slug: 'abc', ops });
      expect(r.isError, JSON.stringify(ops)).toBe(true);
    }
    expect(await (await r2.get('abc/config.json')).text()).toBe(before);
  });

  it('validate_config is a dry run', async () => {
    const before = await (await r2.get('abc/config.json')).text();
    const r = await call(token, 'validate_config', { slug: 'abc', ops: [{ op: 'set', path: ['theme', 'accentHue'], value: 200 }] });
    expect(JSON.parse(txt(r)).valid).toBe(true);
    expect(await (await r2.get('abc/config.json')).text()).toBe(before);
  });

  it('only blocks NEW errors: legacy invalid data does not block unrelated edits', async () => {
    await r2.put('abc/config.json', JSON.stringify({ theme: { accentHue: 999, navStyle: '' }, pages: { list: [] } }));
    const r = await call(token, 'patch_config', { slug: 'abc', ops: [{ op: 'set', path: ['theme', 'navStyle'], value: 'sticky' }] });
    expect(r.isError).toBeUndefined();
  });

  it('write access follows the grant: a revoked email loses MCP access immediately', async () => {
    await r2.seedAuth(env, { emails: {}, tokens: {}, magic: {} });
    const r = await rpc(token, 'tools/list');
    expect(r.status).toBe(401);
  });
});

describe('validator', () => {
  it('reports paths with item ids and diffs errors', () => {
    const e = validate(SCHEMA, { pages: { list: [{ id: 'p1', title: 5 }] } });
    expect(e[0].path).toBe('pages.list[id=p1].title');
    expect(newErrors(e, e)).toEqual([]);
  });
  it('fillIds only fills where the schema requires ids', () => {
    const v = [{ type: 'text' }];
    fillIds(v, SCHEMA.properties.pages.properties.list.items.properties.sections, () => 'gen');
    expect(v[0].id).toBe('gen');
  });
});
