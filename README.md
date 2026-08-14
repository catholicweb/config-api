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

### Media values are absolute URLs

The Worker returns **absolute public URLs** — not bare tokens, not `/media/...`
paths — for media. `GET /sites/:slug(/list)` returns `files: [...url...]` and
`PUT/DELETE /sites/:slug/:token` return a `url` field, each of the form
`https://data.parroquia.app/<slug>/<token>`. Consumers (the editor) treat them as
opaque absolute URLs and never decode them back to tokens; `<img src>` and
`og:image` use them directly, and the stored config field value is the absolute URL.

The origin is configurable via the `DATA_BASE` `[vars]` entry (default
`https://data.parroquia.app`), mirroring `MAGIC_LINK_BASE`. Storing/uploads still
use the flat validated filename as the R2 key (see [Token encoding](#token-encoding));
only the **returned** representation is an absolute URL.

## Single source of truth

This README canonicalizes the **contract** (endpoints, token rules, R2 layout).
`src/index.js` remains authoritative for **runtime behavior**. If this README and
the code ever disagree, **the code wins** and this README must be corrected.

## Endpoints

`X` placeholder = a validated flat filename (see [Token encoding](#token-encoding)).

| Method | Path                     | Auth            | Request                                            | Response |
|--------|--------------------------|-----------------|----------------------------------------------------|----------|
| GET    | `/health`                | —               | —                                                  | `200 { ok, bindings }` / `503` |
| GET    | `/whoami`                | `Bearer editor` | —                                                  | `200 { slug, email, slugs }` / `401` / `403` |
| GET    | `/sites`                 | —               | —                                                  | `200 { slugs: [...] }` |
| GET    | `/sites/:slug`           | —               | `:slug` validated (see slug rules)                 | `200 { slug, files: [...] }` / `400` |
| GET    | `/sites/list`            | —               | —                                                  | `200 { slugs: [...] }` *(legacy alias of `/sites`)* |
| GET    | `/sites/:slug/list`      | —               | `:slug` validated (see slug rules)                 | `200 { slug, files: [...] }` / `400` *(legacy alias of `/sites/:slug`)* |
| POST   | `/sites/:slug`           | `Bearer admin | editor` | `:slug` validated, not reserved; body `{ "email": "<addr>" }` — open to the admin or any editor who can edit at least one slug; provisions Cloudflare, copies the root `config.json` template into the site, grants `<email>` edit access, and emails a one-time magic link | `201 { ok, slug, sent, email }` / `400/401/403/409/502/503` |
| POST   | `/sites/:slug/magic`     | —               | `:slug` must exist; body `{ "email": "<addr>" }` — email a one-time magic **login** link; does NOT grant access | `200 { ok, slug, sent, email }` / `400/404/502/503` |
| POST   | `/sites/:slug/editors`   | `Bearer editor | admin` | `:slug` must exist; body `{ "email": "<addr>" }` — grant `<email>` edit access to the slug and email an invite/login link | `200 { ok, slug, sent, email }` / `400/401/403/404/502/503` |
| GET    | `/sites/:slug/editors`   | `Bearer editor | admin` | `:slug` must exist — list the emails granted write access to **this** slug only | `200 { ok, slug, editors: [...] }` / `400/401/403/404/503` |
| PATCH  | `/sites/:slug/editors`   | `Bearer editor | admin` | `:slug` must exist; body `{ "from": "<old>", "to": "<new>" }` — change an editor's email: re-grants `to` and re-binds `from`'s tokens so existing sessions keep working | `200 { ok, slug, from, to }` / `400/401/403/404/503` |
| DELETE | `/sites/:slug/editors`   | `Bearer editor | admin` | `:slug` must exist; body `{ "email": "<addr>" }` — remove the editor and revoke their tokens for this slug | `200 { ok, slug, email }` / `400/401/403/404/503` |
| POST   | `/auth/magic`            | —               | body `{ "code": "<64hex>" }` (one-time, from the email) | `200 { ok, slug, token, email, slugs }` / `400/404/410` |
| POST   | `/auth/request`          | —               | body `{ "email": "<addr>" }` — email a one-time magic **login** link to every slug the address can edit (resolved server-side from the email grant); never grants access; returns a generic success either way | `200 { ok, email }` / `400/503` |
| POST   | `/sites/backfill-cache`  | `Bearer admin`  | — maintenance: re-stamp `Cache-Control` metadata onto every existing bucket object so `data.parroquia.app` caches them (idempotent) | `200 { ok, updated, skipped }` / `401/403/503` |
| PUT    | `/sites/:slug/:token`    | `Bearer editor` | body = raw bytes, `Content-Type` optional. Writing `config.json` also triggers an automatic page build (best-effort, see [Auto-build](#auto-build)) | `200 { ok, slug, key, url }` / `400/401/403` |
| DELETE | `/sites/:slug/:token`    | `Bearer editor` | —                                                  | `200 { ok, slug, key, url }` / `400/401/403` |

**Reserved slugs** (rejected on site creation): `api`, `editor`, `www`, `data`.

Slug rules: single path segment, lowercase `[a-z0-9]` with optional internal
hyphens, 1–63 chars, no leading/trailing hyphen, no dots/slashes/underscores
(`SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/`). Slugs are deployed as
subdomains (`{slug}.parroquia.app`), and DNS is case-insensitive and cannot contain
`_` — this format is what the auto-build workflow accepts and prevents URL-equivalent
collisions.

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

# Create a site (admin or any editor who can edit a slug) — provisions Cloudflare,
# copies the root config.json template into the site, grants <email> edit access,
# and emails a one-time magic link. No token is returned; the owner exchanges the
# link for an editor token.
curl -X POST \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  --data '{"email":"owner@example.com"}' \
  https://api.parroquia.app/sites/<slug>
# An editor can create a site too — any editor token works; the site owner is the
# body email, just like the admin path.
curl -X POST \
  -H "Authorization: Bearer <EDITOR_TOKEN>" \
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
  admin token. It authenticates as admin for site creation (`POST /sites/:slug`)
  and the editor-roster endpoints (`GET`/`POST`/`PATCH`/`DELETE
  /sites/:slug/editors`) — accepted either on its own or alongside an editor token
  (no endpoint is admin-exclusive). Set with
  `npx wrangler secret put ADMIN_TOKEN_HASH` (prod) or in gitignored
  `.dev.vars` (local). The admin hash is never stored in the bucket.
- **Editor** tokens: 256-bit random hex values minted on magic-link exchange
  (`POST /auth/magic`), bound to the email that redeemed the code. All credential
  state lives in ONE encrypted blob `auth.enc` (AES-GCM-256, keyed by `AUTH_KEY`),
  holding `{ emails, tokens, magic }`. Inside the decrypted state the bearer token
  is SHA-256-hashed and looked up as `tokens[sha256(token)] → { slug, email }`. A
  request is authorized only if that entry exists **and** the bound email is in
  the URL slug's `emails[...]` grant — **one token covers every slug the email can
  edit** (multisession; the token's own `slug` field is not consulted). The editor
  learns the full slug roster from `GET /whoami` or the `POST /auth/magic`
  response and switches sites client-side without a new token. Revocation flows
  through the grant: removing an email from a slug's grant list immediately blocks
  the token there. Gates writes (`PUT`/`DELETE`) and, with the admin secret, the
  editor-management endpoints for that slug. An editor token valid for **any** slug
  also authorizes `POST /sites/:slug` (site creation), so a logged-in editor can
  create new sites; the new site's owner is the body `{ "email" }`, same as the
  admin path. Every editor token is bound to a plaintext email (there is no legacy
  format anymore).

### Magic-link login

`POST /sites/:slug` no longer returns a token. It takes the **site owner's email**
and kicks off magic-link login instead:

1. The caller authenticates with `ADMIN_TOKEN_HASH` (admin) or a token valid for
   any slug they can edit (editor) and provides `{ "email" }`.
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
   (single-use), and returns `{ ok, slug, token, email, slugs }` — the last two
   fields identify the bound email and every slug it can edit (the multisession
   roster), so the editor can offer a site switcher immediately.

**Managing co-editors** (gated by **either** the admin secret **or** an editor
token valid for the requesting editor's own slug; write permission grants the
ability to onboard others):

- **List** — `GET /sites/:slug/editors` returns the granted emails for this slug
  (recoverable because they live plaintext inside the encrypted blob).
- **Add** — `POST /sites/:slug/editors` grants the new email and emails an
  invite/login link. The new editor exchanges the link at `/auth/magic` for a token.
- **Remove** — `DELETE /sites/:slug/editors` with `{ "email" }` drops the slug from
  that email's grant and revokes that email's tokens for this slug.
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

Finally, site creation (`POST /sites/:slug`) provisions real Cloudflare resources
(Pages project, DNS CNAME, custom domain — requires `CLOUDFLARE_*` secrets) and
emails a magic link to the body `email`. Opening it to any authenticated editor
means any editor can mint new sites and email invites to arbitrary addresses — an
intended widening of the capability boundary, but worth knowing before granting
editor access to untrusted users.

### Page build & the Error 1014 custom-domain gotcha

A Pages custom domain (`{slug}.parroquia.app`) is served through a **proxied
CNAME pointing at the Pages project's actual `.pages.dev` subdomain**. Cloudflare
Pages assigns each project a pages.dev subdomain automatically — usually
`{slug}.pages.dev`, but it appends a **random suffix** (e.g. `plantilla-3mn`,
`base-1ef`) when the exact name is unavailable. The worker reads the project's
real subdomain (`getPagesProjectSubdomain`) and points the CNAME at **that**, so
the custom domain only becomes `active` once the project has a successful
production deployment (the `web-template` build workflow deploys automatically on
site creation and on every `config.json` save).

If instead a custom domain is pointed at an **assumed** `{slug}.pages.dev` that
the project doesn't actually own (its real subdomain is suffixed), Cloudflare
serves **Error 1014 ("CNAME Cross-User Banned")** on `https://{slug}.parroquia.app/`
and the domain stays `pending` — the CNAME resolves to an unclaimed/foreign
hostname Cloudflare can't attribute to the zone. This was a real bug: the old
code hardcoded `{slug}.pages.dev` as the CNAME target.

- **Diagnose:** `CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_ZONE_ID=…
  node diag-sites.mjs [slug …]` prints, per slug, the Pages project's real
  subdomain vs the current CNAME target, the latest production deployment status,
  the custom-domain status, and the zone DNS records (read-only — GET only).
  A mismatch between the project subdomain and the CNAME target means 1014.
- **Repair:** admin-gated `POST /sites/:slug/reprovision` re-runs provisioning
  (Pages project, then the DNS record — verified/generated against the project's
  **real** subdomain — then the custom domain), re-attaches the custom domain when
  it isn't `active` to force revalidation, and dispatches a build. It returns the
  `target` used, `domainStatus`, and a list of `actions`. Confirm with
  `curl -sI https://{slug}.parroquia.app/` → `200` (not `error code: 1014`).

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

`auth.enc` holds all credential state. Emails are stored **plaintext inside the
encrypted blob** (recoverable, so the worker can list/remove/rename editors) rather
than as irreversible HMAC digests. Tokens and magic codes stay keyed by their
**SHA-256** for defense in depth. `auth.enc` is created **lazily on the first
authorized write** — reading before that returns an empty state, so a fresh store
works with no `AUTH_KEY` until the first write. There is **no legacy migration**:
the old public `auth.json`/`magic.json`/`emails.json` are never read or deleted
(delete them manually if any remain).

## Files that must stay in sync

| File                 | Depends on                          |
|----------------------|--------------------------------------|
| `config-api/src/index.js` | validation (`FILENAME_RE`, `ALLOWED_EXT`), endpoint definitions (_`SLUG_RE` is **not** cross-repo-synced — it is intentionally stricter than `migrate.js` and subdomain-safe_) |
| `editor/.../theme/lib/codec.js` | token encode/validate |
| `editor/.../theme/lib/api.js` | endpoint definitions, auth headers |
| `web-template/.../migrate.js` | token encode/validate, endpoint definitions, R2 layout |

Before changing **any** of: token rules, an endpoint, the R2 layout, **or the
media URL representation** (now absolute URLs built from `DATA_BASE`), update this
README **and** every file above.

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

### Caching

`data.parroquia.app` is the R2 bucket published through a custom domain. R2 custom
domains only serve responses as cacheable when the **object itself carries a
`Cache-Control` header** (otherwise every read is `cf-cache-status: DYNAMIC`), so the
Worker writes that header into every object's `httpMetadata` at save time:

- **Hashed media** (`{slug}/<hashed-name>.webp`, everything that is not a *living*
  file) → `public, max-age=31536000, immutable`. Content-hashed filenames mean a
  change produces a new URL, so `immutable` is safe.
- **Living files** (`config.json`, `slugs.json`) → `public, max-age=0, must-revalidate`,
  so they never go stale.

Consumers that must stay fresh already bypass this: the editor reads with
`?_=<timestamp>` plus `fetch(..., {cache:'no-cache'})`, and `web-template` fetches
`config.json` only at build time with `cache:'no-cache'`. Any new consumer of a
living file should append a cache-busting query param (e.g. `?time={timestamp}`).

Objects written before this caching was added carry no header (still `DYNAMIC`).
Re-stamp the policy onto them (idempotent, admin-gated) with:

```bash
# admin bearer token — rewrites every object's Cache-Control metadata in place
curl -X POST https://api.parroquia.app/sites/backfill-cache \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# → { "ok": true, "updated": N, "skipped": M }
```

The Cloudflare CDN edge rules for both hosts live in `set-cache-rules.mjs`
(`*.parroquia.app/assets/*` immutable; other files `respect_origin`). Legacy Page
Rules were removed — Page Rules take precedence over Cache Rules and are redundant
here. `set-page-rules.mjs --clear` keeps them removed.

### Auto-build

Whenever a site's `config.json` is written — via `PUT /sites/:slug/config.json`, or
on site creation (`POST /sites/:slug`, which seeds `<slug>/config.json`) — the worker
best-effort dispatches the deploy workflow `catholicweb/web-template:deploy.yml`
(which accepts the site slug as its required `site_slug` input, then builds + deploys
the page to Cloudflare Pages).

The dispatch is **fire-and-forget**: the save/create response is returned
immediately (200/201) regardless of the dispatch outcome. A failure (e.g. missing
token, GitHub error, rate limit) is logged and never blocks the editor. If
`GITHUB_BUILD_TOKEN` is not set, the feature is simply off and nothing is dispatched.

Requires the `GITHUB_BUILD_TOKEN` secret (see [Deploy & secrets](#deploy--secrets)) on
the worker side, and on the GitHub side the `deploy.yml` workflow must keep exposing
its required `site_slug` input on `workflow_dispatch` — no other workflow change is
needed.

### Management scripts

All take `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID` from the environment, with a
`--dry-run`/`--list` first:

- `node set-cache-rules.mjs --apply` — write the 3 Cloudflare Cache Rules
  (media/`data.parroquia.app` and `*.parroquia.app/assets/*` immutable;
  other site files respect origin). PUTs replace the whole phase — review with
  `--list` first.
- `node set-page-rules.mjs --clear` — delete all legacy Page Rules.

## Deploy & secrets

```bash
npx wrangler deploy
```

Required secrets (set via `wrangler secret put`): `ADMIN_TOKEN_HASH`,
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`,
`RESEND_API_KEY` (email delivery), `FROM_EMAIL` (verified sender; defaults to
`no-reply@parroquia.app`), `AUTH_KEY` (base64 of 32 random bytes — the AES-256-GCM
key that encrypts/decrypts `auth.enc`; generate with `openssl rand -base64 32`).

**Optional** secret: `GITHUB_BUILD_TOKEN` — a fine-grained PAT, scoped to ONLY
`catholicweb/web-template` with `Actions: read and write` (classic PATs need broad
`repo` scope; not recommended). Enables [Auto-build](#auto-build) on `config.json`
writes; when unset the feature is off and saves still work.

Optional non-secret var: `MAGIC_LINK_BASE` (default
`https://editor.parroquia.app/magic`). For local dev, put them in gitignored
`.dev.vars`. See `wrangler.toml` comments.

> **⚠️ Back up `AUTH_KEY`.** The R2 bucket is public and `auth.enc` is the only copy
> of every editor token and grant. Emails live recoverably inside the encrypted blob
> (no HMAC digests). `AUTH_KEY` must be base64 of exactly 32 bytes; a missing or
> invalid key makes `auth.enc` unencryptable, so every write returns a `503` (`auth
> encryption key not configured`) and the credential store never gets created.
> There is **no migration** — `auth.enc` is created lazily on the first write. The
> worker also no longer reads or deletes legacy `auth.json`/`magic.json`/`emails.json`;
> delete them manually if any remain in the bucket.

## GitHub

Canonical URL: <https://github.com/catholicweb/config-api>
