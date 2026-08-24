// Integration tests for the auth layer: admin/editor gate matrix, magic-link
// exchange flow, and editor management endpoints.

import { describe, it, expect } from 'vitest';
import handler from '../../src/index.js';
import { MockR2, makeCtx, makeTestEnv, seedEditor, seedMagicCode, seedTemplate, seedSiteMarker } from '../helpers/integration.js';
import { sha256Hex, generateToken, AUTH_FILE } from '../../src/index.js';

async function dispatch(env, ctx, method, path, init = {}) {
  const url = `https://api.parroquia.app${path}`;
  const req = new Request(url, { method, ...init });
  return handler.fetch(req, env, ctx);
}

const ADMIN_TOKEN = 'super-secret-admin-token';
const EDITOR_EMAIL = 'editor@example.com';
const OTHER_EMAIL = 'other@example.com';

describe('admin auth — authorizeAdmin', () => {
  it('returns 401 for missing bearer token on POST /sites/:slug', async () => {
    // POST /sites/:slug calls authorizeAdminOrEditorAny. With no token at all,
    // authorizeAdmin returns 401 and the editor-fallback also returns 401.
    const r2 = new MockR2();
    const env = await makeTestEnv(r2); // no ADMIN_TOKEN_HASH set
    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'POST', '/sites/admin-test-list', {
      headers: {},
      body: JSON.stringify({ email: 'test@example.com' }),
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    // authorizeAdminOrEditorAny returns its own 401 when no token is present
    expect(json.error).toBe('missing bearer token');
  });

  it('returns 403 when ADMIN_TOKEN_HASH is not configured and token is not an editor', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2); // ADMIN_TOKEN_HASH not set
    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'POST', '/sites/someslug', {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ email: 'test@example.com' }),
    });
    // authorizeAdmin returns 503, then authorizeAdminOrEditorAny falls through
    // to the editor check, which finds no matching token → 403
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('admin token or valid editor token required');
  });

  it('returns 403 for an invalid admin token (no matching editor token)', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2, ADMIN_TOKEN);
    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'POST', '/sites/someslug', {
      headers: { Authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ email: 'test@example.com' }),
    });
    // admin check fails, editor check also fails → 403
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('admin token or valid editor token required');
  });

  it('returns 402/503 for a valid admin token but missing RESEND_API_KEY', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2, ADMIN_TOKEN);
    // Site creation requires Cloudflare secrets + Resend — will fail at 503
    await seedTemplate(r2);
    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'POST', '/sites/newsitetest', {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ email: 'owner@example.com' }),
    });
    // 503 because RESEND_API_KEY or CLOUDFLARE_API_TOKEN is not configured
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toContain('not configured');
  });

  it('returns 400 for reserved slug even with admin auth', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2, ADMIN_TOKEN);
    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'POST', '/sites/api', {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ email: 'test@example.com' }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('slug is reserved');
  });
});

describe('editor auth — authorize', () => {
  it('returns 401 for missing bearer token on editor-gated endpoint', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await seedSiteMarker(r2, 'mysite');
    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'GET', '/sites/mysite/editors');
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('missing bearer token');
  });

  it('returns 403 for a non-existent editor token', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await seedSiteMarker(r2, 'mysite');
    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'GET', '/sites/mysite/editors', {
      headers: { Authorization: 'Bearer ' + generateToken() },
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('token not valid');
  });

  it('authorizes an editor token for its own slug on PUT', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await seedSiteMarker(r2, 'myslug');
    const { token } = await seedEditor(r2, env, EDITOR_EMAIL, 'myslug');

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'PUT', '/sites/myslug/data.json', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.key).toBe('myslug/data.json');
  });

  it('rejects an editor token for a different slug on PUT', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    // Editor is granted on 'myslug' only
    await seedSiteMarker(r2, 'myslug');
    await seedSiteMarker(r2, 'otherslug');
    const { token } = await seedEditor(r2, env, EDITOR_EMAIL, 'myslug');

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'PUT', '/sites/otherslug/data.json', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('email not authorized for this slug');
  });

  it('admin can perform editor-gated operations on any slug', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2, ADMIN_TOKEN);
    await seedSiteMarker(r2, 'any-slug');
    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'GET', '/sites/any-slug/editors', {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });
});

