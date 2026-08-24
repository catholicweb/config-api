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
| POST   | `/sites/:slug`           | `Bearer admin | editor` | `:slug` validated, not reserved; body `{ "email": "<addr>" }` — open to the admin or any editor who can edit at least one slug; provisions Cloudflare, copies the root `config.json` template into the site, grants `<email>` edit access, and emails a one-time magic link | `201 { ok, slug, sent, email }` / `400/401/403/409/502/503` |
| POST   | `/sites/:slug/editors`   | `Bearer editor | admin` | `:slug` must exist; body `{ "email": "<addr>" }` — grant `<email>` edit access to the slug and email an invite/login link | `200 { ok, slug, sent, email }` / `400/401/403/404/502/503` |
| GET    | `/sites/:slug/editors`   | `Bearer editor | admin` | `:slug` must exist — list the emails granted write access to **this** slug only | `200 { ok, slug, editors: [...] }` / `400/401/403/404/503` |
| PATCH  | `/sites/:slug/editors`   | `Bearer editor | admin` | `:slug` must exist; body `{ "from": "<old>", "to": "<new>" }` — change an editor's email: re-grants `to` and re-binds `from`'s tokens so existing sessions keep working | `200 { ok, slug, from, to }` / `400/401/403/404/503` |
| DELETE | `/sites/:slug/editors`   | `Bearer editor | admin` | `:slug` must exist; body `{ "email": "<addr>" }` — remove the editor and revoke their tokens for this slug | `200 { ok, slug, email }` / `400/401/403/404/503` |
| POST   | `/auth/magic`            | —               | body `{ "code": "<64hex>" }` (one-time, from the email) | `200 { ok, slug, token }` / `400/404/410` |
| POST   | `/auth/request`          | —               | body `{ "email": "<addr>" }` — email a one-time magic **login** link to every slug the address can edit (resolved server-side from the email grant); never grants access; returns a generic success either way | `200 { ok, email }` / `400/503` |
| POST   | `/sites/backfill-cache`  | `Bearer admin`  | — maintenance: re-stamp `Cache-Control` metadata onto every existing bucket object so `data.parroquia.app` caches them (idempotent) | `200 { ok, updated, skipped }` / `401/403/503` |
| POST   | `/sites/:slug/clone`    | `Bearer admin`  | body `{ "targetSlug": "<slug>" }` — clone all content (files, email grants, config.json media URL rewriting) from an existing slug to a new slug; provisions Cloudflare for the target; does not modify the source | `201 { ok, sourceSlug, targetSlug, filesCopied, domainStatus }` / `400/401/403/404/409/502/503` |
| DELETE | `/sites/:slug`          | `Bearer admin`  | — delete a site entirely: best-effort Cloudflare resource cleanup, then remove all R2 content, clean up auth.enc grants/tokens/magic, re-scan slugs.json | `200 { ok, slug, filesDeleted, cfWarnings? }` / `400/401/403/404/503` |
| POST   | `/api/fcm/token`       | —               | body `{ "token": "<fcm-token>", "site": "<slug>" }` — subscribe the FCM registration token to the site's topic (topic = `site`). Open to all. Uses `FCM_SERVER_KEY` Worker secret, which is also used by the [daily cron](#fcm-notifications) to send topic messages for tomorrow's calendar events. | `200 { ok: true }` / `400` |
| PUT    | `/sites/:slug/:token`    | `Bearer editor | admin` | body = raw bytes, `Content-Type` optional. Writing `config.json` also triggers an automatic page build (best-effort, see [Auto-build](#auto-build)) | `200 { ok, slug, key }` / `400/401/403` |
| PATCH  | `/sites/:slug/config.json` | `Bearer editor` | body `{ "ops": [...] }` — apply a small **diff** onto the currently stored `config.json` and return the merged doc (used by the editor for small, per-field, last-edit-wins concurrent saves; see [Patch saves](#patch-saves)). Also triggers an automatic page build | `200 { ok, slug, key, data, skipped }` / `400/401/403/404/500` |
| DELETE | `/sites/:slug/:token`    | `Bearer editor | admin` | —                                                  | `200 { ok, slug, key }` / `400/401/403` |

**Reserved slugs** (rejected on site creation and cloning): `api`, `editor`, `www`, `data`.

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

# Clone a site (admin only) — copy all content from an existing slug to a new one
curl -X POST \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  --data '{"targetSlug":"new-slug-name"}' \
  https://api.parroquia.app/sites/<slug>/clone

# Delete a site entirely (admin only) — removes content, Cloudflare resources,
# and auth entries
curl -X DELETE -H "Authorization: Bearer <ADMIN_TOKEN>" \
  https://api.parroquia.app/sites/<slug>

# Read a file (public, no auth) — from the data host, not the Worker
curl https://data.parroquia.app/<slug>/noticias.md

# Subscribe an FCM token to a site's topic (called by the browser via PWA.vue;
# the browser can't subscribe tokens to topics itself — see firebase/firebase-js-sdk#5289)
curl -X POST https://api.parroquia.app/api/fcm/token \
  -H "Content-Type: application/json" \
  --data '{"token":"<FCM_REGISTRATION_TOKEN>","site":"<slug>"}'
```

#### FCM Notifications

In addition to token subscription, `FCM_SERVER_KEY` powers a **daily cron** that
sends push notifications for tomorrow's calendar events to each site's FCM
topic (`/topics/<slug>`). The cron runs at **19:00 UTC** (see `[[triggers]]` in
`wrangler.toml`) and works as follows:

1. Reads `slugs.json` from R2 to get the list of all deployed site slugs.
2. For each slug, fetches the already-processed `calendar.json` from the deployed
   Pages site at `https://{slug}.parroquia.app/calendar.json?time={now}` (the
   `?time=` cache-buster bypasses Cloudflare CDN for freshness).
3. Filters events where `applyComplexFilter(event, "byday:empty") && isTomorrow(event.dates[0])`.
4. Groups the filtered events by `["title", "times", "locations", "images"]` using
   the shared `groupEvents()` utility (copied from web-template's
   `docs/.vitepress/utils.js` into `src/utils.js`).
5. Sends an FCM HTTP API message to `to: "/topics/<slug>"` per event group, with
   the notification title, body, icon, and a `fcm_options.link` pointing to the
   site so the user lands on the right page when they tap the notification.

### Slug renaming

There is no single "rename" endpoint. Renaming a slug is a two-step process
using the clone and delete endpoints:

1. `POST /sites/:slug/clone` with `{ "targetSlug": "<new-name>" }` — copies all
   files, email grants, and provisions Cloudflare for the new slug. A build is
   dispatched for the new slug (fire-and-forget).
2. `DELETE /sites/:slug` — removes the old slug's content, Cloudflare resources,
   and auth entries.

Clone does NOT modify the source slug, so the delete step is always optional
— you can keep the old slug as a permanent alias.

**Limitations:**
- Legacy email-less editor tokens (very old tokens with `email: null`) are NOT
  granted access to the cloned slug. Only email-bound tokens (the current token
  model) are automatically carried over via the email grant copy.
- Config.json media URLs are rewritten from
  `https://data.parroquia.app/<old-slug>/` to
  `https://data.parroquia.app/<new-slug>/` during cloning. Other files are
  copied verbatim.
- Cloudflare Pages builds are dispatched for the new slug only (fire-and-forget).
  The old slug's build is not affected.

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
  request is authorized only if that entry exists **and** its mapped slug equals
  the slug in the URL path **and** the bound email is in that slug's `emails[...]`
  grant. Gates writes (`PUT`/`DELETE`) and, with the admin secret, the
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
   (single-use), and returns `{ ok, slug, token }`.

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
| `config-api/src/patch.js` | **mirrored byte-for-byte** with `editor/.../theme/lib/patch.js` (diff/apply convention; see [Patch saves](#patch-saves)) |
| `editor/.../theme/lib/codec.js` | token encode/validate |
| `editor/.../theme/lib/api.js` | endpoint definitions, auth headers |
| `editor/.../theme/lib/patch.js` | **mirrored byte-for-byte** with `config-api/src/patch.js` (diff/apply convention); the editor's `diff` half |
| `editor/.../theme/lib/schema.js` | `ID_KEY` / `injectId` — must equal `ID_KEY` in the patch mirrors |
| `web-template/.../migrate.js` | token encode/validate, endpoint definitions, R2 layout |

Before changing **any** of: token rules, an endpoint, or the R2 layout, update
this README **and** every file above.

The magic-link + editor-permissions changes add `POST /auth/magic` and the
editor-management endpoints
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

## Patch saves

`config.json` is edited concurrently by several people. Instead of the editor
overwriting the whole file (which clobbers unrelated concurrent edits and can
exceed the keepalive body cap on the on-leave flush), the editor sends a small
**diff** that this API applies onto its *current* stored document.

The diff/apply convention lives in `src/patch.js`, **mirrored byte-for-byte** with
`editor/.../theme/lib/patch.js` (same pattern as `codec.js`). It is 100%
**data-guided** — no schema is needed on the server:

- An array whose every item is a plain object with a non-empty string `id` is
  a **keyed** list → diffed/addressed by that stable id. The editor's schema
  injects a hidden `id` default into every object-list/block-list (see
  `schema.js`), so per-field edits within an item are last-edit-wins even against
  a concurrently-updated base, and a concurrently-removed item is never
  resurrected (a `{ id }` that no longer resolves is a harmless no-op).
- **Any other array** (scalars, or objects lacking `id`) is **keyless** → on
  change it is replaced wholesale by one absolute `set`.

Op vocabulary (a `path` is an array of string keys and/or `{ id }` segments):

| Op | Shape | Meaning |
|----|-------|---------|
| `set` | `{ op, path, value }` | absolute-assign at `path` |
| `remove` | `{ op, path }` | delete an object key, or (last segment `{ id }`) remove that keyed list item; no-op if absent |
| `listAdd` | `{ op, path, id, index, value }` | insert a new keyed item |
| `listReorder` | `{ op, path, ids }` | set the list's id order (appends any current items not named, so concurrent adds are never dropped) |

The endpoint returns `{ ok, slug, key, data, skipped }`, where `data` is the
**merged** document — the editor adopts it back to preserve multi-editor
freshness and to pick up server-side additions.

**First save after the editor loads is still a full `PUT`** (hydration): the
`PUT` persists the schema-backfilled ids server-side so subsequent `{ id }`
patch ops can resolve. Only later saves are patches.

**Known trade-off:** two concurrent PATCHes that read the same base can, at the
R2 read-modify-write boundary, lose a different-field change (there is no CAS /
etag on document content — the same limitation as today's concurrent PUTs).
Per-field last-edit-wins mitigates same-field races; acceptable for occasional
co-editing.

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
key that encrypts/decrypts `auth.enc`; generate with `openssl rand -base64 32`),
and `FCM_SERVER_KEY` (Firebase Cloud Messaging server key — used both by
`POST /api/fcm/token` to subscribe browser tokens to per-site topics AND by the
daily cron (`src/notifications.js`, see [FCM Notifications](#fcm-notifications))
to send topic messages for tomorrow's calendar events to each site's
`/topics/<slug>` topic).

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

## opus-youtube-subscriptions
Config.json may include `info.social` with YouTube channels. The worker tracks
current PubSubHubbub subscriptions in `<slug>/config.json` under `dev.subscribedto[]`
(channel IDs only). When config.json is edited, new channels are subscribed and
added to the array (quick zero-file-read check). A secret-token-protected
`POST /webhook/youtube?token=<WEBHOOK_SECRET>` endpoint receives PubSubHubbub
updates; when a new video arrives it triggers `githubDispatch` for the slug.
Requires `PUBSUBHUBBUB_HUB`, `WEBHOOK_SECRET` env (optional; subscribe is
best-effort and never blocks saves).

## GitHub

Canonical URL: <https://github.com/catholicweb/config-api>
