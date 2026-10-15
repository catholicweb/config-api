// MCP tools for the non-config parts of the API: files, editors, site creation.
// Every tool forwards to the existing HTTP handler with the caller's own bearer
// token, so authorization and validation stay exactly as for the editor. Not
// exposed on purpose: admin-only endpoints (clone / delete site / backfill-cache),
// the /auth/* login plumbing (replaced by OAuth), and the browser-only FCM endpoint.
import { validateFilename, validateSlug, validateSlugNotReserved, MAX_FILE_BYTE } from './index.js';

const MAX_INLINE_BYTES = 5 * 1024 * 1024; // content / content_base64 sent in a tool call
const MAX_TEXT_READ = 100_000; // chars returned by read_file
const MAX_IMAGE_READ = 800_000; // bytes returned inline as an image
const MIME = {
  md: 'text/markdown; charset=utf-8', json: 'application/json', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
};
const SERVER_FILES = new Set(['config.json', 'slugs.json']); // config.json: use patch_config (schema-validated)

const SLUG = { type: 'string', description: 'Site slug (see list_sites).' };
const FILE = { type: 'string', description: 'File name, e.g. "media-abc123.jpg": letters, digits, _ and -, plus one optional extension (md, jpg, jpeg, png, gif, webp, pdf, json).' };
const EMAIL = { type: 'string', description: 'Email address.' };

