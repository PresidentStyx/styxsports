// Styx Sports on the web: the same schedule + player as the Android TV app, served from a Worker.
//   /api/schedule        events + categories (edge-cached 60 s)
//   /api/status          live clocks/scores feed (edge-cached 15 s)
//   /api/games           the two above normalized: state, score, period, team colors, heat,
//                        closeness, scoring timeline (see games.js; edge-cached 15 s)
//   /api/games/live-summary   scores only (~1 KB), polled by score bugs and switchers
//   /api/games/:id       one game; /api/games/coverage: status-text shapes seen per league
//   /api/stream?page=    server tabs of a stream page + the active server resolved
//   /api/stream?server=  one server resolved
//   /hls/<token>         signed HLS proxy (see hls.js)
//   /api/account         the viewer's site account: status, /code, /poll, /logout (see account.js)
//   /api/iptv            the account's Live TV channel list; /api/iptv/token signs one channel for /hls/
//   /apk                 latest Android TV build (GitHub Releases)
//   /install             how to install the Android TV / Fire TV and Roku apps (public/install.html)
//   /api/ping            public heartbeat from web / APK / Roku (see presence.js)
//   /api/flags           public: config.json feature flags resolved for ?platform=&device=&version= (flags.js)
//   /api/telemetry       public: playback events from web / APK / Roku (telemetry.js); summarized on /stats
//   /api/pool            shared premium account: 5 connection slots (see pool.js);
//                        /acquire /heartbeat /release are public so the APK and Roku can join
//   /stats, /api/stats   who is watching right now + pool usage (site password)
//   /login, /logout      site password (secret SITE_PASSWORD; see auth.js) — everything below needs it
//   everything else      static front end (public/)
import { loadConfig, fetchSchedule, fetchStatus, streamPage, resolveServer, currentBase, request } from './site.js';
import { handleHls, handleTs, proxyPath, tsPath, proxyable } from './hls.js';
import { hostOf } from './parser.js';
import { DESKTOP_UA } from './site.js';
import { gate, handleLogin, handleLogout } from './auth.js';
import { handlePing, handleStats, isTvDevice } from './presence.js';
import { handlePool, poolStub } from './pool.js';
import {
  loadSession, sessionCookie, clearCookie, publicAccount, requestCode, pollCode, completeSignIn,
  refreshStatus, discoverIptv, signOut, fetchIptv, iptvCacheKey, IPTV_CACHE_TTL_S, iptvUrlAllowed, RECHECK_MS,
  serializeSession, deserializeSession,
} from './account.js';

import { normalizeGames, sortGames, liveSummary, gamesStub } from './games.js';
import { resolveFlags } from './flags.js';
import { handleTelemetry, telemetryHealth } from './telemetry.js';

export { Presence } from './presence.js';
export { Pool } from './pool.js';
export { Games } from './games.js';
export { Telemetry } from './telemetry.js';

