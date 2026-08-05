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
 * The authoritative contract (endpoints, token encoding, R2 layout, and the
 * consumer files that must stay in sync) is documented in ./README.md
 * (and at https://github.com/catholicweb/config-api/blob/main/README.md).
 * This file remains the authoritative source for runtime BEHAVIOR — if the
 * README and this file ever disagree, this file wins and the README must be
 * corrected. Do not change FILENAME_RE/ALLOWED_EXT/routes without updating
 * codec.js, api.js, and migrate.js.
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
 *   - Base charset [A-Za-z0-9_-] (the URL-safe filename alphabet)
 *   - At most one trailing dot with an allowlisted extension
 *   - No leading hyphen (CLI arg injection guard)
 *   - Max 255 chars (filesystem limit)
 *
 * This makes path traversal, hidden files, and extension spoofing structurally
 * impossible through the filename rules themselves.
 *
 * READ (no auth):
 *   GET  /sites                    — list all slugs (top-level "folders" in CONTENT)
 *   GET  /sites/:slug              — list all filenames under a slug
 *   Legacy aliases (kept for backward compatibility):
 *   GET  /sites/list               — same as GET /sites
 *   GET  /sites/:slug/list         — same as GET /sites/:slug
 *
 * SITE CREATION (gated by an admin secret — see authorizeAdmin):
 *   POST /sites/:slug               — create a site and kick off magic-link login for the
 *                                      site owner. Body: { "email": "<addr>" }. Provisions
 *                                      Cloudflare resources (Pages project, DNS CNAME
 *                                      {slug}.parroquia.app, custom domain), emails the owner
 *                                      a one-time magic link, and returns NO token. The owner
 *                                      clicks the link and exchanges the code for an editor
 *                                      token (see POST /auth/magic below).
 *                                      Rejects reserved slugs: api, editor, www, data
 *
 * EDITOR INVITE (gated by an admin secret — see authorizeAdmin):
 *   POST /sites/:slug/magic          — email an existing editor (by email) a magic link for an
 *                                       EXISTING slug, granting them edit capability. Body:
 *                                       { "email": "<addr>" }. No provisioning or creation.
 *
 * MAGIC-LINK LOGIN (no auth — possession of the one-time code from the email is the proof):
 *   POST /auth/magic                 — exchange a one-time magic code (from the emailed link)
 *                                       for a fresh 256-bit editor token. The code is stored
 *                                       only as its SHA-256 in magic.json, is single-use, and
 *                                       expires in 15 minutes; it is consumed (removed) here.
 *
 * WRITE (editor bearer token required):
 *   PUT    /sites/:slug/:filename   — overwrite a file (filename = validated human-readable name)
 *   DELETE /sites/:slug/:filename   — delete a file
 *
 * Two distinct capabilities:
 *   - ADMIN_TOKEN_HASH (Worker secret, never in the bucket): gates site creation.
 *     Set with `wrangler secret put ADMIN_TOKEN_HASH` (prod) or `.dev.vars` (local).
 *   - per-slug editor tokens (256-bit random, stored as SHA-256 in auth.json):
 *     gate writes AND reads for that slug only. Tokens are minted via the magic-link
 *     exchange (POST /auth/magic), not returned directly at site creation.
 *
 * MAGIC-LINK + EMAIL CAPABILITY STORE (all keyed-hashed — the bucket is PUBLIC,
 * so no secrets or plaintext emails ever live in it):
 *   magic.json   { "<sha256(code)>": { "slug", "emailHash", "exp" } }   pending one-time codes
 *   emails.json  { "<hmac-sha256(email)>": ["<slug>", ...] }            email→slug grants (keyed by EMAIL_HASH_SECRET)
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

    // POST /auth/magic — exchange a one-time magic code (from the emailed link)
    // for an editor token. No auth beyond possession of the code.
    if (segments.length === 2 && segments[0] === 'auth' && segments[1] === 'magic' && method === 'POST') {
      return exchangeMagic(env, request);
    }

    if (segments[0] !== 'sites') {
      return new Response('Not Found', { status: 404 });
    }

    // GET /sites — list all slugs
    if (method === 'GET' && segments.length === 1) {
      return listSlugs(env);
    }

    // GET /sites/:slug — list all filenames under a slug
    if (method === 'GET' && segments.length === 2) {
      // Legacy alias: GET /sites/list (was the old "list all slugs" route)
      if (segments[1] === 'list') return listSlugs(env);
      const slug = segments[1];
      if (!validateSlug(slug)) return new Response('Invalid slug', { status: 400 });
      return listFiles(env, slug);
    }

    // Legacy alias: GET /sites/:slug/list (was the old "list files" route)
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

      const body = await readJsonBody(request);
      if (!body.ok) return Response.json({ error: body.error }, { status: 400 });

      const email = body.data.email;
      if (!validateEmail(email)) {
        return Response.json({ error: 'a valid email is required' }, { status: 400 });
      }

      return createSite(env, slug, email);
    }

    // POST /sites/:slug/magic — issue a magic login link to an existing slug.
    // Open to all (no admin/editor required): issuing a link does not grant
    // access, which is still gated by the emails.json grant checked at authorize
    // after the code is redeemed.
    if (method === 'POST' && segments.length === 3 && segments[2] === 'magic') {
      return loginMagic(env, request, segments[1]);
    }

    // POST /sites/:slug/editors — grant an email editor access to an existing
    // slug and email them an invite/login link. Editor-gated: write permission
    // to the slug is enough to add new editor emails (they can already do
    // unbounded damage to the repo, so there is no bigger harm in letting them
    // onboard co-editors).
    if (method === 'POST' && segments.length === 3 && segments[2] === 'editors') {
      const slug = segments[1];
      if (!validateSlug(slug)) return new Response('Invalid slug', { status: 400 });

      const auth = await authorize(env, slug, request);
      if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

      return addEditor(env, request, slug);
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

// Filename validation: a URL-safe base name, plus one optional allowlisted
// extension. The base charset [A-Za-z0-9_-] is used for backward compatibility
// with existing tokens. Dots are only permitted as a single trailing extension
// separator.
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

// A minimal, intentionally permissive email shape check. The address is only
// used to deliver a magic link; exact spec-compliance is the mail provider's job.
function validateEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Canonical form used as the emails.json key hash (trim + lowercase) so the same
// address always maps to one entry regardless of case/whitespace.
function normalizeEmail(email) {
  return email.trim().toLowerCase();
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

// Keyed HMAC-SHA256 of a value. Used to hash email addresses for emails.json:
// the bucket is public, and a *plain* sha256 of an email is trivially
// brute-forceable (small input space). Keying with EMAIL_HASH_SECRET makes the
// stored digests un-reversible without the secret.
async function hmacSha256Hex(secret, text) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return toHex(new Uint8Array(sig));
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

// Parse a JSON request body. Returns { ok:true, data } or { ok:false, error }.
async function readJsonBody(request) {
  let text;
  try {
    text = await request.text();
  } catch {
    return { ok: false, error: 'unreadable body' };
  }
  if (!text) return { ok: false, error: 'missing JSON body' };
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, error: 'invalid JSON body' };
  }
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
 * Read and parse a top-level JSON object store (auth.json, magic.json,
 * emails.json). Returns null if absent, unreadable, or not a plain object.
 */
async function readJsonMap(env, key) {
  const obj = await env.CONTENT.get(key);
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

// Write a top-level JSON object store back to R2.
async function writeJsonMap(env, key, map) {
  await env.CONTENT.put(key, JSON.stringify(map), {
    httpMetadata: { contentType: 'application/json' },
  });
}

/**
 * Read and parse the top-level auth.json (`{ "<sha256(token)>": "<slug>" }`).
 * Returns null if absent or unreadable.
 */
async function readAuthMap(env) {
  return readJsonMap(env, 'auth.json');
}

/**
 * Authorize an editor request for `slug`. The bearer token is SHA-256 hashed
 * and must be present in auth.json, mapped to this slug, AND (for email-bound
 * tokens) have its email listed in the slug's emails.json grant. Iterates all
 * entries (no early break) to avoid leaking which hash matched.
 *
 * Legacy auth.json entries (plain `tokenHash → "slug"` strings, minted before
 * tokens were bound to an email) are grandfathered: they pass the plain slug
 * check with no email requirement. They only lose that status once the holder
 * re-logs in via magic and gets an email-bound token.
 */
async function authorize(env, slug, request) {
  const token = bearerToken(request);
  if (!token) return { ok: false, status: 401, error: 'missing bearer token' };

  const tokenHash = await sha256Hex(token);
  const map = await readAuthMap(env);
  if (!map) return { ok: false, status: 401, error: 'no auth configured' };

  let entry = null;
  for (const [hash, value] of Object.entries(map)) {
    if (typeof hash === 'string' && timingSafeEqual(hash, tokenHash)) {
      entry = value;
    }
  }
  if (entry == null) {
    return { ok: false, status: 403, error: 'token not valid for this slug' };
  }

  // Legacy string entry (token → slug, no bound email): keep the old behavior.
  if (typeof entry === 'string') {
    return entry === slug
      ? { ok: true }
      : { ok: false, status: 403, error: 'token not valid for this slug' };
  }

  // Email-bound entry: { slug, emailHash }.
  if (!entry || entry.slug !== slug) {
    return { ok: false, status: 403, error: 'token not valid for this slug' };
  }
  if (!entry.emailHash) {
    return { ok: false, status: 403, error: 'token has no bound email' };
  }

  const grants = await readJsonMap(env, 'emails.json');
  const list = grants && Array.isArray(grants[entry.emailHash])
    ? grants[entry.emailHash]
    : [];
  if (!list.includes(slug)) {
    return { ok: false, status: 403, error: 'email not authorized for this slug' };
  }
  return { ok: true };
}

// slug-agnostic version of the same lookup authorize() does.
async function whoami(env, request) {
  const token = bearerToken(request);
  if (!token) return Response.json({ error: 'missing bearer token' }, { status: 401 });

  const tokenHash = await sha256Hex(token);
  const map = await readAuthMap(env);
  if (!map) return Response.json({ error: 'no auth configured' }, { status: 401 });

  let slug = null;
  for (const [hash, value] of Object.entries(map)) {
    if (typeof hash === 'string' && timingSafeEqual(hash, tokenHash)) {
      // New entries are { slug, emailHash }; legacy entries are plain strings.
      slug = typeof value === 'string' ? value : (value && value.slug) || null;
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

// Lifespan of a pending magic link (one-time code) before it expires and can no
// longer be exchanged for an editor token.
const MAGIC_TTL_MS = 15 * 60 * 1000;

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
 * Register an email → slug edit-capability grant in emails.json
 * (`{ "<hmac-sha256(email)>": ["<slug>", ...] }`). Appends the slug to the
 * email's list (deduped) so one email can own multiple sites.
 */
async function addEmailGrant(env, emailHash, slug) {
  const grants = (await readJsonMap(env, 'emails.json')) || {};
  const list = grants[emailHash] || [];
  if (!list.includes(slug)) list.push(slug);
  grants[emailHash] = list;
  await writeJsonMap(env, 'emails.json', grants);
}

/**
 * Create a site and kick off magic-link login for the site owner.
 *
 * Provisions Cloudflare resources (Pages project, DNS CNAME, custom domain) —
 * idempotent, unchanged from before — then seeds the site: copies the root
 * config.json template into <slug>/config.json, grants the owner edit access in
 * emails.json, and emails them a magic login link instead of returning a token.
 * The email only arrives after provisioning succeeds; if delivery fails, the
 * just-created magic record is rolled back so a retry of this POST is clean
 * (the slug has no marker yet and is not yet listed).
 *
 * NOTE: magic.json / emails.json are read-modify-written, so concurrent
 * creations can race (last write wins). This API is meant for occasional admin
 * bootstrapping, not concurrent mass-creation.
 */
async function createSite(env, slug, email) {
  if (!env.RESEND_API_KEY) {
    return Response.json(
      { ok: false, error: 'magic-link email not configured (RESEND_API_KEY not set)' },
      { status: 503 },
    );
  }
  if (!env.EMAIL_HASH_SECRET) {
    return Response.json(
      { ok: false, error: 'magic-link signing key not configured (EMAIL_HASH_SECRET not set)' },
      { status: 503 },
    );
  }
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

  // Seed the site's config.json from the root template. This is the default
  // content the site starts with; the editor then edits it as any other file.
  // The template lives at the bucket root (a separate key from each site's
  // <slug>/config.json), so it is never served under a slug prefix.
  const template = await env.CONTENT.get('config.json');
  if (!template) {
    return Response.json(
      { ok: false, error: 'site template config.json not configured at bucket root' },
      { status: 503 },
    );
  }
  const templateText = await template.text();
  await env.CONTENT.put(`${slug}/config.json`, templateText, {
    httpMetadata: { contentType: 'application/json' },
  });

  // Grant the owner editor access (emails.json is the private, enforced
  // allowlist) and email them their first login link. Nothing secret is stored
  // in the (public) bucket.
  const emailHash = await hmacSha256Hex(env.EMAIL_HASH_SECRET, normalizeEmail(email));
  await addEmailGrant(env, emailHash, slug);

  const issued = await issueMagicLink(env, slug, email);
  if (!issued.ok) {
    return Response.json({ ok: false, error: issued.error }, { status: issued.status });
  }

  await env.CONTENT.put(`${slug}/${SITE_MARKER}`, '{"ok":true}', {
    httpMetadata: { contentType: 'application/json' },
  });

  // Write the authoritative slugs.json at the bucket root (same shape as the
  // GET /sites/list response). We re-scan the bucket so the file is always
  // consistent with reality, not just an append of the current creation.
  const slugs = await getSlugs(env);
  await writeJsonMap(env, 'slugs.json', { slugs });

  return Response.json({ ok: true, slug, sent: true, email }, { status: 201 });
}

/**
 * Mint a one-time magic code for `slug` and email the login link to `email`.
 * This ONLY issues a login link — it does NOT grant the address access. Whether
 * the redeemed token can write is decided later by `authorize` against the
 * emails.json grant, which is seeded by `createSite` and added via
 * `POST /sites/:slug/editors`. Returns { ok:true } or { ok:false, status, error }.
 *
 * The code is stored only as its SHA-256 (the bucket is public); it is
 * single-use and expires after MAGIC_TTL_MS. If email delivery fails, the
 * pending magic record is rolled back so the caller can stay retryable.
 */
async function issueMagicLink(env, slug, email) {
  if (!env.RESEND_API_KEY) {
    return { ok: false, status: 503, error: 'magic-link email not configured (RESEND_API_KEY not set)' };
  }
  if (!env.EMAIL_HASH_SECRET) {
    return { ok: false, status: 503, error: 'magic-link signing key not configured (EMAIL_HASH_SECRET not set)' };
  }

  const code = generateToken();
  const codeHash = await sha256Hex(code);
  const emailHash = await hmacSha256Hex(env.EMAIL_HASH_SECRET, normalizeEmail(email));
  const exp = Date.now() + MAGIC_TTL_MS;

  const magic = (await readJsonMap(env, 'magic.json')) || {};
  magic[codeHash] = { slug, emailHash, exp };
  await writeJsonMap(env, 'magic.json', magic);

  const sent = await sendMagicLinkEmail(env, email, slug, code);
  if (!sent.ok) {
    // Roll back the pending magic record so the caller stays retryable.
    delete magic[codeHash];
    await writeJsonMap(env, 'magic.json', magic);
    return { ok: false, status: 502, error: `failed to send magic-link email: ${sent.error}` };
  }

  return { ok: true };
}

/**
 * POST /sites/:slug/magic — email a one-time magic login link to `email` for an
 * EXISTING slug. Open to all: this only issues a login link and does NOT grant
 * access. The address must already be in the slug's emails.json allowlist for
 * the redeemed token to actually be able to write. No Cloudflare provisioning
 * or slug creation happens here.
 */
async function loginMagic(env, request, slug) {
  if (!validateSlug(slug)) return Response.json({ error: 'invalid slug' }, { status: 400 });
  if (!(await siteExists(env, slug))) {
    return Response.json({ error: 'slug not found' }, { status: 404 });
  }

  const body = await readJsonBody(request);
  if (!body.ok) return Response.json({ error: body.error }, { status: 400 });
  const email = body.data.email;
  if (!validateEmail(email)) {
    return Response.json({ error: 'a valid email is required' }, { status: 400 });
  }

  const issued = await issueMagicLink(env, slug, email);
  if (!issued.ok) {
    return Response.json({ ok: false, error: issued.error }, { status: issued.status });
  }
  return Response.json({ ok: true, slug, sent: true, email }, { status: 200 });
}

/**
 * POST /sites/:slug/editors — grant `email` edit access to an EXISTING slug and
 * email them an invite/login link. Editor-gated (the router authorizes first):
 * write permission to the slug is enough to add new co-editors, since a writer
 * can already do unbounded damage to the repo. The grant is recorded privately
 * in emails.json (HMAC-keyed, bucket root — never served publicly) rather than
 * in the public config.json, so editor emails stay out of the public data host.
 */
async function addEditor(env, request, slug) {
  if (!(await siteExists(env, slug))) {
    return Response.json({ error: 'slug not found' }, { status: 404 });
  }

  const body = await readJsonBody(request);
  if (!body.ok) return Response.json({ error: body.error }, { status: 400 });
  const email = body.data.email;
  if (!validateEmail(email)) {
    return Response.json({ error: 'a valid email is required' }, { status: 400 });
  }

  const emailHash = await hmacSha256Hex(env.EMAIL_HASH_SECRET, normalizeEmail(email));
  await addEmailGrant(env, emailHash, slug);

  const issued = await issueMagicLink(env, slug, email);
  if (!issued.ok) {
    return Response.json({ ok: false, error: issued.error }, { status: issued.status });
  }
  return Response.json({ ok: true, slug, sent: true, email }, { status: 200 });
}

/**
 * Send the magic-link email via Resend's JSON API. The link points at the
 * editor's magic-link landing page (MAGIC_LINK_BASE, default
 * https://editor.parroquia.app/magic), carrying the slug for display and the
 * one-time code. Returns { ok:true } or { ok:false, error }.
 */
async function sendMagicLinkEmail(env, email, slug, code) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: 'RESEND_API_KEY not configured' };

  const from = env.FROM_EMAIL || 'no-reply@parroquia.app';
  const base = (env.MAGIC_LINK_BASE || 'https://editor.parroquia.app/magic').replace(/\/$/, '');
  const link = `${base}?slug=${encodeURIComponent(slug)}&code=${encodeURIComponent(code)}`;

  // Worker logs are not public — this makes the code clickable during local dev.
  console.log(`[magic-link] slug=${slug} to=${email} link=${link}`);

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: email,
        subject: `Tu enlace de acceso a ${slug}`,
        text: `Pulsa este enlace para entrar en el editor de ${slug} (válido durante unos minutos y de un solo uso):\n\n${link}`,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `Resend ${res.status}: ${text}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Magic-link exchange
// ---------------------------------------------------------------------------

/**
 * POST /auth/magic — exchange a one-time magic code for a fresh editor token.
 * Proves possession of the emailed link (the code is single-use and expires).
 *
 * Reads magic.json, finds the code by its SHA-256, checks expiry, then mints a
 * 256-bit editor token (sha256 stored in auth.json → { slug, emailHash }, where
 * emailHash is the grant keyed identity of the person who redeemed the link),
 * removes the code from magic.json (one-time invalidation), and returns the
 * token once.
 */
async function exchangeMagic(env, request) {
  const body = await readJsonBody(request);
  if (!body.ok) return Response.json({ error: body.error }, { status: 400 });

  const code = body.data.code;
  if (typeof code !== 'string' || !validateToken(code)) {
    return Response.json({ error: 'a valid magic code is required' }, { status: 400 });
  }

  const codeHash = await sha256Hex(code);
  const magic = await readJsonMap(env, 'magic.json');
  if (!magic) return Response.json({ error: 'no magic link configured' }, { status: 404 });

  const record = magic[codeHash];
  if (!record) return Response.json({ error: 'invalid or already-used magic code' }, { status: 404 });

  if (typeof record.exp === 'number' && record.exp < Date.now()) {
    // Expired: consume it and refuse.
    delete magic[codeHash];
    await writeJsonMap(env, 'magic.json', magic);
    return Response.json({ error: 'magic code expired' }, { status: 410 });
  }

  const slug = record.slug;

  // Consume the code first so it cannot be reused, then mint the editor token.
  delete magic[codeHash];
  await writeJsonMap(env, 'magic.json', magic);

  const token = generateToken();
  const tokenHash = await sha256Hex(token);

  const map = (await readAuthMap(env)) || {};
  map[tokenHash] = { slug, emailHash: record.emailHash };
  await writeJsonMap(env, 'auth.json', map);

  return Response.json({ ok: true, slug, token }, { status: 200 });
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
