#!/usr/bin/env node
/**
 * Diagnose why some `*.parroquia.app` sites serve Cloudflare Error 1014
 * ("CNAME Cross-User Banned") while others work. Error 1014 appears when a custom
 * domain's CNAME points at a `{slug}.pages.dev` hostname that has no active
 * production deployment (or lives on a different account), so Cloudflare cannot
 * validate the domain.
 *
 * READ-ONLY: this script only issues GET requests against the Cloudflare API.
 * It never creates, modifies, or deletes anything.
 *
 * Env vars required (same as the worker):
 *   CLOUDFLARE_API_TOKEN   - token with Zone.DNS:Read + Account.Pages:Read
 *   CLOUDFLARE_ACCOUNT_ID  - Cloudflare account ID (Pages projects)
 *   CLOUDFLARE_ZONE_ID     - zone ID for parroquia.app
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_ZONE_ID=... \
 *     node diag-sites.mjs [slug1 slug2 ...]
 *   (defaults to: 47herri plantilla base)
 */

const TOKEN = process.env.CLOUDFLARE_API_TOKEN?.trim();
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const ZONE_ID = process.env.CLOUDFLARE_ZONE_ID?.trim();

if (!TOKEN || !ACCOUNT_ID || !ZONE_ID) {
  console.error('Missing required env vars: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID');
  process.exit(1);
}

const SLUGS = process.argv.slice(2).length ? process.argv.slice(2) : ['47herri', 'plantilla', 'base'];
const API = 'https://api.cloudflare.com/client/v4';

async function cfGet(path) {
  const url = `${API}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  });
  let json;
  try {
    json = await res.json();
  } catch {
    return { ok: false, status: res.status, error: `non-JSON response (HTTP ${res.status})` };
  }
  if (!json.success) {
    return {
      ok: false,
      status: res.status,
      error: json.errors?.[0]?.message ?? `API error ${res.status}`,
      code: json.errors?.[0]?.code,
    };
  }
  return { ok: true, result: json.result };
}

/** Fetch the first page; Pages deployments list is per_page-paginated. */
async function cfGetPage(path, perPage = 5) {
  const sep = path.includes('?') ? '&' : '?';
  return cfGet(`${path}${sep}per_page=${perPage}`);
}

async function main() {
  // 0. Verify the zone's owner account matches the configured account.
  const zone = await cfGet(`/zones/${ZONE_ID}`);
  const acct = await cfGet(`/accounts/${ACCOUNT_ID}`);
  console.log('=== Environment ===');
  console.log(`Zone ${zone.ok ? zone.result.name : '?'} -> owner account id: ${zone.ok ? zone.result.account?.id : '(unable to read zone)'}`);
  console.log(`Account id -> ${acct.ok ? acct.result.name : '(unable to read account)'}`);
  const sameAccount = zone.ok && zone.result.account?.id === ACCOUNT_ID;
  console.log(`Zone owner === configured ACCOUNT_ID? ${sameAccount ? 'YES' : 'NO  <-- cross-account risk'}`);
  console.log();

  for (const slug of SLUGS) {
    console.log(`===== ${slug}.parroquia.app =====`);

    // 1. Pages project existence + subdomain.
    const proj = await cfGet(`/accounts/${ACCOUNT_ID}/pages/projects/${slug}`);
    if (!proj.ok) {
      console.log(`  Pages project "${slug}": NOT FOUND under this account (${proj.error})`);
      console.log('    -> CNAME target {slug}.pages.dev cannot be validated -> Error 1014');
    } else {
      const p = proj.result;
      console.log(`  Pages project "${slug}": EXISTS`);
      console.log(`    subdomain: ${p.subdomain ?? '(none)'}`);
      console.log(`    production branch: ${p.production_branch ?? '(none)'}`);
      const latest = p.latest_deployment;
      if (latest) {
        console.log(`    latest deployment: env=${latest.environment} stage=${latest.latest_stage?.status} id=${latest.id?.slice(0, 8)}`);
      } else {
        console.log('    latest deployment: NONE  <-- project exists but never deployed -> pages.dev inactive -> Error 1014');
      }
    }

    // 2. Deployments (authoritative: is there a successful production deploy?).
    const deploys = await cfGetPage(`/accounts/${ACCOUNT_ID}/pages/projects/${slug}/deployments`);
    if (deploys.ok) {
      const list = deploys.result || [];
      if (list.length === 0) {
        console.log('  deployments: NONE  <-- no production deployment -> pages.dev not serving (1014)');
      } else {
        const prod = list
          .filter((d) => d.environment === 'production')
          .map((d) => `${d.latest_stage?.status ?? '?'}@${(d.created_on ?? '').slice(0, 10)}`);
        const last = list[0];
        console.log(`  deployments (newest first): total=${list.length} newest=${last.environment}/${last.latest_stage?.status ?? '?'}`);
        if (prod.length) console.log(`    production deploys: ${prod.join(', ')}`);
        else console.log('    production deploys: NONE  <-- never a successful production deploy -> 1014');
      }
    } else {
      console.log(`  deployments: unable to read (${deploys.error})`);
    }

    // 3. Custom-domain attach status on the Pages project.
    const fqdn = `${slug}.parroquia.app`;
    const domains = await cfGet(`/accounts/${ACCOUNT_ID}/pages/projects/${slug}/domains`);
    if (domains.ok) {
      const mine = (domains.result || []).find((d) => d.name === fqdn);
      if (mine) {
        console.log(`  custom domain "${fqdn}": status=${mine.status}` +
          (mine.status === 'active' ? '' : '  <-- not active, site will 1014'));
        if (mine.validation_data) {
          console.log(`    validation: ${JSON.stringify(mine.validation_data)}`);
        }
      } else {
        console.log(`  custom domain "${fqdn}": NOT ATTACHED to this Pages project  <-- 1014`);
      }
    } else {
      console.log(`  custom domains: unable to read (${domains.error})`);
    }

    // 4. Zone DNS records for this hostname.
    const dns = await cfGet(`/zones/${ZONE_ID}/dns_records?name=${encodeURIComponent(fqdn)}`);
    if (dns.ok) {
      const recs = dns.result || [];
      if (recs.length === 0) {
        console.log('  zone DNS records: NONE  <-- no record for hostname');
      } else {
        for (const r of recs) {
          console.log(`  zone DNS: type=${r.type} name=${r.name} content=${r.content} proxied=${r.proxied ?? false} ttl=${r.ttl}`);
        }
      }
    } else {
      console.log(`  zone DNS: unable to read (${dns.error})`);
    }

    console.log();
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
