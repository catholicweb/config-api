// In-memory R2 mock for testing the config-api Worker.
//
// Implements the subset of the Cloudflare R2 binding interface used by
// src/index.js: get, put, list, delete, head. Objects track their HTTP
// metadata so tests can assert Cache-Control, content-type, etc.

export class MockR2Object {
  constructor(key, value, httpMetadata) {
    this.key = key;
    this._value = value;
    this.httpMetadata = httpMetadata || {};
    this.size = typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength || 0;
    this.etag = this._computeEtag();
    this.version = 'mock';
    this.uploaded = new Date().toISOString();
    this.modified = new Date().toISOString();
  }

  _computeEtag() {
    // Simple deterministic etag based on key+size+timestamp
    return `"${this.key}-${this.size}-${Date.now()}"`;
  }

  // Accept value as string, ArrayBuffer, Uint8Array, or Blob-like
  _asBytes() {
    if (this._value == null) return new Uint8Array(0);
    if (typeof this._value === 'string') {
      return new TextEncoder().encode(this._value);
    }
    if (this._value instanceof ArrayBuffer) {
      return new Uint8Array(this._value);
    }
    if (this._value instanceof Uint8Array) {
      return this._value;
    }
    if (typeof this._value?.byteLength === 'number') {
      return new Uint8Array(this._value.buffer, this._value.byteOffset, this._value.byteLength);
    }
    // Fallback: stringify
    return new TextEncoder().encode(String(this._value));
  }

  async text() {
    return new TextDecoder().decode(this._asBytes());
  }

  async arrayBuffer() {
    return this._asBytes().buffer.slice(
      this._asBytes().byteOffset,
      this._asBytes().byteOffset + this._asBytes().byteLength,
    );
  }

  async json() {
    return JSON.parse(await this.text());
  }

  async blob() {
    const bytes = this._asBytes();
    return new Blob([bytes]);
  }

  get body() {
    // Return the raw stored value for tests that need it
    return this._value;
  }

  get customHttpMetadata() {
    return {};
  }

  get httpEtag() {
    return this.etag;
  }
}

export class MockR2 {
  constructor() {
    this._store = new Map();
  }

  // --- R2 binding interface ---

  async get(key, options) {
    const entry = this._store.get(key);
    if (!entry) return null;

    // Support the `type` option: 'arrayBuffer' | 'text' | 'blob' | 'stream'
    const type = options?.type?.toLowerCase();

    if (type === 'arraybuffer') {
      return await entry.arrayBuffer();
    }
    if (type === 'blob') {
      return await entry.blob();
    }
    // Default: return the object wrapper (matches R2's default behavior)
    return entry;
  }

  async put(key, value, options = {}) {
    // The worker passes request.body (a ReadableStream in the Fetch API) directly
    // to CONTENT.put(). We must drain the stream into a buffer before storing.
    let stored = value;
    if (typeof value?.getReader === 'function') {
      const reader = value.getReader();
      const chunks = [];
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        chunks.push(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk);
      }
      stored = new Uint8Array(await new Blob(chunks).arrayBuffer());
    }
    const entry = new MockR2Object(key, stored, options.httpMetadata || {});
    this._store.set(key, entry);
  }

  async list(options = {}) {
    const { limit = 1000, cursor, prefix, delimiter } = options;

    // Get all keys that match the prefix
    let keys = Array.from(this._store.keys()).filter((k) => {
      if (!prefix || k.startsWith(prefix)) return true;
      return false;
    });
    keys.sort(); // deterministic order

    // Apply cursor (skip keys before the cursor)
    if (cursor) {
      const cursorIdx = keys.indexOf(cursor);
      if (cursorIdx !== -1) {
        keys = keys.slice(cursorIdx + 1);
      }
    }

    // Handle delimiter: group keys under the delimiter prefix
    let objects = [];
    let delimitedPrefixes = [];

    if (delimiter) {
      const delim = delimiter;
      const afterPrefix = keys.filter((k) => k.slice(prefix?.length || 0).includes(delim));

      // Objects that don't have the delimiter in their path (after prefix)
      objects = keys
        .filter((k) => !(k.slice(prefix?.length || 0).includes(delim)))
        .slice(0, limit)
        .map((k) => this._store.get(k));

      // Delimited prefixes: unique prefixes up to and including the delimiter
      const prefixSet = new Set();
      for (const k of keys) {
        const rest = k.slice(prefix?.length || 0);
        if (rest.includes(delim)) {
          const idx = rest.indexOf(delim);
          const pfx = (prefix || '') + rest.slice(0, idx + delim.length);
          prefixSet.add(pfx);
        }
      }
      delimitedPrefixes = Array.from(prefixSet).sort();
    } else {
      objects = keys.slice(0, limit).map((k) => this._store.get(k));
    }

    const hasMore = keys.length > limit;
    const result = {
      objects,
      delimitedPrefixes,
      truncated: hasMore,
      count: objects.length,
    };

    if (hasMore) {
      // Return cursor as the last key we returned
      const lastKey = keys[limit - 1];
      result.cursor = lastKey;
    }

    return result;
  }

  async delete(key) {
    if (Array.isArray(key)) {
      for (const k of key) this._store.delete(k);
    } else {
      this._store.delete(key);
    }
  }

  async head(key) {
    return this._store.get(key) || null;
  }

  // --- Test helpers ---

  /** Create a mock env object suitable for passing to the worker's fetch handler. */
  makeEnv(overrides = {}) {
    const AUTH_KEY = this._generateAuthKey();
    return {
      CONTENT: this,
      AUTH_KEY,
      ...overrides,
    };
  }

  _generateAuthKey() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    // Base64 encode (browser/worker-compatible)
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }

  /** Seed auth.enc with a pre-built state object (encrypted under the env's AUTH_KEY). */
  async seedAuth(env, state) {
    const { encryptState, AUTH_FILE } = await import('../../src/index.js');
    const blob = await encryptState(env, state);
    await this.put(AUTH_FILE, JSON.stringify(blob), {
      httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=0, must-revalidate' },
    });
    return blob;
  }

  /** Clear all stored objects. */
  reset() {
    this._store.clear();
  }

  /** Check if a key exists. */
  has(key) {
    return this._store.has(key);
  }

  /** Get raw value as string. */
  async getRawText(key) {
    const obj = await this.get(key);
    return obj ? await obj.text() : null;
  }
}

export default MockR2;
