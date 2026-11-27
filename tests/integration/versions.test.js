// Integration tests for config.json version history:
//   every write keeps an immutable copy under <slug>/.versions/<id>.json
//   GET  /sites/:slug/versions      — newest-first history (editor/admin)
//   POST /sites/:slug/rollback/:id  — restore a version as a NEW version

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../../src/index.js';
import { MockR2, makeCtx, makeTestEnv, seedEditor, seedSiteMarker } from '../helpers/integration.js';
import { CACHE_IMMUTABLE } from '../../src/index.js';

async function dispatch(env, ctx, method, path, init = {}) {
  const url = `https://api.parroquia.app${path}`;
  const req = new Request(url, { method, ...init });
  return handler.fetch(req, env, ctx);
}

const T1 = '2026-11-27T10:00:00.000Z';
const T2 = '2026-11-27T10:00:05.000Z';
const T3 = '2026-11-27T10:01:00.000Z';
const ID1 = '2026-11-27T10-00-00-000Z';
const ID2 = '2026-11-27T10-00-05-000Z';
const ID3 = '2026-11-27T10-01-00-000Z';
const DATA_HOST = 'https://data.parroquia.app';

// Fake only Date so every write gets a distinct, predictable version id.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});
const at = (iso) => vi.setSystemTime(new Date(iso));

async function setup() {
  const r2 = new MockR2();
  const env = await makeTestEnv(r2);
  await seedSiteMarker(r2, 'myslug');
  const { token } = await seedEditor(r2, env, 'editor@example.com', 'myslug');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  return { r2, env, ctx: makeCtx(), headers };
}

const putConfig = (s, doc) =>
  dispatch(s.env, s.ctx, 'PUT', '/sites/myslug/config.json', {
    headers: s.headers,
    body: JSON.stringify(doc),
  });

const getVersions = (s, query = '') =>
  dispatch(s.env, s.ctx, 'GET', `/sites/myslug/versions${query}`, { headers: s.headers });

const rollback = (s, id) =>
  dispatch(s.env, s.ctx, 'POST', `/sites/myslug/rollback/${id}`, { headers: s.headers });

