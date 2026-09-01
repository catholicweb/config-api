// src/notifications.js
// Daily cron handler: for each site in slugs.json, fetch its calendar.json from
// the deployed Pages site, find tomorrow's events, and send an FCM topic
// message via the FCM HTTP v1 API using a Service Account JSON.
//
import {
  groupEvents,
  applyComplexFilter,
  slugify,
} from "./utils.js";  // COPIED from docs/.vitepress/utils.js — keep in sync

// --- OAuth 2.0 Token Helper for Cloudflare Workers (Web Crypto API) ---

export async function getGoogleAccessToken(serviceAccount) {
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = serviceAccount.private_key
    .replace(pemHeader, "")
    .replace(pemFooter, "")
    .replace(/\s+/g, "");

  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claimSet = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const encodeBase64Url = (str) =>
    btoa(str).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const unsignedToken = `${encodeBase64Url(JSON.stringify(header))}.${encodeBase64Url(JSON.stringify(claimSet))}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(unsignedToken)
  );

  const jwt = `${unsignedToken}.${encodeBase64Url(String.fromCharCode(...new Uint8Array(signature)))}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  const data = await res.json();
  return data.access_token;
}

// --- Copied verbatim from notify.js (small, self-contained helpers) ---

function isTomorrow(date) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  return new Date(date).toDateString() === tomorrow.toDateString();
}

function tomorrow_str() {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const basqueDays = [
    "Igandean", // Domingo
    "Astelehenean", // Lunes
    "Asteartean", // Martes
    "Asteazkenean", // Miércoles
    "Ostegunean", // Jueves
    "Ostiralean", // Viernes
    "Larunbatean", // Sábado
  ];
  return "(" + basqueDays[tomorrow.getDay()] + " " + tomorrow.getDate() + ")";
}

// --- Main entry point ---

export async function scheduled(env, ctx) {
  if (!env.FCM_SERVICE_ACCOUNT) {
    console.log("notifications: FCM_SERVICE_ACCOUNT not set; nothing to do");
    return;
  }

  let serviceAccount;
  let accessToken;
  try {
    serviceAccount = typeof env.FCM_SERVICE_ACCOUNT === "string" 
      ? JSON.parse(env.FCM_SERVICE_ACCOUNT) 
      : env.FCM_SERVICE_ACCOUNT;
    accessToken = await getGoogleAccessToken(serviceAccount);
  } catch (e) {
    console.error("notifications: failed to authenticate with Google:", e);
    return;
  }

  // 1. Read slugs from R2 slugs.json ({ slugs: [...] })
  let slugs = [];
  try {
    const obj = await env.CONTENT.get("slugs.json");
    if (obj) {
      const parsed = JSON.parse(await obj.text());
      slugs = parsed.slugs || [];
    }
  } catch (e) {
    console.error("notifications: failed to read slugs.json:", e);
    return;
  }

  for (const slug of slugs) {
    await sendNotificationsForSite(env, serviceAccount.project_id, accessToken, slug);
  }
}

async function sendNotificationsForSite(env, projectId, accessToken, slug) {
  // 2. Fetch the already-processed calendar.json from the deployed Pages site.
  //    The ?time= cache-buster bypasses Cloudflare CDN so the cron sees data
  //    as recent as the latest site build.
  const siteUrl = `https://${slug}.parroquia.app`;
  const calUrl = `${siteUrl}/calendar.json?time=${Date.now()}`;

  let calendar = [];
  try {
    const res = await fetch(calUrl);
    if (!res.ok) {
      console.log(`notifications: ${slug} calendar.json fetch failed (${res.status}); skipping`);
      return;
    }
    calendar = await res.json();
  } catch (e) {
    console.error(`notifications: ${slug} calendar.json error:`, e.message);
    return;
  }

  // 3. buildNotifications() — verbatim logic from notify.js, adapted for Worker
  const filtered = calendar.filter((event) =>
    applyComplexFilter(event, "byday:empty") && isTomorrow(event.dates[0])
  );
  let grouped = groupEvents(filtered, ["title", "times", "locations", "images"]);

  // Read config.json from R2 for siteurl (fallback to default Pages domain)
  let config = {};
  try {
    const cfgObj = await env.CONTENT.get(`${slug}/config.json`);
    if (cfgObj) config = JSON.parse(await cfgObj.text());
  } catch (e) {
    console.error(`notifications: ${slug} config.json read error:`, e.message);
  }
  const fullSiteUrl = config.dev?.siteurl || siteUrl;

  const fcmEndpoint = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

  // 4. Send FCM topic messages via FCM HTTP v1 API
  for (const title in grouped) {
    let body = "";
    let image = "";
    for (const times in grouped[title]) {
      body += times + " - " + Object.keys(grouped[title][times]).join(", ") + "\n";
      if (!image) image = Object.values(grouped[title][times])?.[0]?.images;
    }
    console.log(`notifications: ${slug} ${title} ${body} ${image}`);

    const message = {
      message: {
        topic: slug,
        notification: {
          title: title + " " + tomorrow_str(),
          body: body,
        },
        webpush: {
          headers: { TTL: "86400" },
          notification: {
            icon: image || "/icon-192.png",
            badge: "/icon-192.png",
            data: { url: "/#" + slugify(title) },
          },
          fcm_options: { link: fullSiteUrl + "/#" + slugify(title) },
        },
      },
    };

    try {
      const res = await fetch(fcmEndpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
      });
      console.log(`notifications: ${slug} → ${title} ${res.ok ? "sent" : res.status}`);
    } catch (e) {
      console.error(`notifications: FCM send failed for ${slug}:`, e);
    }
  }
}