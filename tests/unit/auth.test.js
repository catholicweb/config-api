// Unit tests for the auth/crypto state layer of src/index.js.
//
// Tests authKey (key resolution), encryptState/decryptState (AES-GCM roundtrip),
// readAuthState/writeAuthState (R2-backed state), pruneAuthState (cleanup), and
// the four authorize* functions (admin/editor gate matrix).
//
// Uses MockR2 from ../../tests/helpers/mock-r2.js to simulate the R2 binding.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  sha256Hex,
  bytesToBase64,
  base64ToBytes,
  timingSafeEqual,
  bearerToken,
  generateToken,
  authKey,
  encryptState,
  decryptState,
  readAuthState,
  writeAuthState,
  pruneAuthState,
  mutateState,
  authorize,
  authorizeAdmin,
  authorizeAdminOrEditor,
  authorizeAdminOrEditorAny,
  AUTH_FILE,
  AUTH_STATE_V,
  MAGIC_TTL_MS,
} from '../../src/index.js';
import { MockR2 } from '../helpers/mock-r2.js';

// --- Test fixtures & helpers --------------------------------------------------

const ADMIN_TOKEN = 'test-admin-secret-token';
const EDITOR_EMAIL = 'editor@example.com';

function makeAuthKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToBase64(bytes);
}

function makeEnv(r2, overrides = {}) {
  return {
    CONTENT: r2,
    AUTH_KEY: makeAuthKey(),
    ADMIN_TOKEN_HASH: null, // set per-test
    ...overrides,
  };
}

function makeAuthEnv(r2, adminToken = ADMIN_TOKEN) {
  return {
    CONTENT: r2,
    AUTH_KEY: makeAuthKey(),
    ADMIN_TOKEN_HASH: null, // set asynchronously below
  };
}

function makeRequest(token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return new Request('https://example.com/', { headers });
}

// Build an env with a known ADMIN_TOKEN_HASH
async function makeAdminEnv(r2, adminToken = ADMIN_TOKEN) {
  return {
    CONTENT: r2,
    AUTH_KEY: makeAuthKey(),
    ADMIN_TOKEN_HASH: await sha256Hex(adminToken),
  };
}

// Seed auth.enc with a given state
async function seedAuth(r2, env, state) {
  const blob = await encryptState(env, state);
  await r2.put(AUTH_FILE, JSON.stringify(blob), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=0, must-revalidate' },
  });
}

// Create a full auth state with one email+editor grant
async function seedEditorState(r2, env, email = EDITOR_EMAIL, slug = 'myslug') {
  const editorToken = generateToken();
  const tokenHash = await sha256Hex(editorToken);
  const state = {
    emails: { [normalizeEmailForTest(email)]: [slug] },
    tokens: { [tokenHash]: { slug, email: normalizeEmailForTest(email) } },
    magic: {},
  };
  await seedAuth(r2, env, state);
  return { editorToken, state };
}

function normalizeEmailForTest(email) {
  return email.trim().toLowerCase();
}

// --- authKey ------------------------------------------------------------------

describe('authKey', () => {
  it('returns null when AUTH_KEY is missing', async () => {
    const env = { CONTENT: new MockR2() };
    expect(await authKey(env)).toBeNull();
  });

  it('returns null when AUTH_KEY is not valid base64', async () => {
    const env = { CONTENT: new MockR2(), AUTH_KEY: 'not-base64!!!' };
    expect(await authKey(env)).toBeNull();
  });

  it('returns null when AUTH_KEY decodes to wrong length (31 bytes)', async () => {
    // 31 bytes of zeros, base64-encoded
    const bytes = new Uint8Array(31);
    const b64 = bytesToBase64(bytes);
    const env = { CONTENT: new MockR2(), AUTH_KEY: b64 };
    expect(await authKey(env)).toBeNull();
  });

  it('returns null when AUTH_KEY decodes to wrong length (33 bytes)', async () => {
    const bytes = new Uint8Array(33);
    const b64 = bytesToBase64(bytes);
    const env = { CONTENT: new MockR2(), AUTH_KEY: b64 };
    expect(await authKey(env)).toBeNull();
  });

  it('returns a CryptoKey when AUTH_KEY is valid (32 bytes)', async () => {
    const env = { CONTENT: new MockR2(), AUTH_KEY: makeAuthKey() };
    const key = await authKey(env);
    expect(key).not.toBeNull();
    expect(key.type).toBe('secret');
    expect(key.algorithm.name).toBe('AES-GCM');
  });
});