describe('config.json writes keep a version', () => {
  it('PUT stores an immutable timestamped copy and the live config.json', async () => {
    const s = await setup();
    at(T1);
    const res = await putConfig(s, { name: 'v1' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.version).toBe(ID1);

    const versionKey = `myslug/.versions/${ID1}.json`;
    const version = await s.r2.get(versionKey);
    expect(version).not.toBeNull();
    expect(version.httpMetadata.cacheControl).toBe(CACHE_IMMUTABLE);
    expect(await s.r2.getRawText(versionKey)).toBe(await s.r2.getRawText('myslug/config.json'));
    expect(JSON.parse(await s.r2.getRawText('myslug/config.json'))).toEqual({ name: 'v1' });
  });

  it('PATCH stores a version of the merged document', async () => {
    const s = await setup();
    at(T1);
    const res = await dispatch(s.env, s.ctx, 'PATCH', '/sites/myslug/config.json', {
      headers: s.headers,
      body: JSON.stringify({ ops: [{ op: 'set', path: ['name'], value: 'b' }] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe(ID1);
    const stored = JSON.parse(await s.r2.getRawText(`myslug/.versions/${ID1}.json`));
    expect(stored).toEqual({ ok: true, name: 'b' });
  });

  it('does not version other files', async () => {
    const s = await setup();
    at(T1);
    await dispatch(s.env, s.ctx, 'PUT', '/sites/myslug/data.json', {
      headers: s.headers,
      body: JSON.stringify({ a: 1 }),
    });
    const json = await (await getVersions(s)).json();
    expect(json.total).toBe(0);
    expect(json.versions).toEqual([]);
  });
});

describe('GET /sites/:slug/versions', () => {
  it('lists versions newest-first with ISO timestamps and public urls', async () => {
    const s = await setup();
    at(T1);
    await putConfig(s, { name: 'v1' });
    at(T2);
    await putConfig(s, { name: 'v2' });
    at(T3);
    await putConfig(s, { name: 'v3' });

    const res = await getVersions(s);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.slug).toBe('myslug');
    expect(json.total).toBe(3);
    expect(json.versions.map((v) => v.id)).toEqual([ID3, ID2, ID1]);
    expect(json.versions[0].timestamp).toBe(T3);
    expect(json.versions[2].timestamp).toBe(T1);
    expect(json.versions[0].url).toBe(`${DATA_HOST}/myslug/.versions/${ID3}.json`);
    expect(json.versions[0].size).toBeGreaterThan(0);
  });

  it('honours ?limit while still reporting the total', async () => {
    const s = await setup();
    for (const t of [T1, T2, T3]) {
      at(t);
      await putConfig(s, { t });
    }
    const json = await (await getVersions(s, '?limit=2')).json();
    expect(json.total).toBe(3);
    expect(json.versions.map((v) => v.id)).toEqual([ID3, ID2]);
  });

  it('keeps each slug history separate and ignores stray objects', async () => {
    const s = await setup();
    at(T1);
    await putConfig(s, { name: 'mine' });
    await s.r2.put('other/.versions/2026-01-01T00-00-00-000Z.json', '{}');
    await s.r2.put('myslug/.versions/notes.txt', 'not a version');

    const json = await (await getVersions(s)).json();
    expect(json.versions.map((v) => v.id)).toEqual([ID1]);
  });

  it('requires auth for this slug', async () => {
    const s = await setup();
    const anon = await dispatch(s.env, s.ctx, 'GET', '/sites/myslug/versions');
    expect(anon.status).toBe(401);
    const wrongSlug = await dispatch(s.env, s.ctx, 'GET', '/sites/other/versions', { headers: s.headers });
    expect(wrongSlug.status).toBe(403);
  });
});

describe('POST /sites/:slug/rollback/:id', () => {
  it('restores an old version as a NEW version and keeps all history', async () => {
    const s = await setup();
    at(T1);
    await putConfig(s, { name: 'v1' });
    at(T2);
    await putConfig(s, { name: 'v2' });

    at(T3);
    const res = await rollback(s, ID1);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.restored).toBe(ID1);
    expect(json.version).toBe(ID3);
    expect(json.data).toEqual({ name: 'v1' });

    expect(JSON.parse(await s.r2.getRawText('myslug/config.json'))).toEqual({ name: 'v1' });
    const list = await (await getVersions(s)).json();
    expect(list.versions.map((v) => v.id)).toEqual([ID3, ID2, ID1]);
    // the pre-rollback state is still there, so the rollback can itself be undone
    expect(JSON.parse(await s.r2.getRawText(`myslug/.versions/${ID2}.json`))).toEqual({ name: 'v2' });
  });

  it('returns 404 for an unknown version and 400 for a malformed id', async () => {
    const s = await setup();
    const missing = await rollback(s, ID1);
    expect(missing.status).toBe(404);
    const bad = await rollback(s, 'not-a-version');
    expect(bad.status).toBe(400);
  });

  it('requires auth', async () => {
    const s = await setup();
    const res = await dispatch(s.env, s.ctx, 'POST', `/sites/myslug/rollback/${ID1}`);
    expect(res.status).toBe(401);
  });
});

describe('version objects stay out of the way', () => {
  it('are not listed by GET /sites/:slug', async () => {
    const s = await setup();
    at(T1);
    await putConfig(s, { name: 'v1' });
    at(T2);
    await putConfig(s, { name: 'v2' });

    const res = await dispatch(s.env, s.ctx, 'GET', '/sites/myslug');
    const json = await res.json();
    expect(json.files).toEqual([`${DATA_HOST}/myslug/config.json`]);
  });

  it('cannot be written through the file routes', async () => {
    const s = await setup();
    const res = await dispatch(s.env, s.ctx, 'PUT', '/sites/myslug/.versions', {
      headers: s.headers,
      body: '{}',
    });
    expect(res.status).toBe(400);
  });
});
