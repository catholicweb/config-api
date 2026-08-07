#!/usr/bin/env node
/**
 * Configure Cloudflare Cache Rules (http_request_cache_settings phase) for
 * a zone that serves multiple VitePress subdomains + one hashed-media
 * subdomain (data.parroquia.app).
 *
 * NOTE: for the R2-backed data.parroquia.app host these rules alone are NOT
 * enough — R2 custom domains only serve cacheable responses when the object
 * itself carries a Cache-Control header (set at write time in src/index.js via
 * httpMetadata.cacheControl, and re-stamped over existing objects by the admin
 * POST /sites/backfill-cache handler). The data.parroquia.app rule here is
 * belt-and-suspenders; the write-path metadata is the actual fix. The
 * *.parroquia.app rules tune the VitePress Pages sites (hashed assets immutable,
 * other files respect origin).
 *
 * WARNING: PUTting to the entrypoint REPLACES all rules currently in this
 * phase for the zone. Run with --dry-run first, or with --list to see what's
 * there today, before applying.
 *
 * Env vars required:
 *   CLOUDFLARE_API_TOKEN   - token with Zone > Cache Rules > Edit permission
 *                            (also needs Zone > Zone > Read to verify zone access)
 *   CLOUDFLARE_ZONE_ID     - zone ID for parroquia.app
 *
 * Usage:
 *   node set-cache-rules.mjs --list        # show current rules, no changes
 *   node set-cache-rules.mjs --dry-run      # print the payload, don't send it
 *   node set-cache-rules.mjs --apply        # actually write the rules
 */

const TOKEN = process.env.CLOUDFLARE_API_TOKEN?.trim();
const ZONE_ID = process.env.CLOUDFLARE_ZONE_ID?.trim();
const MEDIA_HOSTNAME = "data.parroquia.app";
const ONE_YEAR = 31536000; // Cloudflare's practical max useful TTL; hashed filenames mean you never need more than this

if (!TOKEN || !ZONE_ID) {
  console.error("Missing required env vars: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID");
  console.error("Make sure to export them before running, e.g.:");
  console.error("  export CLOUDFLARE_API_TOKEN=your_token_here");
  console.error("  export CLOUDFLARE_ZONE_ID=your_zone_id_here");
  process.exit(1);
}

const API_BASE = `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/rulesets/phases/http_request_cache_settings/entrypoint`;
const TIERED_CACHE_URL = `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/cache/tiered_cache_smart_topology_enable`;

async function cfFetch(method, body) {
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
  };
  // Only include body for non-GET requests
  if (body !== undefined && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(API_BASE, options);
  const json = await res.json();
  if (!json.success) {
    const errors = json.errors || [];
    console.error("Cloudflare API error:");

    for (const err of errors) {
      console.error(`  [${err.code}] ${err.message}`);
      // Provide helpful hints for common authentication errors
      if (err.code === 9109 || err.code === 2003 || err.code === 10000) {
        console.error("  Hint: Your token can access the zone but lacks Cache Rules permissions.");
        console.error("  Hint: Create an API token with these permissions at:");
        console.error("  Hint: https://dash.cloudflare.com/profile/api-tokens");
        console.error("  Hint:   - Zone > Cache Rules > Edit");
        console.error("  Hint:   - Zone > Zone > Read");
        console.error("  Hint:   - Zone > Cache Settings > Edit (for tiered cache)");
      }
    }

    if (errors.length === 0) {
      console.error(JSON.stringify(json, null, 2));
    }

    process.exit(1);
  }
  return json.result;
}

// ---- Rule definitions -----------------------------------------------------

