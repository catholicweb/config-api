/**
 * Site traffic summary emails (monthly, to each site's main editor).
 *
 * Runs from the daily cron (see worker.js `scheduled`). Two modes, set with the
 * STATS_REPORT_MODE var:
 *
 *   test (default)  every day, ONE email to STATS_TEST_EMAIL: the report of one
 *                   site (rotating through slugs.json, or STATS_TEST_SLUG) over the
 *                   last 30 days, plus a developer-only block comparing the beacon
 *                   with the raw requests. Nothing is sent to editors.
 *   live            on the 1st of each month, the report of the previous calendar
 *                   month to the MAIN EDITOR of every site (see mainEditor()).
 *   off             does nothing.
 *
 * Data (Cloudflare GraphQL Analytics API, secret CF_ANALYTICS_TOKEN):
 *
 *   - The Web Analytics beacon (rumPageloadEventsAdaptiveGroups) is the ONLY source
 *     of visits / page views / pages / referrers / countries / devices. It only
 *     counts real browsers that load a page, so crawlers and asset requests never
 *     reach it. Raw zone requests are NOT mixed into those numbers (they include
 *     robots, crawlers, js/css/images/json, robots.txt, sitemap.xml...), which would
 *     double count and show editors things only a developer cares about.
 *   - Raw zone requests (httpRequestsAdaptiveGroups) are used for file downloads
 *     (PDFs on the data host) and, in test mode only, for the diagnostics block.
 *   - Everything is filtered to the site's own hostnames: <slug>.parroquia.app and the
 *     host of its dev.siteurl. A site never sees another site's numbers.
 *
 * Adding a data source (e.g. Google Search Console): write a collector
 * `async (env, sites, range) => Map<slug, data>`, register it in SOURCES, and add a
 * renderer for its section in buildReport(). A failing optional source only drops
 * its own section; a failing beacon query aborts the run so nobody gets a report
 * full of zeros.
 */
import { readAuthState } from './index.js';
import { esc, sendRegistrationEmail } from './registration.js';

const GQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
const DAY = 86400000;
// Adaptive datasets allow at most 30 days per query: split longer windows.
const CHUNK_DAYS = 15;
const ROW_LIMIT = 10000;

const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// ---------------------------------------------------------------------------
// Date ranges
// ---------------------------------------------------------------------------

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const isoTime = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function monthLabel(ms) {
  const d = new Date(ms);
  return `${MONTHS_ES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`;
}

/** The previous complete calendar month (UTC) and the one before it, for comparison. */
export function monthRange(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = Date.UTC(y, m - 1, 1);
  const end = Date.UTC(y, m, 1);
  return { kind: 'month', start, end, prevStart: Date.UTC(y, m - 2, 1), prevEnd: start, label: monthLabel(start), vsText: 'respecto al mes anterior', sameText: 'igual que el mes anterior' };
}

/** The last `days` complete days (UTC), ending yesterday, and the same length before it. */
export function rollingRange(now = new Date(), days = 30) {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = end - days * DAY;
  return { kind: 'rolling', start, end, prevStart: start - days * DAY, prevEnd: start, label: `los últimos ${days} días`, vsText: `respecto a los ${days} días anteriores`, sameText: `igual que los ${days} días anteriores` };
}

export function chunkRange(start, end, days = CHUNK_DAYS) {
  const out = [];
  for (let s = start; s < end; s += days * DAY) out.push([s, Math.min(s + days * DAY, end)]);
  return out;
}

// ---------------------------------------------------------------------------
// Cleaning: what an editor should (not) see
// ---------------------------------------------------------------------------

