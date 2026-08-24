// Unit tests for utils.js — ported from web-template/tests/unit/utils.test.js.
//
// config-api's src/utils.js is a copy of web-template/docs/.vitepress/utils.js
// (see src/utils.js header and src/notifications.js which imports from it).
// The import path is the only difference from the original test file.

import { describe, it, expect, vi } from 'vitest';
import {
  slugify,
  applyComplexFilter,
  groupEvents,
  assembleOrder,
  formatDate,
  getCode,
  toArray,
  formatWeekdays,
  grid,
  getSectionClasses,
} from '../../src/utils.js';

describe('slugify', () => {
  it('lowercases and joins words with dashes', () => {
    expect(slugify('Hola Mundo')).toBe('hola-mundo');
  });

  it('strips diacritics', () => {
    expect(slugify('Campaña de restauración')).toBe('campana-de-restauracion');
  });

  it('returns empty string for empty input', () => {
    expect(slugify('')).toBe('');
  });

  it('falls back to a hash when no slug-safe chars remain', () => {
    const slug = slugify('???');
    expect(slug).toBeTruthy();
    expect(slug).toMatch(/^[a-z0-9]+$/);
  });

  it('trims surrounding whitespace and dedupes separators', () => {
    expect(slugify('  Hola   Mundo  ')).toBe('hola-mundo');
  });
});

describe('applyComplexFilter', () => {
  const obj = { title: 'Misa', location: 'Iglesia', notes: 'cada semana' };

  it('returns true when filter is empty', () => {
    expect(applyComplexFilter(obj, '')).toBe(true);
    expect(applyComplexFilter(obj, undefined)).toBe(true);
  });

  it('matches a plain term contained in the serialized object', () => {
    expect(applyComplexFilter(obj, 'Misa')).toBe(true);
    expect(applyComplexFilter(obj, 'NoExiste')).toBe(false);
  });

  it('AND: every term must match', () => {
    expect(applyComplexFilter(obj, 'Misa&Iglesia')).toBe(true);
    expect(applyComplexFilter(obj, 'Misa&NoExiste')).toBe(false);
  });

  it('OR: any term may match', () => {
    expect(applyComplexFilter(obj, 'Misa|NoExiste')).toBe(true);
    expect(applyComplexFilter(obj, 'NoExiste1|NoExiste2')).toBe(false);
  });

  it('negation inverts a term', () => {
    expect(applyComplexFilter(obj, '!NoExiste')).toBe(true);
    expect(applyComplexFilter(obj, '!Misa')).toBe(false);
  });
});

describe('groupEvents', () => {
  const events = [
    { title: 'Misa', times: ['10:00'], locations: ['Iglesia'] },
    { title: 'Misa', times: ['12:00'], locations: ['Iglesia'] },
    { title: 'Encuentro', times: ['18:00'], locations: ['Salon'] },
  ];

  it('returns events unchanged when no fields are given', () => {
    expect(groupEvents(events, [])).toEqual(events);
  });

  it('builds a nested key structure grouped by successive fields', () => {
    const grouped = groupEvents(events, ['title', 'locations']);
    expect(Object.keys(grouped).sort()).toEqual(['Encuentro', 'Misa']);
    expect(Object.keys(grouped.Misa)).toEqual(['Iglesia']);
    expect(Object.keys(grouped.Encuentro)).toEqual(['Salon']);
  });

  it('handles empty event lists', () => {
    expect(groupEvents([], ['title'])).toEqual({});
  });
});

describe('assembleOrder', () => {
  it('assembles all 5 fields in level order', () => {
    const section = {
      orderTabla: 'dates',
      orderFila: 'times',
      orderColumna: 'locations',
      orderSubfila: 'byday',
      orderNotas: 'notes',
    };
    expect(assembleOrder(section)).toEqual(['dates', 'times', 'locations', 'byday', 'notes']);
  });

  it("preserves positional integrity — unset levels become 'empty' sentinel", () => {
    const section = {
      orderTabla: 'dates',
      orderFila: null,
      orderColumna: 'locations',
      orderSubfila: undefined,
      orderNotas: '',
    };
    expect(assembleOrder(section)).toEqual(['dates', 'empty', 'locations', 'empty', 'empty']);
  });

  it("keeps the 'empty' sentinel when explicitly selected", () => {
    const section = {
      orderTabla: 'empty',
      orderFila: 'times',
      orderColumna: 'empty',
    };
    expect(assembleOrder(section)).toEqual(['empty', 'times', 'empty', 'empty', 'empty']);
  });

  it('always returns 5 elements when any field is set', () => {
    const section = { orderTabla: 'dates' };
    expect(assembleOrder(section)).toEqual(['dates', 'empty', 'empty', 'empty', 'empty']);
  });

  it('falls back to the legacy order array when new fields are absent', () => {
    const section = { order: ['dates', 'times'] };
    expect(assembleOrder(section)).toEqual(['dates', 'times']);
  });

  it('prefers the new 5-field format when both new and legacy are present', () => {
    const section = {
      order: ['dates', 'times'],
      orderTabla: 'title',
      orderFila: 'locations',
    };
    expect(assembleOrder(section)).toEqual(['title', 'locations', 'empty', 'empty', 'empty']);
  });

  it('falls back to the default when neither new nor legacy fields exist', () => {
    expect(assembleOrder({})).toEqual(['type', 'times']);
  });

  it('falls back to the default when the legacy order array is empty', () => {
    expect(assembleOrder({ order: [] })).toEqual(['type', 'times']);
  });
});

