// Site markup rules: the JavaScript twin of the Android app's ParserRules.java.
// Defaults live here; keys in config.json's "parser" object override them (Java regex syntax is
// close enough to JS for these patterns; a leading (?i) becomes the i flag).

const DEFAULTS = {
  cardStart: '<(?:div|a)\\s+class="m-card\\b([^"]*)"([^>]*)>',
  cardTitle: 'm-card__title"[^>]*>([^<]*)<',
  cardLink: 'class="m-card__link"[^>]*?href="([^"]+)"',
  liveText: 'status-(?:live|final)"[^>]*>([^<]*)<',
  endedText: '(?i)\\s*(final.*|ft|full[ -]?time|ended|finished|game over)\\s*',
  homeScore: 'data-split-home-score="[^"]*"[^>]*>([^<]*)<',
  awayScore: 'data-split-away-score="[^"]*"[^>]*>([^<]*)<',
  catButton: '<button\\b[^>]*class="m-cat-band__item[^"]*"[^>]*>',
  catLabel: 'm-cat-band__label">([^<]*)<',
  catLive: 'm-hud-live">(\\d+)<',
  catSoon: 'm-hud-soon">(\\d+)<',
  showMore: '<button\\b[^>]*class="m-show-more"[^>]*>',
  sportPage: 'href="(/([a-z0-9-]+)-streams/)"',
  serverItem: '<li\\s+class="se-stream\\b([^"]*)"[^>]*>\\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)</li>',
  serverName: 'se-stream__name"[^>]*>([^<]*)<',
  playerState: 'id="se-player-root"[^>]*data-state="([^"]*)"',
  embedIframe: '<iframe[^>]*\\bid="iframe"[^>]*\\ssrc="([^"]+)"',
  anyIframe: '<iframe[^>]*\\ssrc="([^"]+)"',
  hlsUrl: '["\'](https?:[^"\']+\\.m3u8[^"\']*)["\']',
  hlsUrlBase64: 'atob\\(\\s*["\']([A-Za-z0-9+/=]{16,})["\']\\s*\\)',
  // Any long quoted base64 string; the premium player passes its playlist URL through one, reversed.
  base64Literal: '["\']([A-Za-z0-9+/]{40,}={0,2})["\']',
  // Player pages whose <iframe> starts as about:blank and get their real player URL from a JSON
  // call: fetch("api/player.php?id=" + id) -> {"url": ...}; group 1 = the path up to the id.
  playerApiPath: '["\']([^"\'<>\\s]*?api/player\\.php\\?id=)["\']',
  playerChannelId: 'loadPlayerChannel\\((\\d+)\\)',
  playerApiFallback: 'initialPlayerUrlFallback\\s*=\\s*["\']([^"\']+)["\']',
  // Obfuscated loader: var a=[n,n,n,...],k=<xor>,o=<offset>; text = fromCharCode(((n^k)-o+256)&255).
  charcodeLoader: 'var\\s+\\w+\\s*=\\s*\\[(\\d+(?:\\s*,\\s*\\d+){99,})\\]\\s*,\\s*\\w+\\s*=\\s*(\\d+)\\s*,\\s*\\w+\\s*=\\s*(\\d+)',
  // The account page's IPTV tab: <input id="iptv-m3u-plus" class="acc-iptv-url-input" value="...">.
  iptvUrlInput: '<input[^>]*\\bid="([^"]+)"[^>]*class="acc-iptv-url-input"[^>]*\\bvalue="([^"]+)"',
};

const STRINGS = {
  statusPath: '/data/espn_status_batch.json',
  attrId: 'data-match-id',
  attrIdAlt: 'data-mac-id',
  attrCategory: 'data-cat-id',
  attrTime: 'data-time',
  attrTeams: 'data-team-names',
  attrHot: 'data-hot-game',
  attrHotRank: 'data-hot-rank',
  attrPro: 'data-pro-only',
  attrLeague: 'data-league-key',
  attrLeagueAlt: 'data-sport-tag',
  attrMarkHome: 'data-mark-home',
  attrMarkAway: 'data-mark-away',
  liveClass: 'm-card--live',
  hotClass: 'm-card--hot',
  serverActiveClass: 'is-active',
  serverProClass: 'is-pro',
};

function compile(source, extraFlags = '') {
  let flags = 's' + extraFlags;
  let src = source;
  if (src.startsWith('(?i)')) {
    src = src.slice(4);
    flags += 'i';
  }
  return new RegExp(src, flags);
}

/** @param overrides the config's "parser" object (may be undefined). */
export function buildRules(overrides = {}) {
  const rules = {};
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const o = typeof overrides[key] === 'string' ? overrides[key].trim() : '';
    let re;
    try {
      re = compile(o || def);
    } catch {
      re = compile(def); // a broken override must not take the site down
    }
    rules[key] = re;
    // Global variants for scanning loops.
    rules[key + 'G'] = new RegExp(re.source, re.flags + 'g');
  }
  for (const [key, def] of Object.entries(STRINGS)) {
    const o = typeof overrides[key] === 'string' ? overrides[key].trim() : '';
    rules[key] = o || def;
  }
  return rules;
}

export function firstGroup(re, text, fallback = '') {
  const m = re.exec(text);
  return m ? m[1] : fallback;
}
