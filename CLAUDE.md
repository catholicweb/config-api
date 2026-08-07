# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A single-file Cloudflare Worker (`src/index.js`) that stores content in one R2
bucket (`parroquia`, bound as `env.CONTENT`). It handles auth, listing, writes,
and site creation; it does **not** serve file bytes. Public reads come from a
separate static host (`data.parroquia.app/:slug/:token`), so there is deliberately
no `GET /sites/:slug/:token` route.

**`README.md` is the single source of truth** for the HTTP contract, the
token-encoding rules, and the R2 storage layout. `src/index.js` is authoritative
for runtime behavior — where the two disagree, the code wins and the README must
be corrected. This worker is consumed by `editor` and `web-template` in the parent
monorepo; see the parent `../CLAUDE.md` for the cross-repo sync rules.

## Commands

There is no build step, no test suite, and no lint script — the worker runs
directly from source.

```bash
# Local development — runs the worker against a local R2 store under .wrangler/
npm run dev        # == wrangler dev

# Deploy to Cloudflare Workers
npm run deploy     # == wrangler deploy
```

Style: match the existing committed source — **2-space indentation, single quotes**.
Do **not** run `npx prettier --write` on the file: the repo's `.prettierrc` declares
tabs while the committed code is 2-space indented, so prettier would reformat the
whole file into a huge unrelated diff. Format new code by hand to match the
surrounding lines.

Deploy gotchas:
- The custom domain `api.parroquia.app` is bound in the Cloudflare dashboard, not
  in `wrangler.toml` — the deploy token lacks Zone/Workers-Routes edit permission,
  so a `routes` entry makes `wrangler deploy` fail with auth error 10000. Don't
  add it back.
- Local secrets live in gitignored `.dev.vars`; production secrets via
  `npx wrangler secret put` (see `wrangler.toml` comments and README "Deploy & secrets").

## Architecture

`src/index.js` is one module exporting a `fetch` handler. Routing is manual
segment parsing (no framework) with percent-decoding and validation built in.

Request flow, in order:
1. Parse and **percent-decode each path segment before validation** (catches
   `%2e%2e` traversal, and rejects any decoded segment containing `/` — stops `%2f`
   smuggling past the router).
2. `OPTIONS` preflight returns `204` before anything else (required for CORS).
3. Dispatch by `segments` length + method:
   - `GET /health` — checks the R2 binding responds (`handleHealth`)
   - `GET /whoami` — resolves a bearer token to its slug (`whoami`)
   - `GET /sites/list`, `GET /sites/:slug/list` — listing (`listSlugs`/`listFiles`)
   - `POST /sites/:slug` — admin-gated site creation (`createSite`)
   - `POST /sites/:slug/magic` — open login-link issuance (`loginMagic`)
   - `GET`/`POST`/`PATCH`/`DELETE /sites/:slug/editors` — editor management
     gated by admin OR an editor token for the slug
     (`listEditors`/`addEditor`/`updateEditor`/`removeEditor`)
   - `PUT`/`DELETE /sites/:slug/:token` — editor-gated writes (`putFile`/`deleteFile`)

Key helper groups (each has a `// ---` banner comment):
- **Validation** — `validateFilename`, `validateSlug`, `validateToken`,
  `validateSlugNotReserved`. The core of the path-traversal defense.
- **Crypto** — `sha256Hex`, `generateToken`, `timingSafeEqual`, `bearerToken`,
  plus the AES-GCM state helpers (`authKey`, `encryptState`, `decryptState`,
  `bytesToBase64`/`base64ToBytes`) for `auth.enc`. (HMAC email hashing was removed.)
- **Auth** — `authorizeAdmin` (admin secret gate for site creation),
  `authorize` (editor token → slug + email-grant check), `authorizeAdminOrEditor`
  (admin **or** editor-token gate for the /editors roster), and the encrypted-state
  helpers `readAuthState`/`writeAuthState`/`mutateState`. All
  credential data lives in ONE AES-GCM-256 blob `auth.enc` at the bucket root
  (decrypted under `AUTH_KEY` to `{ emails, tokens, magic }`), created lazily on
  the first write. Editor tokens are bound to a plaintext
  email (`tokens[sha256(token)] = { slug, email }`); the **recoverable** `emails`
  grant (`email → [slugs]`, enforced by `authorize`) is the editor allowlist —
  it never lives in the public `config.json`. `issueMagicLink`
  only mints a login link; granting is explicit (`createSite` seed,
  `POST /sites/:slug/editors`).
