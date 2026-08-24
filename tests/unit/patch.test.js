// Comprehensive test suite for patch.js (the diff/apply half of the patch-save system).
//
// These tests assert the CANONICAL semantics (matching editor/docs/.vitepress/theme/lib/patch.js).
// The isKeyedArray([]) fix is already in config-api's copy (returns false for empty arrays),
// so all test cases below should PASS. The editor's copy on the branch where this was authored
// may still have the old behavior — see editor/tests/patch.test.js for the divergence note.
//
// Imported directly from src/patch.js (already exported). No mocking or fixtures needed.

import { describe, it, expect } from 'vitest';
import { ID_KEY, isKeyedArray, diff, applyPatch } from '../../src/patch.js';

// Helpers ---------------------------------------------------------------------

function deepClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function expectOpCount(ops, n) {
  expect(ops).toHaveLength(n);
}

// 1. Constants & isKeyedArray classification ----------------------------------

describe('isKeyedArray classification', () => {
  it('ID_KEY is "id"', () => {
    expect(ID_KEY).toBe('id');
  });

  it('empty arrays are NOT keyed (keyless)', () => {
    expect(isKeyedArray([])).toBe(false);
  });

  it('arrays of objects all carrying a non-empty string id ARE keyed', () => {
    expect(isKeyedArray([{ id: 'a', x: 1 }])).toBe(true);
  });

  it('objects lacking id are keyless', () => {
    expect(isKeyedArray([{ name: 'x' }])).toBe(false);
  });

  it('objects with an empty-string id are keyless', () => {
    expect(isKeyedArray([{ id: '' }])).toBe(false);
  });

  it('scalar arrays are keyless', () => {
    expect(isKeyedArray([1, 2, 3])).toBe(false);
    expect(isKeyedArray(['a', 'b'])).toBe(false);
  });

  it("mixed arrays (some have id, some don't) are keyless", () => {
    expect(isKeyedArray([{ id: 'a' }, { name: 'b' }])).toBe(false);
  });

  it('arrays containing null items are keyless', () => {
    expect(isKeyedArray([{ id: 'a' }, null])).toBe(false);
  });

  it('non-arrays are keyless', () => {
    expect(isKeyedArray(null)).toBe(false);
    expect(isKeyedArray(undefined)).toBe(false);
    expect(isKeyedArray({})).toBe(false);
    expect(isKeyedArray('hello')).toBe(false);
    expect(isKeyedArray(42)).toBe(false);
  });

  it('nested objects with id at the top level are still keyed', () => {
    expect(isKeyedArray([{ id: 'a', nested: { id: 'z' } }])).toBe(true);
  });
});

// 2. diff — scalar leaf changes ------------------------------------------------

describe('diff scalar leaf changes', () => {
  it('identical scalars produce 0 ops', () => {
    expect(diff({ a: 1 }, { a: 1 })).toHaveLength(0);
  });

  it('string change produces a single set', () => {
    const ops = diff({ a: 'hello' }, { a: 'world' });
    expectOpCount(ops, 1);
    expect(ops[0]).toEqual({ op: 'set', path: ['a'], value: 'world' });
  });

  it('number → null produces a single set', () => {
    const ops = diff({ a: 5 }, { a: null });
    expectOpCount(ops, 1);
    expect(ops[0]).toEqual({ op: 'set', path: ['a'], value: null });
  });

  it('boolean true → false produces a single set', () => {
    const ops = diff({ a: true }, { a: false });
    expectOpCount(ops, 1);
    expect(ops[0]).toEqual({ op: 'set', path: ['a'], value: false });
  });

  it('null → 0 (type change) produces a single set', () => {
    const ops = diff({ a: null }, { a: 0 });
    expectOpCount(ops, 1);
    expect(ops[0]).toEqual({ op: 'set', path: ['a'], value: 0 });
  });
});

// 3. diff — object add / drop / rename ----------------------------------------

describe('diff object add / drop / rename', () => {
  it('adding a key produces a set op', () => {
    const ops = diff({ a: 1 }, { a: 1, b: 2 });
    expectOpCount(ops, 1);
    expect(ops[0]).toEqual({ op: 'set', path: ['b'], value: 2 });
  });

  it('dropping a key produces a remove op', () => {
    const ops = diff({ a: 1, b: 2 }, { a: 1 });
    expectOpCount(ops, 1);
    expect(ops[0]).toEqual({ op: 'remove', path: ['b'] });
  });

  it('adding a key while keeping existing produces only the new key', () => {
    const ops = diff({ a: 1, b: 2 }, { a: 1, b: 2, c: 3 });
    expectOpCount(ops, 1);
    expect(ops[0]).toEqual({ op: 'set', path: ['c'], value: 3 });
  });

  it('renaming a key (drop old + add new) produces remove + set', () => {
    const ops = diff({ oldKey: 1 }, { newKey: 1 });
    expectOpCount(ops, 2);
    expect(ops).toContainEqual({ op: 'remove', path: ['oldKey'] });
    expect(ops).toContainEqual({ op: 'set', path: ['newKey'], value: 1 });
  });

  it('deep scalar change produces a recursive set at a.b.c', () => {
    const ops = diff({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } });
    expectOpCount(ops, 1);
    expect(ops[0]).toEqual({ op: 'set', path: ['a', 'b', 'c'], value: 2 });
  });

  it('adding a key inside a nested object produces a set at a.b.newKey', () => {
    const ops = diff({ a: { b: {} } }, { a: { b: { newKey: 1 } } });
    expectOpCount(ops, 1);
    expect(ops[0]).toEqual({ op: 'set', path: ['a', 'b', 'newKey'], value: 1 });
  });

  it('removing a key inside a nested object produces a remove at a.b.oldKey', () => {
    const ops = diff({ a: { b: { oldKey: 1 } } }, { a: { b: {} } });
    expectOpCount(ops, 1);
    expect(ops[0]).toEqual({ op: 'remove', path: ['a', 'b', 'oldKey'] });
  });
});

