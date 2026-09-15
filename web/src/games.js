// Game State Service. One normalized game shape for every client (web, APK, Roku), built from
// the site's listing (/api/schedule) and its live-status feed (/api/status), plus what neither of
// them carries: team colors and abbreviations (design/teams.json, crest fills as a fallback), a
// closeness score per league, a heat score, and a scoring timeline derived by diffing consecutive
// status snapshots in the `Games` Durable Object (no play-by-play feed exists).
//
// What the source gives per game (spike, Sep 2026, uniform across leagues): a status text
// (`vTxt`: "4th", "End 7th", "Bot 5th", "Final", "Halftime"), a status class (live / final),
// both scores (`mScH` / `mScA`), a timestamp; on finals `esEnd` / `endLab`. There is no game
// clock and no situation (down & distance, possession), so `period.clock` and `situation` are
// null unless a status text happens to carry them ("Q4 4:12", "67'"). The DO tallies status-text
// shapes per league (`coverage()`) so new formats show up in /api/games/coverage.
//
// Naming: `home` / `away` follow the site's "H" / "A" (the first- and second-listed team),
// which is what the schedule, the APK and the Roku already call them. For US sports the first
// listed team is usually the visitor; clients display in listed order and should not draw a
// "home" badge from these fields.
import { DurableObject } from 'cloudflare:workers';
import teamsData from '../../design/teams.json';

const CLOCK_RE = /\b(\d{1,3}:\d{2})\b/;
const MINUTE_RE = /\b(\d{1,3})\s*'/;
const ORDINAL_RE = /\b(\d{1,2})(?:st|nd|rd|th)\b/i;
const QUARTER_RE = /\bQ\s?(\d)\b/i;
const INNING_RE = /\b(?:top|mid|bot|bottom|end)\s+(?:of\s+)?(?:the\s+)?(\d{1,2})/i;
const PERIOD_WORD_RE = /\b(\d)(?:st|nd|rd|th)\s+(?:period|per|qtr|quarter)\b/i;
const OT_RE = /\b(OT|overtime|extra|ET|shootout|SO|penalties)\b/i;
const HALF_RE = /\b(half|halftime|HT)\b/i;
const DELAY_RE = /\b(delay|delayed|postponed|suspended|rain|weather)\b/i;
const FINAL_RE = /\b(final|ft|full[- ]time|ended)\b/i;
/** Leagues the site names vs how the rules and design tokens know them. */
const LEAGUE_ALIASES = { 'NCAA Football': 'NCAAF', 'College Football': 'NCAAF', 'NCAA Basketball': 'NCAAB', 'College Basketball': 'NCAAB', 'Football': 'Soccer', 'Formula 1': 'F1' };
const FOOTBALL = new Set(['NFL', 'NCAAF', 'CFL', 'XFL', 'UFL']);
const BASEBALL = new Set(['MLB']);
const BASKETBALL = new Set(['NBA', 'WNBA', 'NCAAB']);
const HOCKEY = new Set(['NHL']);
const SOCCER = new Set(['Soccer', 'MLS', 'EPL', 'Premier League', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1', 'Champions League', 'UEFA']);

const leagueName = (raw) => LEAGUE_ALIASES[raw] || raw || 'Other';
const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const toInt = (v) => { const n = parseInt(String(v ?? '').trim(), 10); return Number.isFinite(n) ? n : null; };
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// ---------------------------------------------------------------------------------------------
// Teams: abbreviation + two brand colors
// ---------------------------------------------------------------------------------------------

/** "Kansas City Chiefs" -> "KCC" when the team is not in teams.json; single-word -> first 3. */
function initials(name) {
  const words = String(name).replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.slice(0, 3).map((w) => w[0]).join('').toUpperCase();
}

const crestColorCache = new Map(); // crest url -> ['#rrggbb', '#rrggbb'] | null (per isolate)

/**
 * The two most used fills of a crest SVG, ignoring whites / blacks / greys and near-duplicates.
 * Good enough for a hero backdrop when the team is not in teams.json; never blocks: resolves
 * to null on any problem and the league colors are used.
 */
export async function crestColors(url) {
  if (!url || !/\.svg(\?|$)/i.test(url)) return null;
  if (crestColorCache.has(url)) return crestColorCache.get(url);
  let out = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000), cf: { cacheTtl: 86400, cacheEverything: true } });
    if (res.ok) {
      const svg = (await res.text()).slice(0, 200_000);
      const counts = new Map();
      for (const m of svg.matchAll(/(?:fill|stop-color)\s*[:=]\s*["']?\s*#([0-9a-f]{3}|[0-9a-f]{6})\b/gi)) {
        const hex = normalizeHex(m[1]);
        if (!hex || isNeutral(hex)) continue;
        counts.set(hex, (counts.get(hex) || 0) + 1);
      }
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h);
      const picked = [];
      for (const h of ranked) {
        if (picked.every((p) => colorDistance(p, h) > 60)) picked.push(h);
        if (picked.length === 2) break;
      }
      if (picked.length) out = picked.length === 2 ? picked : [picked[0], shade(picked[0], -0.35)];
    }
  } catch { /* league colors */ }
  crestColorCache.set(url, out);
  return out;
}

