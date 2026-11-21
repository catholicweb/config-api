/**
 * Cloudflare Web Analytics (the "beacon") for every site hostname.
 *
 * The traffic reports (src/site-stats.js) only count what the beacon reports, so a
 * hostname without it silently shows zeros. `ensureBeacons` lists the account's Web
 * Analytics sites and creates the missing ones with auto-install, which Cloudflare
 * can only do for hostnames proxied in this account's zone (<slug>.parroquia.app).
 * A custom domain outside the zone can't be auto-installed: it is returned in
 * `external` (it needs the JS snippet in the site itself).
 *
 * Needs CLOUDFLARE_API_TOKEN with Account > Web Analytics: Edit. Imports nothing from
 * index.js so both index.js (site creation) and site-stats.js (daily cron) can use it.
 */

const API = 'https://api.cloudflare.com/client/v4';
export const ZONE_SUFFIX = '.parroquia.app';
const MAX_CREATE = 25; // per run: keeps one cron invocation well under the subrequest limits

async function rumFetch(env, path, init = {}) {
  const res = await fetch(`${API}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/rum/site_info${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    throw new Error(`Cloudflare Web Analytics ${res.status}: ${body?.errors?.[0]?.message || 'bad response'}`);
  }
  return body;
}

async function listRumSites(env) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const rows = (await rumFetch(env, `/list?per_page=100&page=${page}`)).result || [];
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

/** Hostnames that already have a Web Analytics site (explicit host or host rules). */
export function coveredHosts(rumSites) {
  const hosts = new Set();
  for (const s of rumSites || []) {
    if (typeof s.host === 'string') hosts.add(s.host.toLowerCase());
    for (const r of s.rules || []) if (typeof r.host === 'string') hosts.add(r.host.toLowerCase());
  }
  return hosts;
}

/**
 * @param {string[]} hosts
 * @returns {{ok:string[], created:string[], external:string[], failed:{host:string,error:string}[], pending:string[], skipped?:string}}
 * Throws when the list call fails (typically: the token lacks the permission).
 */
export async function ensureBeacons(env, hosts) {
  const res = { ok: [], created: [], external: [], failed: [], pending: [] };
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) return { ...res, skipped: 'not configured' };
  const covered = coveredHosts(await listRumSites(env));
  for (const raw of hosts) {
    const host = String(raw).toLowerCase();
    if (covered.has(host)) res.ok.push(host);
    else if (!host.endsWith(ZONE_SUFFIX)) res.external.push(host);
    else if (res.created.length + res.failed.length >= MAX_CREATE) res.pending.push(host);
    else {
      try {
        await rumFetch(env, '', { method: 'POST', body: JSON.stringify({ host, zone_tag: env.CLOUDFLARE_ZONE_ID, auto_install: true }) });
        res.created.push(host);
      } catch (e) {
        res.failed.push({ host, error: String(e?.message || e) });
      }
    }
  }
  return res;
}
