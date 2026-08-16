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

// Mirrored byte-for-byte with editor/docs/.vitepress/theme/lib/patch.js
// (could be regarded as a part of the same inter-dependency contract):
// applyPatch applies the editor's diff ops onto the stored doc.
import { applyPatch } from './patch.js';

/**
 * parroquia-config-api
 *
 * Single R2 bucket (`parroquia`, bound as env.CONTENT). Everything lives in it:
 *
 *   auth.enc                 — ALL credential state in one AES-GCM-256 encrypted blob
 *                              ({ emails, tokens, magic }; encrypted under AUTH_KEY)
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
 * SITE REPROVISION (gated by admin secret — see authorizeAdmin):
 *   POST /sites/:slug/reprovision      — re-run Cloudflare provisioning (Pages project, DNS
 *                                      record, custom domain) + dispatch a build for an EXISTING
 *                                      site, to repair a custom domain that isn't serving (e.g.
 *                                      Cloudflare Error 1014 when {slug}.pages.dev has no active
 *                                      production deployment). Does not email anyone; returns
 *                                      the current custom-domain status.
 *
 * MAGIC-LINK LOGIN (no auth — possession of the one-time code from the email is the proof):
 *   POST /auth/magic                 — exchange a one-time magic code (from the emailed link)
 *                                       for a fresh 256-bit editor token. The code lives in the
 *                                       encrypted state (keyed by its SHA-256), is single-use,
 *                                       and expires in 15 minutes; it is consumed (removed) here.
 *   POST /auth/request               — email a one-time magic login link to every slug the
 *                                       `email` address can edit (resolved server-side from the
 *                                       encrypted email allowlist, so the editor can offer an
 *                                       email-only login). Body: { "email": "<addr>" }. Never
 *                                       grants access; returns a generic success either way.
 *
 * WRITE (admin OR editor bearer token required):
 *   PUT    /sites/:slug/:filename   — overwrite a file (filename = validated human-readable name)
 *   DELETE /sites/:slug/:filename   — delete a file
 *
 * EDITOR MANAGEMENT (editor bearer token for THIS slug only):
 *   GET    /sites/:slug/editors     — list the emails granted write access to the slug
 *   POST   /sites/:slug/editors     — grant an email co-editor access + email an invite link
 *   PATCH  /sites/:slug/editors     — change an editor's email address (body { from, to })
 *   DELETE /sites/:slug/editors     — remove an editor + revoke their slug tokens (body { email })
 *
 * Two distinct capabilities:
 *   - ADMIN_TOKEN_HASH (Worker secret, never in the bucket): authenticates as admin.
 *     Set with `wrangler secret put ADMIN_TOKEN_HASH` (prod) or `.dev.vars` (local).
 *   - editor tokens (256-bit random, stored as SHA-256 in the encrypted state):
 *     authorize writes to ANY slug the bound email is granted on (multisession,
 *     one token per email across all its slugs). Tokens are minted via the
 *     magic-link exchange (POST /auth/magic), not returned directly at site
 *     creation.
 *
 * Site creation (POST /sites/:slug) accepts EITHER capability: the admin secret, or
 * an editor token valid for any slug the caller can edit (authorizeAdminOrEditorAny).
 * It is the only endpoint whose "editor" check is slug-agnostic — the new slug
 * doesn't exist yet, so the caller's own bound slug stands in for it.
 *
 * SINGLE ENCRYPTED CREDENTIAL STORE (the bucket is PUBLIC, but all credential data
 * is encrypted at rest in one blob, so it is never readable without AUTH_KEY):
 *   auth.enc   { v, iv, ct } → plaintext { "emails": { "<email>": ["<slug>",...] },
 *                                          "tokens": { "<sha256(token)>": { slug, email } },
 *                                          "magic":  { "<sha256(code)>":   { slug, email, exp } } }
 *
 * Emails are stored recoverable (plaintext inside the blob) so the worker can
 * list/remove/rename editors — they are NOT HMAC digests anymore. Tokens and
 * magic codes stay keyed by SHA-256 for defense in depth. Editor tokens bind to
 * a plaintext email; a token whose `email` is null (retained defensively) is
 * authorized for its slug without an allowlist check, but cannot be
 * listed/removed/renamed by the editor endpoints. There is no legacy migration:
 * auth.enc is created lazily on the first write and reads of a missing auth.enc
 * return an empty state.
 *
 * Editor auth: the incoming bearer token is SHA-256 hashed and looked up directly
 * in the decrypted `state.tokens`. The request is authorized only if the entry
 * exists AND the email bound to the token is in the URL slug's grant list
 * (multisession — one token covers every slug that email can edit; the token's own
 * `slug` field is deliberately not consulted). Tokens are 256-bit random values,
 * so their SHA-256 hashes are not brute-forceable.
 *
 * CRITICAL INVARIANT: the server must never interpret a filename as a path. It is
 * used verbatim as the R2 key. All path semantics live in the client. If a
 * future change interprets filenames server-side, the traversal safety evaporates.
 */

