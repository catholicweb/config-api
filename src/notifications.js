// src/notifications.js
// Daily cron handler: for each site in slugs.json, fetch its calendar.json from
// the deployed Pages site, find tomorrow's events, and send an FCM topic
// message to /topics/<slug> via the FCM HTTP API using FCM_SERVER_KEY.
//
import {
  groupEvents,
  applyComplexFilter,
  slugify,
} from "./utils.js";  // COPIED from docs/.vitepress/utils.js — keep in sync

const FCM_SEND_URL = "https://fcm.googleapis.com/fcm/send";

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
  const serverKey = env.FCM_SERVER_KEY;
  if (!serverKey) {
    console.log("notifications: FCM_SERVER_KEY not set; nothing to do");
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
    await sendNotificationsForSite(env, serverKey, slug);
  }
}

async function sendNotificationsForSite(env, serverKey, slug) {
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

  // 4. Send FCM topic messages — same payload format as notify.js, but via
  //    FCM HTTP API (to: "/topics/<slug>") instead of firebase-admin (topic: slug)
  for (const title in grouped) {
    let body = "";
    let image = "";
    for (const times in grouped[title]) {
      body += times + " - " + Object.keys(grouped[title][times]).join(", ") + "\n";
      if (!image) image = Object.values(grouped[title][times])?.[0]?.images;
    }
    console.log(`notifications: ${slug} ${title} ${body} ${image}`);

    const message = {
      to: `/topics/${slug}`,
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
    };
    try {
      const res = await fetch(FCM_SEND_URL, {
        method: "POST",
        headers: {
          Authorization: `key=${serverKey}`,
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
