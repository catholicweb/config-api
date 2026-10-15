// MCP server (Streamable HTTP, stateless JSON responses) exposing the config
// editing API to AI clients. Thin layer: auth reuses the editor-token store, and
// writes are forwarded to the existing PATCH /sites/:slug/config.json handler
// (so auto-build, YouTube sync, etc. behave exactly as for the editor).
import { applyPatch } from './patch.js';
import { readAuthState, sha256Hex, bearerToken } from './index.js';
import { validate, newErrors, resolveNode, fillIds, drill, outline, isObj } from './mcp-schema.js';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_SCHEMA_URL = 'https://editor.parroquia.app/config.schema.json';
const SCHEMA_TTL_MS = 5 * 60 * 1000;
let schemaMemo = { url: null, at: 0, schema: null };

export const INSTRUCTIONS = `Edit parish website config.json files.
Workflow: list_sites -> get_schema (overview, then drill into a section) -> get_config (use \`path\`) -> validate_config -> patch_config.
Rules: rich-text fields are Markdown, not HTML. Lists of objects are keyed by "id" (the server fills missing ids on new items). Image upload is not supported; reuse existing image URLs. Edits go live immediately, so validate first and keep changes minimal.`;

const OPS_HELP = `ops is an array of: {"op":"set","path":[...],"value":...} | {"op":"remove","path":[...]} | {"op":"listAdd","path":[...list path],"value":{...},"index"?:n} | {"op":"listReorder","path":[...list path],"ids":[...]}. A path is an array of field names; address a list item with {"id":"<item id>"}, e.g. ["pages","list",{"id":"abc"},"title"]. The first path segment must be a config section (see get_schema).`;

const TOOLS = [
  {
    name: 'list_sites',
    description: 'List the site slugs the logged-in user can edit.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_schema',
    description: 'Describe the config.json structure (generated from the editor schema). Without arguments returns an overview of the sections. Use `section` (e.g. "pages") and optionally a dotted `path` (e.g. "list.sections.gallery") to drill down; large nodes are outlined unless full=true.',
    inputSchema: { type: 'object', properties: { section: { type: 'string' }, path: { type: 'string' }, full: { type: 'boolean' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_config',
    description: 'Read a site\'s config.json, or one part of it with a dotted `path` (list items can be addressed by their id, e.g. "pages.list.<id>.sections").',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, path: { type: 'string' } }, required: ['slug'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'validate_config',
    description: `Dry run: apply ops to the current config in memory and validate against the schema. Nothing is saved. ${OPS_HELP}`,
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, ops: { type: 'array', items: { type: 'object' } } }, required: ['slug', 'ops'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'patch_config',
    description: `Validate and save changes to a site's config.json. Changes go LIVE immediately (a site rebuild is triggered). Rejected if the ops introduce schema errors. ${OPS_HELP}`,
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, ops: { type: 'array', items: { type: 'object' } } }, required: ['slug', 'ops'] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
];

// ---- helpers ---------------------------------------------------------------
const text = (t, isError = false) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }], ...(isError ? { isError: true } : {}) });
const fail = (msg) => text(msg, true);
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'WWW-Authenticate',
};
export const corsPreflight = () => new Response(null, { status: 204, headers: CORS });

export async function getSchema(env, { force = false } = {}) {
  const url = env.SCHEMA_URL || DEFAULT_SCHEMA_URL;
  if (!force && schemaMemo.url === url && Date.now() - schemaMemo.at < SCHEMA_TTL_MS) return schemaMemo.schema;
  try {
    const res = await fetch(url, { cf: { cacheTtl: 300 } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    schemaMemo = { url, at: Date.now(), schema: await res.json() };
  } catch (e) {
    if (schemaMemo.url === url && schemaMemo.schema) return schemaMemo.schema; // serve stale
    throw new Error(`schema unavailable (${e.message})`);
  }
  return schemaMemo.schema;
}
export const resetSchemaCache = () => { schemaMemo = { url: null, at: 0, schema: null }; };

function getAt(doc, path) {
  let node = doc;
  for (const s of String(path || '').split('.').filter(Boolean)) {
    if (Array.isArray(node)) node = node.find((x) => isObj(x) && x.id === s) ?? node[Number(s)];
    else if (isObj(node)) node = node[s];
    else return undefined;
  }
  return node;
}
function summarize(v) {
  if (Array.isArray(v)) return { list: v.length, items: v.slice(0, 30).map((x) => (isObj(x) ? { id: x.id, label: x.title || x.name || x.type || x.label } : x)) };
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Array.isArray(x) ? `list(${x.length})` : isObj(x) ? 'object' : typeof x]));
  return v;
}
const fmtErrors = (errs) => errs.map((e) => `- ${e.path}: ${e.message}`).join('\n');

