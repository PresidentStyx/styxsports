// Styx Sports on the web: the same schedule + player as the Android TV app, served from a Worker.
//   /api/schedule        events + categories (edge-cached 60 s)
//   /api/status          live clocks/scores feed (edge-cached 15 s)
//   /api/stream?page=    server tabs of a stream page + the active server resolved
//   /api/stream?server=  one server resolved
//   /hls/<token>         signed HLS proxy (see hls.js)
//   /apk                 latest Android TV build (GitHub Releases)
//   /login, /logout      site password (secret SITE_PASSWORD; see auth.js) — everything below needs it
//   everything else      static front end (public/)
import { loadConfig, fetchSchedule, fetchStatus, streamPage, resolveServer, currentBase, request } from './site.js';
import { handleHls, proxyPath } from './hls.js';
import { hostOf } from './parser.js';
import { DESKTOP_UA } from './site.js';
import { gate, handleLogin, handleLogout } from './auth.js';

const APK_URL = 'https://github.com/PresidentStyx/styxsports/releases/latest/download/StyxSports.apk';
const SCHEDULE_TTL_S = 60;
const STATUS_TTL_S = 15;

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/apk' || path === '/download' || path.toLowerCase() === '/styxsports.apk') {
        return Response.redirect(APK_URL, 302);
      }
      if (path === '/login') return await handleLogin(request, env);
      if (path === '/logout') return handleLogout(request);
      const denied = await gate(request, env, path);
      if (denied) return denied;
      if (path.startsWith('/hls/')) return await handleHls(request, env, path.slice(5));
      if (path === '/api/schedule') return await cached(request, ctx, SCHEDULE_TTL_S, apiSchedule);
      if (path === '/api/status') return await cached(request, ctx, STATUS_TTL_S, apiStatus);
      if (path === '/api/stream') return await apiStream(url, env);
      if (path === '/api/probe') return await apiProbe(url);
      if (path === '/img') return await apiImage(request, ctx, url);
      if (path.startsWith('/api/')) return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 502);
    }

    return env.ASSETS.fetch(request);
  },
};

/** Edge-caches a GET handler's response for `ttl` seconds (one site fetch per edge per minute). */
async function cached(request, ctx, ttl, handler) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).origin + new URL(request.url).pathname, { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await handler();
  if (res.ok) {
    const copy = new Response(res.body, res);
    copy.headers.set('Cache-Control', `public, max-age=${ttl}`);
    ctx.waitUntil(cache.put(key, copy.clone()));
    return copy;
  }
  return res;
}

async function apiSchedule() {
  const cfg = await loadConfig();
  const s = await fetchSchedule(cfg);
  const img = (u) => (u ? '/img?u=' + encodeURIComponent(u) : '');
  for (const e of s.events) {
    e.crestHome = img(e.crestHome);
    e.crestAway = img(e.crestAway);
  }
  return json({
    fetchedAt: s.fetchedAt,
    base: s.sourceBaseUrl,
    categories: s.categories,
    events: s.events,
  });
}

