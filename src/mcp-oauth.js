// OAuth 2.1 (authorization code + PKCE) for the MCP endpoint, built on the
// Worker's EXISTING credential store: the access token minted here is a normal
// editor token (state.tokens[sha256(token)] -> { slug, email }), so every grant,
// revocation and per-slug check keeps working unchanged. The login step is the
// existing magic link: the user types an email, gets a link, clicks it, and
// approves the client on a consent page.
//
// Stateless pieces (client ids, in-flight request) are HMAC-signed with a key
// derived from AUTH_KEY. Authorization codes are single-use and live in
// state.oauth (a separate map, so /auth/magic can never redeem them).
import {
  readAuthState, writeAuthState, sha256Hex, generateToken, readJsonBody, validateEmail,
  normalizeEmail, base64ToBytes, bytesToBase64, timingSafeEqual, MAGIC_TTL_MS,
} from './index.js';

const CODE_TTL_MS = 60 * 1000;
const REQ_TTL_MS = 30 * 60 * 1000;

// ---- small utils -----------------------------------------------------------
const enc = new TextEncoder();
const b64u = (bytes) => bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => base64ToBytes(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function signingKey(env) {
  if (!env.AUTH_KEY) return null;
  let raw;
  try { raw = base64ToBytes(env.AUTH_KEY); } catch { return null; }
  if (raw.length !== 32) return null;
  const base = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sub = await crypto.subtle.sign('HMAC', base, enc.encode('mcp-oauth-signing-v1')); // domain separation from AES use
  return crypto.subtle.importKey('raw', sub, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function sign(env, payload) {
  const key = await signingKey(env);
  if (!key) return null;
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return `${body}.${b64u(new Uint8Array(sig))}`;
}
async function verify(env, token, type) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const key = await signingKey(env);
  if (!key) return null;
  const [body, sig] = token.split('.');
  try {
    if (!(await crypto.subtle.verify('HMAC', key, unb64u(sig), enc.encode(body)))) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64u(body)));
    if (p.t !== type) return null;
    if (typeof p.exp === 'number' && p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}

const CORS = { 'Access-Control-Allow-Origin': '*' };
const json = (obj, status = 200, extra = {}) =>
  Response.json(obj, { status, headers: { 'Cache-Control': 'no-store', ...CORS, ...extra } });
const oauthError = (error, description, status = 400) => json({ error, error_description: description }, status);
const page = (title, body, status = 200) =>
  new Response(
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;background:#f5f5f5;margin:0}main{max-width:460px;margin:8vh auto;background:#fff;border-radius:10px;padding:28px;box-shadow:0 1px 4px #0002}` +
      `h1{font-size:20px;margin:0 0 14px}p{line-height:1.5;color:#333}input[type=email]{width:100%;box-sizing:border-box;padding:10px;font-size:16px;margin:8px 0 14px}` +
      `button{font-size:16px;padding:10px 18px;border-radius:6px;border:0;background:#0066cc;color:#fff;cursor:pointer}button.sec{background:#e5e5e5;color:#222;margin-left:8px}` +
      `small{color:#777}</style></head><body><main>${body}</main></body></html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      },
    },
  );

// ---- discovery -------------------------------------------------------------
export function protectedResourceMetadata(origin) {
  return json({ resource: `${origin}/mcp`, authorization_servers: [origin], bearer_methods_supported: ['header'] });
}
export function authorizationServerMetadata(origin) {
  return json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
}

// ---- dynamic client registration (stateless) ---------------------------------
function okRedirectUri(u) {
  let url;
  try { url = new URL(u); } catch { return false; }
  if (url.hash) return false;
  if (['javascript:', 'data:', 'file:', 'vbscript:', 'blob:'].includes(url.protocol)) return false;
  if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return true; // https: and custom app schemes (cursor://, vscode://, ...)
}

export async function register(env, request) {
  const body = await readJsonBody(request);
  if (!body.ok) return oauthError('invalid_client_metadata', body.error);
  const uris = body.data.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5 || !uris.every((u) => typeof u === 'string' && okRedirectUri(u))) {
    return oauthError('invalid_redirect_uri', 'redirect_uris must be 1-5 https (or loopback http / app-scheme) URIs without fragments');
  }
  const name = typeof body.data.client_name === 'string' ? body.data.client_name.trim().slice(0, 80) : '';
  const clientId = await sign(env, { t: 'client', n: name || 'Cliente MCP', r: uris });
  if (!clientId) return oauthError('server_error', 'AUTH_KEY not configured', 503);
  return json({
    client_id: clientId, client_name: name || 'Cliente MCP', redirect_uris: uris,
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'],
  }, 201);
}

// ---- authorize: email form -> magic link -> consent -> code ---------------
async function readForm(request) {
  const ct = request.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) {
    const b = await readJsonBody(request);
    return b.ok ? b.data : {};
  }
  try { return Object.fromEntries(new URLSearchParams(await request.text())); } catch { return {}; }
}

export async function authorizeGet(env, request) {
  const q = new URL(request.url).searchParams;
  const client = await verify(env, q.get('client_id'), 'client');
  if (!client) return page('Error', '<h1>Cliente no válido</h1><p>El cliente MCP no está registrado.</p>', 400);

  const requestedRu = q.get('redirect_uri');
  
  // Helper to normalize URLs (ignore trailing slash differences)
  const norm = (u) => {
    try {
      const parsed = new URL(u);
      return parsed.origin + parsed.pathname.replace(/\/$/, '') + parsed.search;
    } catch {
      return u;
    }
  };

  // Find matching registered URI flexibly
  let ru = null;
  if (requestedRu) {
    const matched = client.r.find(r => r === requestedRu || norm(r) === norm(requestedRu));
    ru = matched || requestedRu; // fallback to requested if trusted domain structure
  } else if (client.r.length === 1) {
    ru = client.r[0];
  }

  // Validate against registered list with normalization
  const isValid = ru && client.r.some(r => r === ru || norm(r) === norm(ru));
  if (!isValid) {
    return page('Error', '<h1>redirect_uri no válida</h1><p>No coincide con la registrada.</p>', 400);
  }

  const redirectErr = (e, d) => redirectTo(ru, { error: e, error_description: d, state: q.get('state') });
  if (q.get('response_type') !== 'code') return redirectErr('unsupported_response_type', 'only response_type=code');
  if (!q.get('code_challenge') || (q.get('code_challenge_method') || 'plain') !== 'S256') {
    return redirectErr('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  }
  const req = await sign(env, {
    t: 'req', cid: client.n, client_id: q.get('client_id'), ru, cc: q.get('code_challenge'), st: q.get('state') || null,
    exp: Date.now() + REQ_TTL_MS,
  });
  return page('Conectar con Parroquia.app', emailForm(client.n, req));
}

function emailForm(clientName, req, note = '') {
  return `<h1>Conectar ${esc(clientName)} con Parroquia.app</h1>${note}` +
    `<p><b>${esc(clientName)}</b> quiere editar la configuración de tu web. Escribe el email con el que editas tu parroquia y te enviaremos un enlace de acceso.</p>` +
    `<form method="post" action="/oauth/authorize"><input type="hidden" name="req" value="${esc(req)}">` +
    `<label>Email<input type="email" name="email" required autofocus></label><button>Enviar enlace</button></form>` +
    `<p><small>Connect ${esc(clientName)} to Parroquia.app: enter your editor email to receive a login link.</small></p>`;
}

export async function authorizePost(env, request, deps) {
  const form = await readForm(request);
  const req = await verify(env, form.req, 'req');
  if (!req) return page('Error', '<h1>Solicitud caducada</h1><p>Vuelve a iniciar la conexión desde tu cliente.</p>', 400);
  const email = typeof form.email === 'string' ? form.email.trim() : '';
  if (!validateEmail(email)) {
    return page('Conectar', emailForm(req.cid, form.req, '<p style="color:#b00">Introduce un email válido.</p>'), 400);
  }
  const state = await readAuthState(env);
  if (!state) return page('Error', '<h1>Servicio no disponible</h1>', 503);
  const slugs = (state.emails[normalizeEmail(email)] || []).filter(Boolean);
  if (slugs.length > 0) {
    const code = generateToken();
    state.magic[await sha256Hex(code)] = { slug: slugs[0], email: normalizeEmail(email), exp: Date.now() + MAGIC_TTL_MS };
    const w = await writeAuthState(env, state);
    if (w.ok) {
      const link = `${new URL(request.url).origin}/oauth/confirm?code=${code}&req=${encodeURIComponent(form.req)}`;
      const sent = await (deps?.sendEmail || sendEmail)(env, email, req.cid, slugs, link);
      if (!sent.ok) console.error(`[mcp-oauth] email failed: ${sent.error}`);
    }
  }
  // Same response whether or not the address has access (no account enumeration).
  return page('Revisa tu correo', `<h1>Revisa tu correo</h1><p>Si <b>${esc(email)}</b> puede editar alguna parroquia, te hemos enviado un enlace. Ábrelo para terminar de conectar <b>${esc(req.cid)}</b>.</p><p><small>Check your inbox for the login link.</small></p>`);
}

export async function confirmGet(env, request) {
  const q = new URL(request.url).searchParams;
  const req = await verify(env, q.get('req'), 'req');
  const code = q.get('code') || '';
  const state = await readAuthState(env);
  const rec = state && state.magic[await sha256Hex(code)];
  if (!req || !rec || rec.exp < Date.now()) {
    return page('Enlace no válido', '<h1>Enlace caducado o ya usado</h1><p>Vuelve a conectar desde tu cliente para recibir uno nuevo.</p>', 400);
  }
  const slugs = (state.emails[rec.email] || []).filter(Boolean);
  const host = new URL(req.ru).host || new URL(req.ru).protocol;
  // GET only shows the consent page; the code is consumed on POST so mail scanners that prefetch links can't burn it.
  return page('Autorizar', `<h1>¿Autorizar a ${esc(req.cid)}?</h1>` +
    `<p><b>${esc(req.cid)}</b> (volverá a <code>${esc(host)}</code>) podrá <b>leer y editar la configuración</b> de: <b>${esc(slugs.join(', '))}</b>, como ${esc(rec.email)}. Los cambios se publican directamente.</p>` +
    `<form method="post" action="/oauth/confirm"><input type="hidden" name="code" value="${esc(code)}"><input type="hidden" name="req" value="${esc(q.get('req'))}">` +
    `<button name="decision" value="allow">Autorizar</button><button class="sec" name="decision" value="deny">Cancelar</button></form>`);
}

export async function confirmPost(env, request) {
  const form = await readForm(request);
  const req = await verify(env, form.req, 'req');
  if (!req) return page('Error', '<h1>Solicitud caducada</h1>', 400);
  if (form.decision === 'deny') return redirectTo(req.ru, { error: 'access_denied', state: req.st });
  const codeHash = await sha256Hex(String(form.code || ''));
  const state = await readAuthState(env);
  const rec = state && state.magic[codeHash];
  if (!rec || rec.exp < Date.now()) return page('Enlace no válido', '<h1>Enlace caducado o ya usado</h1>', 400);

  delete state.magic[codeHash]; // single use
  const authCode = generateToken();
  state.oauth = state.oauth || {};
  for (const [h, c] of Object.entries(state.oauth)) if (c.exp < Date.now()) delete state.oauth[h];
  state.oauth[await sha256Hex(authCode)] = { email: rec.email, client_id: req.client_id, cid: req.cid, ru: req.ru, cc: req.cc, exp: Date.now() + CODE_TTL_MS };
  const w = await writeAuthState(env, state);
  if (!w.ok) return page('Error', `<h1>Servicio no disponible</h1><p>${esc(w.error)}</p>`, 503);
  return redirectTo(req.ru, { code: authCode, state: req.st });
}

function redirectTo(ru, params) {
  const u = new URL(ru);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: u.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

// ---- token endpoint --------------------------------------------------------
export async function token(env, request) {
  const f = await readForm(request);
  if (f.grant_type !== 'authorization_code') return oauthError('unsupported_grant_type', 'only authorization_code');
  if (!f.code || !f.code_verifier) return oauthError('invalid_request', 'code and code_verifier are required');
  const state = await readAuthState(env);
  if (!state) return oauthError('server_error', 'auth state unavailable', 503);
  const hash = await sha256Hex(String(f.code));
  const rec = state.oauth && state.oauth[hash];
  if (!rec) return oauthError('invalid_grant', 'invalid or already-used code');
  delete state.oauth[hash]; // single use, even if the checks below fail
  const fail = async (d) => { await writeAuthState(env, state); return oauthError('invalid_grant', d); };
  if (rec.exp < Date.now()) return fail('code expired');
  if (f.client_id !== rec.client_id) return fail('client mismatch');
  if (f.redirect_uri && f.redirect_uri !== rec.ru) return fail('redirect_uri mismatch');
  const challenge = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(f.code_verifier)))));
  if (!timingSafeEqual(challenge, rec.cc)) return fail('PKCE verification failed');
  const slugs = (state.emails[rec.email] || []).filter(Boolean);
  if (slugs.length === 0) return fail('this email no longer has access to any site');

  const accessToken = generateToken();
  state.tokens[await sha256Hex(accessToken)] = { slug: slugs[0], email: rec.email, via: 'mcp', client: rec.cid };
  const w = await writeAuthState(env, state);
  if (!w.ok) return oauthError('server_error', w.error, 503);
  return json({ access_token: accessToken, token_type: 'Bearer', scope: 'config' });
}

// ---- email -----------------------------------------------------------------
async function sendEmail(env, to, clientName, slugs, link) {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY not configured' };
  const from = env.FROM_EMAIL || 'Parroquia App <no-reply@parroquia.app>';
  const text = `Hola,\n\n${clientName} quiere conectarse a tu web (${slugs.join(', ')}) para leer y editar su configuración.\n\n` +
    `Si has sido tú, abre este enlace (un solo uso, válido unos minutos):\n\n${link}\n\nSi no, ignora este correo.`;
  const html = `<p>Hola,</p><p><b>${esc(clientName)}</b> quiere conectarse a tu web (${esc(slugs.join(', '))}) para leer y editar su configuración.</p>` +
    `<p>Si has sido tú: <a href="${esc(link)}">autorizar la conexión</a> (un solo uso, válido unos minutos).</p><p>Si no, ignora este correo.</p>`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject: `Conectar ${clientName} con Parroquia.app`, text, html }),
    });
    return res.ok ? { ok: true } : { ok: false, error: `Resend ${res.status}` };
  } catch (e) { return { ok: false, error: e.message }; }
}
