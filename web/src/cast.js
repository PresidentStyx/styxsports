// Cast to TV from the phone (4.0 phase 4.4).
//
// Pairing: the TV app asks for a code (POST /api/cast/pair, TV device id) and shows it; the
// phone, signed in to the web app, enters it once (POST /api/cast/claim). From then on the phone
// lists its TVs (GET /api/cast/targets) and sends them commands (POST /api/cast/send): today
// { cmd: "open", event } - the TV opens that game. A TV in the foreground keeps one WebSocket
// open here (GET /api/cast/ws, hibernating), so a command arrives in well under a second.
//
// Ids: the TV's install id (Presence id, X-Styx-Device) and the phone's web client id. Every
// phone endpoint is behind the site password like the rest of the web app.
import { DurableObject } from 'cloudflare:workers';

const ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const CODE_TTL_MS = 10 * 60_000;
const CLAIM_WINDOW_MS = 10 * 60_000;
const CLAIM_MAX = 10;
const MAX_TVS_PER_PHONE = 8;
const MAX_MESSAGE = 4096;

export class Cast extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql;
      sql.exec('CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, tv TEXT NOT NULL, expires INTEGER NOT NULL)');
      sql.exec('CREATE TABLE IF NOT EXISTS pairs (tv TEXT NOT NULL, phone TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (tv, phone))');
      sql.exec('CREATE TABLE IF NOT EXISTS claims (phone TEXT PRIMARY KEY, n INTEGER NOT NULL, since INTEGER NOT NULL)');
    });
    // A TV's keep-alive is answered without waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /** A fresh 6-digit code for this TV (any older one is dropped). */
  async startPair(tv) {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    sql.exec('DELETE FROM codes WHERE tv = ? OR expires < ?', tv, now);
    for (let i = 0; i < 20; i++) {
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
      if (sql.exec('SELECT 1 FROM codes WHERE code = ?', code).toArray().length) continue;
      sql.exec('INSERT INTO codes (code, tv, expires) VALUES (?, ?, ?)', code, tv, now + CODE_TTL_MS);
      return { code, expiresInS: CODE_TTL_MS / 1000 };
    }
    throw new Error('no free code');
  }

  /** The phone enters a TV's code. Rate-limited per phone. */
  async claim(phone, code, phoneName) {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const row = sql.exec('SELECT n, since FROM claims WHERE phone = ?', phone).toArray()[0];
    const fresh = !row || now - Number(row.since) > CLAIM_WINDOW_MS;
    const n = fresh ? 1 : Number(row.n) + 1;
    sql.exec('INSERT OR REPLACE INTO claims (phone, n, since) VALUES (?, ?, ?)', phone, n, fresh ? now : Number(row.since));
    if (n > CLAIM_MAX) return { ok: false, error: 'Too many tries. Wait a few minutes and try again.' };
    const hit = sql.exec('SELECT tv FROM codes WHERE code = ? AND expires >= ?', String(code), now).toArray()[0];
    if (!hit) return { ok: false, error: 'That code didn’t match. Check the code on the TV and try again.' };
    const tv = String(hit.tv);
    const count = sql.exec('SELECT COUNT(*) AS n FROM pairs WHERE phone = ?', phone).one().n;
    if (Number(count) >= MAX_TVS_PER_PHONE) return { ok: false, error: 'This phone is paired with too many TVs. Remove one first.' };
    sql.exec('DELETE FROM codes WHERE code = ?', String(code));
    sql.exec('INSERT OR REPLACE INTO pairs (tv, phone, created) VALUES (?, ?, ?)', tv, phone, now);
    this.deliver(tv, { cmd: 'paired', from: phoneName || 'a phone' });
    return { ok: true, tv };
  }

  /** The phone's TVs, with whether each has the app open right now. */
  async targets(phone) {
    const rows = this.ctx.storage.sql.exec('SELECT tv FROM pairs WHERE phone = ? ORDER BY created', phone).toArray();
    return rows.map((r) => ({ id: String(r.tv), online: this.ctx.getWebSockets(String(r.tv)).length > 0 }));
  }

  async unpair(phone, tv) {
    this.ctx.storage.sql.exec('DELETE FROM pairs WHERE phone = ? AND tv = ?', phone, tv);
    return { ok: true };
  }

  /** A command from a paired phone; returns how many of the TV's connections got it. */
  async send(phone, tv, msg) {
    const paired = this.ctx.storage.sql.exec('SELECT 1 FROM pairs WHERE phone = ? AND tv = ?', phone, tv).toArray().length > 0;
    if (!paired) return { ok: false, error: 'Not paired with that TV.' };
    const delivered = this.deliver(tv, msg);
    return delivered
      ? { ok: true, delivered }
      : { ok: false, error: 'The TV isn’t listening. Open Styx Sports on the TV and try again.' };
  }

  deliver(tv, msg) {
    const text = JSON.stringify(msg);
    let n = 0;
    for (const ws of this.ctx.getWebSockets(tv)) {
      try { ws.send(text); n++; } catch { /* closing */ }
    }
    return n;
  }

  /** WebSocket upgrade for a TV (the Worker has checked its device id). */
  async fetch(request) {
    const tv = request.headers.get('X-Styx-Device') || '';
    if (!ID_RE.test(tv) || request.headers.get('Upgrade') !== 'websocket') return new Response('expected a websocket', { status: 426 });
    // One live connection per TV: a reconnect replaces the old one.
    for (const old of this.ctx.getWebSockets(tv)) {
      try { old.close(1000, 'replaced'); } catch { /* gone */ }
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [tv]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, message) {
    // TVs only send keep-alives (answered by the auto-response); anything else is ignored.
    if (typeof message === 'string' && message.length > MAX_MESSAGE) ws.close(1009, 'too big');
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch { /* already closed */ }
  }
}