- **Cloudflare provisioning** — `cfFetch`, `ensurePagesProject`, `ensureDnsRecord`,
  `ensureCustomDomain`. One idempotent "ensure" step per Cloudflare resource.
- **Handlers** — one per endpoint.

## Security invariants (do not break)

1. **Never decode a filename/token server-side.** Filenames are validated then used
   **verbatim** as the R2 key (`key = `${slug}/${token}``). All path semantics live
   in the client. Refusing to interpret tokens as paths is what makes traversal
   structurally impossible — a future change that decodes them server-side
   evaporates that safety.
2. **Validation charset** — filename base is `[A-Za-z0-9_-]`, one optional
   allowlisted trailing extension, no leading `-`, max 255 chars. `FILENAME_RE`
   and `ALLOWED_EXT` **must stay byte-identical** to `editor/.../codec.js` and
   `web-template/.../migrate.js` (see parent CLAUDE.md).
3. **Slug** — `SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/`; reserved: `api, editor, www, data`.
   A token is valid for a slug only if `tokens[sha256(token)].slug` equals that
   **exact** slug, **and** (for email-bound tokens) its bound email is in the slug's
   `emails` grant. (A defensive token with `email: null`, should one exist, passes
   on slug match alone — there is no migrated legacy format anymore.)
4. **Timing-safe comparison** — `timingSafeEqual` is still used for the admin token
   hash (`authorizeAdmin`). Editor token lookups use a **direct** `tokens[sha256(token)]`
   object probe rather than the old all-entries sweep: token hashes are 256-bit random,
   so a timing side channel on a single key probe leaks nothing brute-forceable.
5. **`.site` marker** (`SITE_MARKER = '.site'`) contains a dot, so it's outside the
   token charset and can never be written/overwritten by a client. It's skipped in
   `listFiles` and drives `/sites/list` via R2 delimited prefixes even before any
   content exists. Don't write a key a client could also write.

## Notable behaviors

- **Caching** — every `env.CONTENT.put` sets `httpMetadata.cacheControl` from the
  `CACHE_*` constants: hashed media gets `public, max-age=31536000, immutable`, and
  `LIVING_FILES` (`config.json`, `slugs.json`) get `public, max-age=0, must-revalidate`.
  This is required because the R2 custom domain `data.parroquia.app` only caches
  responses that carry their own Cache-Control header (else `cf-cache-status: DYNAMIC`);
  rules in `set-cache-rules.mjs` are belt-and-suspenders. Pre-existing objects are
  re-stamped in place by the admin-gated `POST /sites/backfill-cache` handler
  (`backfillCache`), which re-applies the same `CACHE_*`/`LIVING_FILES` policy
  bucket-wide. See README "Caching".
- **`auth.enc` read-modify-write races**: every credential mutation reads, mutates,
  and writes back the single encrypted `auth.enc`, so concurrent mutations can lose
  an update (last write wins — R2 has no CAS here). This aggregates the old
  per-file races into one file but is no worse per-operation; acceptable given the
  occasional-administration workload, not mass concurrent minting.
- **`AUTH_KEY` is the single point of failure.** `auth.enc` is the only copy of every
  token and grant (the bucket is public). It must be base64 of exactly 32 bytes; a
  missing or invalid key means encrypts fail (every write returns `503`, `auth
  encryption key not configured`) and decrypts fail (`readAuthState` → null → handlers
  503). There is no migration — `auth.enc` is created lazily on the first write and
  reads of a missing `auth.enc` return an empty state. Back `AUTH_KEY` up.
- **`readFile` is defined but unrouted**: there's no `GET /sites/:slug/:token`
  handler in `fetch`; reads are public from the data host. Don't add a public read
  route without reconsidering the auth model — `readFile` already requires an
  editor token, so wiring it up would change the public-read invariant.
- **Site creation provisions Cloudflare resources** via the API (Pages project,
  DNS CNAME `{slug}.parroquia.app` → `{slug}.pages.dev`, custom domain attach),
  each step idempotent. It requires `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
  `CLOUDFLARE_ZONE_ID` secrets. It then seeds the site from the **bucket-root
  `config.json` template** (copied to `<slug>/config.json`; a `503` if the template
  is missing) and returns the minted token only once.
- **`slugs.json`** is re-scanned from the bucket on every creation so it always
  matches `/sites/list`, not just an append.