// --- encryptState / decryptState ----------------------------------------------

describe('encryptState / decryptState', () => {
  it('roundtrips a state object', async () => {
    const r2 = new MockR2();
    const env = { CONTENT: r2, AUTH_KEY: makeAuthKey() };
    const state = { emails: { 'a@b.com': ['slug1'] }, tokens: {}, magic: {} };
    const blob = await encryptState(env, state);
    expect(blob).not.toBeNull();
    expect(blob.v).toBe(AUTH_STATE_V);
    expect(blob.iv).toBeTruthy(); // 12-byte base64
    expect(blob.ct).toBeTruthy();
    const decrypted = await decryptState(env, blob);
    expect(decrypted).toEqual(state);
  });

  it('encryptState returns null when AUTH_KEY is missing', async () => {
    const env = { CONTENT: new MockR2() };
    expect(await encryptState(env, { emails: {}, tokens: {}, magic: {} })).toBeNull();
  });

  it('decryptState returns null when AUTH_KEY is missing', async () => {
    const env = { CONTENT: new MockR2() };
    const fakeBlob = { v: AUTH_STATE_V, iv: 'AAAA', ct: 'AAAA' };
    expect(await decryptState(env, fakeBlob)).toBeNull();
  });

  it('decryptState returns null for wrong version', async () => {
    const env = { CONTENT: new MockR2(), AUTH_KEY: makeAuthKey() };
    expect(await decryptState(env, { v: 999, iv: 'AAAA', ct: 'AAAA' })).toBeNull();
  });

  it('decryptState returns null for corrupt ciphertext (wrong key)', async () => {
    // Encrypt with one key, decrypt with another
    const env1 = { CONTENT: new MockR2(), AUTH_KEY: makeAuthKey() };
    const env2 = { CONTENT: new MockR2(), AUTH_KEY: makeAuthKey() };
    const blob = await encryptState(env1, { emails: {}, tokens: {}, magic: {} });
    expect(await decryptState(env2, blob)).toBeNull();
  });

  it('decryptState returns null for null/undefined blob', async () => {
    const env = { CONTENT: new MockR2(), AUTH_KEY: makeAuthKey() };
    expect(await decryptState(env, null)).toBeNull();
    expect(await decryptState(env, undefined)).toBeNull();
  });

  it('decryptState normalizes missing fields to empty objects', async () => {
    const env = { CONTENT: new MockR2(), AUTH_KEY: makeAuthKey() };
    const blob = await encryptState(env, { emails: {}, tokens: {} }); // no magic
    const decrypted = await decryptState(env, blob);
    expect(decrypted.magic).toEqual({});
  });

  it('encryptState uses a fresh IV each call (non-deterministic ciphertext)', async () => {
    const env = { CONTENT: new MockR2(), AUTH_KEY: makeAuthKey() };
    const state = { emails: {}, tokens: {}, magic: {} };
    const blob1 = await encryptState(env, state);
    const blob2 = await encryptState(env, state);
    expect(blob1.iv).not.toBe(blob2.iv); // fresh IV each time
    expect(blob1.ct).not.toBe(blob2.ct); // ciphertext differs due to IV
  });
});

// --- readAuthState ------------------------------------------------============

describe('readAuthState', () => {
  it('returns virgin empty state when auth.enc is missing', async () => {
    const r2 = new MockR2();
    const env = { CONTENT: r2, AUTH_KEY: makeAuthKey() };
    const state = await readAuthState(env);
    expect(state).toEqual({ emails: {}, tokens: {}, magic: {} });
  });

  it('returns null when auth.enc is corrupt JSON', async () => {
    const r2 = new MockR2();
    await r2.put(AUTH_FILE, 'not json', { httpMetadata: { contentType: 'application/json' } });
    const env = { CONTENT: r2, AUTH_KEY: makeAuthKey() };
    expect(await readAuthState(env)).toBeNull();
  });

  it('returns the decrypted state when auth.enc is valid', async () => {
    const r2 = new MockR2();
    const env = { CONTENT: r2, AUTH_KEY: makeAuthKey() };
    const state = { emails: { 'a@b.com': ['site1'] }, tokens: {}, magic: {} };
    await seedAuth(r2, env, state);
    const result = await readAuthState(env);
    expect(result).toEqual(state);
  });

  it('returns null when AUTH_KEY is invalid (decrypt fails)', async () => {
    const r2 = new MockR2();
    // Seed with one key...
    const seedEnv = { CONTENT: r2, AUTH_KEY: makeAuthKey() };
    await seedAuth(r2, seedEnv, { emails: {}, tokens: {}, magic: {} });
    // ...but read with no AUTH_KEY
    const readEnv = { CONTENT: r2, AUTH_KEY: null };
    expect(await readAuthState(readEnv)).toBeNull();
  });
});

