// HLS proxy. The CDNs only answer requests that carry the player page's origin as Referer/Origin,
// which a browser cannot fake, so playlists and segments go through here. Playlist URIs are
// rewritten to signed proxy paths so nobody can use the Worker as a general-purpose proxy.
import { DESKTOP_UA } from './site.js';

const PLAYLIST_TYPES = /mpegurl|x-mpegurl|vnd\.apple/i;
const SEGMENT_TTL_S = 20;

/**
 * Hosts whose media is never fetched from here: the premium panel (an XUI/Xtream server behind
 * tv.steast.io and edge-N.iptv4.net). Its segment tokens only work from the address that opened
 * the channel, and this Worker's outbound address changes from one request to the next, so
 * proxying it means playlists from one address and segment requests from others — which the
 * panel reads as restreaming and answers by banning the whole account (a "You have been banned"
 * slate on every channel, for every viewer). Premium HLS plays only from the viewer's own
 * device; when a network blocks that, the panel's continuous-TS endpoint is relayed instead
 * (tsPath / handleTs below) - one connection per viewer, which the panel is fine with.
 */
const NO_PROXY_HOSTS = /(^|\.)(steast\.io|iptv4\.net)$/i;

/** Whether this Worker may fetch media from `url` on a viewer's behalf. */
export function proxyable(url) {
  try {
    return !NO_PROXY_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function b64url(bytes) {
  let s = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}

async function key(env) {
  const secret = (env && env.HLS_SECRET) || 'styxsports-local-dev';
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function sign(env, payload) {
  const sig = await crypto.subtle.sign('HMAC', await key(env), new TextEncoder().encode(payload));
  return b64url(new Uint8Array(sig).slice(0, 16));
}

/** Proxy path for a media URL fetched on behalf of `playerOrigin`; null for hosts never proxied. */
export async function proxyPath(env, url, playerOrigin) {
  if (!proxyable(url)) return null;
  const payload = b64url(unescape(encodeURIComponent(JSON.stringify({ u: url, o: playerOrigin }))));
  return `/hls/${payload}.${await sign(env, payload)}`;
}

/**
 * The one way the premium panel can be relayed: not as HLS (see NO_PROXY_HOSTS) but as the
 * panel's continuous MPEG-TS endpoint - `/live/<user>/<pass>/<id>.ts` beside every `.m3u8` -
 * which is a single long-lived HTTP response. One Worker subrequest carries the whole viewing
 * session, so the panel sees exactly what it sees from any IPTV player: one connection from one
 * address, no per-segment tokens to bind. Minted only for the panel's hosts, and only when the
 * device asked for relay ways (its own network refuses the panel).
 */
export async function tsPath(env, url, playerOrigin) {
  if (proxyable(url)) return null; // free CDNs have the HLS proxy; this is for the panel only
  const payload = b64url(unescape(encodeURIComponent(JSON.stringify({ u: url, o: playerOrigin, ts: 1 }))));
  return `/ts/${payload}.${await sign(env, payload)}`;
}

/** Streams the panel's continuous TS for a /ts/ token (see tsPath). */
export async function handleTs(request, env, token) {
  const t = await decodeToken(env, token);
  if (!t || t.ts !== 1) return new Response('bad token', { status: 403 });
  const u = t.u.replace(/\.m3u8(\?[^#]*)?$/i, '.ts$1');
  const headers = upstreamHeaders(t.o, request);
  delete headers.Range; // the stream is live; there is nothing to seek in
  let upstream;
  try {
    // No timeout: the response is the viewing session. The panel's front door 302s to the edge
    // that carries it; following the redirect keeps the same subrequest, hence the same address.
    upstream = await fetch(u, { headers, redirect: 'follow', cf: { cacheTtl: 0 } });
  } catch (e) {
    return new Response('upstream error: ' + e.message, { status: 502 });
  }
  if (!upstream.ok) return new Response(`upstream ${upstream.status}`, { status: upstream.status === 404 ? 404 : 502 });
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'video/mp2t',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

async function decodeToken(env, token) {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  if ((await sign(env, payload)) !== token.slice(dot + 1)) return null;
  try {
    const o = JSON.parse(decodeURIComponent(escape(unb64url(payload))));
    if (typeof o.u !== 'string' || !/^https?:\/\//.test(o.u)) return null;
    return o;
  } catch {
    return null;
  }
}

function upstreamHeaders(playerOrigin, request) {
  const h = {
    'User-Agent': DESKTOP_UA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (playerOrigin) {
    h.Referer = playerOrigin + '/';
    h.Origin = playerOrigin;
  }
  const range = request.headers.get('Range');
  if (range) h.Range = range;
  return h;
}

export async function handleHls(request, env, token) {
  const t = await decodeToken(env, token);
  if (!t) return new Response('bad token', { status: 403 });
  // Tokens minted before a host joined NO_PROXY_HOSTS (or by an older build) stay refused.
  if (!proxyable(t.u)) return new Response('this CDN plays only from the viewer\'s own address', { status: 403 });

  // Live playlists change every few seconds and must never be served stale; segments are
  // immutable and can be shared between viewers for a short while.
  const looksLikePlaylist = /\.m3u8(\?|$)/i.test(new URL(t.u).pathname);
  let upstream;
  try {
    upstream = await fetch(t.u, {
      headers: upstreamHeaders(t.o, request),
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
      cf: looksLikePlaylist ? { cacheTtl: 0 } : { cacheEverything: true, cacheTtl: SEGMENT_TTL_S },
    });
  } catch (e) {
    return new Response('upstream error: ' + e.message, { status: 502 });
  }
  if (!upstream.ok && upstream.status !== 206) {
    return new Response(`upstream ${upstream.status}`, { status: upstream.status === 404 ? 404 : 502 });
  }

  const type = upstream.headers.get('Content-Type') || '';
  const isPlaylist = PLAYLIST_TYPES.test(type) || /\.m3u8(\?|$)/i.test(new URL(upstream.url || t.u).pathname);
  if (isPlaylist) {
    const text = await upstream.text();
    if (!text.trimStart().startsWith('#EXTM3U')) return new Response('not a playlist', { status: 502 });
    const body = await rewritePlaylist(env, text, upstream.url || t.u, t.o);
    return new Response(body, {
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
      },
    });
  }

  const headers = new Headers();
  for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
    const v = upstream.headers.get(name);
    if (v) headers.set(name, v);
  }
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'video/mp2t');
  headers.set('Cache-Control', `public, max-age=${SEGMENT_TTL_S}`);
  return new Response(upstream.body, { status: upstream.status, headers });
}

async function rewritePlaylist(env, text, playlistUrl, playerOrigin) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { out.push(''); continue; }
    if (line.startsWith('#')) {
      // Tags that carry URIs: EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, EXT-X-I-FRAME-STREAM-INF, ...
      if (line.includes('URI="')) {
        let rewritten = line;
        for (const m of line.matchAll(/URI="([^"]+)"/g)) {
          const abs = absolutize(m[1], playlistUrl);
          rewritten = rewritten.replace(m[0], `URI="${(await proxyPath(env, abs, playerOrigin)) || abs}"`);
        }
        out.push(rewritten);
      } else {
        out.push(line);
      }
      continue;
    }
    // A URI on a host never proxied is left for the player to fetch itself.
    const abs = absolutize(line, playlistUrl);
    out.push((await proxyPath(env, abs, playerOrigin)) || abs);
  }
  return out.join('\n');
}

function absolutize(uri, base) {
  try {
    return new URL(uri, base).toString();
  } catch {
    return uri;
  }
}
