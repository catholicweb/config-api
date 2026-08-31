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
