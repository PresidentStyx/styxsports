// The shared premium accounts and their connection pool.
//
// The site sells premium per account with a hard cap of 5 simultaneous connections (Live TV tabs
// and IPTV apps all count). Any number of accounts can be shared with everyone using the app:
// each site session lives in this Durable Object, and a viewer who wants a premium stream first
// takes a lease on one slot of one account (accounts fill in the order they were shared). Leases
// are renewed by a heartbeat while the stream plays and expire quickly when it stops, so a closed
// tab frees its slot within a minute. Capacity is 5 × the number of shared accounts.
//
// A viewer signed in with their own account also registers a lease so /stats shows them, but it
// only counts against a shared account when it *is* that account (matched by the IPTV playlist
// URL, which is unique per account); otherwise it is an "own" lease that takes no slot.
import { DurableObject } from 'cloudflare:workers';
import { storedPremium } from './account.js';

/** A lease that misses its heartbeats for this long is gone (the web heartbeat is every 20 s). */
export const LEASE_TTL_MS = 45_000;
const DEFAULT_SLOTS = 5;
const ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const KEY_RE = /^[a-z0-9]{6,16}$/;
const KINDS = new Set(['game', 'tv']);
const PLATFORMS = new Set(['web', 'apk', 'roku']);
const LABEL_MAX = 40;
/** Marks a lease that uses the viewer's own account: listed, never counted. */
const OWN = '';

