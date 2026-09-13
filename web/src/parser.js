// Port of SiteParser.java / StreamResolver.java: turns the site's HTML into events and streams.
import { firstGroup } from './rules.js';

const ATTR = /([a-zA-Z][\w-]*)="([^"]*)"/g;

export function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(ATTR)) out[m[1]] = m[2];
  return out;
}

export function unescapeHtml(s) {
  if (!s || s.indexOf('&') < 0) return s || '';
  return s
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(Number(n)); } catch { return _; }
    });
}

export function absolute(href, baseUrl) {
  if (!href) return '';
  if (/^https?:\/\//.test(href)) return href;
  if (href.startsWith('//')) return 'https:' + href;
  if (!href.startsWith('/')) href = '/' + href;
  return baseUrl + href;
}

export function resolveUrl(src, pageUrl) {
  const s = unescapeHtml(src.trim());
  try {
    return new URL(s, pageUrl).toString();
  } catch {
    return absolute(s, originOf(pageUrl));
  }
}

export function originOf(url) {
  const u = new URL(url);
  return u.protocol + '//' + u.host;
}

export function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return ''; }
}

const int = (s) => { const n = parseInt(s, 10); return Number.isFinite(n) ? n : 0; };

// ---------------------------------------------------------------------------------------------
// Listing page
// ---------------------------------------------------------------------------------------------

export function parseListing(r, html, baseUrl) {
  const snapshot = { sourceBaseUrl: baseUrl, categories: [], events: [] };
  parseCategories(r, html, snapshot);
  snapshot.events.push(...parseCards(r, html, baseUrl));
  return snapshot;
}

export function parseCategories(r, html, into) {
  for (const m of html.matchAll(r.catButtonG)) {
    const a = attrs(m[0]);
    const cat = a['data-m-cat'];
    if (!cat || !/^\d+$/.test(cat)) continue; // skips the "All" entry
    const end = html.indexOf('</button>', m.index + m[0].length);
    const inner = end > 0 ? html.slice(m.index + m[0].length, end) : '';
    const id = int(cat);
    if (into.categories.some((c) => c.id === id)) continue;
    into.categories.push({
      id,
      name: unescapeHtml(firstGroup(r.catLabel, inner, 'Category ' + cat)).trim(),
      liveCount: int(firstGroup(r.catLive, inner, '0')),
      soonCount: int(firstGroup(r.catSoon, inner, '0')),
    });
  }
}

export function parseCards(r, html, baseUrl) {
  const spans = [];
  for (const m of html.matchAll(r.cardStartG)) spans.push([m.index, m.index + m[0].length, m]);
  const out = [];
  for (let i = 0; i < spans.length; i++) {
    const [start, tagEnd, m] = spans[i];
    const next = i + 1 < spans.length ? spans[i + 1][0] : Math.min(html.length, tagEnd + 6000);
    const e = parseCard(r, m, html.slice(tagEnd, next), baseUrl);
    if (e) out.push(e);
  }
  return out;
}

function parseCard(r, m, body, baseUrl) {
  const classes = m[1] || '';
  const a = attrs(m[2] || '');
  const e = {
    id: a[r.attrId] || a[r.attrIdAlt] || '',
    categoryId: int(a[r.attrCategory]),
    home: '', away: '', url: '',
    startTs: int(a[r.attrTime]),
    live: classes.includes(r.liveClass),
    ended: false,
    hot: classes.includes(r.hotClass) || a[r.attrHot] === '1',
    hotRank: int(a[r.attrHotRank]),
    premium: a[r.attrPro] === '1',
    league: a[r.attrLeague] || a[r.attrLeagueAlt] || '',
    crestHome: '', crestAway: '', liveText: '', score: '',
  };
  const names = unescapeHtml(a[r.attrTeams]);
  if (names) {
    const bar = names.indexOf('|');
    if (bar >= 0) {
      e.home = names.slice(0, bar).trim();
      e.away = names.slice(bar + 1).trim();
    } else {
      e.home = names.trim();
    }
  }
  let href = a.href || firstGroup(r.cardLink, body, '');
  if (!href) return null;
  e.url = absolute(unescapeHtml(href), baseUrl);
  if (!e.home) e.home = unescapeHtml(firstGroup(r.cardTitle, body, '')).trim();
  if (!e.home) {
    const al = /aria-label="([^"]+)"/.exec(body);
    if (al) e.home = unescapeHtml(al[1]);
  }
  if (!e.home) return null;
  if (!e.id) e.id = e.url;
  e.crestHome = absolute(unescapeHtml(a[r.attrMarkHome]), baseUrl);
  e.crestAway = absolute(unescapeHtml(a[r.attrMarkAway]), baseUrl);
  e.liveText = unescapeHtml(firstGroup(r.liveText, body, '')).trim();
  if (matchesWhole(r.endedText, e.liveText)) {
    e.ended = true;
    e.live = false;
  }
  const hs = firstGroup(r.homeScore, body, '').trim();
  const as = firstGroup(r.awayScore, body, '').trim();
  if (hs && as) e.score = hs + ' - ' + as;
  return e;
}

function matchesWhole(re, s) {
  const m = re.exec(s);
  return !!m && m.index === 0 && m[0].length === s.length;
}

