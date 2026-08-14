#!/usr/bin/env node
/**
 * One-shot migration script to rename the item-identity key from `uuid`/`name`
 * to `id` in existing server config.json files.
 *
 * Background: the editor used to inject a hidden `uuid` field into every
 * repeatable object / block variant, and some schema components declared the
 * ident inline as `name` (double-key bug — items got both keys). The new
 * convention unifies under the key `id`.
 *
 * Algorithm:
 *   For every plain object encountered (recursive walk of arrays and objects):
 *     1. If `name` matches a valid UUID string → `id = name; delete name`.
 *        (A human-typed name is never a valid UUID, so this rule distinguishes
 *         uuid-idents from plain string names.)
 *     2. If `uuid` still exists → `id = uuid` (only if `id` not already set
 *        from step 1); then `delete uuid`.
 *     3. Recurse into every value.
 *
 * Idempotent: any config already using `id` is unchanged.
 *
 * Env:
 *   PARROQUIA_ADMIN_TOKEN  (required — admin token matching ADMIN_TOKEN_HASH)
 *   CONFIG_API_BASE        (default https://api.parroquia.app)
 *   PARROQUIA_DATA_BASE    (default https://data.parroquia.app)
 *
 * Usage:
 *   PARROQUIA_ADMIN_TOKEN=xxx node migrate-uuid-to-id.mjs [--dry-run] [slug …]
 *     --dry-run   Print the per-slug report without writing anything
 *     slug …      Optional slugs to target (default: all from GET /sites)
 */

const ADMIN_TOKEN = process.env.PARROQUIA_ADMIN_TOKEN?.trim();
if (!ADMIN_TOKEN) {
  console.error("Missing required env var: PARROQUIA_ADMIN_TOKEN");
  process.exit(1);
}

const API_BASE = (process.env.CONFIG_API_BASE || "https://api.parroquia.app").replace(/\/+$/, "");
const DATA_BASE = (process.env.PARROQUIA_DATA_BASE || "https://data.parroquia.app").replace(/\/+$/, "");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Flag to only show diffs without writing (parsed after slug args)
let DRY_RUN = false;
const args = process.argv.slice(2).filter((a) => {
  if (a === "--dry-run") { DRY_RUN = true; return false; }
  return true;
});
const targetSlugs = args; // empty = all

// ---- helpers ---------------------------------------------------------------

function isPlainObject(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function isUuidString(s) {
  return typeof s === "string" && UUID_RE.test(s);
}

/**
 * Recursively walk `obj` and rename `name`/`uuid` → `id` where applicable.
 * Returns `true` if any change was made.
 */
function migrateObj(obj) {
  if (!isPlainObject(obj)) return false;
  let changed = false;

  // Step 1: `name` that is a valid UUID → `id` wins
  if (Object.prototype.hasOwnProperty.call(obj, "name") && isUuidString(obj.name)) {
    obj.id = obj.name;
    delete obj.name;
    changed = true;
  }

  // Step 2: `uuid` → `id` (if not already set by step 1)
  if (Object.prototype.hasOwnProperty.call(obj, "uuid")) {
    if (!Object.prototype.hasOwnProperty.call(obj, "id")) {
      obj.id = obj.uuid;
    }
    delete obj.uuid;
    changed = true;
  }

  // Step 3: Recurse into every value
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (isPlainObject(val)) {
      if (migrateObj(val)) changed = true;
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (migrateObj(item)) changed = true;
      }
    }
  }

  return changed;
}

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
    console.log("Fetching site list from API…");
    const sitesRes = await fetchJson(`${API_BASE}/sites`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    if (!sitesRes.ok) {
      console.error(`Failed to list sites: ${sitesRes.status} — ${sitesRes.raw.slice(0, 200)}`);
      process.exit(1);
    }
    slugs = (sitesRes.json?.sites || [])
      .map((s) => (typeof s === "string" ? s : s.slug))
      .filter(Boolean);
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

    const config = configRes.json;
    if (!config) {
      console.log("empty or invalid JSON — skip");
      skipped++;
      continue;
    }

    // Apply the migration
    const changed = migrateObj(config);
    if (!changed) {
      console.log("unchanged — skip");
      skipped++;
      continue;
    }

    // Format the result (2-space indent, trailing newline)
    const newBody = JSON.stringify(config, null, 2) + "\n";
    const sizeKB = (newBody.length / 1024).toFixed(1);

    if (DRY_RUN) {
      console.log(`WOULD PUT (${sizeKB} KB)`);
      touched++;
      continue;
    }

    // PUT the migrated config back
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