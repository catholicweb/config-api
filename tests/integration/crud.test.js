// Integration tests for CRUD operations: PUT, DELETE, and PATCH config.json.

import { describe, it, expect } from 'vitest';
import handler from '../../src/index.js';
import { MockR2, makeCtx, makeTestEnv, seedEditor, seedSiteMarker } from '../helpers/integration.js';
import { sha256Hex, generateToken, LIVING_FILES, CACHE_IMMUTABLE, CACHE_REVALIDATE } from '../../src/index.js';

async function dispatch(env, ctx, method, path, init = {}) {
  const url = `https://api.parroquia.app${path}`;
  const req = new Request(url, { method, ...init });
  return handler.fetch(req, env, ctx);
}

describe('PUT /sites/:slug/:token — file upload', () => {
  it('uploads a file with valid editor auth and returns the public URL', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await seedSiteMarker(r2, 'myslug');
    const { token: editorToken } = await seedEditor(r2, env, 'editor@example.com', 'myslug');

    const ctx = makeCtx();
    const content = JSON.stringify({ hello: 'world' });
    const res = await dispatch(env, ctx, 'PUT', '/sites/myslug/data.json', {
      headers: {
        Authorization: `Bearer ${editorToken}`,
        'Content-Type': 'application/json',
      },
      body: content,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.slug).toBe('myslug');
    expect(json.key).toBe('myslug/data.json');
    expect(json.url).toBe('https://data.parroquia.app/myslug/data.json');

    // Verify the content was stored
    const stored = await r2.get('myslug/data.json');
    expect(stored).not.toBeNull();
    expect(await stored.text()).toBe(content);
  });

  it('uploads a file with admin auth', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2, 'admin-secret');
    await seedSiteMarker(r2, 'myslug');

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'PUT', '/sites/myslug/photo.jpg', {
      headers: {
        Authorization: 'Bearer admin-secret',
        'Content-Type': 'image/jpeg',
      },
      body: 'fake-jpeg-bytes',
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.key).toBe('myslug/photo.jpg');
  });

  it('rejects upload with no auth', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await seedSiteMarker(r2, 'myslug');

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'PUT', '/sites/myslug/data.json', {
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('rejects upload with invalid editor token', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await seedSiteMarker(r2, 'myslug');

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'PUT', '/sites/myslug/data.json', {
      headers: {
        Authorization: `Bearer ${generateToken()}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('rejects upload with invalid token name (filename validation)', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2, 'admin-secret');
    await seedSiteMarker(r2, 'myslug');

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'PUT', '/sites/myslug/..%2f', {
      headers: { Authorization: 'Bearer admin-secret' },
      body: 'evil',
    });
    expect(res.status).toBe(400);
  });

  it('rejects upload when Content-Length exceeds MAX_FILE_BYTE', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2, 'admin-secret');
    await seedSiteMarker(r2, 'myslug');

    const ctx = makeCtx();
    // 21 MB > 20 MiB (20 * 1024 * 1024 = 20971520)
    // Use a valid token extension (.json is in ALLOWED_EXT) so the 413
    // Content-Length check is reached before validation rejects it.
    // Node.js 20 does not auto-set Content-Length on Request bodies, so we
    // pass it explicitly via a Headers object (the handler checks the header
    // value, not the actual body size).
    const headers = new Headers();
    headers.set('Authorization', 'Bearer admin-secret');
    headers.set('Content-Type', 'text/plain');
    headers.set('Content-Length', String(21 * 1024 * 1024));
    const url = 'https://api.parroquia.app/sites/myslug/large.json';
    const req = new Request(url, { method: 'PUT', headers, body: 'placeholder' });
    const res = await handler.fetch(req, env, ctx);
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.error).toBe('file too large');
  });
});

describe('DELETE /sites/:slug/:token — file deletion', () => {
  it('deletes a file with valid editor auth', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await seedSiteMarker(r2, 'myslug');
    await r2.put('myslug/data.json', '{"existing":true}');
    const { token: editorToken } = await seedEditor(r2, env, 'editor@example.com', 'myslug');

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'DELETE', '/sites/myslug/data.json', {
      headers: { Authorization: `Bearer ${editorToken}` },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.key).toBe('myslug/data.json');

    // Verify the file is gone
    expect(await r2.head('myslug/data.json')).toBeNull();
  });

  it('returns 200 even if the file does not exist (idempotent delete)', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2, 'admin-secret');
    await seedSiteMarker(r2, 'myslug');

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'DELETE', '/sites/myslug/nonexistent.json', {
      headers: { Authorization: 'Bearer admin-secret' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects delete without auth', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await seedSiteMarker(r2, 'myslug');

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'DELETE', '/sites/myslug/data.json');
    expect(res.status).toBe(401);
  });
});

describe('PATCH /sites/:slug/config.json — diff apply', () => {
  it('applies a patch op to the stored config.json', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await seedSiteMarker(r2, 'myslug');
    const { token: editorToken } = await seedEditor(r2, env, 'editor@example.com', 'myslug');

    // Seed an existing config.json
    const initial = { name: 'My Site', count: 0 };
    await r2.put('myslug/config.json', JSON.stringify(initial, null, 2) + '\n', {
      httpMetadata: { contentType: 'application/json', cacheControl: CACHE_REVALIDATE },
    });

    const ctx = makeCtx();
    // patch.js op format: path is an array of string keys, op is 'set'/'remove'/'listAdd'/'listReorder'
    const ops = [{ op: 'set', path: ['count'], value: 42 }];
    const res = await dispatch(env, ctx, 'PATCH', '/sites/myslug/config.json', {
      headers: {
        Authorization: `Bearer ${editorToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ops }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.count).toBe(42);
    expect(json.data.name).toBe('My Site');

    // Verify the stored config was updated
    const stored = await r2.get('myslug/config.json');
    const storedJson = JSON.parse(await stored.text());
    expect(storedJson.count).toBe(42);
    expect(storedJson.name).toBe('My Site');
  });

  it('returns 404 if config.json does not exist', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await seedSiteMarker(r2, 'myslug');
    const { token: editorToken } = await seedEditor(r2, env, 'editor@example.com', 'myslug');

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'PATCH', '/sites/myslug/config.json', {
      headers: { Authorization: `Bearer ${editorToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops: [{ op: 'replace', path: '/name', value: 'test' }] }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid JSON body', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await seedSiteMarker(r2, 'myslug');
    const { token: editorToken } = await seedEditor(r2, env, 'editor@example.com', 'myslug');

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'PATCH', '/sites/myslug/config.json', {
      headers: { Authorization: `Bearer ${editorToken}`, 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing ops array', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await seedSiteMarker(r2, 'myslug');
    const { token: editorToken } = await seedEditor(r2, env, 'editor@example.com', 'myslug');

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'PATCH', '/sites/myslug/config.json', {
      headers: { Authorization: `Bearer ${editorToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ foo: 'bar' }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('ops array required');
  });

  it('rejects PATCH without auth', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await seedSiteMarker(r2, 'myslug');

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'PATCH', '/sites/myslug/config.json', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops: [] }),
    });
    expect(res.status).toBe(401);
  });
});
