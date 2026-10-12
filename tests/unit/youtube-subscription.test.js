// Unit tests for opus-youtube-subscriptions (idea: test-youtube)
import { describe, it, expect, vi } from 'vitest';
import { extractYouTubeChannels, updateSubscribedTo, webhookYouTube, resolveYouTubeChannelId } from '../../src/index.js';

describe('extractYouTubeChannels', () => {
  it('extracts @handle urls', () => {
    const doc = { info: { social: ['https://www.youtube.com/@47herri'] } };
    expect(extractYouTubeChannels(doc)).toEqual(['47herri']);
  });

  it('extracts channel/ and youtu.be urls', () => {
    const doc = { info: { social: ['https://youtube.com/channel/UC123', 'https://youtu.be/ABC'] } };
    expect(extractYouTubeChannels(doc)).toContain('UC123');
  });

  it('extracts from object url fields', () => {
    const doc = { info: { social: [{ url: 'https://youtube.com/channel/UCtest' }] } };
    expect(extractYouTubeChannels(doc)).toEqual(['UCtest']);
  });

  it('extracts from object-valued social (channel/youtu.be/c)', () => {
    const doc = { info: { social: { yt: 'https://youtube.com/channel/UCfoo' } } };
    expect(extractYouTubeChannels(doc)).toEqual(['UCfoo']);
  });
});

describe('resolveYouTubeChannelId', () => {
  it('passes through UC... ids', async () => {
    expect(await resolveYouTubeChannelId('UC123', {})).toBe('UC123');
  });

  it('resolves @handle via mocked API', async () => {
    global.fetch = async () => ({ ok: true, json: async () => ({ items: [{ id: 'UC47herri' }] }) });
    const result = await resolveYouTubeChannelId('47herri', { YOUTUBE_API_KEY: 'key' });
    expect(result).toBe('UC47herri');
    delete global.fetch;
  });
});

describe('updateSubscribedTo', () => {
  it('adds subscribedto to doc.dev', async () => {
    global.fetch = async () => ({ ok: true, status: 200 });
    const doc = { info: { social: ['https://youtube.com/@47herri'] } };
    const env = { PUBSUBHUBBUB_HUB: 'https://example.com/', WEBHOOK_SECRET: 'sec' };
    const result = await updateSubscribedTo(doc, env);
    expect(result.dev.subscribedto).toBeDefined();
    delete global.fetch;
  });
});

describe('webhookYouTube deep test (youtube-subscriptions-deeptest)', () => {
  const envSec = { WEBHOOK_SECRET: 'deeptest-secret' };
  const ctx = { waitUntil: () => {} };

  it('GET with hub.challenge returns challenge (PubSubHubbub verification)', async () => {
    const url = new URL('https://example.com/webhook/youtube?token=deeptest-secret&hub.challenge=abc123');
    const req = new Request(url.toString(), { method: 'GET' });
    const res = await webhookYouTube(ctx, envSec, req, url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('abc123');
  });

  it('GET without challenge returns 200 note', async () => {
    const url = new URL('https://example.com/webhook/youtube?token=deeptest-secret');
    const req = new Request(url.toString(), { method: 'GET' });
    const res = await webhookYouTube(ctx, envSec, req, url);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.note).toContain('GET verified');
  });

  it('GET with bad token is 403', async () => {
    const url = new URL('https://example.com/webhook/youtube?token=bad');
    const req = new Request(url.toString(), { method: 'GET' });
    const res = await webhookYouTube(ctx, envSec, req, url);
    expect(res.status).toBe(403);
  });

  it('POST without token is 403', async () => {
    const url = new URL('https://example.com/webhook/youtube');
    const req = new Request(url.toString(), { method: 'POST', body: '{}' });
    const res = await webhookYouTube(ctx, envSec, req, url);
    expect(res.status).toBe(403);
  });

  it('POST with slug in payload resolves slug', async () => {
    const url = new URL('https://example.com/webhook/youtube?token=deeptest-secret');
    const req = new Request(url.toString(), { method: 'POST', body: '{"slug":"testsite"}' });
    const res = await webhookYouTube(ctx, envSec, req, url);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.slug).toBe('testsite');
    expect(body.trigger).toBe('youtube-subscription');
  });

  it('POST with URL slug match resolves slug', async () => {
    const url = new URL('https://example.com/webhook/youtube?token=deeptest-secret');
    const req = new Request(url.toString(), { method: 'POST', body: 'https://api.parroquia.app/sites/my-site' });
    const res = await webhookYouTube(ctx, envSec, req, url);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slug).toBe('my-site');
  });

  it('POST with invalid slug returns 400', async () => {
    const url = new URL('https://example.com/webhook/youtube?token=deeptest-secret');
    const req = new Request(url.toString(), { method: 'POST', body: '{"slug":"bad/slug"}' });
    const res = await webhookYouTube(ctx, envSec, req, url);
    expect(res.status).toBe(400);
  });

  it('POST with unresolvable slug returns ok with note', async () => {
    const url = new URL('https://example.com/webhook/youtube?token=deeptest-secret');
    const req = new Request(url.toString(), { method: 'POST', body: '{}' });
    const res = await webhookYouTube(ctx, envSec, req, url);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.note).toContain('slug not resolved');
  });
});

