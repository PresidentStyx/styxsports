// The viewer's account on the site (Account.java / Iptv.java), one per browser.
//
// Sign-in uses the site's own TV flow: we ask the account service for a short code, the viewer
// types it (or scans the QR) on their phone while signed in there, and we swap the approved code
// for a session. The session is a handful of site cookies; instead of a server-side store they
// travel inside one encrypted, HttpOnly cookie on our own domain (`styx_acct`), so every viewer
// carries their own jar and nothing is shared. Each API call that touches the site decrypts it,
// uses it, and writes it back when the site rotated anything.
import { Jar, request, getText, postForm, currentBase } from './site.js';
import { hostOf, unescapeHtml } from './parser.js';

const COOKIE = 'styx_acct';
const COOKIE_MAX_AGE_S = 180 * 24 * 3600;
/** Browsers cap a cookie around 4 KB; leave headroom for the name and attributes. */
const MAX_COOKIE_BYTES = 3800;
/** Re-check the session with the account service this often (Account.RECHECK_MS). */
export const RECHECK_MS = 6 * 60 * 60 * 1000;
const AUTH_TIMEOUT_MS = 15_000;
const PLAYLIST_TIMEOUT_MS = 60_000;
const MAX_PLAYLIST_BYTES = 48 * 1024 * 1024;
/** Re-download the playlist after this long (Iptv.FRESH_MS is 12 h; the edge cache is shorter). */
const IPTV_CACHE_S = 6 * 3600;

// ---------------------------------------------------------------------------------------------
// Session <-> cookie
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} Session
 * @property {Jar} jar         the site's cookies for this viewer
 * @property {boolean} signedIn
 * @property {number} checkedAt  ms epoch of the last status check
 * @property {string|null} iptv  the account's M3U Plus playlist URL (premium perk)
 * @property {string[]} iptvHosts hosts the playlist's channel URLs live on (for /api/iptv/token)
 * @property {boolean|null} premium  true/false once a premium server was seen unlocked/locked
 * @property {boolean} dirty  something changed since the cookie was read
 */

function freshSession() {
  return { jar: new Jar(), signedIn: false, checkedAt: 0, iptv: null, iptvHosts: [], premium: null, dirty: false };
}

async function aesKey(env) {
  const secret = 'account:' + ((env && env.HLS_SECRET) || 'styxsports-local-dev');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function encrypt(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), new TextEncoder().encode(text)));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return b64url(packed);
}

async function decrypt(env, token) {
  const packed = unb64url(token);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: packed.slice(0, 12) }, await aesKey(env), packed.slice(12));
  return new TextDecoder().decode(pt);
}

function cookieValue(request) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE) return rest.join('=');
  }
  return null;
}

/** The viewer's session from the request cookie; a fresh, signed-out one when there is none. */
export async function loadSession(request, env) {
  const raw = cookieValue(request);
  if (!raw) return freshSession();
  try {
    const o = JSON.parse(await decrypt(env, raw));
    return {
      jar: new Jar(o.j || {}),
      signedIn: !!o.s,
      checkedAt: Number(o.t) || 0,
      iptv: typeof o.i === 'string' && o.i.startsWith('http') ? o.i : null,
      iptvHosts: Array.isArray(o.h) ? o.h.filter((x) => typeof x === 'string') : [],
      premium: o.p === 1 ? true : o.p === 0 ? false : null,
      dirty: false,
    };
  } catch {
    const s = freshSession();
    s.dirty = true; // unreadable (secret rotated?): overwrite it
    return s;
  }
}

