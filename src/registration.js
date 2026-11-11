/**
 * Event registrations (sign-ups) for web-template event / event-type pages.
 *
 * Storage: Cloudflare D1 (binding `REGDB`, database `parroquia-registrations`).
 * It is NOT the public `parroquia` R2 bucket: everything in that bucket is
 * served from data.parroquia.app. One row per registration:
 *   - plaintext columns: id, site, event_key, event_label, people, timestamps
 *     (non-personal, needed for listing/capacity/retention),
 *     email_hmac (HMAC of the email, only used for rate limiting) and
 *     secret_hash (SHA-256 of the edit secret);
 *   - `data` + `iv`: the personal data (name, phone, email, notes, lang) as an
 *     AES-GCM-256 blob. The key is derived per site from the REG_KEY secret
 *     (HKDF), and the ciphertext is bound to its row via AAD = `site|id`, so a
 *     blob copied to another row or site fails to decrypt.
 *
 * Routes (open, like /api/fcm/token; gated by Cloudflare Turnstile on create):
 *   POST   /api/register         create (body below) -> emails the confirmation
 *   GET    /api/register/:id?k=  load one registration for the edit form
 *   PUT    /api/register/:id     update (body: { k, ...fields })
 *   DELETE /api/register/:id?k=  cancel
 * Editor-gated (routed in worker.js):
 *   GET    /sites/:slug/registrations[?event=<key>][&format=csv]
 *
 * Turnstile follows the canonical siteverify contract: success === true, the
 * expected action, and an approved frontend hostname (see allowedHostnames).
 */
import {
  validateSlug,
  validateEmail,
  normalizeEmail,
  readJsonBody,
  sha256Hex,
  generateToken,
  timingSafeEqual,
  bytesToBase64,
  base64ToBytes,
  toHex,
} from './index.js';
import { notifySubscribers } from './registration-notify.js';

export const REG_ACTION = 'register';
export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export const LIMITS = {
  name: 120,
  phone: 40,
  email: 254,
  notes: 2000,
  label: 200,
  eventKey: 120,
  people: 500,
  token: 2048,
};
// Max registrations created per email address per hour (mail-bombing guard).
export const RATE_PER_EMAIL_HOUR = 5;
const DEFAULT_RETENTION_DAYS = 365;

const enc = new TextEncoder();
const dec = new TextDecoder();
const json = (obj, status = 200) =>
  Response.json(obj, { status, headers: { 'Cache-Control': 'no-store' } });

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

// REG_KEY is base64 of 32 random bytes (like AUTH_KEY). Any other string is
// accepted too and hashed to 32 bytes, so a differently-formatted secret does
// not take registrations down.
async function rootKeyBytes(env) {
  if (!env.REG_KEY) return null;
  try {
    const raw = base64ToBytes(env.REG_KEY);
    if (raw.length === 32) return raw;
  } catch {
    /* not base64: fall through */
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(env.REG_KEY))));
}

// Per-site subkeys (AES-GCM for the blob, HMAC for the rate-limit digest).
export async function siteKeys(env, slug) {
  const raw = await rootKeyBytes(env);
  if (!raw) return null;
  const root = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  const derive = (info, algorithm, usages) =>
    crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(`${info}:${slug}`) },
      root,
      algorithm,
      false,
      usages,
    );
  return {
    enc: await derive('parroquia-reg-enc', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
    mac: await derive('parroquia-reg-mac', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']),
  };
}

export async function seal(keys, slug, id, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(`${slug}|${id}`) },
    keys.enc,
    enc.encode(JSON.stringify(obj)),
  );
  return { iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(ct)) };
}

export async function open(keys, slug, id, row) {
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(row.iv), additionalData: enc.encode(`${slug}|${id}`) },
      keys.enc,
      base64ToBytes(row.data),
    );
    return JSON.parse(dec.decode(pt));
  } catch {
    return null;
  }
}

export async function emailDigest(keys, email) {
  const sig = await crypto.subtle.sign('HMAC', keys.mac, enc.encode(normalizeEmail(email)));
  return toHex(new Uint8Array(sig));
}