export default {
  async fetch(request, env, ctx) {
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

    // Wrap the whole dispatch so an unexpected exception surfaces as a readable
    // 500 JSON instead of Cloudflare's bare error 1101 (uncaught Worker throw).
    try {
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

    // POST /auth/request — email a magic login link to every site the address
    // already has edit access to. Open to all: it only issues links and never
    // grants access. The slug is resolved server-side from the email grant, so
    // the editor can offer an email-only login screen.
    if (segments.length === 2 && segments[0] === 'auth' && segments[1] === 'request' && method === 'POST') {
      return requestMagicLink(env, request);
    }

    if (segments[0] !== 'sites') {
      return new Response('Not Found', { status: 404 });
    }

    // POST /sites/backfill-cache — admin-gated maintenance: re-stamp
    // Cache-Control onto every existing bucket object so data.parroquia.app serves
    // them cacheable. Must match BEFORE the generic POST /sites/:slug (createSite)
    // below, which would otherwise treat 'backfill-cache' as a slug to create.
    if (method === 'POST' && segments.length === 2 && segments[1] === 'backfill-cache') {
      const admin = await authorizeAdmin(env, request);
      if (!admin.ok) return Response.json({ error: admin.error }, { status: admin.status });
      return backfillCache(env);
    }

    // POST /sites/:slug/reprovision — admin-gated maintenance: re-run Cloudflare
    // provisioning (Pages project, DNS record, custom domain) + dispatch a build
    // for an EXISTING site, to repair a custom domain that isn't serving (e.g.
    // Cloudflare Error 1014). Must match BEFORE the generic create route below.
    if (method === 'POST' && segments.length === 3 && segments[2] === 'reprovision') {
      const slug = segments[1];
      if (!validateSlug(slug)) return new Response('Invalid slug', { status: 400 });
      const admin = await authorizeAdmin(env, request);
      if (!admin.ok) return Response.json({ error: admin.error }, { status: admin.status });
      return reprovisionSite(ctx, env, slug);
    }

    // POST /sites/:slug/clone — admin-gated: clone all content from source
    // slug to a target slug (new slug). Copies R2 objects (rewriting config.json
    // media URLs), copies email grants in auth.enc, provisions Cloudflare for
    // targetSlug, dispatches a build. Does NOT modify the source slug.
    if (method === 'POST' && segments.length === 3 && segments[2] === 'clone') {
      const slug = segments[1];
      if (!validateSlug(slug)) return new Response('Invalid slug', { status: 400 });
      const admin = await authorizeAdmin(env, request);
      if (!admin.ok) return Response.json({ error: admin.error }, { status: admin.status });
      return cloneSite(ctx, env, slug, request);
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

    // POST /sites/:slug — create a site (gated by admin secret OR any editor token)
    if (method === 'POST' && segments.length === 2) {
      const slug = segments[1];
      if (!validateSlug(slug)) return new Response('Invalid slug', { status: 400 });
      if (!validateSlugNotReserved(slug)) {
        return Response.json({ ok: false, error: 'slug is reserved' }, { status: 400 });
      }

      const auth = await authorizeAdminOrEditorAny(env, request);
      if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

      const body = await readJsonBody(request);
      if (!body.ok) return Response.json({ error: body.error }, { status: 400 });

      const email = body.data.email;
      if (!validateEmail(email)) {
        return Response.json({ error: 'a valid email is required' }, { status: 400 });
      }

      return createSite(ctx, env, slug, email);
    }

    // POST /sites/:slug/editors — grant an email editor access to an existing
    // slug and email them an invite/login link. Editor-gated: write permission
    // to the slug is enough to add new editor emails (they can already do
    // unbounded damage to the repo, so there is no bigger harm in letting them
    // onboard co-editors).
    if (method === 'POST' && segments.length === 3 && segments[2] === 'editors') {
      const slug = segments[1];
      if (!validateSlug(slug)) return new Response('Invalid slug', { status: 400 });

      const auth = await authorizeAdminOrEditor(env, slug, request);
      if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

      return addEditor(env, request, slug);
    }

    // Editor management (all editor-gated to THIS slug only). These must match
    // BEFORE the generic /sites/:slug/:token handlers below (otherwise 'editors'
    // — a legal filename token — would be treated as a file to write/delete).
    if (method === 'GET' && segments.length === 3 && segments[2] === 'editors') {
      const slug = segments[1];
      if (!validateSlug(slug)) return new Response('Invalid slug', { status: 400 });

      const auth = await authorizeAdminOrEditor(env, slug, request);
      if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

      return listEditors(env, slug);
    }
    if (method === 'DELETE' && segments.length === 3 && segments[2] === 'editors') {
      const slug = segments[1];
      if (!validateSlug(slug)) return new Response('Invalid slug', { status: 400 });

      const auth = await authorizeAdminOrEditor(env, slug, request);
      if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

      return removeEditor(env, request, slug);
    }
    if (method === 'PATCH' && segments.length === 3 && segments[2] === 'editors') {
      const slug = segments[1];
      if (!validateSlug(slug)) return new Response('Invalid slug', { status: 400 });

      const auth = await authorizeAdminOrEditor(env, slug, request);
      if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

      return updateEditor(env, request, slug);
    }

    // DELETE /sites/:slug — admin-gated: delete a site entirely. Best-effort
    // Cloudflare resource cleanup, then delete all R2 content under the slug,
    // clean up auth.enc grants/tokens/magic, and re-scan slugs.json.
    if (method === 'DELETE' && segments.length === 2) {
      const slug = segments[1];
      if (!validateSlug(slug)) return new Response('Invalid slug', { status: 400 });
      const admin = await authorizeAdmin(env, request);
      if (!admin.ok) return Response.json({ error: admin.error }, { status: admin.status });
      return deleteSite(ctx, env, slug);
    }

    // PATCH /sites/:slug/config.json — apply a small diff to config.json
    // (editor-authed). Scoped to config.json, the only file the editor edits
    // concurrently; a full PUT of config.json still works as before.
    if (method === 'PATCH' && segments.length === 3 && segments[2] === 'config.json') {
      const slug = segments[1];
      if (!validateSlug(slug)) return new Response('Invalid slug', { status: 400 });

      const auth = await authorize(env, slug, request);
      if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

      return patchConfigFile(ctx, env, slug, request);
    }

    // PUT /sites/:slug/:token — write a file (admin or editor)
    if (method === 'PUT' && segments.length === 3) {
      const slug = segments[1];
      if (!validateSlug(slug)) return new Response('Invalid slug', { status: 400 });
      const token = segments[2];
      if (!validateToken(token)) return new Response('Invalid token', { status: 400 });

      const auth = await authorizeAdminOrEditor(env, slug, request);
      if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

      return putFile(ctx, env, slug, token, request);
    }

    // DELETE /sites/:slug/:token — delete a file (admin OR editor, matching PUT)
    if (method === 'DELETE' && segments.length === 3) {
      const slug = segments[1];
      if (!validateSlug(slug)) return new Response('Invalid slug', { status: 400 });
      const token = segments[2];
      if (!validateToken(token)) return new Response('Invalid token', { status: 400 });

      const auth = await authorizeAdminOrEditor(env, slug, request);
      if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

      return deleteFile(env, slug, token);
    }

    return new Response('Not Found', { status: 404 });
    } catch (err) {
      // Log for the operator; never echo internals (paths, messages, secrets) to
      // the caller — that is exactly the detail an attacker probes with.
      console.error('unhandled worker error:', err);
      return Response.json({ error: 'internal error' }, { status: 500 });
    }
  },
};

// ---------------------------------------------------------------------------
// Validation — the core of the path-traversal defense.
// ---------------------------------------------------------------------------

// Slug = single path segment, no dots/slashes, can't start with `_` or `-`.
// It selects the write-target prefix and is matched against auth.json's
// mapped slug, so it must be a bare identifier.
// Slugs become subdomains ({slug}.parroquia.app): DNS is case-insensitive and
// hostnames cannot contain `_`, so only lowercase alnum + internal hyphens are
// allowed (no leading/trailing hyphen, 1-63 chars). This is a strict subset of the
// deploy workflow's slug check and prevents URL-equivalent subdomain collisions.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

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
  return !RESERVED_SLUGS.has(slug);
}

// Public origin that serves file bytes (no auth) at /:slug/:token — the home of
// every media URL we hand out. Configurable via the DATA_BASE [vars] entry
// (default https://data.parroquia.app); the worker is never queried on this host,
// so it cannot be derived from request.url.
function dataBase(env) {
  return (env.DATA_BASE || "https://data.parroquia.app").replace(/\/$/, "");
}

// Absolute public URL for one file: https://data.parroquia.app/<slug>/<token>.
// This is the single representation returned for media/list results.
function fileUrl(env, slug, token) {
  return `${dataBase(env)}/${slug}/${encodeURIComponent(token)}`;
}

// A minimal, intentionally permissive email shape check. The address is only
// used to deliver a magic link; exact spec-compliance is the mail provider's job.
function validateEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Canonical form used as the state.emails key (trim + lowercase) so the same
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

// Base64 codecs for binary <-> string. Workers exposes global btoa/atob, which
// operate on binary strings, so wrap Uint8Array. Enough for the 12-byte IV and
// the small ciphertexts produced by AES-GCM here; no chunking needed.
function bytesToBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
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
// Encrypted auth state — one AES-GCM-256 blob (auth.enc) at the bucket root
// ---------------------------------------------------------------------------
//
// All credential state (emails allowlist, editor tokens, pending magic codes)
// lives in a SINGLE encrypted object instead of three public plaintext JSON
// files. Emails are recoverable (they sit in plaintext inside the encrypted
// blob) so the worker can list/remove/rename editors — impossible when they were
// stored as irreversible HMAC digests. Tokens remain keyed by their SHA-256 for
// defense in depth even though the blob is encrypted.
//
//   auth.enc = { "v": 1, "iv": "<base64 12-byte>", "ct": "<base64 ct+tag>" }
//
// Decrypting to a null signals AUTH_KEY is wrong/corrupt; handlers return 503.

// Resolve AUTH_KEY to a WebCrypto AES-GCM key, or null if it is missing,
// not base64, or not exactly 32 bytes. Never throws — an invalid value is
// treated the same as a missing one so a bad secret degrades to a clean 503
// instead of a raw Worker throw (Cloudflare error 1101).
async function authKey(env) {
  if (!env.AUTH_KEY) return null;
  let raw;
  try {
    raw = base64ToBytes(env.AUTH_KEY); // atob() throws on non-base64 input
  } catch {
    return null; // invalid base64 → treat as unconfigured
  }
  if (raw.length !== 32) return null; // AES-256 requires exactly 32 raw bytes
  return crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

// Encrypt a state object to the auth.enc blob. A fresh random 12-byte IV is used
// on every call — reusing an IV across encrypts under the same AES-GCM key leaks
// the key stream, so never cache/reuse an IV. Returns null (never throws) if
// AUTH_KEY is missing or invalid.
async function encryptState(env, state) {
  const key = await authKey(env);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify(state));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt);
  // ct already carries the 16-byte GCM auth tag appended
  return { v: AUTH_STATE_V, iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ct)) };
}

// Decrypt an auth.enc blob. Returns the state object, or null on any failure
// (wrong key, tamper, wrong version, bad shape).
async function decryptState(env, blob) {
  try {
    const key = await authKey(env);
    if (!key || !blob || blob.v !== AUTH_STATE_V) return null;
    const iv = base64ToBytes(blob.iv);
    const ct = base64ToBytes(blob.ct);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    const s = JSON.parse(new TextDecoder().decode(pt));
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    s.emails = s.emails || {};
    s.tokens = s.tokens || {};
    s.magic = s.magic || {};
    return s;
  } catch {
    return null;
  }
}

// Read the whole auth store. Returns the state, or null if it cannot be
// decrypted (AUTH_KEY wrong/corrupt). A missing auth.enc (fresh store) reads as
// a virgin empty state — no AUTH_KEY or migration is needed to read an absent
// blob; auth.enc is created lazily on the first write.
async function readAuthState(env) {
  const obj = await env.CONTENT.get(AUTH_FILE);
  if (!obj) return { emails: {}, tokens: {}, magic: {} }; // virgin state
  let blob;
  try {
    blob = JSON.parse(await obj.text());
  } catch {
    return null;
  }
  return decryptState(env, blob);
}

