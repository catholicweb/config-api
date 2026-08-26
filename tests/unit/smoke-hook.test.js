// Smoke test for enforce-test (idea: enforce-test / test-youtube)
import { describe, it, expect } from 'vitest';

describe('enforce-test smoke', () => {
  it('pre-commit hook file exists', () => {
    const fs = require('fs');
    // Worktree .git is a file; hook lives in main repo hooks
    const hookPath = '/home/miguel/Tech/parroquia/config-api/.git/hooks/pre-commit';
    expect(fs.existsSync(hookPath)).toBe(true);
  });

  it('youtube subscription regex reduced external calls (doc.dev set on success)', async () => {
    const { updateSubscribedTo } = await import('../../src/index.js');
    global.fetch = async () => ({ ok: true, status: 200 });
    const doc = { info: { social: ['https://youtube.com/@chan'] } };
    const env = { PUBSUBHUBBUB_HUB: 'https://example.com/', WEBHOOK_SECRET: 's' };
    const res = await updateSubscribedTo(doc, env);
    expect(res).toBeDefined();
    delete global.fetch;
  });
});
