// Site password. One shared password (secret SITE_PASSWORD) unlocks a long-lived signed session
// cookie; without the secret set, the gate is off. Signing reuses HLS_SECRET with its own prefix.

const COOKIE = 'styx_session';
const SESSION_DAYS = 180;
const LOGIN_PATH = '/login';
const LOGOUT_PATH = '/logout';

/** Paths that never need the password (TV install link, the login page itself, branding). */
const OPEN = new Set([LOGIN_PATH, LOGOUT_PATH, '/apk', '/download', '/styxsports.apk', '/wordmark.png', '/icon.png', '/favicon.ico', '/robots.txt']);

export function gateEnabled(env) {
  return typeof env.SITE_PASSWORD === 'string' && env.SITE_PASSWORD.length > 0;
}

export function isOpenPath(path) {
  return OPEN.has(path.toLowerCase());
}

/**
 * Returns null when the request may proceed, or a Response (redirect / 401) when it may not.
 * API, media and image calls get a 401 the front end turns into a redirect; pages redirect directly.
 */
export async function gate(request, env, path) {
  if (!gateEnabled(env) || isOpenPath(path)) return null;
  if (await hasSession(request, env)) return null;
  if (path.startsWith('/api/') || path.startsWith('/hls/') || path === '/img') {
    return new Response(JSON.stringify({ error: 'password required' }), {
      status: 401, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  const url = new URL(request.url);
  const next = url.pathname + url.search;
  return Response.redirect(`${url.origin}${LOGIN_PATH}${next !== '/' ? '?next=' + encodeURIComponent(next) : ''}`, 302);
}

export async function handleLogin(request, env) {
  const url = new URL(request.url);
  if (!gateEnabled(env)) return Response.redirect(url.origin + '/', 302);
  const next = safeNext(url.searchParams.get('next'));

  if (request.method === 'POST') {
    let given = '';
    try {
      const form = await request.formData();
      given = String(form.get('password') || '');
    } catch { /* not a form */ }
    if (await equalSecret(env, given.trim(), env.SITE_PASSWORD.trim())) {
      const cookie = await sessionCookie(env);
      return new Response(null, {
        status: 303,
        headers: { Location: url.origin + next, 'Set-Cookie': cookie, 'Cache-Control': 'no-store' },
      });
    }
    await new Promise((r) => setTimeout(r, 400)); // blunt brute-force damper
    return page(next, 'That password isn’t right.', 401);
  }

  if (await hasSession(request, env)) return Response.redirect(url.origin + next, 302);
  return page(next, '');
}

export function handleLogout(request) {
  const url = new URL(request.url);
  return new Response(null, {
    status: 303,
    headers: {
      Location: url.origin + LOGIN_PATH,
      'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
      'Cache-Control': 'no-store',
    },
  });
}

// --- session cookie -----------------------------------------------------------------------------

async function key(env) {
  const secret = 'session:' + ((env && env.HLS_SECRET) || 'styxsports-local-dev');
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function hmac(env, text) {
  const sig = await crypto.subtle.sign('HMAC', await key(env), new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time-ish comparison: compare MACs, not the raw strings. */
async function equalSecret(env, a, b) {
  const [ma, mb] = await Promise.all([hmac(env, 'pw:' + a), hmac(env, 'pw:' + b)]);
  return ma === mb;
}

async function sessionCookie(env) {
  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  const token = `${exp}.${(await hmac(env, 'exp:' + exp + ':' + env.SITE_PASSWORD)).slice(0, 32)}`;
  return `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86_400}; Secure; HttpOnly; SameSite=Lax`;
}

async function hasSession(request, env) {
  const raw = request.headers.get('Cookie') || '';
  const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [expStr, sig] = m[1].split('.');
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now() || !sig) return false;
  // Binding the MAC to the password means changing the password logs everyone out.
  return (await hmac(env, 'exp:' + exp + ':' + env.SITE_PASSWORD)).slice(0, 32) === sig;
}

function safeNext(next) {
  return next && /^\/(?!\/)/.test(next) ? next : '/';
}

// --- login page ---------------------------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(next, error, status = 200) {
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Styx Sports</title>
<link rel="icon" href="/icon.png">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0a0a0a; color: #f5f5f5;
         font: 16px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  form { width: min(420px, 92vw); padding: 36px 32px; background: #171717; border: 1px solid #2a2a2a; border-radius: 16px; text-align: center; }
  img { width: 240px; max-width: 80%; height: auto; margin-bottom: 26px; }
  label { display: block; color: #a3a3a3; font-size: 14px; margin-bottom: 10px; }
  input { width: 100%; padding: 14px 16px; font-size: 18px; color: #fff; background: #0a0a0a; border: 2px solid #333; border-radius: 10px; outline: none; }
  input:focus { border-color: #f5b942; }
  button { width: 100%; margin-top: 14px; padding: 14px; font-size: 17px; font-weight: 600; color: #0a0a0a; background: #f5b942; border: 0; border-radius: 10px; cursor: pointer; }
  button:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }
  .err { min-height: 22px; margin: 12px 0 0; color: #f87171; font-size: 14px; }
</style></head>
<body>
<form method="post" action="/login${next !== '/' ? '?next=' + encodeURIComponent(next) : ''}" autocomplete="on">
  <img src="/wordmark.png" alt="Styx Sports">
  <label for="pw">Enter the password to watch</label>
  <input id="pw" name="password" type="password" autofocus autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="current-password" required>
  <button type="submit">Enter</button>
  <p class="err">${esc(error)}</p>
</form>
</body></html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
