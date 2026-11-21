// Long-term aggregate archive (src/stats-archive.js) on a real SQL engine (node:sqlite).
import { describe, it, expect } from 'vitest';
import { makeD1 } from '../helpers/d1.js';
import { saveDaily, loadDaily, addMonthly, loadMonthly, getMeta, setMeta, purgeOld } from '../../src/stats-archive.js';

describe('stats archive', () => {
  it('stores daily totals, replaces a re-archived day and reads a window', async () => {
    const db = makeD1();
    await saveDaily(db, [
      { slug: 'a', day: '2026-10-01', views: 10, visits: 6 },
      { slug: 'a', day: '2026-10-02', views: 4, visits: 3 },
      { slug: 'b', day: '2026-10-01', views: 7, visits: 5 },
    ]);
    await saveDaily(db, [{ slug: 'a', day: '2026-10-02', views: 9, visits: 8 }]);
    const rows = await loadDaily(db, '2026-10-01', '2026-10-02');
    expect(rows.map((r) => `${r.slug}:${r.day}:${r.views}`).sort()).toEqual(['a:2026-10-01:10', 'b:2026-10-01:7']);
    const all = await loadDaily(db, '2026-10-01', '2026-11-01');
    expect(all.find((r) => r.slug === 'a' && r.day === '2026-10-02')).toMatchObject({ views: 9, visits: 8 });
  });

  it('accumulates monthly counts per day and keeps only the top entries', async () => {
    const db = makeD1();
    await addMonthly(db, '2026-10', [{ slug: 'a', kind: 'page', key: '/', views: 5 }, { slug: 'a', kind: 'page', key: '/misas', views: 3 }, { slug: 'a', kind: 'page', key: '/raro', views: 1 }], 2);
    await addMonthly(db, '2026-10', [{ slug: 'a', kind: 'page', key: '/', views: 4 }, { slug: 'a', kind: 'country', key: 'España', views: 9 }], 2);
    const rows = await loadMonthly(db, '2026-10');
    const pages = rows.filter((r) => r.kind === 'page').sort((x, y) => y.views - x.views);
    expect(pages).toEqual([{ slug: 'a', kind: 'page', key: '/', views: 9 }, { slug: 'a', kind: 'page', key: '/misas', views: 3 }]);
    expect(rows.find((r) => r.kind === 'country')).toMatchObject({ key: 'España', views: 9 });
    expect(await loadMonthly(db, '2026-09')).toEqual([]);
  });

  it('meta: ifAbsent keeps the first value; purge drops old aggregates', async () => {
    const db = makeD1();
    await setMeta(db, 'first_day', '2026-10-22', { ifAbsent: true });
    await setMeta(db, 'first_day', '2026-11-01', { ifAbsent: true });
    expect(await getMeta(db, 'first_day')).toBe('2026-10-22');
    await setMeta(db, 'last_day', '2026-11-20');
    await setMeta(db, 'last_day', '2026-11-21');
    expect(await getMeta(db, 'last_day')).toBe('2026-11-21');
    expect(await getMeta(db, 'nope')).toBeNull();

    await saveDaily(db, [{ slug: 'a', day: '2020-01-01', views: 1, visits: 1 }, { slug: 'a', day: '2026-11-01', views: 1, visits: 1 }]);
    await addMonthly(db, '2020-01', [{ slug: 'a', kind: 'page', key: '/', views: 1 }]);
    await purgeOld(db, new Date('2026-11-21T18:00:00Z'));
    expect((await loadDaily(db, '2000-01-01', '2100-01-01')).map((r) => r.day)).toEqual(['2026-11-01']);
    expect(await loadMonthly(db, '2020-01')).toEqual([]);
  });
});
