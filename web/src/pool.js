// The shared premium account and its connection pool.
//
// The site sells premium per account with a hard cap of 5 simultaneous connections (Live TV tabs
// and IPTV apps all count). One account is shared with everyone using the app: its site session
// lives in this Durable Object, and a viewer who wants a premium stream first takes a lease on one
// of the slots. Leases are renewed by a heartbeat while the stream plays and expire quickly when
// it stops, so a closed tab frees its slot within a minute. Viewers signed in with their own
// account never touch the pool (see account.js).
import { DurableObject } from 'cloudflare:workers';

/** A lease that misses its heartbeats for this long is gone (the web heartbeat is every 20 s). */
export const LEASE_TTL_MS = 45_000;
const DEFAULT_SLOTS = 5;
const ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const KINDS = new Set(['game', 'tv']);
const PLATFORMS = new Set(['web', 'apk', 'roku']);

export class Pool extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS leases (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          label TEXT NOT NULL,
          platform TEXT NOT NULL,
          since INTEGER NOT NULL,
          last_seen INTEGER NOT NULL
        )
      `);
    });
  }

  maxSlots() {
    const n = Number(this.env && this.env.POOL_SLOTS);
    return n > 0 ? Math.floor(n) : DEFAULT_SLOTS;
  }

  // --- shared account ----------------------------------------------------------------------------

  /** The shared account's serialised session ({ j, i, h, p, t, at }) or null when none is shared. */
  async getShared() {
    return (await this.ctx.storage.get('shared')) || null;
  }

  async setShared(shared) {
    if (shared) await this.ctx.storage.put('shared', shared);
    else await this.ctx.storage.delete('shared');
  }

  // --- leases ------------------------------------------------------------------------------------

  prune(now) {
    this.ctx.storage.sql.exec('DELETE FROM leases WHERE last_seen < ?', now - LEASE_TTL_MS);
  }

  used() {
    return Number(this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM leases').one().n) || 0;
  }

  async armAlarm(now) {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(now + LEASE_TTL_MS);
  }

  /**
   * What a device without its own account needs to know about the shared account (no cookies):
   * whether one is shared at all, whether it has an IPTV playlist, whether its premium tabs
   * are known to work. Public via /api/pool/info and on every acquire reply.
   */
  async info() {
    const shared = await this.getShared();
    this.prune(Date.now());
    return {
      shared: !!shared,
      sharedIptv: !!(shared && shared.i),
      sharedPremium: shared ? (shared.p === 1 ? true : shared.p === 0 ? false : null) : null,
      used: this.used(),
      max: this.maxSlots(),
    };
  }

  /** Takes (or renews) the slot for `id`. Denied when all slots are held by others. */
  async acquire(id, kind, label, platform) {
    if (!ID_RE.test(id) || !KINDS.has(kind) || !PLATFORMS.has(platform)) return { granted: false, error: 'bad lease request' };
    const now = Date.now();
    this.prune(now);
    const max = this.maxSlots();
    const mine = this.ctx.storage.sql.exec('SELECT id FROM leases WHERE id = ?', id).toArray().length > 0;
    const text = String(label || '').slice(0, 80);
    const info = await this.info();
    if (mine) {
      this.ctx.storage.sql.exec('UPDATE leases SET kind = ?, label = ?, platform = ?, last_seen = ? WHERE id = ?', kind, text, platform, now, id);
    } else if (this.used() < max) {
      this.ctx.storage.sql.exec('INSERT INTO leases (id, kind, label, platform, since, last_seen) VALUES (?, ?, ?, ?, ?, ?)', id, kind, text, platform, now, now);
    } else {
      return { ...info, granted: false, used: this.used(), max };
    }
    await this.armAlarm(now);
    return { ...info, granted: true, used: this.used(), max };
  }

  /** Renews the slot; `granted: false` means it expired and someone else may hold it now. */
  async heartbeat(id, label) {
    const now = Date.now();
    this.prune(now);
    const cur = this.ctx.storage.sql.exec('SELECT id FROM leases WHERE id = ?', id).toArray().length > 0;
    if (cur) {
      if (typeof label === 'string' && label) this.ctx.storage.sql.exec('UPDATE leases SET last_seen = ?, label = ? WHERE id = ?', now, label.slice(0, 80), id);
      else this.ctx.storage.sql.exec('UPDATE leases SET last_seen = ? WHERE id = ?', now, id);
      await this.armAlarm(now);
    }
    return { granted: cur, used: this.used(), max: this.maxSlots() };
  }

  async release(id) {
    this.ctx.storage.sql.exec('DELETE FROM leases WHERE id = ?', id);
    this.prune(Date.now());
    return { used: this.used(), max: this.maxSlots() };
  }

  async hasLease(id) {
    if (!ID_RE.test(id)) return false;
    this.prune(Date.now());
    return this.ctx.storage.sql.exec('SELECT id FROM leases WHERE id = ?', id).toArray().length > 0;
  }

  /**
   * For /stats and the account dialog: never the cookies themselves. Lease ids only when asked
   * (`withIds`, /api/stats joins them to device names and strips them): a lease id opens the
   * shared-account endpoints without the site password.
   */
  async state(withIds = false) {
    const now = Date.now();
    this.prune(now);
    const shared = await this.getShared();
    const leases = this.ctx.storage.sql.exec('SELECT id, kind, label, platform, since, last_seen FROM leases ORDER BY since').toArray()
      .map((r) => ({ ...(withIds ? { id: r.id } : {}), kind: r.kind, label: r.label, platform: r.platform, since: Number(r.since), lastSeen: Number(r.last_seen) }));
    return {
      shared: !!shared,
      sharedAt: shared ? Number(shared.at) || 0 : 0,
      sharedIptv: !!(shared && shared.i),
      sharedPremium: shared ? (shared.p === 1 ? true : shared.p === 0 ? false : null) : null,
      used: leases.length,
      max: this.maxSlots(),
      ttlSec: LEASE_TTL_MS / 1000,
      leases,
    };
  }

  async releaseAll() {
    this.ctx.storage.sql.exec('DELETE FROM leases');
    return { used: 0, max: this.maxSlots() };
  }

  async alarm() {
    const now = Date.now();
    this.prune(now);
    if (this.used() > 0) await this.ctx.storage.setAlarm(now + LEASE_TTL_MS);
  }
}

export function poolStub(env) {
  return env && env.POOL ? env.POOL.getByName('global') : null;
}

function poolJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function readBody(request) {
  try {
    const o = await request.json();
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

/**
 * /api/pool          current slot + share state (no cookies)
 * /api/pool/info     public: { shared, sharedIptv, sharedPremium, used, max } for the APK / Roku
 * /api/pool/share    POST: store the caller's StreamEast session as the shared account
 * /api/pool/clear    POST: forget the shared account and drop every lease
 * /api/pool/acquire  POST: { id, kind, label, platform }
 * /api/pool/heartbeat POST: { id, label? }
 * /api/pool/release  POST: { id }
 */
export async function handlePool(request, env, path, session, serialize) {
  const stub = poolStub(env);
  if (!stub) return poolJson({ error: 'pool not configured' }, 500);
  const sub = path.slice('/api/pool'.length);

  if (sub === '' || sub === '/') return poolJson(await stub.state());
  if (sub === '/info') return poolJson(await stub.info());

  if (sub === '/share') {
    if (request.method !== 'POST') return poolJson({ error: 'POST' }, 405);
    if (!session || !session.signedIn) {
      return poolJson({ error: 'Sign in to StreamEast on the home page first, then share from here.' }, 400);
    }
    await stub.setShared(serialize(session));
    return poolJson(await stub.state());
  }

  if (sub === '/clear') {
    if (request.method !== 'POST') return poolJson({ error: 'POST' }, 405);
    await stub.setShared(null);
    await stub.releaseAll();
    return poolJson(await stub.state());
  }

  if (sub === '/acquire') {
    if (request.method !== 'POST') return poolJson({ error: 'POST' }, 405);
    const b = await readBody(request);
    return poolJson(await stub.acquire(String(b.id || ''), String(b.kind || 'game'), String(b.label || ''), String(b.platform || 'web')));
  }

  if (sub === '/heartbeat') {
    if (request.method !== 'POST') return poolJson({ error: 'POST' }, 405);
    const b = await readBody(request);
    return poolJson(await stub.heartbeat(String(b.id || ''), typeof b.label === 'string' ? b.label : ''));
  }

  if (sub === '/release') {
    if (request.method !== 'POST') return poolJson({ error: 'POST' }, 405);
    const b = await readBody(request);
    return poolJson(await stub.release(String(b.id || '')));
  }

  return poolJson({ error: 'not found' }, 404);
}
