// Site traffic summary emails (src/site-stats.js): cleaning rules, aggregation per site,
// report rendering and the cron entry point (test mode and live mode), with a stubbed
// Cloudflare GraphQL API and a stubbed Resend.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  normalizePath,
  isNoisePath,
  pageLabel,
  classifyReferrer,
  mainEditor,
  siteHostnames,
  monthRange,
  rollingRange,
  chunkRange,
  pctChange,
  runStatsReport,
} from '../../src/site-stats.js';
import { MockR2, makeTestEnv } from '../helpers/integration.js';

describe('cleaning rules', () => {
  it('normalizes paths', () => {
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('/misas/')).toBe('/misas');
    expect(normalizePath('/misas.html')).toBe('/misas');
    expect(normalizePath('/misas/index.html?x=1')).toBe('/misas');
    expect(normalizePath('')).toBe('/');
  });

  it('drops everything an editor should not see', () => {
    for (const p of ['/robots.txt', '/sitemap.xml', '/sitemap-1.xml', '/favicon.ico', '/calendar.json', '/calendar.ics', '/assets/app.abc.js',
      '/.well-known/security.txt', '/cdn-cgi/rum', '/api/x', '/_nuxt/a', '/404', '/404.html', '/manifest.webmanifest', '/sw.js', '/foto.png']) {
      expect(isNoisePath(p), p).toBe(true);
    }
    for (const p of ['/', '/misas', '/misas/horarios', '/catequesis.html', '/eventos/retiro-2026']) {
      expect(isNoisePath(p), p).toBe(false);
    }
  });

  it('labels pages readably', () => {
    expect(pageLabel('/')).toBe('Inicio');
    expect(pageLabel('/misas/horarios-verano')).toBe('Misas / horarios verano');
    expect(pageLabel('/a%C3%B1o-santo')).toBe('Año santo');
  });

  it('classifies referrers and ignores the site itself', () => {
    const own = new Set(['demo.parroquia.app', 'www.demoparroquia.es']);
    expect(classifyReferrer('', own)).toBe('direct');
    expect(classifyReferrer('demo.parroquia.app', own)).toBe('own');
    expect(classifyReferrer('demoparroquia.es', own)).toBe('own');
    expect(classifyReferrer('www.google.com', own)).toBe('search');
    expect(classifyReferrer('duckduckgo.com', own)).toBe('search');
    expect(classifyReferrer('l.facebook.com', own)).toBe('social');
    expect(classifyReferrer('t.co', own)).toBe('social');
    expect(classifyReferrer('diocesis.example', own)).toBe('other');
  });
});

describe('sites and editors', () => {
  it('main editor is the first email granted on the slug', () => {
    const state = { emails: { 'a@x.com': ['one'], 'b@x.com': ['two', 'one'], 'c@x.com': ['two'] } };
    expect(mainEditor(state, 'one')).toBe('a@x.com');
    expect(mainEditor(state, 'two')).toBe('b@x.com');
    expect(mainEditor(state, 'none')).toBeNull();
    expect(mainEditor(null, 'one')).toBeNull();
  });

  it('hostnames: subdomain plus the custom domain', () => {
    expect([...siteHostnames({ dev: { siteurl: 'https://www.demoparroquia.es/' } }, 'demo')]).toEqual(['demo.parroquia.app', 'www.demoparroquia.es']);
    expect([...siteHostnames({}, 'demo')]).toEqual(['demo.parroquia.app']);
    expect([...siteHostnames({ dev: { siteurl: 'not a url ::' } }, 'demo')]).toEqual(['demo.parroquia.app']);
  });
});

