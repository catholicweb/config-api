/**
 * Credential store on D1 (binding AUTHDB), instead of `auth.enc` in the PUBLIC
 * R2 bucket.
 *
 * index.js (and mcp-oauth.js) read and write the credential state through
 * `env.CONTENT.get/put('auth.enc')`. `withAuthStore(env)` returns an env whose
 * CONTENT is a thin proxy: every key except `auth.enc` goes straight to R2, and
 * `auth.enc` is served from / written to a single D1 row instead. index.js is
 * therefore unchanged, and without the AUTHDB binding nothing changes at all
 * (the env is returned as is).
 *
 * What this fixes:
 *  - The credential blob is no longer an object in a world-readable bucket.
 *  - Lost updates. Every request writes the WHOLE state back, so with R2 a
 *    stale writer silently overwrote concurrent changes, e.g. resurrecting a
 *    revoked editor. Here a write is a compare-and-swap on `version`; when
 *    someone else wrote first we MERGE: the diff between what this request
 *    read and what it wants to write (entry-level, and element-level for slug
 *    lists) is re-applied on top of the latest state, then retried.
 *  - Double redemption. Entries in single-use maps (`magic`, `oauth`) that this
 *    request consumed but another request already consumed make the write fail
 *    with AuthConflictError (surfaced as a 500; the second redeemer simply
 *    fails and can retry).
 *
 * The row still holds the AES-GCM blob (same format as the legacy auth.enc), so
 * AUTH_KEY remains defense in depth and the legacy object imports as is.
 * Migration is lazy: if the D1 table is empty, the first read imports the R2
 * `auth.enc` once. Delete the R2 copy afterwards (see SECURITY.md).
 */
import { AUTH_FILE, decryptState, encryptState } from './index.js';

const MAX_ATTEMPTS = 6;
const STRICT_MAPS = new Set(['magic', 'oauth']); // single-use credentials

const SCHEMA =
  'CREATE TABLE IF NOT EXISTS auth_state (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, blob TEXT NOT NULL, updated_at INTEGER NOT NULL)';
const ready = new WeakSet();

export class AuthConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthConflictError';
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const VIRGIN = () => ({ emails: {}, tokens: {}, magic: {} });

// ---- merge ------------------------------------------------------------------

/** Entry-level diff of two states. Slug lists (arrays) diff element-wise. */
export function diffStates(base, next) {
  const ops = [];
  for (const k of new Set([...Object.keys(base), ...Object.keys(next)])) {
    const b = base[k];
    const n = next[k];
    if (isObj(b) || isObj(n)) {
      const bm = isObj(b) ? b : {};
      const nm = isObj(n) ? n : {};
      for (const key of new Set([...Object.keys(bm), ...Object.keys(nm)])) {
        const bv = bm[key];
        const nv = nm[key];
        if (same(bv, nv)) continue;
        if (Array.isArray(bv) || Array.isArray(nv)) {
          const bArr = Array.isArray(bv) ? bv : [];
          const nArr = Array.isArray(nv) ? nv : [];
          ops.push({
            t: 'arr', map: k, key,
            add: nArr.filter((x) => !bArr.includes(x)),
            remove: bArr.filter((x) => !nArr.includes(x)),
          });
        } else if (nv === undefined) {
          ops.push({ t: 'del', map: k, key, was: bv });
        } else {
          ops.push({ t: 'set', map: k, key, value: nv });
        }
      }
    } else if (!same(b, n)) {
      ops.push({ t: 'top', key: k, value: n });
    }
  }
  return ops;
}

const expired = (entry, now) => typeof entry?.exp === 'number' && entry.exp < now;

/** Re-apply a diff on top of `latest` (mutated in place). */
export function applyOps(latest, ops, now = Date.now()) {
  for (const op of ops) {
    if (op.t === 'top') {
      if (op.value === undefined) delete latest[op.key];
      else latest[op.key] = op.value;
      continue;
    }
    if (!isObj(latest[op.map])) latest[op.map] = {};
    const m = latest[op.map];
    if (op.t === 'set') {
      m[op.key] = op.value;
    } else if (op.t === 'del') {
      // Someone else already consumed this single-use credential.
      if (STRICT_MAPS.has(op.map) && !(op.key in m) && !expired(op.was, now)) {
        throw new AuthConflictError(`${op.map} entry was already used`);
      }
      delete m[op.key];
    } else {
      const cur = (Array.isArray(m[op.key]) ? m[op.key] : []).filter((x) => !op.remove.includes(x));
      for (const a of op.add) if (!cur.includes(a)) cur.push(a);
      if (cur.length === 0) delete m[op.key];
      else m[op.key] = cur;
    }
  }
  return latest;
}

