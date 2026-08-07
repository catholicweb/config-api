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
 * EDITOR INVITE (gated by an admin secret — see authorizeAdmin):
 *   POST /sites/:slug/magic          — email an existing editor (by email) a magic link for an
 *                                       EXISTING slug, granting them edit capability. Body:
 *                                       { "email": "<addr>" }. No provisioning or creation.
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
 * WRITE (editor bearer token required):
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
 *   - per-slug editor tokens (256-bit random, stored as SHA-256 in the encrypted
 *     state): gate writes for that slug only. Tokens are minted via the magic-link
 *     exchange (POST /auth/magic), not returned directly at site creation.
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
 * exists AND its mapped slug equals the slug in the URL path AND (for email-bound
 * tokens) the email is in the slug's grant list. Tokens are 256-bit random values,
 * so their SHA-256 hashes are not brute-forceable.
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
    // already has edit access to. Open to all (like /sites/:slug/magic): it only
    // issues links and never grants access. The slug is resolved server-side from
    // the email grant, so the editor can offer an email-only login screen.
    if (segments.length === 2 && segments[0] === 'auth' && segments[1] === 'request' && method === 'POST') {
      return requestMagicLink(env, request);
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

      return createSite(env, slug, email);
    }

    // POST /sites/:slug/magic — issue a magic login link to an existing slug.
    // Open to all (no admin/editor required): issuing a link does not grant
    // access, which is still gated by the email grant checked at authorize after
    // the code is redeemed.
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
    } catch (err) {
      return Response.json(
        { error: 'internal error', detail: String(err?.message ?? err).slice(0, 200) },
        { status: 500 },
      );
    }
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

// Write the whole auth store back as a single encrypted blob. Returns
// { ok:true, error:null } on success, or { ok:false, error } when AUTH_KEY is
// missing/invalid and the store can't be encrypted. Never throws.
async function writeAuthState(env, state) {
  const blob = await encryptState(env, state);
  if (!blob) {
    return { ok: false, error: 'auth encryption key not configured (AUTH_KEY not set or invalid)' };
  }
  await env.CONTENT.put(AUTH_FILE, JSON.stringify(blob), {
    httpMetadata: { contentType: 'application/json' },
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

// Write a top-level JSON object store back to R2.
async function writeJsonMap(env, key, map) {
  await env.CONTENT.put(key, JSON.stringify(map), {
    httpMetadata: { contentType: 'application/json' },
  });
}

/**
 * Authorize an editor request for `slug`. The bearer token is SHA-256 hashed and
 * looked up directly in the single encrypted state (`state.tokens[sha256(token)]`).
 * The token is valid only if its mapped slug equals the URL slug. For email-bound
 * tokens, the bound email must also be listed in the slug's grant. (A token with
 * `email: null`, retained as a defensive leftover, passes on slug match alone.)
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
  if (!entry || entry.slug !== slug) {
    return { ok: false, status: 403, error: 'token not valid for this slug' };
  }
  if (entry.email == null) return { ok: true }; // email-less (defensive) token: no grant check

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
  return Response.json({ slug: entry.slug });
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

// Single encrypted credential store at the bucket root (replaces auth.json,
// magic.json, emails.json). Its plaintext payload is { emails, tokens, magic }.
const AUTH_FILE = 'auth.enc';
const AUTH_STATE_V = 1; // encrypted-blob format version

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
  // Legacy pre-marker slugs (a token/grant existed without a .site marker).
  const state = await readAuthState(env);
  if (!state) return false;
  for (const e of Object.values(state.tokens)) if (e && e.slug === slug) return true;
  for (const slugs of Object.values(state.emails)) {
    if (Array.isArray(slugs) && slugs.includes(slug)) return true;
  }
  return false;
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
async function createSite(env, slug, email) {
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

  // Grant the owner editor access (the encrypted email allowlist is the enforced
  // allowlist) and email them their first login link.
  const mres = await mutateState(env, (s) => addEmailGrant(s, normalizeEmail(email), slug));
  if (!mres.ok) return Response.json({ error: mres.error }, { status: 503 });

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
 * POST /sites/:slug/magic — email a one-time magic login link to `email` for an
 * EXISTING slug. Open to all: this only issues a login link and does NOT grant
 * access. The address must already be in the slug's email grant for the redeemed
 * token to actually be able to write. No Cloudflare provisioning or slug creation
 * happens here.
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
 * POST /auth/request — email a one-time magic login link to every slug the
 * `email` address already has edit access to. Open to all: like loginMagic it
 * only issues links and never grants access (authorize still checks the email
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
 * issueMagicLink).
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

  // Consume the code first so it cannot be reused, then mint the editor token.
  delete state.magic[codeHash];

  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  state.tokens[tokenHash] = { slug, email: record.email == null ? null : record.email };

  const res = await writeAuthState(env, state);
  if (!res.ok) return Response.json({ error: res.error }, { status: 503 });

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
