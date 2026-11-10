# Event registrations

Sign-ups for events, sent by the `web-template` event pages (`?register`). Code: `src/registration.js`,
routed from `src/worker.js`. (`README.md` stays the contract for everything else; the endpoint table
below is the contract for these routes.)

| Method | Path | Auth | Request | Response |
|--------|------|------|---------|----------|
| POST   | `/api/register` | Turnstile token in body | `{ site, event, eventLabel?, name, phone, email, people, notes?, consent: true, turnstile, lang?, pageUrl? }`: store an encrypted registration and email a confirmation with a personal edit link | `201 { ok, id, emailSent }` / `400/403/404/429/503` |
| GET    | `/api/register/:id?k=<secret>` | secret from the emailed link | load a registration for the edit form | `200 { ok, site, event, eventLabel, name, phone, email, people, notes }` / `404/503` |
| PUT    | `/api/register/:id` | secret in body | `{ k, name, phone, email, people, notes? }`: update | `200 { ok }` / `400/404/503` |
| DELETE | `/api/register/:id?k=<secret>` | secret from the emailed link | cancel | `200 { ok }` / `404/503` |
| GET    | `/sites/:slug/registrations` | `Bearer editor | admin` | optional `?event=<key>`, `?format=csv`: organizers read their decrypted sign-ups | `200 { ok, slug, total, people, registrations }` / `401/403/503` |

## Storage: Cloudflare D1

Binding `REGDB`, database `parroquia-registrations` (schema: `migrations/0001_registrations.sql`).
Deliberately **not** the public `parroquia` R2 bucket, which is served from `data.parroquia.app`.

Name, phone, email, notes and language are one AES-GCM-256 blob per row. The key is derived per site
from the `REG_KEY` secret (HKDF) and the blob is bound to its row with AAD `site|id`. Plaintext columns are
non-personal (`site`, `event_key`, `event_label`, `people`, timestamps) plus `email_hmac` (rate limiting only)
and `secret_hash` (SHA-256 of the edit secret). **Back up `REG_KEY`**: without it the data is unreadable.

## Turnstile

Canonical siteverify on create: `success === true`, `action === "register"`, and `hostname` one of the site's
own hosts (`<slug>.parroquia.app`, the host of `config.json` `dev.siteurl`, or `TURNSTILE_HOSTNAMES`).
Secret: `TURNSTILE_SECRET` (fails closed with 503 when unset). Every one of those hosts must be listed in the
widget's domains in Cloudflare. The widget is explicitly rendered with `data-action="register"` by web-template.

## Other protections

Honeypot field `website`; max 5 registrations per email per hour; field-length caps; `consent: true` required;
the edit link in the email only ever points at one of the site's own hosts.

## Retention

The daily cron deletes registrations not updated for `REG_RETENTION_DAYS` days (default 365).

## Setup checklist

1. `npx wrangler d1 execute parroquia-registrations --remote --file=migrations/0001_registrations.sql` (already applied)
2. Secrets: `REG_KEY`, `TURNSTILE_SECRET` (optional: `TURNSTILE_HOSTNAMES`)
3. `npx wrangler deploy`
4. Cloudflare dashboard: add CORS for `PUT`/`DELETE` on `api.parroquia.app/api/register*` if the zone rule only lists the current methods.