const APK_URL = 'https://github.com/PresidentStyx/styxsports/releases/latest/download/StyxSports.apk';
const SCHEDULE_TTL_S = 60;
const STATUS_TTL_S = 15;
const GAMES_TTL_S = 15;

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
      // The Roku channel package (roku/deploy.ps1 copies each build to public/StyxSports.zip):
      // a phone downloads it here and uploads it to the Roku's own installer page.
      if (path === '/roku' || path.toLowerCase() === '/styxsports.zip') {
        const zip = await env.ASSETS.fetch(new URL('/StyxSports.zip', request.url));
        if (!zip.ok) return zip;
        const out = new Response(zip.body, zip);
        out.headers.set('Content-Type', 'application/zip');
        out.headers.set('Content-Disposition', 'attachment; filename="StyxSports.zip"');
        return out;
      }
      if (path === '/api/ping') return await handlePing(request, env);
      if (path === '/api/telemetry') return await handleTelemetry(request, env);
      // Feature flags carry nothing private, and a client that is gated or on a blocking network
      // still needs them, so they are open like /api/ping.
      if (path === '/api/flags') {
        const cfg = await loadConfig();
        const out = resolveFlags(cfg, {
          platform: url.searchParams.get('platform') || 'web',
          deviceId: url.searchParams.get('device') || request.headers.get(DEVICE_HEADER) || '',
          version: url.searchParams.get('version') || '',
        });
        return json(out, 200, { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      }
      // Lease bookkeeping is open like /api/ping so the APK and Roku can count toward the 5 slots
      // (no cookies pass through it). State, /share and /clear stay behind the site password.
      if (path === '/api/pool/acquire' || path === '/api/pool/heartbeat' || path === '/api/pool/release' || path === '/api/pool/info') {
        // A browser's own-account cookie tells acquire the lease is on the viewer's account.
        const session = path === '/api/pool/acquire' ? await loadSession(request, env) : null;
        return await handlePool(request, env, path, session, serializeSession);
      }
      if (path === '/login') return await handleLogin(request, env);
      if (path === '/logout') return handleLogout(request);
      // A device holding a live pool lease (Roku, APK without its own account) may resolve
      // premium servers and read Live TV through the shared account without the site password:
      // the lease id is a random per-install UUID and the slot cap bounds what it can spend.
      // /hls/ paths are HMAC-signed by this Worker, so they need no password either.
      const leased = LEASED_PATHS.has(path) && await hasLiveLease(env, url.searchParams.get('slot'));
      // A TV app whose network blocks the site by name reads it through here instead (the
      // APK's Relay): its install id, the same one that pings /api/ping, is its credential.
      const device = request.headers.get(DEVICE_HEADER) || '';
      const app = !!device && appPath(path) && await isTvDevice(env, device);
      const denied = leased || app || path.startsWith('/hls/') || path.startsWith('/ts/') ? null : await gate(request, env, path);
      if (denied) return denied;
      if (path === '/api/stats') {
        const res = await handleStats(env);
        const data = await res.json();
        // Lease ids are the same per-install ids that ping /api/ping, so each lease can carry
        // its device's name. The ids themselves never leave the Worker (see Pool.state).
        const names = new Map((data.devices || []).map((d) => [d.id, d.name]));
        try {
          const pool = await poolStub(env)?.state(true);
          if (pool) {
            const byId = new Map(pool.leases.map((l) => [l.id, l]));
            for (const d of data.devices || []) {
              const l = byId.get(d.id);
              if (l) d.watching = { kind: l.kind, label: l.label, account: l.account ? l.accountLabel : '' };
            }
            for (const l of pool.leases) { l.device = names.get(l.id) || ''; delete l.id; }
            data.pool = pool;
          }
        } catch { /* optional */ }
        for (const d of data.devices || []) delete d.id;
        data.playback = await telemetryHealth(env, 24);
        return json(data);
      }
      if (path === '/stats') {
        return env.ASSETS.fetch(new URL('/stats.html', request.url));
      }
      if (path.startsWith('/hls/')) return await handleHls(request, env, path.slice(5));
      if (path.startsWith('/ts/')) return await handleTs(request, env, path.slice(4));
      if (path === '/api/schedule') return await cached(request, ctx, SCHEDULE_TTL_S, apiSchedule);
      if (path === '/api/status') return await cached(request, ctx, STATUS_TTL_S, apiStatus);
      if (path === '/api/games') return await cached(request, ctx, GAMES_TTL_S, () => apiGames(request, env, ctx));
      if (path === '/api/games/live-summary') return await cached(request, ctx, GAMES_TTL_S, () => apiGamesSummary(request, env, ctx));
      if (path === '/api/games/coverage') return await apiGamesCoverage(env);
      if (path.startsWith('/api/games/')) return await apiGame(request, env, ctx, decodeURIComponent(path.slice('/api/games/'.length)));
      if (path === '/api/stream') return await apiStream(request, env, url);
      if (path === '/api/account' || path.startsWith('/api/account/')) return await apiAccount(request, env, url, path);
      if (path === '/api/pool' || path.startsWith('/api/pool/')) {
        const session = await loadSession(request, env);
        return await handlePool(request, env, path, session, serializeSession);
      }
      if (path === '/api/iptv') return await apiIptv(request, env, ctx, url);
      if (path === '/api/iptv/token') return await apiIptvToken(request, env, url);
      if (path === '/api/probe') return await apiProbe(url);
      if (path === '/img') return await apiImage(request, ctx, url);
      if (path.startsWith('/api/')) return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 502);
    }

    return env.ASSETS.fetch(request);
  },
};

