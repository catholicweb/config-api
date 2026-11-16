import { describe, it, expect } from 'vitest';
import worker from '../../src/worker.js';
import { AUTH_FILE, encryptState, decryptState, sha256Hex, generateToken } from '../../src/index.js';
import { withAuthStore, diffStates, applyOps, AuthConflictError } from '../../src/auth-store.js';
import { makeD1 } from '../helpers/d1.js';
import { MockR2, makeCtx } from '../helpers/integration.js';

const AUTH_SQL = 'migrations-auth/0001_auth_state.sql';

function setup() {
  const r2 = new MockR2();
  const AUTHDB = makeD1(AUTH_SQL);
  const base = r2.makeEnv({ AUTHDB });
  return { r2, AUTHDB, base };
}
// Each call = one "request": its own proxy/snapshot, same D1.
const request = (base) => withAuthStore(base);
const read = async (env) => {
  const obj = await env.CONTENT.get(AUTH_FILE);
  return obj ? decryptState(env, JSON.parse(await obj.text())) : null;
};
const write = async (env, state) => env.CONTENT.put(AUTH_FILE, JSON.stringify(await encryptState(env, state)));
const rowCount = (AUTHDB) => AUTHDB._sqlite.prepare('SELECT COUNT(*) n FROM auth_state').get().n;

describe('withAuthStore: routing', () => {
  it('returns env untouched without an AUTHDB binding', () => {
    const env = new MockR2().makeEnv();
    expect(withAuthStore(env)).toBe(env);
  });

  it('sends only auth.enc to D1; every other key goes to R2', async () => {
    const { r2, AUTHDB, base } = setup();
    const env = request(base);
    await env.CONTENT.put('site/config.json', '{"a":1}');
    expect(r2.has('site/config.json')).toBe(true);
    expect(await (await env.CONTENT.get('site/config.json')).text()).toBe('{"a":1}');
    expect(await env.CONTENT.get(AUTH_FILE)).toBeNull();

    await write(env, { emails: { 'a@x.com': ['s1'] }, tokens: {}, magic: {} });
    expect(r2.has(AUTH_FILE)).toBe(false); // never written to the public bucket
    expect(rowCount(AUTHDB)).toBe(1);
    expect((await read(request(base))).emails['a@x.com']).toEqual(['s1']);
  });

  it('imports the legacy R2 auth.enc once, then never reads R2 for it again', async () => {
    const { r2, AUTHDB, base } = setup();
    await r2.seedAuth(base, { emails: { 'old@x.com': ['s1'] }, tokens: { h1: { slug: 's1', email: 'old@x.com' } }, magic: {} });
    expect((await read(request(base))).emails['old@x.com']).toEqual(['s1']);
    expect(rowCount(AUTHDB)).toBe(1);

    // Tamper with the legacy object: D1 must now be the source of truth.
    await r2.seedAuth(base, { emails: { 'evil@x.com': ['s9'] }, tokens: {}, magic: {} });
    const st = await read(request(base));
    expect(st.emails['old@x.com']).toEqual(['s1']);
    expect(st.emails['evil@x.com']).toBeUndefined();
  });
});

describe('concurrency: lost updates', () => {
  it('a stale writer cannot resurrect a revoked editor', async () => {
    const { base } = setup();
    await write(request(base), {
      emails: { 'ed@x.com': ['s1'], 'keep@x.com': ['s1'] },
      tokens: { t1: { slug: 's1', email: 'ed@x.com' } },
      magic: {},
    });
    const revoke = request(base); // request A: revokes ed@x.com
    const stale = request(base); // request B: read BEFORE the revocation
    const a = await read(revoke);
    const b = await read(stale);

    delete a.emails['ed@x.com'];
    delete a.tokens.t1;
    await write(revoke, a);

    b.clients = { c1: { n: 'Client', r: ['https://x.example/cb'] } }; // unrelated change
    await write(stale, b);

    const final = await read(request(base));
    expect(final.emails['ed@x.com']).toBeUndefined(); // revocation survived
    expect(final.tokens.t1).toBeUndefined();
    expect(final.clients.c1.n).toBe('Client'); // and B's change landed
    expect(final.emails['keep@x.com']).toEqual(['s1']);
  });

  it('concurrent grants of different slugs to the same email both survive', async () => {
    const { base } = setup();
    await write(request(base), { emails: { 'e@x.com': ['s1'] }, tokens: {}, magic: {} });
    const A = request(base);
    const B = request(base);
    const a = await read(A);
    const b = await read(B);
    a.emails['e@x.com'].push('s2');
    b.emails['e@x.com'].push('s3');
    await write(A, a);
    await write(B, b);
    expect((await read(request(base))).emails['e@x.com'].sort()).toEqual(['s1', 's2', 's3']);
  });

  it('removing a slug does not drop a slug granted concurrently', async () => {
    const { base } = setup();
    await write(request(base), { emails: { 'e@x.com': ['s1'] }, tokens: {}, magic: {} });
    const A = request(base);
    const B = request(base);
    const a = await read(A);
    const b = await read(B);
    delete a.emails['e@x.com']; // removeEditor on s1 (list became empty)
    b.emails['e@x.com'].push('s2'); // concurrent addEditor on s2
    await write(A, a);
    await write(B, b);
    expect((await read(request(base))).emails['e@x.com']).toEqual(['s2']);
  });
});

describe('concurrency: single-use codes', () => {
  it('a magic code redeemed twice concurrently mints only one token', async () => {
    const { base } = setup();
    await write(request(base), {
      emails: { 'e@x.com': ['s1'] }, tokens: {},
      magic: { code1: { slug: 's1', email: 'e@x.com', exp: Date.now() + 60_000 } },
    });
    const A = request(base);
    const B = request(base);
    const a = await read(A);
    const b = await read(B);
    for (const [st, tok] of [[a, 'tokA'], [b, 'tokB']]) {
      delete st.magic.code1;
      st.tokens[tok] = { slug: 's1', email: 'e@x.com' };
    }
    await write(A, a);
    await expect(write(B, b)).rejects.toBeInstanceOf(AuthConflictError);
    const final = await read(request(base));
    expect(Object.keys(final.tokens)).toEqual(['tokA']);
  });

  it('pruning an already-expired code concurrently is not a conflict', () => {
    const latest = { emails: {}, tokens: {}, magic: {} };
    const ops = diffStates({ magic: { old: { exp: Date.now() - 1000 } } }, { magic: {} });
    expect(() => applyOps(latest, ops)).not.toThrow();
  });
});

describe('end to end through the worker', () => {
  it('magic-link login + authenticated call work with credentials only in D1', async () => {
    const { r2, AUTHDB, base } = setup();
    const code = generateToken();
    await write(request(base), {
      emails: { 'ed@x.com': ['mysite'] }, tokens: {},
      magic: { [await sha256Hex(code)]: { slug: 'mysite', email: 'ed@x.com', exp: Date.now() + 60_000 } },
    });
    const res = await worker.fetch(new Request('https://api.parroquia.app/auth/magic', {
      method: 'POST', body: JSON.stringify({ code }),
    }), base, makeCtx());
    expect(res.status).toBe(200);
    const { token } = await res.json();

    const who = await worker.fetch(new Request('https://api.parroquia.app/whoami', {
      headers: { Authorization: `Bearer ${token}` },
    }), base, makeCtx());
    expect(who.status).toBe(200);
    expect((await who.json()).email).toBe('ed@x.com');
    expect(r2.has(AUTH_FILE)).toBe(false);
    expect(rowCount(AUTHDB)).toBe(1);
  });
});
