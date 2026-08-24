// Integration tests for cache headers — verifying that every object written
// to R2 carries the correct Cache-Control policy so data.parroquia.app serves
// them cacheable (the R2 custom domain host does NOT add Cache-Control on its own).

import { describe, it, expect } from 'vitest';
import handler from '../../src/index.js';
import { MockR2, makeCtx, makeTestEnv, seedEditor, seedSiteMarker } from '../helpers/integration.js';
import { LIVING_FILES, CACHE_IMMUTABLE, CACHE_REVALIDATE } from '../../src/index.js';

async function dispatch(env, ctx, method, path, init = {}) {
  const url = `https://api.parroquia.app${path}`;
  const req = new Request(url, { method, ...init });
  return handler.fetch(req, env, ctx);
}

describe('Cache-Control on PUT — immutable for media, revalidate for living files', () => {
  it('sets immutable for non-living files (e.g. data.json)', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2, 'admin-secret');
    await seedSiteMarker(r2, 'myslug');

    const ctx = makeCtx();
    await dispatch(env, ctx, 'PUT', '/sites/myslug/data.json', {
      headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });

    const obj = await r2.head('myslug/data.json');
    expect(obj.httpMetadata.cacheControl).toBe(CACHE_IMMUTABLE);
  });

  it('sets immutable for image files', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2, 'admin-secret');
    await seedSiteMarker(r2, 'myslug');

    const ctx = makeCtx();
    await dispatch(env, ctx, 'PUT', '/sites/myslug/photo.jpg', {
      headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'image/jpeg' },
      body: 'fake-jpeg',
    });

    const obj = await r2.head('myslug/photo.jpg');
    expect(obj.httpMetadata.cacheControl).toBe(CACHE_IMMUTABLE);
  });

  it('sets revalidate for config.json (a living file)', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2, 'admin-secret');
    await seedSiteMarker(r2, 'myslug');

    const ctx = makeCtx();
    await dispatch(env, ctx, 'PUT', '/sites/myslug/config.json', {
      headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Site' }),
    });

    const obj = await r2.head('myslug/config.json');
    expect(obj.httpMetadata.cacheControl).toBe(CACHE_REVALIDATE);
  });

  it('sets revalidate for slugs.json', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2, 'admin-secret');
    // slugs.json is written at the bucket root, not under a slug.
    // We verify the LIVING_FILES set contains it.
    expect(LIVING_FILES.has('slugs.json')).toBe(true);
  });

  it('LIVING_FILES contains config.json and slugs.json', () => {
    expect(LIVING_FILES.has('config.json')).toBe(true);
    expect(LIVING_FILES.has('slugs.json')).toBe(true);
  });

  it('LIVING_FILES does NOT contain common media filenames', () => {
    expect(LIVING_FILES.has('data.json')).toBe(false);
    expect(LIVING_FILES.has('photo.jpg')).toBe(false);
    expect(LIVING_FILES.has('readme.md')).toBe(false);
  });

  it('PATCH config.json also sets revalidate cache control', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await seedSiteMarker(r2, 'myslug');
    const { token: editorToken } = await seedEditor(r2, env, 'editor@example.com', 'myslug');

    // Seed initial config
    await r2.put('myslug/config.json', '{}', {
      httpMetadata: { contentType: 'application/json', cacheControl: CACHE_REVALIDATE },
    });

    const ctx = makeCtx();
    await dispatch(env, ctx, 'PATCH', '/sites/myslug/config.json', {
      headers: { Authorization: `Bearer ${editorToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops: [{ op: 'replace', path: '/name', value: 'test' }] }),
    });

    const obj = await r2.head('myslug/config.json');
    expect(obj.httpMetadata.cacheControl).toBe(CACHE_REVALIDATE);
  });

  it('content-type is set on PUT responses', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2, 'admin-secret');
    await seedSiteMarker(r2, 'myslug');

    const ctx = makeCtx();
    await dispatch(env, ctx, 'PUT', '/sites/myslug/data.json', {
      headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' },
      body: '{}',
    });

    const obj = await r2.head('myslug/data.json');
    expect(obj.httpMetadata.contentType).toBe('application/json');
  });
});

describe('backfill-cache — admin-gated cache re-stamping', () => {
  it('returns 401 without admin auth', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'POST', '/sites/backfill-cache');
    expect(res.status).toBe(401);
  });

  it('returns 403 with invalid admin token', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2, 'real-admin-token');
    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'POST', '/sites/backfill-cache', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(403);
  });

  it('returns 200 with ok:true when re-stamping is complete', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2, 'real-admin-token');

    // Seed some objects with WRONG cache headers (simulating pre-caching objects)
    await r2.put('myslug/config.json', '{}', {
      httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=999999' },
    });
    await r2.put('myslug/photo.jpg', 'binary', {
      httpMetadata: { contentType: 'image/jpeg', cacheControl: 'public, max-age=999999' },
    });

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'POST', '/sites/backfill-cache', {
      headers: { Authorization: 'Bearer real-admin-token' },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.updated).toBe(2); // both objects re-stamped
    expect(json.skipped).toBe(0);

    // Verify the re-stamped headers
    const configObj = await r2.head('myslug/config.json');
    expect(configObj.httpMetadata.cacheControl).toBe(CACHE_REVALIDATE);

    const photoObj = await r2.head('myslug/photo.jpg');
    expect(photoObj.httpMetadata.cacheControl).toBe(CACHE_IMMUTABLE);
  });

  it('skips auth.enc during backfill', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2, 'real-admin-token');

    // Auth.enc should be skipped (it's private, never served by data host)
    await r2.put('auth.enc', '{"encrypted":"blob"}', {
      httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
    });
    await r2.put('myslug/data.json', '{}', {
      httpMetadata: { contentType: 'application/json' },
    });

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'POST', '/sites/backfill-cache', {
      headers: { Authorization: 'Bearer real-admin-token' },
    });
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.updated).toBe(1); // only data.json, auth.enc skipped
    expect(json.skipped).toBe(1); // auth.enc

    // auth.enc should be untouched
    const authObj = await r2.head('auth.enc');
    expect(authObj.httpMetadata.cacheControl).toBe('no-store');
  });
});
