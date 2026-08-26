// Unit tests for opus-youtube-subscriptions (idea: test-youtube)
import { describe, it, expect } from 'vitest';
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
