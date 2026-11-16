import { describe, it, expect } from 'vitest';
import worker from '../../src/worker.js';
import { AUTH_FILE, readAuthState, writeAuthState, sha256Hex, generateToken } from '../../src/index.js';
import { diffStates, applyOps } from '../../src/auth-store.js';
import { MockR2, makeCtx } from '../helpers/integration.js';

function setup() {
  const r2 = new MockR2();
  const base = r2.makeEnv(); // includes AUTHDB (D1 on SQLite)
  return { r2, AUTHDB: base.AUTHDB, base };
}
// Each "request" is just another readAuthState on the same D1: it snapshots the
// version it read, which is what makes the later write mergeable.
const read = (env) => readAuthState(env);
const write = async (env, state) => {
  const r = await writeAuthState(env, state);
  if (!r.ok) throw new Error(r.error);
};
const rowCount = (AUTHDB) => AUTHDB._sqlite.prepare('SELECT COUNT(*) n FROM auth_state').get().n;
const seed = (env, state) => env.CONTENT.seedAuth(env, state);

describe('storage', () => {
  it('stores credentials only in D1, never in the bucket', async () => {
    const { r2, AUTHDB, base } = setup();
    expect(await read(base)).toEqual({ emails: {}, tokens: {}, magic: {} });
    const st = await read(base);
    st.emails['a@x.com'] = ['s1'];
    await write(base, st);
    expect(r2.has(AUTH_FILE)).toBe(false);
    expect(rowCount(AUTHDB)).toBe(1);
    expect((await read(base)).emails['a@x.com']).toEqual(['s1']);
  });

  it('imports the legacy R2 auth.enc once, then never reads R2 for it again', async () => {
    const { r2, AUTHDB, base } = setup();
    await r2.seedLegacyAuth(base, { emails: { 'old@x.com': ['s1'] }, tokens: {}, magic: {} });
    expect((await read(base)).emails['old@x.com']).toEqual(['s1']);
    expect(rowCount(AUTHDB)).toBe(1);

    // Tamper with the legacy object: D1 is now the source of truth.
    await r2.seedLegacyAuth(base, { emails: { 'evil@x.com': ['s9'] }, tokens: {}, magic: {} });
    const st = await read(base);
    expect(st.emails['old@x.com']).toEqual(['s1']);
    expect(st.emails['evil@x.com']).toBeUndefined();
  });
});

describe('concurrency: lost updates', () => {
  it('a stale writer cannot resurrect a revoked editor', async () => {
    const { base } = setup();
    await seed(base, {
      emails: { 'ed@x.com': ['s1'], 'keep@x.com': ['s1'] },
      tokens: { t1: { slug: 's1', email: 'ed@x.com' } },
      magic: {},
    });
    const a = await read(base); // request A: revokes ed@x.com
    const b = await read(base); // request B: read BEFORE the revocation

    delete a.emails['ed@x.com'];
    delete a.tokens.t1;
    await write(base, a);

    b.clients = { c1: { n: 'Client', r: ['https://x.example/cb'] } }; // unrelated change
    await write(base, b);

    const final = await read(base);
    expect(final.emails['ed@x.com']).toBeUndefined(); // revocation survived
    expect(final.tokens.t1).toBeUndefined();
    expect(final.clients.c1.n).toBe('Client'); // and B's change landed
    expect(final.emails['keep@x.com']).toEqual(['s1']);
  });

  it('concurrent grants of different slugs to the same email both survive', async () => {
    const { base } = setup();
    await seed(base, { emails: { 'e@x.com': ['s1'] }, tokens: {}, magic: {} });
    const a = await read(base);
    const b = await read(base);
    a.emails['e@x.com'].push('s2');
    b.emails['e@x.com'].push('s3');
    await write(base, a);
    await write(base, b);
    expect((await read(base)).emails['e@x.com'].sort()).toEqual(['s1', 's2', 's3']);
  });

  it('removing a slug does not drop a slug granted concurrently', async () => {
    const { base } = setup();
    await seed(base, { emails: { 'e@x.com': ['s1'] }, tokens: {}, magic: {} });
    const a = await read(base);
    const b = await read(base);
    delete a.emails['e@x.com']; // removeEditor on s1 (list became empty)
    b.emails['e@x.com'].push('s2'); // concurrent addEditor on s2
    await write(base, a);
    await write(base, b);
    expect((await read(base)).emails['e@x.com']).toEqual(['s2']);
  });
});

describe('concurrency: single-use codes', () => {
  it('a magic code redeemed twice concurrently mints only one token', async () => {
    const { base } = setup();
    await seed(base, {
      emails: { 'e@x.com': ['s1'] }, tokens: {},
      magic: { code1: { slug: 's1', email: 'e@x.com', exp: Date.now() + 60_000 } },
    });
    const a = await read(base);
    const b = await read(base);
    for (const [st, tok] of [[a, 'tokA'], [b, 'tokB']]) {
      delete st.magic.code1;
      st.tokens[tok] = { slug: 's1', email: 'e@x.com' };
    }
    await write(base, a);
    const r = await writeAuthState(base, b);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('retry'); // second redeemer is refused (503 upstream)
    const final = await read(base);
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
    await seed(base, {
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