async function loadDoc(env, slug) {
  const obj = await env.CONTENT.get(`${slug}/config.json`);
  if (!obj) return null;
  try { return JSON.parse(await obj.text()); } catch { return null; }
}

/** Shared by validate_config and patch_config. Returns { error } or { ops, after, ... }. */
async function prepare(env, slug, rawOps) {
  const schema = await getSchema(env);
  const doc = await loadDoc(env, slug);
  if (!doc) return { error: `No config.json found for "${slug}".` };
  if (!Array.isArray(rawOps) || rawOps.length === 0) return { error: 'ops must be a non-empty array.' };
  if (rawOps.length > 200) return { error: 'too many ops (max 200 per call).' };
  const ops = structuredClone(rawOps);
  const working = structuredClone(doc);
  const problems = [];
  const assigned = [];

  ops.forEach((op, i) => {
    const where = `op ${i}`;
    if (!isObj(op) || !['set', 'remove', 'listAdd', 'listReorder'].includes(op.op)) return problems.push(`${where}: unknown op`);
    if (!Array.isArray(op.path) || op.path.length === 0) return problems.push(`${where}: path must be a non-empty array`);
    if (typeof op.path[0] !== 'string' || !(op.path[0] in (schema.properties || {}))) {
      return problems.push(`${where}: "${JSON.stringify(op.path[0])}" is not an editable section. Sections: ${Object.keys(schema.properties || {}).join(', ')}`);
    }
    const r = resolveNode(schema, working, op.path);
    if (r.error) return problems.push(`${where}: ${r.error}`);
    if (op.op === 'listAdd') {
      if (!isObj(op.value)) return problems.push(`${where}: listAdd value must be an object`);
      if (!op.id && !op.value.id) op.value.id = crypto.randomUUID();
      op.id = op.id || op.value.id;
      op.value.id = op.value.id || op.id;
      assigned.push({ op: i, id: op.id });
      fillIds([op.value], { items: r.node?.items }, undefined); // nested lists/blocks
    } else if (op.op === 'set') {
      const last = op.path[op.path.length - 1];
      if (isObj(last) && isObj(op.value) && !op.value.id) op.value.id = last.id;
      fillIds(op.value, r.node);
      if (Array.isArray(op.value)) fillIds(op.value, r.node);
    }
    const applied = applyPatch(working, [op]);
    if (applied.skipped) problems.push(`${where}: had no effect (path not found, e.g. unknown item id or missing parent)`);
  });
  if (problems.length) return { error: `Could not apply ops:\n${problems.map((p) => `- ${p}`).join('\n')}` };

  const introduced = newErrors(validate(schema, doc), validate(schema, working));
  return { ops, working, introduced, assigned, version: schema['x-schema-version'] };
}

