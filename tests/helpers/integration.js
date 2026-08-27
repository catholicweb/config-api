// Shared helpers for integration tests.
//
// These helpers wire up the worker's default fetch handler with a MockR2-backed
// env, a mock ctx (for waitUntil), and pre-seeded auth state so tests can hit
// real routing paths end-to-end.

import { sha256Hex, generateToken, AUTH_FILE, MAGIC_TTL_MS } from '../../src/index.js';
import { MockR2 } from './mock-r2.js';

/** Create a mock ctx with a no-op waitUntil that captures promises for assertions. */
export function makeCtx() {
  const pending = [];
  return {
    waitUntil(promise) {
      pending.push(promise);
    },
    pending,
    async flush() {
      await Promise.all(this.pending);
      this.pending.length = 0;
    },
  };
}

/** Create a test env with a valid AUTH_KEY and optional ADMIN_TOKEN_HASH. */
export async function makeTestEnv(r2, adminToken = null) {
  const env = r2.makeEnv();
  if (adminToken !== null) {
    env.ADMIN_TOKEN_HASH = await sha256Hex(adminToken);
  }
  return env;
}

/** Seed an editor token in the auth state bound to `email` for `slug`. */
export async function seedEditor(r2, env, email, slug) {
  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  const normalizedEmail = email.trim().toLowerCase();
  const state = {
    emails: { [normalizedEmail]: [slug] },
    tokens: { [tokenHash]: { slug, email: normalizedEmail } },
    magic: {},
  };
  await r2.seedAuth(env, state);
  return { token, state };
}

/** Seed a magic code in the auth state for `email` on `slug`. */
export async function seedMagicCode(r2, env, email, slug, ttlMs = MAGIC_TTL_MS + 1000) {
  const code = generateToken();
  const codeHash = await sha256Hex(code);
  const normalizedEmail = email.trim().toLowerCase();
  const state = {
    emails: { [normalizedEmail]: [slug] },
    tokens: {},
    magic: { [codeHash]: { slug, email: normalizedEmail, exp: Date.now() + ttlMs } },
  };
  await r2.seedAuth(env, state);
  return { code, state };
}

/** Seed the site template at `plantilla/config.json`. */
export async function seedTemplate(r2, template = { name: 'My Site', version: 1 }) {
  await r2.put('plantilla/config.json', JSON.stringify(template, null, 2) + '\n', {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=31536000, immutable' },
  });
}

/** Seed a site marker so siteExists() returns true (config.json is the marker). */
export async function seedSiteMarker(r2, slug) {
  await r2.put(`${slug}/config.json`, '{"ok":true}\n', {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=0, must-revalidate' },
  });
}

export { MockR2 };
