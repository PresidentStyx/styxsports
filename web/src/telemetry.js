// Playback telemetry from every client (web / APK / Roku), so /stats can say how playback is
// doing per CDN family, platform and version — and, in 4.0 phase 5, so the status page can tell
// viewers "the site is having a night" apart from "the app is broken".
//
// POST /api/telemetry (public, like /api/ping; the device id is the Presence id):
//   { device, platform: "web"|"apk"|"roku", version, network: "direct"|"relay",
//     events: [ { kind, at?, game?, server?, cdn?, premium?, relay?, ttff?, duration?, position?,
//                 from?, to?, reason?, code?, outcome? }, ... ] }
// `cdn` is the stream host (grouped into families here); `relay: true` means the bytes came
// through this Worker's /hls/ or /ts/ rather than straight from the CDN.
// Kinds: start (first frame; ttff ms), stall (duration ms), switch (from/to server, reason),
// error (code, cdn), stop (duration ms watched), update (from -> to version, outcome).
//
// Raw events are kept 7 days; hourly rollups (per platform / version / cdn) 90 days.
import { DurableObject } from 'cloudflare:workers';

const PLATFORMS = new Set(['web', 'apk', 'roku']);
const KINDS = new Set(['start', 'stall', 'switch', 'error', 'stop', 'update']);
const NETWORKS = new Set(['direct', 'relay', '']);
const ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const MAX_EVENTS = 50;
const RAW_KEEP_MS = 7 * 24 * 3600_000;
const ROLLUP_KEEP_MS = 90 * 24 * 3600_000;
const HOUR_MS = 3600_000;

const str = (v, max = 80) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '');
const num = (v, max = 24 * 3600_000) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), max) : null);

/** Groups stream hosts into the families /stats reports on. */
export function cdnFamily(hostOrUrl) {
  let h = String(hostOrUrl || '').toLowerCase();
  try { if (h.includes('/')) h = new URL(h.startsWith('http') ? h : 'https://' + h).host; } catch { /* keep */ }
  if (!h) return '';
  if (h.includes('steast') || h.includes('iptv4')) return 'premium';
  if (h === 'sports.styxam.com') return 'relay';
  const parts = h.split('.');
  return parts.length > 2 ? parts.slice(-2).join('.') : h;
}

