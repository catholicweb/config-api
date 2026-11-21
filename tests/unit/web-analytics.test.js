// Web Analytics beacon check/auto-install (src/web-analytics.js) with a stubbed Cloudflare API.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ensureBeacons, coveredHosts } from '../../src/web-analytics.js';

afterEach(() => vi.unstubAllGlobals());

const env = { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_ZONE_ID: 'zone' };

function stub(existing, { failCreate = [] } = {}) {
  const created = [];
  vi.stubGlobal('fetch', async (url, init) => {
    const u = String(url);
    if (u.includes('/rum/site_info/list')) return Response.json({ success: true, result: existing });
    if (u.endsWith('/rum/site_info') && init?.method === 'POST') {
      const body = JSON.parse(init.body);
      if (failCreate.includes(body.host)) return Response.json({ success: false, errors: [{ message: 'nope' }] }, { status: 403 });
      created.push(body);
      return Response.json({ success: true, result: { site_tag: 'x' } });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  return created;
}

describe('beacons', () => {
  it('knows which hosts are covered (explicit host or host rules)', () => {
    const set = coveredHosts([{ host: 'A.parroquia.app' }, { rules: [{ host: 'b.parroquia.app' }] }, {}]);
    expect([...set].sort()).toEqual(['a.parroquia.app', 'b.parroquia.app']);
  });

  it('creates only the missing zone hostnames, with auto-install, and reports custom domains', async () => {
    const created = stub([{ host: 'a.parroquia.app' }]);
    const res = await ensureBeacons(env, ['a.parroquia.app', 'b.parroquia.app', 'www.custom.es']);
    expect(res.ok).toEqual(['a.parroquia.app']);
    expect(res.created).toEqual(['b.parroquia.app']);
    expect(res.external).toEqual(['www.custom.es']);
    expect(created).toEqual([{ host: 'b.parroquia.app', zone_tag: 'zone', auto_install: true }]);
  });

  it('a failing creation is reported, the others still go through', async () => {
    const created = stub([], { failCreate: ['bad.parroquia.app'] });
    const res = await ensureBeacons(env, ['bad.parroquia.app', 'good.parroquia.app']);
    expect(res.created).toEqual(['good.parroquia.app']);
    expect(res.failed).toEqual([{ host: 'bad.parroquia.app', error: expect.stringContaining('nope') }]);
    expect(created).toHaveLength(1);
  });

  it('does nothing when unconfigured', async () => {
    expect((await ensureBeacons({}, ['a.parroquia.app'])).skipped).toBe('not configured');
  });
});