// 4. diff — keyless (scalar) arrays — KEY BUG SCENARIOS -----------------------

describe('diff keyless scalar arrays', () => {
  it('identical scalar arrays produce 0 ops', () => {
    expect(diff({ a: [1, 2, 3] }, { a: [1, 2, 3] })).toHaveLength(0);
    expect(diff({ a: ['x'] }, { a: ['x'] })).toHaveLength(0);
  });

  it('[1,2,3] → [1,2,3,4] produces a single set (not listAdd)', () => {
    const ops = diff({ a: [1, 2, 3] }, { a: [1, 2, 3, 4] });
    expectOpCount(ops, 1);
    expect(ops[0]).toEqual({ op: 'set', path: ['a'], value: [1, 2, 3, 4] });
    expect(ops[0].op).not.toBe('listAdd');
  });

  it('[1,2,3] → [] produces a single set with value [] (NOT zero ops)', () => {
    const ops = diff({ a: [1, 2, 3] }, { a: [] });
    expectOpCount(ops, 1);
    expect(ops[0]).toEqual({ op: 'set', path: ['a'], value: [] });
  });

  it('[] → [1,2,3] produces a single set with raw array value (NOT listAdd with {id,value})', () => {
    const ops = diff({ a: [] }, { a: [1, 2, 3] });
    expectOpCount(ops, 1);
    expect(ops[0]).toEqual({ op: 'set', path: ['a'], value: [1, 2, 3] });
    // The value must be the raw array, not wrapped objects
    expect(ops[0].value).toEqual([1, 2, 3]);
    expect(ops[0].op).not.toBe('listAdd');
  });

  it('["a"] → ["b"] produces a single set', () => {
    const ops = diff({ a: ['a'] }, { a: ['b'] });
    expectOpCount(ops, 1);
    expect(ops[0]).toEqual({ op: 'set', path: ['a'], value: ['b'] });
  });

  it('[] → ["a","b"] produces a single set with plain array value (NOT listAdd)', () => {
    const ops = diff({ a: [] }, { a: ['a', 'b'] });
    expectOpCount(ops, 1);
    expect(ops[0]).toEqual({ op: 'set', path: ['a'], value: ['a', 'b'] });
    expect(ops[0].op).not.toBe('listAdd');
  });

  it('different scalar arrays produce a single set (wholesale replace)', () => {
    const ops = diff({ a: ['x', 'y'] }, { a: ['z'] });
    expectOpCount(ops, 1);
    expect(ops[0]).toEqual({ op: 'set', path: ['a'], value: ['z'] });
  });

  it('scalar array diff produces a set op with raw array value (no {id,value} wrapping)', () => {
    const ops = diff({ tags: [] }, { tags: ['dark', 'twocols'] });
    expectOpCount(ops, 1);
    expect(ops[0].op).toBe('set');
    expect(ops[0].value).toEqual(['dark', 'twocols']);
    // No element should be an {id, value} wrapper object
    expect(ops[0].value.some((v) => typeof v === 'object' && v !== null && 'id' in v && 'value' in v)).toBe(false);
  });
});

// 5. diff — keyed arrays (objects with id) -------------------------------------

