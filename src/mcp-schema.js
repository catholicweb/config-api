// JSON Schema helpers for the MCP layer. Dependency-free on purpose (Workers
// cannot compile schemas at runtime, and this implements exactly the keyword
// subset that editor/lib/jsonschema.js emits): type, enum, const, pattern,
// minLength, minimum, maximum, properties, required, additionalProperties:false,
// items, allOf, if/then, oneOf. Unknown keywords are ignored (annotations).

const MAX_ERRORS = 50;
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // string | number | boolean | object
}
function typeMatches(t, v) {
  const actual = typeOf(v);
  return t === actual || (t === 'integer' && actual === 'number' && Number.isInteger(v));
}
const short = (list) => {
  const shown = list.slice(0, 12).map((x) => JSON.stringify(x)).join(', ');
  return list.length > 12 ? `${shown}, … (${list.length} options)` : shown;
};
const seg = (path, key) => (typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : String(key));

/** Validate `value` against `schema`. Returns [{ path, message }]. */
export function validate(schema, value) {
  const errors = [];
  walk(schema, value, '', errors);
  return errors;
}

function walk(schema, value, path, errors) {
  if (!isObj(schema) || errors.length >= MAX_ERRORS) return;
  const here = path || '(root)';
  const err = (message) => errors.length < MAX_ERRORS && errors.push({ path: here, message });

  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    if (!types.some((t) => typeMatches(t, value))) {
      return err(`must be ${types.join(' or ')}, got ${typeOf(value)}`);
    }
  }
  if (schema.const !== undefined && value !== schema.const) err(`must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) err(`must be one of: ${short(schema.enum)}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) err('must not be empty');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) err(`must match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) err(`must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) err(`must be <= ${schema.maximum}`);
  }
  if (schema.oneOf) {
    const ok = schema.oneOf.filter((s) => {
      const sub = [];
      walk(s, value, path, sub);
      return sub.length === 0;
    }).length;
    if (ok !== 1) err('does not match any allowed form (e.g. a number in range, or an empty string for "unset")');
  }
  for (const s of schema.allOf || []) {
    if (s.if) {
      const probe = [];
      walk(s.if, value, path, probe);
      if (probe.length === 0 && s.then) walk(s.then, value, path, errors);
    } else walk(s, value, path, errors);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => {
      const key = isObj(item) && typeof item.id === 'string' && item.id ? `id=${item.id}` : i;
      walk(schema.items, item, typeof key === 'number' ? seg(path, key) : `${path}[${key}]`, errors);
    });
  }
  if (isObj(value)) {
    for (const r of schema.required || []) if (!(r in value)) err(`missing required field "${r}"`);
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (k in props) walk(props[k], v, seg(path, k), errors);
      else if (schema.additionalProperties === false) {
        errors.length < MAX_ERRORS &&
          errors.push({ path: seg(path, k), message: `unknown field "${k}". Known fields: ${Object.keys(props).join(', ')}` });
      }
    }
  }
}

/** Errors in `after` that were not already present in `before` (same path+message). */
export function newErrors(before, after) {
  const seen = new Set(before.map((e) => `${e.path}|${e.message}`));
  return after.filter((e) => !seen.has(`${e.path}|${e.message}`));
}

// ---------------------------------------------------------------------------
// Walking the schema along an ops path
// ---------------------------------------------------------------------------
const isArrayNode = (n) => n && [].concat(n.type || []).includes('array');
const isIdSeg = (s) => isObj(s) && typeof s.id === 'string';

/** The `then` schema of the block variant named `typeName` under a block item schema. */
export function pickVariant(itemNode, typeName) {
  const hit = (itemNode?.allOf || []).find((a) => a.if?.properties?.type?.const === typeName);
  return hit ? hit.then : null;
}
const variantFor = (items, item) =>
  items?.allOf && isObj(item) && typeof item.type === 'string' ? pickVariant(items, item.type) || items : items;

/**
 * Walk `path` (strings and { id } segments) through the schema, following the
 * current document so block variants resolve. Returns { node } (node may be null
 * when the schema stops describing the data, e.g. free-form objects) or { error }.
 */
export function resolveNode(schema, doc, path) {
  let node = schema;
  let data = doc;
  for (const s of path) {
    if (!node) return { node: null };
    if (isIdSeg(s)) {
      if (!isArrayNode(node)) return { error: `path segment {"id":"${s.id}"} addresses a list item, but the parent is not a list` };
      data = Array.isArray(data) ? data.find((x) => isObj(x) && x.id === s.id) : undefined;
      node = variantFor(node.items, data);
    } else if (typeof s === 'string') {
      if (node.properties) {
        if (!(s in node.properties)) {
          return { error: `unknown field "${s}". Known fields here: ${Object.keys(node.properties).join(', ')}` };
        }
        node = node.properties[s];
        data = isObj(data) ? data[s] : undefined;
      } else if (isArrayNode(node)) {
        return { error: `"${s}" is a list; address items with {"id":"<item id>"}` };
      } else return { node: null };
    } else return { error: 'path segments must be strings or {"id": "..."} objects' };
  }
  return { node };
}

/** Add missing `id`s (required by the schema) to new list items inside `value`. */
export function fillIds(value, node, gen = () => crypto.randomUUID()) {
  if (!node) return;
  if (Array.isArray(value)) {
    const items = node.items;
    if (!items) return;
    for (const it of value) {
      if (isObj(it)) {
        const n = variantFor(items, it);
        if (n?.required?.includes('id') && !it.id) it.id = gen();
        fillIds(it, n, gen);
      } else fillIds(it, items, gen);
    }
  } else if (isObj(value) && node.properties) {
    for (const [k, v] of Object.entries(value)) if (node.properties[k]) fillIds(v, node.properties[k], gen);
  }
}

// ---------------------------------------------------------------------------
// Schema browsing for get_schema
// ---------------------------------------------------------------------------
export function drill(schema, path) {
  let node = schema;
  for (const s of String(path || '').split('.').filter(Boolean)) {
    if (!node) break;
    if (isArrayNode(node) && node.items && !node.properties) node = node.items;
    const variant = pickVariant(node, s);
    if (variant) node = variant;
    else if (node.properties && s in node.properties) node = node.properties[s];
    else return { error: `nothing named "${s}" here. Options: ${[...Object.keys(node.properties || {}), ...(node.allOf || []).map((a) => a.if?.properties?.type?.const).filter(Boolean)].join(', ') || '(none)'}` };
  }
  return { node };
}

/** One-level summary of a (possibly huge) schema node. */
export function outline(node) {
  const inner = isArrayNode(node) && node.items ? node.items : node;
  const out = { type: node.type, title: node.title, description: node.description };
  if (isArrayNode(node)) out.note = 'list of items; each item has the shape below';
  if (inner.properties) {
    out.properties = Object.fromEntries(
      Object.entries(inner.properties).map(([k, v]) => [k, { type: v.type, title: v.title }]),
    );
    if (inner.required) out.required = inner.required;
  }
  const variants = (inner.allOf || []).filter((a) => a.if).map((a) => ({
    name: a.if.properties.type.const, title: a.then?.title,
  }));
  if (variants.length) out.variants = variants;
  out.hint = 'Call get_schema again with a deeper `path` (use a variant name to see one block type), or pass full=true.';
  return out;
}