/** '/misas/index.html?x=1' -> '/misas' ; '/' stays '/'. */
export function normalizePath(raw) {
  let p = String(raw ?? '').split(/[?#]/)[0];
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/index\.html$/i, '/').replace(/\.html$/i, '');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '/';
}

/**
 * Requests that are not "a person looking at a page": robots.txt, sitemaps, favicons,
 * manifests, service workers, build assets, any file with an extension (json, ics, xml,
 * txt, js, css, images, pdf...), Cloudflare/well-known/internal paths and the 404 page.
 */
export function isNoisePath(raw) {
  const p = normalizePath(raw);
  if (/^\/(?:cdn-cgi|\.well-known|assets|api|_)/i.test(p)) return true;
  if (/^\/404$/i.test(p)) return true;
  return /\.[a-z0-9]{1,12}$/i.test(p);
}

/** Readable name for a path: '/misas/horarios-verano' -> 'Misas / horarios verano'. */
export function pageLabel(path) {
  if (path === '/') return 'Inicio';
  const parts = path.split('/').filter(Boolean).map((seg) => {
    try {
      return decodeURIComponent(seg).replace(/[-_]+/g, ' ');
    } catch {
      return seg;
    }
  });
  return cap(parts.join(' / '));
}

const SEARCH_RE = /(^|\.)(google|bing|duckduckgo|ecosia|yahoo|yandex|qwant|startpage|baidu|brave)\.[a-z.]+$/i;
const SOCIAL_RE = /(^|\.)(facebook|fb|instagram|twitter|x|t|whatsapp|wa|youtube|youtu|telegram|threads|linkedin|tiktok|pinterest|reddit)\.(com|me|be|co|net|org)$/i;

const stripWww = (h) => String(h || '').toLowerCase().replace(/^www\./, '');

/** 'direct' | 'own' | 'search' | 'social' | 'other'. `ownHosts` = the site's hostnames. */
export function classifyReferrer(host, ownHosts) {
  const h = stripWww(host);
  if (!h) return 'direct';
  for (const o of ownHosts) if (stripWww(o) === h) return 'own';
  if (SEARCH_RE.test(h)) return 'search';
  if (SOCIAL_RE.test(h)) return 'social';
  return 'other';
}

function countryName(code) {
  const c = String(code || '');
  if (!/^[A-Za-z]{2}$/.test(c)) return c || 'Desconocido';
  try {
    return new Intl.DisplayNames(['es'], { type: 'region' }).of(c.toUpperCase()) || c;
  } catch {
    return c;
  }
}

/** The editor that receives the report: the first email granted on the slug (the owner seeded at creation). */
export function mainEditor(state, slug) {
  for (const [email, slugs] of Object.entries(state?.emails || {})) {
    if (Array.isArray(slugs) && slugs.includes(slug)) return email;
  }
  return null;
}

/** Hostnames that belong to a site: <slug>.parroquia.app + the host of config.dev.siteurl. */
export function siteHostnames(cfg, slug) {
  const hosts = new Set([`${slug}.parroquia.app`]);
  const siteurl = cfg?.dev?.siteurl;
  if (typeof siteurl === 'string' && siteurl) {
    try {
      const u = new URL(/^https?:\/\//i.test(siteurl) ? siteurl : `https://${siteurl}`);
      if (u.hostname) hosts.add(u.hostname.toLowerCase());
    } catch {
      /* keep the default subdomain only */
    }
  }
  return hosts;
}

// ---------------------------------------------------------------------------
// Cloudflare GraphQL
// ---------------------------------------------------------------------------

const TAG_RE = /^[a-f0-9]{32}$/i;
const HOST_RE = /^[a-z0-9.-]+$/;

async function gql(env, scope, selection) {
  const tag = scope === 'zone' ? env.CLOUDFLARE_ZONE_ID : env.CLOUDFLARE_ACCOUNT_ID;
  if (!TAG_RE.test(String(tag || ''))) throw new Error(`invalid Cloudflare ${scope} id`);
  const root = scope === 'zone' ? `zones(filter: { zoneTag: "${tag}" })` : `accounts(filter: { accountTag: "${tag}" })`;
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `query { viewer { ${root} { ${selection} } } }` }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.errors?.length) {
    throw new Error(`Cloudflare GraphQL ${res.status}: ${body?.errors?.[0]?.message || 'bad response'}`);
  }
  return body.data?.viewer?.[scope === 'zone' ? 'zones' : 'accounts']?.[0] || {};
}

const hostList = (hosts) => JSON.stringify([...hosts].filter((h) => HOST_RE.test(h)));

