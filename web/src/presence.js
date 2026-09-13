// Anonymous "I'm open" presence. Each client (web / APK / Roku) pings /api/ping with a random
// id; this Durable Object keeps last-seen times so /stats can show who is watching right now.
import { DurableObject } from 'cloudflare:workers';

const PLATFORMS = new Set(['web', 'apk', 'roku']);
/** A client drops off the count if it misses this window (heartbeat is every 60 s). */
export const ACTIVE_MS = 3 * 60_000;
const ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
/** Device names come from the client (Android device name, Roku friendly name) or the User-Agent. */
const NAME_MAX = 64;

export class Presence extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS clients (
          id TEXT PRIMARY KEY,
          platform TEXT NOT NULL,
          last_seen INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(
        'CREATE INDEX IF NOT EXISTS idx_clients_seen ON clients(last_seen)'
      );
      // Added later: what the device calls itself. SQLite has no ADD COLUMN IF NOT EXISTS.
      const cols = this.ctx.storage.sql.exec('PRAGMA table_info(clients)').toArray().map((c) => c.name);
      if (!cols.includes('name')) this.ctx.storage.sql.exec('ALTER TABLE clients ADD COLUMN name TEXT');
    });
  }

  async ping(id, platform, name) {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO clients (id, platform, last_seen, name) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET platform = excluded.platform, last_seen = excluded.last_seen,
         name = COALESCE(excluded.name, clients.name)`,
      id, platform, now, name || null
    );
    if (await this.ctx.storage.getAlarm() == null) {
      await this.ctx.storage.setAlarm(now + 60_000);
    }
  }

  async stats() {
    const cutoff = Date.now() - ACTIVE_MS;
    const rows = this.ctx.storage.sql.exec(
      'SELECT id, platform, name, last_seen FROM clients WHERE last_seen >= ? ORDER BY last_seen DESC',
      cutoff
    ).toArray();
    const counts = { web: 0, apk: 0, roku: 0 };
    const devices = [];
    for (const r of rows) {
      if (!(r.platform in counts)) continue;
      counts[r.platform]++;
      devices.push({ id: r.id, platform: r.platform, name: r.name || '', lastSeen: Number(r.last_seen) });
    }
    return {
      web: counts.web,
      apk: counts.apk,
      roku: counts.roku,
      total: counts.web + counts.apk + counts.roku,
      windowSec: ACTIVE_MS / 1000,
      devices,
    };
  }

  async alarm() {
    const cutoff = Date.now() - ACTIVE_MS;
    this.ctx.storage.sql.exec('DELETE FROM clients WHERE last_seen < ?', cutoff);
    const left = this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM clients').one().n;
    if (left > 0) await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }
}

function stub(env) {
  return env.PRESENCE.getByName('global');
}

/** One printable line, at most NAME_MAX characters; '' when nothing usable. */
function cleanName(s) {
  return String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

/**
 * A browser never knows its own device name, so describe it from the User-Agent:
 * "iPhone · Safari", "Windows · Chrome", "Pixel 8 · Chrome", "Samsung TV · browser".
 */
export function describeUserAgent(ua) {
  ua = String(ua || '');
  if (!ua) return '';
  let device = '';
  let m;
  if (/iPhone/.test(ua)) device = 'iPhone';
  else if (/iPad/.test(ua)) device = 'iPad';
  else if (/Tizen/i.test(ua)) device = 'Samsung TV';
  else if (/Web0S|webOS/i.test(ua)) device = 'LG TV';
  else if (/CrKey|Chromecast/i.test(ua)) device = 'Chromecast';
  else if (/Roku/i.test(ua)) device = 'Roku';
  else if (/Xbox/i.test(ua)) device = 'Xbox';
  else if (/PlayStation/i.test(ua)) device = 'PlayStation';
  else if ((m = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/|\))/.exec(ua)) && m[1] && !/^[a-z]{2}(-[a-z]{2})?$/i.test(m[1].trim())) {
    device = m[1].trim();
    if (/^SM-/.test(device)) device = 'Samsung ' + device;
    else if (/^AFT/.test(device)) device = 'Fire TV';
  }
  else if (/Android/.test(ua)) device = /TV/i.test(ua) ? 'Android TV' : 'Android';
  else if (/Windows/.test(ua)) device = 'Windows PC';
  else if (/Macintosh/.test(ua)) device = 'Mac';
  else if (/CrOS/.test(ua)) device = 'Chromebook';
  else if (/Linux/.test(ua)) device = 'Linux';

  let browser = '';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/SamsungBrowser/.test(ua)) browser = 'Samsung Internet';
  else if (/Silk\//.test(ua)) browser = 'Silk';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) browser = 'Safari';

  // Safari on iPadOS calls itself a Mac; nothing in the UA tells them apart, so a "Mac" may be an iPad.
  return [device, browser].filter(Boolean).join(' · ');
}

/** Public: TV apps have no site-password cookie. Body: { id, platform, device? }. */
export async function handlePing(request, env) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json; charset=utf-8', Allow: 'POST', 'Cache-Control': 'no-store' },
    });
  }
  let body = {};
  try { body = await request.json(); } catch { /* empty / not json */ }
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const platform = typeof body.platform === 'string' ? body.platform.trim().toLowerCase() : '';
  if (!ID_RE.test(id) || !PLATFORMS.has(platform)) {
    return new Response(JSON.stringify({ error: 'bad ping' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  // TV apps say what the device is called; browsers are described from the User-Agent.
  let name = cleanName(body.device);
  if (!name && platform === 'web') name = cleanName(describeUserAgent(request.headers.get('User-Agent')));
  await stub(env).ping(id, platform, name);
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** Behind the site password. */
export async function handleStats(env) {
  const data = await stub(env).stats();
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