describe('webhookYouTube', () => {
  it('returns 403 for bad token', async () => {
    const req = new Request('https://example.com/webhook/youtube?token=bad', { method: 'POST', body: '{}' });
    const res = await webhookYouTube({ waitUntil: () => {} }, { WEBHOOK_SECRET: 'good' }, req, new URL(req.url));
    expect(res.status).toBe(403);
  });

  it('accepts valid token and resolves slug', async () => {
    const url = new URL('https://example.com/webhook/youtube?token=good');
    const req = new Request(url.toString(), { method: 'POST', body: '{"slug":"47herri"}' });
    const res = await webhookYouTube({ waitUntil: () => {} }, { WEBHOOK_SECRET: 'good' }, req, url);
    expect(res.status).toBe(200);
  });
});

describe('extractYouTubeChannels — @handle in every social shape', () => {
  it('extracts @handle from object url fields', () => {
    const doc = { info: { social: [{ url: 'https://www.youtube.com/@47herri' }] } };
    expect(extractYouTubeChannels(doc)).toEqual(['47herri']);
  });

  it('extracts @handle from object-valued social', () => {
    const doc = { info: { social: { yt: 'https://youtube.com/@47herri' } } };
    expect(extractYouTubeChannels(doc)).toEqual(['47herri']);
  });

  it('extracts url from nested object values', () => {
    const doc = { info: { social: { yt: { url: 'https://youtube.com/channel/UCnested' } } } };
    expect(extractYouTubeChannels(doc)).toEqual(['UCnested']);
  });
});

describe('updateSubscribedTo — callback, force and report', () => {
  const env = { PUBSUBHUBBUB_HUB: 'https://hub.example/', WEBHOOK_SECRET: 'sec' };
  const doc = () => ({ info: { social: ['https://youtube.com/channel/UCabc'] } });

  it('puts the slug in the callback URL', async () => {
    const calls = [];
    global.fetch = async (_u, init) => { calls.push(init.body); return { status: 202, text: async () => '' }; };
    await updateSubscribedTo(doc(), env, { slug: 'my-site' });
    delete global.fetch;
    const cb = new URLSearchParams(calls[0]).get('hub.callback');
    expect(cb).toBe('https://api.parroquia.app/webhook/youtube?token=sec&slug=my-site');
  });

  it('omits slug for invalid slugs', async () => {
    const calls = [];
    global.fetch = async (_u, init) => { calls.push(init.body); return { status: 202, text: async () => '' }; };
    await updateSubscribedTo(doc(), env, { slug: 'bad/slug' });
    delete global.fetch;
    expect(new URLSearchParams(calls[0]).get('hub.callback')).not.toContain('slug=');
  });

  it('force resubscribes channels already in subscribedto', async () => {
    const fetchMock = vi.fn(async () => ({ status: 202, text: async () => '' }));
    global.fetch = fetchMock;
    const d = doc();
    d.dev = { subscribedto: ['UCabc'] };
    await updateSubscribedTo(d, env);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    await updateSubscribedTo(d, env, { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    delete global.fetch;
  });

  it('reports accepted and failed counts', async () => {
    global.fetch = async () => ({ status: 500, text: async () => 'boom' });
    const report = {};
    const d = await updateSubscribedTo(doc(), env, { report });
    delete global.fetch;
    expect(report).toEqual({ channels: 1, accepted: 0, failed: 1 });
    expect(d.dev.subscribedto).toEqual([]);
  });
});

describe('webhookYouTube — slug from callback query', () => {
  it('resolves slug from ?slug= on an Atom payload', async () => {
    const url = new URL('https://example.com/webhook/youtube?token=s&slug=my-site');
    const req = new Request(url.toString(), { method: 'POST', body: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>' });
    const res = await webhookYouTube({ waitUntil: () => {} }, { WEBHOOK_SECRET: 's' }, req, url);
    expect(res.status).toBe(200);
    expect((await res.json()).slug).toBe('my-site');
  });

  it('rejects an invalid ?slug=', async () => {
    const url = new URL('https://example.com/webhook/youtube?token=s&slug=Bad_Slug');
    const req = new Request(url.toString(), { method: 'POST', body: '<feed/>' });
    const res = await webhookYouTube({ waitUntil: () => {} }, { WEBHOOK_SECRET: 's' }, req, url);
    expect(res.status).toBe(400);
  });
});
