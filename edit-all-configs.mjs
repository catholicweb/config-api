#!/usr/bin/env node
/**
 * Generic config.json replacer runner.
 *
 * Reads the list of site slugs from the public data origin
 * (https://data.parroquia.app/slugs.json) and applies a user-supplied
 * `replacer` function to each site's config.json, then writes back
 * via the admin-gated API.
 *
 * The replacer function takes the raw config.json file text as input and
 * returns the new file text. Edit it to perform your replacement
 * (e.g. a replaceAll on the raw string).
 *
 * Env:
 *   PARROQUIA_ADMIN_TOKEN  (required — admin token for PUT writes)
 *   CONFIG_API_BASE        (default https://api.parroquia.app)
 *   PARROQUIA_DATA_BASE    (default https://data.parroquia.app)
 *
 * Usage:
 *   PARROQUIA_ADMIN_TOKEN=xxx node migrate-uuid-to-id.mjs [--dry-run] [slug …]
 *     --dry-run   Print the per-slug report without writing anything
 *     slug …      Optional slugs to target (default: all from slugs.json)
 */

const ADMIN_TOKEN = process.env.PARROQUIA_ADMIN_TOKEN?.trim();
if (!ADMIN_TOKEN) {
  console.error("Missing required env var: PARROQUIA_ADMIN_TOKEN");
  process.exit(1);
}

const API_BASE = (process.env.CONFIG_API_BASE || "https://api.parroquia.app").replace(/\/+$/, "");
const DATA_BASE = (process.env.PARROQUIA_DATA_BASE || "https://data.parroquia.app").replace(/\/+$/, "");

// Flag to only show diffs without writing (parsed after slug args)
let DRY_RUN = false;
const args = process.argv.slice(2).filter((a) => {
  if (a === "--dry-run") { DRY_RUN = true; return false; }
  return true;
});
const targetSlugs = args; // empty = all

// ---- helpers ---------------------------------------------------------------

// ==== REPLACER ================================================================
// Transform the config.json file text -> new config.json file text.
// Edit this to perform your replacement (e.g. a replaceAll on the raw string).
function walk(obj) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    if (obj.type === 'gallery' && Object.prototype.hasOwnProperty.call(obj, 'list')) {
      obj.images = obj.list;
      delete obj.list;
    }
    for (const key of Object.keys(obj)) {
      walk(obj[key]);
    }
  } else if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      walk(obj[i]);
    }
  }
}

const replacer = (configText) => {
  try {
    const obj = JSON.parse(configText);
    walk(obj);
    return JSON.stringify(obj, null, 2);
  } catch {
    return configText;
  }
}
// ============================================================================

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.text();
  try {
    const json = JSON.parse(body);
    return { status: res.status, ok: res.ok, json, raw: body };
  } catch {
    return { status: res.status, ok: res.ok, json: null, raw: body };
  }
}

// ---- main ------------------------------------------------------------------

async function main() {
  // 1. Get all sites (or use the provided subset)
  let slugs;
  if (targetSlugs.length > 0) {
    slugs = targetSlugs;
    console.log(`Targeting ${slugs.length} slug(s) from CLI args.`);
  } else {
    console.log("Fetching slug list from data origin…");
    const slugsRes = await fetchJson(`${DATA_BASE}/slugs.json`, {
      headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
    });
    if (!slugsRes.ok || !Array.isArray(slugsRes.json?.slugs)) {
      console.error(`Failed to read slugs from ${DATA_BASE}/slugs.json (HTTP ${slugsRes.status})`);
      process.exit(1);
    }
    slugs = slugsRes.json.slugs.filter((s) => typeof s === "string");
    console.log(`Found ${slugs.length} site(s).`);
  }

  // 2. Process each slug
  let touched = 0;
  let skipped = 0;
  let errors = [];

  for (const slug of slugs) {
    process.stdout.write(`  ${slug}: `);

    // Fetch current config.json (bypass cache)
    const dataUrl = `${DATA_BASE}/${slug}/config.json`;
    const configRes = await fetchJson(dataUrl, {
      headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
    });

    if (!configRes.ok) {
      if (configRes.status === 404) {
        console.log("no config.json — skip");
        skipped++;
      } else {
        const msg = `HTTP ${configRes.status}`;
        console.log(`ERROR ${msg}`);
        errors.push({ slug, error: msg });
      }
      continue;
    }

    const raw = configRes.raw;
    if (!raw.trim()) {
      console.log("empty config.json — skip");
      skipped++;
      continue;
    }

    // Apply the replacer
    const newBody = replacer(raw);
    if (typeof newBody !== "string") {
      console.log("replacer did not return a string — skip");
      errors.push({ slug, error: "replacer did not return a string" });
      continue;
    }

    if (newBody === raw) {
      console.log("unchanged — skip");
      skipped++;
      continue;
    }

    const sizeKB = (newBody.length / 1024).toFixed(1);

    if (DRY_RUN) {
      console.log(`======= WOULD PUT (${sizeKB} KB) @ ${slug} =========`);
      console.log(newBody)
      touched++;
      continue;
    }

    // PUT the replaced config back
    const putRes = await fetchJson(`${API_BASE}/sites/${slug}/config.json`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: newBody,
    });

    if (putRes.ok) {
      console.log(`OK (${sizeKB} KB)`);
      touched++;
    } else {
      const msg = `PUT failed: HTTP ${putRes.status} — ${putRes.raw.slice(0, 200)}`;
      console.log(`ERROR ${msg}`);
      errors.push({ slug, error: msg });
    }
  }

  // 3. Summary
  console.log("\n── Summary ──");
  console.log(`  Touched:  ${touched}`);
  console.log(`  Skipped:  ${skipped}`);
  if (errors.length > 0) {
    console.log(`  Errors:   ${errors.length}`);
    for (const e of errors) {
      console.log(`    - ${e.slug}: ${e.error}`);
    }
  }
  if (DRY_RUN) {
    console.log("\n  (dry-run — no data was written)");
  }
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
