// Integration tests for HTTP routing, segment parsing, and the path-traversal
// defense at the request layer.
//
// These tests hit the real fetch handler from src/index.js with mock Request
// objects, exercising the full request-decode → dispatch → response cycle.

import { describe, it, expect, beforeEach } from 'vitest';
import handler from '../../src/index.js';
import { MockR2, makeCtx, makeTestEnv } from '../helpers/integration.js';

async function dispatch(env, ctx, method, path, init = {}) {
  const url = `https://api.parroquia.app${path}`;
  const req = new Request(url, { method, ...init });
  return handler.fetch(req, env, ctx);
}

describe('routing — OPTIONS preflight', () => {
  it('returns 204 before any body parsing for OPTIONS', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'OPTIONS', '/sites/myslug/config.json', {
      headers: { Authorization: 'Bearer token' },
      body: JSON.stringify({ ops: [] }),
    });
    expect(res.status).toBe(204);
  });

  it('returns 204 for OPTIONS on any path', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    const ctx = makeCtx();
    for (const path of ['/health', '/sites', '/sites/myslug/editors', '/auth/magic']) {
      const res = await dispatch(env, ctx, 'OPTIONS', path);
      expect(res.status).toBe(204);
    }
  });
});

describe('routing — 404 for unknown routes', () => {
  it('returns 404 for non-/sites root paths', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'GET', '/unknown');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not Found');
  });

  it('returns 404 for deeply nested unknown paths', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'GET', '/sites/foo/deeply/nested');
    expect(res.status).toBe(404);
  });

  it('returns 404 for unsupported methods on valid routes', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    const ctx = makeCtx();
    // PUT on /health — not a defined route for PUT
    const res = await dispatch(env, ctx, 'PUT', '/health');
    expect(res.status).toBe(404);
  });
});

describe('routing — percent-decode-before-validate path traversal defense', () => {
  it('blocks %2e%2e (encoded ..) traversal — URL parser normalizes or handler rejects it', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    const ctx = makeCtx();
    // The WHATWG URL parser may normalize %2e%2e → .. → remove the preceding
    // segment before our handler runs (path normalization). Either way the
    // traversal must NOT reach a site route — it must be blocked (400 or 404).
    const res = await dispatch(env, ctx, 'GET', '/sites/%2e%2e/editors');
    expect([400, 404]).toContain(res.status);
  });

  it('rejects %2f (encoded slash) smuggling an extra segment', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    const ctx = makeCtx();
    // %2f decodes to "/" — the decoded segment contains a separator, rejected at 400
    const res = await dispatch(env, ctx, 'GET', '/sites/myslug%2ffoo');
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Bad path');
  });

  it('rejects %2f in the token position of a PUT', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2, 'admin-token');
    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'PUT', '/sites/myslug/file%2fname.json', {
      headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'text/plain' },
      body: 'hello',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Bad path');
  });

  it('rejects double-encoded %252e%252e (decodes to %2e%2e, not ..)', async () => {
    // %252e%252e → decodeURIComponent → "%2e%2e" (literal string, not "..")
    // "%2e%2e" is not a valid slug (contains dots) so it's rejected
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'GET', '/sites/%252e%252e/editors');
    expect(res.status).toBe(400);
  });
});

describe('routing — valid slug passes decode+validate', () => {
  it('accepts lowercase alnum+hyphen slugs', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    const ctx = makeCtx();
    // A valid slug with a valid file — should not 400 on slug validation
    const res = await dispatch(env, ctx, 'GET', '/sites/myslug');
    // 404 because site doesn't exist, but NOT a 400 (slug was valid)
    expect(res.status).not.toBe(400);
  });
});