/** Rows of a beacon (Web Analytics) dimension for the hosts, over [start, end). */
async function rumRows(env, hosts, dimension, start, end) {
  const rows = [];
  for (const [s, e] of chunkRange(start, end)) {
    const data = await gql(
      env,
      'account',
      `rumPageloadEventsAdaptiveGroups(limit: ${ROW_LIMIT}, orderBy: [count_DESC], filter: { datetime_geq: "${isoTime(s)}", datetime_lt: "${isoTime(e)}", requestHost_in: ${hostList(hosts)} }) { count sum { visits } dimensions { requestHost ${dimension} } }`,
    );
    rows.push(...(data.rumPageloadEventsAdaptiveGroups || []));
  }
  return rows;
}

/** Rows of raw zone requests (all hosts of the zone matching `filter`), over [start, end). */
async function rawRows(env, filter, dimensions, start, end) {
  const rows = [];
  for (const [s, e] of chunkRange(start, end)) {
    const data = await gql(
      env,
      'zone',
      `httpRequestsAdaptiveGroups(limit: ${ROW_LIMIT}, orderBy: [count_DESC], filter: { datetime_geq: "${isoTime(s)}", datetime_lt: "${isoTime(e)}", ${filter} }) { count dimensions { ${dimensions} } }`,
    );
    rows.push(...(data.httpRequestsAdaptiveGroups || []));
  }
  return rows;
}

const bump = (map, key, n) => map.set(key, (map.get(key) || 0) + n);
const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function emptyRum(range) {
  const daily = [];
  for (let t = range.start; t < range.end; t += DAY) daily.push({ date: isoDate(t), views: 0, visits: 0 });
  return { views: 0, visits: 0, prevViews: 0, prevVisits: 0, daily, pages: [], referrers: { cats: {}, hosts: [] }, countries: [], devices: {} };
}

/** Beacon data: the human-visible numbers. One query set for ALL given sites. */
async function collectRum(env, sites, range) {
  const hostToSlug = new Map();
  const ownBySlug = new Map();
  for (const s of sites) {
    ownBySlug.set(s.slug, s.hosts);
    for (const h of s.hosts) hostToSlug.set(h, s.slug);
  }
  const hosts = [...hostToSlug.keys()];
  const slugOf = (row) => hostToSlug.get(String(row.dimensions.requestHost || '').toLowerCase());

  const [daily, prevDaily, pageRows, refRows, countryRows, deviceRows] = await Promise.all([
    rumRows(env, hosts, 'date', range.start, range.end),
    rumRows(env, hosts, 'date', range.prevStart, range.prevEnd),
    rumRows(env, hosts, 'requestPath', range.start, range.end),
    rumRows(env, hosts, 'refererHost', range.start, range.end),
    rumRows(env, hosts, 'countryName', range.start, range.end),
    rumRows(env, hosts, 'deviceType', range.start, range.end),
  ]);

  const acc = new Map();
  const tmp = new Map();
  for (const s of sites) {
    acc.set(s.slug, emptyRum(range));
    tmp.set(s.slug, { pages: new Map(), cats: new Map(), refHosts: new Map(), countries: new Map(), devices: new Map() });
  }

  for (const r of daily) {
    const slug = slugOf(r);
    if (!slug) continue;
    const a = acc.get(slug);
    const day = a.daily.find((d) => d.date === r.dimensions.date);
    const views = r.count || 0;
    const visits = r.sum?.visits || 0;
    if (day) {
      day.views += views;
      day.visits += visits;
      a.views += views;
      a.visits += visits;
    }
  }
  for (const r of prevDaily) {
    const slug = slugOf(r);
    if (!slug) continue;
    acc.get(slug).prevViews += r.count || 0;
    acc.get(slug).prevVisits += r.sum?.visits || 0;
  }
  for (const r of pageRows) {
    const slug = slugOf(r);
    if (!slug || isNoisePath(r.dimensions.requestPath)) continue;
    bump(tmp.get(slug).pages, normalizePath(r.dimensions.requestPath), r.count || 0);
  }
  for (const r of refRows) {
    const slug = slugOf(r);
    if (!slug) continue;
    const kind = classifyReferrer(r.dimensions.refererHost, ownBySlug.get(slug));
    if (kind === 'own') continue; // navigation inside the site is not a source of visitors
    const t = tmp.get(slug);
    bump(t.cats, kind, r.count || 0);
    if (kind !== 'direct') bump(t.refHosts, stripWww(r.dimensions.refererHost), r.count || 0);
  }
  for (const r of countryRows) {
    const slug = slugOf(r);
    if (slug) bump(tmp.get(slug).countries, countryName(r.dimensions.countryName), r.count || 0);
  }
  for (const r of deviceRows) {
    const slug = slugOf(r);
    if (!slug) continue;
    const d = String(r.dimensions.deviceType || '').toLowerCase();
    bump(tmp.get(slug).devices, ['desktop', 'mobile', 'tablet'].includes(d) ? d : 'other', r.count || 0);
  }

  for (const s of sites) {
    const a = acc.get(s.slug);
    const t = tmp.get(s.slug);
    a.pages = top(t.pages, 10).map(([path, views]) => ({ path, views }));
    a.referrers = { cats: Object.fromEntries(t.cats), hosts: top(t.refHosts, 5).map(([host, views]) => ({ host, views })) };
    a.countries = top(t.countries, 6).map(([name, views]) => ({ name, views }));
    a.devices = Object.fromEntries(t.devices);
  }
  return acc;
}