export function parseShowMore(r, html) {
  const out = [];
  for (const m of html.matchAll(r.showMoreG)) {
    const a = attrs(m[0]);
    const ids = (a['data-ids'] || '').split(',').map((s) => s.trim()).filter((s) => /^[1-9]\d*$/.test(s));
    if (ids.length) {
      out.push({ categoryId: int(a['data-category']), endpoint: a['data-endpoint'] || '/ajax/ajax_match_cards.php', ids });
    }
  }
  return out;
}

/** Merges the live-status feed (clock, score, final) into events; best effort. */
export function mergeStatus(r, json, events) {
  let root;
  try { root = typeof json === 'string' ? JSON.parse(json) : json; } catch { return; }
  const m = root && root.m;
  if (!m || typeof m !== 'object') return;
  const byId = new Map(events.map((e) => [e.id, e]));
  for (const [id, st] of Object.entries(m)) {
    const e = byId.get(id);
    if (!e || !st || typeof st !== 'object') continue;
    const cls = String(st.vCls || '');
    const txt = unescapeHtml(String(st.vTxt || '')).trim();
    const ended = st.esEnd === 1 || cls.includes('final') || matchesWhole(r.endedText, txt);
    const live = !ended && (st.lw === true || cls.includes('live'));
    if (live || ended) {
      e.live = live;
      e.ended = ended;
      const label = ended ? String(st.endLab || txt).trim() : txt;
      if (label) e.liveText = label;
      const sc = String(st.vSc || '').trim();
      if (sc) e.score = sc;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Stream page
// ---------------------------------------------------------------------------------------------

const IGNORE_SRC = /about:blank|sso-frame|streamea\.st|chat|recaptcha|google|facebook|twitter|histats|doubleclick|adsystem/i;

export function parseServers(r, html, pageUrl) {
  const out = [];
  for (const m of html.matchAll(r.serverItemG)) {
    const classes = m[1] || '';
    const inner = m[3] || '';
    let name = unescapeHtml(firstGroup(r.serverName, inner, '')).trim();
    if (!name) name = 'Server ' + (out.length + 1);
    out.push({
      name,
      pageUrl: resolveUrl(m[2], pageUrl),
      active: classes.includes(r.serverActiveClass),
      premium: classes.includes(r.serverProClass),
    });
  }
  return out;
}

export function playerState(r, html) {
  return firstGroup(r.playerState, html, '');
}

export function mainEmbed(r, html, pageUrl) {
  const byId = firstGroup(r.embedIframe, html, null);
  if (byId && !IGNORE_SRC.test(byId)) return resolveUrl(byId, pageUrl);
  const pageHost = hostOf(pageUrl);
  for (const m of html.matchAll(r.anyIframeG)) {
    const src = m[1];
    if (!src || IGNORE_SRC.test(src)) continue;
    const abs = resolveUrl(src, pageUrl);
    if (hostOf(abs) !== pageHost) return abs;
  }
  return null;
}

export function firstEmbed(r, html, pageUrl) {
  for (const m of html.matchAll(r.anyIframeG)) {
    if (m[1] && !IGNORE_SRC.test(m[1])) return resolveUrl(m[1], pageUrl);
  }
  return null;
}

export function unescapeJs(s) {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\\//g, '/');
}

function isPlaylistUrl(s) {
  return s.startsWith('http') && (s.includes('.m3u8') || s.includes('/hls')) && !s.includes('\n');
}

/** First match of `re` whose base64 payload decodes (plain or reversed) to a playlist URL. */
function decodedPlaylist(re, html) {
  for (const m of html.matchAll(re)) {
    let decoded;
    try {
      decoded = atob(m[1]).trim();
    } catch {
      continue;
    }
    if (isPlaylistUrl(decoded)) return decoded;
    const reversed = [...decoded].reverse().join('').trim();
    if (isPlaylistUrl(reversed)) return reversed;
  }
  return null;
}

/**
 * Some embed hosts ship the player setup as an array of char codes that the page XORs, offsets
 * and eval()s. Pure arithmetic, so it is undone here; returns the decoded script or null.
 */
export function decodeCharcodeLoader(r, html) {
  const m = r.charcodeLoader.exec(html);
  if (!m) return null;
  const xor = Number(m[2]);
  const offset = Number(m[3]);
  let out = '';
  for (const n of m[1].split(',')) out += String.fromCharCode(((Number(n) ^ xor) - offset + 256) & 255);
  return out;
}

/**
 * Playlist URL in a player page: plain (JSON-escaped) first, then base64 (atob), then any long
 * base64 literal that decodes - plain or reversed - to a playlist URL, then the same search
 * inside a decoded char-code loader.
 */
export function findHls(r, html, depth = 0) {
  const plain = firstGroup(r.hlsUrl, html, null);
  if (plain) return unescapeJs(plain);
  const viaAtob = decodedPlaylist(r.hlsUrlBase64G, html);
  if (viaAtob) return viaAtob;
  const viaLiteral = decodedPlaylist(r.base64LiteralG, html);
  if (viaLiteral) return viaLiteral;
  if (depth === 0) {
    const decoded = decodeCharcodeLoader(r, html);
    if (decoded) return findHls(r, decoded, depth + 1);
  }
  return null;
}

/**
 * Player pages that load their real player through a JSON call instead of a static <iframe>:
 * returns { path, id, fallback } (URLs relative to the page) or null when the page is not one.
 */
export function playerApiHint(r, html) {
  const path = firstGroup(r.playerApiPath, html, null);
  if (!path) return null;
  return {
    path,
    id: firstGroup(r.playerChannelId, html, null),
    fallback: firstGroup(r.playerApiFallback, html, null),
  };
}
