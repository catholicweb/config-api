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
   - `PUT`/`DELETE /sites/:slug/:token` — editor-gated writes (`putFile`/`deleteFile`)

Key helper groups (each has a `// ---` banner comment):
- **Validation** — `validateFilename`, `validateSlug`, `validateToken`,
  `validateSlugNotReserved`. The core of the path-traversal defense.
- **Crypto** — `sha256Hex`, `generateToken`, `timingSafeEqual`, `bearerToken`.
- **Auth** — `authorizeAdmin` (admin secret gate for site creation),
  `authorize` (editor token → slug check), `readAuthMap` (reads top-level `auth.json`).
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
   A token is valid for a slug only if its hash maps to that **exact** slug.
4. **Timing-safe comparison** — `timingSafeEqual` for both admin hash and editor
   token hash. `authorize`/`whoami` intentionally iterate *all* map entries with no
   early break to avoid leaking which hash matched.
5. **`.site` marker** (`SITE_MARKER = '.site'`) contains a dot, so it's outside the
   token charset and can never be written/overwritten by a client. It's skipped in
   `listFiles` and drives `/sites/list` via R2 delimited prefixes even before any
   content exists. Don't write a key a client could also write.

## Notable behaviors

- **`auth.json` read-modify-write races**: `createSite` reads, mutates, and writes
  back `auth.json`, so concurrent creations can lose a hash (last write wins).
  Acceptable — site creation is occasional admin bootstrapping, not mass-mint.
- **`readFile` is defined but unrouted**: there's no `GET /sites/:slug/:token`
  handler in `fetch`; reads are public from the data host. Don't add a public read
  route without reconsidering the auth model — `readFile` already requires an
  editor token, so wiring it up would change the public-read invariant.
- **Site creation provisions Cloudflare resources** via the API (Pages project,
  DNS CNAME `{slug}.parroquia.app` → `{slug}.pages.dev`, custom domain attach),
  each step idempotent. It requires `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
  `CLOUDFLARE_ZONE_ID` secrets and returns the minted token only once.
- **`slugs.json`** is re-scanned from the bucket on every creation so it always
  matches `/sites/list`, not just an append.