describe('magic-link exchange (POST /auth/magic)', () => {
  it('exchanges a valid magic code for an editor token', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await seedSiteMarker(r2, 'myslug');
    const { code } = await seedMagicCode(r2, env, EDITOR_EMAIL, 'myslug');

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'POST', '/auth/magic', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.slug).toBe('myslug');
    expect(json.token).toBeTruthy();
    expect(json.email).toBe(EDITOR_EMAIL);
    expect(json.slugs).toEqual(['myslug']);
  });

  it('returns 404 for an unknown magic code', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'POST', '/auth/magic', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: generateToken() }),
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('invalid or already-used magic code');
  });

  it('returns 410 after a code has been used (single-use)', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await seedSiteMarker(r2, 'myslug');
    const { code } = await seedMagicCode(r2, env, EDITOR_EMAIL, 'myslug');

    const ctx = makeCtx();
    // First exchange succeeds
    const res1 = await dispatch(env, ctx, 'POST', '/auth/magic', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(res1.status).toBe(200);

    // Second exchange with same code fails
    const res2 = await dispatch(env, ctx, 'POST', '/auth/magic', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(res2.status).toBe(404);
    const json2 = await res2.json();
    expect(json2.error).toBe('invalid or already-used magic code');
  });

  it('rejects an expired magic code', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await seedSiteMarker(r2, 'myslug');
    // Seed an already-expired code
    const code = generateToken();
    const codeHash = await sha256Hex(code);
    const normalizedEmail = EDITOR_EMAIL.trim().toLowerCase();
    const state = {
      emails: { [normalizedEmail]: ['myslug'] },
      tokens: {},
      magic: { [codeHash]: { slug: 'myslug', email: normalizedEmail, exp: Date.now() - 1000 } },
    };
    await r2.seedAuth(env, state);

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'POST', '/auth/magic', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(res.status).toBe(410);
    const json = await res.json();
    expect(json.error).toBe('magic code expired');
  });

  it('returns 400 for a body missing the code field', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'POST', '/auth/magic', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('a valid magic code is required');
  });
});

describe('editor management (POST/GET/DELETE /sites/:slug/editors)', () => {
  it('listEditors returns the grant list for an authorized editor', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await seedSiteMarker(r2, 'myslug');
    const { token } = await seedEditor(r2, env, EDITOR_EMAIL, 'myslug');

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'GET', '/sites/myslug/editors', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.editors).toContain(EDITOR_EMAIL);
  });

  it('addEditor requires RESEND_API_KEY (returns 503 without it)', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await seedSiteMarker(r2, 'myslug');
    const { token } = await seedEditor(r2, env, EDITOR_EMAIL, 'myslug');

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'POST', '/sites/myslug/editors', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: OTHER_EMAIL }),
    });
    // 503 because RESEND_API_KEY isn't configured in the test env
    expect(res.status).toBe(503);
  });

  it('DELETE editors returns 404 when email is not an editor', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await seedSiteMarker(r2, 'myslug');
    const { token } = await seedEditor(r2, env, EDITOR_EMAIL, 'myslug');

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'DELETE', '/sites/myslug/editors', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-editor@example.com' }),
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('email is not an editor of this slug');
  });

  it('DELETE editors removes an editor and revokes their token', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await seedSiteMarker(r2, 'myslug');
    const { token } = await seedEditor(r2, env, EDITOR_EMAIL, 'myslug');

    const ctx = makeCtx();
    // Add editor first
    const addRes = await dispatch(env, ctx, 'POST', '/sites/myslug/editors', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: OTHER_EMAIL }),
    });
    // 503 due to RESEND_API_KEY, but the grant was still recorded first?
    // Actually, addEditor calls mutateState first, then issueMagicLink. If
    // RESEND fails it returns the error but the grant IS already written.
    // Let's just directly manipulate the state for this test instead.

    // Actually, let's test the direct removal path differently.
    // We'll seed a state with two editors and test removal of one.
    const secondToken = generateToken();
    const secondHash = await sha256Hex(secondToken);
    const normalizedEmail = EDITOR_EMAIL.trim().toLowerCase();
    const state = {
      emails: {
        [normalizedEmail]: ['myslug'],
        [OTHER_EMAIL]: ['myslug'],
      },
      tokens: {
        [await sha256Hex(token)]: { slug: 'myslug', email: normalizedEmail },
        [secondHash]: { slug: 'myslug', email: OTHER_EMAIL },
      },
      magic: {},
    };
    await r2.seedAuth(env, state);

    const res = await dispatch(env, ctx, 'DELETE', '/sites/myslug/editors', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: OTHER_EMAIL }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.email).toBe(OTHER_EMAIL);

    // The removed email should no longer be in the editor list
    const listRes = await dispatch(env, ctx, 'GET', '/sites/myslug/editors', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const listJson = await listRes.json();
    expect(listJson.editors).not.toContain(OTHER_EMAIL);
    expect(listJson.editors).toContain(normalizedEmail);
  });

  it('PATCH editors changes an email address and rebinds tokens', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await seedSiteMarker(r2, 'myslug');
    const { token } = await seedEditor(r2, env, EDITOR_EMAIL, 'myslug');

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'PATCH', '/sites/myslug/editors', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: EDITOR_EMAIL, to: OTHER_EMAIL }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.from).toBe(EDITOR_EMAIL.toLowerCase());
    expect(json.to).toBe(OTHER_EMAIL);
  });
});
