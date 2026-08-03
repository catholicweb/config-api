/**
 * ⚠️⚠️⚠️ CRITICAL INTER-DEPENDENCY WARNING ⚠️⚠️⚠️
 *
 * This file's filename validation and API endpoints are DEPENDED UPON by:
 *   - editor/docs/.vitepress/theme/lib/codec.js (filename encoding)
 *   - editor/docs/.vitepress/theme/lib/api.js (API client)
 *   - web-template/docs/.vitepress/migrate.js (sync script)
 *
 * BEFORE making changes:
 * 1. Filename validation (FILENAME_RE, ALLOWED_EXT, validateFilename) MUST match codec.js and migrate.js
 * 2. API endpoints MUST be compatible with api.js and migrate.js
 * 3. R2 storage format MUST be compatible with migrate.js
 *
 * See ../CLAUDE.md for full dependency documentation.
 */

/**
 * parroquia-config-api
 *
 * Single R2 bucket (`parroquia`, bound as env.CONTENT). Everything lives in it:
 *
 *   auth.json                — top-level credential map: { "<sha256(token)>": "<slug>" }
 *   <slug>/.site             — per-slug existence marker (created on site creation)
 *   <slug>/<filename>        — a file, where <filename> is a validated human-readable name
 *
 * File keys are validated filenames (not opaque tokens). The client encodes local
 * paths to flat filenames by replacing / with - and sanitizing extensions. The
 * server validates filenames but NEVER interprets them as paths — they are used
 * verbatim as R2 keys. Security comes from the filename validation rules:
 *   - Base charset [A-Za-z0-9_-] (intentionally identical to base64url alphabet)
 *   - At most one trailing dot with an allowlisted extension
 *   - No leading hyphen (CLI arg injection guard)
 *   - Max 255 chars (filesystem limit)
 *
 * This makes path traversal, hidden files, and extension spoofing structurally
 * impossible through the filename rules themselves.
 *
 * READ (no auth):
 *   GET  /sites/list               — list all slugs (top-level "folders" in CONTENT)
 *   GET  /sites/:slug/list         — list all filenames under a slug
 *
 * SITE CREATION (gated by an admin secret — see authorizeAdmin):
 *   POST /sites/:slug               — create a site, mint a 256-bit editor token,
 *                                      store its SHA-256 in auth.json, return the token.
 *                                      Also provisions Cloudflare resources:
 *                                      - Creates a Pages project named {slug}
 *                                      - Creates a DNS CNAME record {slug}.parroquia.app
 *                                      - Attaches custom domain to the Pages project
 *                                      Rejects reserved slugs: api, editor, www, data
 *
 * WRITE (editor bearer token required):
 *   PUT    /sites/:slug/:filename   — overwrite a file (filename = validated human-readable name)
 *   DELETE /sites/:slug/:filename   — delete a file
 *
 * Two distinct capabilities:
 *   - ADMIN_TOKEN_HASH (Worker secret, never in the bucket): gates site creation.
 *     Set with `wrangler secret put ADMIN_TOKEN_HASH` (prod) or `.dev.vars` (local).
 *   - per-slug editor tokens (256-bit random, stored as SHA-256 in auth.json):
 *     gate writes AND reads for that slug only.
 *
 * Editor auth: the incoming bearer token is SHA-256 hashed and looked up in the
 * top-level `auth.json` object (`{ "<hash>": "<slug>" }`). The request is
 * authorized only if the hash exists AND its mapped slug equals the slug in the
 * URL path. Tokens are 256-bit random values, so their SHA-256 hashes are not
 * brute-forceable. The credential map lives at the bucket root; every content
 * key is `<slug>/<filename>` with a validated filename, so no content key can reach it.
 *
 * CRITICAL INVARIANT: the server must never interpret a filename as a path. It is
 * used verbatim as the R2 key. All path semantics live in the client. If a
 * future change interprets filenames server-side, the traversal safety evaporates.
 */

