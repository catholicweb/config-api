// Organizer notifications: subscription endpoints + emails on new / modified / cancelled
// registrations. Same harness as registration.test.js (D1 on node:sqlite, stubbed fetch).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../../src/worker.js';
import { resetSubscriberTableCache } from '../../src/registration-notify.js';
import { MockR2, makeCtx, makeTestEnv, seedEditor, seedSiteMarker } from '../helpers/integration.js';
import { makeD1 } from '../helpers/d1.js';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
let sent;

beforeEach(() => {
  resetSubscriberTableCache();
  sent = [];
  vi.stubGlobal('fetch', async (url, init) => {
    if (String(url).includes('turnstile')) return Response.json({ success: true, action: 'register', hostname: 'demo.parroquia.app' });
    if (String(url).includes('resend')) {
      sent.push(JSON.parse(init.body));
      return Response.json({ id: 'x' });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});
afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const r2 = new MockR2();
  const env = await makeTestEnv(r2);
  Object.assign(env, { REGDB: makeD1(), REG_KEY: KEY, TURNSTILE_SECRET: 's', RESEND_API_KEY: 're' });
  await seedSiteMarker(r2, 'demo');
  const ed = await seedEditor(r2, env, 'Priest@Example.com', 'demo');
  return { r2, env, ctx: makeCtx(), ed };
}

const call = (env, ctx, method, path, { body, token } = {}) =>
  handler.fetch(
    new Request(`https://api.parroquia.app${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }),
    env,
    ctx,
  );

const reg = (over = {}) => ({
  site: 'demo', event: 'camp', eventLabel: 'Campamento', name: 'Ana', phone: '600111222', email: 'ana@example.com',
  people: 4, notes: 'Alergia a frutos secos', consent: true, turnstile: 't', lang: 'es',
  pageUrl: 'https://demo.parroquia.app/camp/', ...over,
});
const to = (addr) => sent.filter((m) => m.to === addr);

describe('subscription endpoints', () => {
  it('require an editor token', async () => {
    const { env, ctx } = await setup();
    expect((await call(env, ctx, 'GET', '/sites/demo/registrations/subscription')).status).toBe(401);
  });

  it('subscribe, read and unsubscribe; the email is not stored in the clear', async () => {
    const { env, ctx, ed } = await setup();
    const get = async () => (await (await call(env, ctx, 'GET', '/sites/demo/registrations/subscription', { token: ed.token })).json()).subscribed;
    expect(await get()).toBe(false);
    expect((await call(env, ctx, 'PUT', '/sites/demo/registrations/subscription', { token: ed.token })).status).toBe(200);
    expect(await get()).toBe(true);
    const rows = env.REGDB._sqlite.prepare('SELECT * FROM registration_subscribers').all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]).toLowerCase()).not.toContain('priest');
    await call(env, ctx, 'DELETE', '/sites/demo/registrations/subscription', { token: ed.token });
    expect(await get()).toBe(false);
  });
});

describe('notifications', () => {
  async function subscribed() {
    const s = await setup();
    await call(s.env, s.ctx, 'PUT', '/sites/demo/registrations/subscription', { token: s.ed.token });
    return s;
  }

  it('emails subscribers about new registrations, with the head count and running totals', async () => {
    const { env, ctx } = await subscribed();
    expect((await call(env, ctx, 'POST', '/api/register', { body: reg() })).status).toBe(201);
    await call(env, ctx, 'POST', '/api/register', { body: reg({ name: 'Luis', email: 'luis@example.com', people: 6 }) });
    await ctx.flush();
    const mails = to('priest@example.com');
    expect(mails).toHaveLength(2);
    expect(mails[0].subject).toBe('Nueva inscripción: Campamento');
    expect(mails[0].text).toContain('(4 personas)');
    expect(mails[1].text).toContain('Total para este evento: 10 personas en 2 inscripciones.');
    expect(mails[1].text).toContain('https://editor.parroquia.app/');
    expect(to('ana@example.com')).toHaveLength(1); // the registrant's own confirmation is unaffected
  });

  it('sends nothing when nobody subscribed', async () => {
    const { env, ctx } = await setup();
    await call(env, ctx, 'POST', '/api/register', { body: reg() });
    await ctx.flush();
    expect(to('priest@example.com')).toHaveLength(0);
  });

  it('tells subscribers about modifications and cancellations', async () => {
    const { env, ctx } = await subscribed();
    await call(env, ctx, 'POST', '/api/register', { body: reg() });
    const m = /edit=([0-9a-f]{32})\.([0-9a-f]{64})/.exec(to('ana@example.com')[0].text);
    const [, id, k] = m;
    await call(env, ctx, 'PUT', `/api/register/${id}`, { body: { k, name: 'Ana', phone: '600111222', email: 'ana@example.com', people: 7, notes: '' } });
    await call(env, ctx, 'DELETE', `/api/register/${id}?k=${k}`);
    await ctx.flush();
    const subjects = to('priest@example.com').map((x) => x.subject);
    expect(subjects).toEqual(['Nueva inscripción: Campamento', 'Inscripción modificada: Campamento', 'Inscripción cancelada: Campamento']);
    expect(to('priest@example.com')[1].text).toContain('ahora 7 personas');
    expect(to('priest@example.com')[2].text).toContain('Se ha cancelado una inscripción (7 personas)'); // as last edited
  });

  it('never includes personal data, in any kind of notification', async () => {
    const { env, ctx } = await subscribed();
    await call(env, ctx, 'POST', '/api/register', { body: reg({ name: 'Zacarías Quijano', phone: '699888777', email: 'zac@example.com', notes: 'Alergia a frutos secos' }) });
    const m = /edit=([0-9a-f]{32})\.([0-9a-f]{64})/.exec(to('zac@example.com')[0].text);
    await call(env, ctx, 'PUT', `/api/register/${m[1]}`, { body: { k: m[2], name: 'Zacarías Quijano', phone: '699888777', email: 'zac@example.com', people: 2, notes: 'Alergia a frutos secos' } });
    await call(env, ctx, 'DELETE', `/api/register/${m[1]}?k=${m[2]}`);
    await ctx.flush();
    const notes = to('priest@example.com');
    expect(notes).toHaveLength(3);
    for (const n of notes) {
      for (const secret of ['Zacar', 'Quijano', '699888777', 'zac@example.com', 'frutos', 'Alergia']) {
        expect(n.text).not.toContain(secret);
        expect(n.html).not.toContain(secret);
      }
    }
  });

  it('escapes the event label in the HTML', async () => {
    const { env, ctx } = await subscribed();
    await call(env, ctx, 'POST', '/api/register', { body: reg({ eventLabel: '<img src=x onerror=1>' }) });
    await ctx.flush();
    expect(to('priest@example.com')[0].html).toContain('&lt;img src=x onerror=1&gt;');
  });

  it('drops a subscriber who is no longer an editor of the site', async () => {
    const { r2, env, ctx, ed } = await subscribed();
    await r2.seedAuth(env, { ...ed.state, emails: {} }); // access revoked
    await call(env, ctx, 'POST', '/api/register', { body: reg() });
    await ctx.flush();
    expect(to('priest@example.com')).toHaveLength(0);
    expect(env.REGDB._sqlite.prepare('SELECT COUNT(*) n FROM registration_subscribers').get().n).toBe(0);
  });
});
