// Unit tests for the validation layer of src/index.js.
//
// These are the security-critical path-traversal defense functions — they
// must reject any filename or slug that could escape the intended R2 key
// namespace. Imported from the worker's named exports (added for testability;
// zero behavioral change — these were already module-private functions).

import { describe, it, expect } from 'vitest';
import {
  SLUG_RE,
  RESERVED_SLUGS,
  ALLOWED_EXT,
  FILENAME_RE,
  validateFilename,
  validateSlug,
  validateSlugNotReserved,
  validateToken,
  validateEmail,
  normalizeEmail,
} from '../../src/index.js';

// --- FILENAME_RE & validateFilename -------------------------------------------

describe('FILENAME_RE', () => {
  it('matches simple alphanumeric names', () => {
    expect(FILENAME_RE.test('hello')).toBe(true);
    expect(FILENAME_RE.test('file123')).toBe(true);
    expect(FILENAME_RE.test('my-file_name')).toBe(true);
  });

  it('matches names with an allowlisted extension', () => {
    expect(FILENAME_RE.test('photo.jpg')).toBe(true);
    expect(FILENAME_RE.test('doc.json')).toBe(true);
    expect(FILENAME_RE.test('page.md')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(FILENAME_RE.test('')).toBe(false);
  });

  it('rejects names starting with a dot (hidden files)', () => {
    expect(FILENAME_RE.test('.env')).toBe(false);
    expect(FILENAME_RE.test('.htaccess')).toBe(false);
  });

  it('rejects names with path separators', () => {
    expect(FILENAME_RE.test('path/to/file')).toBe(false);
    expect(FILENAME_RE.test('a/b')).toBe(false);
  });

  it('rejects names with consecutive dots (traversal)', () => {
    expect(FILENAME_RE.test('..')).toBe(false);
    expect(FILENAME_RE.test('a..b')).toBe(false);
    expect(FILENAME_RE.test('a/../b')).toBe(false);
  });

  it('rejects names with spaces', () => {
    expect(FILENAME_RE.test('hello world')).toBe(false);
  });

  it('rejects names with special characters', () => {
    expect(FILENAME_RE.test('file@name')).toBe(false);
    expect(FILENAME_RE.test('file#name')).toBe(false);
    expect(FILENAME_RE.test('file!name')).toBe(false);
  });

  it('allows exactly one extension dot', () => {
    expect(FILENAME_RE.test('a.b')).toBe(true);
    expect(FILENAME_RE.test('a.b.c')).toBe(false);
  });
});

describe('validateFilename', () => {
  it('accepts valid filenames', () => {
    expect(validateFilename('index.json')).toBe(true);
    expect(validateFilename('config.json')).toBe(true);
    expect(validateFilename('photo.jpg')).toBe(true);
    expect(validateFilename('README.md')).toBe(true);
    expect(validateFilename('file_name-01.jpeg')).toBe(true);
  });

  it('rejects null and undefined', () => {
    expect(validateFilename(null)).toBe(false);
    expect(validateFilename(undefined)).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(validateFilename(123)).toBe(false);
    expect(validateFilename({})).toBe(false);
    expect(validateFilename([])).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateFilename('')).toBe(false);
  });

  it('rejects filenames over 255 chars', () => {
    const long = 'a'.repeat(256);
    expect(validateFilename(long)).toBe(false);
  });

  it('accepts filenames at exactly 255 chars', () => {
    // .json is 5 chars; 250 + 5 = 255 (the max)
    const max = 'a'.repeat(250) + '.json';
    expect(max.length).toBe(255);
    expect(validateFilename(max)).toBe(true);
  });

  it('rejects leading hyphen (CLI arg injection guard)', () => {
    expect(validateFilename('-rf')).toBe(false);
    expect(validateFilename('-config.json')).toBe(false);
  });

  it('rejects double extension spoofing', () => {
    // .jpg.exe — second extension not in charset
    expect(validateFilename('photo.jpg.exe')).toBe(false);
    // .php disguised as image
    expect(validateFilename('image.jpg.php')).toBe(false);
  });

  it('rejects path traversal attempts', () => {
    expect(validateFilename('..')).toBe(false);
    expect(validateFilename('../etc/passwd')).toBe(false);
    expect(validateFilename('a/../b')).toBe(false);
    expect(validateFilename('..%2f')).toBe(false);
    // Encoded dots — the server uses the filename verbatim, but the
    // regex rejects any dot that isn't a single trailing extension separator
    expect(validateFilename('file.name.json')).toBe(false);
  });

  it('rejects hidden files (leading dot)', () => {
    expect(validateFilename('.env')).toBe(false);
    expect(validateFilename('.htaccess')).toBe(false);
    expect(validateFilename('.site')).toBe(false);
  });

  it('rejects filenames with directory separators', () => {
    expect(validateFilename('a/b')).toBe(false);
    expect(validateFilename('a\\b')).toBe(false);
  });

  it('rejects filenames with spaces', () => {
    expect(validateFilename('hello world.json')).toBe(false);
  });

  it('enforces the ALLOWED_EXT extension list', () => {
    // Allowed extensions pass
    expect(validateFilename('file.md')).toBe(true);
    expect(validateFilename('file.jpg')).toBe(true);
    expect(validateFilename('file.jpeg')).toBe(true);
    expect(validateFilename('file.png')).toBe(true);
    expect(validateFilename('file.gif')).toBe(true);
    expect(validateFilename('file.webp')).toBe(true);
    expect(validateFilename('file.pdf')).toBe(true);
    expect(validateFilename('file.json')).toBe(true);
    // Disallowed extensions fail
    expect(validateFilename('file.php')).toBe(false);
    expect(validateFilename('file.html')).toBe(false);
    expect(validateFilename('file.exe')).toBe(false);
    expect(validateFilename('file.sh')).toBe(false);
  });

  it('rejects uppercase extensions (FILENAME_RE only allows lowercase ext charset)', () => {
    // The regex [a-z0-9]{1,5} for extensions means uppercase extensions
    // like .JPG never pass the regex — they're rejected before the
    // ALLOWED_EXT check (which does toLowerCase()).
    expect(validateFilename('photo.JPG')).toBe(false);
    expect(validateFilename('config.JSON')).toBe(false);
  });

  it('rejects 5-char extensions that are not in ALLOWED_EXT', () => {
    // xxxxx matches the regex charset/length but isn't a permitted extension
    expect(validateFilename('file.xxxxx')).toBe(false);
  });

  it('rejects 6-char extensions', () => {
    expect(validateFilename('file.xxxxxx')).toBe(false);
  });
});

