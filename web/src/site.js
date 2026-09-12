// Talks to the sports site: remote config, schedule (SiteRepository.java) and stream resolution
// (StreamResolver.java). Everything here runs inside the Worker, never in the browser.
import { buildRules } from './rules.js';
import {
  parseListing, parseCards, parseShowMore, mergeStatus, parseServers, playerState,
  mainEmbed, firstEmbed, findHls, originOf, hostOf,
} from './parser.js';

const CONFIG_URL = 'https://raw.githubusercontent.com/PresidentStyx/styxsports/master/config.json';
const DEFAULT_CONFIG = {
  homeUrl: 'https://v5.gostreameast.link/',
  dataBaseUrl: 'https://v2.streameast.ga',
  allowedHostFragments: ['streameast', 'streamea.st'],
  parser: {},
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

// Cookie jar, per isolate. The site fronts its pages with an SSO handshake
// (/ -> auth.streamea.st/SsoHandoff.php -> /connect.php -> /) that only completes when the
// cookies set along the way are sent back; fetch(redirect: 'follow') drops them, and the
// resulting redirect loop trips the site's rate limiter. So redirects are followed by hand.
const jar = new Map(); // host -> Map(name -> value)
const MAX_REDIRECTS = 8;

function cookieHeader(host) {
  const parts = [];
  const h = host.toLowerCase();
  for (const [domain, cookies] of jar) {
    if (h === domain || h.endsWith('.' + domain)) {
      for (const [k, v] of cookies) parts.push(`${k}=${v}`);
    }
  }
  return parts.join('; ');
}

function storeCookies(host, res) {
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
    if (!jar.has(domain)) jar.set(domain, new Map());
    if (expired || value === 'deleted') jar.get(domain).delete(name);
    else jar.get(domain).set(name, value);
  }
}

/** fetch() with cookies and manual redirects; resolves to the final response. */
export async function request(url, { method = 'GET', body, headers = {}, referer, timeoutMs = PAGE_TIMEOUT_MS } = {}) {
  let current = url;
  let m = method;
  let b = body;
  let extra = headers;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const host = hostOf(current);
    const cookie = cookieHeader(host);
    const res = await fetch(current, {
      method: m,
      body: b,
      headers: { ...baseHeaders(referer), ...extra, ...(cookie ? { Cookie: cookie } : {}) },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      cf: { cacheTtl: 0 },
    });
    storeCookies(host, res);
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

export async function getText(url, { referer, timeoutMs = PAGE_TIMEOUT_MS, init = {} } = {}) {
  const res = await request(url, {
    method: init.method || 'GET',
    body: init.body,
    headers: init.headers || {},
    referer,
    timeoutMs,
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status} from ${hostOf(res.url || url)}`);
  }
  return res.text();
}

async function postForm(url, body) {
  return getText(url, {
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
      if (Array.isArray(o.allowedHostFragments) && o.allowedHostFragments.length) {
        cfg.allowedHostFragments = o.allowedHostFragments.filter((s) => typeof s === 'string');
      }
      if (o.parser && typeof o.parser === 'object') cfg.parser = o.parser;
    }
  } catch {
    // defaults
  }
  cfg.dataBaseUrl = cfg.dataBaseUrl.replace(/\/+$/, '');
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

/** The stream page and its server tabs (fast; no embed hops). */
export async function streamPage(cfg, streamPageUrl) {
  const html = await getText(streamPageUrl);
  const servers = parseServers(cfg.rules, html, streamPageUrl);
  let activeIndex = 0;
  servers.forEach((s, i) => { if (s.active) activeIndex = i; });
  if (!servers.length) servers.push({ name: 'Server 1', pageUrl: streamPageUrl, active: true, premium: false });
  return { servers, activeIndex, html };
}

/** Resolves one server to its playlist, reusing the page HTML for the page's active server. */
export async function resolveServer(cfg, server, page) {
  const html = page && page.servers[page.activeIndex] === server ? page.html : await getText(server.pageUrl);
  return resolveFromHtml(cfg.rules, server, html);
}

async function resolveFromHtml(r, server, pageHtml) {
  const state = playerState(r, pageHtml);
  const embedUrl = mainEmbed(r, pageHtml, server.pageUrl);
  const base = { server: server.name, pageUrl: server.pageUrl, state, hlsUrl: null, playerOrigin: null, embed: null, log: [] };
  if (!embedUrl) {
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
    const next = firstEmbed(r, inner, hop.url);
    if (!next) {
      base.log.push(`dead end at ${hostOf(hop.url)} (${inner.length} chars)`);
      break;
    }
    hop = { url: next, referer: hop.url };
  }
  return base;
}

/** Embed hosts are flaky: one dropped connection is not a verdict on the server. */
async function fetchHop(hop) {
  try {
    return await getText(hop.url, { referer: hop.referer, timeoutMs: HOP_TIMEOUT_MS });
  } catch (e) {
    if (e && e.name === 'TimeoutError') throw e; // a host this slow will not recover within a retry
    return getText(hop.url, { referer: hop.referer, timeoutMs: HOP_TIMEOUT_MS });
  }
}