const rules = [
  {
    ref: "media_hashed_long_ttl",
    description: "data.parroquia.app: all hashed media, cache forever",
    expression: `(http.host eq "${MEDIA_HOSTNAME}")`,
    action: "set_cache_settings",
    action_parameters: {
      cache: true,
      edge_ttl: {
        mode: "override_origin", // ignore whatever (or missing) cache-control the Worker sends
        default: ONE_YEAR,
      },
      browser_ttl: {
        mode: "override_origin",
        default: ONE_YEAR,
      },
    },
  },
  {
    ref: "site_assets_hashed_long_ttl",
    description: "Site subdomains: hashed build assets (/assets/*), cache forever",
    expression: `(http.host ne "${MEDIA_HOSTNAME}" and http.request.uri.path contains "/assets/")`,
    action: "set_cache_settings",
    action_parameters: {
      cache: true,
      edge_ttl: {
        mode: "override_origin",
        default: ONE_YEAR,
      },
      browser_ttl: {
        mode: "override_origin",
        default: ONE_YEAR,
      },
    },
  },
  {
    ref: "site_html_short_ttl",
    description: "Site subdomains: HTML (and everything outside /assets/) — respect origin, must revalidate",
    expression: `(http.host ne "${MEDIA_HOSTNAME}" and not http.request.uri.path contains "/assets/")`,
    action: "set_cache_settings",
    action_parameters: {
      cache: true,
      // For the VitePress Pages sites the origin already sends `max-age=0, must-revalidate`
      // on HTML, so respect_origin keeps new deploys visible instantly while still caching
      // at the edge for revalidation. Overriding the edge TTL would delay deploys.
      edge_ttl: {
        mode: "respect_origin",
      },
      browser_ttl: {
        mode: "respect_origin",
      },
    },
  },
];

async function enableSmartTieredCache() {
  const res = await fetch(TIERED_CACHE_URL, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ value: "on" }),
  });
  const json = await res.json();
  if (!json.success) {
    console.error("Failed to enable Smart Tiered Cache:", JSON.stringify(json.errors, null, 2));
    // Note: this requires a paid plan (Pro+) or Argo/Smart Shield subscription depending on
    // account setup — a permission/plan error here is common and not a script bug.
    return;
  }
  // The API returns { result: { id: "...", value: "on" } } on success
  console.log("Smart Tiered Cache enabled:", json.result?.value || "on");
}

// ---- CLI --------------------------------------------------------------

async function testTokenAccess() {
  console.log("Testing token access to zone...");
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    const json = await res.json();
    if (json.success) {
      console.log("✓ Token can access zone:", json.result.name);
      return true;
    } else {
      console.error("✗ Token cannot access zone:", JSON.stringify(json.errors, null, 2));
      return false;
    }
  } catch (err) {
    console.error("✗ Failed to test token:", err.message);
    return false;
  }
}

async function main() {
  const mode = process.argv[2];

  if (mode === "--test") {
    await testTokenAccess();
    return;
  }

  // Test access before proceeding with other operations
  const hasAccess = await testTokenAccess();
  if (!hasAccess) {
    console.error("\nToken access test failed. Check that:");
    console.error("  1. CLOUDFLARE_API_TOKEN is correct and not expired");
    console.error("  2. Token has 'Zone:Zone:Read' permission for this zone");
    console.error("  3. CLOUDFLARE_ZONE_ID is correct");
    process.exit(1);
  }

  if (mode === "--list") {
    const current = await cfFetch("GET");
    console.log(JSON.stringify(current.rules ?? [], null, 2));
  } else if (mode === "--dry-run") {
    console.log(JSON.stringify({ rules }, null, 2));
  } else if (mode === "--apply") {
    const result = await cfFetch("PUT", { rules });
    console.log("Applied cache rules. New ruleset:");
    console.log(JSON.stringify(result.rules, null, 2));
    await enableSmartTieredCache();
  } else if (mode === "--tiered-cache-only") {
    await enableSmartTieredCache();
  } else {
    console.log("Usage: node set-cache-rules.mjs [--test|--list|--dry-run|--apply|--tiered-cache-only]");
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err.message);
  process.exit(1);
});
