// Byte-for-byte parity test from the config-api side.
//
// config-api/src/patch.js MUST be identical to editor/docs/.vitepress/theme/lib/patch.js,
// and src/utils.js MUST be identical to web-template/docs/.vitepress/utils.js.
// Divergence silently corrupts concurrent saves (patch.js) or breaks shared
// logic (utils.js). This suite catches any future drift by comparing the full
// file content (minus the header comment block) when the sibling file exists.
//
// The editor repo already has its own parity test (editor/tests/parity.test.js)
// checking config-api's patch.js; this is the config-api-side mirror that also
// covers utils.js.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Paths relative to the config-api repo root.
const CONFIG_API_ROOT = resolve(process.cwd());
const EDITOR_PATCH = resolve(CONFIG_API_ROOT, '../editor/docs/.vitepress/theme/lib/patch.js');
const WEBTEMPLATE_UTILS = resolve(CONFIG_API_ROOT, '../web-template/docs/.vitepress/utils.js');

const LOCAL_PATCH = resolve(CONFIG_API_ROOT, 'src/patch.js');
const LOCAL_UTILS = resolve(CONFIG_API_ROOT, 'src/utils.js');

function stripHeaderComment(code) {
  // Both files have a header comment block describing the inter-repo mirroring
  // contract. The comment text may differ slightly (e.g. the isKeyedArray
  // explanation changed between versions), so we compare only the executable
  // code: everything from the first `export` onward. Comments after that point
  // are kept (they're part of the logic).
  const lines = code.split('\n');
  const firstExport = lines.findIndex((l) => l.startsWith('export'));
  if (firstExport === -1) return code;
  return lines.slice(firstExport).join('\n');
}

function lineDiff(a, b) {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const max = Math.max(aLines.length, bLines.length);
  const diffs = [];
  for (let i = 0; i < max; i++) {
    if (aLines[i] !== bLines[i]) {
      diffs.push({
        line: i + 1,
        editor: aLines[i] ?? '<missing>',
        configApi: bLines[i] ?? '<missing>',
      });
    }
  }
  return diffs;
}

describe('patch.js byte-for-byte parity with editor', () => {
  const siblingExists = existsSync(EDITOR_PATCH);
  const maybe = siblingExists ? describe : describe.skip;

  maybe('when editor patch.js is available', () => {
    if (!siblingExists) return;
    const localCode = stripHeaderComment(readFileSync(LOCAL_PATCH, 'utf-8'));
    const siblingCode = stripHeaderComment(readFileSync(EDITOR_PATCH, 'utf-8'));

    it('config-api patch.js is byte-for-byte identical to editor (minus header)', () => {
      if (localCode !== siblingCode) {
        const diffs = lineDiff(localCode, siblingCode);
        const preview = diffs
          .slice(0, 15)
          .map((d) => `  L${d.line}: local="${d.editor.trim()}" | sibling="${d.configApi.trim()}"`)
          .join('\n');
        const shown = diffs.length > 15 ? `\n  ...and ${diffs.length - 15} more` : '';
        throw new Error(
          `patch.js diverges between config-api and editor (${diffs.length} differing lines):\n${preview}${shown}\n\n` +
            `Full files: ${LOCAL_PATCH} vs ${EDITOR_PATCH}`,
        );
      }
      expect(localCode).toBe(siblingCode);
    });

    it('both files export the same function/const names', () => {
      const localExports = localCode.match(/(?:export\s+(?:function|const|async\s+function)\s+\w+)/g) || [];
      const siblingExports = siblingCode.match(/(?:export\s+(?:function|const|async\s+function)\s+\w+)/g) || [];
      expect(localExports.sort()).toEqual(siblingExports.sort());
    });
  });
});

describe('utils.js byte-for-byte parity with web-template', () => {
  const siblingExists = existsSync(WEBTEMPLATE_UTILS);
  const maybe = siblingExists ? describe : describe.skip;

  maybe('when web-template utils.js is available', () => {
    if (!siblingExists) return;
    const localCode = stripHeaderComment(readFileSync(LOCAL_UTILS, 'utf-8'));
    const siblingCode = stripHeaderComment(readFileSync(WEBTEMPLATE_UTILS, 'utf-8'));

    it('config-api utils.js is byte-for-byte identical to web-template (minus header)', () => {
      if (localCode !== siblingCode) {
        const diffs = lineDiff(localCode, siblingCode);
        const preview = diffs
          .slice(0, 15)
          .map((d) => `  L${d.line}: local="${d.editor.trim()}" | sibling="${d.configApi.trim()}"`)
          .join('\n');
        const shown = diffs.length > 15 ? `\n  ...and ${diffs.length - 15} more` : '';
        throw new Error(
          `utils.js diverges between config-api and web-template (${diffs.length} differing lines):\n${preview}${shown}\n\n` +
            `Full files: ${LOCAL_UTILS} vs ${WEBTEMPLATE_UTILS}`,
        );
      }
      expect(localCode).toBe(siblingCode);
    });

    it('both files export the same function/const names', () => {
      const localExports = localCode.match(/(?:export\s+(?:function|const|async\s+function)\s+\w+)/g) || [];
      const siblingExports = siblingCode.match(/(?:export\s+(?:function|const|async\s+function)\s+\w+)/g) || [];
      expect(localExports.sort()).toEqual(siblingExports.sort());
    });
  });
});
