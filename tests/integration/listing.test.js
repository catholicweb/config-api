// Integration tests for listing endpoints:
//   GET /sites           — list all slugs (via R2 delimited prefixes)
//   GET /sites/:slug     — list all files under a slug
//   GET /sites/list      — legacy alias for GET /sites
//   GET /sites/:slug/list — legacy alias for GET /sites/:slug

import { describe, it, expect, beforeEach } from 'vitest';
import handler from '../../src/index.js';
import { MockR2, makeCtx, makeTestEnv } from '../helpers/integration.js';

async function dispatch(env, ctx, method, path, init = {}) {
  const url = `https://api.parroquia.app${path}`;
  const req = new Request(url, { method, ...init });
  return handler.fetch(req, env, ctx);
}

const DATA_HOST = 'https://data.parroquia.app';

describe('GET /sites — list all slugs', () => {
  it('returns an empty array when no sites exist', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'GET', '/sites');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.slugs).toEqual([]);
  });

  it('returns all top-level slug prefixes', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    // Create objects under different slugs
    await r2.put('site-a/config.json', '{}');
    await r2.put('site-b/photo.jpg', 'binary');
    await r2.put('site-c/.site', '{}');
    await r2.put('auth.enc', '{}'); // root-level, not a slug

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'GET', '/sites');
    const json = await res.json();
    expect(json.slugs.sort()).toEqual(['site-a', 'site-b', 'site-c']);
  });

  it('does not include auth.enc or slugs.json as a slug', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await r2.put('real-site/config.json', '{}');
    await r2.put('auth.enc', '{}');
    await r2.put('slugs.json', '[]');

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'GET', '/sites');
    const json = await res.json();
    expect(json.slugs).toEqual(['real-site']);
  });

  it('legacy alias GET /sites/list returns the same result', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await r2.put('alpha/config.json', '{}');
    await r2.put('beta/config.json', '{}');

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'GET', '/sites/list');
    const json = await res.json();
    expect(json.slugs.sort()).toEqual(['alpha', 'beta']);
  });
});

describe('GET /sites/:slug — list files under a slug', () => {
  it('returns file URLs for all files in the slug', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await r2.put('myslug/config.json', '{}');
    await r2.put('myslug/photo.jpg', 'binary');

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'GET', '/sites/myslug');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.slug).toBe('myslug');
    expect(json.files).toHaveLength(2);
    expect(json.files).toContain(`${DATA_HOST}/myslug/config.json`);
    expect(json.files).toContain(`${DATA_HOST}/myslug/photo.jpg`);
    // .site is skipped
    expect(json.files).not.toContain(`${DATA_HOST}/myslug/.site`);
  });

  it('returns empty file list for a slug with only the .site marker', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await r2.put('lonely/config.json', '{}');

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'GET', '/sites/lonely');
    const json = await res.json();
    expect(json.files).toEqual([`${DATA_HOST}/lonely/config.json`]);
  });

  it('returns 400 for a slug with uppercase letters', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'GET', '/sites/MySite');
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Invalid slug');
  });

  it('returns 400 for a slug with underscores', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'GET', '/sites/my_site');
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Invalid slug');
  });

  it('legacy alias GET /sites/:slug/list returns the same result', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await r2.put('myslug/config.json', '{}');

    const ctx = makeCtx();
    const res = await dispatch(env, ctx, 'GET', '/sites/myslug/list');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.files).toEqual([`${DATA_HOST}/myslug/config.json`]);
  });
});