/** Set-Cookie header value carrying `session`, or null when nothing changed. */
export async function sessionCookie(session, env, { force = false } = {}) {
  if (!force && !session.dirty && !session.jar.dirty) return null;
  if (!session.signedIn && session.jar.size === 0) return clearCookie();
  const payload = JSON.stringify({
    j: session.jar,
    s: session.signedIn ? 1 : 0,
    t: session.checkedAt,
    i: session.iptv,
    h: session.iptvHosts,
    p: session.premium === true ? 1 : session.premium === false ? 0 : null,
  });
  const value = await encrypt(env, payload);
  if (value.length > MAX_COOKIE_BYTES) {
    throw new Error(`account session too large for a cookie (${value.length} bytes)`);
  }
  return `${COOKIE}=${value}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; Secure; HttpOnly; SameSite=Lax`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

/** What the browser is told about the account (never the cookies themselves). */
export function publicAccount(session) {
  return {
    signedIn: session.signedIn,
    premium: session.premium,
    iptv: !!(session.signedIn && session.iptv),
    checkedAt: session.checkedAt,
  };
}

/** Durable-Object form of a session (the shared premium account). */
export function serializeSession(session) {
  return {
    j: session.jar.toJSON(),
    i: session.iptv,
    h: session.iptvHosts,
    p: session.premium === true ? 1 : session.premium === false ? 0 : null,
    t: session.checkedAt,
    at: Date.now(),
  };
}

/** Reverse of serializeSession; signedIn is always true (it would not have been stored otherwise). */
export function deserializeSession(o) {
  if (!o || typeof o !== 'object' || !o.j) return null;
  return {
    jar: new Jar(o.j),
    signedIn: true,
    checkedAt: Number(o.t) || 0,
    iptv: typeof o.i === 'string' && o.i.startsWith('http') ? o.i : null,
    iptvHosts: Array.isArray(o.h) ? o.h.filter((x) => typeof x === 'string') : [],
    premium: o.p === 1 ? true : o.p === 0 ? false : null,
    dirty: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Sign-in flow
// ---------------------------------------------------------------------------------------------

function activateUrl(cfg) {
  return `${cfg.authBaseUrl}/activate?from=${hostOf(currentBase(cfg))}`;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Unexpected answer from the account service');
  }
}

/** Asks for a fresh code. Reusing `deviceId` makes the service replace the previous code. */
export async function requestCode(cfg, session, deviceId) {
  const body = deviceId ? 'device_id=' + encodeURIComponent(deviceId) : '';
  const d = parseJson(await postForm(`${cfg.authBaseUrl}/device/code`, body, { referer: `${cfg.authBaseUrl}/tv`, jar: session.jar }));
  if (!d.success) throw new Error('The account service refused to issue a code');
  const code = String(d.code || '');
  const id = String(d.device_id || deviceId || '');
  if (!code || !id) throw new Error('Malformed code response');
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = Number(d.expires_at) || now + (Number(d.expires_in) || 600);
  return {
    code,
    display: code.length === 6 ? code.slice(0, 3) + ' ' + code.slice(3) : code,
    deviceId: id,
    expiresAt,
    activateUrl: activateUrl(cfg),
    activateDisplay: hostOf(cfg.authBaseUrl) + '/activate',
  };
}

/** Has the viewer approved the code yet? -> { status: pending|approved|used|expired|invalid, token } */
export async function pollCode(cfg, session, code, deviceId) {
  const url = `${cfg.authBaseUrl}/device/poll?code=${encodeURIComponent(code)}&device_id=${encodeURIComponent(deviceId)}`;
  const d = parseJson(await getText(url, { referer: `${cfg.authBaseUrl}/tv`, jar: session.jar, timeoutMs: AUTH_TIMEOUT_MS }));
  return { status: String(d.status || 'pending'), token: String(d.auth_token || '') };
}

/**
 * Swaps an approved token for a session on the account service and on the mirror we read (the
 * service redirects into the mirror's SSO hand-off), then confirms it and looks for the IPTV perk.
 */
export async function completeSignIn(cfg, session, token) {
  const base = currentBase(cfg);
  const landing = await request(`${cfg.authBaseUrl}/device/login?token=${encodeURIComponent(token)}&from=${hostOf(base)}`, {
    jar: session.jar, timeoutMs: AUTH_TIMEOUT_MS,
  });
  await landing.body?.cancel();
  try {
    await getText(base + '/', { jar: session.jar }); // make sure the mirror ran its hand-off too
  } catch {
    // the status check below is the verdict
  }
  if (!(await refreshStatus(cfg, session))) {
    throw new Error('Signed in, but the account service does not see a session');
  }
  session.premium = null; // learnt fresh from the first premium server
  try {
    await discoverIptv(cfg, session);
  } catch {
    // retried from /api/account when stale
  }
  session.dirty = true;
}

/** Asks the account service whether the cookies still make a signed-in session. */
export async function refreshStatus(cfg, session) {
  const res = await request(`${cfg.authBaseUrl}/my-account/`, { jar: session.jar, timeoutMs: AUTH_TIMEOUT_MS });
  await res.body?.cancel();
  const landed = res.url || '';
  const signedIn = res.ok && !landed.includes('/login');
  session.signedIn = signedIn;
  session.checkedAt = Date.now();
  if (!signedIn) {
    session.iptv = null;
    session.iptvHosts = [];
    session.premium = null;
  }
  session.dirty = true;
  return signedIn;
}

/** Reads the personal playlist link off the account page's IPTV tab (premium accounts only). */
export async function discoverIptv(cfg, session) {
  const html = await getText(`${cfg.authBaseUrl}/my-account/?tab=iptv`, { jar: session.jar, timeoutMs: AUTH_TIMEOUT_MS });
  const urls = {};
  for (const m of html.matchAll(cfg.rules.iptvUrlInputG)) urls[m[1]] = unescapeHtml(m[2]);
  const plus = urls['iptv-m3u-plus'];
  session.dirty = true;
  if (!plus || !plus.startsWith('http')) {
    session.iptv = null;
    session.iptvHosts = [];
    return false;
  }
  if (session.iptv !== plus) session.iptvHosts = [];
  session.iptv = plus;
  return true;
}

/** Signs out on the account service and forgets every cookie. */
export async function signOut(cfg, session) {
  try {
    const res = await request(`${cfg.authBaseUrl}/logout/`, { jar: session.jar, timeoutMs: AUTH_TIMEOUT_MS });
    await res.body?.cancel();
  } catch {
    // forgetting the cookies signs us out regardless
  }
  Object.assign(session, freshSession(), { dirty: true });
}

// ---------------------------------------------------------------------------------------------
// IPTV playlist (premium perk)
// ---------------------------------------------------------------------------------------------

const ATTR_RE = /([A-Za-z][\w-]*)="([^"]*)"/g;
const SPORTS_RE = /sport|espn|bein|desport|esporte|dazn|ppv/i;