// ---------------------------------------------------------------------------
// Turnstile
// ---------------------------------------------------------------------------

// Frontend hostnames allowed to have produced a Turnstile token (and to be
// linked from the confirmation email) for this site: its parroquia.app
// subdomain, the host of its own `dev.siteurl` (custom domain), plus any
// comma-separated TURNSTILE_HOSTNAMES. Only put localhost/127.0.0.1 in
// TURNSTILE_HOSTNAMES for local dev (.dev.vars), never in production.
export async function allowedHostnames(env, slug) {
  const hosts = new Set([`${slug}.parroquia.app`]);
  try {
    const obj = await env.CONTENT.get(`${slug}/config.json`);
    if (obj) {
      const cfg = JSON.parse(await obj.text());
      const siteurl = cfg?.dev?.siteurl;
      if (typeof siteurl === 'string' && siteurl) {
        const u = new URL(/^https?:\/\//i.test(siteurl) ? siteurl : `https://${siteurl}`);
        if (u.hostname) hosts.add(u.hostname.toLowerCase());
      }
    }
  } catch {
    /* unreadable config: keep the default subdomain only */
  }
  for (const h of String(env.TURNSTILE_HOSTNAMES || '').split(',')) {
    const t = h.trim().toLowerCase();
    if (t) hosts.add(t);
  }
  return hosts;
}

// Canonical siteverify. Fails closed on every error path.
export async function verifyTurnstile(env, token, ip, hostnames) {
  if (!env.TURNSTILE_SECRET) return { ok: false, status: 503, error: 'captcha not configured' };
  if (typeof token !== 'string' || !token || token.length > LIMITS.token || hostnames.size === 0) {
    return { ok: false, status: 403, error: 'captcha failed' };
  }
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  if (ip) form.set('remoteip', ip);
  let result;
  try {
    const r = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
      body: form,
    });
    if (!r.ok) throw new Error(`siteverify ${r.status}`);
    result = await r.json();
  } catch (e) {
    console.error('turnstile: siteverify failed:', e?.message);
    return { ok: false, status: 403, error: 'captcha failed' };
  }
  if (!result.success || result.action !== REG_ACTION || !hostnames.has(String(result.hostname).toLowerCase())) {
    return { ok: false, status: 403, error: 'captcha failed' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Returns { ok, fields } or { ok:false, error }.
export function validateFields(d) {
  const name = str(d.name, LIMITS.name);
  const phone = str(d.phone, LIMITS.phone);
  const email = str(d.email, LIMITS.email);
  const notes = str(d.notes, LIMITS.notes);
  const people = Number(d.people);
  if (!name) return { ok: false, error: 'name is required' };
  if (!phone || !/^[+()\d\s.\-]{5,}$/.test(phone)) return { ok: false, error: 'a valid phone is required' };
  if (!validateEmail(email)) return { ok: false, error: 'a valid email is required' };
  if (!Number.isInteger(people) || people < 1 || people > LIMITS.people) {
    return { ok: false, error: `people must be a whole number between 1 and ${LIMITS.people}` };
  }
  return { ok: true, fields: { name, phone, email: normalizeEmail(email), people, notes } };
}

const validEventKey = (k) => typeof k === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(k);

async function siteExists(env, slug) {
  return !!(await env.CONTENT.head(`${slug}/config.json`));
}

// ---------------------------------------------------------------------------
// Email (Resend, same provider and sender as the magic links)
// ---------------------------------------------------------------------------

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STRINGS = {
  es: {
    subject: (ev) => `Tu inscripción: ${ev}`,
    hello: (n) => `Hola ${n},`,
    intro: 'Hemos recibido tu inscripción. Estos son los datos:',
    event: 'Evento', name: 'Responsable', phone: 'Teléfono', email: 'Email',
    people: 'Personas', notes: 'Observaciones',
    edit: 'Si necesitas cambiar o cancelar tu inscripción, usa este enlace (personal, no lo compartas):',
    button: 'Modificar mi inscripción',
    ignore: 'Si no has hecho esta inscripción, puedes ignorar este correo.',
  },
  en: {
    subject: (ev) => `Your registration: ${ev}`,
    hello: (n) => `Hello ${n},`,
    intro: 'We have received your registration. Here are the details:',
    event: 'Event', name: 'Person in charge', phone: 'Phone', email: 'Email',
    people: 'People', notes: 'Notes',
    edit: 'If you need to change or cancel your registration, use this link (personal, please do not share it):',
    button: 'Edit my registration',
    ignore: 'If you did not make this registration, you can ignore this email.',
  },
};

export function buildEmail(lang, { eventLabel, fields, link }) {
  const t = STRINGS[String(lang || '').toLowerCase().startsWith('en') ? 'en' : 'es'];
  const rows = [
    [t.event, eventLabel], [t.name, fields.name], [t.phone, fields.phone],
    [t.email, fields.email], [t.people, String(fields.people)], [t.notes, fields.notes || '—'],
  ];
  const text = `${t.hello(fields.name)}\n\n${t.intro}\n\n`
    + rows.map(([k, v]) => `${k}: ${v}`).join('\n')
    + `\n\n${t.edit}\n${link}\n\n${t.ignore}`;
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;margin:24px 16px;padding:32px 24px;"><tr><td>
<p style="margin:0 0 12px;color:#1a1a1a;font-size:16px;">${esc(t.hello(fields.name))}</p>
<p style="margin:0 0 16px;color:#444;font-size:16px;">${esc(t.intro)}</p>
<table cellpadding="6" cellspacing="0" style="margin:0 0 20px;font-size:15px;color:#333;">${rows
    .map(([k, v]) => `<tr><td style="color:#888;vertical-align:top;">${esc(k)}</td><td style="white-space:pre-wrap;">${esc(v)}</td></tr>`)
    .join('')}</table>
<p style="margin:0 0 12px;color:#444;font-size:15px;">${esc(t.edit)}</p>
<p style="margin:0 0 20px;"><a href="${esc(link)}" style="display:inline-block;padding:12px 24px;background:#0066cc;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;">${esc(t.button)}</a></p>
<p style="margin:0;color:#888;font-size:13px;">${esc(t.ignore)}</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject: t.subject(eventLabel), text, html };
}

export async function sendRegistrationEmail(env, to, mail) {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY not configured' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.FROM_EMAIL || 'Parroquia App <no-reply@parroquia.app>',
        to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      }),
    });
    return res.ok ? { ok: true } : { ok: false, error: `Resend ${res.status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Edit link base: the page the visitor registered from, but only when its host
// is one of the site's own hostnames (a caller-supplied URL must never make the
// email point at a third-party site). Falls back to the site root.
function editLink(pageUrl, slug, hostnames, id, secret) {
  let base = `https://${slug}.parroquia.app/`;
  try {
    const u = new URL(String(pageUrl));
    if (u.protocol === 'https:' && hostnames.has(u.hostname.toLowerCase())) base = `${u.origin}${u.pathname}`;
  } catch {
    /* keep fallback */
  }
  return `${base}?edit=${encodeURIComponent(`${id}.${secret}`)}`;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function db(env) {
  return env.REGDB || null;
}

// Tell the organizers who subscribed (see registration-notify.js). Never delays or
// fails the visitor's request: runs after the response when the runtime allows it.
function later(ctx, promise) {
  const safe = promise.catch((e) => console.error('registration: notification failed:', e?.message));
  if (ctx?.waitUntil) ctx.waitUntil(safe);
  return safe;
}

async function createRegistration(env, request, ctx) {
  const body = await readJsonBody(request);
  if (!body.ok) return json({ error: body.error }, 400);
  const d = body.data && typeof body.data === 'object' ? body.data : {};

  const slug = d.site;
  if (!validateSlug(slug)) return json({ error: 'invalid site' }, 400);
  if (!validEventKey(d.event)) return json({ error: 'invalid event' }, 400);
  const checked = validateFields(d);
  if (!checked.ok) return json({ error: checked.error }, 400);
  if (d.consent !== true) return json({ error: 'consent is required' }, 400);
  // Honeypot: real visitors never fill it in. Pretend success to the bot.
  if (typeof d.website === 'string' && d.website) return json({ ok: true }, 200);

  if (!db(env)) return json({ error: 'registrations not configured' }, 503);
  const keys = await siteKeys(env, slug);
  if (!keys) return json({ error: 'registrations not configured' }, 503);

  if (!(await siteExists(env, slug))) return json({ error: 'unknown site' }, 404);

  const hostnames = await allowedHostnames(env, slug);
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const captcha = await verifyTurnstile(env, d.turnstile, ip, hostnames);
  if (!captcha.ok) return json({ error: captcha.error }, captcha.status);

  const fields = checked.fields;
  const now = Date.now();
  const mac = await emailDigest(keys, fields.email);
  const recent = await db(env)
    .prepare('SELECT COUNT(*) AS n FROM registrations WHERE email_hmac = ? AND created_at > ?')
    .bind(mac, now - 3_600_000)
    .first();
  if ((recent?.n ?? 0) >= RATE_PER_EMAIL_HOUR) return json({ error: 'too many registrations, try later' }, 429);

  const id = generateToken().slice(0, 32);
  const secret = generateToken();
  const eventLabel = str(d.eventLabel, LIMITS.label) || d.event;
  const lang = str(d.lang, 12);
  const sealed = await seal(keys, slug, id, { ...fields, lang });
  await db(env)
    .prepare(
      'INSERT INTO registrations (id, site, event_key, event_label, people, email_hmac, secret_hash, iv, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    )
    .bind(id, slug, d.event, eventLabel, fields.people, mac, await sha256Hex(secret), sealed.iv, sealed.data, now, now)
    .run();

  const link = editLink(d.pageUrl, slug, hostnames, id, secret);
  const sent = await sendRegistrationEmail(env, fields.email, buildEmail(lang, { eventLabel, fields, link }));
  if (!sent.ok) console.error('registration: confirmation email failed:', sent.error);
  later(ctx, notifySubscribers(env, slug, 'new', { eventKey: d.event, eventLabel, fields }));
  return json({ ok: true, id, emailSent: sent.ok }, 201);
}

// Loads a row and checks the edit secret. Returns { row } or { res }.
async function loadWithSecret(env, id, secret) {
  if (!db(env)) return { res: json({ error: 'registrations not configured' }, 503) };
  if (!/^[0-9a-f]{32}$/.test(id) || typeof secret !== 'string' || !/^[0-9a-f]{64}$/.test(secret)) {
    return { res: json({ error: 'not found' }, 404) };
  }
  const row = await db(env).prepare('SELECT * FROM registrations WHERE id = ?').bind(id).first();
  if (!row || !timingSafeEqual(row.secret_hash, await sha256Hex(secret))) {
    return { res: json({ error: 'not found' }, 404) };
  }
  return { row };
}

async function getRegistration(env, id, url) {
  const { row, res } = await loadWithSecret(env, id, url.searchParams.get('k'));
  if (res) return res;
  const keys = await siteKeys(env, row.site);
  const data = keys && (await open(keys, row.site, id, row));
  if (!data) return json({ error: 'registration unavailable' }, 503);
  return json({
    ok: true,
    site: row.site,
    event: row.event_key,
    eventLabel: row.event_label,
    name: data.name, phone: data.phone, email: data.email, people: data.people, notes: data.notes,
  });
}

async function updateRegistration(env, id, request, ctx) {
  const body = await readJsonBody(request);
  if (!body.ok) return json({ error: body.error }, 400);
  const { row, res } = await loadWithSecret(env, id, body.data?.k);
  if (res) return res;
  const checked = validateFields(body.data);
  if (!checked.ok) return json({ error: checked.error }, 400);
  const keys = await siteKeys(env, row.site);
  if (!keys) return json({ error: 'registrations not configured' }, 503);
  const prev = await open(keys, row.site, id, row);
  const f = checked.fields;
  const sealed = await seal(keys, row.site, id, { ...f, lang: prev?.lang || '' });
  await db(env)
    .prepare('UPDATE registrations SET people = ?, email_hmac = ?, iv = ?, data = ?, updated_at = ? WHERE id = ?')
    .bind(f.people, await emailDigest(keys, f.email), sealed.iv, sealed.data, Date.now(), id)
    .run();
  later(ctx, notifySubscribers(env, row.site, 'updated', { eventKey: row.event_key, eventLabel: row.event_label, fields: f }));
  return json({ ok: true });
}

async function deleteRegistration(env, id, url, ctx) {
  const { row, res } = await loadWithSecret(env, id, url.searchParams.get('k'));
  if (res) return res;
  // Read the data before it is gone, so the organizers can be told who cancelled.
  const keys = await siteKeys(env, row.site);
  const data = keys ? await open(keys, row.site, id, row) : null;
  await db(env).prepare('DELETE FROM registrations WHERE id = ?').bind(row.id).run();
  if (data) later(ctx, notifySubscribers(env, row.site, 'cancelled', { eventKey: row.event_key, eventLabel: row.event_label, fields: data }));
  return json({ ok: true });
}

/**
 * Dispatch for /api/register[/:id]. `segments` are the already-decoded path
 * segments. Returns a Response, or null when the route does not match.
 */
export async function handleRegister(env, request, segments, url, ctx) {
  if (segments[0] !== 'api' || segments[1] !== 'register' || segments.length > 3) return null;
  const method = request.method.toUpperCase();
  if (segments.length === 2) return method === 'POST' ? createRegistration(env, request, ctx) : null;
  const id = segments[2];
  if (method === 'GET') return getRegistration(env, id, url);
  if (method === 'PUT') return updateRegistration(env, id, request, ctx);
  if (method === 'DELETE') return deleteRegistration(env, id, url, ctx);
  return null;
}

// ---------------------------------------------------------------------------
// Organizer access (caller must already be authorized for `slug`)
// ---------------------------------------------------------------------------

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function listRegistrations(env, slug, url) {
  if (!db(env)) return json({ error: 'registrations not configured' }, 503);
  const keys = await siteKeys(env, slug);
  if (!keys) return json({ error: 'registrations not configured' }, 503);
  const event = url.searchParams.get('event');
  const stmt = event
    ? db(env).prepare('SELECT * FROM registrations WHERE site = ? AND event_key = ? ORDER BY created_at').bind(slug, event)
    : db(env).prepare('SELECT * FROM registrations WHERE site = ? ORDER BY created_at').bind(slug);
  const { results } = await stmt.all();
  const items = [];
  for (const row of results || []) {
    const data = (await open(keys, slug, row.id, row)) || {};
    items.push({
      id: row.id, event: row.event_key, eventLabel: row.event_label,
      createdAt: row.created_at, updatedAt: row.updated_at,
      name: data.name, phone: data.phone, email: data.email, people: row.people, notes: data.notes,
    });
  }
  if (url.searchParams.get('format') === 'csv') {
    const head = ['event', 'eventLabel', 'createdAt', 'name', 'phone', 'email', 'people', 'notes'];
    const lines = [head.join(',')].concat(
      items.map((i) => head.map((h) => csvCell(h === 'createdAt' ? new Date(i.createdAt).toISOString() : i[h])).join(',')),
    );
    return new Response(lines.join('\n') + '\n', {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  return json({ ok: true, slug, total: items.length, people: items.reduce((n, i) => n + i.people, 0), registrations: items });
}

// Retention: personal data is not kept forever. Called by the daily cron.
export async function purgeRegistrations(env) {
  if (!db(env)) return { deleted: 0 };
  const days = Number(env.REG_RETENTION_DAYS) > 0 ? Number(env.REG_RETENTION_DAYS) : DEFAULT_RETENTION_DAYS;
  const cutoff = Date.now() - days * 86_400_000;
  const r = await db(env).prepare('DELETE FROM registrations WHERE updated_at < ?').bind(cutoff).run();
  return { deleted: r?.meta?.changes ?? 0 };
}
