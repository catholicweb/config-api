#!/usr/bin/env node
/**
 * Configure Cloudflare Page Rules for caching (Free plan compatible).
 * Page Rules are limited to 3 on the Free plan.
 *
 * Env vars required:
 *   CLOUDFLARE_API_TOKEN   - token with Zone > Page Rules > Edit permission
 *   CLOUDFLARE_ZONE_ID     - zone ID for parroquia.app
 *
 * Usage:
 *   node set-page-rules.mjs --list        # show current rules
 *   node set-page-rules.mjs --dry-run     # print the payload
 *   node set-page-rules.mjs --apply       # actually create the rules
 */

const TOKEN = process.env.CLOUDFLARE_API_TOKEN?.trim();
const ZONE_ID = process.env.CLOUDFLARE_ZONE_ID?.trim();

if (!TOKEN || !ZONE_ID) {
  console.error("Missing required env vars: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID");
  process.exit(1);
}

const API_BASE = `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/pagerules`;

async function cfFetch(method, endpoint, body) {
  const url = endpoint ? `${API_BASE}/${endpoint}` : API_BASE;
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const json = await res.json();
  if (!json.success) {
    console.error("Cloudflare API error:", JSON.stringify(json.errors, null, 2));
    process.exit(1);
  }
  return json.result;
}

// ---- Page Rule definitions -----------------------------------------------------

const rules = [
  {
    targets: [
      {
        target: "url",
        constraint: {
          operator: "matches",
          value: "data.parroquia.app/*",
        },
      },
    ],
    actions: [
      { id: "cache_level", value: "cache_everything" },
    ],
    status: "active",
    priority: 1,
  },
  {
    targets: [
      {
        target: "url",
        constraint: {
          operator: "matches",
          value: "*parroquia.app/assets/*",
        },
      },
    ],
    actions: [
      { id: "cache_level", value: "cache_everything" },
    ],
    status: "active",
    priority: 2,
  },
];

// ---- CLI --------------------------------------------------------------

async function main() {
  const mode = process.argv[2];

  if (mode === "--list") {
    const current = await cfFetch("GET");
    console.log(JSON.stringify(current, null, 2));
  } else if (mode === "--dry-run") {
    console.log(JSON.stringify({ rules }, null, 2));
  } else if (mode === "--apply") {
    // Delete existing page rules first (optional - uncomment if needed)
    // const existing = await cfFetch("GET");
    // for (const rule of existing) {
    //   await cfFetch("DELETE", rule.id);
    //   console.log(`Deleted: ${rule.id}`);
    // }

    for (const rule of rules) {
      const result = await cfFetch("POST", null, rule);
      console.log(`Created rule: ${result.id}`);
    }
    console.log("Applied page rules. New rules:");
    const updated = await cfFetch("GET");
    console.log(JSON.stringify(updated, null, 2));
  } else {
    console.log("Usage: node set-page-rules.mjs [--list|--dry-run|--apply]");
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err.message);
  process.exit(1);
});