/** Whether a shared account is known to have premium (true), known not to (false, expiring), or unknown. */
function premiumOf(a) {
  return a && a.s ? storedPremium(a.s.p, a.s.pt) : null;
}

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
      const cols = this.ctx.storage.sql.exec('PRAGMA table_info(leases)').toArray().map((c) => c.name);
      if (!cols.includes('account')) this.ctx.storage.sql.exec("ALTER TABLE leases ADD COLUMN account TEXT NOT NULL DEFAULT ''");
      // Before several accounts could be shared there was one, under the key "shared".
      const legacy = await this.ctx.storage.get('shared');
      if (legacy) {
        const accounts = await this.accounts();
        if (!accounts.length) {
          const key = newKey();
          await this.saveAccounts([{ key, label: 'Account 1', at: Number(legacy.at) || Date.now(), s: legacy }]);
          this.ctx.storage.sql.exec("UPDATE leases SET account = ? WHERE account = ''", key);
        }
        await this.ctx.storage.delete('shared');
      }
    });
  }

  /** Connections one account may hold at once. */
  slotsPerAccount() {
    const n = Number(this.env && this.env.POOL_SLOTS);
    return n > 0 ? Math.floor(n) : DEFAULT_SLOTS;
  }

  // --- shared accounts ---------------------------------------------------------------------------

  /** [{ key, label, at, s }] in the order they were shared; `s` is the serialised session. */
  async accounts() {
    const list = await this.ctx.storage.get('accounts');
    return Array.isArray(list) ? list : [];
  }

  async saveAccounts(list) {
    if (list.length) await this.ctx.storage.put('accounts', list);
    else await this.ctx.storage.delete('accounts');
  }

  /**
   * The serialised session of one shared account, with its key attached, or the first shared
   * account when `key` is empty (anonymous page reads); null when nothing is shared.
   */
  async getShared(key) {
    const list = await this.accounts();
    const a = key ? list.find((x) => x.key === key) : list[0];
    return a ? { ...a.s, key: a.key } : null;
  }

  /** Replaces the stored session of account `key` (cookies rotate as the Worker uses them). */
  async setShared(key, s) {
    const list = await this.accounts();
    const a = list.find((x) => x.key === key);
    if (!a) return;
    const { key: _k, ...rest } = s || {};
    a.s = { ...rest, at: a.at };
    await this.saveAccounts(list);
  }

  /**
   * Adds an account, or updates the one it matches: `replaceKey` (the sharer's browser remembers
   * which entry is theirs) or the same IPTV playlist URL (unique per account). Returns the key.
   */
  async share(s, label, replaceKey) {
    const list = await this.accounts();
    const now = Date.now();
    let a = (replaceKey && list.find((x) => x.key === replaceKey))
      || (s && s.i && list.find((x) => x.s && x.s.i === s.i))
      || null;
    const text = cleanLabel(label);
    if (a) {
      a.s = { ...s, at: a.at };
      a.at = now;
      if (text) a.label = text;
    } else {
      a = { key: newKey(), label: text || `Account ${list.length + 1}`, at: now, s: { ...s, at: now } };
      list.push(a);
    }
    await this.saveAccounts(list);
    return a.key;
  }

  /** Forgets one account; whoever was borrowing it loses the lease (they fall back to free servers). */
  async remove(key) {
    const list = await this.accounts();
    const next = list.filter((x) => x.key !== key);
    if (next.length !== list.length) {
      await this.saveAccounts(next);
      this.ctx.storage.sql.exec('DELETE FROM leases WHERE account = ?', key);
    }
    return this.state();
  }

  async clear() {
    await this.saveAccounts([]);
    this.ctx.storage.sql.exec("DELETE FROM leases WHERE account <> ''");
    return this.state();
  }

  // --- leases ------------------------------------------------------------------------------------

  prune(now) {
    this.ctx.storage.sql.exec('DELETE FROM leases WHERE last_seen < ?', now - LEASE_TTL_MS);
  }

  /** Leases on shared accounts (own-account leases are listed but take no slot). */
  used() {
    return Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM leases WHERE account <> ''").one().n) || 0;
  }

  usedBy(key) {
    return Number(this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM leases WHERE account = ?', key).one().n) || 0;
  }

  async armAlarm(now) {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(now + LEASE_TTL_MS);
  }

  /**
   * What a device without its own account needs to know about the shared accounts (no cookies):
   * whether any is shared, whether one has an IPTV playlist, whether premium is known to work on
   * one. Public via /api/pool/info and on every acquire reply.
   */
  async info() {
    const list = await this.accounts();
    this.prune(Date.now());
    return {
      shared: list.length > 0,
      accounts: list.length,
      sharedIptv: list.some((a) => a.s && a.s.i),
      sharedPremium: list.some((a) => premiumOf(a) === true) ? true : list.length && list.every((a) => premiumOf(a) === false) ? false : null,
      used: this.used(),
      max: this.slotsPerAccount() * list.length,
    };
  }

  /**
   * Takes (or renews) a slot for `id`. Shared accounts fill in the order they were shared; a
   * `tv` lease needs an account with a playlist, a `game` lease one not known to lack premium.
   * With `own` the viewer plays on their own account: always granted, and it only takes a slot
   * when `fp` (fingerprint of their playlist URL) identifies one of the shared accounts.
   * Denied when every usable slot is held by others.
   */
  async acquire(id, kind, label, platform, own = false, fp = '') {
    if (!ID_RE.test(id) || !KINDS.has(kind) || !PLATFORMS.has(platform)) return { granted: false, error: 'bad lease request' };
    const now = Date.now();
    this.prune(now);
    const per = this.slotsPerAccount();
    const list = await this.accounts();
    const text = String(label || '').slice(0, 80);
    const info = await this.info();
    const mine = this.ctx.storage.sql.exec('SELECT account FROM leases WHERE id = ?', id).toArray()[0];
    if (mine) {
      this.ctx.storage.sql.exec('UPDATE leases SET kind = ?, label = ?, platform = ?, last_seen = ? WHERE id = ?', kind, text, platform, now, id);
      await this.armAlarm(now);
      return { ...info, granted: true, own: mine.account === OWN, used: this.used() };
    }
    let account = null;
    if (own) {
      const match = fp ? await findByFingerprint(list, fp) : null;
      account = match && this.usedBy(match.key) < per ? match.key : OWN;
    } else {
      for (const a of list) {
        if (!a.s) continue;
        if (kind === 'tv' ? !a.s.i : premiumOf(a) === false) continue;
        if (this.usedBy(a.key) < per) { account = a.key; break; }
      }
      if (account === null) return { ...info, granted: false, used: this.used() };
    }
    this.ctx.storage.sql.exec(
      'INSERT INTO leases (id, kind, label, platform, since, last_seen, account) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, kind, text, platform, now, now, account
    );
    await this.armAlarm(now);
    return { ...info, granted: true, own: account === OWN, used: this.used() };
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
    return { ...await this.info(), granted: cur };
  }

  async release(id) {
    this.ctx.storage.sql.exec('DELETE FROM leases WHERE id = ?', id);
    this.prune(Date.now());
    return { used: this.used(), max: (await this.info()).max };
  }

  /** The shared account this lease borrows, or null (no lease, or an own-account lease). */
  async leaseAccount(id) {
    if (!ID_RE.test(id)) return null;
    this.prune(Date.now());
    const r = this.ctx.storage.sql.exec('SELECT account FROM leases WHERE id = ?', id).toArray()[0];
    return r && r.account !== OWN ? r.account : null;
  }

  async hasLease(id) {
    return (await this.leaseAccount(id)) !== null;
  }

  /**
   * For /stats and the account dialog: never the cookies themselves. Lease ids only when asked
   * (`withIds`, /api/stats joins them to device names and strips them): a lease id opens the
   * shared-account endpoints without the site password.
   */
  async state(withIds = false) {
    const now = Date.now();
    this.prune(now);
    const list = await this.accounts();
    const per = this.slotsPerAccount();
    const labels = new Map(list.map((a) => [a.key, a.label]));
    const leases = this.ctx.storage.sql.exec('SELECT id, kind, label, platform, since, last_seen, account FROM leases ORDER BY since').toArray()
      .map((r) => ({
        ...(withIds ? { id: r.id } : {}),
        kind: r.kind, label: r.label, platform: r.platform, since: Number(r.since), lastSeen: Number(r.last_seen),
        account: r.account === OWN ? null : r.account,
        accountLabel: r.account === OWN ? '' : labels.get(r.account) || '?',
      }));
    const accounts = list.map((a) => ({
      key: a.key,
      label: a.label,
      sharedAt: Number(a.at) || 0,
      iptv: !!(a.s && a.s.i),
      premium: premiumOf(a),
      used: leases.filter((l) => l.account === a.key).length,
      max: per,
    }));
    const info = await this.info();
    return {
      shared: info.shared,
      sharedAt: accounts.length ? Math.max(...accounts.map((a) => a.sharedAt)) : 0,
      sharedIptv: info.sharedIptv,
      sharedPremium: info.sharedPremium,
      accounts,
      used: info.used,
      max: info.max,
      ttlSec: LEASE_TTL_MS / 1000,
      leases,
    };
  }

  async alarm() {
    const now = Date.now();
    this.prune(now);
    const left = Number(this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM leases').one().n) || 0;
    if (left > 0) await this.ctx.storage.setAlarm(now + LEASE_TTL_MS);
  }
}

function newKey() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(b, (x) => x.toString(36).padStart(2, '0')).join('').slice(0, 12);
}