/** PDF downloads served from the data host (/<slug>/<file>). Raw requests, so approximate. */
async function collectFiles(env, sites, range) {
  const dataHost = new URL(env.DATA_BASE || 'https://data.parroquia.app').hostname;
  if (!HOST_RE.test(dataHost)) return new Map();
  const rows = await rawRows(env, `clientRequestHTTPHost: "${dataHost}", edgeResponseContentType: "pdf", edgeResponseStatus: 200`, 'clientRequestPath', range.start, range.end);
  const known = new Set(sites.map((s) => s.slug));
  const per = new Map();
  for (const r of rows) {
    const [, slug, ...rest] = String(r.dimensions.clientRequestPath || '').split('/');
    if (!known.has(slug) || !rest.length) continue;
    if (!per.has(slug)) per.set(slug, new Map());
    let name = rest.join('/');
    try {
      name = decodeURIComponent(name);
    } catch {
      /* keep raw */
    }
    bump(per.get(slug), name, r.count || 0);
  }
  const out = new Map();
  for (const [slug, m] of per) out.set(slug, top(m, 5).map(([name, downloads]) => ({ name, downloads })));
  return out;
}

/** Developer-only (test mode): how the raw requests compare with the beacon, and what was filtered out. */
async function collectDiagnostics(env, sites, range) {
  const out = new Map();
  for (const s of sites) {
    const rows = await rawRows(env, `clientRequestHTTPHost_in: ${hostList(s.hosts)}`, 'clientRequestPath edgeResponseContentType edgeResponseStatus', range.start, range.end);
    let total = 0;
    let html200 = 0;
    let html200Clean = 0;
    const noise = new Map();
    for (const r of rows) {
      const n = r.count || 0;
      const d = r.dimensions;
      total += n;
      if (isNoisePath(d.clientRequestPath)) bump(noise, normalizePath(d.clientRequestPath), n);
      if (d.edgeResponseContentType === 'html' && Number(d.edgeResponseStatus) === 200) {
        html200 += n;
        if (!isNoisePath(d.clientRequestPath)) html200Clean += n;
      }
    }
    out.set(s.slug, { total, html200, html200Clean, noiseTop: top(noise, 5), truncated: rows.length >= ROW_LIMIT });
  }
  return out;
}

// Optional sources: a failure only drops their section. Add Google Search Console here.
const SOURCES = [{ id: 'files', collect: collectFiles }];