const LEASED_PATHS = new Set(['/api/stream', '/api/iptv', '/api/iptv/token']);
/** The TV apps' install id header, and what they may read with it when their network blocks the site. */
const DEVICE_HEADER = 'X-Styx-Device';
const APP_PATHS = new Set(['/api/schedule', '/api/status', '/api/stream', '/api/iptv', '/api/iptv/token', '/img']);
const appPath = (path) => APP_PATHS.has(path) || (path.startsWith('/api/games') && path !== '/api/games/coverage');

async function hasLiveLease(env, slot) {
  if (!slot) return false;
  try {
    const stub = poolStub(env);
    return !!(stub && await stub.hasLease(slot));
  } catch {
    return false;
  }
}

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

// --- Game State Service (games.js) ------------------------------------------------------------

/** Reads another API's body through the same edge cache entry it serves from (no extra site hits). */
async function readCached(request, ctx, path, ttl, handler) {
  const key = new Request(new URL(request.url).origin + path, { method: 'GET' });
  const res = await cached(key, ctx, ttl, handler);
  if (!res.ok) throw new Error(path + ' failed: ' + res.status);
  return await res.json();
}

const IMG_RE = /^\/img\?u=/;
const unproxyImg = (u) => (IMG_RE.test(u || '') ? decodeURIComponent(u.slice(7)) : u || '');

/** Schedule + status normalized, scoring timeline from the Games DO, sorted for Home. */
async function buildGames(request, env, ctx) {
  const [schedule, status] = await Promise.all([
    readCached(request, ctx, '/api/schedule', SCHEDULE_TTL_S, apiSchedule),
    readCached(request, ctx, '/api/status', STATUS_TTL_S, apiStatus).catch(() => null),
  ]);
  // apiSchedule already wrapped crests in /img; games.js reads the SVG behind it for colors.
  let games = await normalizeGames(schedule, status, { rawCrest: unproxyImg });
  try {
    const stub = gamesStub(env);
    if (stub) {
      const timelines = await stub.record(games.map((g) => ({ id: g.id, league: g.league, state: g.state, score: g.score, statusText: g.statusText })));
      for (const g of games) g.scoring = timelines[g.id] || [];
    }
  } catch { /* the timeline is a bonus */ }
  games = sortGames(games);
  const leagues = (schedule.categories || []).map((c) => ({ id: c.id, name: c.name, live: c.liveCount, soon: c.soonCount }));
  return { generatedAt: Date.now(), scheduleAt: schedule.fetchedAt, statusAt: status && status.generated_at ? status.generated_at * 1000 : null, base: schedule.base, leagues, games };
}

async function apiGames(request, env, ctx) {
  return json(await buildGames(request, env, ctx));
}

async function apiGamesSummary(request, env, ctx) {
  const all = await buildGames(request, env, ctx);
  return json({ at: all.generatedAt, games: liveSummary(all.games) });
}

async function apiGame(request, env, ctx, id) {
  const all = await buildGames(request, env, ctx);
  const g = all.games.find((x) => x.id === id || x.slug === id);
  return g ? json(g) : json({ error: 'no such game' }, 404);
}