// ---- tools -----------------------------------------------------------------
async function callTool(name, args, ctx) {
  const { env, identity } = ctx;
  const needSlug = () => {
    const slug = args?.slug;
    if (typeof slug !== 'string' || !identity.slugs.includes(slug)) {
      return `You cannot edit "${slug}". Your sites: ${identity.slugs.join(', ') || '(none)'}`;
    }
    return null;
  };
  try {
    switch (name) {
      case 'list_sites':
        return text({ email: identity.email, sites: identity.slugs.map((s) => ({ slug: s, url: `https://${s}.parroquia.app` })) });

      case 'get_schema': {
        const schema = await getSchema(env);
        const section = args?.section;
        if (!section) {
          return text({
            schema_version: schema['x-schema-version'],
            sections: Object.entries(schema.properties).map(([k, v]) => ({ name: k, title: v.title, fields: Object.keys(v.properties || {}) })),
            hint: 'Call get_schema with section (and path) for details.',
          });
        }
        if (!(section in schema.properties)) return fail(`Unknown section "${section}". Sections: ${Object.keys(schema.properties).join(', ')}`);
        const d = drill(schema.properties[section], args.path);
        if (d.error) return fail(d.error);
        const s = JSON.stringify(d.node);
        if (!args.full && s.length > 16000) return text({ schema_version: schema['x-schema-version'], outline: outline(d.node) });
        return text({ schema_version: schema['x-schema-version'], schema: d.node });
      }

      case 'get_config': {
        const bad = needSlug();
        if (bad) return fail(bad);
        const doc = await loadDoc(env, args.slug);
        if (!doc) return fail(`No config.json found for "${args.slug}".`);
        const v = args.path ? getAt(doc, args.path) : doc;
        if (v === undefined) return fail(`Nothing at path "${args.path}".`);
        const s = JSON.stringify(v, null, 2);
        if (s.length > 100000) return text({ note: 'Too large to return in full; narrow the path.', summary: summarize(v) });
        return text(s);
      }

      case 'validate_config':
      case 'patch_config': {
        const bad = needSlug();
        if (bad) return fail(bad);
        const p = await prepare(env, args.slug, args.ops);
        if (p.error) return fail(p.error);
        if (p.introduced.length) return fail(`Rejected: these changes would introduce schema errors (nothing was saved):\n${fmtErrors(p.introduced)}`);
        if (name === 'validate_config') return text({ valid: true, ops: p.ops.length, assigned_ids: p.assigned, note: 'Nothing saved. Call patch_config with the same ops to apply.' });
        const res = await ctx.forward(new Request(`${ctx.origin}/sites/${encodeURIComponent(args.slug)}/config.json`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ops: p.ops }),
        }));
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) return fail(`Save failed (${res.status}): ${body.error || 'unknown error'}`);
        return text({ saved: true, skipped: body.skipped, assigned_ids: p.assigned, note: 'Live; a site rebuild was triggered.' });
      }
      default:
        return fail(`Unknown tool "${name}"`);
    }
  } catch (e) {
    return fail(`Error: ${e.message}`);
  }
}

// ---- JSON-RPC / HTTP -------------------------------------------------------
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handleMessage(msg, ctx) {
  const { id, method, params } = msg || {};
  if (id === undefined) return null; // notification
  switch (method) {
    case 'initialize': {
      const want = params?.protocolVersion;
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'parroquia-config', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      } };
    }
    case 'ping': return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list': return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
      if (!TOOLS.some((t) => t.name === params?.name)) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
      return { jsonrpc: '2.0', id, result: await callTool(params.name, params.arguments || {}, ctx) };
    }
    default: return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function handleMcp(request, env, execCtx, forward) {
  const origin = new URL(request.url).origin;
  const unauthorized = (why) => new Response(JSON.stringify({ error: why }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', ...CORS, 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` },
  });
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST', ...CORS } });

  const token = bearerToken(request);
  if (!token) return unauthorized('missing bearer token');
  const state = await readAuthState(env);
  if (!state) return Response.json({ error: 'auth state unavailable' }, { status: 503, headers: CORS });
  const entry = state.tokens[await sha256Hex(token)];
  if (!entry || entry.email == null) return unauthorized('invalid token');
  const identity = { email: entry.email, slugs: (state.emails[entry.email] || []).filter(Boolean) };

  let body;
  try { body = JSON.parse(await request.text()); } catch {
    return Response.json(rpcError(null, -32700, 'Parse error'), { status: 400, headers: CORS });
  }
  const ctx = { env, identity, token, origin, forward };
  const batch = Array.isArray(body);
  const replies = (await Promise.all((batch ? body : [body]).map((m) => handleMessage(m, ctx)))).filter(Boolean);
  if (replies.length === 0) return new Response(null, { status: 202, headers: CORS });
  return Response.json(batch ? replies : replies[0], { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}