export class Telemetry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS events (
        at INTEGER NOT NULL, device TEXT NOT NULL, platform TEXT NOT NULL, version TEXT NOT NULL,
        network TEXT NOT NULL, kind TEXT NOT NULL, cdn TEXT NOT NULL, premium INTEGER NOT NULL,
        ttff INTEGER, duration INTEGER, code TEXT, detail TEXT)`);
      sql.exec('CREATE INDEX IF NOT EXISTS idx_events_at ON events(at)');
      sql.exec(`CREATE TABLE IF NOT EXISTS rollups (
        hour INTEGER NOT NULL, platform TEXT NOT NULL, version TEXT NOT NULL, cdn TEXT NOT NULL,
        starts INTEGER NOT NULL, ttff_sum INTEGER NOT NULL, ttff_n INTEGER NOT NULL,
        stalls INTEGER NOT NULL, stall_ms INTEGER NOT NULL, errors INTEGER NOT NULL,
        watched_ms INTEGER NOT NULL, devices INTEGER NOT NULL,
        PRIMARY KEY (hour, platform, version, cdn))`);
      sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)');
    });
  }

  /** Stores one validated batch. */
  async ingest(batch) {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    for (const e of batch.events) {
      sql.exec(
        'INSERT INTO events (at, device, platform, version, network, kind, cdn, premium, ttff, duration, code, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        e.at, batch.device, batch.platform, batch.version, batch.network, e.kind, e.cdn, e.premium ? 1 : 0,
        e.ttff, e.duration, e.code, e.detail,
      );
    }
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(now + 10 * 60_000);
  }

  /** Last `hours` hours from raw events: per-CDN health and per-platform/version counts. */
  async health(hours = 24) {
    const sql = this.ctx.storage.sql;
    const since = Date.now() - hours * HOUR_MS;
    const byCdn = new Map();
    const row = (cdn) => byCdn.get(cdn) || byCdn.set(cdn, { cdn, starts: 0, ttff: [], ttffPre: [], stalls: 0, stallMs: 0, errors: 0, watchedMs: 0, premium: 0 }).get(cdn);
    for (const r of sql.exec('SELECT kind, cdn, premium, ttff, duration, code FROM events WHERE at >= ?', since).toArray()) {
      const c = row(r.cdn || 'unknown');
      if (r.kind === 'start') {
        c.starts++;
        if (r.ttff != null) (r.code === 'pre' ? c.ttffPre : c.ttff).push(Number(r.ttff));
        if (r.premium) c.premium++;
      }
      else if (r.kind === 'stall') { c.stalls++; c.stallMs += Number(r.duration || 0); }
      else if (r.kind === 'error') c.errors++;
      else if (r.kind === 'stop') c.watchedMs += Number(r.duration || 0);
    }
    const median = (xs) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
    const cdns = [...byCdn.values()].map((c) => {
      const viewerHours = c.watchedMs / HOUR_MS;
      return {
        cdn: c.cdn, starts: c.starts, errors: c.errors, premium: c.premium,
        successRate: c.starts + c.errors ? Math.round((100 * c.starts) / (c.starts + c.errors)) : null,
        // Cold starts (resolved after OK) and pre-resolved starts (resolved while the card had focus).
        medianTtffMs: median(c.ttff), preStarts: c.ttffPre.length, medianTtffPreMs: median(c.ttffPre),
        stalls: c.stalls, stallsPerViewerHour: viewerHours >= 0.1 ? Math.round((c.stalls / viewerHours) * 10) / 10 : null,
        viewerHours: Math.round(viewerHours * 10) / 10,
      };
    }).sort((a, b) => b.starts - a.starts);
    const platforms = sql.exec(
      'SELECT platform, version, network, COUNT(DISTINCT device) AS devices, SUM(kind = ?) AS starts FROM events WHERE at >= ? GROUP BY platform, version, network ORDER BY platform, version',
      'start', since,
    ).toArray().map((r) => ({ platform: r.platform, version: r.version, network: r.network, devices: Number(r.devices), starts: Number(r.starts) }));
    const updates = sql.exec(
      'SELECT code AS outcome, detail, COUNT(*) AS n FROM events WHERE kind = ? AND at >= ? GROUP BY code, detail ORDER BY n DESC LIMIT 20', 'update', since,
    ).toArray().map((r) => ({ outcome: r.outcome, change: r.detail, n: Number(r.n) }));
    return { hours, cdns, platforms, updates };
  }

  /** Hourly rollups (for trends and the 90-day history). */
  async rollups(days = 7) {
    const since = Date.now() - days * 24 * HOUR_MS;
    return this.ctx.storage.sql.exec('SELECT * FROM rollups WHERE hour >= ? ORDER BY hour', since).toArray()
      .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])));
  }

  /** Folds completed hours into rollups, trims raw and old rollups. */
  async alarm() {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
    const doneRow = sql.exec('SELECT v FROM meta WHERE k = ?', 'rolled_until').toArray()[0];
    let from = doneRow ? Number(doneRow.v) : Math.floor((now - RAW_KEEP_MS) / HOUR_MS) * HOUR_MS;
    for (; from < currentHour; from += HOUR_MS) {
      const rows = sql.exec(
        `SELECT platform, version, cdn,
           SUM(kind = 'start') AS starts, SUM(CASE WHEN kind = 'start' AND ttff IS NOT NULL THEN ttff ELSE 0 END) AS ttff_sum,
           SUM(kind = 'start' AND ttff IS NOT NULL) AS ttff_n, SUM(kind = 'stall') AS stalls,
           SUM(CASE WHEN kind = 'stall' THEN COALESCE(duration, 0) ELSE 0 END) AS stall_ms, SUM(kind = 'error') AS errors,
           SUM(CASE WHEN kind = 'stop' THEN COALESCE(duration, 0) ELSE 0 END) AS watched_ms, COUNT(DISTINCT device) AS devices
         FROM events WHERE at >= ? AND at < ? GROUP BY platform, version, cdn`, from, from + HOUR_MS,
      ).toArray();
      for (const r of rows) {
        sql.exec(
          `INSERT OR REPLACE INTO rollups (hour, platform, version, cdn, starts, ttff_sum, ttff_n, stalls, stall_ms, errors, watched_ms, devices)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          from, r.platform, r.version, r.cdn, Number(r.starts), Number(r.ttff_sum), Number(r.ttff_n), Number(r.stalls),
          Number(r.stall_ms), Number(r.errors), Number(r.watched_ms), Number(r.devices),
        );
      }
    }
    sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', 'rolled_until', currentHour);
    sql.exec('DELETE FROM events WHERE at < ?', now - RAW_KEEP_MS);
    sql.exec('DELETE FROM rollups WHERE hour < ?', now - ROLLUP_KEEP_MS);
    const left = sql.exec('SELECT COUNT(*) AS n FROM events').one().n;
    if (left > 0) await this.ctx.storage.setAlarm(now + HOUR_MS);
  }
}

