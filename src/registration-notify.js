/**
 * Organizer notifications for event registrations (companion of registration.js).
 *
 * Any editor of a site can subscribe, from the editor's "Inscripciones" tab, to an
 * email for every new / modified / cancelled registration of that site:
 *   GET    /sites/:slug/registrations/subscription   -> { ok, subscribed }
 *   PUT    /sites/:slug/registrations/subscription   -> subscribe the calling editor
 *   DELETE /sites/:slug/registrations/subscription   -> unsubscribe
 * (editor-gated and routed in worker.js; the site admin secret has no email, so it
 * cannot subscribe.)
 *
 * Subscriptions live in the same private D1 database as the registrations
 * (table `registration_subscribers`, created on first use). The subscriber's email is
 * stored encrypted like registration data (AES-GCM under the per-site key, bound to
 * its row via AAD); only an HMAC of it is kept in the clear, as the row key.
 *
 * Access is re-checked at send time: a subscriber who is no longer an editor of the
 * site is dropped instead of being sent personal data.
 */
import { readAuthState, bearerToken, sha256Hex, normalizeEmail } from './index.js';
import { siteKeys, seal, open, emailDigest, esc, sendRegistrationEmail, db } from './registration.js';

const MAX_SUBSCRIBERS = 25;
const json = (obj, status = 200) => Response.json(obj, { status, headers: { 'Cache-Control': 'no-store' } });

let tableReady = null;
// `CREATE TABLE IF NOT EXISTS`, once per isolate (also in migrations/0002_subscribers.sql).
function ensureTable(env) {
  if (!tableReady) {
    tableReady = db(env)
      .prepare(
        'CREATE TABLE IF NOT EXISTS registration_subscribers (site TEXT NOT NULL, email_hmac TEXT NOT NULL, iv TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (site, email_hmac))',
      )
      .run()
      .catch((e) => {
        tableReady = null;
        throw e;
      });
  }
  return tableReady;
}
// Tests build a fresh database per test.
export function resetSubscriberTableCache() {
  tableReady = null;
}

// Email of the (already authorized) editor behind the bearer token, or null for the admin secret.
async function callerEmail(env, request) {
  const token = bearerToken(request);
  if (!token) return null;
  const state = await readAuthState(env);
  return state?.tokens?.[await sha256Hex(token)]?.email ?? null;
}

const subId = (mac) => `sub:${mac}`;

export async function handleSubscription(env, slug, request) {
  if (!db(env)) return json({ error: 'registrations not configured' }, 503);
  const keys = await siteKeys(env, slug);
  if (!keys) return json({ error: 'registrations not configured' }, 503);
  const email = await callerEmail(env, request);
  if (!email) return json({ error: 'an editor login (not the admin secret) is required' }, 400);

  await ensureTable(env);
  const mac = await emailDigest(keys, email);
  const method = request.method.toUpperCase();

  if (method === 'PUT') {
    const sealed = await seal(keys, slug, subId(mac), { email });
    await db(env)
      .prepare('INSERT OR REPLACE INTO registration_subscribers (site, email_hmac, iv, data, created_at) VALUES (?,?,?,?,?)')
      .bind(slug, mac, sealed.iv, sealed.data, Date.now())
      .run();
    return json({ ok: true, subscribed: true });
  }
  if (method === 'DELETE') {
    await db(env).prepare('DELETE FROM registration_subscribers WHERE site = ? AND email_hmac = ?').bind(slug, mac).run();
    return json({ ok: true, subscribed: false });
  }
  if (method === 'GET') {
    const row = await db(env)
      .prepare('SELECT 1 AS x FROM registration_subscribers WHERE site = ? AND email_hmac = ?')
      .bind(slug, mac)
      .first();
    return json({ ok: true, subscribed: !!row });
  }
  return json({ error: 'method not allowed' }, 405);
}

const COPY = {
  new: { subject: 'Nueva inscripción', lead: 'Se ha recibido una nueva inscripción.' },
  updated: { subject: 'Inscripción modificada', lead: 'Una persona ha modificado su inscripción.' },
  cancelled: { subject: 'Inscripción cancelada', lead: 'Una persona ha cancelado su inscripción.' },
};

export function buildNotification(kind, { eventLabel, fields, totals }) {
  const c = COPY[kind];
  const rows = [
    ['Evento', eventLabel],
    ['Responsable', fields.name],
    ['Teléfono', fields.phone],
    ['Email', fields.email],
    ['Personas', String(fields.people)],
    ['Observaciones', fields.notes || '—'],
  ];
  const total = `Total para este evento: ${totals.people} personas en ${totals.count} inscripciones.`;
  const foot = 'Recibes este aviso porque lo activaste en la pestaña Inscripciones del editor; puedes desactivarlo allí.';
  const text = `${c.lead}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${total}\n\n${foot}`;
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;margin:24px 16px;padding:32px 24px;"><tr><td>
<p style="margin:0 0 16px;color:#1a1a1a;font-size:16px;">${esc(c.lead)}</p>
<table cellpadding="6" cellspacing="0" style="margin:0 0 20px;font-size:15px;color:#333;">${rows
    .map(([k, v]) => `<tr><td style="color:#888;vertical-align:top;">${esc(k)}</td><td style="white-space:pre-wrap;">${esc(v)}</td></tr>`)
    .join('')}</table>
<p style="margin:0 0 16px;color:#444;font-size:15px;">${esc(total)}</p>
<p style="margin:0;color:#888;font-size:13px;">${esc(foot)}</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject: `${c.subject}: ${eventLabel}`, text, html };
}

/**
 * Email every current subscriber of `slug`. `kind`: 'new' | 'updated' | 'cancelled'.
 * Best effort: throws only on infrastructure errors (callers log and move on).
 */
export async function notifySubscribers(env, slug, kind, { eventKey, eventLabel, fields }) {
  if (!db(env)) return { sent: 0 };
  const keys = await siteKeys(env, slug);
  if (!keys) return { sent: 0 };
  await ensureTable(env);

  const { results } = await db(env)
    .prepare('SELECT * FROM registration_subscribers WHERE site = ? ORDER BY created_at LIMIT ?')
    .bind(slug, MAX_SUBSCRIBERS)
    .all();
  if (!results?.length) return { sent: 0 };

  const t = await db(env)
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(people), 0) AS p FROM registrations WHERE site = ? AND event_key = ?')
    .bind(slug, eventKey)
    .first();
  const mail = buildNotification(kind, { eventLabel, fields, totals: { count: t?.n ?? 0, people: t?.p ?? 0 } });

  const auth = await readAuthState(env);
  let sent = 0;
  for (const row of results) {
    const who = await open(keys, slug, subId(row.email_hmac), row);
    const to = who?.email && normalizeEmail(who.email);
    if (!to) continue;
    // No longer an editor of this site (access revoked): drop the subscription, send nothing.
    if (auth && !(auth.emails?.[to] || []).includes(slug)) {
      await db(env).prepare('DELETE FROM registration_subscribers WHERE site = ? AND email_hmac = ?').bind(slug, row.email_hmac).run();
      continue;
    }
    const r = await sendRegistrationEmail(env, to, mail);
    if (r.ok) sent++;
    else console.error('registration: organizer notification failed:', r.error);
  }
  return { sent };
}
