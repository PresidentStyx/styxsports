// HLS proxy. The CDNs only answer requests that carry the player page's origin as Referer/Origin,
// which a browser cannot fake, so playlists and segments go through here. Playlist URIs are
// rewritten to signed proxy paths so nobody can use the Worker as a general-purpose proxy.
import { DESKTOP_UA } from './site.js';

const PLAYLIST_TYPES = /mpegurl|x-mpegurl|vnd\.apple/i;
const SEGMENT_TTL_S = 20;

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

/** Proxy path for a media URL fetched on behalf of `playerOrigin`. */
export async function proxyPath(env, url, playerOrigin) {
  const payload = b64url(unescape(encodeURIComponent(JSON.stringify({ u: url, o: playerOrigin }))));
  return `/hls/${payload}.${await sign(env, payload)}`;
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
          rewritten = rewritten.replace(m[0], `URI="${await proxyPath(env, abs, playerOrigin)}"`);
        }
        out.push(rewritten);
      } else {
        out.push(line);
      }
      continue;
    }
    out.push(await proxyPath(env, absolutize(line, playlistUrl), playerOrigin));
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
