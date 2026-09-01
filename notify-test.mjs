// Simple helper: notify slug "test" via admin bearer token from env
// Usage: ADMIN_TOKEN=xxx node notify-test.mjs
const SLUG = 'test';
const URL = `https://api.parroquia.app/sites/${SLUG}/notify`;

const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) {
  console.error('Set ADMIN_TOKEN (raw admin token) in env');
  process.exit(1);
}

const payload = {
  notification: {
    title: 'Test notification',
    body: 'Sent from notify-test.mjs',
  },
};

fetch(URL, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${adminToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(payload),
}).then(async (r) => {
  const data = await r.json().catch(() => ({}));
  console.log(`status=${r.status}`, data);
}).catch((e) => console.error('fetch failed:', e));