function cleanLabel(s) {
  return String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX);
}

/** Short hash of an account's IPTV playlist URL: how a signed-in device says which account it is. */
export async function fingerprint(iptvUrl) {
  if (typeof iptvUrl !== 'string' || !iptvUrl) return '';
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(iptvUrl.trim()));
  return Array.from(new Uint8Array(d).slice(0, 8), (x) => x.toString(16).padStart(2, '0')).join('');
}

async function findByFingerprint(list, fp) {
  for (const a of list) {
    if (a.s && a.s.i && await fingerprint(a.s.i) === fp) return a;
  }
  return null;
}

export function poolStub(env) {
  return env && env.POOL ? env.POOL.getByName('global') : null;
}

function poolJson(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
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

/** The sharer's browser remembers which shared entry is theirs so re-sharing updates it. */
const SHARE_COOKIE = 'styx_shared';

function shareKeyCookie(request) {
  const m = /(?:^|;\s*)styx_shared=([a-z0-9]{6,16})/.exec(request.headers.get('Cookie') || '');
  return m ? m[1] : '';
}

/**
 * /api/pool          accounts + leases + this browser's own entry (no cookies)
 * /api/pool/info     public: { shared, accounts, sharedIptv, sharedPremium, used, max } for the APK / Roku
 * /api/pool/share    POST { label? }: add (or update) the caller's StreamEast session as a shared account
 * /api/pool/remove   POST { key }: forget one shared account
 * /api/pool/clear    POST: forget every shared account and drop their leases
 * /api/pool/acquire  POST: { id, kind, label, platform, own?, acct? }  (web: own/acct come from the session)
 * /api/pool/heartbeat POST: { id, label? }
 * /api/pool/release  POST: { id }
 */
export async function handlePool(request, env, path, session, serialize) {
  const stub = poolStub(env);
  if (!stub) return poolJson({ error: 'pool not configured' }, 500);
  const sub = path.slice('/api/pool'.length);

  if (sub === '' || sub === '/') {
    const st = await stub.state();
    const mine = shareKeyCookie(request);
    st.mine = mine && st.accounts.some((a) => a.key === mine) ? mine : null;
    return poolJson(st);
  }
  if (sub === '/info') return poolJson(await stub.info());

  if (sub === '/share') {
    if (request.method !== 'POST') return poolJson({ error: 'POST' }, 405);
    if (!session || !session.signedIn) {
      return poolJson({ error: 'Sign in to StreamEast on the home page first, then share from here.' }, 400);
    }
    const b = await readBody(request);
    const key = await stub.share(serialize(session), typeof b.label === 'string' ? b.label : '', shareKeyCookie(request));
    const st = await stub.state();
    st.mine = key;
    return poolJson(st, 200, { 'Set-Cookie': `${SHARE_COOKIE}=${key}; Path=/; Max-Age=${365 * 86400}; Secure; HttpOnly; SameSite=Lax` });
  }

  if (sub === '/remove') {
    if (request.method !== 'POST') return poolJson({ error: 'POST' }, 405);
    const b = await readBody(request);
    const key = String(b.key || '');
    if (!KEY_RE.test(key)) return poolJson({ error: 'bad key' }, 400);
    return poolJson(await stub.remove(key));
  }

  if (sub === '/clear') {
    if (request.method !== 'POST') return poolJson({ error: 'POST' }, 405);
    return poolJson(await stub.clear());
  }

  if (sub === '/acquire') {
    if (request.method !== 'POST') return poolJson({ error: 'POST' }, 405);
    const b = await readBody(request);
    // A browser signed in with its own account says so through its session cookie; the APK and
    // Roku say so in the body (they never send cookies here).
    let own = b.own === true || b.own === 1;
    let fp = typeof b.acct === 'string' && /^[0-9a-f]{16}$/.test(b.acct) ? b.acct : '';
    if (session && session.signedIn) {
      own = true;
      fp = await fingerprint(session.iptv);
    }
    return poolJson(await stub.acquire(String(b.id || ''), String(b.kind || 'game'), String(b.label || ''), String(b.platform || 'web'), own, fp));
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
