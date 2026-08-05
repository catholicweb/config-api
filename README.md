# parroquia-config-api

> **THIS FILE IS THE SINGLE SOURCE OF TRUTH** for the config-api HTTP contract,
> the token-encoding rules, and the R2 storage layout.
>
> The implementations below "talk" to each other across repos and MUST stay in
> sync with this doc:
>
> - `config-api/src/index.js` — server (validation + endpoints)
> - `editor/docs/.vitepress/theme/lib/codec.js` — browser encode/validate
> - `editor/docs/.vitepress/theme/lib/api.js` — browser API client
> - `web-template/docs/.vitepress/migrate.js` — Node sync script
>
> Those files carry this README as their pointer target. If a behavior change is
> needed, update this README **AND** all consumer/implementor copies.

## Overview

A Cloudflare Worker exposed at **`https://api.parroquia.app`**, backed by a single
R2 bucket (`parroquia`, bound as `env.CONTENT`).

- **Writes / listing / auth** go through the Worker.
- **Reading file bytes** is served publicly (no auth) from a separate static host
  at `https://data.parroquia.app/:slug/:token`. There is deliberately **no**
  `GET /sites/:slug/:token` route on the Worker — content is public, so reads
  never need the Worker.

## Single source of truth

This README canonicalizes the **contract** (endpoints, token rules, R2 layout).
`src/index.js` remains authoritative for **runtime behavior**. If this README and
the code ever disagree, **the code wins** and this README must be corrected.

## Endpoints

