import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker from '../../src/worker.js';
import { MockR2, makeCtx, makeTestEnv, seedEditor } from '../helpers/integration.js';

const ORIGIN = 'https://api.parroquia.app';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let r2, env, ctx, token, mails;
const call = async (name, args) => {
  const res = await worker.fetch(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), env, ctx);
  return (await res.json()).result;
};
const txt = (r) => r.content[0].text;
const body = async (key) => { const o = await r2.get(key); return o && (await o.text()); };

beforeEach(async () => {
  r2 = new MockR2(); env = await makeTestEnv(r2); ctx = makeCtx(); mails = [];
  env.RESEND_API_KEY = 'k';
  await r2.put('abc/config.json', JSON.stringify({ theme: {} }));
  await r2.put('abc/media-old.png', 'x');
  ({ token } = await seedEditor(r2, env, 'ed@example.com', 'abc'));
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const u = String(url);
    if (u.includes('resend.com')) { mails.push(JSON.parse(init.body)); return new Response('{}'); }
    if (u === 'https://img.example/pic.png') return new Response(Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)), { headers: { 'Content-Type': 'image/png' } });
    return new Response('nope', { status: 404 });
  }));
});

describe('files', () => {
  it('list_files lists names and urls, with filter', async () => {
    const all = JSON.parse(txt(await call('list_files', { slug: 'abc' })));
    expect(all.files.map((f) => f.name).sort()).toEqual(['config.json', 'media-old.png']);
    const some = JSON.parse(txt(await call('list_files', { slug: 'abc', filter: 'media' })));
    expect(some.total).toBe(1);
  });

  it('write_file creates text files, refuses silent overwrite, allows explicit overwrite', async () => {
    const r = await call('write_file', { slug: 'abc', name: 'notes.md', content: '# Hola' });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(txt(r)).url).toContain('/abc/notes.md');
    expect(await body('abc/notes.md')).toBe('# Hola');
    expect((await call('write_file', { slug: 'abc', name: 'notes.md', content: 'x' })).isError).toBe(true);
    expect((await call('write_file', { slug: 'abc', name: 'notes.md', content: 'v2', overwrite: true })).isError).toBeUndefined();
    expect(await body('abc/notes.md')).toBe('v2');
  });

  it('write_file blocks config.json, bad names, bad json, and ambiguous sources', async () => {
    for (const a of [
      { name: 'config.json', content: '{}' },
      { name: '../evil.md', content: 'x' },
      { name: 'run.exe', content: 'x' },
      { name: 'data.json', content: '{nope' },
      { name: 'a.md' },
      { name: 'a.md', content: 'x', content_base64: 'eA==' },
      { name: 'a.png', source_url: 'http://img.example/pic.png' },
    ]) {
      expect((await call('write_file', { slug: 'abc', ...a })).isError, JSON.stringify(a)).toBe(true);
    }
    expect(await body('abc/config.json')).toBe(JSON.stringify({ theme: {} }));
  });

  it('uploads from base64 and from an https URL; read_file returns the image', async () => {
    expect((await call('write_file', { slug: 'abc', name: 'media-b64.png', content_base64: PNG })).isError).toBeUndefined();
    expect((await call('write_file', { slug: 'abc', name: 'media-url.png', source_url: 'https://img.example/pic.png' })).isError).toBeUndefined();
    for (const n of ['media-b64.png', 'media-url.png']) {
      const r = await call('read_file', { slug: 'abc', name: n });
      expect(r.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png', data: PNG });
    }
    expect((await call('read_file', { slug: 'abc', name: 'nope.png' })).isError).toBe(true);
  });

  it('delete_file removes a file but never config.json', async () => {
    expect((await call('delete_file', { slug: 'abc', name: 'config.json' })).isError).toBe(true);
    expect((await call('delete_file', { slug: 'abc', name: 'media-old.png' })).isError).toBeUndefined();
    expect(await r2.get('abc/media-old.png')).toBeNull();
  });

  it('refuses sites the user cannot edit', async () => {
    await r2.put('other/config.json', '{}');
    for (const [n, a] of [['list_files', {}], ['write_file', { name: 'a.md', content: 'x' }], ['delete_file', { name: 'a.md' }], ['list_editors', {}]]) {
      expect((await call(n, { slug: 'other', ...a })).isError, n).toBe(true);
    }
  });
});

describe('editors', () => {
  it('lists, adds (with invite email), renames and removes editors', async () => {
    expect(JSON.parse(txt(await call('list_editors', { slug: 'abc' }))).editors).toEqual(['ed@example.com']);
    expect((await call('add_editor', { slug: 'abc', email: 'new@example.com' })).isError).toBeUndefined();
    expect(mails.length).toBe(1);
    expect(JSON.parse(txt(await call('list_editors', { slug: 'abc' }))).editors).toContain('new@example.com');
    expect((await call('change_editor_email', { slug: 'abc', from: 'new@example.com', to: 'newer@example.com' })).isError).toBeUndefined();
    expect((await call('remove_editor', { slug: 'abc', email: 'newer@example.com' })).isError).toBeUndefined();
    expect(JSON.parse(txt(await call('list_editors', { slug: 'abc' }))).editors).toEqual(['ed@example.com']);
  });

  it('refuses to remove the caller themselves and surfaces API errors', async () => {
    const r = await call('remove_editor', { slug: 'abc', email: 'ED@example.com' });
    expect(r.isError).toBe(true);
    expect(txt(r)).toMatch(/your own access/);
    expect((await call('add_editor', { slug: 'abc', email: 'not-an-email' })).isError).toBe(true);
  });
});

describe('create_site', () => {
  it('validates the slug locally and surfaces API errors', async () => {
    expect((await call('create_site', { slug: 'api', email: 'o@example.com' })).isError).toBe(true);
    expect((await call('create_site', { slug: 'Bad Slug', email: 'o@example.com' })).isError).toBe(true);
    const r = await call('create_site', { slug: 'fresh-site', email: 'o@example.com' }); // Cloudflare not configured in tests
    expect(r.isError).toBe(true);
    expect(txt(r)).toMatch(/\(5\d\d\)|\(40\d\)/);
  });
});
