// ⚠️⚠️⚠️ CRITICAL INTER-DEPENDENCY WARNING ⚠️⚠️⚠️
//
// This file is MIRRORED BYTE-FOR-BYTE in two repos and MUST stay identical:
//   - editor/docs/.vitepress/theme/lib/patch.js   (the "diff" half — computes ops)
//   - config-api/src/patch.js                     (the "apply" half — applies ops)
//
// Same pattern as codec.js. If you change logic here, apply the SAME change to
// the sibling file; a divergence silently corrupts concurrent saves (id
// addressing, op ordering, or value shape would no longer agree between the
// editor that produces the patch and the server that applies it).
//
// The shared convention is 100% data-guided (no schema needed on the server):
//   A "keyed" array is an array whose every item is a plain object carrying a
//   non-empty string `id`. Keyed arrays are diffed/addressed by that stable
//   id, so per-field edits survive concurrent saves (last-edit-wins) and a
//   concurrent removal never resurrects an item.
//   ANY OTHER array (scalars, or objects lacking an id) is "keyless" and is
//   replaced wholesale on any change.
//
// The schema's hidden `id` default (see schema.js ID_KEY / injectUuid)
// guarantees every object-list and block-list in an edited config is keyed, so
// per-field granularity holds where it matters; scalar lists stay keyless.
//
// ID_KEY here MUST equal ID_KEY in editor docs/.vitepress/theme/lib/schema.js.
//
// Op vocabulary (a `path` is an array of string keys and/or `{ id }` segments):
//   - set    { op:'set',    path, value }        absolute-assign at `path`
//   - remove { op:'remove', path }               delete object key, or (when the
//                                                last segment is `{ id }`) remove
//                                                that keyed list item; no-op if absent
//   - listAdd    { op:'listAdd',    path, id, index, value }  insert a new keyed item
//   - listReorder{ op:'listReorder', path, ids }              set the list's id order
//
// Values are ABSOLUTE (the server applies them onto its *current* stored doc),
// so per-field edits are truly last-edit-wins even when the patch was computed
// from stale data.
//
// `diff` is pure and synchronous; `applyPatch` mutates `doc` in place and is
// kept well under 5 ms on ~100 KB docs (a WeakMap id→index cache makes
// repeated {id} segments O(1) rather than O(n)).
export const ID_KEY = 'id';

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function isIdSegment(seg) {
  return isPlainObject(seg) && typeof seg[ID_KEY] === 'string';
}

function genUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Fallback for environments without crypto.randomUUID.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// An array is KEYED when every item is a plain object with a non-empty string
// `id`. Empty arrays are NOT keyed (treated as keyless) so a scalar list that
// starts empty and gains plain values (e.g. [] -> ["a","b"]) diffs as a
// wholesale `set` instead of wrapping each scalar into { id, value }. A
// genuinely keyed array paired with an empty one still routes to diffKeyedArray,
// because at least one side then has real id-bearing items.
export function isKeyedArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  for (const item of arr) {
    if (!isPlainObject(item) || typeof item[ID_KEY] !== 'string' || item[ID_KEY].length === 0) {
      return false;
    }
  }
  return true;
}

function deepClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// diff (pure)
// ---------------------------------------------------------------------------

export function diff(baseline, current) {
  const ops = [];
  diffNode(baseline ?? {}, current ?? {}, [], ops);
  return ops;
}

function diffNode(base, cur, path, ops) {
  const bArr = Array.isArray(base);
  const cArr = Array.isArray(cur);
  if (bArr || cArr) {
    diffArray(base ?? [], cur ?? [], path, ops);
    return;
  }
  const bObj = isPlainObject(base);
  const cObj = isPlainObject(cur);
  if (bObj || cObj) {
    diffObject(base ?? {}, cur ?? {}, path, ops);
    return;
  }
  // scalar leaf
  if (!deepEqual(base, cur)) {
    ops.push({ op: 'set', path, value: deepClone(cur) });
  }
}