export default {
  async fetch(request, env) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Bad URL', { status: 400 });
    }

    const method = request.method.toUpperCase();

    // 2. INTERCEPT PREFLIGHT: This MUST return a 200 or 204 status!
    if (method === "OPTIONS") {
      return new Response(null, { status: 204   });
    }

    // Split path into segments, then percent-decode each. Decoding must
    // happen *before* validation so encoded traversal like %2e%2e is caught
    // (it decodes to a char outside the token charset and is rejected).
    const rawSegments = url.pathname.split('/').filter((p) => p.length > 0);
    const segments = [];
    for (const seg of rawSegments) {
      let decoded;
      try {
        decoded = decodeURIComponent(seg);
      } catch {
        return new Response('Bad path encoding', { status: 400 });
      }
      if (decoded.includes('/')) {
        // A decoded segment must not itself contain a separator — guards
        // against %2f smuggling an extra path component past the router.
        return new Response('Bad path', { status: 400 });
      }
      segments.push(decoded);
    }

    // ---- Health (confirms the binding responds) ----
    if (segments.length === 1 && segments[0] === 'health' && method === 'GET') {
      return handleHealth(env);
    }

    if (segments.length === 1 && segments[0] === 'whoami' && method === 'GET') {
      return whoami(env, request);
    }

    if (segments[0] !== 'sites') {
      return new Response('Not Found', { status: 404 });
    }

    // GET /sites/list
    if (method === 'GET' && segments.length === 2 && segments[1] === 'list') {
      return listSlugs(env);
    }

    // GET /sites/:slug/list
    if (method === 'GET' && segments.length === 3 && segments[2] === 'list') {
      const slug = segments[1];
      if (!validateSlug(slug)) return new Response('Invalid slug', { status: 400 });
      return listFiles(env, slug);
    }

    // POST /sites/:slug — create a site (gated by admin secret)
    if (method === 'POST' && segments.length === 2) {
      const slug = segments[1];
      if (!validateSlug(slug)) return new Response('Invalid slug', { status: 400 });
      if (!validateSlugNotReserved(slug)) {
        return Response.json({ ok: false, error: 'slug is reserved' }, { status: 400 });
      }

      const admin = await authorizeAdmin(env, request);
      if (!admin.ok) return Response.json({ error: admin.error }, { status: admin.status });

      return createSite(env, slug);
    }

    // PUT /sites/:slug/:token — write a file (editor-authed)
    if (method === 'PUT' && segments.length === 3) {
      const slug = segments[1];
      if (!validateSlug(slug)) return new Response('Invalid slug', { status: 400 });
      const token = segments[2];
      if (!validateToken(token)) return new Response('Invalid token', { status: 400 });

      const auth = await authorize(env, slug, request);
      if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

      return putFile(env, slug, token, request);
    }

    // DELETE /sites/:slug/:token — delete a file (editor-authed)
    if (method === 'DELETE' && segments.length === 3) {
      const slug = segments[1];
      if (!validateSlug(slug)) return new Response('Invalid slug', { status: 400 });
      const token = segments[2];
      if (!validateToken(token)) return new Response('Invalid token', { status: 400 });

      const auth = await authorize(env, slug, request);
      if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

      return deleteFile(env, slug, token);
    }

    return new Response('Not Found', { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Validation — the core of the path-traversal defense.
// ---------------------------------------------------------------------------

// Slug = single path segment, no dots/slashes, can't start with `_` or `-`.
// It selects the write-target prefix and is matched against auth.json's
// mapped slug, so it must be a bare identifier.
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// Slugs that must not be used as site names because they conflict with
// existing DNS records or planned service endpoints under parroquia.app.
const RESERVED_SLUGS = new Set(['api', 'editor', 'www', 'data']);

// Allowed file extensions for uploaded content. Only these extensions are
// permitted after the single trailing dot in a filename.
const ALLOWED_EXT = ['md', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'json'];

// Filename validation: base64url-compatible base name, plus one optional
// allowlisted extension. The base charset [A-Za-z0-9_-] is intentionally
// identical to the base64url alphabet for backward compatibility with existing
// tokens. Dots are only permitted as a single trailing extension separator.
// This makes path traversal (..), hidden files (.env), and extension spoofing
// (file.jpg.exe) structurally impossible.
const FILENAME_RE = /^[A-Za-z0-9_-]+(\.[a-z0-9]{1,5})?$/;

function validateFilename(filename) {
  if (!filename || typeof filename !== 'string') return false;
  if (filename.length > 255) return false;          // filesystem limit
  if (filename.startsWith('-')) return false;        // CLI arg injection guard
  if (!FILENAME_RE.test(filename)) return false;

  // Extension check (if present)
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex !== -1) {
    const ext = filename.slice(dotIndex + 1).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) return false;
  }
  return true;
}

function validateSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}

function validateToken(token) {
  return validateFilename(token);
}

function validateSlugNotReserved(slug) {
  return !RESERVED_SLUGS.has(slug.toLowerCase());
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function toHex(bytes) {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// Generate a 256-bit random editor token as 64 hex chars.
function generateToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function bearerToken(request) {
  const h =
    request.headers.get('Authorization') ||
    request.headers.get('authorization');
  if (!h) return null;
  const m = /^\s*Bearer\s+(.+?)\s*$/i.exec(h);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Auth — admin (site creation) and editor (file read/write)
// ---------------------------------------------------------------------------

/**
 * Admin gate for site creation. `env.ADMIN_TOKEN_HASH` is the SHA-256 hex of
 * the admin token, set as a Worker secret (never stored in the bucket).
 */
async function authorizeAdmin(env, request) {
  const token = bearerToken(request);
  if (!token) return { ok: false, status: 401, error: 'missing admin bearer token' };

  const adminHash = env.ADMIN_TOKEN_HASH;
  if (!adminHash) {
    return { ok: false, status: 503, error: 'site creation not configured (ADMIN_TOKEN_HASH not set)' };
  }
  const tokenHash = await sha256Hex(token);
  if (!timingSafeEqual(adminHash, tokenHash)) {
    return { ok: false, status: 403, error: 'invalid admin token' };
  }
  return { ok: true };
}

/**
 * Read and parse the top-level auth.json (`{ "<sha256(token)>": "<slug>" }`).
 * Returns null if absent or unreadable.
 */
async function readAuthMap(env) {
  const obj = await env.CONTENT.get('auth.json');
  if (!obj) return null;
  let text;
  try {
    text = await obj.text();
  } catch {
    return null;
  }
  try {
    const map = JSON.parse(text);
    if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
    return map;
  } catch {
    return null;
  }
}

/**
 * Authorize an editor request for `slug`. The bearer token is SHA-256 hashed
 * and must be present in auth.json AND mapped to this slug. Iterates all
 * entries (no early break) to avoid leaking which hash matched.
 */
async function authorize(env, slug, request) {
  const token = bearerToken(request);
  if (!token) return { ok: false, status: 401, error: 'missing bearer token' };

  const tokenHash = await sha256Hex(token);
  const map = await readAuthMap(env);
  if (!map) return { ok: false, status: 401, error: 'no auth configured' };

  let ok = false;
  for (const [hash, validSlug] of Object.entries(map)) {
    if (typeof hash === 'string' && timingSafeEqual(hash, tokenHash)) {
      if (validSlug === slug) ok = true;
    }
  }
  return ok
    ? { ok: true }
    : { ok: false, status: 403, error: 'token not valid for this slug' };
}

// slug-agnostic version of the same lookup authorize() does.
async function whoami(env, request) {
  const token = bearerToken(request);
  if (!token) return Response.json({ error: 'missing bearer token' }, { status: 401 });

  const tokenHash = await sha256Hex(token);
  const map = await readAuthMap(env);
  if (!map) return Response.json({ error: 'no auth configured' }, { status: 401 });

  let slug = null;
  for (const [hash, validSlug] of Object.entries(map)) {
    if (typeof hash === 'string' && timingSafeEqual(hash, tokenHash)) {
      slug = validSlug;
    }
  }
  if (!slug) return Response.json({ error: 'invalid token' }, { status: 403 });
  return Response.json({ slug });
}

// ---------------------------------------------------------------------------
// Cloudflare API helpers for site provisioning
// ---------------------------------------------------------------------------

/**
 * Make a Cloudflare API request. Reads CLOUDFLARE_API_TOKEN,
 * CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_ZONE_ID from env secrets.
 * Returns the parsed JSON response, or throws with a descriptive error.
 */
async function cfFetch(env, path, options = {}) {
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN not configured');
  const url = `https://api.cloudflare.com/client/v4${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const json = await res.json();
  return json;
}

/**
 * Ensure a Cloudflare Pages project named `slug` exists.
 * Creates it if missing; returns `{ ok, error? }`.
 */
async function ensurePagesProject(env, slug) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) return { ok: false, error: 'CLOUDFLARE_ACCOUNT_ID not configured' };

  // Try to create; if it already exists the API returns errors[0].code === 10016.
  const res = await cfFetch(env, `/accounts/${accountId}/pages/projects`, {
    method: 'POST',
    body: JSON.stringify({ name: slug, production_branch: 'main' }),
  });
  if (res.success) return { ok: true };
  const code = res.errors?.[0]?.code;
  if (code === 10016) return { ok: true }; // already exists
  return { ok: false, error: res.errors?.[0]?.message ?? 'failed to create Pages project' };
}

/**
 * Ensure a DNS CNAME record for `{slug}.parroquia.app` exists, pointing to
 * `{slug}.pages.dev`. Returns `{ ok, error? }`.
 */
async function ensureDnsRecord(env, slug) {
  const zoneId = env.CLOUDFLARE_ZONE_ID;
  if (!zoneId) return { ok: false, error: 'CLOUDFLARE_ZONE_ID not configured' };

  const name = `${slug}.parroquia.app`;
  const target = `${slug}.pages.dev`;

  // Check for existing record.
  const listed = await cfFetch(env, `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(name)}`);
  if (!listed.success) {
    return { ok: false, error: listed.errors?.[0]?.message ?? 'failed to list DNS records' };
  }
  if (listed.result.length > 0) return { ok: true };

  // Create record.
  const res = await cfFetch(env, `/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify({ type: 'CNAME', name, content: target, ttl: 1, proxied: true }),
  });
  if (res.success) return { ok: true };
  return { ok: false, error: res.errors?.[0]?.message ?? 'failed to create DNS record' };
}