async function apiGamesCoverage(env) {
  const stub = gamesStub(env);
  return json({ shapes: stub ? await stub.coverage() : [] });
}

/**
 * Stream pages are read with the viewer's own site cookies when they are signed in, so the page
 * carries their account's premium servers as real players instead of a gate. Viewers without
 * their own account borrow the shared premium session, but only after they hold a pool lease
 * (`slot=`) — listing the tabs can use the shared cookies (HTML only); resolving a premium
 * playlist cannot.
 */
async function apiStream(request, env, url) {
  const cfg = await loadConfig();
  const pageUrl = url.searchParams.get('page');
  const serverUrl = url.searchParams.get('server');
  const target = pageUrl || serverUrl;
  if (!target || !/^https?:\/\//.test(target)) return json({ error: 'missing page/server' }, 400);
  const host = hostOf(target);
  if (!cfg.isAllowedHost(host) && host !== hostOf(currentBase(cfg))) {
    return json({ error: 'host not allowed' }, 403);
  }
  const session = await loadSession(request, env);
  const listing = url.searchParams.get('only') === 'servers';
  const wantPremium = url.searchParams.get('premium') === '1';
  // A TV app plays with its own HTTP client: it gets the CDN URL whatever the CDN's CORS says.
  const native = !!request.headers.get(DEVICE_HEADER);
  // ...and one whose network blocks the site by name (the APK's Relay) also wants to know where
  // the CDN's front door redirects to, in case the edge behind it is not blocked.
  const relay = native && url.searchParams.get('relay') === '1';
  const borrowed = await borrowShared(env, url.searchParams.get('slot') || '', { listing, wantPremium });
  const jar = session.signedIn ? session.jar : borrowed.jar;

  if (pageUrl) {
    const page = await streamPage(cfg, pageUrl, jar);
    await saveBorrowed(borrowed);
    if (listing) {
      return withSession(json({ servers: page.servers, activeIndex: page.activeIndex }), session, env);
    }
    const active = page.servers[page.activeIndex];
    const stream = await resolveServer(cfg, active, page, jar);
    await saveBorrowed(borrowed);
    notePremium(session, active, stream);
    return withSession(json({
      servers: page.servers,
      activeIndex: page.activeIndex,
      stream: await publicStream(env, stream, { origin: url.origin, native, relay }),
    }), session, env);
  }

  const server = {
    name: url.searchParams.get('name') || 'Server',
    pageUrl: serverUrl,
    active: false,
    premium: wantPremium,
  };
  // A premium resolve without a lease (and without the viewer's own account) would spend a
  // connection of the shared account; refuse it instead of fetching.
  if (wantPremium && !session.signedIn && !borrowed.leased) {
    return json({ stream: { server: server.name, pageUrl: server.pageUrl, state: 'gate', hls: null, playable: false, log: ['no pool slot'] } });
  }
  const stream = await resolveServer(cfg, server, null, jar);
  if (!session.signedIn && borrowed.leased) notePremium(borrowed.session, server, stream);
  await saveBorrowed(borrowed);
  notePremium(session, server, stream);
  return withSession(json({ stream: await publicStream(env, stream, { origin: url.origin, native, relay }) }), session, env);
}

/**
 * Shared-account cookies. Listing server tabs is HTML only and does not need a lease; resolving
 * a premium playlist or Live TV does.
 */
async function borrowShared(env, slot, { listing = false, wantPremium = false } = {}) {
  const out = { stub: poolStub(env), shared: null, session: null, jar: undefined, leased: false };
  if (!out.stub) return out;
  try {
    // A lease names the shared account it borrows; a plain page listing may use any of them.
    const key = slot ? await out.stub.leaseAccount(slot) : null;
    if (key) out.leased = true;
    else if (!(listing && !wantPremium)) return out;
    out.shared = await out.stub.getShared(key);
  } catch {
    return out;
  }
  out.session = deserializeSession(out.shared);
  if (!out.session) {
    out.leased = false;
    return out;
  }
  out.jar = out.session.jar;
  return out;
}

async function saveBorrowed(borrowed) {
  if (!borrowed || !borrowed.stub || !borrowed.session || !borrowed.shared) return;
  if (!borrowed.session.dirty && !borrowed.session.jar.dirty) return;
  try {
    await borrowed.stub.setShared(borrowed.shared.key, serializeSession(borrowed.session));
  } catch { /* next request will reuse the last stored cookies */ }
}

/** What the site gave a premium tab tells us whether the account really has premium. */
function notePremium(session, server, stream) {
  if (!session.signedIn || !server.premium) return;
  let seen = null;
  if (stream.hlsUrl) seen = true;
  else if (stream.state === 'gate') seen = false;
  if (seen === null) return;
  // The time is kept too: a "no premium" verdict expires (storedPremium), so a renewed
  // subscription is noticed the next time a premium tab is tried.
  if (session.premium !== seen || (!seen && Date.now() - (session.premiumAt || 0) > 10 * 60 * 1000)) {
    session.premium = seen;
    session.premiumAt = Date.now();
    session.dirty = true;
  }
}

/** Adds the (re-encrypted) account cookie to `res` when the session changed during the request. */
async function withSession(res, session, env) {
  let cookie = null;
  try {
    cookie = await sessionCookie(session, env);
  } catch (e) {
    console.warn('[account] ' + e.message);
  }
  if (!cookie) return res;
  const out = new Response(res.body, res);
  out.headers.append('Set-Cookie', cookie);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Account (Account.java) — the viewer's own site account, carried in an encrypted cookie
// ---------------------------------------------------------------------------------------------

async function apiAccount(request, env, url, path) {
  const cfg = await loadConfig();
  const session = await loadSession(request, env);
  const sub = path.slice('/api/account'.length);

  if (sub === '' || sub === '/') {
    if (session.signedIn && Date.now() - session.checkedAt > RECHECK_MS) {
      try {
        if (await refreshStatus(cfg, session) && !session.iptv) await discoverIptv(cfg, session);
      } catch {
        // keep the cached verdict; checked again next time
      }
    }
    const acct = publicAccount(session);
    try {
      const p = await poolStub(env)?.state();
      if (p) acct.pool = { shared: p.shared, used: p.used, max: p.max, sharedIptv: p.sharedIptv, sharedPremium: p.sharedPremium };
    } catch { /* pool optional */ }
    return withSession(json(acct), session, env);
  }

  if (sub === '/code') {
    if (request.method !== 'POST') return json({ error: 'POST' }, 405);
    let deviceId = '';
    try {
      const body = await request.json();
      if (body && typeof body.deviceId === 'string') deviceId = body.deviceId.slice(0, 128);
    } catch { /* no body */ }
    const code = await requestCode(cfg, session, deviceId);
    return withSession(json(code), session, env);
  }

  if (sub === '/poll') {
    const code = url.searchParams.get('code') || '';
    const deviceId = url.searchParams.get('device_id') || '';
    if (!code || !deviceId) return json({ error: 'missing code/device_id' }, 400);
    const poll = await pollCode(cfg, session, code, deviceId);
    if (poll.status !== 'approved' || !poll.token) return json({ status: poll.status });
    await completeSignIn(cfg, session, poll.token);
    let cookie;
    try {
      cookie = await sessionCookie(session, env, { force: true });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
    return json({ status: 'approved', account: publicAccount(session) }, 200, { 'Set-Cookie': cookie });
  }

  if (sub === '/logout') {
    if (request.method !== 'POST') return json({ error: 'POST' }, 405);
    await signOut(cfg, session);
    return json({ signedIn: false }, 200, { 'Set-Cookie': clearCookie() });
  }

  return json({ error: 'not found' }, 404);
}

// ---------------------------------------------------------------------------------------------
// Live TV (Iptv.java) — the premium account's channel list
// ---------------------------------------------------------------------------------------------

const IPTV_HOSTS_HEADER = 'X-Iptv-Hosts';

async function apiIptv(request, env, ctx, url) {
  const session = await loadSession(request, env);
  const borrowed = session.signedIn ? null : await borrowShared(env, url.searchParams.get('slot') || '', { wantPremium: true });
  const who = session.signedIn ? session : (borrowed && borrowed.leased ? borrowed.session : null);
  if (!who) return json({ error: session.signedIn ? 'sign in first' : 'no pool slot' }, 403);
  const cfg = await loadConfig();
  if (!who.iptv) {
    try {
      await discoverIptv(cfg, who);
    } catch (e) {
      if (borrowed) await saveBorrowed(borrowed);
      return withSession(json({ error: 'Could not read the account page: ' + e.message }, 502), session, env);
    }
    if (!who.iptv) {
      if (borrowed) await saveBorrowed(borrowed);
      return withSession(json({ error: 'This account has no IPTV playlist' }, 404), session, env);
    }
  }

  // The parsed list is a couple of MB and the panel is slow: keep it at the edge for a while,
  // under a key only the holder of this playlist URL can produce.
  const cache = caches.default;
  const key = await iptvCacheKey(url.origin, who.iptv);
  const noStore = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' };
  if (url.searchParams.get('refresh') !== '1') {
    const hit = await cache.match(key);
    if (hit) {
      const hosts = (hit.headers.get(IPTV_HOSTS_HEADER) || '').split(',').filter(Boolean);
      if (hosts.length && hosts.join(',') !== who.iptvHosts.join(',')) { who.iptvHosts = hosts; who.dirty = true; }
      if (borrowed) await saveBorrowed(borrowed);
      return withSession(new Response(hit.body, { headers: noStore }), session, env);
    }
  }

  const data = await fetchIptv(who);
  if (data.hosts.join(',') !== who.iptvHosts.join(',')) { who.iptvHosts = data.hosts; who.dirty = true; }
  if (borrowed) await saveBorrowed(borrowed);
  const body = JSON.stringify(data);
  ctx.waitUntil(cache.put(key, new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${IPTV_CACHE_TTL_S}`,
      [IPTV_HOSTS_HEADER]: data.hosts.join(','),
    },
  })));
  return withSession(new Response(body, { headers: noStore }), session, env);
}

/**
 * One channel of this viewer's (or the shared) playlist: the raw URL for the device to play
 * directly. The panel's CDN is never proxied (see hls.js), so `hls` is null for it; a TV app
 * whose network blocks the front door (?relay=1) also gets the edge it redirects to (`hop`),
 * in case that is reachable — segments only play from the address that opened the edge, which
 * must be the TV's, not this Worker's.
 */
async function apiIptvToken(request, env, url) {
  const session = await loadSession(request, env);
  const u = url.searchParams.get('u') || '';
  const relay = !!request.headers.get(DEVICE_HEADER) && url.searchParams.get('relay') === '1';
  const answer = async () => {
    const hls = await proxyPath(env, u, null);
    const hop = relay ? await firstHop(u, null) : null;
    // The panel's continuous-TS relay (hls.js tsPath): one connection per viewer, safe to carry.
    const ts = relay && !hls ? await tsPath(env, u, null) : null;
    return json({
      hls,
      direct: u,
      hop,
      ts,
      ownAddressOnly: !hls,
      cdn: hostOf(u),
      // For the relay: nothing else to try means the message below, not a proxied stream.
      error: relay && !hls && !hop && !ts ? 'this channel plays only from your own network, which blocks it' : undefined,
    });
  };
  if (iptvUrlAllowed(session, u)) return await answer();
  const borrowed = await borrowShared(env, url.searchParams.get('slot') || '', { wantPremium: true });
  if (borrowed.leased && iptvUrlAllowed(borrowed.session, u)) return await answer();
  return json({ error: borrowed.session && !borrowed.leased ? 'no pool slot' : 'not a channel of your playlist' }, 403);
}

/**
 * Where a playlist URL redirects to, without following the redirect. The premium CDN's front
 * door (tv.steast.io) answers each channel with a 302 to an edge (edge-N.iptv4.net/auth/<token>)
 * whose segment tokens are bound to the IP that opens the edge; a TV that cannot reach the
 * front door can still open the edge itself if it is told where it is. Null when the URL does
 * not redirect (or does not answer).
 */
async function firstHop(u, playerOrigin) {
  // Never for the premium panel: even its front door logs the asking address against the
  // account, and the edge it names would only be blocked wherever the front door is.
  if (!proxyable(u)) return null;
  try {
    const headers = { 'User-Agent': DESKTOP_UA, Accept: '*/*' };
    if (playerOrigin) { headers.Referer = playerOrigin + '/'; headers.Origin = playerOrigin; }
    const res = await fetch(u, { headers, redirect: 'manual', signal: AbortSignal.timeout(8_000) });
    const loc = res.headers.get('Location');
    if (res.status >= 300 && res.status < 400 && loc) return new URL(loc, u).toString();
  } catch { /* unreachable from here */ }
  return null;
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
    const text = (await r.text()).slice(0, 4096);
    return {
      status: r.status,
      ok: r.ok && text.trimStart().startsWith('#EXTM3U'),
      // The premium CDN answers with a one-segment "warming.ts" placeholder while it spins the
      // channel up (sometimes for minutes); the player should not sit on it.
      warming: /warming\.ts/i.test(text),
      cors: r.headers.get('access-control-allow-origin'),
    };
  } catch (e) {
    return { status: 0, ok: false, error: e.message };
  }
}

/**
 * What the browser gets: a proxied playlist path, plus the raw URL (`direct`) when the CDN allows
 * cross-origin playback. The premium CDN binds its segment tokens to the IP that authorised the
 * playlist, and every Worker subrequest leaves Cloudflare from a different IP, so those streams
 * only play when the browser fetches them itself; the proxy stays as the fallback.
 */
async function publicStream(env, s, { origin = '', native = false, relay = false } = {}) {
  // The premium panel is never touched from here (see hls.js): not proxied, not pre-checked -
  // every Worker request reaches it from another Cloudflare address, which its panel reads as
  // the account being restreamed. Its URL goes out as `direct` regardless of CORS (the viewer's
  // own device is the only thing that can play it), and it is reported playable: the device
  // finds out for itself, and treats a warming.ts placeholder as "try another server".
  const ownAddressOnly = !!s.hlsUrl && !proxyable(s.hlsUrl);
  const check = s.hlsUrl && !ownAddressOnly ? await checkPlaylist(s) : null;
  const cors = check && check.cors;
  const hls = s.hlsUrl ? await proxyPath(env, s.hlsUrl, s.playerOrigin) : null;
  const direct = !!(s.hlsUrl && (native || ownAddressOnly || cors === '*' || (origin && cors === origin)));
  return {
    server: s.server,
    pageUrl: s.pageUrl,
    state: s.state,
    hls,
    direct: direct ? s.hlsUrl : null,
    playerOrigin: s.playerOrigin || null,
    hop: relay && s.hlsUrl ? await firstHop(s.hlsUrl, s.playerOrigin) : null,
    // The panel's continuous-TS relay (one connection per viewer, see hls.js tsPath): the way a
    // device whose network refuses the panel still plays premium.
    ts: relay && ownAddressOnly ? await tsPath(env, s.hlsUrl, s.playerOrigin) : null,
    ownAddressOnly,
    playable: ownAddressOnly || !!(check && check.ok && !check.warming),
    warming: !!(check && check.warming),
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