function diffObject(base, cur, path, ops) {
  const keys = new Set([...Object.keys(base), ...Object.keys(cur)]);
  for (const k of keys) {
    const inB = Object.prototype.hasOwnProperty.call(base, k);
    const inC = Object.prototype.hasOwnProperty.call(cur, k);
    if (inB && inC) {
      diffNode(base[k], cur[k], path.concat(k), ops);
    } else if (inB) {
      // key dropped in current -> delete it server-side
      ops.push({ op: 'remove', path: path.concat(k) });
    } else {
      ops.push({ op: 'set', path: path.concat(k), value: deepClone(cur[k]) });
    }
  }
}

function diffArray(base, cur, path, ops) {
  const baseKeyed = isKeyedArray(base);
  const curKeyed = isKeyedArray(cur);
  if (!baseKeyed && !curKeyed) {
    if (!deepEqual(base, cur)) {
      ops.push({ op: 'set', path, value: deepClone(cur) });
    }
    return;
  }
  diffKeyedArray(base, cur, path, ops);
}

function diffKeyedArray(base, cur, path, ops) {
  const bMap = new Map();
  for (const item of base) {
    if (isPlainObject(item) && typeof item[ID_KEY] === 'string') bMap.set(item[ID_KEY], item);
  }
  const baseOrder = base
    .map((item) => (isPlainObject(item) ? item[ID_KEY] : undefined))
    .filter((u) => typeof u === 'string');

  for (let i = 0; i < cur.length; i++) {
    const item = cur[i];
    let uuid = isPlainObject(item) && typeof item[ID_KEY] === 'string' ? item[ID_KEY] : '';
    const bItem = bMap.get(uuid);
    if (bItem !== undefined) {
      // existing item -> recurse per-field at {...path, {id}}
      diffNode(bItem, item, path.concat({ [ID_KEY]: uuid }), ops);
      bMap.delete(uuid);
    } else {
      // new item (assign a uuid if it lacks one; the op's value carries it, and
      // the editor adopts the server's merged config back, so it self-heals).
      if (!uuid) uuid = genUuid();
      const value = isPlainObject(item) ? { ...item } : { [ID_KEY]: uuid, value: item };
      if (!value[ID_KEY]) value[ID_KEY] = uuid;
      ops.push({ op: 'listAdd', path, id: uuid, index: i, value: deepClone(value) });
    }
  }
  // Remaining base items: removed.
  for (const uuid of bMap.keys()) {
    ops.push({ op: 'remove', path: path.concat({ [ID_KEY]: uuid }) });
  }
  // Emit a reorder only when the resulting uuid order can't be reached by the
  // listAdd/remove ops above (i.e. survivors were moved, or an insert happens
  // mid-list). Pure appends (tail = new uuids, survivors keep relative order)
  // need no reorder.
  const curIds = [];
  const seen = new Set();
  for (const item of cur) {
    const u = isPlainObject(item) ? item[ID_KEY] : undefined;
    if (typeof u === 'string' && !seen.has(u)) {
      seen.add(u);
      curIds.push(u);
    }
  }
  const expected = [];
  const inCur = new Set(curIds);
  for (const u of baseOrder) if (inCur.has(u)) expected.push(u); // survivors in base order
  for (const u of curIds) if (!expected.includes(u)) expected.push(u); // new uuids in cur order
  if (curIds.length > 1 && curIds.join('|') !== expected.join('|')) {
    ops.push({ op: 'listReorder', path, ids: curIds.slice() });
  }
}

// ---------------------------------------------------------------------------
// applyPatch (mutates doc in place; sub-5ms)
// ---------------------------------------------------------------------------

export function applyPatch(doc, ops) {
  let skipped = 0;
  for (const op of ops || []) {
    if (!applyOp(doc, op)) skipped++;
  }
  return { data: doc, skipped };
}

function applyOp(root, op) {
  if (!op || typeof op !== 'object') return false;
  switch (op.op) {
    case 'set':
      return applySet(root, op.path, op.value);
    case 'remove':
      return applyRemove(root, op.path);
    case 'listAdd':
      return applyListAdd(root, op.path, op.id, op.index, op.value);
    case 'listReorder':
      return applyListReorder(root, op.path, op.ids);
    default:
      return false;
  }
}