// Drop state that can never be used again, so the single auth.enc blob does not
// grow without bound (it is read+decrypted on every authed request and rewritten
// on every mutation — smaller store = less CPU/bytes per op):
//   - expired pending magic codes (a code past its TTL already refuses to redeem);
//   - tokens whose bound email no longer exists in the grant allowlist (such a
//     token is unreachable — authorize() requires the email's grant to contain
//     the target slug — so keeping it only bloats the store). Email-less
//     defensive tokens are retained; they are a legacy artifact, not an orphan.
function pruneAuthState(state) {
  const now = Date.now();
  for (const [hash, code] of Object.entries(state.magic)) {
    if (code && typeof code.exp === 'number' && code.exp < now) delete state.magic[hash];
  }
  for (const [hash, entry] of Object.entries(state.tokens)) {
    if (entry && entry.email != null && !state.emails[entry.email]) delete state.tokens[hash];
  }
}

// Write the whole auth store back as a single encrypted blob. Returns
// { ok:true, error:null } on success, or { ok:false, error } when AUTH_KEY is
// missing/invalid and the store can't be encrypted. Never throws.
async function writeAuthState(env, state) {
  pruneAuthState(state);
  const blob = await encryptState(env, state);
  if (!blob) {
    return { ok: false, error: 'auth encryption key not configured (AUTH_KEY not set or invalid)' };
  }
  await env.CONTENT.put(AUTH_FILE, JSON.stringify(blob), {
    httpMetadata: { contentType: 'application/json', cacheControl: CACHE_REVALIDATE },
  });
  return { ok: true, error: null };
}

// Shared read -> mutate in place -> write loop. Returns { ok, state?, error? }.
// ok is false (with a message) if the store couldn't be read or written; the
// caller decides the 503.
async function mutateState(env, fn) {
  const state = await readAuthState(env);
  if (!state) return { ok: false, error: 'auth state unavailable' };
  fn(state);
  const res = await writeAuthState(env, state);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, state };
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
  if (text.length > MAX_JSON_BODY) return { ok: false, error: 'request body too large' };
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, error: 'invalid JSON body' };
  }
}

// Wrap a streamed request body so it errors once it exceeds `max` bytes. The
// request body is counted by the platform and capped independently, but capping
// here too bounds how much the worker buffers/forwards even when a client lies
// about Content-Length. Throws the BODY_TOO_LARGE marker so putFile can answer a
// clean 413 instead of surfacing a generic 500.
function cappedBody(stream, max) {
  let size = 0;
  const ts = new TransformStream({
    transform(chunk, controller) {
      size += chunk.length;
      if (size > max) controller.error(new Error(BODY_TOO_LARGE));
      else controller.enqueue(chunk);
    },
  });
  return stream.pipeThrough(ts);
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

// Write a top-level JSON object store back to R2.
async function writeJsonMap(env, key, map) {
  await env.CONTENT.put(key, JSON.stringify(map), {
    httpMetadata: { contentType: 'application/json', cacheControl: CACHE_REVALIDATE },
  });
}

/**
 * Authorize an editor request for `slug`. The bearer token is SHA-256 hashed and
 * looked up directly in the single encrypted state (`state.tokens[sha256(token)]`).
 * The token is valid for a `slug` when the email it is bound to is granted on that
 * slug (`emails[email].includes(slug)`) — one token covers every slug the email can
 * edit (multisession). (A token with `email: null`, retained as a defensive
 * leftover, is pinned to the single slug it was minted for.)
 *
 * Direct object lookup replaces the old all-entries `timingSafeEqual` sweep: token
 * hashes are 256-bit random values, so a timing side channel on a single key probe
 * leaks nothing brute-forceable.
 */
async function authorize(env, slug, request) {
  const token = bearerToken(request);
  if (!token) return { ok: false, status: 401, error: 'missing bearer token' };

  const tokenHash = await sha256Hex(token);
  const state = await readAuthState(env);
  if (!state) return { ok: false, status: 503, error: 'auth state unavailable' };

  const entry = state.tokens[tokenHash];
  if (!entry) {
    return { ok: false, status: 403, error: 'token not valid' };
  }
  if (entry.email == null) {
    // Email-less (defensive) token: keep old single-slug semantics — only valid
    // for the exact slug it was minted for, never for other slugs.
    return entry.slug === slug
      ? { ok: true }
      : { ok: false, status: 403, error: 'token not valid for this slug' };
  }

  // Multisession: an email-bound token authorizes every slug the email is granted
  // on. state.emails is the single source of truth, so revoking the grant
  // immediately blocks the token there. entry.slug is deliberately not consulted.
  const slugs = state.emails[entry.email] || [];
  if (!slugs.includes(slug)) {
    return { ok: false, status: 403, error: 'email not authorized for this slug' };
  }
  return { ok: true };
}

/**
 * Accept either the site admin secret (authorizeAdmin) or an editor token
 * authorized for `slug` (authorize). Used by the /editors roster endpoints so
 * the admin can manage co-editors without holding an editor token. Admin secret
 * and editor tokens are disjoint credential spaces — a token failing one check
 * may validly satisfy the other. Returns the passing check, else the editor
 * check's failure result.
 */
async function authorizeAdminOrEditor(env, slug, request) {
  const admin = await authorizeAdmin(env, request);
  if (admin.ok) return admin;
  return authorize(env, slug, request);
}

/**
 * Accept either the site admin secret (authorizeAdmin) or a valid editor token for
 * ANY slug the caller can currently edit. Opens site creation (POST /sites/:slug)
 * to logged-in editors, not just the admin.
 *
 * Unlike the slug-scoped authorizeAdminOrEditor — which pins the token to the URL
 * slug — this is slug-agnostic: the NEW slug doesn't exist yet, so there is no URL
 * slug to match. A token qualifies if it resolves to an email-bound entry whose
 * email's grant list contains the token's own bound slug (i.e. the caller is
 * currently an authorized editor of at least one site, per the same grant check
 * authorize() applies). Email-less defensive tokens and non-editor tokens fail.
 */
async function authorizeAdminOrEditorAny(env, request) {
  const admin = await authorizeAdmin(env, request);
  if (admin.ok) return admin;

  const token = bearerToken(request);
  if (!token) return { ok: false, status: 401, error: 'missing bearer token' };

  const tokenHash = await sha256Hex(token);
  const state = await readAuthState(env);
  if (!state) return { ok: false, status: 503, error: 'auth state unavailable' };

  const entry = state.tokens[tokenHash];
  if (!entry || entry.email == null) {
    return { ok: false, status: 403, error: 'admin token or valid editor token required' };
  }
  const slugs = state.emails[entry.email] || [];
  if (!slugs.includes(entry.slug)) {
    return { ok: false, status: 403, error: 'admin token or valid editor token required' };
  }
  return { ok: true };
}

// slug-agnostic version of the same lookup authorize() does.
async function whoami(env, request) {
  const token = bearerToken(request);
  if (!token) return Response.json({ error: 'missing bearer token' }, { status: 401 });

  const tokenHash = await sha256Hex(token);
  const state = await readAuthState(env);
  if (!state) return Response.json({ error: 'auth state unavailable' }, { status: 503 });

  const entry = state.tokens[tokenHash];
  if (!entry) return Response.json({ error: 'invalid token' }, { status: 403 });

  // Multisession identity: the editor needs the full roster of slugs its email can
  // edit to render the site switcher. `slug` stays for backward compatibility.
  if (entry.email == null) {
    return Response.json({ slug: entry.slug, email: null, slugs: [entry.slug] });
  }
  const slugs = (state.emails[entry.email] || []).filter(Boolean);
  return Response.json({ slug: entry.slug, email: entry.email, slugs });
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
 * Dispatch the web-template deploy workflow for one slug (best-effort).
 * Returns `{ ok: true }` on success; returns `{ ok: false }` and logs on any
 * failure. Never throws. Unlike cfFetch, the success response here is HTTP 204
 * with NO body, so we must NOT call res.json() on it.
 */
async function githubDispatch(env, slug) {
  const token = env.GITHUB_BUILD_TOKEN;
  if (!token) {
    console.log(
      'githubDispatch: GITHUB_BUILD_TOKEN not configured; skipping build trigger',
    );
    return { ok: false };
  }
  const res = await fetch(
    `https://api.github.com/repos/${BUILD_REPO}/actions/workflows/${BUILD_WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'parroquia-config-api',
      },
      body: JSON.stringify({ ref: BUILD_REF, inputs: { site_slug: slug } }),
    },
  );
  if (res.status === 204) return { ok: true };
  // Body may be present on errors; read it defensively (can be non-JSON), and
  // never echo the token.
  let detail = '';
  try {
    detail = await res.text();
  } catch {}
  console.log(`githubDispatch: dispatch failed (${res.status}) ${detail}`);
  return { ok: false };
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
 * Fetch the Cloudflare Pages project object for `slug` and return its actual
 * pages.dev subdomain. This is the authoritative CNAME target: Pages may assign
 * a random-suffixed subdomain (e.g. `plantilla-3mn.pages.dev`) when the exact
 * `{slug}.pages.dev` name is unavailable, so we must never assume it is
 * `{slug}.pages.dev` — pointing a custom-domain CNAME at a subdomain the project
 * doesn't own is exactly what surfaces as Cloudflare Error 1014.
 * Returns `{ ok, subdomain, error? }`.
 */
async function getPagesProjectSubdomain(env, slug) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) return { ok: false, error: 'CLOUDFLARE_ACCOUNT_ID not configured' };

  const res = await cfFetch(env, `/accounts/${accountId}/pages/projects/${slug}`);
  if (!res.success) {
    return { ok: false, error: res.errors?.[0]?.message ?? 'failed to read Pages project' };
  }
  const subdomain = res.result?.subdomain;
  if (!subdomain) return { ok: false, error: 'Pages project has no subdomain' };
  return { ok: true, subdomain };
}

/**
 * Ensure a DNS CNAME record for `{slug}.parroquia.app` exists, pointing to the
 * given `target` (the project's ACTUAL pages.dev subdomain, from
 * `getPagesProjectSubdomain`), and is proxied. Verifies an existing record
 * actually matches (content + proxied) and deletes + recreates a
 * stale/conflicting/non-proxied record — pointing at the wrong (assumed)
 * `{slug}.pages.dev` subdomain, or at an unclaimed target, is repaired rather
 * than silently kept. Returns `{ ok, error?, action? }`.
 */
async function ensureDnsRecord(env, slug, target) {
  const zoneId = env.CLOUDFLARE_ZONE_ID;
  if (!zoneId) return { ok: false, error: 'CLOUDFLARE_ZONE_ID not configured' };

  const name = `${slug}.parroquia.app`;

  // List any existing record on this name (any type), so a conflicting or stale
  // record is removed instead of being trusted because a CNAME "exists".
  const listed = await cfFetch(env, `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`);
  if (!listed.success) {
    return { ok: false, error: listed.errors?.[0]?.message ?? 'failed to list DNS records' };
  }

  const records = listed.result || [];
  const good = records.find(
    (r) => r.type === 'CNAME' && r.content === target && r.proxied === true,
  );
  if (good) return { ok: true, action: 'CNAME already correct' };

  // No correct record — delete whatever is already there, then create the right one.
  for (const r of records) {
    await cfFetch(env, `/zones/${zoneId}/dns_records/${r.id}`, { method: 'DELETE' });
  }

  const res = await cfFetch(env, `/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify({ type: 'CNAME', name, content: target, ttl: 1, proxied: true }),
  });
  if (!res.success) {
    return { ok: false, error: res.errors?.[0]?.message ?? 'failed to create DNS record' };
  }
  return { ok: true, action: records.length > 0 ? 'replaced stale/conflicting record' : 'created CNAME' };
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

/**
 * Read the current status of the custom domain `{slug}.parroquia.app` on the
 * Pages project `slug`. Statuses include `active`, `pending`, `initializing`,
 * and `failed`; `not-attached` is returned when the domain isn't on the project
 * at all. Returns `{ ok, status, error? }`.
 */
async function getCustomDomainStatus(env, slug) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) return { ok: false, error: 'CLOUDFLARE_ACCOUNT_ID not configured' };

  const res = await cfFetch(env, `/accounts/${accountId}/pages/projects/${slug}/domains`);
  if (!res.success) {
    return { ok: false, error: res.errors?.[0]?.message ?? 'failed to list custom domains' };
  }
  const name = `${slug}.parroquia.app`;
  const found = (res.result || []).find((d) => d.name === name);
  return { ok: true, status: found?.status ?? 'not-attached' };
}

