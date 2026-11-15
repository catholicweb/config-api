/**
 * Request guards that sit IN FRONT of src/index.js.
 *
 * worker.js runs every request through `guardRequest` before it reaches the
 * base handler — including the requests the MCP tools forward internally — so
 * the hardening below applies to the REST API and to MCP alike. They live in
 * their own module on purpose: index.js is a large, cross-repo-contracted file
 * and these rules are policy, not routing.
 *
 *  1. Reserved slugs (site creation). Slugs become {slug}.parroquia.app, so
 *     names that look like infrastructure, mail or account pages are refused.
 *  2. DNS / Pages collision guard (site creation). createSite's
 *     ensureDnsRecord deletes ANY record already at {slug}.parroquia.app
 *     (MX, TXT, A...) before creating the CNAME, and ensurePagesProject treats
 *     "already exists" as success. Any editor can create sites, so we refuse a
 *     slug whose name is taken by something that is not one of our tenant
 *     records.
 *  3. Content-Type from the extension (file upload). The Content-Type stored in
 *     R2 is what data.parroquia.app serves. It is derived from the validated
 *     extension, never taken from the client, so a ".png" can't be served as
 *     text/html.
 */
import { validateSlug, validateToken, authorizeAdminOrEditorAny } from './index.js';

// ---- 1. reserved slugs ------------------------------------------------------

// Superset of index.js RESERVED_SLUGS (api, editor, www, data).
const RESERVED = new Set([
  'api', 'editor', 'www', 'data',
  // mail / DNS / infra names (Resend's return-path and DKIM live under these kinds of names)
  'mail', 'email', 'smtp', 'imap', 'pop', 'pop3', 'mx', 'ns', 'dns', 'ftp', 'sftp', 'ssh', 'vpn',
  'autodiscover', 'autoconfig', 'webmail', 'send', 'sending', 'resend', 'bounce', 'bounces', 'mailer',
  'cdn', 'static', 'assets', 'media', 'img', 'images', 'files', 'download', 'downloads', 'upload', 'uploads',
  // account / trust-sensitive names (phishing-friendly)
  'admin', 'administrator', 'root', 'system', 'staff', 'webmaster', 'postmaster', 'hostmaster', 'abuse',
  'security', 'support', 'help', 'info', 'contact', 'noreply', 'no-reply',
  'login', 'signin', 'sign-in', 'signup', 'register', 'auth', 'oauth', 'sso', 'account', 'accounts', 'secure',
  'billing', 'pay', 'payment', 'payments', 'checkout', 'status', 'dashboard', 'console',
  // product / environment names
  'app', 'apps', 'mcp', 'docs', 'dev', 'staging', 'stage', 'preview', 'beta',
  'plantilla', 'template', 'base', 'parroquia', 'parroquias', 'catholicweb',
  // brands that must not be impersonated
  'google', 'github', 'cloudflare', 'claude', 'anthropic',
]);

// Pattern families: punycode (homograph risk) and numbered infra names (ns1, mx2, em1234, smtp3...).
const RESERVED_PATTERNS = [/^xn--/, /^(?:ns|mx|smtp|imap|pop3?|mail|em|ftp)\d+$/];

export function isReservedSlug(slug) {
  return RESERVED.has(slug) || RESERVED_PATTERNS.some((re) => re.test(slug));
}

// ---- 2. DNS / Pages collision guard ----------------------------------------

const ZONE_DOMAIN = 'parroquia.app';
// A Pages project created this recently is assumed to be a half-finished creation
// by the same caller (createSite is idempotent and may be retried).
export const PAGES_RETRY_WINDOW_MS = 60 * 60 * 1000;

async function cf(env, path) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
  });
  let body = {};
  try { body = await res.json(); } catch { /* non-JSON error body */ }
  return { status: res.status, body };
}

const inUse = { ok: false, status: 409, error: 'slug is already in use' };
const unverifiable = { ok: false, status: 503, error: 'could not verify that the site name is free; try again later' };

/** Ok only if nothing at {slug}.parroquia.app except (at most) our own CNAME -> *.pages.dev. */
export async function checkDnsFree(env, slug) {
  // Not configured: let createSite report its own "not configured" error.
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ZONE_ID) return { ok: true };
  const name = `${slug}.${ZONE_DOMAIN}`;
  const { body } = await cf(env, `/zones/${env.CLOUDFLARE_ZONE_ID}/dns_records?name=${encodeURIComponent(name)}`);
  if (!body.success) return unverifiable;
  const foreign = (body.result || []).filter((r) => !(r.type === 'CNAME' && /\.pages\.dev\.?$/i.test(String(r.content))));
  return foreign.length ? inUse : { ok: true };
}

/** Ok only if there is no Pages project called `slug`, or it was created within the retry window. */
export async function checkPagesFree(env, slug, now = Date.now()) {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) return { ok: true };
  const { status, body } = await cf(env, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${encodeURIComponent(slug)}`);
  if (body.success) {
    const created = Date.parse(body.result?.created_on);
    return Number.isFinite(created) && now - created < PAGES_RETRY_WINDOW_MS ? { ok: true } : inUse;
  }
  const code = String(body.errors?.[0]?.code ?? '');
  return status === 404 || code.startsWith('8000') ? { ok: true } : unverifiable;
}

// ---- 3. Content-Type from extension ----------------------------------------

export const CONTENT_TYPES = {
  md: 'text/markdown; charset=utf-8',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  json: 'application/json; charset=utf-8',
};

export function contentTypeFor(filename) {
  const i = filename.lastIndexOf('.');
  const ext = i === -1 ? '' : filename.slice(i + 1).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

// ---- entry point -------------------------------------------------------------

/** Returns { response } to short-circuit, or { request } (possibly rewritten) to continue. */
export async function guardRequest(env, request) {
  const method = request.method.toUpperCase();
  if (method !== 'POST' && method !== 'PUT') return { request };

  let segs;
  try {
    segs = new URL(request.url).pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return { request }; // malformed path: the base handler rejects it
  }
  if (segs[0] !== 'sites') return { request };

  // PUT /sites/:slug/:file — force the stored Content-Type.
  if (method === 'PUT' && segs.length === 3 && validateToken(segs[2])) {
    const headers = new Headers(request.headers);
    headers.set('Content-Type', contentTypeFor(segs[2]));
    return { request: new Request(request, { headers }) };
  }

  // POST /sites/:slug — create a site.
  if (method === 'POST' && segs.length === 2 && segs[1] !== 'backfill-cache' && validateSlug(segs[1])) {
    const slug = segs[1];
    if (isReservedSlug(slug)) return { response: Response.json({ ok: false, error: 'slug is reserved' }, { status: 400 }) };

    // The Cloudflare lookups below only run for an authorized caller, so anonymous
    // traffic can never trigger API calls. Unauthorized requests fall through and
    // get the base handler's normal error.
    const auth = await authorizeAdminOrEditorAny(env, request);
    if (!auth.ok) return { request };
    // Existing site: the base handler answers 409 "slug already exists".
    if (await env.CONTENT.head(`${slug}/config.json`)) return { request };

    for (const check of [checkDnsFree, checkPagesFree]) {
      const r = await check(env, slug);
      if (!r.ok) return { response: Response.json({ ok: false, error: r.error }, { status: r.status }) };
    }
  }
  return { request };
}
