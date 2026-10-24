// Parity guard for src/patch.js, which is MIRRORED byte-for-byte in the editor
// (see the header of src/patch.js). A divergence corrupts concurrent saves
// silently, and no CI job runs the tests (this repo deploys on push to main), so
// this suite must be hard to ignore:
//
//   * It never skips by itself. If the counterpart can't be read it FAILS.
//     PARITY_SKIP=1 is the only deliberate opt-out.
//   * Counterpart lookup, first match wins:
//       1. a sibling clone ../editor/docs/.vitepress/theme/lib/patch.js
//          (PARITY_REMOTE=1 ignores it)
//       2. GitHub, on the same-named branch as this checkout / PR (PARITY_REF,
//          GITHUB_HEAD_REF, current git branch), so two PRs that change both
//          files together validate each other
//       3. GitHub, main
//   * Everything after the leading comment block is compared, so code placed
//     before the first `export` is compared too.
//   * Both headers must name each other, so the warning can't be deleted unnoticed.
//
// The mirror of this test lives in editor/tests/parity.test.js.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const OWNER = 'catholicweb';
const SELF = 'config-api';
const ROOT = process.cwd();
const SKIP = process.env.PARITY_SKIP === '1';

const PAIR = {
  local: 'src/patch.js',
  repo: 'editor',
  path: 'docs/.vitepress/theme/lib/patch.js',
};

function currentBranch() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

const REFS = [
  ...new Set([process.env.PARITY_REF, process.env.GITHUB_HEAD_REF, currentBranch(), 'main'].filter((r) => r && r !== 'HEAD')),
];

async function get(url, headers) {
  try {
    const res = await fetch(url, { headers });
    return { status: res.status, text: res.ok ? await res.text() : null };
  } catch {
    return { status: 0, text: null }; // offline
  }
}

async function fetchFromGitHub() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const auth = token ? { Authorization: `Bearer ${token}` } : {};
  for (const ref of REFS) {
    // raw.githubusercontent.com first: unlike the REST API (60 requests/hour per
    // IP when unauthenticated, easily exhausted on shared IPs) it has no such
    // limit. The unique query string bypasses its CDN cache, so a branch pushed
    // a moment ago is read fresh.
    const raw = await get(`https://raw.githubusercontent.com/${OWNER}/${PAIR.repo}/${ref}/${PAIR.path}?nocache=${Date.now()}`, auth);
    if (raw.text !== null) return { code: raw.text, from: `github ${OWNER}/${PAIR.repo}@${ref}` };
    if (raw.status === 404) continue; // no such branch / file: try the next ref
    const api = await get(`https://api.github.com/repos/${OWNER}/${PAIR.repo}/contents/${PAIR.path}?ref=${encodeURIComponent(ref)}`, {
      Accept: 'application/vnd.github.raw+json',
      'User-Agent': 'parity-test',
      ...auth,
    });
    if (api.text !== null) return { code: api.text, from: `github ${OWNER}/${PAIR.repo}@${ref}` };
  }
  return null;
}

async function loadCounterpart() {
  const sibling = resolve(ROOT, '..', PAIR.repo, PAIR.path);
  if (!process.env.PARITY_REMOTE && existsSync(sibling)) {
    return { code: readFileSync(sibling, 'utf-8'), from: `sibling clone ${sibling}` };
  }
  return fetchFromGitHub();
}

// Drop the leading comment/blank lines (the header); compare everything else.
function stripLeadingComments(code) {
  const lines = code.replace(/\r\n/g, '\n').split('\n');
  const i = lines.findIndex((l) => !/^\s*(\/\/.*)?$/.test(l));
  return i === -1 ? '' : lines.slice(i).join('\n');
}

function lineDiff(a, b) {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const diffs = [];
  for (let i = 0; i < Math.max(aLines.length, bLines.length); i++) {
    if (aLines[i] !== bLines[i]) diffs.push({ line: i + 1, here: aLines[i] ?? '<missing>', there: bLines[i] ?? '<missing>' });
  }
  return diffs;
}

const local = readFileSync(resolve(ROOT, PAIR.local), 'utf-8');
const other = await loadCounterpart();

describe(`patch.js mirrors ${PAIR.repo}/${PAIR.path}`, () => {
  it.skipIf(SKIP)('counterpart is readable', () => {
    expect(
      other,
      `Could not read ${PAIR.repo}/${PAIR.path}: no sibling clone at ../${PAIR.repo} and GitHub is unreachable ` +
        `(tried refs: ${REFS.join(', ')}). Fix access, or set PARITY_SKIP=1 to skip deliberately.`,
    ).toBeTruthy();
  });

  it.skipIf(SKIP || !other)('code is byte-for-byte identical (minus the leading comment block)', () => {
    const a = stripLeadingComments(local);
    const b = stripLeadingComments(other.code);
    if (a !== b) {
      const diffs = lineDiff(a, b);
      const preview = diffs
        .slice(0, 15)
        .map((d) => `  L${d.line}: here="${d.here.trim()}" | there="${d.there.trim()}"`)
        .join('\n');
      const more = diffs.length > 15 ? `\n  ...and ${diffs.length - 15} more` : '';
      throw new Error(
        `patch.js diverges from ${other.from} (${diffs.length} differing lines):\n${preview}${more}\n\n` +
          `Change BOTH files in the same piece of work (same branch name in both repos).`,
      );
    }
    expect(a).toBe(b);
  });

  it.skipIf(SKIP || !other)('both headers name each other', () => {
    expect(local, 'header must link to the counterpart').toContain(`github.com/${OWNER}/${PAIR.repo}/blob/`);
    expect(local).toContain(PAIR.path);
    expect(other.code, 'counterpart header must link back here').toContain(`github.com/${OWNER}/${SELF}/blob/`);
    expect(other.code).toContain(PAIR.local);
  });
});