function castStub(env) {
  return env.CAST ? env.CAST.getByName('global') : null;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

/** The event fields a TV needs to open a game (the /api/schedule shape). */
function castEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const s = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
  const out = {
    id: s(e.id, 64), categoryId: Number(e.categoryId) || 0, home: s(e.home, 120), away: s(e.away, 120),
    url: s(e.url, 500), startTs: Number(e.startTs) || 0, live: e.live === true, ended: e.ended === true,
    premium: e.premium === true, league: s(e.league, 40), crestHome: s(e.crestHome), crestAway: s(e.crestAway),
    liveText: s(e.liveText, 40), score: s(e.score, 40),
  };
  return out.id && /^https?:\/\//.test(out.url) ? out : null;
}

/**
 * /api/cast/* routes. `tvDevice` is the caller's TV install id when it authenticated as a TV
 * app, `names(ids)` looks up device names from Presence.
 */
export async function handleCast(request, env, path, { tvDevice, names }) {
  const stub = castStub(env);
  if (!stub) return json({ error: 'cast is not set up' }, 503);
  const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
  const phone = String(body.phone || new URL(request.url).searchParams.get('phone') || '');

  if (path === '/api/cast/ws') {
    if (!tvDevice) return json({ error: 'TV apps only' }, 403);
    const fwd = new Request(request);
    fwd.headers.set('X-Styx-Device', tvDevice);
    return stub.fetch(fwd);
  }
  if (path === '/api/cast/pair' && request.method === 'POST') {
    if (!tvDevice) return json({ error: 'TV apps only' }, 403);
    return json(await stub.startPair(tvDevice));
  }
  if (!ID_RE.test(phone)) return json({ error: 'missing phone id' }, 400);
  if (path === '/api/cast/claim' && request.method === 'POST') {
    const code = String(body.code || '').replace(/\D/g, '');
    if (code.length !== 6) return json({ ok: false, error: 'The code has 6 digits.' }, 400);
    const own = (await names([phone]))[phone] || '';
    const r = await stub.claim(phone, code, own);
    if (!r.ok) return json(r, 400);
    return json({ ok: true, tv: { id: r.tv, name: (await names([r.tv]))[r.tv] || 'TV' } });
  }
  if (path === '/api/cast/targets') {
    const tvs = await stub.targets(phone);
    const n = await names(tvs.map((t) => t.id));
    return json({ tvs: tvs.map((t) => ({ ...t, name: n[t.id] || 'TV' })) });
  }
  if (path === '/api/cast/unpair' && request.method === 'POST') {
    return json(await stub.unpair(phone, String(body.tv || '')));
  }
  if (path === '/api/cast/send' && request.method === 'POST') {
    const event = castEvent(body.event);
    if (body.cmd !== 'open' || !event) return json({ ok: false, error: 'bad command' }, 400);
    const from = (await names([phone]))[phone] || '';
    const r = await stub.send(phone, String(body.tv || ''), { cmd: 'open', event, from });
    return json(r, r.ok ? 200 : 409);
  }
  return json({ error: 'not found' }, 404);
}