describe('formatDate', () => {
  it('formats a Spanish date with month name', () => {
    expect(formatDate('25/12/2099', 'Español:es')).toBe('25 Diciembre');
  });

  it('formats a future-year Basque date with leading month', () => {
    expect(formatDate('25/12/2099', 'Euskara:eu')).toBe('Abenduak 25');
  });

  it('appends the year for a past date', () => {
    expect(formatDate('25/12/2020', 'Español:es')).toBe('25 Diciembre (2020)');
  });

  it('returns empty string for non-string input', () => {
    expect(formatDate(123, 'Español:es')).toBe('');
  });

  it('returns the input unchanged when lang is not a string', () => {
    expect(formatDate('25/12/2099', 5)).toBe('25/12/2099');
  });
});

describe('getCode', () => {
  it('extracts the code after the colon', () => {
    expect(getCode('Español:es')).toBe('es');
    expect(getCode('Euskara:eu')).toBe('eu');
  });

  it('falls back to the first two lowercase letters', () => {
    expect(getCode('es')).toBe('es');
    expect(getCode('Español')).toBe('es');
  });
});

describe('toArray', () => {
  it('returns non-empty arrays as-is', () => {
    expect(toArray(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('returns empty array for an empty array', () => {
    expect(toArray([])).toEqual([]);
  });

  it('wraps a string in an array', () => {
    expect(toArray('x')).toEqual(['x']);
  });

  it('returns empty array for non-array non-string values', () => {
    expect(toArray(5)).toEqual([]);
    expect(toArray(null)).toEqual([]);
    expect(toArray(undefined)).toEqual([]);
  });
});

describe('formatWeekdays', () => {
  it('sorts days into week order', () => {
    expect(formatWeekdays(['FR', 'SA'])).toEqual(['FR', 'SA']);
    expect(formatWeekdays(['SU', 'MO'])).toEqual(['MO', 'SU']);
  });

  it('consolidates a full MO-FRI run into a single token', () => {
    expect(formatWeekdays(['FR', 'MO', 'TU', 'WE', 'TH'])).toEqual(['MO,TU,WE,TH,FR']);
  });

  it('keeps weekend days separate after an MO-FR consolidation', () => {
    expect(formatWeekdays(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'])).toEqual([
      'MO,TU,WE,TH,FR',
      'SA',
      'SU',
    ]);
  });
});

describe('grid', () => {
  const base = 'container mx-auto flex';

  it('defaults to vertical direction and medium size', () => {
    const cls = grid({ tags: [], elements: [1, 2] });
    expect(cls).toBe(`${base} flex-wrap justify-center text-center py-4 *:w-full *:sm:w-1/2 *:md:w-1/3 *:p-2 px-2`);
  });

  it('defaults to large size when a single element', () => {
    const cls = grid({ tags: [], elements: [1] });
    expect(cls).toContain('*:w-full *:sm:w-2/3');
    expect(cls).toContain('py-4');
  });

  it('defaults to medium size when no elements', () => {
    const cls = grid({ tags: [] });
    expect(cls).toContain('*:w-full *:sm:w-1/2 *:md:w-1/3');
  });

  // --- Existing size tags (regression coverage) ---
  it('applies tiny size', () => {
    const cls = grid({ tags: ['tiny'], elements: [1, 2, 3] });
    expect(cls).toContain('*:w-1/3');
    expect(cls).toContain('*:sm:w-1/4');
    expect(cls).toContain('*:md:w-1/5');
    expect(cls).toContain('*:p-1');
    expect(cls).toContain('py-4');
  });

  it('applies small size', () => {
    const cls = grid({ tags: ['small'], elements: [1, 2, 3] });
    expect(cls).toContain('*:w-1/2 *:md:w-1/3 *:lg:w-1/4');
  });

  it('applies medium size explicitly', () => {
    const cls = grid({ tags: ['medium'], elements: [1, 2] });
    expect(cls).toContain('*:w-full *:sm:w-1/2 *:md:w-1/3');
  });

  it('applies large size', () => {
    const cls = grid({ tags: ['large'], elements: [1, 2] });
    expect(cls).toContain('*:w-full *:sm:w-2/3');
  });

  // --- New size tags ---
  it('applies xs size (extra-small items)', () => {
    const cls = grid({ tags: ['xs'], elements: [1, 2, 3] });
    expect(cls).toContain('*:w-1/2');
    expect(cls).toContain('*:sm:w-1/3');
    expect(cls).toContain('*:md:w-1/6');
    expect(cls).toContain('*:p-1');
    expect(cls).toContain('py-2');
  });

  it('applies xl size (extra-large items)', () => {
    const cls = grid({ tags: ['xl'], elements: [1, 2] });
    expect(cls).toContain('*:w-full *:md:w-5/6');
  });

  // --- Existing direction tags (regression coverage) ---
  it('applies horizontal direction', () => {
    const cls = grid({ tags: ['horizontal'], elements: [1, 2] });
    expect(cls).toContain('flex-nowrap overflow-x-scroll');
  });

  it('applies vertical direction', () => {
    const cls = grid({ tags: ['vertical'], elements: [1, 2] });
    expect(cls).toContain('flex-wrap justify-center text-center');
  });

  // --- New spacing modifiers ---
  it('applies dense (tighter gaps)', () => {
    const cls = grid({ tags: ['dense'], elements: [1, 2] });
    expect(cls).toContain('gap-1');
  });

  it('applies spacious (wider gaps)', () => {
    const cls = grid({ tags: ['spacious'], elements: [1, 2] });
    expect(cls).toContain('gap-6');
  });

  // --- New visual modifiers ---
  it('applies cards (shadow + rounded + white bg on items)', () => {
    const cls = grid({ tags: ['cards'], elements: [1, 2] });
    expect(cls).toContain('*:shadow-sm');
    expect(cls).toContain('*:rounded-xl');
    expect(cls).toContain('*:bg-white');
  });

  it('applies bordered (border on items)', () => {
    const cls = grid({ tags: ['bordered'], elements: [1, 2] });
    expect(cls).toContain('*:border');
    expect(cls).toContain('*:border-gray-200');
  });

  it('applies flat (removes shadows on items)', () => {
    const cls = grid({ tags: ['flat'], elements: [1, 2] });
    expect(cls).toContain('*:shadow-none');
  });

  // --- New masonry layout ---
  it('returns masonry columns layout when masonry tag is present', () => {
    const cls = grid({ tags: ['masonry'], elements: [1, 2, 3] });
    expect(cls).toContain('columns-1 sm:columns-2 md:columns-3');
    expect(cls).toContain('*:break-inside-avoid');
    expect(cls).not.toContain('flex');
  });

  it('masonry takes priority over other tags', () => {
    const cls = grid({ tags: ['masonry', 'horizontal', 'tiny', 'dense'], elements: [1, 2] });
    expect(cls).toContain('columns-1 sm:columns-2 md:columns-3');
    expect(cls).not.toContain('flex');
    expect(cls).not.toContain('flex-nowrap');
  });

  // --- Combinations ---
  it('combines size, direction, and visual modifiers', () => {
    const cls = grid({ tags: ['small', 'horizontal', 'cards', 'dense'], elements: [1, 2, 3] });
    expect(cls).toContain('flex-nowrap overflow-x-scroll');
    expect(cls).toContain('*:w-1/2 *:md:w-1/3 *:lg:w-1/4');
    expect(cls).toContain('gap-1');
    expect(cls).toContain('*:shadow-sm');
  });

  it('trims trailing space when no modifiers are active', () => {
    const cls = grid({ tags: ['medium'], elements: [1, 2] });
    expect(cls).not.toMatch(/\s+$/);
  });
});

describe('getSectionClasses', () => {
  it('returns default classes with no tags', () => {
    expect(getSectionClasses([])).toEqual(['block', 'w-full']);
  });

  it('returns default classes when tags is undefined', () => {
    expect(getSectionClasses()).toEqual(['block', 'w-full']);
  });

  it('applies dark background + white text', () => {
    expect(getSectionClasses(['dark'])).toEqual([
      '[&_*]:text-white', 'bg-[#222831]', 'pt-4', 'block', 'w-full',
    ]);
  });

  it('applies twocols half-width layout', () => {
    expect(getSectionClasses(['twocols'])).toEqual([
      'w-full', 'md:w-1/2', 'flex-none', 'align-top', 'px-4', 'mx-auto',
    ]);
  });

  it('applies fullbleed (full width, no padding)', () => {
    expect(getSectionClasses(['fullbleed'])).toEqual([
      'w-full', 'px-0',
    ]);
  });

  it('fullbleed takes priority over twocols', () => {
    const cls = getSectionClasses(['twocols', 'fullbleed']);
    expect(cls).toContain('px-0');
    expect(cls).not.toContain('px-4');
    expect(cls).not.toContain('md:w-1/2');
  });

  it('applies narrow max-width', () => {
    expect(getSectionClasses(['narrow'])).toEqual([
      'block', 'w-full', 'max-w-3xl', 'mx-auto',
    ]);
  });

  it('combines dark + narrow', () => {
    const cls = getSectionClasses(['dark', 'narrow']);
    expect(cls).toEqual([
      '[&_*]:text-white', 'bg-[#222831]', 'pt-4',
      'block', 'w-full',
      'max-w-3xl', 'mx-auto',
    ]);
  });

  it('combines fullbleed + narrow', () => {
    const cls = getSectionClasses(['fullbleed', 'narrow']);
    expect(cls).toEqual([
      'w-full', 'px-0',
      'max-w-3xl', 'mx-auto',
    ]);
  });
});