async function apiStatus() {
  const cfg = await loadConfig();
  const text = await fetchStatus(cfg);
  return new Response(text, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

async function apiStream(url, env) {
  const cfg = await loadConfig();
  const pageUrl = url.searchParams.get('page');
  const serverUrl = url.searchParams.get('server');
  const target = pageUrl || serverUrl;
  if (!target || !/^https?:\/\//.test(target)) return json({ error: 'missing page/server' }, 400);
  const host = hostOf(target);
  if (!cfg.isAllowedHost(host) && host !== hostOf(currentBase(cfg))) {
    return json({ error: 'host not allowed' }, 403);
  }

  if (pageUrl) {
    const page = await streamPage(cfg, pageUrl);
    if (url.searchParams.get('only') === 'servers') {
      return json({ servers: page.servers, activeIndex: page.activeIndex });
    }
    const active = page.servers[page.activeIndex];
    const stream = await resolveServer(cfg, active, page);
    return json({
      servers: page.servers,
      activeIndex: page.activeIndex,
      stream: await publicStream(env, stream),
    });
  }

  const server = { name: url.searchParams.get('name') || 'Server', pageUrl: serverUrl, active: false, premium: false };
  const stream = await resolveServer(cfg, server, null);
  return json({ stream: await publicStream(env, stream) });
}

/**
 * Diagnostics (allowed hosts only): what the site answers the Worker with, or with
 * ?resolve=<server page> the full chain down to the CDN's answer.
 */
async function apiProbe(url) {
  const cfg = await loadConfig();
  const resolve = url.searchParams.get('resolve');
  if (resolve) {
    if (!cfg.isAllowedHost(hostOf(resolve))) return json({ error: 'host not allowed' }, 403);
    const stream = await resolveServer(cfg, { name: 'probe', pageUrl: resolve, active: false, premium: false }, null);
    const check = stream.hlsUrl ? await checkPlaylist(stream) : null;
    return json({ state: stream.state, cdn: stream.hlsUrl ? hostOf(stream.hlsUrl) : null, playerOrigin: stream.playerOrigin, log: stream.log, playlist: check });
  }
  const target = url.searchParams.get('url') || currentBase(cfg) + '/';
  if (!cfg.isAllowedHost(hostOf(target))) return json({ error: 'host not allowed' }, 403);
  const res = await request(target, { timeoutMs: 15_000 });
  const body = await res.text();
  return json({ target, status: res.status, finalUrl: res.url, length: body.length, head: body.slice(0, 600) });
}

/**
 * Fetches the playlist once, the way the proxy will. Some CDNs refuse Cloudflare's egress
 * addresses outright; knowing that now lets the player skip the server instead of waiting
 * for hls.js to give up.
 */
async function checkPlaylist(s) {
  try {
    const r = await fetch(s.hlsUrl, {
      headers: { 'User-Agent': DESKTOP_UA, Referer: s.playerOrigin + '/', Origin: s.playerOrigin },
      signal: AbortSignal.timeout(10_000),
      cf: { cacheTtl: 0 },
    });
    const head = (await r.text()).slice(0, 64);
    return { status: r.status, ok: r.ok && head.trimStart().startsWith('#EXTM3U') };
  } catch (e) {
    return { status: 0, ok: false, error: e.message };
  }
}

/** What the browser gets: a proxied playlist path instead of the raw signed CDN URL. */
async function publicStream(env, s) {
  const check = s.hlsUrl ? await checkPlaylist(s) : null;
  return {
    server: s.server,
    pageUrl: s.pageUrl,
    state: s.state,
    hls: s.hlsUrl ? await proxyPath(env, s.hlsUrl, s.playerOrigin) : null,
    playable: !!(check && check.ok),
    cdn: s.hlsUrl ? hostOf(s.hlsUrl) : null,
    cdnStatus: check ? check.status : null,
    embed: s.embed,
    log: s.log,
  };
}

/** Team crests live behind the site's SSO handshake, which a browser cannot complete for a
 *  cross-site <img>; serve them from here, cached for a day. */
async function apiImage(request, ctx, url) {
  const src = url.searchParams.get('u') || '';
  const cfg = await loadConfig();
  if (!/^https?:\/\//.test(src) || !cfg.isAllowedHost(hostOf(src))) return new Response('not allowed', { status: 403 });
  const cache = caches.default;
  const key = new Request(url.origin + '/img?u=' + encodeURIComponent(src), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  let res;
  try {
    res = await getImage(src);
  } catch {
    return new Response('', { status: 502 });
  }
  if (!res.ok) return new Response('', { status: 404, headers: { 'Cache-Control': 'public, max-age=600' } });
  const out = new Response(res.body, {
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400',
    },
  });
  ctx.waitUntil(cache.put(key, out.clone()));
  return out;
}

async function getImage(src) {
  return request(src, { timeoutMs: 10_000, headers: { Accept: 'image/*,*/*' } });
}
