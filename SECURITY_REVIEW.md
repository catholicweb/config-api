# Security Review — opus (2026-08-24)

Scope: `src/index.js`, `src/patch.js`, `README.md`, cross-repo sync (`editor` / `web-template`), `tests/`.
Branch: `feat/opus-security-review`. No merge performed.

## Possible attacks analyzed

### 1. Path / file traversal
- **Vector:** `%2e%2e` (%..) or `%2f` (%/) in path segments to escape the slug prefix.
- **Defense:** Percent-decode per segment (line 167) before regex; any decoded segment containing `/` returns `400 Bad path`; `FILENAME_RE` (`[A-Za-z0-9_-]` base + one optional extension) excludes dots except a single trailing one; R2 key is `${slug}/${token}` with a `!key.startsWith(
`${slug}/
)` guard (put/delete). Filename is never interpreted as a path server-side.
- **Remaining risk:** Low. The defense is layered; a future change that decodes the token server-side would evaporate safety (invariant #1 in CLAUDE.md).

### 2. Auth / token
- **Vector:** Timing side-channel on bearer validation; token brute-force; editor token reuse across slugs; defensive `email: null` token bypass.
- **Defense:** `timingSafeEqual` for admin hash (line 709); editor lookup is a direct key probe (`tokens[sha256(token)]`, line 743) rather than a sweep — 256-bit random hashes make timing on a single probe unexploitable for brute-force. Token is bound to `email`; grant enforced by `authorize` (email must be in slug's `emails` grant). Defensive `email: null` passes slug match only (line 743 comment); no legacy format exists.
- **Remaining risk:** Low. Concurrent `auth.enc` RMW is last-write-wins (CLAUDE.md L140); acceptable for occasional admin work, but not safe under concurrent minting.
- **Critical dependency:** `AUTH_KEY` is single point of failure (line 571 — strict 32-byte check, no migration). Back it up.

### 3. Patch / config mutation
- **Vector:** Malicious diff that injects keys, removes `.site`, corrupts `config.json`, or exploits `applyPatch` id-index cache.
- **Defense:** `patch.js` is byte-for-byte mirrored with `editor/.../patch.js`; `applyPatch` uses a WeakMap id index (line 274) and resolves `{ id }` segments strictly — missing item = no-op, never resurrects (last-edit-wins). `PATCH /sites/:slug/config.json` is scoped to `config.json` only; body capped at 5 MiB.
- **Remaining risk:** Low if mirroring stays intact (parity test `tests/unit/parity.test.js` guards it).

### 4. Deployment / network
- **Vector:** CORS misconfiguration; cache poisoning; Cloudflare Error 1014 from stale CNAME aimed at wrong `{slug}.pages.dev`; custom domain not re-attached.
- **Defense:** `OPTIONS` preflight returns `204` first (line 160). Cache-Control set per `CACHE_*` / `LIVING_FILES`. `getPagesProjectSubdomain` reads actual subdomain (may random-suffix); CNAME points there; `reprovisionSite` re-attaches non-`active` domain to force revalidation.
- **Remaining risk:** Low. Monitor `diag-sites.mjs` for mismatches.

### 5. Cross-repo sync
- **Vector:** `FILENAME_RE`, `ALLOWED_EXT`, `patch.js` diverge from `editor/codec.js`, `editor/patch.js`, `web-template/migrate.js`.
- **Defense:** `tests/unit/parity.test.js`; code comments warn explicitly. Do not edit `FILENAME_RE`/`ALLOWED_EXT` without updating the three consumer files.

## Recommended actions (implemented)
- Added security-focused tests (see `tests/unit/security-review.test.js`).
- Documented invariants and remaining risks above.
- No code changes to invariant-critical paths; only tests and documentation.
