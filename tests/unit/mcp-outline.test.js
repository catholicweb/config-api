import { describe, it, expect } from 'vitest';
import { outline } from '../../src/mcp-schema.js';

// get_schema returns an outline for big nodes. Field descriptions carry the
// editor's long-form `help`, so the outline must keep them visible (briefly)
// instead of dropping them, and say when one was cut.
describe('outline descriptions', () => {
  const long = 'Paso 1. '.repeat(100);
  const node = {
    type: 'object',
    properties: {
      title: { type: 'string', title: 'Título', description: 'Short note.' },
      body: { type: 'string', title: 'Cuerpo', description: long },
      plain: { type: 'string' },
    },
    allOf: [{ if: { properties: { type: { const: 'text' } } }, then: { title: 'Texto', description: long } }],
  };
  const out = outline(node);

  it('keeps short property descriptions whole and truncates long ones', () => {
    expect(out.properties.title.description).toBe('Short note.');
    expect(out.properties.body.description.length).toBeLessThan(long.length);
    expect(out.properties.body.description.startsWith('Paso 1. Paso 1.')).toBe(true);
    expect(out.properties.body.description).toMatch(/\[truncated\]$/);
    expect(out.properties.plain.description).toBeUndefined();
  });

  it('applies the same limit to block variants', () => {
    expect(out.variants[0]).toMatchObject({ name: 'text', title: 'Texto' });
    expect(out.variants[0].description).toMatch(/\[truncated\]$/);
  });

  it('keeps the outlined node\'s own description in full and explains truncation', () => {
    expect(outline({ ...node, description: long }).description).toBe(long);
    expect(out.hint).toContain('[truncated]');
  });
});