describe('ranges', () => {
  it('monthRange is the previous full month (UTC)', () => {
    const r = monthRange(new Date('2026-11-01T18:00:00Z'));
    expect(new Date(r.start).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(new Date(r.end).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(new Date(r.prevStart).toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(r.label).toBe('octubre de 2026');
    expect(new Date(monthRange(new Date('2027-01-01T18:00:00Z')).start).toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  it('rollingRange ends yesterday and chunks stay under 30 days', () => {
    const r = rollingRange(new Date('2026-11-18T18:00:00Z'), 30);
    expect(new Date(r.start).toISOString()).toBe('2026-10-19T00:00:00.000Z');
    expect(new Date(r.end).toISOString()).toBe('2026-11-18T00:00:00.000Z');
    const dec = monthRange(new Date('2027-01-01T00:00:00Z')); // 31 days
    expect(chunkRange(dec.start, dec.end).length).toBe(3);
    expect(chunkRange(r.start, r.end).length).toBe(2);
  });

  it('pctChange', () => {
    expect(pctChange(150, 100)).toBe(50);
    expect(pctChange(50, 100)).toBe(-50);
    expect(pctChange(5, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cron entry point
// ---------------------------------------------------------------------------

let sent;
let gqlCalls;

// Rows are keyed by dimension; the real API filters by time, so daily rows honour the window.
function stubCloudflare(rowsByDim) {
  const served = new Set();
  vi.stubGlobal('fetch', async (url, init) => {
    const u = String(url);
    if (u.includes('api.resend.com')) {
      sent.push(JSON.parse(init.body));
      return Response.json({ id: 'x' });
    }
    if (u.includes('api.cloudflare.com/client/v4/graphql')) {
      const q = JSON.parse(init.body).query;
      gqlCalls.push(q);
      const geq = /datetime_geq: "([^"]+)"/.exec(q)[1];
      const lt = /datetime_lt: "([^"]+)"/.exec(q)[1];
      const isRum = q.includes('rumPageloadEventsAdaptiveGroups');
      const dim = isRum
        ? /dimensions \{ requestHost (\w+) \}/.exec(q)[1]
        : q.includes('edgeResponseContentType: "pdf"') ? 'pdf' : 'diag';
      let rows = rowsByDim[dim] || [];
      if (dim === 'date') rows = rows.filter((r) => `${r.dimensions.date}T00:00:00Z` >= geq && `${r.dimensions.date}T00:00:00Z` < lt);
      else {
        const key = `${dim}|${q.includes('requestHost_in') ? 'h' : 'z'}|${/requestHost_in: (\[[^\]]*\])/.exec(q)?.[1] ?? ''}`;
        if (served.has(key)) rows = []; // later chunks of the same query: nothing more
        served.add(key);
      }
      // A host filter really filters.
      const m = /(?:requestHost_in|clientRequestHTTPHost_in): (\[[^\]]*\])/.exec(q);
      if (m) {
        const hosts = JSON.parse(m[1]);
        rows = rows.filter((r) => !(r.dimensions.requestHost || r.dimensions.clientRequestHTTPHost) || hosts.includes(r.dimensions.requestHost || r.dimensions.clientRequestHTTPHost));
      }
      const name = isRum ? 'rumPageloadEventsAdaptiveGroups' : 'httpRequestsAdaptiveGroups';
      return Response.json({ data: { viewer: { [isRum ? 'accounts' : 'zones']: [{ [name]: rows }] } } });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
}

const row = (dims, count, visits = count) => ({ count, sum: { visits }, dimensions: dims });
const TAG = 'a'.repeat(32);

function dataset(octDay = '2026-10-12', novDay = '2026-11-10') {
  return {
    date: [
      row({ requestHost: 'demo.parroquia.app', date: octDay }, 30, 20),
      row({ requestHost: 'www.demoparroquia.es', date: '2026-10-20' }, 10, 8),
      row({ requestHost: 'demo.parroquia.app', date: '2026-09-15' }, 20, 14), // previous month
      row({ requestHost: 'otra.parroquia.app', date: '2026-10-05' }, 500, 400),
      row({ requestHost: 'demo.parroquia.app', date: novDay }, 12, 9),
    ],
    requestPath: [
      row({ requestHost: 'demo.parroquia.app', requestPath: '/' }, 25),
      row({ requestHost: 'demo.parroquia.app', requestPath: '/misas/horarios' }, 10),
      row({ requestHost: 'demo.parroquia.app', requestPath: '/robots.txt' }, 99),
      row({ requestHost: 'demo.parroquia.app', requestPath: '/assets/index.js' }, 77),
      row({ requestHost: 'demo.parroquia.app', requestPath: '/404' }, 55),
      row({ requestHost: 'otra.parroquia.app', requestPath: '/secreto-de-otra' }, 400),
    ],
    refererHost: [
      row({ requestHost: 'demo.parroquia.app', refererHost: '' }, 15),
      row({ requestHost: 'demo.parroquia.app', refererHost: 'www.google.com' }, 12),
      row({ requestHost: 'demo.parroquia.app', refererHost: 'demo.parroquia.app' }, 40),
      row({ requestHost: 'demo.parroquia.app', refererHost: 'l.facebook.com' }, 5),
    ],
    countryName: [row({ requestHost: 'demo.parroquia.app', countryName: 'ES' }, 35), row({ requestHost: 'demo.parroquia.app', countryName: 'FR' }, 5)],
    deviceType: [row({ requestHost: 'demo.parroquia.app', deviceType: 'mobile' }, 30), row({ requestHost: 'demo.parroquia.app', deviceType: 'desktop' }, 10)],
    pdf: [
      { count: 7, dimensions: { clientRequestPath: '/demo/boletin-1a2b3c.pdf' } },
      { count: 99, dimensions: { clientRequestPath: '/otra/privado.pdf' } },
      { count: 3, dimensions: { clientRequestPath: '/desconocida/x.pdf' } },
    ],
    diag: [
      { count: 100, dimensions: { clientRequestPath: '/', edgeResponseContentType: 'html', edgeResponseStatus: 200 } },
      { count: 40, dimensions: { clientRequestPath: '/robots.txt', edgeResponseContentType: 'plain', edgeResponseStatus: 200 } },
      { count: 5, dimensions: { clientRequestPath: '/404', edgeResponseContentType: 'html', edgeResponseStatus: 200 } },
    ],
  };
}

async function setup(extraEnv = {}) {
  const r2 = new MockR2();
  const env = await makeTestEnv(r2);
  Object.assign(env, { CF_ANALYTICS_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: TAG, CLOUDFLARE_ZONE_ID: 'b'.repeat(32), RESEND_API_KEY: 're', STATS_SEND_DELAY_MS: 0, ...extraEnv });
  await r2.put('slugs.json', JSON.stringify({ slugs: ['demo', 'otra', 'sineditor'] }));
  await r2.put('demo/config.json', JSON.stringify({ info: { title: 'Parroquia Demo' }, dev: { siteurl: 'https://www.demoparroquia.es' } }));
  await r2.put('otra/config.json', JSON.stringify({ title: 'Otra' }));
  await r2.put('sineditor/config.json', JSON.stringify({}));
  await r2.seedAuth(env, { emails: { 'owner@demo.org': ['demo'], 'second@x.org': ['demo', 'otra'] }, tokens: {}, magic: {} });
  return env;
}

beforeEach(() => {
  sent = [];
  gqlCalls = [];
});
afterEach(() => vi.unstubAllGlobals());

describe('runStatsReport', () => {
  it('does nothing when unconfigured or off', async () => {
    const env = await setup({ CF_ANALYTICS_TOKEN: undefined });
    expect(await runStatsReport(env, new Date('2026-11-01T18:00:00Z'))).toEqual({ skipped: 'not configured' });
    const off = await setup({ STATS_REPORT_MODE: 'off' });
    expect(await runStatsReport(off)).toEqual({ skipped: 'off' });
    expect(sent).toHaveLength(0);
  });

  it('live mode: only on the 1st, to the main editor of each site, with only that site\'s numbers', async () => {
    const env = await setup({ STATS_REPORT_MODE: 'live', STATS_TEST_EMAIL: 'dev@x.org' });
    stubCloudflare(dataset());

    expect(await runStatsReport(env, new Date('2026-11-18T18:00:00Z'))).toEqual({ skipped: 'not the 1st' });
    expect(sent).toHaveLength(0);

    const res = await runStatsReport(env, new Date('2026-11-01T18:00:00Z'));
    expect(res).toEqual({ sent: 2, skipped: 1 }); // 'sineditor' has no editor and no data
    const byTo = Object.fromEntries(sent.map((m) => [m.to, m]));
    expect(Object.keys(byTo).sort()).toEqual(['owner@demo.org', 'second@x.org']);
    expect(sent.some((m) => m.to === 'dev@x.org')).toBe(false);

    const demo = byTo['owner@demo.org'];
    expect(demo.subject).toBe('Resumen de octubre de 2026 — Parroquia Demo');
    // beacon numbers of demo (both hosts): visits 20 + 8 = 28; views 30 + 10 = 40
    expect(demo.html).toContain('>28<');
    expect(demo.html).toContain('>40<');
    expect(demo.html).toContain('▲ 100 % respecto al mes anterior'); // 14 visits -> 28
    // noise never reaches the editor
    for (const bad of ['/robots.txt', 'robots.txt', '/assets', '/404', 'sitemap', 'secreto', 'privado', '>500<', '>400<']) expect(demo.html + demo.text).not.toContain(bad);
    // cleaned content does
    expect(demo.html).toContain('Misas / horarios');
    expect(demo.html).toContain('Buscadores');
    expect(demo.html).toContain('España');
    expect(demo.html).toContain('boletin-1a2b3c.pdf');
    // no developer block, no test banner
    expect(demo.html).not.toContain('Solo prueba');
    expect(demo.subject).not.toContain('[Prueba]');
    // the second site goes to ITS first editor and shows its own data
    expect(byTo['second@x.org'].html).toContain('Secreto de otra');
    expect(byTo['second@x.org'].html).toContain('>400<');
    expect(byTo['second@x.org'].html).not.toContain('Misas');
  });

  it('every GraphQL window is at most 15 days (limit is 30)', async () => {
    const env = await setup({ STATS_REPORT_MODE: 'live' });
    stubCloudflare(dataset());
    await runStatsReport(env, new Date('2026-12-01T18:00:00Z'));
    expect(gqlCalls.length).toBeGreaterThan(0);
    for (const q of gqlCalls) {
      const geq = Date.parse(/datetime_geq: "([^"]+)"/.exec(q)[1]);
      const lt = Date.parse(/datetime_lt: "([^"]+)"/.exec(q)[1]);
      expect((lt - geq) / 86400000).toBeLessThanOrEqual(15);
    }
  });

  it('test mode: one email to the developer only, last 30 days, with the diagnostics block', async () => {
    const env = await setup({ STATS_REPORT_MODE: 'test', STATS_TEST_EMAIL: 'dev@x.org', STATS_TEST_SLUG: 'demo' });
    stubCloudflare(dataset('2026-11-03'));
    const res = await runStatsReport(env, new Date('2026-11-18T18:00:00Z'));
    expect(res).toMatchObject({ sent: 1, slug: 'demo' });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('dev@x.org');
    expect(sent[0].subject).toBe('[Prueba] Resumen de los últimos 30 días — Parroquia Demo');
    expect(sent[0].html).toContain('Modo prueba');
    expect(sent[0].html).toContain('owner@demo.org');
    expect(sent[0].html).toContain('Solo prueba');
    expect(sent[0].html).toContain('HTML 200 sin ruido');
    expect(sent[0].html).toContain('/robots.txt (40)'); // filtered, but visible to the developer
  });

  it('test mode rotates through the sites by day', async () => {
    const env = await setup({ STATS_REPORT_MODE: 'test', STATS_TEST_EMAIL: 'dev@x.org' });
    stubCloudflare(dataset());
    const a = await runStatsReport(env, new Date('2026-11-18T18:00:00Z'));
    const b = await runStatsReport(env, new Date('2026-11-19T18:00:00Z'));
    expect(a.slug).not.toBe(b.slug);
  });

  it('test mode mails the error instead of failing silently when Cloudflare rejects the query', async () => {
    const env = await setup({ STATS_REPORT_MODE: 'test', STATS_TEST_EMAIL: 'dev@x.org', STATS_TEST_SLUG: 'demo' });
    vi.stubGlobal('fetch', async (url, init) => {
      if (String(url).includes('resend')) {
        sent.push(JSON.parse(init.body));
        return Response.json({ id: 'x' });
      }
      return Response.json({ data: null, errors: [{ message: 'unknown field requestHost_in' }] });
    });
    const res = await runStatsReport(env, new Date('2026-11-18T18:00:00Z'));
    expect(res.error).toContain('unknown field requestHost_in');
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('dev@x.org');
    expect(sent[0].subject).toContain('Error');
  });

  it('live mode never mails editors when the beacon query fails', async () => {
    const env = await setup({ STATS_REPORT_MODE: 'live' });
    vi.stubGlobal('fetch', async () => Response.json({ data: null, errors: [{ message: 'boom' }] }));
    await expect(runStatsReport(env, new Date('2026-11-01T18:00:00Z'))).rejects.toThrow('boom');
    expect(sent).toHaveLength(0);
  });
});
