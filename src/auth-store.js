/**
 * Credential storage on D1 (binding AUTHDB): a single private row holding the
 * AES-GCM blob that index.js builds ({v, iv, ct}, encrypted under AUTH_KEY),
 * plus a `version` used for optimistic concurrency.
 *
 * index.js (readAuthState / writeAuthState) is the only caller. This module
 * deals in opaque blob text and never imports index.js; the two crypto steps it
 * needs for merging are injected as `codec`.
 *
 * Why not just overwrite the row? Every request reads the WHOLE state and writes
 * the WHOLE state back. With a blind overwrite a stale request silently reverts
 * concurrent changes (e.g. resurrects a revoked editor). So a write is a
 * compare-and-swap on `version`; when someone else wrote first we MERGE: the diff
 * between what this request read and what it wants to write (entry-level, and
 * element-level for slug lists) is re-applied on top of the latest state, then
 * retried. Entries of the single-use maps (`magic`, `oauth`) that this request
 * consumed but another request already consumed raise AuthConflictError, so a
 * code can't be redeemed twice concurrently.
 */

const MAX_ATTEMPTS = 6;
const STRICT_MAPS = new Set(['magic', 'oauth']); // single-use credentials

const LEGACY_KEY = 'auth.enc'; // pre-D1 location in the R2 bucket (see loadAuthBlob)
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

async function ensureSchema(db) {
  if (ready.has(db)) return;
  await db.prepare(SCHEMA).run();
  ready.add(db);
}

const readRow = (db) => db.prepare('SELECT version, blob FROM auth_state WHERE id = 1').first();

async function cas(db, blob, expect) {
  const now = Date.now();
  const r =
    expect === 0
      ? await db
          .prepare('INSERT INTO auth_state (id, version, blob, updated_at) VALUES (1, 1, ?, ?) ON CONFLICT(id) DO NOTHING')
          .bind(blob, now)
          .run()
      : await db
          .prepare('UPDATE auth_state SET version = version + 1, blob = ?, updated_at = ? WHERE id = 1 AND version = ?')
          .bind(blob, now, expect)
          .run();
  return r?.meta?.changes === 1;
}

/**
 * Current credential blob: { version, blob } where blob is the JSON text of the
 * encrypted state, or null (version 0) when nothing has been stored yet.
 */
export async function loadAuthBlob(env) {
  const db = env.AUTHDB;
  await ensureSchema(db);
  let row = await readRow(db);
  if (!row) {
    // TEMPORARY one-time import of the pre-D1 object. Delete this block (and
    // LEGACY_KEY) once auth.enc has been removed from the R2 bucket.
    const legacy = await env.CONTENT?.get(LEGACY_KEY);
    if (legacy) {
      await db
        .prepare('INSERT OR IGNORE INTO auth_state (id, version, blob, updated_at) VALUES (1, 1, ?, ?)')
        .bind(await legacy.text(), Date.now())
        .run();
      row = await readRow(db);
    }
  }
  return row ? { version: row.version, blob: row.blob } : { version: 0, blob: null };
}

/**
 * Store `nextBlob` (JSON text) that was derived from `base` (what loadAuthBlob
 * returned for this request). Returns the new base. Merges onto concurrent
 * writes; throws AuthConflictError if it can't (single-use code already used,
 * or too much contention).
 *
 * codec = { decrypt(text) -> state | null, encrypt(state) -> text | null }
 */
export async function saveAuthBlob(env, base, nextBlob, codec) {
  const db = env.AUTHDB;
  await ensureSchema(db);
  let blob = nextBlob;
  let expect = base.version;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (await cas(db, blob, expect)) return { version: expect + 1, blob };
    // Somebody wrote since we read: merge our change onto the latest state.
    const latest = await readRow(db);
    if (!latest) {
      expect = 0;
      blob = nextBlob;
      continue;
    }
    const empty = () => ({ emails: {}, tokens: {}, magic: {} });
    const [was, want, cur] = await Promise.all([
      base.blob == null ? empty() : codec.decrypt(base.blob),
      codec.decrypt(nextBlob),
      codec.decrypt(latest.blob),
    ]);
    if (!was || !want || !cur) throw new Error('auth state unreadable during merge');
    applyOps(cur, diffStates(was, want));
    blob = await codec.encrypt(cur);
    if (!blob) throw new Error('auth encryption key not configured');
    expect = latest.version;
  }
  throw new AuthConflictError('auth state is busy; retry');
}