// --- SLUG_RE & validateSlug ---------------------------------------------------

describe('SLUG_RE', () => {
  it('matches simple lowercase slugs', () => {
    expect(SLUG_RE.test('abc')).toBe(true);
    expect(SLUG_RE.test('parroquia')).toBe(true);
    expect(SLUG_RE.test('site-1')).toBe(true);
    expect(SLUG_RE.test('a-b-c')).toBe(true);
  });

  it('matches slugs with digits', () => {
    expect(SLUG_RE.test('site123')).toBe(true);
    expect(SLUG_RE.test('123')).toBe(true);
    expect(SLUG_RE.test('0')).toBe(true);
  });

  it('matches max-length slug (63 chars)', () => {
    const max = 'a'.repeat(63);
    expect(SLUG_RE.test(max)).toBe(true);
  });

  it('rejects slugs over 63 chars', () => {
    const tooLong = 'a'.repeat(64);
    expect(SLUG_RE.test(tooLong)).toBe(false);
  });

  it('rejects empty slug', () => {
    expect(SLUG_RE.test('')).toBe(false);
  });

  it('rejects slugs with leading hyphen', () => {
    expect(SLUG_RE.test('-site')).toBe(false);
  });

  it('rejects slugs with trailing hyphen', () => {
    expect(SLUG_RE.test('site-')).toBe(false);
  });

  it('rejects slugs with underscores', () => {
    expect(SLUG_RE.test('site_name')).toBe(false);
  });

  it('rejects slugs with dots', () => {
    expect(SLUG_RE.test('sub.domain')).toBe(false);
  });

  it('rejects slugs with spaces', () => {
    expect(SLUG_RE.test('my site')).toBe(false);
  });

  it('rejects uppercase slugs (DNS hostnames are case-insensitive)', () => {
    expect(SLUG_RE.test('MySite')).toBe(false);
    expect(SLUG_RE.test('SITE')).toBe(false);
  });
});

describe('validateSlug', () => {
  it('accepts valid slugs', () => {
    expect(validateSlug('parroquia')).toBe(true);
    expect(validateSlug('site-1')).toBe(true);
    expect(validateSlug('abc123')).toBe(true);
  });

  it('rejects null and undefined', () => {
    expect(validateSlug(null)).toBe(false);
    expect(validateSlug(undefined)).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(validateSlug(123)).toBe(false);
    expect(validateSlug({})).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateSlug('')).toBe(false);
  });

  it('rejects invalid chars', () => {
    expect(validateSlug('my_site')).toBe(false);
    expect(validateSlug('my.site')).toBe(false);
    expect(validateSlug('my site')).toBe(false);
  });
});

