// Integration tests for the event registration endpoints (src/registration.js).
// D1 is emulated with node:sqlite (a real SQL engine), Turnstile and Resend with
// a stubbed global fetch.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import handler from '../../src/worker.js';
import { MockR2, makeCtx, makeTestEnv, seedEditor, seedSiteMarker } from '../helpers/integration.js';

function makeD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../migrations/0001_registrations.sql', import.meta.url), 'utf8'));
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
  });
  return { prepare: (sql) => wrap(sql), _sqlite: sqlite };
}

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const GOOD = { success: true, action: 'register', hostname: 'demo.parroquia.app' };
let turnstile, sent, resendQueue; // resendQueue: statuses to answer the next Resend calls with

function stubFetch() {
  turnstile = { ...GOOD };
  sent = [];
  resendQueue = [];
  vi.stubGlobal('fetch', async (url, init) => {
    if (String(url).includes('turnstile')) return Response.json(turnstile);
    if (String(url).includes('resend')) {
      sent.push(JSON.parse(init.body));
      const status = resendQueue.shift();
      if (status === 'throw') throw new Error('network down');
      if (status) return new Response('{}', { status });
      return Response.json({ id: 'x' });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

async function setup() {
  const r2 = new MockR2();
  const env = await makeTestEnv(r2);
  env.REGDB = makeD1();
  env.REG_KEY = KEY;
  env.TURNSTILE_SECRET = 'ts-secret';
  env.RESEND_API_KEY = 're_test';
  await seedSiteMarker(r2, 'demo');
  return { r2, env, ctx: makeCtx() };
}

const call = (env, ctx, method, path, body) =>
  handler.fetch(
    new Request(`https://api.parroquia.app${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }),
    env,
    ctx,
  );

const payload = (over = {}) => ({
  site: 'demo', event: 'catequesis', eventLabel: 'Catequesis <b>', name: 'Ana Pérez', phone: '+34 600 111 222',
  email: 'Ana@Example.com', people: 12, notes: 'Dos alergias: nueces', consent: true, turnstile: 'tok',
  lang: 'es', pageUrl: 'https://demo.parroquia.app/catequesis/', ...over,
});

beforeEach(stubFetch);
afterEach(() => vi.unstubAllGlobals());

describe('POST /api/register', () => {
  it('stores an encrypted row and emails a confirmation with an edit link', async () => {
    const { env, ctx } = await setup();
    const res = await call(env, ctx, 'POST', '/api/register', payload());
    expect(res.status).toBe(201);
    const out = await res.json();
    expect(out.emailSent).toBe(true);

    const row = env.REGDB._sqlite.prepare('SELECT * FROM registrations').get();
    expect(row.people).toBe(12);
    expect(row.event_key).toBe('catequesis');
    // No personal data in plaintext anywhere in the row.
    const dump = JSON.stringify(row);
    for (const secret of ['Ana', 'example.com', '600 111', 'nueces']) expect(dump).not.toContain(secret);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('ana@example.com');
    expect(sent[0].html).toContain('Catequesis &lt;b&gt;'); // escaped
    expect(sent[0].text).toMatch(/https:\/\/demo\.parroquia\.app\/catequesis\/\?edit=[0-9a-f]{32}\.[0-9a-f]{64}/);
  });

  it('rejects when Turnstile fails, wrong action, or wrong hostname', async () => {
    const { env, ctx } = await setup();
    for (const bad of [{ success: false }, { action: 'login' }, { hostname: 'evil.example' }]) {
      turnstile = { ...GOOD, ...bad };
      const res = await call(env, ctx, 'POST', '/api/register', payload());
      expect(res.status).toBe(403);
    }
    expect(env.REGDB._sqlite.prepare('SELECT COUNT(*) n FROM registrations').get().n).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('fails closed when the Turnstile secret is missing', async () => {
    const { env, ctx } = await setup();
    delete env.TURNSTILE_SECRET;
    expect((await call(env, ctx, 'POST', '/api/register', payload())).status).toBe(503);
  });

  it('validates input and requires consent', async () => {
    const { env, ctx } = await setup();
    for (const over of [{ name: '' }, { phone: 'abc' }, { email: 'nope' }, { people: 0 }, { people: 1.5 }, { consent: false }, { event: '../x' }, { site: 'Bad_Slug' }]) {
      expect((await call(env, ctx, 'POST', '/api/register', payload(over))).status).toBe(400);
    }
  });

  it('404s for an unknown site and rejects honeypot hits visibly (never a fake success)', async () => {
    const { env, ctx } = await setup();
    expect((await call(env, ctx, 'POST', '/api/register', payload({ site: 'nope' }))).status).toBe(404);
    const res = await call(env, ctx, 'POST', '/api/register', payload({ website: 'http://spam' }));
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBeUndefined();
    expect(env.REGDB._sqlite.prepare('SELECT COUNT(*) n FROM registrations').get().n).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('rate-limits registrations per email address', async () => {
    const { env, ctx } = await setup();
    for (let i = 0; i < 5; i++) expect((await call(env, ctx, 'POST', '/api/register', payload())).status).toBe(201);
    expect((await call(env, ctx, 'POST', '/api/register', payload({ email: 'ANA@example.com' }))).status).toBe(429);
  });

  it('brands the confirmation with the site\'s own name, colour and icon', async () => {
    const { r2, env, ctx } = await setup();
    await r2.put('demo/config.json', JSON.stringify({ info: { title: 'Parroquia San Miguel' }, theme: { accentHue: 30, icon: 'https://data.parroquia.app/demo/icon.png' } }));
    expect((await call(env, ctx, 'POST', '/api/register', payload())).status).toBe(201);
    expect(sent[0].from).toBe('Parroquia San Miguel <no-reply@parroquia.app>');
    expect(sent[0].html).toContain('src="https://data.parroquia.app/demo/icon.png"');
    expect(sent[0].html).toContain('Parroquia San Miguel');
    expect(sent[0].html).not.toContain('Parroquia App');
    expect(sent[0].html).not.toContain('#0066cc');
    expect(sent[0].text).toContain('Parroquia San Miguel');
  });

  it('falls back to the slug name and an initial tile when the config has no branding', async () => {
    const { env, ctx } = await setup();
    await call(env, ctx, 'POST', '/api/register', payload());
    expect(sent[0].from).toBe('Demo <no-reply@parroquia.app>');
    expect(sent[0].html).not.toContain('<img');
    expect(sent[0].html).not.toContain('Parroquia App');
  });

  it('never takes branding from the request body', async () => {
    const { env, ctx } = await setup();
    await call(env, ctx, 'POST', '/api/register', payload({ brand: { name: 'Evil' }, brandName: 'Evil', iconUrl: 'https://evil.example/x.png', accentHue: 10 }));
    expect(sent[0].from).toBe('Demo <no-reply@parroquia.app>');
    expect(sent[0].html).not.toContain('evil.example');
    expect(sent[0].html).not.toContain('Evil');
  });

  it('never links the email to a host that is not the site\'s own', async () => {
    const { env, ctx } = await setup();
    await call(env, ctx, 'POST', '/api/register', payload({ pageUrl: 'https://evil.example/phish' }));
    expect(sent[0].text).toContain('https://demo.parroquia.app/?edit=');
    expect(sent[0].text).not.toContain('evil.example');
  });

  it('accepts the site\'s custom domain from config.json', async () => {
    const { r2, env, ctx } = await setup();
    await r2.put('demo/config.json', JSON.stringify({ dev: { siteurl: 'https://www.parroquiademo.org' } }));
    turnstile = { ...GOOD, hostname: 'www.parroquiademo.org' };
    const res = await call(env, ctx, 'POST', '/api/register', payload({ pageUrl: 'https://www.parroquiademo.org/evento/' }));
    expect(res.status).toBe(201);
    expect(sent[0].text).toContain('https://www.parroquiademo.org/evento/?edit=');
  });
});

// Wrap D1 so statements matching `match` run `override` instead (run/first).
function intercept(env, match, override) {
  const real = env.REGDB;
  env.REGDB = {
    _sqlite: real._sqlite,
    prepare: (sql) => {
      const wrap = (stmt) => ({
        bind: (...a) => wrap(stmt.bind(...a)),
        first: (...a) => (match.test(sql) && override.first ? override.first() : stmt.first(...a)),
        all: (...a) => stmt.all(...a),
        run: (...a) => (match.test(sql) && override.run ? override.run() : stmt.run(...a)),
      });
      return wrap(real.prepare(sql));
    },
  };
}
const rowCount = (env) => env.REGDB._sqlite.prepare('SELECT COUNT(*) n FROM registrations').get().n;

describe('a registration is never confirmed unless it was really saved', () => {
  const INSERT = /INSERT INTO registrations/;

  it('500s, sends no email and notifies nobody when the insert throws', async () => {
    const { env, ctx } = await setup();
    intercept(env, INSERT, { run: async () => { throw new Error('D1 down'); } });
    const res = await call(env, ctx, 'POST', '/api/register', payload());
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBeUndefined();
    expect(rowCount(env)).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('500s when the insert reports no written row', async () => {
    const { env, ctx } = await setup();
    intercept(env, INSERT, { run: async () => ({ meta: { changes: 0 } }) });
    const res = await call(env, ctx, 'POST', '/api/register', payload());
    expect(res.status).toBe(500);
    expect(sent).toHaveLength(0);
  });

  it('500s when the row cannot be read back after the insert', async () => {
    const { env, ctx } = await setup();
    intercept(env, /SELECT id FROM registrations WHERE id/, { first: async () => null });
    const res = await call(env, ctx, 'POST', '/api/register', payload());
    expect(res.status).toBe(500);
    expect(sent).toHaveLength(0);
  });

  it('503s (no email, no row) when storage or the encryption key is missing', async () => {
    const a = await setup();
    delete a.env.REG_KEY;
    expect((await call(a.env, a.ctx, 'POST', '/api/register', payload())).status).toBe(503);
    expect(sent).toHaveLength(0);
    const b = await setup();
    delete b.env.REGDB;
    expect((await call(b.env, b.ctx, 'POST', '/api/register', payload())).status).toBe(503);
    expect(sent).toHaveLength(0);
  });

  it('retries a transient email failure once and reports emailSent true', async () => {
    const { env, ctx } = await setup();
    resendQueue = [500];
    const out = await (await call(env, ctx, 'POST', '/api/register', payload())).json();
    expect(out.emailSent).toBe(true);
    expect(sent).toHaveLength(2);
    resendQueue = ['throw'];
    expect((await (await call(env, ctx, 'POST', '/api/register', payload({ email: 'b@example.com' }))).json()).emailSent).toBe(true);
  });

  it('keeps the registration but says so honestly when the email cannot be sent', async () => {
    const { env, ctx } = await setup();
    resendQueue = [500, 500];
    const res = await call(env, ctx, 'POST', '/api/register', payload());
    expect(res.status).toBe(201);
    expect((await res.json()).emailSent).toBe(false);
    expect(rowCount(env)).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it('does not retry a permanent email failure', async () => {
    const { env, ctx } = await setup();
    resendQueue = [403];
    expect((await (await call(env, ctx, 'POST', '/api/register', payload())).json()).emailSent).toBe(false);
    expect(sent).toHaveLength(1);
    expect(rowCount(env)).toBe(1);
  });

  it('reports emailSent false when email is not configured, with the row saved', async () => {
    const { env, ctx } = await setup();
    delete env.RESEND_API_KEY;
    const res = await call(env, ctx, 'POST', '/api/register', payload());
    expect(res.status).toBe(201);
    expect((await res.json()).emailSent).toBe(false);
    expect(rowCount(env)).toBe(1);
  });

  async function created() {
    const s = await setup();
    await call(s.env, s.ctx, 'POST', '/api/register', payload());
    const m = /edit=([0-9a-f]{32})\.([0-9a-f]{64})/.exec(sent[0].text);
    return { ...s, id: m[1], k: m[2] };
  }
  const edit = (k, over = {}) => ({ k, name: 'Ana P.', phone: '600111222', email: 'ana@example.com', people: 15, notes: '', ...over });

  it('an edit is not confirmed when no row was updated, and the data is unchanged', async () => {
    const { env, ctx, id, k } = await created();
    intercept(env, /UPDATE registrations/, { run: async () => ({ meta: { changes: 0 } }) });
    const res = await call(env, ctx, 'PUT', `/api/register/${id}`, edit(k));
    expect(res.status).toBe(404);
    expect((await res.json()).ok).toBeUndefined();
    const now = await (await call(env, ctx, 'GET', `/api/register/${id}?k=${k}`)).json();
    expect(now).toMatchObject({ name: 'Ana Pérez', people: 12 });
  });

  it('an edit 500s when the update throws', async () => {
    const { env, ctx, id, k } = await created();
    intercept(env, /UPDATE registrations/, { run: async () => { throw new Error('D1 down'); } });
    expect((await call(env, ctx, 'PUT', `/api/register/${id}`, edit(k))).status).toBe(500);
  });

  it('a cancellation is not confirmed when no row was deleted', async () => {
    const { env, ctx, id, k } = await created();
    intercept(env, /DELETE FROM registrations/, { run: async () => ({ meta: { changes: 0 } }) });
    const res = await call(env, ctx, 'DELETE', `/api/register/${id}?k=${k}`);
    expect(res.status).toBe(404);
    expect(rowCount(env)).toBe(1);
  });
});

describe('edit / cancel with the emailed secret', () => {
  async function created() {
    const s = await setup();
    await call(s.env, s.ctx, 'POST', '/api/register', payload());
    const m = /edit=([0-9a-f]{32})\.([0-9a-f]{64})/.exec(sent[0].text);
    return { ...s, id: m[1], k: m[2] };
  }

  it('GET returns the decrypted data only with the right secret', async () => {
    const { env, ctx, id, k } = await created();
    const ok = await (await call(env, ctx, 'GET', `/api/register/${id}?k=${k}`)).json();
    expect(ok).toMatchObject({ name: 'Ana Pérez', people: 12, email: 'ana@example.com', event: 'catequesis' });
    expect((await call(env, ctx, 'GET', `/api/register/${id}?k=${'0'.repeat(64)}`)).status).toBe(404);
    expect((await call(env, ctx, 'GET', `/api/register/${id}`)).status).toBe(404);
  });

  it('PUT updates, DELETE cancels', async () => {
    const { env, ctx, id, k } = await created();
    const put = await call(env, ctx, 'PUT', `/api/register/${id}`, { k, name: 'Ana P.', phone: '600111222', email: 'ana@example.com', people: 15, notes: '' });
    expect(put.status).toBe(200);
    const now = await (await call(env, ctx, 'GET', `/api/register/${id}?k=${k}`)).json();
    expect(now).toMatchObject({ name: 'Ana P.', people: 15 });
    expect((await call(env, ctx, 'DELETE', `/api/register/${id}?k=${k}`)).status).toBe(200);
    expect((await call(env, ctx, 'GET', `/api/register/${id}?k=${k}`)).status).toBe(404);
  });

  it('a ciphertext moved to another row fails to decrypt (AAD binding)', async () => {
    const { env, ctx, id, k } = await created();
    await call(env, ctx, 'POST', '/api/register', payload({ name: 'Otro', email: 'otro@example.com' }));
    const rows = env.REGDB._sqlite.prepare('SELECT id, iv, data FROM registrations ORDER BY created_at').all();
    const other = rows.find((r) => r.id !== id);
    env.REGDB._sqlite.prepare('UPDATE registrations SET iv=?, data=? WHERE id=?').run(other.iv, other.data, id);
    expect((await call(env, ctx, 'GET', `/api/register/${id}?k=${k}`)).status).toBe(503);
  });
});

describe('GET /sites/:slug/registrations (organizers)', () => {
  it('requires an editor/admin token', async () => {
    const { env, ctx } = await setup();
    expect((await call(env, ctx, 'GET', '/sites/demo/registrations')).status).toBe(401);
  });

  it('returns decrypted registrations and a CSV with formula-injection guard', async () => {
    const { r2, env, ctx } = await setup();
    await call(env, ctx, 'POST', '/api/register', payload({ name: '=HYPERLINK("x")' }));
    const { token } = await seedEditor(r2, env, 'ed@example.com', 'demo');
    const req = (q) => handler.fetch(new Request(`https://api.parroquia.app/sites/demo/registrations${q}`, { headers: { Authorization: `Bearer ${token}` } }), env, ctx);
    const list = await (await req('?event=catequesis')).json();
    expect(list).toMatchObject({ ok: true, total: 1, people: 12 });
    expect(list.registrations[0].email).toBe('ana@example.com');
    const csv = await (await req('?format=csv')).text();
    expect(csv.split('\n')[0]).toBe('event,eventLabel,createdAt,name,phone,email,people,notes');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe('retention', () => {
  it('purges registrations not updated within REG_RETENTION_DAYS', async () => {
    const { env, ctx } = await setup();
    await call(env, ctx, 'POST', '/api/register', payload());
    env.REGDB._sqlite.prepare('UPDATE registrations SET updated_at = ?').run(Date.now() - 400 * 86_400_000);
    const { purgeRegistrations } = await import('../../src/registration.js');
    expect((await purgeRegistrations(env)).deleted).toBe(1);
  });
});
