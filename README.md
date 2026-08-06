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
| POST   | `/sites/:slug`           | `Bearer admin`  | `:slug` validated, not reserved; body `{ "email": "<addr>" }` — provisions Cloudflare, copies the root `config.json` template into the site, grants `<email>` edit access, and emails a one-time magic link | `201 { ok, slug, sent, email }` / `400/401/403/409/502/503` |
| POST   | `/sites/:slug/magic`     | —               | `:slug` must exist; body `{ "email": "<addr>" }` — email a one-time magic **login** link; does NOT grant access | `200 { ok, slug, sent, email }` / `400/404/502/503` |
| POST   | `/sites/:slug/editors`   | `Bearer editor | admin` | `:slug` must exist; body `{ "email": "<addr>" }` — grant `<email>` edit access to the slug and email an invite/login link | `200 { ok, slug, sent, email }` / `400/401/403/404/502/503` |
| GET    | `/sites/:slug/editors`   | `Bearer editor | admin` | `:slug` must exist — list the emails granted write access to **this** slug only | `200 { ok, slug, editors: [...] }` / `400/401/403/404/503` |
| PATCH  | `/sites/:slug/editors`   | `Bearer editor | admin` | `:slug` must exist; body `{ "from": "<old>", "to": "<new>" }` — change an editor's email: re-grants `to` and re-binds `from`'s tokens so existing sessions keep working | `200 { ok, slug, from, to }` / `400/401/403/404/503` |
| DELETE | `/sites/:slug/editors`   | `Bearer editor | admin` | `:slug` must exist; body `{ "email": "<addr>" }` — remove the editor and revoke their tokens for this slug (grandfathered tokens can't be revoked) | `200 { ok, slug, email }` / `400/401/403/404/503` |
| POST   | `/auth/magic`            | —               | body `{ "code": "<64hex>" }` (one-time, from the email) | `200 { ok, slug, token }` / `400/404/410` |
| POST   | `/auth/request`          | —               | body `{ "email": "<addr>" }` — email a one-time magic **login** link to every slug the address can edit (resolved server-side from the email grant); never grants access; returns a generic success either way | `200 { ok, email }` / `400/503` |
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

# Create a site (admin only) — provisions Cloudflare, copies the root config.json
# template into the site, grants <email> edit access, and emails a one-time magic
# link. No token is returned; the owner exchanges the link for an editor token.
curl -X POST \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  --data '{"email":"owner@example.com"}' \
  https://api.parroquia.app/sites/<slug>

# Grant a co-editor access to an existing slug (editor token: write permission to
# the slug is enough to add new editors) and email them an invite/login link
curl -X POST \
  -H "Authorization: Bearer <EDITOR_TOKEN>" \
  -H "Content-Type: application/json" \
  --data '{"email":"coeditor@example.com"}' \
  https://api.parroquia.app/sites/<slug>/editors

# Email a magic LOGIN link to an inbox that already has access (open to all; does
# NOT grant access by itself). Use this to get a fresh token on a new device.
curl -X POST \
  -H "Content-Type: application/json" \
  --data '{"email":"owner@example.com"}' \
  https://api.parroquia.app/sites/<slug>/magic

# Email-only login (open to all): send a magic login link to every slug the inbox
# can edit. The slug(s) are resolved server-side from emails.json, so the editor can
# offer a form that asks only for an email. Returns a generic success either way to
# avoid revealing which addresses have access.
curl -X POST \
  -H "Content-Type: application/json" \
  --data '{"email":"owner@example.com"}' \
  https://api.parroquia.app/auth/request

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
  admin token. It gates `POST /sites/:slug` (site creation) and the editor-roster
  endpoints (`GET`/`POST`/`PATCH`/`DELETE /sites/:slug/editors`). Set with
  `npx wrangler secret put ADMIN_TOKEN_HASH` (prod) or in gitignored
  `.dev.vars` (local). The admin hash is never stored in the bucket.
- **Editor** tokens: 256-bit random hex values minted on magic-link exchange
  (`POST /auth/magic`), bound to the email that redeemed the code. All credential
  state lives in ONE encrypted blob `auth.enc` (AES-GCM-256, keyed by `AUTH_KEY`),
  holding `{ emails, tokens, magic }`. Inside the decrypted state the bearer token
  is SHA-256-hashed and looked up as `tokens[sha256(token)] → { slug, email }`. A
  request is authorized only if that entry exists **and** its mapped slug equals
  the slug in the URL path **and** the bound email is in that slug's `emails[...]`
  grant. Gates writes (`PUT`/`DELETE`) and, with the admin secret, the
  editor-management endpoints for that slug. Grandfathered tokens (bound
  `email: null`, migrated from the pre-email
  legacy format) are authorized on slug match alone.

### Magic-link login

`POST /sites/:slug` no longer returns a token. It takes the **site owner's email**
and kicks off magic-link login instead:

1. The admin authenticates with `ADMIN_TOKEN_HASH` and provides `{ "email" }`.
2. The worker provisions Cloudflare resources (as before), **copies the bucket-root
   `config.json` template into `<slug>/config.json`** as the site's initial content,
   **grants `<email>` edit access** in the encrypted email allowlist, and creates a
   **one-time magic code** (`generateToken()`, 64 hex chars), stored in the encrypted
   state **keyed by its SHA-256** with `{ slug, email, exp }` (expiry = 15 minutes).
3. It emails the owner a link via **Resend**:
   `MAGIC_LINK_BASE?slug=<slug>&code=<code>` (default base
   `https://editor.parroquia.app/magic`, overridable via the `MAGIC_LINK_BASE`
   var). The code is recorded only after the email is sent, so a delivery failure
   leaves nothing to roll back. **No token is returned.**
4. The owner clicks the link; the editor landing page posts `{ "code" }` to
   `POST /auth/magic`. Possession of the code proves ownership of the inbox.
5. The worker mints a fresh 256-bit editor token, stores
   `sha256(token) → { slug, email }` in the decrypted state, **deletes the code**
   (single-use), and returns `{ ok, slug, token }`.

**Managing co-editors** (gated by **either** the admin secret **or** an editor
token valid for the requesting editor's own slug; write permission grants the
ability to onboard others):

- **List** — `GET /sites/:slug/editors` returns the granted emails for this slug
  (recoverable because they live plaintext inside the encrypted blob).
- **Add** — `POST /sites/:slug/editors` grants the new email and emails an
  invite/login link. The new editor exchanges the link at `/auth/magic` for a token.
- **Remove** — `DELETE /sites/:slug/editors` with `{ "email" }` drops the slug from
  that email's grant and revokes its tokens for this slug. Grandfathered tokens
  (migrated from the pre-email legacy format) have no bound email and **cannot** be
  revoked here; a migrated editor keeps write access until they re-login via magic.
- **Rename** — `PATCH /sites/:slug/editors` with `{ "from", "to" }` re-grants the
  target email and re-binds the source's tokens to it, so the editor keeps their
  existing logged-in sessions across the address change.

**Requesting a fresh login link** (`POST /sites/:slug/magic`) is open to all and only
emails a link — it does **not** grant anything. The redeemed token only works if the
address is already in the slug's email grant.

**Email-only login** (`POST /auth/request`) removes the slug from the request: the
editor asks only for the address, and this endpoint emails a login link to **every**
slug that address is granted (one link per slug). It never grants anything, and it
deliberately returns the same generic `200 { ok, email }` whether or not the address
has access, so it cannot be used to enumerate which addresses are granted editors.

**Security notes:** the R2 bucket is **public**, but all credential data is encrypted
at rest in one `auth.enc` blob (AES-GCM-256 under `AUTH_KEY`), and **editor emails
never enter a site's `config.json`** (which *is* served publicly). Emails are stored
recoverably *inside* the encrypted blob — the worker can enumerate/remove/rename them,
but anyone without `AUTH_KEY` sees only ciphertext. Magic codes are stored keyed by
their SHA-256 and are single-use + expiring. Editor tokens are 256-bit random values
whose stored hashes are not brute-forceable. Trade-off: `AUTH_KEY` is the **single
point of failure** — the bucket is public and `auth.enc` is the only copy of every
token and grant, so losing it (or a decrypt failure) locks all editors out; back it up.
Also note `GET /editors` reveals co-editor emails to the admin or any valid token
holder for that slug — an intended consequence of recoverable emails, scoped to one slug.

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
config.json               default site template copied into every new site at creation (must exist)
auth.enc                  ALL credential state in ONE AES-GCM-256 encrypted blob
                          (decrypt with AUTH_KEY → { "emails": { "<email>": ["<slug>",...] },
                          "tokens": { "<sha256(token)>": { slug, email } },
                          "magic":  { "<sha256(code)>":   { slug, email, exp } } })
<slug>/.site              existence marker (outside token charset, un-writable by clients)
<slug>/<filename>         content file (validated flat filename)
slugs.json                { "slugs": [...] }  written on site creation
```

Everything is a **top-level single object** (no `magic/`-style prefix), so `GET /sites`
(which lists R2 delimited prefixes) never surfaces a synthetic slug — neither the root
`config.json` template nor `auth.enc` nor `slugs.json` appear under a slug prefix.

`auth.enc` replaces the old public `auth.json` + `magic.json` + `emails.json`. Emails
are stored **plaintext inside the encrypted blob** (recoverable, so the worker can
list/remove/rename editors) rather than as irreversible HMAC digests. Tokens and magic
codes stay keyed by their **SHA-256** for defense in depth. On first use after deploy,
a lazy migration reads any legacy `auth.json`/`magic.json`/`emails.json`, writes the
encrypted `auth.enc`, and deletes the legacy files. Legacy tokens become **grandfathered**
(`email: null`): they keep write access but aren't bound to an email, so they can't be
listed/removed/renamed by the editor endpoints, and their emails are irrecoverable.

## Files that must stay in sync

| File                 | Depends on                          |
|----------------------|--------------------------------------|
| `config-api/src/index.js` | validation (`FILENAME_RE`, `ALLOWED_EXT`), endpoint definitions |
| `editor/.../theme/lib/codec.js` | token encode/validate |
| `editor/.../theme/lib/api.js` | endpoint definitions, auth headers |
| `web-template/.../migrate.js` | token encode/validate, endpoint definitions, R2 layout |

Before changing **any** of: token rules, an endpoint, or the R2 layout, update
this README **and** every file above.

The magic-link + editor-permissions changes add `POST /auth/magic`,
`POST /sites/:slug/magic` (open login link) and the editor-management endpoints
(`GET`/`POST`/`PATCH`/`DELETE /sites/:slug/editors`), and change the
`POST /sites/:slug` body; `PUT`/`DELETE` file endpoints are unchanged. All credential
storage moved into the single encrypted `auth.enc` (see R2 layout). `codec.js` needs
no change; `migrate.js` (unchanged `PUT`/`GET`) is unaffected. This
`POST /auth/request` endpoint powers the editor's email-only login. The magic-link
**landing page** (at `MAGIC_LINK_BASE` — reads `?code=`, posts it to `POST /auth/magic`,
stores the returned token) and a **"manage editors" UI** (calls
`GET/POST/PATCH/DELETE /sites/:slug/editors` to list/add/rename/remove co-editors)
are follow-ups in the **editor** repo.

**Deploy prerequisite:** before creating any site, put a default `config.json` at
the **bucket root** — `createSite` copies it into every new site and returns `503`
if it is missing.

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
`no-reply@parroquia.app`), `AUTH_KEY` (base64 of 32 random bytes — the AES-256-GCM
key that encrypts/decrypts `auth.enc`; generate with `openssl rand -base64 32`).
Optional non-secret var: `MAGIC_LINK_BASE` (default
`https://editor.parroquia.app/magic`). For local dev, put them in gitignored
`.dev.vars`. See `wrangler.toml` comments.

> **⚠️ Back up `AUTH_KEY`.** The R2 bucket is public and `auth.enc` is the only copy
> of every editor token and grant. `EMAIL_HASH_SECRET` was removed: emails now live
> recoverably inside the encrypted blob instead of as HMAC digests. On first request
> after deploy, the worker migrates any legacy `auth.json`/`magic.json`/`emails.json`
> into `auth.enc` and deletes them — **that migration is one-way**. Losing `AUTH_KEY`
> after migration (or setting it wrong) makes `auth.enc` undecryptable and locks all
> editors out. Verify one authorized call in staging before trusting the migration,
> and snapshot the legacy files once if you want a fallback.

## GitHub

Canonical URL: <https://github.com/catholicweb/config-api>