/** slug -> { rum, files, ... } for the given sites and range. */
export async function collectStats(env, sites, range, { diagnostics = false } = {}) {
  const rum = await collectRum(env, sites, range); // required: throws on failure
  const stats = new Map(sites.map((s) => [s.slug, { rum: rum.get(s.slug) }]));
  const optional = [...SOURCES];
  if (diagnostics) optional.push({ id: 'diagnostics', collect: collectDiagnostics });
  for (const src of optional) {
    try {
      const data = await src.collect(env, sites, range);
      for (const s of sites) if (data.has(s.slug)) stats.get(s.slug)[src.id] = data.get(s.slug);
    } catch (e) {
      console.error(`site-stats: source ${src.id} failed:`, e?.message);
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Report (HTML for email clients: tables + inline styles, no images, no JS)
// ---------------------------------------------------------------------------

const C = { primary: '#0066cc', track: '#e9eef5', text: '#1a1a1a', body: '#444', muted: '#888', up: '#1a7f37', down: '#c62828' };
const nf = (n) => Math.round(n).toLocaleString('es-ES');
const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function pctChange(cur, prev) {
  return prev ? Math.round(((cur - prev) / prev) * 100) : null;
}

function deltaText(cur, prev, range) {
  const p = pctChange(cur, prev);
  if (p === null) return { text: 'sin datos para comparar', color: C.muted };
  if (p === 0) return { text: range.sameText, color: C.muted };
  return { text: `${p > 0 ? '▲' : '▼'} ${Math.abs(p)} % ${range.vsText}`, color: p > 0 ? C.up : C.down };
}

const sectionTitle = (t) => `<p style="margin:28px 0 10px;color:${C.text};font-size:17px;font-weight:bold;">${esc(t)}</p>`;

function kpiCell(label, value, delta) {
  return `<td width="33%" valign="top" style="padding:0 6px 0 0;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7fb;border-radius:8px;"><tr><td style="padding:12px 14px;">
<div style="font-size:12px;color:${C.muted};">${esc(label)}</div>
<div style="font-size:26px;font-weight:bold;color:${C.text};line-height:1.2;">${esc(value)}</div>
<div style="font-size:11px;color:${delta ? delta.color : C.muted};">${esc(delta ? delta.text : ' ')}</div>
</td></tr></table></td>`;
}

/** One column per day; bar height proportional to visits. Nested tables so Outlook keeps the heights. */
function dailyChart(daily) {
  const max = Math.max(1, ...daily.map((d) => d.visits));
  const bars = daily
    .map((d) => {
      const h = d.visits ? Math.max(3, Math.round((d.visits / max) * 100)) : 0;
      const bar = h
        ? `<table width="100%" cellpadding="0" cellspacing="0"><tr><td height="${h}" bgcolor="${C.primary}" title="${esc(`${d.date}: ${d.visits}`)}" style="font-size:0;line-height:0;">&nbsp;</td></tr></table>`
        : '';
      return `<td valign="bottom" style="padding:0 1px;height:104px;">${bar}</td>`;
    })
    .join('');
  const labels = daily
    .map((d, i) => `<td align="center" style="padding:3px 0 0;font-size:9px;color:${C.muted};">${i === 0 || (i + 1) % 5 === 0 ? Number(d.date.slice(8)) : ''}</td>`)
    .join('');
  const first = daily[0]?.date;
  const last = daily[daily.length - 1]?.date;
  const fmt = (iso) => `${Number(iso.slice(8))} ${MONTHS_ES[Number(iso.slice(5, 7)) - 1].slice(0, 3)}`;
  return `<table width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;border-bottom:1px solid ${C.track};"><tr>${bars}</tr></table>
<table width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;"><tr>${labels}</tr></table>
<p style="margin:6px 0 0;font-size:12px;color:${C.muted};">Visitas por día${first && last ? ` · del ${fmt(first)} al ${fmt(last)}` : ''}</p>`;
}

/** Horizontal bars; each item { label, value }. */
function hbars(items, unit = '') {
  const max = Math.max(1, ...items.map((i) => i.value));
  return items
    .map((i) => {
      const pct = Math.min(100, Math.max(2, Math.round((i.value / max) * 100)));
      const rest = 100 - pct;
      return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 9px;"><tr>
<td style="font-size:14px;color:#333;padding-bottom:3px;">${esc(trunc(i.label, 52))}</td>
<td align="right" style="font-size:14px;color:#333;padding-bottom:3px;white-space:nowrap;">${esc(nf(i.value) + unit)}</td></tr>
<tr><td colspan="2"><table width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;"><tr>
<td width="${pct}%" height="8" bgcolor="${C.primary}" style="font-size:0;line-height:0;">&nbsp;</td>${rest ? `<td width="${rest}%" height="8" bgcolor="${C.track}" style="font-size:0;line-height:0;">&nbsp;</td>` : ''}
</tr></table></td></tr></table>`;
    })
    .join('');
}

const SOURCE_LABEL = { direct: 'Directo (dirección escrita, favoritos, apps)', search: 'Buscadores (Google, Bing…)', social: 'Redes sociales y mensajería', other: 'Enlaces desde otras webs' };
const DEVICE_LABEL = { mobile: 'Móvil', desktop: 'Ordenador', tablet: 'Tableta', other: 'Otros' };

function busiestDay(daily) {
  let best = null;
  for (const d of daily) if (d.visits > (best?.visits || 0)) best = d;
  if (!best) return null;
  return `${Number(best.date.slice(8))} de ${MONTHS_ES[Number(best.date.slice(5, 7)) - 1]}`;
}

/**
 * @param {{slug:string,title:string}} site
 * @param {{rum:object, files?:Array, diagnostics?:object}} data
 * @param {object} range
 * @param {{testNote?:string, diagnostics?:boolean}} [opts]
 * @returns {{subject:string, text:string, html:string}}
 */
export function buildReport(site, data, range, opts = {}) {
  const rum = data.rum;
  const name = site.title || site.slug;
  const period = range.label;
  const ppv = rum.visits ? rum.views / rum.visits : 0;
  const day = busiestDay(rum.daily);
  const dVisits = deltaText(rum.visits, rum.prevVisits, range);
  const dViews = deltaText(rum.views, rum.prevViews, range);

  const intro = rum.visits
    ? `Tu web recibió <strong>${esc(nf(rum.visits))} visitas</strong> durante ${esc(period)}${day ? `; el día con más visitas fue el ${esc(day)}` : ''}.`
    : `Durante ${esc(period)} no hemos registrado visitas en tu web.`;

  const pages = rum.pages.map((p) => ({ label: pageLabel(p.path), value: p.views }));
  const cats = Object.entries(rum.referrers.cats).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const sources = cats.map(([k, v]) => ({ label: SOURCE_LABEL[k], value: v }));
  const refHosts = rum.referrers.hosts.map((h) => ({ label: h.host, value: h.views }));
  const countries = rum.countries.map((c) => ({ label: c.name, value: c.views }));
  const devTotal = Object.values(rum.devices).reduce((a, b) => a + b, 0);
  const devices = Object.entries(rum.devices).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ label: DEVICE_LABEL[k] || k, value: Math.round((v / devTotal) * 100) }));
  const files = data.files || [];

  const sections = [];
  if (rum.visits) {
    sections.push(sectionTitle('Visitas por día'), dailyChart(rum.daily));
    if (pages.length) sections.push(sectionTitle('Páginas más visitadas'), hbars(pages));
    if (sources.length) {
      sections.push(sectionTitle('De dónde llegan tus visitantes'), hbars(sources));
      if (refHosts.length) {
        sections.push(`<p style="margin:14px 0 8px;font-size:13px;color:${C.muted};">Webs que más visitantes te envían</p>`, hbars(refHosts));
      }
    }
    if (countries.length) sections.push(sectionTitle('Desde dónde te visitan'), hbars(countries));
    if (devices.length) sections.push(sectionTitle('Dispositivos'), hbars(devices, ' %'));
  }
  if (files.length) {
    sections.push(sectionTitle('Documentos más descargados'), hbars(files.map((f) => ({ label: f.name, value: f.downloads }))));
  }

  const note = `Solo se cuentan visitas de personas con un navegador: los robots, los buscadores y las peticiones técnicas de la web no aparecen. Quien tenga bloqueados los contadores tampoco, así que la cifra real puede ser algo mayor.`;
  const foot = `Resumen automático de parroquia.app para el editor principal de «${name}».`;

  const banner = opts.testNote
    ? `<div style="margin:0 0 20px;padding:10px 14px;background:#fff7d6;border:1px solid #f0dc82;border-radius:6px;font-size:13px;color:#5c4b00;">${esc(opts.testNote)}</div>`
    : '';
  const diag = opts.diagnostics ? diagnosticsHtml(rum, data.diagnostics) : '';

  const html = `<!DOCTYPE html><html lang="es"><body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;margin:24px 16px;padding:32px 24px;max-width:600px;"><tr><td>
${banner}<p style="margin:0;color:${C.muted};font-size:13px;">Resumen de visitas · ${esc(cap(period))}</p>
<p style="margin:2px 0 14px;color:${C.text};font-size:24px;font-weight:bold;">${esc(name)}</p>
<p style="margin:0 0 18px;color:${C.body};font-size:15px;line-height:1.5;">${intro}</p>
<table width="100%" cellpadding="0" cellspacing="0"><tr>
${kpiCell('Visitas', nf(rum.visits), dVisits)}${kpiCell('Páginas vistas', nf(rum.views), dViews)}${kpiCell('Páginas por visita', ppv ? ppv.toFixed(1).replace('.', ',') : '—', null)}
</tr></table>
${sections.join('\n')}
<p style="margin:28px 0 6px;color:${C.muted};font-size:12px;line-height:1.5;">${esc(note)}</p>
<p style="margin:0;color:${C.muted};font-size:12px;">${esc(foot)}</p>
${diag}
</td></tr></table></td></tr></table></body></html>`;

  const lines = [
    `${name} — resumen de visitas, ${period}`,
    '',
    rum.visits ? `Visitas: ${nf(rum.visits)} (${dVisits.text})` : 'No hay visitas registradas.',
    `Páginas vistas: ${nf(rum.views)} (${dViews.text})`,
    ppv ? `Páginas por visita: ${ppv.toFixed(1).replace('.', ',')}` : '',
    day ? `Día con más visitas: ${day}` : '',
  ];
  const list = (title, items, unit = '') => (items.length ? ['', title, ...items.map((i) => `  - ${i.label}: ${nf(i.value)}${unit}`)] : []);
  lines.push(...list('Páginas más visitadas', pages), ...list('De dónde llegan', sources), ...list('Webs que te envían visitantes', refHosts));
  lines.push(...list('Países', countries), ...list('Dispositivos', devices, ' %'), ...list('Documentos más descargados', files.map((f) => ({ label: f.name, value: f.downloads }))));
  lines.push('', note, foot);
  if (opts.testNote) lines.unshift(`[${opts.testNote}]`, '');

  return { subject: `${opts.testNote ? '[Prueba] ' : ''}Resumen de ${period} — ${name}`, text: lines.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n'), html };
}

function diagnosticsHtml(rum, d) {
  if (!d) return '';
  const row = (k, v) => `<tr><td style="padding:2px 12px 2px 0;color:#555;">${esc(k)}</td><td style="padding:2px 0;color:#222;" align="right">${esc(v)}</td></tr>`;
  const noise = d.noiseTop.map(([p, n]) => `${p} (${nf(n)})`).join(', ') || '—';
  return `<div style="margin:30px 0 0;padding:12px 14px;border:1px dashed #bbb;border-radius:6px;font-size:12px;color:#555;">
<strong>Solo prueba — contador (beacon) frente a peticiones crudas</strong>
<table cellpadding="0" cellspacing="0" style="margin:8px 0;font-size:12px;">
${row('Beacon: páginas vistas', nf(rum.views))}${row('Beacon: visitas', nf(rum.visits))}
${row('Crudas: peticiones totales (todo tipo)', nf(d.total) + (d.truncated ? '+' : ''))}
${row('Crudas: HTML 200 (incluye robots)', nf(d.html200))}
${row('Crudas: HTML 200 sin ruido', nf(d.html200Clean))}
</table>
<div>Ruido filtrado (top): ${esc(noise)}</div>
</div>`;
}

// ---------------------------------------------------------------------------
// Run (called from the daily cron)
// ---------------------------------------------------------------------------

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

async function readSlugs(env) {
  const obj = await env.CONTENT.get('slugs.json');
  if (!obj) return [];
  const parsed = JSON.parse(await obj.text());
  return (parsed.slugs || []).filter((s) => typeof s === 'string');
}

async function loadSite(env, slug) {
  let cfg = {};
  try {
    const obj = await env.CONTENT.get(`${slug}/config.json`);
    if (obj) cfg = JSON.parse(await obj.text());
  } catch (e) {
    console.error(`site-stats: ${slug} config.json unreadable:`, e?.message);
  }
  const title = cfg?.info?.title ?? cfg?.title ?? cfg?.site?.title ?? '';
  return { slug, title: typeof title === 'string' ? title : '', hosts: siteHostnames(cfg, slug) };
}

async function sendWithRetry(env, to, mail) {
  let r = await sendRegistrationEmail(env, to, mail);
  if (!r.ok && /429/.test(r.error || '')) {
    await sleep(1500); // Resend's default limit is 2 requests/second
    r = await sendRegistrationEmail(env, to, mail);
  }
  return r;
}

const dayOfYear = (now) => Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - Date.UTC(now.getUTCFullYear(), 0, 0)) / DAY);

export async function runStatsReport(env, now = new Date()) {
  const mode = String(env.STATS_REPORT_MODE || 'test').toLowerCase();
  if (mode === 'off') return { skipped: 'off' };
  if (!env.CF_ANALYTICS_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_ZONE_ID || !env.RESEND_API_KEY) {
    console.log('site-stats: CF_ANALYTICS_TOKEN / CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_ZONE_ID / RESEND_API_KEY not all set; nothing to do');
    return { skipped: 'not configured' };
  }
  const delay = env.STATS_SEND_DELAY_MS === undefined ? 600 : Number(env.STATS_SEND_DELAY_MS) || 0;
  const slugs = await readSlugs(env);
  if (!slugs.length) return { skipped: 'no sites' };

  if (mode === 'live') {
    if (now.getUTCDate() !== 1) return { skipped: 'not the 1st' };
    const state = await readAuthState(env);
    if (!state) throw new Error('auth state unavailable');
    const range = monthRange(now);
    const sites = [];
    for (const slug of slugs) sites.push(await loadSite(env, slug));
    const stats = await collectStats(env, sites, range);
    let sent = 0;
    let skipped = 0;
    for (const site of sites) {
      const to = mainEditor(state, site.slug);
      const data = stats.get(site.slug);
      // No beacon data at all (this or the previous month): the site probably has no beacon; a report of zeros would mislead.
      if (!to || !data?.rum || (!data.rum.views && !data.rum.prevViews)) {
        skipped++;
        continue;
      }
      const r = await sendWithRetry(env, to, buildReport(site, data, range));
      if (r.ok) sent++;
      else console.error(`site-stats: ${site.slug} email failed:`, r.error);
      await sleep(delay);
    }
    console.log(`site-stats: monthly reports sent=${sent} skipped=${skipped}`);
    return { sent, skipped };
  }

  // test mode: one site, last 30 days, to the developer only.
  const to = env.STATS_TEST_EMAIL;
  if (!to) return { skipped: 'STATS_TEST_EMAIL not set' };
  const slug = slugs.includes(env.STATS_TEST_SLUG) ? env.STATS_TEST_SLUG : slugs[dayOfYear(now) % slugs.length];
  const range = rollingRange(now, 30);
  const site = await loadSite(env, slug);
  try {
    const stats = await collectStats(env, [site], range, { diagnostics: true });
    const state = await readAuthState(env);
    const editor = mainEditor(state, slug);
    const note = `Modo prueba: informe de «${slug}» (${range.label}). En producción se enviaría el día 1 de cada mes al editor principal: ${editor || 'ninguno encontrado'}.`;
    const r = await sendWithRetry(env, to, buildReport(site, stats.get(slug), range, { testNote: note, diagnostics: true }));
    if (!r.ok) console.error('site-stats: test email failed:', r.error);
    return { sent: r.ok ? 1 : 0, slug };
  } catch (e) {
    console.error('site-stats: test report failed:', e);
    const msg = `No se pudo generar el informe de prueba de «${slug}»:\n\n${e?.message || e}`;
    await sendWithRetry(env, to, { subject: `[Prueba] Error generando el informe de ${slug}`, text: msg, html: `<pre style="font-family:monospace;white-space:pre-wrap;">${esc(msg)}</pre>` });
    return { sent: 0, slug, error: String(e?.message || e) };
  }
}