function stub(env) {
  return env.TELEMETRY ? env.TELEMETRY.getByName('global') : null;
}

const jsonRes = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
});

/** Public: validates and stores one batch. Always answers quickly; bad batches are dropped. */
export async function handleTelemetry(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
  }
  if (request.method !== 'POST') return jsonRes({ error: 'POST only' }, 405);
  let body = {};
  try { body = await request.json(); } catch { return jsonRes({ error: 'bad json' }, 400); }
  const device = str(body.device, 64);
  const platform = str(body.platform, 8).toLowerCase();
  if (!ID_RE.test(device) || !PLATFORMS.has(platform) || !Array.isArray(body.events)) return jsonRes({ error: 'bad batch' }, 400);
  const now = Date.now();
  const events = [];
  for (const e of body.events.slice(0, MAX_EVENTS)) {
    if (!e || typeof e !== 'object' || !KINDS.has(e.kind)) continue;
    const at = typeof e.at === 'number' && e.at > now - RAW_KEEP_MS && e.at < now + 60_000 ? Math.round(e.at) : now;
    let detail = '';
    if (e.kind === 'start') detail = str(e.game, 40) + '|' + str(e.server, 40);
    else if (e.kind === 'switch') detail = str(e.from, 40) + '>' + str(e.to, 40) + '|' + str(e.reason, 40);
    else if (e.kind === 'update') detail = str(e.from, 16) + '>' + str(e.to, 16);
    else if (e.kind === 'stall') detail = String(num(e.position) ?? '');
    let cdn = cdnFamily(e.cdn);
    if (cdn === 'relay' || !cdn) cdn = 'unknown';
    if (e.relay === true) cdn += ' via relay'; // proxied through this Worker (/hls/ or /ts/)
    events.push({
      at, kind: e.kind, cdn, premium: e.premium === true,
      ttff: e.kind === 'start' ? num(e.ttff, 600_000) : null,
      duration: e.kind === 'stall' || e.kind === 'stop' ? num(e.duration) : null,
      // start: "pre" when the stream was resolved before the viewer pressed OK (zero-wait start)
      code: e.kind === 'error' || e.kind === 'update' ? str(e.code || e.outcome, 40) : e.kind === 'start' && e.pre === true ? 'pre' : null,
      detail,
    });
  }
  const s = stub(env);
  if (s && events.length) {
    try {
      await s.ingest({ device, platform, version: str(body.version, 16) || '?', network: NETWORKS.has(body.network) ? body.network || 'direct' : 'direct', events });
    } catch { /* telemetry never fails the client */ }
  }
  return jsonRes({ ok: true, stored: events.length });
}

/** Behind the site password: the last 24 h for /stats. */
export async function telemetryHealth(env, hours = 24) {
  const s = stub(env);
  if (!s) return null;
  try { return await s.health(hours); } catch { return null; }
}

export async function telemetryRollups(env, days = 7) {
  const s = stub(env);
  if (!s) return [];
  try { return await s.rollups(days); } catch { return []; }
}
