// Integration tests for GET /health and GET /whoami.

import { describe, it, expect } from 'vitest';
import handler from '../../src/index.js';
import { MockR2, makeCtx, makeTestEnv, seedEditor, seedTemplate, seedSiteMarker } from '../helpers/integration.js';

async function dispatch(env, ctx, method, path, init = {}) {
  const url = `https://api.parroquia.app${path}`;
  const req = new Request(url, { method, ...init });
  return handler.fetch(req, env, ctx);
}

describe('GET /health', () => {
  it('returns 200 when R2 binding is present and responds', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'GET', '/health');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.bindings.CONTENT.bound).toBe(true);
    expect(json.bindings.CONTENT.responds).toBe(true);
    expect(json.bindings.CONTENT.objects).toBe(0);
  });

  it('returns 200 and reports existing objects', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await r2.put('test.txt', 'hello');
    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'GET', '/health');
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.bindings.CONTENT.objects).toBe(1);
  });
});

describe('GET /whoami', () => {
  it('returns 401 when no bearer token is provided', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'GET', '/whoami');
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('missing bearer token');
  });

  it('returns 403 for a token not in state', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'GET', '/whoami', {
      headers: { Authorization: 'Bearer nonexistent-token-1234567890abcdef' },
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('invalid token');
  });

  it('returns the email and slug roster for a valid editor token', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await seedTemplate(r2);
    await seedSiteMarker(r2, 'myslug');
    const { token } = await seedEditor(r2, env, 'editor@example.com', 'myslug');

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'GET', '/whoami', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.email).toBe('editor@example.com');
    expect(json.slug).toBe('myslug');
    expect(json.slugs).toEqual(['myslug']);
  });
});
