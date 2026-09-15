// Talks to the sports site: remote config, schedule (SiteRepository.java) and stream resolution
// (StreamResolver.java). Everything here runs inside the Worker, never in the browser.
import { buildRules } from './rules.js';
import {
  parseListing, parseCards, parseShowMore, mergeStatus, parseServers, playerState,
  mainEmbed, firstEmbed, findHls, playerApiHint, originOf, hostOf,
} from './parser.js';

const CONFIG_URL = 'https://raw.githubusercontent.com/PresidentStyx/styxsports/master/config.json';
const DEFAULT_CONFIG = {
  homeUrl: 'https://v5.gostreameast.link/',
  dataBaseUrl: 'https://v2.streameast.ga',
  // The site's account service: TV sign-in codes, account status, sign-out (Account.java).
  authBaseUrl: 'https://auth.streamea.st',
  allowedHostFragments: ['streameast', 'streamea.st'],
  parser: {},
  // 4.0 feature flags, per-platform minimum versions and APK version pins (flags.js).
  features: {},
  minVersion: {},
  pinned: {},
};

export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const AJAX_BATCH = 50;
const MAX_HOPS = 4;
const PAGE_TIMEOUT_MS = 12_000;
/** Embed hosts answer slowly (measured ~14 s for the site's primary one) but do answer. */
const HOP_TIMEOUT_MS = 22_000;

// Per-isolate memory: cheap and good enough between edge cache hits.
let configCache = { at: 0, value: null };
let discoveredBase = null;

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

function baseHeaders(referer) {
  const h = {
    'User-Agent': DESKTOP_UA,
    Accept: 'text/html,application/json,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (referer) h.Referer = referer;
  return h;
}

// Cookie jar. The site fronts its pages with an SSO handshake
// (/ -> auth.streamea.st/SsoHandoff.php -> /connect.php -> /) that only completes when the
// cookies set along the way are sent back; fetch(redirect: 'follow') drops them, and the
// resulting redirect loop trips the site's rate limiter. So redirects are followed by hand.
// Anonymous reads share one jar per isolate; a signed-in viewer carries their own (account.js).
const MAX_REDIRECTS = 8;

export class Jar {
  /** @param {Record<string, Record<string, string>>} [entries] domain -> { name: value } */
  constructor(entries) {
    this.map = new Map(); // domain -> Map(name -> value)
    this.dirty = false;
    if (entries) {
      for (const [domain, cookies] of Object.entries(entries)) this.map.set(domain, new Map(Object.entries(cookies)));
    }
  }

  header(host) {
    const parts = [];
    const h = host.toLowerCase();
    for (const [domain, cookies] of this.map) {
      if (h === domain || h.endsWith('.' + domain)) {
        for (const [k, v] of cookies) parts.push(`${k}=${v}`);
      }
    }
    return parts.join('; ');
  }

  store(host, res) {
    const list = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    for (const raw of list) {
      const [pair, ...attrs] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let domain = host.toLowerCase();
      let expired = false;
      for (const a of attrs) {
        const [k, v = ''] = a.trim().split('=');
        const key = k.toLowerCase();
        if (key === 'domain' && v) domain = v.trim().replace(/^\./, '').toLowerCase();
        if (key === 'max-age' && Number(v) <= 0) expired = true;
      }
      if (!this.map.has(domain)) this.map.set(domain, new Map());
      const cookies = this.map.get(domain);
      if (expired || value === 'deleted') {
        if (cookies.delete(name)) this.dirty = true;
      } else if (cookies.get(name) !== value) {
        cookies.set(name, value);
        this.dirty = true;
      }
    }
  }

  /** Plain object for serialisation (empty domains dropped). */
  toJSON() {
    const out = {};
    for (const [domain, cookies] of this.map) {
      if (cookies.size) out[domain] = Object.fromEntries(cookies);
    }
    return out;
  }

  get size() {
    let n = 0;
    for (const cookies of this.map.values()) n += cookies.size;
    return n;
  }
}

const sharedJar = new Jar();

/** fetch() with cookies and manual redirects; resolves to the final response. */
export async function request(url, { method = 'GET', body, headers = {}, referer, timeoutMs = PAGE_TIMEOUT_MS, jar = sharedJar } = {}) {
  let current = url;
  let m = method;
  let b = body;
  let extra = headers;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const host = hostOf(current);
    const cookie = jar.header(host);
    const res = await fetch(current, {
      method: m,
      body: b,
      headers: { ...baseHeaders(referer), ...extra, ...(cookie ? { Cookie: cookie } : {}) },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      cf: { cacheTtl: 0 },
    });
    jar.store(host, res);
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      current = new URL(location, current).toString();
      if (res.status !== 307 && res.status !== 308) { m = 'GET'; b = undefined; extra = {}; }
      continue;
    }
    return res;
  }
  throw new Error(`too many redirects from ${hostOf(url)}`);
}