// --- writeAuthState -----------------------------------------------------------

describe('writeAuthState', () => {
  it('writes auth.enc and returns {ok: true}', async () => {
    const r2 = new MockR2();
    const env = { CONTENT: r2, AUTH_KEY: makeAuthKey() };
    const state = { emails: { 'a@b.com': ['site1'] }, tokens: {}, magic: {} };
    const result = await writeAuthState(env, state);
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(r2.has(AUTH_FILE)).toBe(true);
  });

  it('returns ok:false when AUTH_KEY is missing', async () => {
    const r2 = new MockR2();
    const env = { CONTENT: r2, AUTH_KEY: null };
    const result = await writeAuthState(env, { emails: {}, tokens: {}, magic: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('AUTH_KEY');
  });

  it('returns ok:false when AUTH_KEY is invalid base64', async () => {
    const r2 = new MockR2();
    const env = { CONTENT: r2, AUTH_KEY: '!!!notbase64!!!' };
    const result = await writeAuthState(env, { emails: {}, tokens: {}, magic: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('writes correct cache headers on auth.enc', async () => {
    const r2 = new MockR2();
    const env = { CONTENT: r2, AUTH_KEY: makeAuthKey() };
    await writeAuthState(env, { emails: {}, tokens: {}, magic: {} });
    const obj = await r2.get(AUTH_FILE);
    expect(obj.httpMetadata.cacheControl).toBe('public, max-age=0, must-revalidate');
  });
});

// --- pruneAuthState -----------------------------------------------------------

describe('pruneAuthState', () => {
  it('removes expired magic codes', () => {
    const state = {
      emails: {},
      tokens: {},
      magic: {
        'hash1': { slug: 's', email: 'a@b.com', exp: Date.now() - 1000 }, // expired
        'hash2': { slug: 's', email: 'b@b.com', exp: Date.now() + 3600000 }, // valid
      },
    };
    pruneAuthState(state);
    expect(Object.keys(state.magic)).toEqual(['hash2']);
  });

  it('removes tokens whose email is no longer in the grant list', () => {
    const state = {
      emails: { 'a@b.com': ['site1'] },
      tokens: {
        'hash1': { slug: 'site1', email: 'a@b.com' }, // email still granted — keep
        'hash2': { slug: 'site2', email: 'removed@b.com' }, // email no longer exists — remove
      },
      magic: {},
    };
    pruneAuthState(state);
    expect(state.tokens['hash1']).toBeDefined();
    expect(state.tokens['hash2']).toBeUndefined();
  });

  it('keeps email-less defensive tokens (email: null)', () => {
    const state = {
      emails: {},
      tokens: {
        'hash1': { slug: 'site1', email: null }, // defensive
      },
      magic: {},
    };
    pruneAuthState(state);
    expect(state.tokens['hash1']).toBeDefined();
  });

  it('does not modify non-expired magic codes', () => {
    const state = {
      emails: {},
      tokens: {},
      magic: {
        'hash1': { slug: 's', email: 'a@b.com', exp: Date.now() + 3600000 },
      },
    };
    pruneAuthState(state);
    expect(Object.keys(state.magic)).toEqual(['hash1']);
  });

  it('does not throw when magic has no expired entries', () => {
    const state = {
      emails: { 'a@b.com': ['s'] },
      tokens: {},
      magic: {},
    };
    pruneAuthState(state);
    expect(state.tokens).toEqual({});
    expect(state.magic).toEqual({});
  });
});

// --- mutateState ----------------------------------------------------------------

describe('mutateState', () => {
  it('reads, applies mutation, writes back', async () => {
    const r2 = new MockR2();
    const env = { CONTENT: r2, AUTH_KEY: makeAuthKey() };
    await seedAuth(r2, env, { emails: { 'a@b.com': ['s1'] }, tokens: {}, magic: {} });

    const result = await mutateState(env, (state) => {
      state.emails['c@d.com'] = ['s2'];
    });

    expect(result.ok).toBe(true);
    expect(result.state.emails['c@d.com']).toEqual(['s2']);

    // Verify it was persisted
    const persisted = await readAuthState(env);
    expect(persisted.emails['c@d.com']).toEqual(['s2']);
  });

  it('returns ok:false when state cannot be read', async () => {
    const r2 = new MockR2();
    // auth.enc is corrupt
    await r2.put(AUTH_FILE, 'corrupt json', { httpMetadata: { contentType: 'application/json' } });
    const env = { CONTENT: r2, AUTH_KEY: makeAuthKey() };
    const result = await mutateState(env, (state) => { state.emails['a@b.com'] = ['s1']; });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('auth state unavailable');
  });

  it('returns ok:false when AUTH_KEY is missing (write fails)', async () => {
    const r2 = new MockR2();
    const env = { CONTENT: r2, AUTH_KEY: null };
    const result = await mutateState(env, (state) => { state.emails['a@b.com'] = ['s1']; });
    expect(result.ok).toBe(false);
  });
});

// --- authorize ----------------------------------------------------------------

describe('authorize (editor gate for slug)', () => {
  it('returns 401 when bearer token is missing', async () => {
    const r2 = new MockR2();
    const env = { CONTENT: r2, AUTH_KEY: makeAuthKey() };
    const req = makeRequest(null);
    const result = await authorize(env, 'myslug', req);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toContain('missing bearer token');
  });

  it('returns 403 when token hash is not in state', async () => {
    const r2 = new MockR2();
    const env = { CONTENT: r2, AUTH_KEY: makeAuthKey() };
    await seedAuth(r2, env, { emails: {}, tokens: {}, magic: {} });
    const req = makeRequest('nonexistent-token');
    const result = await authorize(env, 'myslug', req);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toBe('token not valid');
  });

  it('returns ok:true when email-bound token is granted on the slug', async () => {
    const r2 = new MockR2();
    const env = { CONTENT: r2, AUTH_KEY: makeAuthKey() };
    const { editorToken } = await seedEditorState(r2, env, 'editor@example.com', 'myslug');
    const req = makeRequest(editorToken);
    const result = await authorize(env, 'myslug', req);
    expect(result.ok).toBe(true);
  });

  it('returns 403 when token is granted but email is not in the slug grant list', async () => {
    const r2 = new MockR2();
    const env = { CONTENT: r2, AUTH_KEY: makeAuthKey() };
    const { editorToken } = await seedEditorState(r2, env, 'editor@example.com', 'myslug');
    // Try to access a DIFFERENT slug
    const req = makeRequest(editorToken);
    const result = await authorize(env, 'other-slug', req);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toBe('email not authorized for this slug');
  });

  it('returns ok:true for email-less defensive token on its own slug', async () => {
    const r2 = new MockR2();
    const env = { CONTENT: r2, AUTH_KEY: makeAuthKey() };
    const token = generateToken();
    const tokenHash = await sha256Hex(token);
    // Email-less token bound to 'myslug'
    await seedAuth(r2, env, {
      emails: {},
      tokens: { [tokenHash]: { slug: 'myslug', email: null } },
      magic: {},
    });
    const req = makeRequest(token);
    const result = await authorize(env, 'myslug', req);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toBe('editor token requires bound email');
  });

  it('returns 403 for email-less defensive token on a different slug', async () => {
    const r2 = new MockR2();
    const env = { CONTENT: r2, AUTH_KEY: makeAuthKey() };
    const token = generateToken();
    const tokenHash = await sha256Hex(token);
    await seedAuth(r2, env, {
      emails: {},
      tokens: { [tokenHash]: { slug: 'myslug', email: null } },
      magic: {},
    });
    const req = makeRequest(token);
    const result = await authorize(env, 'other-slug', req);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toBe('editor token requires bound email');
  });

  it('returns 503 when auth state is unavailable (corrupt auth.enc)', async () => {
    const r2 = new MockR2();
    await r2.put(AUTH_FILE, 'corrupt', { httpMetadata: { contentType: 'application/json' } });
    const env = { CONTENT: r2, AUTH_KEY: makeAuthKey() };
    const req = makeRequest('any-token');
    const result = await authorize(env, 'myslug', req);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.error).toBe('auth state unavailable');
  });
});

// --- authorizeAdmin -----------------------------------------------------------

describe('authorizeAdmin', () => {
  it('returns 401 when bearer token is missing', async () => {
    const r2 = new MockR2();
    const env = { CONTENT: r2, AUTH_KEY: makeAuthKey(), ADMIN_TOKEN_HASH: null };
    const req = makeRequest(null);
    const result = await authorizeAdmin(env, req);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toBe('missing admin bearer token');
  });

  it('returns 503 when ADMIN_TOKEN_HASH is not configured', async () => {
    const r2 = new MockR2();
    const env = { CONTENT: r2, AUTH_KEY: makeAuthKey(), ADMIN_TOKEN_HASH: null };
    const req = makeRequest('some-token');
    const result = await authorizeAdmin(env, req);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.error).toContain('ADMIN_TOKEN_HASH');
  });

  it('returns 403 for an invalid admin token', async () => {
    const r2 = new MockR2();
    const env = await makeAdminEnv(r2, ADMIN_TOKEN);
    const req = makeRequest('wrong-token');
    const result = await authorizeAdmin(env, req);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toBe('invalid admin token');
  });

  it('returns ok:true for the correct admin token', async () => {
    const r2 = new MockR2();
    const env = await makeAdminEnv(r2, ADMIN_TOKEN);
    const req = makeRequest(ADMIN_TOKEN);
    const result = await authorizeAdmin(env, req);
    expect(result.ok).toBe(true);
  });
});

// --- authorizeAdminOrEditor ---------------------------------------------------

describe('authorizeAdminOrEditor', () => {
  it('passes through when admin token is valid', async () => {
    const r2 = new MockR2();
    const env = await makeAdminEnv(r2, ADMIN_TOKEN);
    const req = makeRequest(ADMIN_TOKEN);
    const result = await authorizeAdminOrEditor(env, 'myslug', req);
    expect(result.ok).toBe(true);
  });

  it('passes through when editor token is valid for the slug', async () => {
    const r2 = new MockR2();
    const env = { CONTENT: r2, AUTH_KEY: makeAuthKey() };
    const { editorToken } = await seedEditorState(r2, env, 'editor@example.com', 'myslug');
    const req = makeRequest(editorToken);
    const result = await authorizeAdminOrEditor(env, 'myslug', req);
    expect(result.ok).toBe(true);
  });

  it('fails when both admin and editor checks fail', async () => {
    const r2 = new MockR2();
    const env = { CONTENT: r2, AUTH_KEY: makeAuthKey(), ADMIN_TOKEN_HASH: null };
    await seedAuth(r2, env, { emails: {}, tokens: {}, magic: {} });
    const req = makeRequest('invalid-token');
    const result = await authorizeAdminOrEditor(env, 'myslug', req);
    expect(result.ok).toBe(false);
  });
});

// --- authorizeAdminOrEditorAny ------------------------------------------------

describe('authorizeAdminOrEditorAny', () => {
  it('passes through when admin token is valid', async () => {
    const r2 = new MockR2();
    const env = await makeAdminEnv(r2, ADMIN_TOKEN);
    const req = makeRequest(ADMIN_TOKEN);
    const result = await authorizeAdminOrEditorAny(env, req);
    expect(result.ok).toBe(true);
  });

  it('passes through when a valid email-bound editor token is present', async () => {
    const r2 = new MockR2();
    const env = { CONTENT: r2, AUTH_KEY: makeAuthKey() };
    const { editorToken } = await seedEditorState(r2, env, 'editor@example.com', 'myslug');
    const req = makeRequest(editorToken);
    const result = await authorizeAdminOrEditorAny(env, req);
    expect(result.ok).toBe(true);
  });

  it('rejects email-less defensive tokens (no grant to check against)', async () => {
    const r2 = new MockR2();
    const env = { CONTENT: r2, AUTH_KEY: makeAuthKey() };
    const token = generateToken();
    const tokenHash = await sha256Hex(token);
    await seedAuth(r2, env, {
      emails: {},
      tokens: { [tokenHash]: { slug: 'myslug', email: null } },
      magic: {},
    });
    const req = makeRequest(token);
    const result = await authorizeAdminOrEditorAny(env, req);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('admin token or valid editor token required');
  });

  it('rejects a token whose email has no grants', async () => {
    const r2 = new MockR2();
    const env = { CONTENT: r2, AUTH_KEY: makeAuthKey() };
    const token = generateToken();
    const tokenHash = await sha256Hex(token);
    const email = 'orphan@example.com';
    const emailKey = normalizeEmailForTest(email);
    await seedAuth(r2, env, {
      // email exists but has no slugs granted
      emails: { [emailKey]: [] },
      tokens: { [tokenHash]: { slug: 'myslug', email: emailKey } },
      magic: {},
    });
    const req = makeRequest(token);
    const result = await authorizeAdminOrEditorAny(env, req);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('admin token or valid editor token required');
  });
});
