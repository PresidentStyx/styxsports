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