export const EXTRA_TOOLS = [
  {
    name: 'list_files',
    description: 'List the files stored for a site (images, documents, ...) with their public URLs.',
    inputSchema: { type: 'object', properties: { slug: SLUG, filter: { type: 'string', description: 'Only names containing this text.' } }, required: ['slug'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_file',
    description: 'Read a site file: text files (md, json) as text, small images as an image, anything else as its URL. For config.json use get_config.',
    inputSchema: { type: 'object', properties: { slug: SLUG, name: FILE }, required: ['slug', 'name'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'write_file',
    description: 'Upload a NEW file to a site. Give exactly one of: content (text), content_base64, or source_url (https URL the server downloads). Files are cached for a year, so an existing name is refused unless overwrite=true: pick a fresh unique name instead. Cannot write config.json (use patch_config). To use an uploaded image, set its URL (returned here) in the config with patch_config.',
    inputSchema: { type: 'object', properties: {
      slug: SLUG, name: FILE,
      content: { type: 'string', description: 'Text content (md/json files).' },
      content_base64: { type: 'string', description: 'Base64-encoded bytes (up to ~5 MB).' },
      source_url: { type: 'string', description: 'https URL to download (up to 20 MB).' },
      overwrite: { type: 'boolean', description: 'Replace an existing file (clients may keep serving the old one for a long time).' },
    }, required: ['slug', 'name'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'delete_file',
    description: 'Permanently delete a site file. Check the config does not still reference it. Cannot delete config.json.',
    inputSchema: { type: 'object', properties: { slug: SLUG, name: FILE }, required: ['slug', 'name'] },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'list_editors',
    description: 'List the emails that can edit a site.',
    inputSchema: { type: 'object', properties: { slug: SLUG }, required: ['slug'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add_editor',
    description: 'Give an email edit access to a site and email them a login link.',
    inputSchema: { type: 'object', properties: { slug: SLUG, email: EMAIL }, required: ['slug', 'email'] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'change_editor_email',
    description: "Change an editor's email address for a site; their existing sessions keep working.",
    inputSchema: { type: 'object', properties: { slug: SLUG, from: EMAIL, to: EMAIL }, required: ['slug', 'from', 'to'] },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'remove_editor',
    description: "Remove an editor from a site and revoke their sessions for it. You cannot remove yourself (do that in the editor).",
    inputSchema: { type: 'object', properties: { slug: SLUG, email: EMAIL }, required: ['slug', 'email'] },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'create_site',
    description: 'Create a new parish site: provisions hosting, copies the template config, grants `email` edit access and emails them a login link. Slug: lowercase letters, digits and hyphens (max 63, not api/editor/www/data). Note: only `email` gets access, so you cannot edit the new site unless it is your own email.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, email: EMAIL }, required: ['slug', 'email'] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
];

// ---- helpers ---------------------------------------------------------------
const text = (t, isError = false) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }], ...(isError ? { isError: true } : {}) });
const fail = (msg) => text(msg, true);
const extOf = (n) => (n.includes('.') ? n.split('.').pop().toLowerCase() : '');

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function api(ctx, method, path, { json, body, contentType } = {}) {
  const headers = { Authorization: `Bearer ${ctx.token}` };
  const init = { method, headers };
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(json); }
  else if (body !== undefined) { headers['Content-Type'] = contentType || 'application/octet-stream'; init.body = body; }
  const res = await ctx.forward(new Request(`${ctx.origin}${path}`, init));
  const raw = await res.text();
  let data; try { data = JSON.parse(raw); } catch { data = { error: raw }; }
  return { res, data };
}
const apiError = (res, data) => fail(`Request failed (${res.status}): ${data?.error || data?.message || 'unknown error'}`);

function ownSlug(args, ctx) {
  const slug = args?.slug;
  if (typeof slug !== 'string' || !ctx.identity.slugs.includes(slug)) {
    return `You cannot edit "${slug}". Your sites: ${ctx.identity.slugs.join(', ') || '(none)'}`;
  }
  return null;
}
function checkName(name, { forWrite = false } = {}) {
  if (!validateFilename(name)) return `Invalid file name "${name}". Use letters, digits, _ and -, plus one optional extension (${Object.keys(MIME).join(', ')}).`;
  if (forWrite && SERVER_FILES.has(name)) return `"${name}" is managed by the server${name === 'config.json' ? ': edit it with patch_config (schema-validated)' : ''}.`;
  return null;
}

// ---- dispatcher ------------------------------------------------------------
export async function callExtraTool(name, args, ctx) {
  const { env } = ctx;
  try {
    if (name === 'create_site') {
      if (!validateSlug(args?.slug)) return fail('Invalid slug: lowercase letters, digits and hyphens, 1-63 chars, not starting/ending with a hyphen.');
      if (!validateSlugNotReserved(args.slug)) return fail(`"${args.slug}" is a reserved slug.`);
      const { res, data } = await api(ctx, 'POST', `/sites/${args.slug}`, { json: { email: args.email } });
      if (!res.ok) return apiError(res, data);
      return text({ ...data, note: `Site created. ${data.email || args.email} was emailed a login link.` });
    }

    const bad = ownSlug(args, ctx);
    if (bad) return fail(bad);
    const slug = args.slug;

    switch (name) {
      case 'list_files': {
        const { res, data } = await api(ctx, 'GET', `/sites/${slug}`);
        if (!res.ok) return apiError(res, data);
        let files = (data.files || []).map((url) => ({ name: url.split('/').pop(), url }));
        if (args.filter) files = files.filter((f) => f.name.includes(args.filter));
        const total = files.length;
        return text({ slug, total, files: files.slice(0, 300), ...(total > 300 ? { note: 'Truncated to 300; use filter.' } : {}) });
      }

      case 'read_file': {
        const e = checkName(args.name);
        if (e) return fail(e);
        const obj = await env.CONTENT.get(`${slug}/${args.name}`);
        if (!obj) return fail(`No file "${args.name}" in "${slug}".`);
        const ext = extOf(args.name);
        const url = `${(env.DATA_BASE || 'https://data.parroquia.app').replace(/\/$/, '')}/${slug}/${args.name}`;
        if (ext === 'md' || ext === 'json') {
          const t = await obj.text();
          if (t.length > MAX_TEXT_READ) return text({ url, size: t.length, note: 'Too large to return in full.', preview: t.slice(0, 2000) });
          return text(t);
        }
        if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext) && obj.size <= MAX_IMAGE_READ) {
          const bytes = new Uint8Array(await obj.arrayBuffer());
          return { content: [{ type: 'text', text: url }, { type: 'image', data: toBase64(bytes), mimeType: MIME[ext] }] };
        }
        return text({ url, size: obj.size, note: 'Not returned inline (type or size); open the URL.' });
      }

      case 'write_file': {
        const e = checkName(args.name, { forWrite: true });
        if (e) return fail(e);
        const sources = ['content', 'content_base64', 'source_url'].filter((k) => args[k] !== undefined);
        if (sources.length !== 1) return fail('Provide exactly one of content, content_base64 or source_url.');
        const existing = await env.CONTENT.head(`${slug}/${args.name}`);
        if (existing && !args.overwrite) return fail(`"${args.name}" already exists. Files are cached for a year: choose a new unique name (or pass overwrite=true).`);

        let bytes;
        if (args.content !== undefined) {
          bytes = new TextEncoder().encode(String(args.content));
        } else if (args.content_base64 !== undefined) {
          try { bytes = fromBase64(String(args.content_base64)); } catch { return fail('content_base64 is not valid base64.'); }
        } else {
          let u;
          try { u = new URL(args.source_url); } catch { return fail('source_url is not a valid URL.'); }
          if (u.protocol !== 'https:') return fail('source_url must be https.');
          const r = await fetch(u.toString(), { redirect: 'follow' });
          if (!r.ok) return fail(`Could not download source_url (HTTP ${r.status}).`);
          if (Number(r.headers.get('Content-Length')) > MAX_FILE_BYTE) return fail('source_url file is too large (max 20 MB).');
          bytes = new Uint8Array(await r.arrayBuffer());
          if (bytes.length > MAX_FILE_BYTE) return fail('source_url file is too large (max 20 MB).');
        }
        if (args.source_url === undefined && bytes.length > MAX_INLINE_BYTES) return fail('Inline content too large (max ~5 MB); use source_url.');
        if (bytes.length === 0) return fail('File is empty.');
        const ext = extOf(args.name);
        if (ext === 'json') {
          try { JSON.parse(new TextDecoder().decode(bytes)); } catch { return fail('Invalid JSON.'); }
        }
        const { res, data } = await api(ctx, 'PUT', `/sites/${slug}/${args.name}`, { body: bytes, contentType: MIME[ext] });
        if (!res.ok || !data.ok) return apiError(res, data);
        return text({ saved: true, name: args.name, url: data.url, bytes: bytes.length, note: 'To use it on the site, reference this URL from the config with patch_config.' });
      }

      case 'delete_file': {
        const e = checkName(args.name, { forWrite: true });
        if (e) return fail(e);
        const { res, data } = await api(ctx, 'DELETE', `/sites/${slug}/${args.name}`);
        if (!res.ok || !data.ok) return apiError(res, data);
        return text({ deleted: true, name: args.name });
      }

      case 'list_editors': {
        const { res, data } = await api(ctx, 'GET', `/sites/${slug}/editors`);
        return res.ok ? text(data) : apiError(res, data);
      }
      case 'add_editor': {
        const { res, data } = await api(ctx, 'POST', `/sites/${slug}/editors`, { json: { email: args.email } });
        return res.ok ? text(data) : apiError(res, data);
      }
      case 'change_editor_email': {
        const { res, data } = await api(ctx, 'PATCH', `/sites/${slug}/editors`, { json: { from: args.from, to: args.to } });
        return res.ok ? text(data) : apiError(res, data);
      }
      case 'remove_editor': {
        if (String(args.email).trim().toLowerCase() === ctx.identity.email) {
          return fail('Refusing to remove your own access from an AI session (it would end this connection). Do it in the editor if you really want to.');
        }
        const { res, data } = await api(ctx, 'DELETE', `/sites/${slug}/editors`, { json: { email: args.email } });
        return res.ok ? text(data) : apiError(res, data);
      }
      default:
        return fail(`Unknown tool "${name}"`);
    }
  } catch (e) {
    return fail(`Error: ${e.message}`);
  }
}