/**
 * Delete then re-attach the custom domain `{slug}.parroquia.app` on the Pages
 * project `slug`, forcing Cloudflare to re-validate it (a custom domain stuck in
 * `initializing`/`failed` — a common Error 1014 state — is not healed by a plain
 * re-POST that just returns 10006 "already attached"). Returns `{ ok, status }`.
 */
async function reattachCustomDomain(env, slug) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) return { ok: false, error: 'CLOUDFLARE_ACCOUNT_ID not configured' };

  const name = `${slug}.parroquia.app`;
  // Delete first; a missing domain is not an error worth propagating.
  await cfFetch(env, `/accounts/${accountId}/pages/projects/${slug}/domains/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  const res = await cfFetch(env, `/accounts/${accountId}/pages/projects/${slug}/domains`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  if (!res.success && res.errors?.[0]?.code !== 10006) {
    return { ok: false, error: res.errors?.[0]?.message ?? 'failed to re-attach custom domain' };
  }
  return getCustomDomainStatus(env, slug);
}

/**
 * Delete a Cloudflare Pages project for `slug`. Best-effort: failures are logged
 * and returned but not thrown, so the caller can continue cleanup.
 * Returns { ok, error? }.
 */
async function deletePagesProject(env, slug) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) return { ok: false, error: 'CLOUDFLARE_ACCOUNT_ID not configured' };
  try {
    const res = await cfFetch(env, `/accounts/${accountId}/pages/projects/${slug}`, {
      method: 'DELETE',
    });
    if (res.success) return { ok: true };
    // 8000 = project not found — not an error worth propagating
    if (res.errors?.[0]?.code === 8000) return { ok: true };
    return { ok: false, error: res.errors?.[0]?.message ?? 'failed to delete Pages project' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Delete all DNS records for `{slug}.parroquia.app`. Best-effort: failures are
 * returned but not thrown, so the caller can continue cleanup.
 * Returns { ok, error? }.
 */
async function deleteDnsRecord(env, slug) {
  const zoneId = env.CLOUDFLARE_ZONE_ID;
  if (!zoneId) return { ok: false, error: 'CLOUDFLARE_ZONE_ID not configured' };
  const name = `${slug}.parroquia.app`;
  try {
    const listed = await cfFetch(env, `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`);
    if (!listed.success) {
      return { ok: false, error: listed.errors?.[0]?.message ?? 'failed to list DNS records' };
    }
    const records = listed.result || [];
    for (const r of records) {
      await cfFetch(env, `/zones/${zoneId}/dns_records/${r.id}`, { method: 'DELETE' });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Detach the custom domain `{slug}.parroquia.app` from the Pages project `slug`.
 * Best-effort: failures are returned but not thrown.
 * Returns { ok, error? }.
 */
async function deleteCustomDomain(env, slug) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) return { ok: false, error: 'CLOUDFLARE_ACCOUNT_ID not configured' };
  const name = `${slug}.parroquia.app`;
  try {
    await cfFetch(env, `/accounts/${accountId}/pages/projects/${slug}/domains/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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

// Single encrypted credential store at the bucket root (replaces auth.json,
// magic.json, emails.json). Its plaintext payload is { emails, tokens, magic }.
const AUTH_FILE = 'auth.enc';
const AUTH_STATE_V = 1; // encrypted-blob format version

// Cache-Control policies written into every object's httpMetadata. The bucket is
// published read-only at data.parroquia.app (R2 custom domain), which only treats
// responses as cacheable when the object itself carries Cache-Control — a header the
// R2 host will not add on its own, so without this every read is cf-cache-status:
// DYNAMIC. Hashed media (content-hashed filename → new URL per change) is safe to
// mark immutable; "living" files (config.json, slugs.json) must revalidate so they
// never go stale for a whole year, and any non-busted consumer still gets fresh data.
const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
const CACHE_REVALIDATE = 'public, max-age=0, must-revalidate';
const LIVING_FILES = new Set(['config.json', 'slugs.json']);

// Request-body size caps. Every endpoint reads caller-supplied bytes into memory
// before use; uncapped bodies are a memory/CPU/cost abuse vector (the JSON paths
// are parsed, so a giant body is CPU work too). Config/media are the large ones;
// the small JSON control bodies cap tight. Content-Length may lie, so putFile also
// enforces the cap on the live stream (see cappedBody). Marker distinguishes a
// raised cap from any other stream failure so the handler can answer 413 cleanly.
const MAX_JSON_BODY = 1024 * 1024; // 1 MiB — auth/editors/clone/create JSON bodies
const MAX_PATCH_BODY = 5 * 1024 * 1024; // 5 MiB — config.json patch op payloads
const MAX_FILE_BYTE = 20 * 1024 * 1024; // 20 MiB — file content (PUT)
const BODY_TOO_LARGE = 'parroquia:body-too-large';

// Auto-build: where to dispatch the deploy workflow when a site's config.json is
// written. The workflow (web-template/.github/workflows/deploy.yml) accepts a
// required `site_slug` input, then builds + deploys the page to Cloudflare Pages.
const BUILD_REPO = 'catholicweb/web-template';
const BUILD_WORKFLOW = 'deploy.yml'; // filename in that repo's .github/workflows/
const BUILD_REF = 'main';

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

/**
 * Maintain slugs.json incrementally (1 get + 1 put, no full bucket scan).
 * Reads the current artifact, applies add/remove, writes back. If slugs.json is
 * absent or corrupt the first time through, seeds it from a one-time live scan
 * via getSlugs so the file is never stale even after a manual bucket wipe.
 */
async function updateSlugsJson(env, { add, remove } = {}) {
  let slugs = [];
  const obj = await env.CONTENT.get('slugs.json');
  if (obj) {
    try {
      const parsed = JSON.parse(await obj.text());
      if (Array.isArray(parsed?.slugs)) slugs = parsed.slugs.filter((s) => typeof s === 'string');
    } catch { /* corrupt — fall through to seed below */ }
  }
  // If we still have nothing (missing or corrupt), seed once from a live scan.
  if (slugs.length === 0) {
    slugs = await getSlugs(env);
  }
  if (add && !slugs.includes(add)) slugs.push(add);
  if (remove) slugs = slugs.filter((s) => s !== remove);
  await writeJsonMap(env, 'slugs.json', { slugs });
}

async function siteExists(env, slug) {
  // .site markers are created on every site creation and clone, so the marker
  // head is authoritative and one R2 op (no list fallback). An old pre-marker
  // slug would read as absent here; the marker has existed for every site
  // created through this worker.
  return !!(await env.CONTENT.head(`${slug}/${SITE_MARKER}`));
}

/**
 * Register an email → slug edit-capability grant in the in-memory state
 * (`state.emails[email] = ["<slug>", ...]`). Appends the slug to the email's list
 * (deduped) so one email can own multiple sites. This is a pure mutation on the
 * caller-owned state object; the caller writes it back via writeAuthState.
 */
function addEmailGrant(state, email, slug) {
  const list = state.emails[email] || [];
  if (!list.includes(slug)) list.push(slug);
  state.emails[email] = list;
}

/**
 * Create a site and kick off magic-link login for the site owner.
 *
 * Provisions Cloudflare resources (Pages project, DNS CNAME, custom domain) —
 * idempotent, unchanged from before — then seeds the site: copies the root
 * config.json template into <slug>/config.json, grants the owner edit access in
 * the encrypted auth.enc email allowlist, and emails them a magic login link
 * instead of returning a token. The email only arrives after provisioning
 * succeeds.
 *
 * NOTE: every credential mutation now reads, mutates, and writes back the single
 * encrypted auth.enc, so concurrent creations/mutations can race (last write
 * wins). This API is meant for occasional admin bootstrapping, not concurrent
 * mass-creation.
 */
async function createSite(ctx, env, slug, email) {
  if (!env.RESEND_API_KEY) {
    return Response.json(
      { ok: false, error: 'magic-link email not configured (RESEND_API_KEY not set)' },
      { status: 503 },
    );
  }
  if (!env.AUTH_KEY) {
    return Response.json(
      { ok: false, error: 'auth encryption key not configured (AUTH_KEY not set)' },
      { status: 503 },
    );
  }
  if (await siteExists(env, slug)) {
    return Response.json({ ok: false, error: 'slug already exists' }, { status: 409 });
  }

  // Provision Cloudflare resources. Each step is idempotent: it creates the
  // resource only if missing and returns ok if it already exists. The DNS CNAME
  // target is the project's ACTUAL pages.dev subdomain (which Pages may have
  // random-suffixed, e.g. `plantilla-3mn.pages.dev`), never an assumed
  // `{slug}.pages.dev` — a CNAME aimed at a subdomain the project doesn't own is
  // what surfaces as Cloudflare Error 1014.
  try {
    const proj = await ensurePagesProject(env, slug);
    if (!proj.ok) {
      return Response.json(
        { ok: false, error: `failed ensuring Cloudflare Pages project: ${proj.error}` },
        { status: 502 },
      );
    }
    const sub = await getPagesProjectSubdomain(env, slug);
    if (!sub.ok) {
      return Response.json(
        { ok: false, error: `failed reading Pages project subdomain: ${sub.error}` },
        { status: 502 },
      );
    }

    const steps = [
      ['ensuring DNS CNAME record', () => ensureDnsRecord(env, slug, sub.subdomain)],
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

  // Seed the site's config.json from the 'plantilla' template. This is the default
  // content the site starts with; the editor then edits it as any other file.
  // The template lives at plantilla/config.json (a separate key from each site's
  // <slug>/config.json)
  const template = await env.CONTENT.get('plantilla/config.json');
  if (!template) {
    return Response.json(
      { ok: false, error: 'site template config.json not configured at bucket root' },
      { status: 503 },
    );
  }
  const templateText = await template.text();
  await env.CONTENT.put(`${slug}/config.json`, templateText, {
    httpMetadata: { contentType: 'application/json', cacheControl: CACHE_REVALIDATE },
  });

  // Auto-build: a freshly-created site should build right away. Placed right after
  // the config seed so it fires even if a later step (email/marker/slugs.json)
  // fails — a fresh site's build is harmless and the seed is what matters.
  if (ctx?.waitUntil) {
    ctx.waitUntil(githubDispatch(env, slug));
  }

  // Grant the owner editor access (the encrypted email allowlist is the enforced
  // allowlist) and email them their first login link.
  const mres = await mutateState(env, (s) => addEmailGrant(s, normalizeEmail(email), slug));
  if (!mres.ok) return Response.json({ error: mres.error }, { status: 503 });

  const issued = await issueMagicLink(env, slug, email);
  if (!issued.ok) {
    return Response.json({ ok: false, error: issued.error }, { status: issued.status });
  }

  await env.CONTENT.put(`${slug}/${SITE_MARKER}`, '{"ok":true}', {
    httpMetadata: { contentType: 'application/json', cacheControl: CACHE_REVALIDATE },
  });

  // Write the authoritative slugs.json at the bucket root (same shape as the
  // GET /sites/list response). We re-scan the bucket so the file is always
  // consistent with reality, not just an append of the current creation.
  await updateSlugsJson(env, { add: slug });

  // Report the custom-domain attach status so a site that can't validate (and
  // would surface later as Cloudflare Error 1014) is flagged at creation rather
  // than silently kept. A brand-new domain is usually `initializing`/`pending`
  // until the first build deploys, so only log a warning on a hard failure.
  let domainStatus;
  try {
    const st = await getCustomDomainStatus(env, slug);
    if (st.ok) domainStatus = st.status;
  } catch {
    /* non-fatal — DNS/list failure here shouldn't fail an otherwise-created site */
  }
  if (domainStatus === 'failed' || domainStatus === 'not-attached') {
    console.log(
      `createSite: custom domain for ${slug} is ${domainStatus}; ` +
        'site will 1014 until the domain validates and a build deploys',
    );
  }

  return Response.json({ ok: true, slug, sent: true, email, domainStatus }, { status: 201 });
}

/**
 * Re-run Cloudflare provisioning for an EXISTING site to repair a state that
 * surfaces as Cloudflare Error 1014 — most often a custom-domain CNAME aimed at
 * an assumed `{slug}.pages.dev` rather than the project's actual (possibly
 * random-suffixed) pages.dev subdomain. Idempotent: each ensure step only acts
 * as needed. It repairs the DNS record to point at the project's real subdomain,
 * re-attaches the custom domain when it isn't `active` (forcing revalidation),
 * and dispatches a page build so the pages.dev subdomain is live. Admin-gated
 * via `POST /sites/:slug/reprovision`. Returns `{ ok, slug, target, domainStatus,
 * actions }`.
 */
async function reprovisionSite(ctx, env, slug) {
  const actions = [];
  try {
    const proj = await ensurePagesProject(env, slug);
    if (!proj.ok) {
      return Response.json(
        { ok: false, error: `failed ensuring Cloudflare Pages project: ${proj.error}` },
        { status: 502 },
      );
    }
    const sub = await getPagesProjectSubdomain(env, slug);
    if (!sub.ok) {
      return Response.json(
        { ok: false, error: `failed reading Pages project subdomain: ${sub.error}` },
        { status: 502 },
      );
    }
    actions.push(`project subdomain: ${sub.subdomain}`);

    const steps = [
      ['ensuring DNS CNAME record', () => ensureDnsRecord(env, slug, sub.subdomain)],
    ];
    for (const [label, fn] of steps) {
      const result = await fn();
      if (!result.ok) {
        return Response.json(
          { ok: false, error: `failed ${label}: ${result.error}` },
          { status: 502 },
        );
      }
      if (result.action) actions.push(`${label}: ${result.action}`);
    }

    // Ensure the custom domain is attached; then, if it isn't live, delete and
    // re-attach it to force Cloudflare to re-validate against a fresh pages.dev.
    const attached = await ensureCustomDomain(env, slug);
    if (!attached.ok) {
      return Response.json(
        { ok: false, error: `failed attaching custom domain: ${attached.error}` },
        { status: 502 },
      );
    }
    const dom = await getCustomDomainStatus(env, slug);
    const domainStatus = dom.ok ? dom.status : undefined;
    if (domainStatus !== 'active') {
      const reattached = await reattachCustomDomain(env, slug);
      if (!reattached.ok) {
        return Response.json(
          { ok: false, error: `failed re-attaching custom domain: ${reattached.error}` },
          { status: 502 },
        );
      }
      domainStatus = reattached.status;
      actions.push('custom domain: re-attached to force revalidation');
    } else {
      actions.push('custom domain: already active');
    }

    // Ensure the pages.dev subdomain gets an active production deployment.
    if (ctx?.waitUntil) ctx.waitUntil(githubDispatch(env, slug));
    actions.push('dispatched page build');

    return Response.json({ ok: true, slug, target: sub.subdomain, domainStatus, actions }, { status: 200 });
  } catch (err) {
    return Response.json(
      { ok: false, error: `failed during Cloudflare reprovisioning: ${err.message}` },
      { status: 502 },
    );
  }
}

/**
 * POST /sites/:slug/clone — admin-gated: clone all content from sourceSlug to
 * targetSlug. Copies R2 objects (rewriting config.json media URLs), copies
 * email grants in auth.enc, provisions Cloudflare for targetSlug, dispatches
 * a build. Does NOT modify the source slug at all.
 */
async function cloneSite(ctx, env, sourceSlug, request) {
  // 1. Validate source slug exists
  if (!(await siteExists(env, sourceSlug))) {
    return Response.json({ error: 'source slug not found' }, { status: 404 });
  }

  // 2. Extract and validate target slug from JSON body
  const body = await readJsonBody(request);
  if (!body.ok) return Response.json({ error: body.error }, { status: 400 });
  const targetSlug = body.data.targetSlug;
  if (!targetSlug || typeof targetSlug !== 'string') {
    return Response.json({ error: 'targetSlug is required as a string' }, { status: 400 });
  }
  if (!validateSlug(targetSlug)) {
    return Response.json({ error: 'invalid target slug' }, { status: 400 });
  }
  if (!validateSlugNotReserved(targetSlug)) {
    return Response.json({ error: 'target slug is reserved' }, { status: 400 });
  }

  // 3. Check target slug doesn't already exist
  if (await siteExists(env, targetSlug)) {
    return Response.json({ error: 'target slug already exists' }, { status: 409 });
  }

  // 4. Copy all R2 objects from sourceSlug/ prefix to targetSlug/ prefix.
  //    For config.json, rewrite media URLs from dataBase(env)/{sourceSlug}/
  //    to dataBase(env)/{targetSlug}/.
  const prefix = `${sourceSlug}/`;
  const db = dataBase(env);
  let cursor;
  let copied = 0;
  do {
    const listed = await env.CONTENT.list({ limit: 1000, cursor, prefix });
    for (const obj of listed.objects) {
      const filename = obj.key.slice(prefix.length);
      const sourceKey = obj.key;

      const sourceObj = await env.CONTENT.get(sourceKey);
      if (!sourceObj) continue;

      let bodyContent = await sourceObj.arrayBuffer();
      let contentType = sourceObj.httpMetadata?.contentType || 'application/octet-stream';

      if (filename === 'config.json') {
        const search = `${db}/${sourceSlug}/`;
        const replace = `${db}/${targetSlug}/`;
        let text = new TextDecoder().decode(bodyContent);
        if (text.includes(search)) {
          text = text.split(search).join(replace);
        }
        bodyContent = new TextEncoder().encode(text).buffer;
      }

      const cacheControl = LIVING_FILES.has(filename) ? CACHE_REVALIDATE : CACHE_IMMUTABLE;
      await env.CONTENT.put(`${targetSlug}/${filename}`, bodyContent, {
        httpMetadata: { contentType, cacheControl },
      });
      copied += 1;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  // 5. Copy email grants from sourceSlug to targetSlug. Email-bound tokens
  //    automatically work for targetSlug via the multi-session grant check
  //    (authorize() checks state.emails[email].includes(slug)).
  const mres = await mutateState(env, (state) => {
    for (const [email, slugs] of Object.entries(state.emails)) {
      if (slugs.includes(sourceSlug) && !slugs.includes(targetSlug)) {
        slugs.push(targetSlug);
      }
    }
  });
  if (!mres.ok) return Response.json({ error: mres.error }, { status: 503 });

  // 6. Provision Cloudflare for targetSlug (same pattern as createSite)
  let domainStatus;
  try {
    const proj = await ensurePagesProject(env, targetSlug);
    if (!proj.ok) {
      return Response.json(
        { ok: false, error: `failed ensuring Cloudflare Pages project: ${proj.error}` },
        { status: 502 },
      );
    }
    const sub = await getPagesProjectSubdomain(env, targetSlug);
    if (!sub.ok) {
      return Response.json(
        { ok: false, error: `failed reading Pages project subdomain: ${sub.error}` },
        { status: 502 },
      );
    }
    const dns = await ensureDnsRecord(env, targetSlug, sub.subdomain);
    if (!dns.ok) {
      return Response.json(
        { ok: false, error: `failed ensuring DNS CNAME record: ${dns.error}` },
        { status: 502 },
      );
    }
    const domain = await ensureCustomDomain(env, targetSlug);
    if (!domain.ok) {
      return Response.json(
        { ok: false, error: `failed attaching custom domain: ${domain.error}` },
        { status: 502 },
      );
    }
    const st = await getCustomDomainStatus(env, targetSlug);
    if (st.ok) domainStatus = st.status;
  } catch (err) {
    return Response.json(
      { ok: false, error: `failed during Cloudflare provisioning: ${err.message}` },
      { status: 502 },
    );
  }

  // 7. Write .site marker for targetSlug
  await env.CONTENT.put(`${targetSlug}/${SITE_MARKER}`, '{"ok":true}', {
    httpMetadata: { contentType: 'application/json', cacheControl: CACHE_REVALIDATE },
  });

  // 8. Dispatch build for targetSlug (fire-and-forget)
  if (ctx?.waitUntil) {
    ctx.waitUntil(githubDispatch(env, targetSlug));
  }

  // 9. Update slugs.json incrementally
  await updateSlugsJson(env, { add: targetSlug });

  // 10. Return 201 with details
  return Response.json({
    ok: true,
    sourceSlug,
    targetSlug,
    filesCopied: copied,
    domainStatus,
  }, { status: 201 });
}

/**
 * DELETE /sites/:slug — admin-gated: delete a site entirely. Best-effort
 * Cloudflare resource cleanup, then remove all R2 content under the slug,
 * clean up auth.enc grants/tokens/magic, re-scan slugs.json.
 */
async function deleteSite(ctx, env, slug) {
  // 1. Check slug exists
  if (!(await siteExists(env, slug))) {
    return Response.json({ error: 'slug not found' }, { status: 404 });
  }

  // 2. Best-effort Cloudflare resource cleanup (dependency order: domain →
  //    DNS → project). Log failures but never fail the endpoint — R2 and
  //    auth cleanup should proceed regardless.
  const cfErrors = [];
  try {
    const domainResult = await deleteCustomDomain(env, slug);
    if (!domainResult.ok) cfErrors.push(`custom domain: ${domainResult.error}`);
  } catch (err) { cfErrors.push(`custom domain: ${err.message}`); }

  try {
    const dnsResult = await deleteDnsRecord(env, slug);
    if (!dnsResult.ok) cfErrors.push(`DNS: ${dnsResult.error}`);
  } catch (err) { cfErrors.push(`DNS: ${err.message}`); }

  try {
    const projResult = await deletePagesProject(env, slug);
    if (!projResult.ok) cfErrors.push(`Pages project: ${projResult.error}`);
  } catch (err) { cfErrors.push(`Pages project: ${err.message}`); }

  for (const e of cfErrors) {
    console.log(`deleteSite: ${slug} — ${e}`);
  }

  // 3. Delete all R2 objects under slug/ prefix
  let deleted = 0;
  let cursor;
  do {
    const listed = await env.CONTENT.list({ limit: 1000, cursor, prefix: `${slug}/` });
    for (const obj of listed.objects) {
      await env.CONTENT.delete(obj.key);
      deleted += 1;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  // 4. Clean up auth.enc: remove slug from email grants, delete tokens and
  //    magic codes bound to slug
  const mres = await mutateState(env, (state) => {
    for (const [email, slugs] of Object.entries(state.emails)) {
      state.emails[email] = slugs.filter((s) => s !== slug);
      if (state.emails[email].length === 0) delete state.emails[email];
    }
    for (const [hash, entry] of Object.entries(state.tokens)) {
      if (entry.slug === slug) delete state.tokens[hash];
    }
    for (const [hash, code] of Object.entries(state.magic)) {
      if (code.slug === slug) delete state.magic[hash];
    }
  });
  if (!mres.ok) return Response.json({ error: mres.error }, { status: 503 });

  // 5. Update slugs.json incrementally
  await updateSlugsJson(env, { remove: slug });

  // 6. Return 200 with result
  return Response.json({
    ok: true,
    slug,
    filesDeleted: deleted,
    cfWarnings: cfErrors.length > 0 ? cfErrors : undefined,
  }, { status: 200 });
}

/**
 * Mint a one-time magic code for `slug` and email the login link to `email`.
 * This ONLY issues a login link — it does NOT grant the address access. Whether
 * the redeemed token can write is decided later by `authorize` against the email
 * grant, which is seeded by `createSite` and added via `POST /sites/:slug/editors`.
 * Returns { ok:true } or { ok:false, status, error }.
 *
 * The code is stored in the encrypted state (keyed by its SHA-256), is single-use,
 * and expires after MAGIC_TTL_MS. The email is sent first; only on success is the
 * code recorded, so a delivery failure leaves no stale pending code to roll back.
 */
async function issueMagicLink(env, slug, email) {
  if (!env.RESEND_API_KEY) {
    return { ok: false, status: 503, error: 'magic-link email not configured (RESEND_API_KEY not set)' };
  }

  const code = generateToken();
  const codeHash = await sha256Hex(code);
  const exp = Date.now() + MAGIC_TTL_MS;

  // Send the email first, then record the code. A crash between the two leaves a
  // dead link rather than a stuck pending code; the caller is otherwise retryable.
  const sent = await sendMagicLinkEmail(env, email, slug, code);
  if (!sent.ok) {
    return { ok: false, status: 502, error: `failed to send magic-link email: ${sent.error}` };
  }

  const state = await readAuthState(env);
  if (!state) return { ok: false, status: 503, error: 'auth state unavailable' };
  state.magic[codeHash] = { slug, email: normalizeEmail(email), exp };
  const res = await writeAuthState(env, state);
  if (!res.ok) return { ok: false, status: 503, error: res.error };
  return { ok: true };
}

/**
 * POST /auth/request — email a one-time magic login link to every slug the
 * `email` address already has edit access to. Open to all: it only issues links
 * and never grants access (authorize still checks the email
 * grant after the code is redeemed). This is what lets the editor offer an
 * email-only login screen — the slug(s) are resolved here from the (encrypted)
 * email allowlist instead of being typed by the user.
 *
 * To avoid account enumeration, the response is deliberately generic: we return
 * the same 200 whether or not the address has any grant, and only actually send
 * email(s) when at least one granted slug exists.
 */
async function requestMagicLink(env, request) {
  if (!env.RESEND_API_KEY) {
    return Response.json(
      { ok: false, error: 'magic-link email not configured (RESEND_API_KEY not set)' },
      { status: 503 },
    );
  }

  const body = await readJsonBody(request);
  if (!body.ok) return Response.json({ error: body.error }, { status: 400 });
  const email = body.data.email;
  if (!validateEmail(email)) {
    return Response.json({ error: 'a valid email is required' }, { status: 400 });
  }

  // Look up the address's granted slugs from the decrypted state. One magic link
  // per slug; issueMagicLink sends its own email and is best-effort per slug so
  // a single failure doesn't block the rest.
  const state = await readAuthState(env);
  if (!state) return Response.json({ error: 'auth state unavailable' }, { status: 503 });

  const slugs = (state.emails[normalizeEmail(email)] || []).filter(Boolean);
  for (const slug of slugs) {
    const issued = await issueMagicLink(env, slug, email);
    if (!issued.ok) {
      console.error(`[auth/request] failed to email link for slug=${slug}: ${issued.error}`);
    }
  }

  return Response.json({ ok: true, email }, { status: 200 });
}

/**
 * POST /sites/:slug/editors — grant `email` edit access to an EXISTING slug and
 * email them an invite/login link. Editor-gated (the router authorizes first):
 * write permission to the slug is enough to add new co-editors, since a writer
 * can already do unbounded damage to the repo. The grant is recorded inside the
 * encrypted auth.enc (never in the public config.json), so editor emails stay
 * out of the public data host but remain recoverable by the worker.
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

  const mres = await mutateState(env, (s) => addEmailGrant(s, normalizeEmail(email), slug));
  if (!mres.ok) return Response.json({ error: mres.error }, { status: 503 });

  const issued = await issueMagicLink(env, slug, email);
  if (!issued.ok) {
    return Response.json({ ok: false, error: issued.error }, { status: issued.status });
  }
  return Response.json({ ok: true, slug, sent: true, email }, { status: 200 });
}

/**
 * GET /sites/:slug/editors — list the emails granted edit access to `slug`.
 * Editor-gated to this slug (the router authorizes first). Emails are recoverable
 * because they live plaintext inside the encrypted auth.enc.
 */
async function listEditors(env, slug) {
  if (!(await siteExists(env, slug))) {
    return Response.json({ error: 'slug not found' }, { status: 404 });
  }
  const state = await readAuthState(env);
  if (!state) return Response.json({ error: 'auth state unavailable' }, { status: 503 });

  const editors = Object.entries(state.emails)
    .filter(([, slugs]) => slugs.includes(slug))
    .map(([email]) => email);
  return Response.json({ ok: true, slug, editors });
}

/**
 * DELETE /sites/:slug/editors — remove `email`'s edit access to `slug` and revoke
 * every token bound to that email for this slug. Body
 * `{ "email": "<addr>" }`. Returns 404 if the email isn't currently an
 * editor of this slug.
 */
async function removeEditor(env, request, slug) {
  if (!(await siteExists(env, slug))) {
    return Response.json({ error: 'slug not found' }, { status: 404 });
  }

  const body = await readJsonBody(request);
  if (!body.ok) return Response.json({ error: body.error }, { status: 400 });
  const email = normalizeEmail(body.data.email);
  if (!validateEmail(email)) {
    return Response.json({ error: 'a valid email is required' }, { status: 400 });
  }

  const state = await readAuthState(env);
  if (!state) return Response.json({ error: 'auth state unavailable' }, { status: 503 });
  if (!(state.emails[email] || []).includes(slug)) {
    return Response.json({ error: 'email is not an editor of this slug' }, { status: 404 });
  }

  state.emails[email] = state.emails[email].filter((s) => s !== slug);
  if (state.emails[email].length === 0) delete state.emails[email];
  // Revoke every token of this slug that is bound to this email.
  for (const [hash, e] of Object.entries(state.tokens)) {
    if (e.slug === slug && e.email === email) delete state.tokens[hash];
  }
  const res = await writeAuthState(env, state);
  if (!res.ok) return Response.json({ error: res.error }, { status: 503 });
  return Response.json({ ok: true, slug, email }, { status: 200 });
}

/**
 * PATCH /sites/:slug/editors — change an editor's email address for `slug`.
 * Body `{ "from": "<old>", "to": "<new>" }`. Re-grants `to` and re-binds all of
 * `from`'s email-bound tokens for this slug to `to`, so the editor keeps their
 * existing logged-in sessions. Returns 404 if `from` isn't currently an editor.
 */
async function updateEditor(env, request, slug) {
  if (!(await siteExists(env, slug))) {
    return Response.json({ error: 'slug not found' }, { status: 404 });
  }

  const body = await readJsonBody(request);
  if (!body.ok) return Response.json({ error: body.error }, { status: 400 });
  const from = normalizeEmail(body.data.from);
  const to = normalizeEmail(body.data.to);
  if (!validateEmail(to)) {
    return Response.json({ error: 'a valid target email is required' }, { status: 400 });
  }

  const state = await readAuthState(env);
  if (!state) return Response.json({ error: 'auth state unavailable' }, { status: 503 });
  if (!(state.emails[from] || []).includes(slug)) {
    return Response.json({ error: 'from email is not an editor of this slug' }, { status: 404 });
  }

  // Rebind the grant (dedupe into the target).
  state.emails[from] = state.emails[from].filter((s) => s !== slug);
  if (state.emails[from].length === 0) delete state.emails[from];
  const toList = state.emails[to] || [];
  if (!toList.includes(slug)) toList.push(slug);
  state.emails[to] = toList;

  // Rebind this slug's email-bound tokens from 'from' to 'to'.
  for (const e of Object.values(state.tokens)) {
    if (e.slug === slug && e.email === from) e.email = to;
  }
  const res = await writeAuthState(env, state);
  if (!res.ok) return Response.json({ error: res.error }, { status: 503 });
  return Response.json({ ok: true, slug, from, to }, { status: 200 });
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
 * Reads the encrypted state, finds the code by its SHA-256, checks expiry, then
 * mints a 256-bit editor token (sha256 stored in state.tokens → { slug, email }),
 * removes the code (one-time invalidation), and returns the token once. The
 * minted token inherits the code's bound email (always set for codes issued by
 * issueMagicLink). Alongside the token it returns the email and that email's full
 * slug grant (the multisession roster) so the editor can offer a site switcher
 * immediately, before any /whoami round-trip.
 */
async function exchangeMagic(env, request) {
  const body = await readJsonBody(request);
  if (!body.ok) return Response.json({ error: body.error }, { status: 400 });

  const code = body.data.code;
  if (typeof code !== 'string' || !validateToken(code)) {
    return Response.json({ error: 'a valid magic code is required' }, { status: 400 });
  }

  const codeHash = await sha256Hex(code);
  const state = await readAuthState(env);
  if (!state) return Response.json({ error: 'auth state unavailable' }, { status: 503 });

  const record = state.magic[codeHash];
  if (!record) return Response.json({ error: 'invalid or already-used magic code' }, { status: 404 });

  if (typeof record.exp === 'number' && record.exp < Date.now()) {
    // Expired: consume it and refuse.
    delete state.magic[codeHash];
    const res = await writeAuthState(env, state);
    if (!res.ok) return Response.json({ error: res.error }, { status: 503 });
    return Response.json({ error: 'magic code expired' }, { status: 410 });
  }

  const slug = record.slug;
  const email = record.email == null ? null : record.email;

  // Consume the code first so it cannot be reused, then mint the editor token.
  delete state.magic[codeHash];

  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  state.tokens[tokenHash] = { slug, email };

  const res = await writeAuthState(env, state);
  if (!res.ok) return Response.json({ error: res.error }, { status: 503 });

  // Grant list at redemption time, so the client can render the site switcher
  // before ever calling /whoami. If the email was revoked from `slug` between
  // send and redemption, `slugs` may already omit it — the client re-targets.
  const slugs = email == null ? [slug] : (state.emails[email] || []).filter(Boolean);

  return Response.json({ ok: true, slug, token, email, slugs }, { status: 200 });
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

// Returns the list of file URLs under a slug: one absolute public URL per file
// (https://data.parroquia.app/<slug>/<token>). The internal .site marker is
// skipped. Consumers treat these as opaque absolute URLs — no token decoding.
async function listFiles(env, slug) {
  const prefix = `${slug}/`;
  const files = [];
  let cursor;
  do {
    const listed = await env.CONTENT.list({ limit: 1000, cursor, prefix });
    for (const o of listed.objects) {
      const token = o.key.slice(prefix.length); // strip "<slug>/"
      if (token === SITE_MARKER) continue; // internal marker
      files.push(fileUrl(env, slug, token));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return Response.json({ slug, files });
}

// Write one file by token (admin or editor). Token is used verbatim as the key.
async function putFile(ctx, env, slug, token, request) {
  const key = `${slug}/${token}`;
  if (!key.startsWith(`${slug}/`)) {
    return new Response('Invalid path', { status: 400 });
  }
  const contentType =
    request.headers.get('Content-Type') || 'application/octet-stream';
  // Client-generated media uses content-hashed filenames (a change → new URL), so
  // non-config files are safe to serve immutable from data.parroquia.app. config.json
  // (and any other living file) revalidates instead. Consumers that must stay fresh
  // already cache-bust with a ?_=/?time query param or cache:no-cache.
  const cacheControl = LIVING_FILES.has(token) ? CACHE_REVALIDATE : CACHE_IMMUTABLE;
  // Reject oversized uploads up front (Content-Length) and on the live stream
  // (a client can lie about the header). An oversized body answers 413, not 500.
  const declared = Number(request.headers.get('Content-Length'));
  if (!Number.isNaN(declared) && declared > MAX_FILE_BYTE) {
    return Response.json({ ok: false, error: 'file too large' }, { status: 413 });
  }
  const body = request.body ? cappedBody(request.body, MAX_FILE_BYTE) : request.body;
  try {
    await env.CONTENT.put(key, body, {
      httpMetadata: { contentType, cacheControl },
    });
  } catch (err) {
    if (err instanceof Error && err.message === BODY_TOO_LARGE) {
      return Response.json({ ok: false, error: 'file too large' }, { status: 413 });
    }
    throw err;
  }
  // Auto-build: whenever a site's config.json is saved, trigger a page build
  // (best-effort, fire-and-forget via waitUntil so the save is never blocked or
  // failed by a dispatch problem).
  if (token === 'config.json' && ctx?.waitUntil) {
    ctx.waitUntil(githubDispatch(env, slug));
  }
  // `url` is the absolute public URL of the stored file, so a client that just
  // uploaded media can use it directly as the field value.
  return Response.json({ ok: true, slug, key, url: fileUrl(env, slug, token) }, { status: 200 });
}

// PATCH /sites/:slug/config.json — apply a small diff to the stored config.json.
// The editor sends absolute ops (see editor lib/patch.js and its mirror
// src/patch.js); they are applied onto the CURRENT stored document so per-field
// edits are truly last-edit-wins even against a concurrently-updated base. Returns
// the merged doc so the editor can adopt other editors' changes. Scoped to
// config.json (the only file the editor edits concurrently).
async function patchConfigFile(ctx, env, slug, request) {
  const key = `${slug}/config.json`;
  if (!key.startsWith(`${slug}/`)) {
    return new Response('Invalid path', { status: 400 });
  }
  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_PATCH_BODY) {
      return Response.json({ ok: false, error: 'request body too large' }, { status: 413 });
    }
    body = JSON.parse(text);
  } catch (err) {
    if (err instanceof Error && err.message === BODY_TOO_LARGE) {
      return Response.json({ ok: false, error: 'request body too large' }, { status: 413 });
    }
    return Response.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!Array.isArray(body?.ops) || body.ops.length === 0) {
    return Response.json({ ok: false, error: 'ops array required' }, { status: 400 });
  }
  const obj = await env.CONTENT.get(key);
  if (!obj) return new Response('Not Found', { status: 404 });
  let doc;
  try {
    doc = JSON.parse(await obj.text());
  } catch {
    return Response.json(
      { ok: false, error: 'Stored config.json is invalid JSON' },
      { status: 500 }
    );
  }
  // applyPatch mutates `doc` in place (only allocation is parse/stringify).
  const { data, skipped } = applyPatch(doc, body.ops);
  const text = JSON.stringify(data, null, 2) + '\n';
  await env.CONTENT.put(key, text, {
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: CACHE_REVALIDATE },
  });
  // Auto-build: same as a config.json PUT (best-effort, fire-and-forget).
  if (ctx?.waitUntil) ctx.waitUntil(githubDispatch(env, slug));
  return Response.json({ ok: true, slug, key, data, skipped }, { status: 200 });
}

// Admin-gated maintenance: rewrite every object's httpMetadata.cacheControl so the
// whole bucket is served cacheable from data.parroquia.app. Objects written before
// the write-path caching existed carry no Cache-Control (so R2 serves them DYNAMIC);
// this re-stamps the same policy in place for consistent behavior. auth.enc is
// skipped (private credential blob, never served by the data host).
async function backfillCache(env) {
  let cursor;
  let updated = 0;
  let skipped = 0;
  do {
    const listed = await env.CONTENT.list({ cursor, limit: 1000 });
    for (const obj of listed.objects) {
      const key = obj.key;
      if (key === AUTH_FILE) {
        skipped += 1;
        continue;
      }
      const base = key.split('/').pop();
      const cacheControl = LIVING_FILES.has(base) ? CACHE_REVALIDATE : CACHE_IMMUTABLE;
      const existing = await env.CONTENT.get(key);
      if (!existing) {
        skipped += 1;
        continue;
      }
      await env.CONTENT.put(key, existing.body, {
        httpMetadata: {
          contentType: existing.httpMetadata?.contentType ?? undefined,
          cacheControl,
        },
      });
      updated += 1;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return Response.json({ ok: true, updated, skipped }, { status: 200 });
}

// Delete one file by token (admin or editor). Token is used verbatim as the key.
async function deleteFile(env, slug, token) {
  const key = `${slug}/${token}`;
  if (!key.startsWith(`${slug}/`)) {
    return new Response('Invalid path', { status: 400 });
  }
  await env.CONTENT.delete(key);
  return Response.json({ ok: true, slug, key, url: fileUrl(env, slug, token) }, { status: 200 });
}