// --- RESERVED_SLUGS & validateSlugNotReserved ---------------------------------

describe('RESERVED_SLUGS', () => {
  it('contains api, editor, www, data', () => {
    expect(RESERVED_SLUGS.has('api')).toBe(true);
    expect(RESERVED_SLUGS.has('editor')).toBe(true);
    expect(RESERVED_SLUGS.has('www')).toBe(true);
    expect(RESERVED_SLUGS.has('data')).toBe(true);
  });

  it('does not contain common user slugs', () => {
    expect(RESERVED_SLUGS.has('parroquia')).toBe(false);
    expect(RESERVED_SLUGS.has('santodomingo')).toBe(false);
  });
});

describe('validateSlugNotReserved', () => {
  it('returns true for non-reserved slugs', () => {
    expect(validateSlugNotReserved('parroquia')).toBe(true);
    expect(validateSlugNotReserved('mysite')).toBe(true);
  });

  it('returns false for reserved slugs', () => {
    expect(validateSlugNotReserved('api')).toBe(false);
    expect(validateSlugNotReserved('editor')).toBe(false);
    expect(validateSlugNotReserved('www')).toBe(false);
    expect(validateSlugNotReserved('data')).toBe(false);
  });
});

// --- ALLOWED_EXT ----------------------------------------------------------------

describe('ALLOWED_EXT', () => {
  it('contains the expected set of extensions', () => {
    expect(ALLOWED_EXT).toContain('md');
    expect(ALLOWED_EXT).toContain('jpg');
    expect(ALLOWED_EXT).toContain('jpeg');
    expect(ALLOWED_EXT).toContain('png');
    expect(ALLOWED_EXT).toContain('gif');
    expect(ALLOWED_EXT).toContain('webp');
    expect(ALLOWED_EXT).toContain('pdf');
    expect(ALLOWED_EXT).toContain('json');
  });

  it('does not contain dangerous extensions', () => {
    expect(ALLOWED_EXT).not.toContain('html');
    expect(ALLOWED_EXT).not.toContain('htm');
    expect(ALLOWED_EXT).not.toContain('php');
    expect(ALLOWED_EXT).not.toContain('exe');
    expect(ALLOWED_EXT).not.toContain('sh');
    expect(ALLOWED_EXT).not.toContain('js');
  });
});

// --- validateToken ----------------------------------------------------------------

describe('validateToken', () => {
  it('delegates to validateFilename (same validation rules)', () => {
    expect(validateToken('abc123.json')).toBe(true);
    expect(validateToken('config.json')).toBe(true);
  });

  it('rejects invalid tokens just like filenames', () => {
    expect(validateToken('..')).toBe(false);
    expect(validateToken('a/b')).toBe(false);
    expect(validateToken('.env')).toBe(false);
    expect(validateToken('-bad')).toBe(false);
  });
});

// --- validateEmail & normalizeEmail -------------------------------------------

describe('validateEmail', () => {
  it('accepts well-formed emails', () => {
    expect(validateEmail('user@example.com')).toBe(true);
    expect(validateEmail('first.last@example.co.uk')).toBe(true);
    expect(validateEmail('user+tag@example.org')).toBe(true);
    expect(validateEmail('a@b.c')).toBe(true);
  });

  it('rejects null and undefined', () => {
    expect(validateEmail(null)).toBe(false);
    expect(validateEmail(undefined)).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(validateEmail(123)).toBe(false);
    expect(validateEmail({})).toBe(false);
  });

  it('rejects emails without @', () => {
    expect(validateEmail('notanemail')).toBe(false);
  });

  it('rejects emails without a domain', () => {
    expect(validateEmail('user@')).toBe(false);
  });

  it('rejects emails without a tld', () => {
    expect(validateEmail('user@domain')).toBe(false);
  });

  it('rejects emails with spaces', () => {
    expect(validateEmail('user @example.com')).toBe(false);
    expect(validateEmail('user@ example.com')).toBe(false);
  });
});

describe('normalizeEmail', () => {
  it('lowercases the email', () => {
    expect(normalizeEmail('User@Example.COM')).toBe('user@example.com');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeEmail('  user@example.com  ')).toBe('user@example.com');
  });

  it('combines trim + lowercase', () => {
    expect(normalizeEmail('  User@Example.COM  ')).toBe('user@example.com');
  });
});