/** M3U text -> { groups: [{ name, channels: [{ name, logo, url }] }], count } (Iptv.parse). */
export function parseM3u(text) {
  const byGroup = new Map();
  let count = 0;
  let pending = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      pending = line;
    } else if (line[0] !== '#' && pending) {
      const c = channelOf(pending, line);
      pending = null;
      if (!c) continue;
      let list = byGroup.get(c.group);
      if (!list) byGroup.set(c.group, (list = []));
      list.push(c);
      count++;
    }
  }
  // Sports groups first (this is a sports app), everything else in the playlist's order.
  const sports = [];
  const rest = [];
  for (const [name, channels] of byGroup) (SPORTS_RE.test(name) ? sports : rest).push({ name, channels });
  return { groups: sports.concat(rest), count };
}

function channelOf(extinf, url) {
  if (!url.startsWith('http')) return null;
  const comma = extinf.lastIndexOf(',');
  let name = comma >= 0 ? extinf.slice(comma + 1).trim() : '';
  let logo = '';
  let group = '';
  const head = comma >= 0 ? extinf.slice(0, comma) : extinf;
  for (const m of head.matchAll(ATTR_RE)) {
    switch (m[1].toLowerCase()) {
      case 'tvg-logo': logo = m[2].trim(); break;
      case 'group-title': group = m[2].trim(); break;
      case 'tvg-name': if (!name) name = m[2].trim(); break;
      default:
    }
  }
  if (!name) name = 'Channel';
  if (!group) group = 'Other';
  if (!logo.startsWith('http')) logo = '';
  return { name, logo, group, url };
}

async function download(url, jar) {
  const res = await request(url, { jar, timeoutMs: PLAYLIST_TIMEOUT_MS, headers: { Accept: '*/*' } });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status} from ${hostOf(url)}`);
  }
  const len = Number(res.headers.get('Content-Length') || 0);
  if (len > MAX_PLAYLIST_BYTES) {
    await res.body?.cancel();
    throw new Error('Playlist too large');
  }
  return res.text();
}

/**
 * Downloads and parses the account's playlist. The panel serves it with HLS URLs when asked
 * (`output=hls`), which is the only kind a browser can play; the plain MPEG-TS list is the fallback
 * so at least the channel names show up, with the unplayable ones dropped.
 */
export async function fetchIptv(session) {
  const plus = session.iptv;
  if (!plus) throw new Error('This account has no IPTV playlist');
  const hlsUrl = plus + (plus.includes('?') ? '&' : '?') + 'output=hls';
  let parsed = null;
  try {
    const probe = parseM3u(await download(hlsUrl, session.jar));
    let m3u8 = 0;
    for (const g of probe.groups) for (const c of g.channels) if (c.url.includes('.m3u8')) m3u8++;
    if (probe.count > 0 && m3u8 * 2 >= probe.count) parsed = probe;
  } catch {
    // plain list below
  }
  if (!parsed) parsed = parseM3u(await download(plus, session.jar));
  if (!parsed.count) throw new Error('Playlist is empty');

  // Browsers play HLS only; keep those and remember where they live.
  const hosts = new Set();
  let dropped = 0;
  const groups = [];
  for (const g of parsed.groups) {
    const channels = [];
    for (const c of g.channels) {
      if (!c.url.includes('.m3u8')) { dropped++; continue; }
      hosts.add(hostOf(c.url).toLowerCase());
      channels.push({ n: c.name, l: c.logo, u: c.url });
    }
    if (channels.length) groups.push({ n: g.name, c: channels });
  }
  return { groups, count: parsed.count - dropped, dropped, hosts: [...hosts], fetchedAt: Date.now() };
}

/** Edge cache key for a playlist URL: private to whoever holds that URL, and unguessable. */
export async function iptvCacheKey(origin, plusUrl) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('iptv:' + plusUrl));
  return new Request(`${origin}/__iptv/${b64url(new Uint8Array(digest))}`, { method: 'GET' });
}

export const IPTV_CACHE_TTL_S = IPTV_CACHE_S;

/** May this viewer proxy `url`? Only channels of their own playlist. */
export function iptvUrlAllowed(session, url) {
  if (!session.signedIn || !session.iptv || !/^https?:\/\//.test(url)) return false;
  const host = hostOf(url).toLowerCase();
  return host === hostOf(session.iptv).toLowerCase() || session.iptvHosts.includes(host);
}
