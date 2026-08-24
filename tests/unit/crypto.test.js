// Unit tests for the crypto helper layer of src/index.js.
//
// Tests pure crypto primitives: hashing, timing-safe comparison, token
// generation, and base64 codecs. These use the WebCrypto API available in
// Node 22+ (via global `crypto.subtle` and `crypto.getRandomValues`).

import { describe, it, expect } from 'vitest';
import {
  sha256Hex,
  timingSafeEqual,
  bearerToken,
  generateToken,
  bytesToBase64,
  base64ToBytes,
  toHex,
} from '../../src/index.js';

// --- sha256Hex ----------------------------------------------------------------

describe('sha256Hex', () => {
  it('produces the correct SHA-256 for "hello"', () => {
    // Known: SHA-256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    return expect(sha256Hex('hello')).resolves.toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('produces the correct SHA-256 for empty string', () => {
    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    return expect(sha256Hex('')).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('produces the correct SHA-256 for "abc"', () => {
    // SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    return expect(sha256Hex('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('returns 64 hex characters (256 bits)', () => {
    return sha256Hex('test').then((hash) => {
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('produces different hashes for different inputs', () => {
    return Promise.all([sha256Hex('foo'), sha256Hex('bar')]).then(([a, b]) => {
      expect(a).not.toBe(b);
    });
  });

  it('produces the same hash for the same input (deterministic)', () => {
    return Promise.all([sha256Hex('same'), sha256Hex('same')]).then(([a, b]) => {
      expect(a).toBe(b);
    });
  });
});

// --- timingSafeEqual ----------------------------------------------------------

describe('timingSafeEqual', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
  });

  it('returns true for equal empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it('returns false for different strings of same length', () => {
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
  });

  it('returns false for strings of different lengths', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('abcd', 'abc')).toBe(false);
  });

  it('returns false for non-string inputs', () => {
    expect(timingSafeEqual(null, 'abc')).toBe(false);
    expect(timingSafeEqual('abc', null)).toBe(false);
    expect(timingSafeEqual(undefined, undefined)).toBe(false);
    expect(timingSafeEqual(123, 'abc')).toBe(false);
    expect(timingSafeEqual({}, {})).toBe(false);
  });
});

// --- bearerToken --------------------------------------------------------------

describe('bearerToken', () => {
  function makeRequest(headers) {
    return new Request('https://example.com/', { headers });
  }

  it('extracts a standard Bearer token', () => {
    const req = makeRequest({ Authorization: 'Bearer abc123' });
    expect(bearerToken(req)).toBe('abc123');
  });

  it('is case-insensitive for "Bearer"', () => {
    const req = makeRequest({ Authorization: 'bearer abc123' });
    expect(bearerToken(req)).toBe('abc123');
    const req2 = makeRequest({ Authorization: 'BEARER abc123' });
    expect(bearerToken(req2)).toBe('abc123');
  });

  it('handles lowercase "authorization" header key', () => {
    const req = makeRequest({ authorization: 'Bearer abc123' });
    expect(bearerToken(req)).toBe('abc123');
  });

  it('handles leading/trailing whitespace around the token', () => {
    const req = makeRequest({ Authorization: 'Bearer   abc123  ' });
    expect(bearerToken(req)).toBe('abc123');
  });

  it('returns null when no Authorization header is present', () => {
    const req = makeRequest({});
    expect(bearerToken(req)).toBeNull();
  });

  it('returns null for non-Bearer schemes', () => {
    const req = makeRequest({ Authorization: 'Basic abc123' });
    expect(bearerToken(req)).toBeNull();
  });

  it('returns null for malformed Authorization header', () => {
    const req = makeRequest({ Authorization: 'Bearer' });
    expect(bearerToken(req)).toBeNull();
  });
});

// --- generateToken ------------------------------------------------------------

describe('generateToken', () => {
  it('produces a 64-character hex string (256 bits)', () => {
    const token = generateToken();
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces unique tokens on consecutive calls', () => {
    const tokens = new Set();
    for (let i = 0; i < 100; i++) {
      tokens.add(generateToken());
    }
    // 100 random 256-bit tokens should all be unique
    expect(tokens.size).toBe(100);
  });

  it('only uses lowercase hex characters', () => {
    const token = generateToken();
    expect(token).toBe(token.toLowerCase());
    expect(token).not.toBe(token.toUpperCase());
  });
});

// --- bytesToBase64 / base64ToBytes --------------------------------------------

describe('bytesToBase64 / base64ToBytes', () => {
  it('roundtrips a simple byte array', () => {
    const original = new Uint8Array([0, 1, 2, 3, 255]);
    const b64 = bytesToBase64(original);
    const recovered = base64ToBytes(b64);
    expect(recovered).toBeInstanceOf(Uint8Array);
    expect(Array.from(recovered)).toEqual([0, 1, 2, 3, 255]);
  });

  it('roundtrips an empty byte array', () => {
    const b64 = bytesToBase64(new Uint8Array([]));
    const recovered = base64ToBytes(b64);
    expect(recovered).toBeInstanceOf(Uint8Array);
    expect(recovered.length).toBe(0);
  });

  it('produces valid base64', () => {
    const b64 = bytesToBase64(new Uint8Array([72, 101, 108, 108, 111])); // "Hello"
    // btoa('Hello') = "SGVsbG8="
    expect(b64).toBe('SGVsbG8=');
  });

  it('base64ToBytes decodes "SGVsbG8=" to "Hello"', () => {
    const bytes = base64ToBytes('SGVsbG8=');
    expect(new TextDecoder().decode(bytes)).toBe('Hello');
  });
});

// --- toHex --------------------------------------------------------------------

describe('toHex', () => {
  it('converts a Uint8Array to lowercase hex', () => {
    const bytes = new Uint8Array([0, 1, 2, 15, 255]);
    expect(toHex(bytes)).toBe('0001020fff');
  });

  it('converts an empty Uint8Array to empty string', () => {
    expect(toHex(new Uint8Array([]))).toBe('');
  });

  it('pads single-digit values with leading zero', () => {
    const bytes = new Uint8Array([1]);
    expect(toHex(bytes)).toBe('01');
  });
});
