import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../../src/worker.js';
import {
  isReservedSlug, contentTypeFor, checkDnsFree, checkPagesFree, guardRequest, PAGES_RETRY_WINDOW_MS,
} from '../../src/guards.js';
import { MockR2, makeCtx, makeTestEnv, seedEditor, seedSiteMarker } from '../helpers/integration.js';

afterEach(() => vi.unstubAllGlobals());

const cfEnv = (env) => Object.assign(env, { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ZONE_ID: 'z', CLOUDFLARE_ACCOUNT_ID: 'a' });
const stubCf = (status, body) => {
  const f = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', f);
  return f;
};

describe('isReservedSlug', () => {
  it.each(['api', 'editor', 'www', 'data', 'mail', 'send', 'login', 'admin', 'plantilla', 'ns1', 'em1234', 'smtp2', 'xn--abc'])(
    'reserves %s', (s) => expect(isReservedSlug(s)).toBe(true));
  it.each(['santa-maria', 'parroquia-san-jose', '47herri', 'test', 'ermitasanfrutos', 'mailbox-fan'])(
    'allows %s', (s) => expect(isReservedSlug(s)).toBe(false));
});

describe('contentTypeFor', () => {
  it('maps allowlisted extensions', () => {
    expect(contentTypeFor('a.png')).toBe('image/png');
    expect(contentTypeFor('a.jpg')).toBe('image/jpeg');
    expect(contentTypeFor('config.json')).toContain('application/json');
    expect(contentTypeFor('notes.md')).toContain('text/markdown');
  });
  it('never yields an HTML or script type; unknown/no extension is octet-stream', () => {
    expect(contentTypeFor('noext')).toBe('application/octet-stream');
    expect(contentTypeFor('x.html')).toBe('application/octet-stream');
    for (const f of ['a.pdf', 'b.webp', 'c.md', 'd.json', 'e.png']) expect(contentTypeFor(f)).not.toMatch(/html|javascript|svg/);
  });
});

describe('checkDnsFree', () => {
  it('is ok when nothing exists or only our pages.dev CNAME', async () => {
    const env = cfEnv({});
    stubCf(200, { success: true, result: [] });
    expect((await checkDnsFree(env, 'newsite')).ok).toBe(true);
    stubCf(200, { success: true, result: [{ type: 'CNAME', content: 'newsite-3mn.pages.dev' }] });
    expect((await checkDnsFree(env, 'newsite')).ok).toBe(true);
  });
  it('refuses an existing MX/TXT/A record (409)', async () => {
    const env = cfEnv({});
    for (const rec of [{ type: 'MX', content: 'feedback-smtp.eu-west-1.amazonses.com' }, { type: 'TXT', content: 'v=spf1' }, { type: 'A', content: '1.2.3.4' }, { type: 'CNAME', content: 'evil.example.com' }]) {
      stubCf(200, { success: true, result: [rec] });
      const r = await checkDnsFree(env, 'send');
      expect(r).toMatchObject({ ok: false, status: 409 });
    }
  });
  it('fails closed (503) when Cloudflare cannot be queried; skips when unconfigured', async () => {
    stubCf(500, { success: false, errors: [{ message: 'boom' }] });
    expect(await checkDnsFree(cfEnv({}), 'x')).toMatchObject({ ok: false, status: 503 });
    const f = stubCf(200, {});
    expect((await checkDnsFree({}, 'x')).ok).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('checkPagesFree', () => {
  const now = Date.now();
  it('ok when the project does not exist (404 / 8000xxx)', async () => {
    stubCf(404, { success: false, errors: [{ code: 8000007 }] });
    expect((await checkPagesFree(cfEnv({}), 'new', now)).ok).toBe(true);
  });
  it('refuses an older existing project, allows a just-created one (retry)', async () => {
    stubCf(200, { success: true, result: { created_on: new Date(now - 2 * PAGES_RETRY_WINDOW_MS).toISOString() } });
    expect(await checkPagesFree(cfEnv({}), 'old', now)).toMatchObject({ ok: false, status: 409 });
    stubCf(200, { success: true, result: { created_on: new Date(now - 60_000).toISOString() } });
    expect((await checkPagesFree(cfEnv({}), 'fresh', now)).ok).toBe(true);
  });
  it('fails closed on other errors', async () => {
    stubCf(500, { success: false, errors: [{ code: 10000 }] });
    expect(await checkPagesFree(cfEnv({}), 'x', now)).toMatchObject({ ok: false, status: 503 });
  });
});

describe('guardRequest / worker wiring', () => {
  it('PUT forces the stored Content-Type from the extension (even if the client says text/html)', async () => {
    const r2 = new MockR2();
    const env = await makeTestEnv(r2);
    await seedSiteMarker(r2, 'mysite');
    const { token } = await seedEditor(r2, env, 'ed@example.com', 'mysite');
    const res = await worker.fetch(new Request('https://api.parroquia.app/sites/mysite/pic.png', {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/html' }, body: new Uint8Array([1, 2, 3]),
    }), env, makeCtx());
    expect(res.status).toBe(200);
    expect((await r2.head('mysite/pic.png')).httpMetadata.contentType).toBe('image/png');
  });

  it('POST reserved slug -> 400 for an editor, before any Cloudflare call', async () => {
    const r2 = new MockR2();
    const env = cfEnv(await makeTestEnv(r2));
    const { token } = await seedEditor(r2, env, 'ed@example.com', 'mysite');
    const f = stubCf(200, {});
    const res = await worker.fetch(new Request('https://api.parroquia.app/sites/send', {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ email: 'o@example.com' }),
    }), env, makeCtx());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('slug is reserved');
    expect(f).not.toHaveBeenCalled();
  });

  it('POST by an unauthenticated caller never reaches Cloudflare', async () => {
    const r2 = new MockR2();
    const env = cfEnv(await makeTestEnv(r2));
    const f = stubCf(200, { success: true, result: [] });
    const res = await worker.fetch(new Request('https://api.parroquia.app/sites/newsite', {
      method: 'POST', body: JSON.stringify({ email: 'o@example.com' }),
    }), env, makeCtx());
    expect(res.status).toBe(401);
    expect(f).not.toHaveBeenCalled();
  });

  it('POST by an editor on a name that already has an MX record -> 409, nothing provisioned', async () => {
    const r2 = new MockR2();
    const env = cfEnv(await makeTestEnv(r2));
    const { token } = await seedEditor(r2, env, 'ed@example.com', 'mysite');
    stubCf(200, { success: true, result: [{ type: 'MX', content: 'mx.example.com' }] });
    const res = await worker.fetch(new Request('https://api.parroquia.app/sites/ordinaryname', {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ email: 'o@example.com' }),
    }), env, makeCtx());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('slug is already in use');
  });

  it('non-site and GET requests are untouched', async () => {
    const req = new Request('https://api.parroquia.app/health');
    expect((await guardRequest({}, req)).request).toBe(req);
  });
});