`X` placeholder = a validated flat filename (see [Token encoding](#token-encoding)).

| Method | Path                     | Auth            | Request                                            | Response |
|--------|--------------------------|-----------------|----------------------------------------------------|----------|
| GET    | `/health`                | —               | —                                                  | `200 { ok, bindings }` / `503` |
| GET    | `/whoami`                | `Bearer editor` | —                                                  | `200 { slug }` / `401` / `403` |
| GET    | `/sites`                 | —               | —                                                  | `200 { slugs: [...] }` |
| GET    | `/sites/:slug`           | —               | `:slug` validated (see slug rules)                 | `200 { slug, files: [...] }` / `400` |
| GET    | `/sites/list`            | —               | —                                                  | `200 { slugs: [...] }` *(legacy alias of `/sites`)* |
| GET    | `/sites/:slug/list`      | —               | `:slug` validated (see slug rules)                 | `200 { slug, files: [...] }` / `400` *(legacy alias of `/sites/:slug`)* |
| POST   | `/sites/:slug`           | `Bearer admin`  | `:slug` validated, not reserved; body `{ "email": "<addr>" }` | `201 { ok, slug, sent, email }` / `400/401/403/409/502/503` |
| POST   | `/auth/magic`            | —               | body `{ "code": "<64hex>" }` (one-time, from the email) | `200 { ok, slug, token }` / `400/404/410` |
| PUT    | `/sites/:slug/:token`    | `Bearer editor` | body = raw bytes, `Content-Type` optional          | `200 { ok, slug, key }` / `400/401/403` |
| DELETE | `/sites/:slug/:token`    | `Bearer editor` | —                                                  | `200 { ok, slug, key }` / `400/401/403` |

**Reserved slugs** (rejected on site creation): `api`, `editor`, `www`, `data`.

Slug rules: single path segment, no dots/slashes, cannot start with `-` or `_`
(`SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/`).

### Examples (curl)

```bash
# Health
curl https://api.parroquia.app/health

# Resolve an editor token to its slug
curl -H "Authorization: Bearer <EDITOR_TOKEN>" https://api.parroquia.app/whoami

# List all slugs / list files under a slug
curl https://api.parroquia.app/sites
curl https://api.parroquia.app/sites/<slug>
# Legacy aliases still work: /sites/list and /sites/<slug>/list

# Create a site (admin only) — provisions Cloudflare and emails <email> a one-time
# magic link. No token is returned; the owner exchanges the link for an editor token.
curl -X POST \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  --data '{"email":"owner@example.com"}' \
  https://api.parroquia.app/sites/<slug>

# Exchange a one-time magic code (from the emailed link) for an editor token
curl -X POST -H "Content-Type: application/json" \
  --data '{"code":"<ONE_TIME_CODE>"}' \
  https://api.parroquia.app/auth/magic

# Write a file (editor token); body is the raw bytes
curl -X PUT \
  -H "Authorization: Bearer <EDITOR_TOKEN>" \
  -H "Content-Type: text/markdown" \
  --data-binary @noticias.md \
  https://api.parroquia.app/sites/<slug>/noticias.md

# Delete a file (editor token)
curl -X DELETE -H "Authorization: Bearer <EDITOR_TOKEN>" \
  https://api.parroquia.app/sites/<slug>/noticias.md

# Read a file (public, no auth) — from the data host, not the Worker
curl https://data.parroquia.app/<slug>/noticias.md
```

## Auth model

Two capabilities:

- **Admin** (`ADMIN_TOKEN_HASH`): a Worker secret holding the SHA-256 hex of the
  admin token. It gates **only** `POST /sites/:slug`. Set with
  `npx wrangler secret put ADMIN_TOKEN_HASH` (prod) or in gitignored
  `.dev.vars` (local). The admin hash is never stored in the bucket.
- **Editor** tokens: 256-bit random hex values minted on magic-link exchange
  (`POST /auth/magic`). The bearer token is SHA-256-hashed and looked up in the
  top-level `auth.json` object (`{ "<sha256(token)>": "<slug>" }`). A request is
  authorized only if the hash exists **and** its mapped slug equals the slug in
  the URL path. Gates writes (`PUT`/`DELETE`) for that slug.

### Magic-link login

`POST /sites/:slug` no longer returns a token. It takes the **site owner's email**
and kicks off magic-link login instead:

1. The admin authenticates with `ADMIN_TOKEN_HASH` and provides `{ "email" }`.
2. The worker provisions Cloudflare resources (as before) and creates a **one-time
   magic code** (`generateToken()`, 64 hex chars), stored **only as its SHA-256** in
   `magic.json` with `{ slug, emailHash, exp }` (expiry = 15 minutes).
3. It emails the owner a link via **Resend**:
   `MAGIC_LINK_BASE?slug=<slug>&code=<code>` (default base
   `https://editor.parroquia.app/magic`, overridable via the `MAGIC_LINK_BASE`
   var). If delivery fails, the pending magic record is rolled back so the POST
   is retryable. **No token is returned.**
4. The owner clicks the link; the editor landing page posts `{ "code" }` to
   `POST /auth/magic`. Possession of the code proves ownership of the inbox.
5. The worker mints a fresh 256-bit editor token (sha256 → slug in `auth.json`),
   **deletes the code from `magic.json`** (single-use), and returns `{ ok, slug, token }`.

**Security notes:** the R2 bucket is **public**, so nothing secret ever lives in it.
Magic codes are stored only as one-way SHA-256 hashes and are single-use + expiring.
Email addresses are likewise **not stored in plaintext** — `emails.json` is keyed by
`hmac-sha256(EMAIL_HASH_SECRET, trim(lower(email)))`. A *plain* sha256 of an email
would be trivially brute-forceable (small input space), so the digest is **keyed**
with the `EMAIL_HASH_SECRET` secret; the real address only travels in the outbound
email. Editor tokens are 256-bit random values whose hashes are not brute-forceable.

## Token encoding

File keys are **flat, validated filenames** — **not base64**, not opaque random
tokens. Clients encode a local relative path by flattening it:

- Base charset `[A-Za-z0-9_-]` (URL-safe filename alphabet).
- `/` is flattened to `-` (the client does this; the server never interprets a
  filename as a path — that is the core anti-traversal invariant).
- At most **one** trailing dotted extension, and only from the allowlist:
  `md jpg jpeg png gif webp pdf json`.
- No leading `-` (CLI-arg injection guard).
- Max 255 chars (filesystem limit).

Validation regex (must stay identical in all copies):

```js
const FILENAME_RE = /^[A-Za-z0-9_-]+(\.[a-z0-9]{1,5})?$/;
const ALLOWED_EXT = ['md', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'json'];
```

The server validates filenames and uses them **verbatim** as the R2 key. It never
decodes them back to paths. All path semantics live in the client.

## R2 storage layout

```
auth.json                 { "<sha256(token)>": "<slug>" }
magic.json                { "<sha256(code)>": { "slug", "emailHash", "exp" } }   pending one-time magic links
emails.json               { "<hmac-sha256(email)>": ["<slug>", ...] }           email → slug edit grants (keyed)
<slug>/.site              existence marker (outside token charset, un-writable by clients)
<slug>/<filename>         content file (validated flat filename)
slugs.json                { "slugs": [...] }  written on site creation
```

All stores are **top-level single-file JSON objects** (no `magic/`-style prefix), so
`GET /sites` (which lists R2 delimited prefixes) never surfaces a synthetic slug.
Magic codes and emails are keyed by **SHA-256** only (the bucket is public).

## Files that must stay in sync

| File                 | Depends on                          |
|----------------------|--------------------------------------|
| `config-api/src/index.js` | validation (`FILENAME_RE`, `ALLOWED_EXT`), endpoint definitions |
| `editor/.../theme/lib/codec.js` | token encode/validate |
| `editor/.../theme/lib/api.js` | endpoint definitions, auth headers |
| `web-template/.../migrate.js` | token encode/validate, endpoint definitions, R2 layout |

Before changing **any** of: token rules, an endpoint, or the R2 layout, update
this README **and** every file above.

The magic-link change is **additive**: it adds `POST /auth/magic`, changes the
`POST /sites/:slug` request body, and adds `magic.json`/`emails.json`, but the
editor-token format and all `PUT`/`GET`/`DELETE` endpoints are unchanged, so
`api.js`, `codec.js`, and `migrate.js` need **no** changes. The editor-side
magic-link **landing page** (at `MAGIC_LINK_BASE` — reads `?code=`, posts it to
`POST /auth/magic`, stores the returned token) is a follow-up in the **editor** repo.

## Public read host

`https://data.parroquia.app/:slug/:token` — serves raw file bytes with **no
auth**. The Worker's `/sites/:slug/list` returns which filenames exist; the byte
content is always fetched from the data host. The editor forces cache revalidation
and never shows stale content.

## Deploy & secrets

```bash
npx wrangler deploy
```

Required secrets (set via `wrangler secret put`): `ADMIN_TOKEN_HASH`,
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`,
`RESEND_API_KEY` (email delivery), `FROM_EMAIL` (verified sender; defaults to
`no-reply@parroquia.app`), `EMAIL_HASH_SECRET` (≥32 random bytes — keyed-hashes
emails in `emails.json`). Optional non-secret var: `MAGIC_LINK_BASE` (default
`https://editor.parroquia.app/magic`). For local dev, put them in gitignored
`.dev.vars`. See `wrangler.toml` comments.

## GitHub

Canonical URL: <https://github.com/catholicweb/config-api>