/**
 * Ensure the custom domain `{slug}.parroquia.app` is attached to the Pages
 * project `slug`. Returns `{ ok, error? }`.
 */
async function ensureCustomDomain(env, slug) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) return { ok: false, error: 'CLOUDFLARE_ACCOUNT_ID not configured' };

  const name = `${slug}.parroquia.app`;
  const res = await cfFetch(env, `/accounts/${accountId}/pages/projects/${slug}/domains`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  if (res.success) return { ok: true };
  // 10006 = domain already attached
  if (res.errors?.[0]?.code === 10006) return { ok: true };
  return { ok: false, error: res.errors?.[0]?.message ?? 'failed to attach custom domain' };
}

// ---------------------------------------------------------------------------
// Site existence / creation
// ---------------------------------------------------------------------------

// Internal marker key created on site creation so the slug shows up in
// /sites/list (which is R2-prefix based) even before any content is written.
// It contains a `.` so it is outside the token charset and therefore can never
// be written or overwritten by a client (clients can only write tokens).
const SITE_MARKER = '.site';

/**
 * List all slugs by scanning the R2 bucket for top-level "folders".
 * Returns a bare `string[]` of slug names. This is the authoritative source;
 * both the GET /sites/list handler and the slugs.json writer use it.
 */
async function getSlugs(env) {
  const slugs = [];
  let cursor;
  do {
    const listed = await env.CONTENT.list({
      limit: 1000,
      cursor,
      delimiter: '/',
    });
    for (const prefix of listed.delimitedPrefixes) {
      slugs.push(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return slugs;
}

async function siteExists(env, slug) {
  if (await env.CONTENT.head(`${slug}/${SITE_MARKER}`)) return true;
  const listed = await env.CONTENT.list({ prefix: `${slug}/`, limit: 1 });
  if (listed.objects.length > 0) return true;
  const map = await readAuthMap(env);
  if (map && Object.values(map).includes(slug)) return true;
  return false;
}

/**
 * Create a site: provision Cloudflare resources (Pages project, DNS CNAME,
 * custom domain) and mint a 256-bit editor token, store its SHA-256 in
 * auth.json mapped to the slug, and write the existence marker. Returns the
 * token (shown once). Rejects if the slug already exists or if any
 * Cloudflare API step fails.
 *
 * NOTE: auth.json is read-modify-written, so concurrent creations can race
 * (last write wins, losing a hash). This API is meant for occasional admin
 * bootstrapping, not concurrent mass-creation.
 */
async function createSite(env, slug) {
  if (await siteExists(env, slug)) {
    return Response.json({ ok: false, error: 'slug already exists' }, { status: 409 });
  }

  // Provision Cloudflare resources. Each step is idempotent: it creates the
  // resource only if missing and returns ok if it already exists.
  try {
    const steps = [
      ['ensuring Cloudflare Pages project', () => ensurePagesProject(env, slug)],
      ['ensuring DNS CNAME record', () => ensureDnsRecord(env, slug)],
      ['attaching custom domain to Pages project', () => ensureCustomDomain(env, slug)],
    ];
    for (const [label, fn] of steps) {
      const result = await fn();
      if (!result.ok) {
        return Response.json(
          { ok: false, error: `failed ${label}: ${result.error}` },
          { status: 502 },
        );
      }
    }
  } catch (err) {
    return Response.json(
      { ok: false, error: `failed during Cloudflare provisioning: ${err.message}` },
      { status: 502 },
    );
  }

  const token = generateToken();
  const tokenHash = await sha256Hex(token);

  const map = (await readAuthMap(env)) || {};
  map[tokenHash] = slug;
  await env.CONTENT.put('auth.json', JSON.stringify(map), {
    httpMetadata: { contentType: 'application/json' },
  });

  await env.CONTENT.put(`${slug}/${SITE_MARKER}`, '{"ok":true}', {
    httpMetadata: { contentType: 'application/json' },
  });

  // Write the authoritative slugs.json at the bucket root (same shape as the
  // GET /sites/list response). We re-scan the bucket so the file is always
  // consistent with reality, not just an append of the current creation.
  const slugs = await getSlugs(env);
  await env.CONTENT.put('slugs.json', JSON.stringify({ slugs }), {
    httpMetadata: { contentType: 'application/json' },
  });

  return Response.json({ ok: true, slug, token }, { status: 201 });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleHealth(env) {
  const entry = { bound: !!env.CONTENT, responds: false };
  if (env.CONTENT) {
    try {
      const listed = await env.CONTENT.list({ limit: 1 });
      entry.responds = true;
      entry.objects = listed.objects.length;
    } catch (err) {
      entry.error = err?.message ?? String(err);
    }
  }
  const ok = entry.bound && entry.responds;
  return Response.json(
    { ok, bindings: { CONTENT: entry } },
    { status: ok ? 200 : 503 }
  );
}

async function listSlugs(env) {
  const slugs = await getSlugs(env);
  return Response.json({ slugs });
}

// Returns the list of file TOKENS under a slug (the key suffixes). migrate.js
// decodes each token back to a local path. The internal .site marker is skipped.
async function listFiles(env, slug) {
  const prefix = `${slug}/`;
  const files = [];
  let cursor;
  do {
    const listed = await env.CONTENT.list({ limit: 1000, cursor, prefix });
    for (const o of listed.objects) {
      const token = o.key.slice(prefix.length); // strip "<slug>/"
      if (token === SITE_MARKER) continue; // internal marker
      files.push(token);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return Response.json({ slug, files });
}

// Read one file by token (editor-authed). Token is used verbatim as the key;
// it is never decoded into a path.
async function readFile(env, slug, token, request) {
  const auth = await authorize(env, slug, request);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const key = `${slug}/${token}`;
  if (!key.startsWith(`${slug}/`)) {
    return new Response('Invalid path', { status: 400 });
  }
  const obj = await env.CONTENT.get(key);
  if (!obj) return new Response('Not Found', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers); // content-type etc. stored on the object
  return new Response(obj.body, { status: 200, headers });
}

// Write one file by token (editor-authed). Token is used verbatim as the key.
async function putFile(env, slug, token, request) {
  const key = `${slug}/${token}`;
  if (!key.startsWith(`${slug}/`)) {
    return new Response('Invalid path', { status: 400 });
  }
  const contentType =
    request.headers.get('Content-Type') || 'application/octet-stream';
  await env.CONTENT.put(key, request.body, {
    httpMetadata: { contentType },
  });
  return Response.json({ ok: true, slug, key }, { status: 200 });
}

// Delete one file by token (editor-authed). Token is used verbatim as the key.
async function deleteFile(env, slug, token) {
  const key = `${slug}/${token}`;
  if (!key.startsWith(`${slug}/`)) {
    return new Response('Invalid path', { status: 400 });
  }
  await env.CONTENT.delete(key);
  return Response.json({ ok: true, slug, key }, { status: 200 });
}
