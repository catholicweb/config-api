# Security notes

## Path traversal: defense in depth

R2 keys are flat strings, not filesystem paths: `a/../b` is just a key containing
dots and slashes, so R2 has no `..` to resolve. Traversal is therefore not
exploitable *at the storage layer*. We still keep the validation as defense in
depth, because the same names also flow into other places that DO interpret
paths: URLs (`data.parroquia.app/:slug/:file`), the client-side codec, the
web-template sync script (`migrate.js`) and CI jobs.

Layers (all must stay):

1. Segments are percent-decoded **before** validation; a decoded segment
   containing `/` is rejected (blocks `%2e%2e`, `%2f`).
2. `SLUG_RE` / `FILENAME_RE` + `ALLOWED_EXT` allow only `[A-Za-z0-9_-]`, one
   optional allowlisted extension, no leading `-`, max 255 chars.
3. Filenames are used verbatim as the key (`${slug}/${file}`); the server never
   decodes or interprets them as paths.
4. `FILENAME_RE` / `ALLOWED_EXT` must stay byte-identical to the editor's
   `codec.js` and web-template's `migrate.js`.

## Request guards (`src/guards.js`)

Applied in `worker.js` to every request to the base API, including MCP-forwarded
ones.

- **Reserved slugs**: infra/mail/account/brand names and `xn--*`, `ns1`, `em123`
  style names cannot be created as sites.
- **DNS/Pages collision guard**: site creation is refused (409) if
  `{slug}.parroquia.app` already has any record other than a CNAME to
  `*.pages.dev`, or a Pages project with that name exists and is older than 1 h.
  Without it, `ensureDnsRecord` would delete e.g. MX/TXT records at that name.
  Cloudflare is only queried for authorized callers, and the guard fails closed
  (503) if Cloudflare can't be queried.
- **Content-Type from extension**: uploads are stored with a type derived from
  the validated extension (never the client header), so a `.png` can't be served
  as `text/html` from the data host. Recommended companion (dashboard, not
  code): a Transform Rule on `data.parroquia.app` adding
  `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`.

## Known follow-ups

- Move `auth.enc` to D1 (one row per token/grant/code): fixes lost-update races
  (revocations can be undone by a concurrent write) and keeps credentials out of
  the public bucket.
- Per-pool site-creation quota with admin notification.
- Token expiry (MCP tokens first); enforce MCP token scope.
- Cloudflare rate-limit rules / Turnstile on open endpoints.