function normalizeHex(h) {
  h = h.toLowerCase();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return h.length === 6 ? '#' + h : null;
}
function rgb(hex) { return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); }
function isNeutral(hex) {
  const [r, g, b] = rgb(hex);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max - min < 28 || max < 40 || min > 225; // grey, near-black, near-white
}
function colorDistance(a, b) {
  const [r1, g1, b1] = rgb(a), [r2, g2, b2] = rgb(b);
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
}
function shade(hex, amount) {
  const c = rgb(hex).map((v) => Math.round(Math.max(0, Math.min(255, v + (amount < 0 ? v * amount : (255 - v) * amount)))));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** { id, name, short, crest, colors, known } for one team. */
async function team(name, crest, league) {
  const entry = teamsData.teams[name];
  const leagueColors = (teamsData.leagues[league] || {}).colors || ['#1f2a44', '#c8102e'];
  let colors = entry ? entry.colors : await crestColors(crest);
  return {
    id: slug(name),
    name,
    short: entry ? entry.short : initials(name),
    crest: crest || '',
    colors: colors || leagueColors,
    known: !!entry,
  };
}

// ---------------------------------------------------------------------------------------------
// Period / state / closeness
// ---------------------------------------------------------------------------------------------

/** Splits "Q4 4:12" / "End 7th" / "67'" into { label, clock, n, ot, half } for the rules below. */
export function parsePeriod(text) {
  const t = String(text || '').trim();
  const clockM = CLOCK_RE.exec(t);
  const clock = clockM ? clockM[1] : null;
  const label = clock ? t.replace(clockM[0], '').replace(/\s{2,}/g, ' ').trim() : t;
  let n = null;
  const m = PERIOD_WORD_RE.exec(t) || QUARTER_RE.exec(t) || INNING_RE.exec(t) || ORDINAL_RE.exec(t);
  if (m) n = toInt(m[1]);
  const minuteM = MINUTE_RE.exec(t);
  const minute = minuteM ? toInt(minuteM[1]) : null;
  return { label, clock, n, minute, ot: OT_RE.test(t), half: HALF_RE.test(t) };
}

export function gameState(e, statusText) {
  const p = parsePeriod(statusText);
  if (e.ended || FINAL_RE.test(statusText)) return 'final';
  if (!e.live) return 'pre';
  if (DELAY_RE.test(statusText)) return 'delayed';
  if (p.half) return 'halftime';
  return 'live';
}

/**
 * 0..1: how much a live game is worth switching to right now. Per-league rules from the plan,
 * without a clock (the source has none): "late" means the last regulation period or overtime.
 */
export function closeness(league, state, period, score) {
  if (state !== 'live' && state !== 'halftime' && state !== 'delayed') return 0;
  if (score.home == null || score.away == null) return 0;
  const diff = Math.abs(score.home - score.away);
  const n = period.n, ot = period.ot;
  if (FOOTBALL.has(league)) {
    if (ot || n === 4) return diff <= 8 ? 1 : diff <= 16 ? 0.6 : 0.2;
    if (n === 3) return diff <= 8 ? 0.55 : diff <= 16 ? 0.35 : 0.1;
    return clamp01(0.4 - diff / 60);
  }
  if (BASEBALL.has(league)) {
    if (ot || (n != null && n >= 9)) return diff <= 2 ? 1 : diff <= 4 ? 0.5 : 0.15;
    if (n != null && n >= 7) return diff <= 2 ? 0.7 : diff <= 4 ? 0.4 : 0.1;
    return diff <= 1 ? 0.45 : clamp01(0.3 - diff / 20);
  }
  if (BASKETBALL.has(league)) {
    if (ot || n === 4) return diff <= 6 ? 1 : diff <= 12 ? 0.55 : 0.15;
    if (n === 3) return diff <= 8 ? 0.5 : 0.25;
    return clamp01(0.35 - diff / 60);
  }
  if (HOCKEY.has(league)) {
    if (ot || n === 3) return diff <= 1 ? 1 : diff <= 2 ? 0.5 : 0.15;
    return diff <= 1 ? 0.5 : 0.2;
  }
  if (SOCCER.has(league)) {
    const late = ot || (period.minute != null && period.minute >= 70) || n === 2;
    if (late) return diff <= 1 ? 1 : 0.2;
    return diff <= 1 ? 0.55 : 0.2;
  }
  return diff <= 3 ? 0.6 : diff <= 7 ? 0.35 : 0.15; // anything else with a score
}

/** 0..1: what to put first. The site's hot rank (#1 is what most people opened) plus closeness. */
export function heat(e, state, close) {
  const rank = e.hotRank > 0 ? clamp01(1 - (e.hotRank - 1) / 10) : (e.hot ? 0.5 : 0);
  if (state === 'final') return clamp01(0.15 * rank);
  if (state === 'pre') return clamp01(0.3 * rank);
  return clamp01(0.55 * rank + 0.45 * close);
}

// ---------------------------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------------------------

/**
 * @param schedule  the /api/schedule body ({ categories, events, fetchedAt, base })
 * @param status    the /api/status body ({ generated_at, m: { id: {...} } }) or null
 * @param crestUrl  maps an event's crest field to the URL clients load (the /img proxy)
 * @param rawCrest  maps it to the URL the Worker can read the SVG from (for colors)
 */
export async function normalizeGames(schedule, status, { crestUrl = (u) => u, rawCrest = (u) => u } = {}) {
  const cats = new Map((schedule.categories || []).map((c) => [c.id, c]));
  const m = status && status.m && typeof status.m === 'object' ? status.m : {};
  const games = [];
  for (const e of schedule.events || []) {
    const st = m[e.id] || null;
    const cat = cats.get(e.categoryId);
    const league = leagueName(cat ? cat.name : e.league);
    const statusText = st ? String(st.vTxt || st.endLab || '').trim() : e.liveText || '';
    const ended = e.ended || (st ? (st.esEnd === 1 || String(st.vCls || '').includes('final')) : false);
    const live = !ended && (e.live || (st ? st.lw === true || String(st.vCls || '').includes('live') : false));
    const ev = { ...e, live, ended };
    const state = gameState(ev, statusText);
    const period = parsePeriod(statusText);
    const score = scoreOf(st, e);
    const single = !e.away; // UFC card, race, wrestling show: one title, no opponent
    const [home, away] = await Promise.all([
      team(e.home, rawCrest(e.crestHome), league),
      single ? null : team(e.away, rawCrest(e.crestAway), league),
    ]);
    const close = closeness(league, state, period, score);
    const g = {
      id: String(e.id),
      slug: [slug(league), slug(e.home), single ? '' : slug(e.away)].filter(Boolean).join('-'),
      league,
      leagueId: slug(league),
      title: single ? e.home : `${e.home} vs ${e.away}`,
      single,
      home: { ...home, crest: crestUrl(e.crestHome) },
      away: away ? { ...away, crest: crestUrl(e.crestAway) } : null,
      state,
      score: single ? null : score,
      period: state === 'pre' ? null : { label: period.label || (state === 'final' ? 'Final' : ''), clock: period.clock, n: period.n, overtime: period.ot },
      situation: null, // the source has no down & distance / possession
      statusText,
      startsAt: e.startTs ? e.startTs * 1000 : null,
      updatedAt: st && st.ts ? st.ts * 1000 : null,
      hotRank: e.hotRank || null,
      closeness: round2(close),
      heat: round2(heat(e, state, close)),
      streams: { pageUrl: e.url, premiumOnly: !!e.premium },
      scoring: [], // filled from the Games DO
    };
    games.push(g);
  }
  return games;
}

function scoreOf(st, e) {
  let home = st ? toInt(st.mScH) : null;
  let away = st ? toInt(st.mScA) : null;
  if (home == null || away == null) {
    const m = /^\s*(\d+)\s*[-–:]\s*(\d+)\s*$/.exec(st && st.vSc ? st.vSc : e.score || '');
    if (m) { home = toInt(m[1]); away = toInt(m[2]); }
  }
  return { home, away };
}
const round2 = (x) => Math.round(x * 100) / 100;

/** Sorted the way Home shows them: live by heat, then upcoming by start, then finals. */
export function sortGames(games) {
  const rank = { live: 0, halftime: 0, delayed: 0, pre: 1, final: 2 };
  return [...games].sort((a, b) => {
    const ra = rank[a.state] ?? 1, rb = rank[b.state] ?? 1;
    if (ra !== rb) return ra - rb;
    if (ra === 0) return b.heat - a.heat || (a.hotRank || 99) - (b.hotRank || 99);
    if (ra === 1) return (a.startsAt || 0) - (b.startsAt || 0);
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

/** ~1 KB per 20 games: what the score bug and the game switcher poll every 15 s. */
export function liveSummary(games) {
  return games.filter((g) => g.state !== 'pre').map((g) => ({
    id: g.id, state: g.state, score: g.score, period: g.period && { label: g.period.label, clock: g.period.clock },
    heat: g.heat, closeness: g.closeness, last: g.scoring.length ? g.scoring[g.scoring.length - 1].at : null,
  }));
}

// ---------------------------------------------------------------------------------------------
// Scoring timeline + coverage: the Games Durable Object
// ---------------------------------------------------------------------------------------------

const KEEP_MS = 36 * 60 * 60_000;

export class Games extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS scores (
        game_id TEXT PRIMARY KEY, home INTEGER, away INTEGER, state TEXT NOT NULL, updated INTEGER NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS scoring (
        game_id TEXT NOT NULL, at INTEGER NOT NULL, team TEXT NOT NULL, delta INTEGER NOT NULL,
        home INTEGER NOT NULL, away INTEGER NOT NULL)`);
      sql.exec('CREATE INDEX IF NOT EXISTS idx_scoring_game ON scoring(game_id, at)');
      sql.exec(`CREATE TABLE IF NOT EXISTS coverage (
        league TEXT NOT NULL, shape TEXT NOT NULL, example TEXT NOT NULL, n INTEGER NOT NULL, last INTEGER NOT NULL,
        PRIMARY KEY (league, shape))`);
    });
  }

  /**
   * Feed the latest snapshot; returns { id: [scoring events] } for every game in it. A score
   * change between two snapshots of a live game becomes one event per team that scored, with
   * the delta and the score after it.
   */
  async record(snapshot) {
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    const out = {};
    for (const g of snapshot) {
      const prev = sql.exec('SELECT home, away, state FROM scores WHERE game_id = ?', g.id).toArray()[0];
      const h = g.score ? g.score.home : null, a = g.score ? g.score.away : null;
      if (prev && h != null && a != null && prev.home != null && prev.away != null && (g.state === 'live' || g.state === 'halftime' || g.state === 'final')) {
        if (h > prev.home) sql.exec('INSERT INTO scoring VALUES (?, ?, ?, ?, ?, ?)', g.id, now, 'home', h - prev.home, h, a);
        if (a > prev.away) sql.exec('INSERT INTO scoring VALUES (?, ?, ?, ?, ?, ?)', g.id, now, 'away', a - prev.away, h, a);
      }
      sql.exec(
        `INSERT INTO scores (game_id, home, away, state, updated) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(game_id) DO UPDATE SET home = excluded.home, away = excluded.away, state = excluded.state, updated = excluded.updated`,
        g.id, h, a, g.state, now,
      );
      if (g.statusText) {
        const shape = g.statusText.replace(/\d+/g, '#').slice(0, 40);
        sql.exec(
          `INSERT INTO coverage (league, shape, example, n, last) VALUES (?, ?, ?, 1, ?)
           ON CONFLICT(league, shape) DO UPDATE SET n = coverage.n + 1, last = excluded.last, example = excluded.example`,
          g.league, shape, g.statusText.slice(0, 60), now,
        );
      }
    }
    const ids = snapshot.map((g) => g.id);
    if (ids.length) {
      const rows = sql.exec(
        `SELECT game_id, at, team, delta, home, away FROM scoring WHERE game_id IN (${ids.map(() => '?').join(',')}) ORDER BY at`,
        ...ids,
      ).toArray();
      for (const r of rows) (out[r.game_id] ||= []).push({ at: Number(r.at), team: r.team, delta: Number(r.delta), score: { home: Number(r.home), away: Number(r.away) } });
    }
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(now + 60 * 60_000);
    return out;
  }

  /** Status-text shapes seen per league: which fields we can count on, learned from traffic. */
  async coverage() {
    return this.ctx.storage.sql.exec('SELECT league, shape, example, n, last FROM coverage ORDER BY league, n DESC').toArray()
      .map((r) => ({ league: r.league, shape: r.shape, example: r.example, n: Number(r.n), last: Number(r.last) }));
  }

  async alarm() {
    const cutoff = Date.now() - KEEP_MS;
    this.ctx.storage.sql.exec('DELETE FROM scoring WHERE at < ?', cutoff);
    this.ctx.storage.sql.exec('DELETE FROM scores WHERE updated < ?', cutoff);
    const left = this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM scores').one().n;
    if (left > 0) await this.ctx.storage.setAlarm(Date.now() + 60 * 60_000);
  }
}

export function gamesStub(env) {
  return env.GAMES ? env.GAMES.getByName('global') : null;
}