// ---- store ------------------------------------------------------------------

class AuthStore {
  constructor(db, r2, env) {
    this.db = db;
    this.r2 = r2;
    this.env = env;
    this.ver = 0; // version of the row this request last read/wrote (0 = no row)
    this.baseBlob = null; // blob text at that version
  }

  async _ensure() {
    if (ready.has(this.db)) return;
    await this.db.prepare(SCHEMA).run();
    ready.add(this.db);
  }

  _row() {
    return this.db.prepare('SELECT version, blob FROM auth_state WHERE id = 1').first();
  }

  async _decrypt(blobText) {
    if (blobText == null) return VIRGIN();
    try {
      return await decryptState(this.env, JSON.parse(blobText));
    } catch {
      return null;
    }
  }

  async _cas(blob, expect) {
    const now = Date.now();
    const r =
      expect === 0
        ? await this.db
            .prepare('INSERT INTO auth_state (id, version, blob, updated_at) VALUES (1, 1, ?, ?) ON CONFLICT(id) DO NOTHING')
            .bind(blob, now)
            .run()
        : await this.db
            .prepare('UPDATE auth_state SET version = version + 1, blob = ?, updated_at = ? WHERE id = 1 AND version = ?')
            .bind(blob, now, expect)
            .run();
    return r?.meta?.changes === 1;
  }

  /** Same contract as R2 `get('auth.enc')`: null, or an object with text(). */
  async get() {
    await this._ensure();
    let row = await this._row();
    if (!row) {
      // One-time lazy import of the legacy R2 object.
      const legacy = await this.r2.get(AUTH_FILE);
      if (legacy) {
        const text = await legacy.text();
        await this.db
          .prepare('INSERT OR IGNORE INTO auth_state (id, version, blob, updated_at) VALUES (1, 1, ?, ?)')
          .bind(text, Date.now())
          .run();
        row = await this._row();
      }
    }
    if (!row) {
      this.ver = 0;
      this.baseBlob = null;
      return null;
    }
    this.ver = row.version;
    this.baseBlob = row.blob;
    return { text: async () => row.blob };
  }

  /** Same contract as R2 `put('auth.enc', json)`. */
  async put(value) {
    await this._ensure();
    const nextBlob = typeof value === 'string' ? value : await new Response(value).text();
    let blob = nextBlob;
    let expect = this.ver;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (await this._cas(blob, expect)) {
        this.ver = expect + 1;
        this.baseBlob = blob;
        return;
      }
      // Somebody wrote since we read: merge our change onto the latest state.
      const latest = await this._row();
      if (!latest) {
        expect = 0;
        blob = nextBlob;
        continue;
      }
      const [base, next, cur] = await Promise.all([
        this._decrypt(this.baseBlob),
        this._decrypt(nextBlob),
        this._decrypt(latest.blob),
      ]);
      if (!base || !next || !cur) throw new Error('auth state unreadable during merge');
      applyOps(cur, diffStates(base, next));
      const enc = await encryptState(this.env, cur);
      if (!enc) throw new Error('auth encryption key not configured');
      blob = JSON.stringify(enc);
      expect = latest.version;
    }
    throw new AuthConflictError('auth state is busy; retry');
  }
}

/** env whose CONTENT serves `auth.enc` from D1. Returns env unchanged without an AUTHDB binding. */
export function withAuthStore(env) {
  if (!env?.AUTHDB || !env.CONTENT) return env;
  const store = new AuthStore(env.AUTHDB, env.CONTENT, env);
  const bucket = new Proxy(env.CONTENT, {
    get(target, prop) {
      if (prop === 'get') return (key, opts) => (key === AUTH_FILE ? store.get() : target.get(key, opts));
      if (prop === 'put') return (key, value, opts) => (key === AUTH_FILE ? store.put(value) : target.put(key, value, opts));
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { ...env, CONTENT: bucket };
}