// Resolve every segment before the last, returning the container (`node`) that
// holds the final segment. `create` controls whether missing string-key path
// segments are auto-created (`true` for set, so a wholesale set can build the
// doc as it goes). `{ id }` segments are always resolved strictly: if the
// item is absent (removed concurrently) the resolve fails and the op becomes a
// no-op — last-edit-wins, never resurrects.
function resolveToParent(root, path, create) {
  if (!Array.isArray(path) || path.length === 0) return null;
  let node = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    if (isIdSegment(seg)) {
      if (!Array.isArray(node)) return null;
      const idx = indexById(node, seg[ID_KEY]);
      if (idx === -1) return null;
      node = node[idx];
    } else {
      if (!isPlainObject(node)) return null;
      if (!Object.prototype.hasOwnProperty.call(node, seg)) {
        if (!create) return null;
        node[seg] = {};
      }
      node = node[seg];
    }
  }
  const last = path[path.length - 1];
  if (isIdSegment(last)) {
    if (!Array.isArray(node)) return null;
    return { node, lastUuid: last[ID_KEY] };
  }
  if (!isPlainObject(node)) return null;
  return { node, lastKey: last };
}

// id -> index cache keyed by array identity, so repeated {id} segments and
// list ops are O(1). Invalidated whenever an array is structurally mutated.
const idIndexCache = new WeakMap();
function indexById(arr, id) {
  let map = idIndexCache.get(arr);
  if (!map) {
    map = new Map();
    for (let i = 0; i < arr.length; i++) {
      const u = arr[i] && arr[i][ID_KEY];
      if (typeof u === 'string') map.set(u, i);
    }
    idIndexCache.set(arr, map);
  }
  const idx = map.get(id);
  return idx === undefined ? -1 : idx;
}

function applySet(root, path, value) {
  const p = resolveToParent(root, path, true);
  if (!p) return false;
  if (p.lastUuid !== undefined) {
    const idx = indexById(p.node, p.lastUuid);
    if (idx === -1) return false;
    p.node[idx] = value;
    return true;
  }
  p.node[p.lastKey] = value;
  return true;
}

function applyRemove(root, path) {
  const p = resolveToParent(root, path, false);
  if (!p) return false;
  if (p.lastUuid !== undefined) {
    const idx = indexById(p.node, p.lastUuid);
    if (idx === -1) return false;
    p.node.splice(idx, 1);
    idIndexCache.delete(p.node);
    return true;
  }
  if (!Object.prototype.hasOwnProperty.call(p.node, p.lastKey)) return false;
  delete p.node[p.lastKey];
  return true;
}

function applyListAdd(root, path, id, index, value) {
  const p = resolveToParent(root, path, false);
  if (!p || p.lastUuid !== undefined) return false;
  const arr = p.node[p.lastKey];
  if (!Array.isArray(arr)) return false;
  if (!isPlainObject(value)) value = { [ID_KEY]: id, value };
  if (!value[ID_KEY]) value[ID_KEY] = id;
  const pos =
    typeof index === 'number' && index >= 0 && index <= arr.length ? Math.floor(index) : arr.length;
  arr.splice(pos, 0, value);
  idIndexCache.delete(arr);
  return true;
}

function applyListReorder(root, path, uuids) {
  const p = resolveToParent(root, path, false);
  if (!p || p.lastUuid !== undefined) return false;
  const arr = p.node[p.lastKey];
  if (!Array.isArray(arr) || !Array.isArray(uuids)) return false;
  const byUuid = new Map();
  for (const el of arr) {
    if (isPlainObject(el) && typeof el[ID_KEY] === 'string') byUuid.set(el[ID_KEY], el);
  }
  const rebuilt = [];
  for (const u of uuids) {
    if (byUuid.has(u)) {
      rebuilt.push(byUuid.get(u));
      byUuid.delete(u);
    }
  }
  // Preserve items not named in the order (concurrent adds are never dropped).
  for (const el of arr) {
    if (isPlainObject(el) && typeof el[ID_KEY] === 'string' && byUuid.has(el[ID_KEY])) {
      rebuilt.push(el);
      byUuid.delete(el[ID_KEY]);
    }
  }
  arr.length = 0;
  for (const el of rebuilt) arr.push(el);
  idIndexCache.delete(arr);
  return true;
}