export async function getText(url, { referer, timeoutMs = PAGE_TIMEOUT_MS, init = {}, jar } = {}) {
  const res = await request(url, {
    method: init.method || 'GET',
    body: init.body,
    headers: init.headers || {},
    referer,
    timeoutMs,
    jar,
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status} from ${hostOf(res.url || url)}`);
  }
  return res.text();
}

export async function postForm(url, body, { referer, jar } = {}) {
  return getText(url, {
    referer,
    jar,
    init: {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

export async function loadConfig() {
  if (configCache.value && Date.now() - configCache.at < 5 * 60_000) return configCache.value;
  let cfg = { ...DEFAULT_CONFIG };
  try {
    const res = await fetch(CONFIG_URL, { signal: AbortSignal.timeout(6000), cf: { cacheTtl: 300 } });
    if (res.ok) {
      const o = await res.json();
      if (typeof o.homeUrl === 'string' && o.homeUrl.startsWith('http')) cfg.homeUrl = o.homeUrl;
      if (typeof o.dataBaseUrl === 'string' && o.dataBaseUrl.startsWith('http')) cfg.dataBaseUrl = o.dataBaseUrl;
      if (typeof o.authBaseUrl === 'string' && o.authBaseUrl.startsWith('http')) cfg.authBaseUrl = o.authBaseUrl;
      if (Array.isArray(o.allowedHostFragments) && o.allowedHostFragments.length) {
        cfg.allowedHostFragments = o.allowedHostFragments.filter((s) => typeof s === 'string');
      }
      if (o.parser && typeof o.parser === 'object') cfg.parser = o.parser;
      for (const k of ['features', 'minVersion', 'pinned']) {
        if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) cfg[k] = o[k];
      }
    }
  } catch {
    // defaults
  }
  cfg.dataBaseUrl = cfg.dataBaseUrl.replace(/\/+$/, '');
  cfg.authBaseUrl = cfg.authBaseUrl.replace(/\/+$/, '');
  cfg.rules = buildRules(cfg.parser);
  cfg.isAllowedHost = (host) => {
    const h = (host || '').toLowerCase();
    return cfg.allowedHostFragments.some((f) => h.includes(f.toLowerCase()));
  };
  configCache = { at: Date.now(), value: cfg };
  return cfg;
}

// ---------------------------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------------------------

/** Full refresh: listing page, then the "load more" batches, then the live-status feed. */
export async function fetchSchedule(cfg) {
  const candidates = [];
  if (discoveredBase) candidates.push(discoveredBase);
  if (!candidates.includes(cfg.dataBaseUrl)) candidates.push(cfg.dataBaseUrl);

  let last = null;
  for (const base of candidates) {
    try {
      const s = await fetchFrom(cfg, base);
      if (s.events.length) {
        discoveredBase = base;
        return s;
      }
    } catch (e) {
      last = e;
    }
  }
  const found = await discoverBase(cfg);
  if (found && !candidates.includes(found)) {
    const s = await fetchFrom(cfg, found);
    if (s.events.length) {
      discoveredBase = found;
      return s;
    }
  }
  throw last || new Error('No events found');
}

export function currentBase(cfg) {
  return discoveredBase || cfg.dataBaseUrl;
}

async function fetchFrom(cfg, base) {
  const r = cfg.rules;
  const html = await getText(base + '/');
  const s = parseListing(r, html, base);
  if (!s.events.length) return s;
  const seen = new Set(s.events.map((e) => e.id));

  // "Show more" batches for the big categories, fetched in parallel.
  const jobs = [];
  for (const sm of parseShowMore(r, html)) {
    for (let i = 0; i < sm.ids.length; i += AJAX_BATCH) {
      const batch = sm.ids.slice(i, i + AJAX_BATCH);
      jobs.push(
        postForm(base + sm.endpoint, `category_id=${sm.categoryId}&ids=${batch.join(',')}`)
          .then((txt) => {
            const payload = JSON.parse(txt);
            return payload.ok ? parseCards(r, payload.html || '', base) : [];
          })
          .catch(() => []),
      );
    }
  }
  for (const list of await Promise.all(jobs)) {
    for (const e of list) if (!seen.has(e.id)) { seen.add(e.id); s.events.push(e); }
  }

  // Small categories (UFC, Boxing, ...) are often not inlined on the front page at all;
  // their dedicated "/<sport>-streams/" page lists them.
  const sportPaths = [];
  for (const m of html.matchAll(r.sportPageG)) if (!sportPaths.includes(m[1])) sportPaths.push(m[1]);
  const pageJobs = [];
  for (const c of s.categories) {
    if (c.liveCount + c.soonCount === 0 || s.events.some((e) => e.categoryId === c.id)) continue;
    const path = sportPathFor(c.name, sportPaths);
    if (!path) continue;
    pageJobs.push(
      getText(base + path)
        .then((page) => parseCards(r, page, base).map((e) => { if (!e.categoryId) e.categoryId = c.id; return e; }))
        .catch(() => []),
    );
  }
  for (const list of await Promise.all(pageJobs)) {
    for (const e of list) if (!seen.has(e.id)) { seen.add(e.id); s.events.push(e); }
  }

  try {
    mergeStatus(r, await getText(base + r.statusPath), s.events);
  } catch {
    // optional
  }
  s.fetchedAt = Date.now();
  return s;
}

function sportPathFor(categoryName, paths) {
  const slug = categoryName.toLowerCase().trim().replace(/ /g, '-');
  return paths.find((p) => p === `/${slug}-streams/`) || paths.find((p) => p.startsWith('/' + slug)) || null;
}

/** The gateway page links to mirror domains that 30x to the current real origin. */
async function discoverBase(cfg) {
  try {
    const html = await getText(cfg.homeUrl);
    const gatewayHost = hostOf(cfg.homeUrl);
    const tried = new Set();
    for (const m of html.matchAll(/href="(https?:\/\/([^"/]+)\/)"/g)) {
      const [, url, host] = m;
      if (host.toLowerCase() === gatewayHost || !cfg.isAllowedHost(host)) continue;
      if (tried.has(host)) continue;
      tried.add(host);
      try {
        const res = await request(url);
        await res.body?.cancel();
        const fin = new URL(res.url);
        if (cfg.isAllowedHost(fin.host)) return fin.protocol + '//' + fin.host;
      } catch {
        // next mirror
      }
      if (tried.size >= 4) break;
    }
  } catch {
    // gateway unreachable
  }
  return null;
}

/** Live clocks/scores only. */
export async function fetchStatus(cfg) {
  return getText(currentBase(cfg) + cfg.rules.statusPath);
}

// ---------------------------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------------------------

/**
 * The stream page and its server tabs (fast; no embed hops). With a signed-in viewer's `jar` the
 * page comes back with that account's premium servers playable.
 */
export async function streamPage(cfg, streamPageUrl, jar) {
  const html = await getText(streamPageUrl, { jar });
  const servers = parseServers(cfg.rules, html, streamPageUrl);
  let activeIndex = 0;
  servers.forEach((s, i) => { if (s.active) activeIndex = i; });
  if (!servers.length) servers.push({ name: 'Server 1', pageUrl: streamPageUrl, active: true, premium: false });
  return { servers, activeIndex, html };
}

/** Resolves one server to its playlist, reusing the page HTML for the page's active server. */
export async function resolveServer(cfg, server, page, jar) {
  const html = page && page.servers[page.activeIndex] === server ? page.html : await getText(server.pageUrl, { jar });
  return resolveFromHtml(cfg.rules, server, html);
}

async function resolveFromHtml(r, server, pageHtml) {
  const state = playerState(r, pageHtml);
  const embedUrl = mainEmbed(r, pageHtml, server.pageUrl);
  const base = { server: server.name, pageUrl: server.pageUrl, state, hlsUrl: null, playerOrigin: null, embed: null, log: [] };
  if (!embedUrl) {
    // Premium servers have no iframe: the stream page itself carries the player.
    const onPage = findHls(r, pageHtml);
    if (onPage) {
      base.hlsUrl = onPage;
      base.playerOrigin = originOf(server.pageUrl);
      base.log.push('hls on the stream page');
      return base;
    }
    base.log.push('no embed');
    return base;
  }
  base.embed = embedUrl;

  let hop = { url: embedUrl, referer: server.pageUrl };
  for (let depth = 0; depth < MAX_HOPS; depth++) {
    let inner;
    try {
      inner = await fetchHop(hop);
    } catch (e) {
      base.log.push(`hop ${depth} ${hostOf(hop.url)} failed: ${e.message}`);
      break;
    }
    const hls = findHls(r, inner);
    if (hls) {
      base.hlsUrl = hls;
      base.playerOrigin = originOf(hop.url);
      base.log.push(`hls at depth ${depth} on ${hostOf(hop.url)}`);
      return base;
    }
    let next = firstEmbed(r, inner, hop.url);
    if (!next) {
      next = await playerViaApi(r, inner, hop.url, base.log);
    }
    if (!next) {
      base.log.push(`dead end at ${hostOf(hop.url)} (${inner.length} chars)`);
      break;
    }
    hop = { url: next, referer: hop.url };
  }
  return base;
}

/**
 * Pages whose <iframe> starts as about:blank and get the real player URL from a JSON endpoint
 * (fetch("api/player.php?id=N") -> {"url": ...}), with a literal fallback URL on the page.
 */
async function playerViaApi(r, html, pageUrl, log) {
  const hint = playerApiHint(r, html);
  if (!hint) return null;
  if (hint.id) {
    try {
      const apiUrl = new URL(hint.path + hint.id, pageUrl).toString();
      const data = JSON.parse(await getText(apiUrl, { referer: pageUrl, timeoutMs: HOP_TIMEOUT_MS }));
      if (data && typeof data.url === 'string' && data.url) {
        log.push(`player url via api on ${hostOf(pageUrl)}`);
        return new URL(data.url, pageUrl).toString();
      }
    } catch (e) {
      log.push(`player api on ${hostOf(pageUrl)} failed: ${e.message}`);
    }
  }
  if (hint.fallback) {
    log.push(`player url via fallback literal on ${hostOf(pageUrl)}`);
    return new URL(hint.fallback, pageUrl).toString();
  }
  return null;
}

/**
 * Embed hosts are flaky: one dropped connection or a 403 is not a verdict on the server. Every
 * subrequest leaves Cloudflare from a different IPv4 address, so a retry is also a fresh IP.
 */
const HOP_ATTEMPTS = 3;
const HOP_RETRY_PAUSE_MS = 250;

async function fetchHop(hop) {
  let last;
  for (let attempt = 1; attempt <= HOP_ATTEMPTS; attempt++) {
    try {
      return await getText(hop.url, { referer: hop.referer, timeoutMs: HOP_TIMEOUT_MS });
    } catch (e) {
      last = e;
      if (e && e.name === 'TimeoutError') throw e; // a host this slow will not recover within a retry
      if (/^HTTP 4(?!03|29)\d\d/.test(e && e.message || '')) throw e; // 404 etc. will not change
      if (attempt < HOP_ATTEMPTS) await new Promise((res) => setTimeout(res, HOP_RETRY_PAUSE_MS));
    }
  }
  throw last;
}
