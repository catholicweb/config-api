/**
 * Per-site branding for emails sent to a site's own visitors (e.g. the event
 * registration confirmation). Emails to editors/admins (magic links, organizer
 * notifications, stats) keep the plain "Parroquia App" branding.
 *
 * The branding is ALWAYS read server-side from the site's own `<slug>/config.json`
 * (`info.title`, `theme.accentHue`, `theme.icon`), never taken from the request:
 * the registration endpoint is open and mails an address chosen by the caller,
 * so caller-supplied branding would let anyone send arbitrary-looking mail from
 * our sending domain.
 */

const FALLBACK_HUE = 200; // same fallback as web-template's PWA icon tile
const NAME_MAX = 80;

export const DEFAULT_BRAND = Object.freeze({ name: 'Parroquia App', color: '#0066cc', iconUrl: null });

// Same maths as web-template's `oklchToHex` (docs/.vitepress/utils.js).
export function oklchToHex(l, c, h) {
  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const b = c * Math.sin(hRad);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ ** 3;
  const M = m_ ** 3;
  const S = s_ ** 3;
  const r = +4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S;
  const g = -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S;
  const bl = -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S;
  const gamma = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055);
  const toByte = (v) => Math.min(255, Math.max(0, Math.round(gamma(v) * 255)));
  return `#${[toByte(r), toByte(g), toByte(bl)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

function slugToTitle(slug) {
  return String(slug || '')
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

// Display name safe to use both in the HTML (escaped separately) and in a From header:
// no control characters (header injection), no address/quoting syntax.
export function cleanName(v) {
  return String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[<>"\\,;:@]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
}

// The editor stores an image as a URL string; tolerate a list or an { url } object.
function pickUrl(v) {
  if (Array.isArray(v)) return pickUrl(v[0]);
  if (v && typeof v === 'object') return pickUrl(v.url ?? v.src);
  return typeof v === 'string' ? v.trim() : '';
}

// Absolute https only, and not SVG (most mail clients, Gmail included, do not render it).
function iconUrlOf(cfg) {
  for (const raw of [pickUrl(cfg?.theme?.icon), pickUrl(cfg?.icon)]) {
    try {
      const u = new URL(raw);
      if (u.protocol === 'https:' && !/\.svgz?$/i.test(u.pathname)) return u.href;
    } catch {
      /* not a URL: try the next candidate */
    }
  }
  return null;
}

/** { name, color, iconUrl } for `slug` from its parsed config.json (null/undefined config is fine). */
export function siteBranding(cfg, slug) {
  const name = cleanName(cfg?.info?.title) || cleanName(slugToTitle(slug)) || DEFAULT_BRAND.name;
  const hue = Number(cfg?.theme?.accentHue);
  const h = Number.isFinite(hue) ? ((hue % 360) + 360) % 360 : FALLBACK_HUE;
  // Darker than the site's own accent (L 0.64) so white button text stays readable.
  return { name, color: oklchToHex(0.52, 0.17, h), iconUrl: iconUrlOf(cfg) };
}

/** From header: the site's name on our verified sending address (SPF/DKIM stay valid). */
export function brandedFrom(env, brand) {
  const configured = env.FROM_EMAIL || `${DEFAULT_BRAND.name} <no-reply@parroquia.app>`;
  const name = cleanName(brand?.name);
  if (!name) return configured;
  const m = /<([^>]+)>/.exec(configured);
  return `${name} <${(m ? m[1] : configured).trim()}>`;
}
