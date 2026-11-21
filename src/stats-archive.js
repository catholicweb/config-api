/**
 * Long-term archive of the site traffic numbers, kept as small AGGREGATES in the
 * private D1 database (binding REGDB), because the free Cloudflare plan only serves
 * about one month of Web Analytics data.
 *
 *   site_stats_daily    one row per site and day: views + visits
 *   site_stats_monthly  per site and month: the top entries of each breakdown
 *                       (kind = page | refcat | refhost | country | device), summed day by day
 *   site_stats_meta     bookkeeping (first_day, last_day, last_dims_day, dims_first_day)
 *
 * The tables are created on first use (like registration_subscribers), so no migration
 * has to be applied by hand. Monthly breakdowns are approximate: each day only
 * contributes its top entries, and every (site, month, kind) is cut to the top KEEP.
 * Nothing here talks to Cloudflare; src/site-stats.js feeds it and reads it back.
 */

const DAY = 86400000;
const CHUNK = 200; // rows per statement (one JSON parameter, json_each)
export const KEEP = 25;

const TABLES = [
  `CREATE TABLE IF NOT EXISTS site_stats_daily (
    slug TEXT NOT NULL, day TEXT NOT NULL, views INTEGER NOT NULL, visits INTEGER NOT NULL,
    PRIMARY KEY (slug, day))`,
  `CREATE TABLE IF NOT EXISTS site_stats_monthly (
    slug TEXT NOT NULL, month TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, views INTEGER NOT NULL,
    PRIMARY KEY (slug, month, kind, key))`,
  `CREATE TABLE IF NOT EXISTS site_stats_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
];

const ready = new WeakSet();

export async function ensureArchive(db) {
  if (ready.has(db)) return;
  for (const sql of TABLES) await db.prepare(sql).run();
  ready.add(db);
}

async function runAll(db, stmts) {
  if (!stmts.length) return;
  if (typeof db.batch === 'function') await db.batch(stmts);
  else for (const s of stmts) await s.run();
}

function chunks(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(JSON.stringify(rows.slice(i, i + CHUNK)));
  return out;
}

/** rows: [{ slug, day: 'YYYY-MM-DD', views, visits }]. Re-saving a day replaces it. */
export async function saveDaily(db, rows) {
  await ensureArchive(db);
  const sql = `INSERT OR REPLACE INTO site_stats_daily (slug, day, views, visits)
    SELECT json_extract(value, '$.slug'), json_extract(value, '$.day'), json_extract(value, '$.views'), json_extract(value, '$.visits') FROM json_each(?)`;
  await runAll(db, chunks(rows).map((json) => db.prepare(sql).bind(json)));
}

/** Daily rows with startDay <= day < endDay (ISO dates), all sites. */
export async function loadDaily(db, startDay, endDay) {
  await ensureArchive(db);
  const r = await db.prepare('SELECT slug, day, views, visits FROM site_stats_daily WHERE day >= ? AND day < ?').bind(startDay, endDay).all();
  return r.results || [];
}

/** items: [{ slug, kind, key, views }] of one month ('YYYY-MM'); adds to what is stored, then keeps the top `keep` per site and kind. */
export async function addMonthly(db, month, items, keep = KEEP) {
  await ensureArchive(db);
  const upsert = `INSERT INTO site_stats_monthly (slug, month, kind, key, views)
    SELECT json_extract(value, '$.slug'), ?, json_extract(value, '$.kind'), json_extract(value, '$.key'), json_extract(value, '$.views') FROM json_each(?) WHERE true
    ON CONFLICT (slug, month, kind, key) DO UPDATE SET views = views + excluded.views`;
  const prune = `DELETE FROM site_stats_monthly WHERE month = ? AND rowid IN (
    SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (PARTITION BY slug, kind ORDER BY views DESC) AS rn FROM site_stats_monthly WHERE month = ?) WHERE rn > ?)`;
  const stmts = chunks(items).map((json) => db.prepare(upsert).bind(month, json));
  stmts.push(db.prepare(prune).bind(month, month, keep));
  await runAll(db, stmts);
}

export async function loadMonthly(db, month) {
  await ensureArchive(db);
  const r = await db.prepare('SELECT slug, kind, key, views FROM site_stats_monthly WHERE month = ?').bind(month).all();
  return r.results || [];
}

export async function getMeta(db, k) {
  await ensureArchive(db);
  const r = await db.prepare('SELECT v FROM site_stats_meta WHERE k = ?').bind(k).first();
  return r?.v ?? null;
}

export async function setMeta(db, k, v, { ifAbsent = false } = {}) {
  await ensureArchive(db);
  await db.prepare(`INSERT OR ${ifAbsent ? 'IGNORE' : 'REPLACE'} INTO site_stats_meta (k, v) VALUES (?, ?)`).bind(k, v).run();
}

/** Drop aggregates older than `days` (default ~2 years + a bit). */
export async function purgeOld(db, now = new Date(), days = 800) {
  await ensureArchive(db);
  const cutoff = new Date(now.getTime() - days * DAY).toISOString().slice(0, 10);
  await db.prepare('DELETE FROM site_stats_daily WHERE day < ?').bind(cutoff).run();
  await db.prepare('DELETE FROM site_stats_monthly WHERE month < ?').bind(cutoff.slice(0, 7)).run();
}