describe('diff keyed arrays', () => {
  it('identical keyed arrays produce 0 ops', () => {
    const items = [{ id: 'a', name: 'first' }, { id: 'b', name: 'second' }];
    expect(diff({ list: items }, { list: deepClone(items) })).toHaveLength(0);
  });

  it('adding a new keyed item produces a listAdd with correct id, index, value', () => {
    const ops = diff({ list: [{ id: 'a', name: 'first' }] }, {
      list: [{ id: 'a', name: 'first' }, { id: 'b', name: 'second' }],
    });
    expectOpCount(ops, 1);
    expect(ops[0].op).toBe('listAdd');
    expect(ops[0].path).toEqual(['list']);
    expect(ops[0].id).toBe('b');
    expect(ops[0].index).toBe(1);
    expect(ops[0].value).toEqual({ id: 'b', name: 'second' });
  });

  it('removing a keyed item produces a remove op with {id} path segment', () => {
    const ops = diff(
      { list: [{ id: 'a', name: 'first' }, { id: 'b', name: 'second' }] },
      { list: [{ id: 'a', name: 'first' }] },
    );
    expectOpCount(ops, 1);
    expect(ops[0]).toEqual({ op: 'remove', path: ['list', { id: 'b' }] });
  });

  it('editing a field on an existing keyed item produces a set at path/[id]/field', () => {
    const ops = diff(
      { list: [{ id: 'a', name: 'old' }] },
      { list: [{ id: 'a', name: 'new' }] },
    );
    expectOpCount(ops, 1);
    expect(ops[0]).toEqual({ op: 'set', path: ['list', { id: 'a' }, 'name'], value: 'new' });
  });

  it('add + edit existing produces listAdd + set', () => {
    const ops = diff(
      { list: [{ id: 'a', title: 'old' }] },
      { list: [{ id: 'a', title: 'new' }, { id: 'b', title: 'fresh' }] },
    );
    expectOpCount(ops, 2);
    expect(ops).toContainEqual({ op: 'set', path: ['list', { id: 'a' }, 'title'], value: 'new' });
    expect(ops).toContainEqual({
      op: 'listAdd',
      path: ['list'],
      id: 'b',
      index: 1,
      value: { id: 'b', title: 'fresh' },
    });
  });

  it('remove + edit existing produces remove + set', () => {
    const ops = diff(
      { list: [{ id: 'a', title: 'one' }, { id: 'b', title: 'two' }] },
      { list: [{ id: 'a', title: 'ONE' }] },
    );
    expectOpCount(ops, 2);
    expect(ops).toContainEqual({ op: 'remove', path: ['list', { id: 'b' }] });
    expect(ops).toContainEqual({ op: 'set', path: ['list', { id: 'a' }, 'title'], value: 'ONE' });
  });

  it('reorder (move item) produces a listReorder op with ids in new order', () => {
    const ops = diff(
      { list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      { list: [{ id: 'c' }, { id: 'a' }, { id: 'b' }] },
    );
    expectOpCount(ops, 1);
    expect(ops[0]).toEqual({ op: 'listReorder', path: ['list'], ids: ['c', 'a', 'b'] });
  });

  it('pure tail-append (new item at end) produces listAdd only, no listReorder', () => {
    const ops = diff(
      { list: [{ id: 'a' }, { id: 'b' }] },
      { list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
    );
    expectOpCount(ops, 1);
    expect(ops[0].op).toBe('listAdd');
    expect(ops.some((o) => o.op === 'listReorder')).toBe(false);
  });

  it('prepend (new item at start) produces listAdd + listReorder', () => {
    const ops = diff({ list: [{ id: 'a' }, { id: 'b' }] }, { list: [{ id: 'c' }, { id: 'a' }, { id: 'b' }] });
    expect(ops.some((o) => o.op === 'listAdd')).toBe(true);
    expect(ops.some((o) => o.op === 'listReorder')).toBe(true);
  });

  it('empty keyed → populated produces a listAdd per new item', () => {
    const ops = diff({ list: [] }, { list: [{ id: 'a', name: 'x' }, { id: 'b', name: 'y' }] });
    expect(ops.every((o) => o.op === 'listAdd')).toBe(true);
    expectOpCount(ops, 2);
  });

  it('populated keyed → empty produces a remove per item', () => {
    const ops = diff(
      { list: [{ id: 'a' }, { id: 'b' }] },
      { list: [] },
    );
    expect(ops.every((o) => o.op === 'remove')).toBe(true);
    expectOpCount(ops, 2);
  });

  it('shuffle of all items produces a single listReorder', () => {
    const ops = diff(
      { list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] },
      { list: [{ id: 'd' }, { id: 'c' }, { id: 'b' }, { id: 'a' }] },
    );
    expectOpCount(ops, 1);
    expect(ops[0]).toEqual({ op: 'listReorder', path: ['list'], ids: ['d', 'c', 'b', 'a'] });
  });
});

// 6. diff — keyed array with genUuid (items lacking id) ------------------------

describe('diff keyed array with genUuid', () => {
  it('new item without id in a keyed array gets a generated non-empty id', () => {
    const ops = diff(
      { list: [{ id: 'a', title: 'existing' }] },
      { list: [{ id: 'a', title: 'existing' }, { title: 'new-item' }] },
    );
    const addOp = ops.find((o) => o.op === 'listAdd');
    expect(addOp).toBeDefined();
    expect(typeof addOp.id).toBe('string');
    expect(addOp.id.length).toBeGreaterThan(0);
    // value.id must match op id (self-healing via server merge)
    expect(addOp.value.id).toBe(addOp.id);
  });

  it('generated id is a valid UUID v4 format string', () => {
    const ops = diff({ list: [{ id: 'a' }] }, { list: [{ id: 'a' }, { title: 'x' }] });
    const addOp = ops.find((o) => o.op === 'listAdd');
    // UUID v4: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx where y is 8/9/a/b
    expect(addOp.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

// 7. diff — nullish inputs -----------------------------------------------------

describe('diff nullish inputs', () => {
  it('diff(null, null) produces 0 ops', () => {
    expect(diff(null, null)).toHaveLength(0);
  });

  it('diff(undefined, undefined) produces 0 ops', () => {
    expect(diff(undefined, undefined)).toHaveLength(0);
  });

  it('diff(null, {a:1}) produces a single set at a', () => {
    const ops = diff(null, { a: 1 });
    expectOpCount(ops, 1);
    expect(ops[0]).toEqual({ op: 'set', path: ['a'], value: 1 });
  });

  it('diff({a:1}, null) produces a remove op at a', () => {
    const ops = diff({ a: 1 }, null);
    expectOpCount(ops, 1);
    expect(ops[0]).toEqual({ op: 'remove', path: ['a'] });
  });

  it('diff({a:1}, undefined) produces a remove op at a', () => {
    const ops = diff({ a: 1 }, undefined);
    expectOpCount(ops, 1);
    expect(ops[0]).toEqual({ op: 'remove', path: ['a'] });
  });
});

// 8. diff — deeply nested structures ------------------------------------------

describe('diff deeply nested structures', () => {
  it('3-level nested object scalar change has correct path composition', () => {
    const ops = diff({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } });
    expectOpCount(ops, 1);
    expect(ops[0].path).toEqual(['a', 'b', 'c']);
  });

  it('nested object inside keyed array item has correct path', () => {
    const ops = diff(
      { list: [{ id: 'a', meta: { title: 'old' } }] },
      { list: [{ id: 'a', meta: { title: 'new' } }] },
    );
    expectOpCount(ops, 1);
    expect(ops[0].path).toEqual(['list', { id: 'a' }, 'meta', 'title']);
  });

  it('nested keyed array inside keyed array item has correct path composition', () => {
    const ops = diff(
      { grid: [{ id: 'g1', row: [{ id: 'r1', col: { val: 1 } }] }] },
      { grid: [{ id: 'g1', row: [{ id: 'r1', col: { val: 2 } }] }] },
    );
    expectOpCount(ops, 1);
    expect(ops[0].path).toEqual([
      'grid',
      { id: 'g1' },
      'row',
      { id: 'r1' },
      'col',
      'val',
    ]);
  });
});

// 9. applyPatch — set operation -----------------------------------------------

describe('applyPatch set operation', () => {
  it('set at root path segments (nested) creates and sets values', () => {
    const doc = {};
    const result = applyPatch(doc, [{ op: 'set', path: ['a', 'b'], value: 42 }]);
    expect(result.data).toEqual({ a: { b: 42 } });
    expect(result.skipped).toBe(0);
  });

  it('set with {id} path segment replaces the entire keyed item', () => {
    const doc = { list: [{ id: 'a', title: 'old' }, { id: 'b', title: 'keep' }] };
    const result = applyPatch(doc, [
      { op: 'set', path: ['list', { id: 'a' }], value: { id: 'a', title: 'replaced' } },
    ]);
    expect(result.skipped).toBe(0);
    expect(result.data).toEqual({ list: [{ id: 'a', title: 'replaced' }, { id: 'b', title: 'keep' }] });
  });

  it('set at existing object key overwrites', () => {
    const doc = { a: 1 };
    const result = applyPatch(doc, [{ op: 'set', path: ['a'], value: 2 }]);
    expect(result.data).toEqual({ a: 2 });
  });

  it('set with missing string-key path auto-creates intermediate objects', () => {
    const doc = {};
    applyPatch(doc, [{ op: 'set', path: ['x', 'y', 'z'], value: 'deep' }]);
    expect(doc).toEqual({ x: { y: { z: 'deep' } } });
  });

  it('set when {id} segment does not resolve returns false (skipped, no resurrection)', () => {
    const doc = { list: [{ id: 'a', title: 'keep' } ]};
    const result = applyPatch(doc, [
      { op: 'set', path: ['list', { id: 'nonexistent' }], value: { id: 'nonexistent', title: 'new' } },
    ]);
    expect(result.skipped).toBe(1);
    expect(result.data).toEqual({ list: [{ id: 'a', title: 'keep' }] });
  });

  it('set at {} root (empty path) returns false', () => {
    const doc = { a: 1 };
    const result = applyPatch(doc, [{ op: 'set', path: [], value: 2 }]);
    expect(result.skipped).toBe(1);
    expect(result.data).toEqual({ a: 1 });
  });
});

// 10. applyPatch — remove operation -------------------------------------------

describe('applyPatch remove operation', () => {
  it('remove existing object key deletes it and returns true', () => {
    const doc = { a: 1, b: 2 };
    const result = applyPatch(doc, [{ op: 'remove', path: ['a'] }]);
    expect(result.skipped).toBe(0);
    expect(result.data).toEqual({ b: 2 });
  });

  it('remove non-existent object key returns false (skipped, no error)', () => {
    const doc = { a: 1 };
    const result = applyPatch(doc, [{ op: 'remove', path: ['nonexistent'] }]);
    expect(result.skipped).toBe(1);
    expect(result.data).toEqual({ a: 1 });
  });

  it('remove keyed item by {id} splices it out, returns true', () => {
    const doc = { list: [{ id: 'a', title: 'one' }, { id: 'b', title: 'two' }] };
    const result = applyPatch(doc, [{ op: 'remove', path: ['list', { id: 'b' }] }]);
    expect(result.skipped).toBe(0);
    expect(result.data).toEqual({ list: [{ id: 'a', title: 'one' }] });
  });

  it('remove non-existent {id} returns false (skipped, no resurrection) — critical invariant', () => {
    const doc = { list: [{ id: 'a', title: 'keep' }] };
    const result = applyPatch(doc, [{ op: 'remove', path: ['list', { id: 'deleted-concurrently' }] }]);
    expect(result.skipped).toBe(1);
    expect(result.data).toEqual({ list: [{ id: 'a', title: 'keep' }] });
  });

  it('remove with {id} when parent is not an array returns false', () => {
    const doc = { foo: { id: 'a' } };
    const result = applyPatch(doc, [{ op: 'remove', path: ['foo', { id: 'a' }] }]);
    expect(result.skipped).toBe(1);
  });

  it('remove with empty path returns false', () => {
    const doc = { a: 1 };
    const result = applyPatch(doc, [{ op: 'remove', path: [] }]);
    expect(result.skipped).toBe(1);
    expect(result.data).toEqual({ a: 1 });
  });
});

// 11. applyPatch — listAdd operation ------------------------------------------

describe('applyPatch listAdd operation', () => {
  it('listAdd at empty array inserts at index 0', () => {
    const doc = { list: [] };
    const result = applyPatch(doc, [
      { op: 'listAdd', path: ['list'], id: 'x', index: 0, value: { id: 'x', title: 'new' } },
    ]);
    expect(result.skipped).toBe(0);
    expect(result.data).toEqual({ list: [{ id: 'x', title: 'new' }] });
  });

  it('listAdd at index 0 prepends', () => {
    const doc = { list: [{ id: 'b', title: 'second' }] };
    applyPatch(doc, [{ op: 'listAdd', path: ['list'], id: 'a', index: 0, value: { id: 'a', title: 'first' } }]);
    expect(doc.list[0].id).toBe('a');
    expect(doc.list[1].id).toBe('b');
  });

  it('listAdd at index 0 of [{id:"a"}] inserts before', () => {
    const doc = { list: [{ id: 'a' }] };
    applyPatch(doc, [{ op: 'listAdd', path: ['list'], id: 'b', index: 0, value: { id: 'b' } }]);
    expect(doc.list).toEqual([{ id: 'b' }, { id: 'a' }]);
  });

  it('listAdd index beyond array length appends at end', () => {
    const doc = { list: [{ id: 'a' }] };
    applyPatch(doc, [{ op: 'listAdd', path: ['list'], id: 'b', index: 999, value: { id: 'b' } }]);
    expect(doc.list).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('listAdd with negative index appends at end (clamp)', () => {
    const doc = { list: [{ id: 'a' }] };
    applyPatch(doc, [{ op: 'listAdd', path: ['list'], id: 'b', index: -1, value: { id: 'b' } }]);
    expect(doc.list).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('listAdd with non-numeric index appends at end', () => {
    const doc = { list: [{ id: 'a' }] };
    applyPatch(doc, [{ op: 'listAdd', path: ['list'], id: 'b', index: 'foo', value: { id: 'b' } }]);
    expect(doc.list).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('listAdd to non-array returns false', () => {
    const doc = { list: { not: 'an array' } };
    const result = applyPatch(doc, [
      { op: 'listAdd', path: ['list'], id: 'x', index: 0, value: { id: 'x' } },
    ]);
    expect(result.skipped).toBe(1);
  });

  it('listAdd with scalar value wraps as {id, value}', () => {
    const doc = { list: [] };
    applyPatch(doc, [{ op: 'listAdd', path: ['list'], id: 'newid', index: 0, value: 'scalar' }]);
    expect(doc.list).toEqual([{ id: 'newid', value: 'scalar' }]);
  });

  it('listAdd with object value lacking id assigns the op id', () => {
    const doc = { list: [] };
    applyPatch(doc, [
      { op: 'listAdd', path: ['list'], id: 'assigned', index: 0, value: { title: 'no-id' } },
    ]);
    expect(doc.list[0].id).toBe('assigned');
    expect(doc.list[0].title).toBe('no-id');
  });

  it('listAdd with object value already having id keeps it', () => {
    const doc = { list: [] };
    applyPatch(doc, [
      { op: 'listAdd', path: ['list'], id: 'opid', index: 0, value: { id: 'valueid', title: 'kept' } },
    ]);
    expect(doc.list[0].id).toBe('valueid');
  });
});

// 12. applyPatch — listReorder operation --------------------------------------

describe('applyPatch listReorder operation', () => {
  it('reorder existing items produces correct order', () => {
    const doc = { list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
    applyPatch(doc, [{ op: 'listReorder', path: ['list'], ids: ['c', 'a', 'b'] }]);
    expect(doc.list.map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  it('reorder with uuid not in array skips that uuid (no error)', () => {
    const doc = { list: [{ id: 'a' }, { id: 'b' }] };
    applyPatch(doc, [{ op: 'listReorder', path: ['list'], ids: ['c', 'a', 'b'] }]);
    expect(doc.list.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('reorder with uuids subset of current only reorders named items, preserves rest', () => {
    const doc = { list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] };
    applyPatch(doc, [{ op: 'listReorder', path: ['list'], ids: ['d', 'a'] }]);
    // d and a come first in specified order, b and c preserved in original order
    expect(doc.list.map((i) => i.id)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('reorder with empty ids preserves all items (idempotent)', () => {
    const doc = { list: [{ id: 'a' }, { id: 'b' }] };
    applyPatch(doc, [{ op: 'listReorder', path: ['list'], ids: [] }]);
    expect(doc.list.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('reorder on non-array returns false', () => {
    const doc = { list: 'not-array' };
    const result = applyPatch(doc, [{ op: 'listReorder', path: ['list'], ids: ['a'] }]);
    expect(result.skipped).toBe(1);
  });

  it('reorder with non-array ids returns false', () => {
    const doc = { list: [{ id: 'a' }] };
    const result = applyPatch(doc, [{ op: 'listReorder', path: ['list'], ids: 'not-array' }]);
    expect(result.skipped).toBe(1);
  });

  it('concurrent-add safety: items not named are never dropped', () => {
    // The array has 3 items, reorder only names 2 — the unnamed one survives
    const doc = { list: [{ id: 'x' }, { id: 'a' }, { id: 'b' }] };
    applyPatch(doc, [{ op: 'listReorder', path: ['list'], ids: ['b', 'a'] }]);
    expect(doc.list.map((i) => i.id)).toEqual(['b', 'a', 'x']);
  });
});

// 13. applyPatch — robustness / no-resurrection -------------------------------

describe('applyPatch robustness', () => {
  it('empty ops array returns {data: doc, skipped: 0}', () => {
    const doc = { a: 1 };
    const result = applyPatch(doc, []);
    expect(result.data).toBe(doc);
    expect(result.skipped).toBe(0);
    expect(result.data).toEqual({ a: 1 });
  });

  it('null ops returns {data: doc, skipped: 0}', () => {
    const doc = { a: 1 };
    const result = applyPatch(doc, null);
    expect(result.data).toBe(doc);
    expect(result.skipped).toBe(0);
  });

  it('undefined ops returns {data: doc, skipped: 0}', () => {
    const doc = { a: 1 };
    const result = applyPatch(doc, undefined);
    expect(result.data).toBe(doc);
    expect(result.skipped).toBe(0);
  });

  it('unknown op type is skipped', () => {
    const doc = { a: 1 };
    const result = applyPatch(doc, [{ op: 'unknownOp', path: ['a'], value: 2 }]);
    expect(result.skipped).toBe(1);
    expect(result.data).toEqual({ a: 1 });
  });

  it('malformed op (not an object) is skipped', () => {
    const doc = { a: 1 };
    const result = applyPatch(doc, ['not-an-object', 42, null]);
    expect(result.skipped).toBe(3);
    expect(result.data).toEqual({ a: 1 });
  });

  it('op without op field is skipped', () => {
    const doc = { a: 1 };
    const result = applyPatch(doc, [{ path: ['a'], value: 2 }]);
    expect(result.skipped).toBe(1);
  });

  it('removing then adding same id across two ops produces correct final state', () => {
    const doc = { list: [{ id: 'a', title: 'old' }] };
    const ops = [
      { op: 'remove', path: ['list', { id: 'a' }] },
      { op: 'listAdd', path: ['list'], id: 'a', index: 0, value: { id: 'a', title: 'new' } },
    ];
    const result = applyPatch(doc, ops);
    expect(result.skipped).toBe(0);
    expect(result.data).toEqual({ list: [{ id: 'a', title: 'new' }] });
  });
});

// 14. Roundtrip property — diff then applyPatch reconstructs current -----------

describe('roundtrip: applyPatch(deepClone(baseline), diff(baseline, current)) === current', () => {
  function roundtrip(baseline, current) {
    const ops = diff(baseline, current);
    // applyPatch cannot set properties on null; mirror the real system
    // (store.js always has an object baseline) by defaulting null to {}.
    const result = applyPatch(deepClone(baseline ?? {}), ops);
    return { data: result.data, skipped: result.skipped, ops };
  }

  it('identical objects roundtrip to identity', () => {
    const base = { a: 1, b: 'hello', c: true };
    const r = roundtrip(base, deepClone(base));
    expect(r.data).toEqual(base);
    expect(r.skipped).toBe(0);
  });

  it('scalar leaf change roundtrips', () => {
    const r = roundtrip({ a: 1, b: 2 }, { a: 1, b: 99 });
    expect(r.data).toEqual({ a: 1, b: 99 });
    expect(r.skipped).toBe(0);
  });

  it('object add/drop/rename roundtrips', () => {
    const r = roundtrip({ a: 1, b: 2 }, { c: 3, d: 4 });
    expect(r.data).toEqual({ c: 3, d: 4 });
    expect(r.skipped).toBe(0);
  });

  it('nested object changes roundtrips', () => {
    const r = roundtrip(
      { a: { b: { c: 1, d: 2 } } },
      { a: { b: { c: 99, d: 2 } } },
    );
    expect(r.data).toEqual({ a: { b: { c: 99, d: 2 } } });
    expect(r.skipped).toBe(0);
  });

  it('keyless array change roundtrips — [] → [1,2,3]', () => {
    const r = roundtrip({ a: [] }, { a: [1, 2, 3] });
    expect(r.data).toEqual({ a: [1, 2, 3] });
    expect(r.skipped).toBe(0);
  });

  it('keyless array change roundtrips — [1,2,3] → []', () => {
    const r = roundtrip({ a: [1, 2, 3] }, { a: [] });
    expect(r.data).toEqual({ a: [] });
    expect(r.skipped).toBe(0);
  });

  it('keyless array change roundtrips — ["a","b"] → ["c"]', () => {
    const r = roundtrip({ tags: ['a', 'b'] }, { tags: ['c'] });
    expect(r.data).toEqual({ tags: ['c'] });
    expect(r.skipped).toBe(0);
  });

  it('keyed array add roundtrips', () => {
    const r = roundtrip(
      { list: [{ id: 'a', title: 'one' }] },
      { list: [{ id: 'a', title: 'one' }, { id: 'b', title: 'two' }] },
    );
    expect(r.data).toEqual({ list: [{ id: 'a', title: 'one' }, { id: 'b', title: 'two' }] });
    expect(r.skipped).toBe(0);
  });

  it('keyed array remove roundtrips', () => {
    const r = roundtrip(
      { list: [{ id: 'a', title: 'one' }, { id: 'b', title: 'two' }] },
      { list: [{ id: 'a', title: 'one' }] },
    );
    expect(r.data).toEqual({ list: [{ id: 'a', title: 'one' }] });
    expect(r.skipped).toBe(0);
  });

  it('keyed array edit roundtrips', () => {
    const r = roundtrip(
      { list: [{ id: 'a', title: 'old' }] },
      { list: [{ id: 'a', title: 'new' }] },
    );
    expect(r.data).toEqual({ list: [{ id: 'a', title: 'new' }] });
    expect(r.skipped).toBe(0);
  });

  it('keyed array reorder roundtrips', () => {
    const r = roundtrip(
      { list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      { list: [{ id: 'c' }, { id: 'a' }, { id: 'b' }] },
    );
    expect(r.data).toEqual({ list: [{ id: 'c' }, { id: 'a' }, { id: 'b' }] });
    expect(r.skipped).toBe(0);
  });

  it('keyed array empty → populated roundtrips', () => {
    const r = roundtrip(
      { list: [] },
      { list: [{ id: 'x', title: 'new' }] },
    );
    expect(r.data).toEqual({ list: [{ id: 'x', title: 'new' }] });
    expect(r.skipped).toBe(0);
  });

  it('keyed array populated → empty roundtrips', () => {
    const r = roundtrip(
      { list: [{ id: 'a' }, { id: 'b' }] },
      { list: [] },
    );
    expect(r.data).toEqual({ list: [] });
    expect(r.skipped).toBe(0);
  });

  it('multiple concurrent field edits on same keyed item roundtrips', () => {
    const r = roundtrip(
      { items: [{ id: 'a', name: 'old', count: 1, active: false }] },
      { items: [{ id: 'a', name: 'new', count: 42, active: true }] },
    );
    expect(r.data).toEqual({ items: [{ id: 'a', name: 'new', count: 42, active: true }] });
    expect(r.skipped).toBe(0);
  });

  it('nullish inputs roundtrip', () => {
    const r = roundtrip(null, null);
    expect(r.data).toEqual({});
    expect(r.skipped).toBe(0);
  });

  it('null → object roundtrips', () => {
    const r = roundtrip(null, { a: 1, b: { c: 2 } });
    expect(r.data).toEqual({ a: 1, b: { c: 2 } });
    expect(r.skipped).toBe(0);
  });

  it('large nested config (simulated realistic config.json) roundtrips', () => {
    const baseline = {
      theme: { accent: '#3b82f6', fonts: { heading: 'Inter', body: 'Source Sans' } },
      site: { title: 'Parroquia', languages: ['Español:es'] },
      info: {
        places: [
          { id: 'p1', name: 'Santo Domingo', geo: { lat: 40.4, lng: -3.6 }, tags: ['old'] },
          { id: 'p2', name: 'Centro', geo: { lat: 40.5, lng: -3.7 }, tags: [] },
        ],
        bank: [{ id: 'b1', title: 'Main', account: '1234' }],
      },
      pages: {
        list: [
          {
            id: 'pg1',
            title: 'Inicio',
            sections: [
              { id: 's1', type: 'text', title: 'Welcome', tags: ['dark'] },
              { id: 's2', type: 'gallery', title: 'Photos', tags: [] },
            ],
          },
          { id: 'pg2', title: 'Misa', sections: [{ id: 's3', type: 'hero', title: 'Banner' }] },
        ],
        nav: [{ id: 'n1', title: 'Home', links: ['https://x.com'] }],
      },
      'event-types': { list: [{ id: 'et1', name: 'mass', label: 'Misa' }] },
    };

    const current = {
      theme: { accent: '#ef4444', fonts: { heading: 'Inter', body: 'Inter' } },
      site: { title: 'Parroquia', languages: ['Español:es', 'English:en'] },
      info: {
        places: [
          { id: 'p1', name: 'Santo Domingo', geo: { lat: 40.41, lng: -3.6 }, tags: ['old', 'new'] },
          { id: 'p2', name: 'Centro', geo: { lat: 40.5, lng: -3.7 }, tags: ['updated'] },
        ],
        bank: [{ id: 'b1', title: 'Main', account: '5678' }],
      },
      pages: {
        list: [
          {
            id: 'pg1',
            title: 'Inicio',
            sections: [
              { id: 's1', type: 'text', title: 'Welcome Updated', tags: ['dark', 'twocols'] },
              { id: 's2', type: 'gallery', title: 'Photos Updated', tags: ['new'] },
              { id: 's4', type: 'hero', title: 'New Section', tags: [] },
            ],
          },
          { id: 'pg2', title: 'Misa', sections: [{ id: 's3', type: 'hero', title: 'Banner Updated' }] },
          { id: 'pg3', title: 'Contacto', sections: [] },
        ],
        nav: [{ id: 'n1', title: 'Home', links: ['https://x.com', 'https://y.com'] }],
      },
      'event-types': { list: [{ id: 'et1', name: 'mass', label: 'Misa', newField: true }] },
    };

    const r = roundtrip(deepClone(baseline), current);
    expect(r.data).toEqual(current);
    expect(r.skipped).toBe(0);
  });
});

// 15. Op vocabulary conformance -----------------------------------------------

describe('op vocabulary conformance', () => {
  it('set op has {op:"set", path, value} with no extra fields', () => {
    const ops = diff({ a: 1 }, { a: 2 });
    expect(ops[0]).toEqual({ op: 'set', path: ['a'], value: 2 });
    expect(Object.keys(ops[0]).sort()).toEqual(['op', 'path', 'value']);
  });

  it('remove op has {op:"remove", path} with no value field', () => {
    const ops = diff({ a: 1, b: 2 }, { a: 1 });
    expect(ops[0]).toEqual({ op: 'remove', path: ['b'] });
    expect(Object.keys(ops[0]).sort()).toEqual(['op', 'path']);
  });

  it('listAdd op has {op:"listAdd", path, id, index, value}', () => {
    const ops = diff(
      { list: [{ id: 'a', title: 'x' }] },
      { list: [{ id: 'a', title: 'x' }, { id: 'b', title: 'y' }] },
    );
    const addOp = ops.find((o) => o.op === 'listAdd');
    expect(addOp).toEqual({ op: 'listAdd', path: ['list'], id: 'b', index: 1, value: { id: 'b', title: 'y' } });
    expect(Object.keys(addOp).sort()).toEqual(['id', 'index', 'op', 'path', 'value']);
  });

  it('listReorder op has {op:"listReorder", path, ids}', () => {
    const ops = diff(
      { list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      { list: [{ id: 'c' }, { id: 'a' }, { id: 'b' }] },
    );
    const reorderOp = ops.find((o) => o.op === 'listReorder');
    expect(reorderOp).toEqual({ op: 'listReorder', path: ['list'], ids: ['c', 'a', 'b'] });
    expect(Object.keys(reorderOp).sort()).toEqual(['ids', 'op', 'path']);
  });
});

// 16. Idempotency / stability --------------------------------------------------

describe('idempotency / stability', () => {
  it('diff(x, x) always produces empty ops', () => {
    const obj = { a: 1, b: [1, 2, 3], c: { d: { e: 'hi' } } };
    expect(diff(deepClone(obj), deepClone(obj))).toHaveLength(0);
  });

  it('applyPatch(deepClone(x), diff(x, x)) returns {data: x, skipped: 0}', () => {
    const x = { a: 1, b: [{ id: 'i1', title: 't' }] };
    const ops = diff(deepClone(x), deepClone(x));
    const result = applyPatch(deepClone(x), ops);
    expect(result.data).toEqual(x);
    expect(result.skipped).toBe(0);
  });

  it('applying empty ops leaves the original doc unchanged', () => {
    const doc = { a: 1, b: [1, 2], c: { d: 'deep' } };
    const snapshot = deepClone(doc);
    applyPatch(doc, []);
    expect(doc).toEqual(snapshot);
  });

  it('identical diffs are stable across repeated invocations', () => {
    const a = { items: [{ id: 'x', v: 1 }, { id: 'y', v: 2 }] };
    const b = { items: [{ id: 'y', v: 2 }, { id: 'x', v: 99 }] };
    const ops1 = diff(deepClone(a), b);
    const ops2 = diff(deepClone(a), b);
    expect(ops1).toEqual(ops2);
  });
});
