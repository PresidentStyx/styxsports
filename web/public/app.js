/* Styx Sports web: the TV app's home screen and player, in a browser. */
(() => {
  'use strict';

  const SCHEDULE_MS = 60_000;
  const STATUS_MS = 30_000;
  const MAX_CONTINUE = 6;
  const RECENT_MAX = 8;
  const RECENT_MAX_AGE = 6 * 3600_000;
  const HUD_HIDE_MS = 3500;
  const STALL_MS = 15_000;
  const START_TIMEOUT_MS = 25_000;
  const IMPATIENCE_MS = 6_000;
  /**
   * Self-healing (4.0 phase 2.2; NativePlayerActivity DEGRADE_*): a stream that keeps playing
   * but badly - this many stalls within the window, this many stalls longer than
   * DEGRADE_LONG_STALL_MS, or a burst of segment/playlist load errors - is left for the next
   * best server, readied in a hidden second <video> and swapped in once it has frames.
   */
  const DEGRADE_STALLS = 3;
  const DEGRADE_WINDOW_MS = 120_000;
  const DEGRADE_LONG_STALLS = 2;
  const DEGRADE_LONG_STALL_MS = 8_000;
  const DEGRADE_ERRORS = 3;
  const DEGRADE_ERROR_WINDOW_MS = 60_000;
  const STANDBY_TIMEOUT_MS = 40_000;
  /** Shown to the flag service and telemetry; bump with the 4.0 release train. */
  const WEB_VERSION = '3.9';
  const FLAGS_MS = 6 * 3600_000;
  const TELEMETRY_MS = 60_000;

  // app.css styles the phone Home only under <html class="home">; an index.html cached from before
  // the class existed (the service worker refreshes each shell file on its own) still gets them.
  document.documentElement.classList.add('home');

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  // ---------------------------------------------------------------------------------------------
  // Local state (localStorage twins of the app's SharedPreferences)
  // ---------------------------------------------------------------------------------------------

  const store = {
    get(k, def) {
      try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; }
    },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  const favorites = {
    teams: new Set(store.get('fav_teams', [])),
    leagues: new Set(store.get('fav_leagues', [])),
    categories: new Map(),
    save() { store.set('fav_teams', [...this.teams]); store.set('fav_leagues', [...this.leagues]); },
    isEmpty() { return !this.teams.size && !this.leagues.size; },
    leagueOf(e) { return (e.league || this.categories.get(e.categoryId) || '').toLowerCase(); },
    matches(e) {
      if (e.home && this.teams.has(e.home.toLowerCase())) return true;
      if (e.away && this.teams.has(e.away.toLowerCase())) return true;
      const l = this.leagueOf(e);
      return !!l && this.leagues.has(l);
    },
    toggleTeam(name) { const k = name.toLowerCase(); this.teams.has(k) ? this.teams.delete(k) : this.teams.add(k); this.save(); },
    toggleLeague(key) { const k = key.toLowerCase(); this.leagues.has(k) ? this.leagues.delete(k) : this.leagues.add(k); this.save(); },
  };

  const recents = {
    load() {
      const now = Date.now();
      return store.get('recents', []).filter((it) => now - it.at < RECENT_MAX_AGE);
    },
    record(e) {
      const list = this.load().filter((it) => it.event.id !== e.id);
      list.unshift({ at: Date.now(), event: e });
      store.set('recents', list.slice(0, RECENT_MAX));
    },
  };

  let snapshot = null;
  /** True while `snapshot` is the last saved schedule, painted before the first fetch answers. */
  let snapshotCached = false;
  /** The last /api/schedule failure ('' while the latest load worked): phones say so on screen. */
  let scheduleError = '';
  /**
   * Phones: a schedule older than this (no network, the Worker down, an app back after a night) no
   * longer passes as live: no LIVE flags, pulses, counts or ranks; its games read "Last seen".
   */
  const STALE_MS = 20 * 60e3;
  /** When this device got the schedule (its own clock, so a skewed phone clock cannot age it). */
  const snapshotAt = () => {
    const t = snapshot && (Number(snapshot.receivedAt) || Number(snapshot.fetchedAt));
    return t > 0 ? t : Date.now();
  };
  const phoneStale = () => !!snapshot && Date.now() - snapshotAt() > STALE_MS;
  const SNAPSHOT_KEY = 'snapshot';
  /** Chip that collects games with premium-only servers (kept out of the regular rows). */
  const PREMIUM_CHIP = '★ Premium Only';
  let filterName = store.get('filter_category', null);
  let lastLayoutKey = '';
  const cardsById = new Map(); // id -> [card elements]
  let focusedId = null;

  /**
   * The viewer's site account (Account.java). The Worker holds the site cookies in an encrypted
   * cookie of its own; this is only what it tells us: signed in, premium seen unlocked/locked
   * (null until a premium server has been tried), and whether the account has a Live TV playlist.
   */
  let account = store.get('account', { signedIn: false, premium: null, iptv: false });
  /** Shared premium pool (your one StreamEast account, 5 connections). Never the cookies. */
  let pool = store.get('pool', { shared: false, used: 0, max: 5, sharedIptv: false, sharedPremium: null });

  function clientId() {
    let id = store.get('client_id', '');
    if (typeof id !== 'string' || id.length < 8) {
      id = (crypto.randomUUID && crypto.randomUUID()) || ('web-' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36));
      store.set('client_id', id);
    }
    return id;
  }

  // Remote feature flags (config.json `features`, resolved by the Worker for this client id).
  // The last answer is kept so a flag-gated feature does not flicker on a slow start.
  const flags = {
    values: store.get('flags', {}),
    on(name, def = false) { return name in this.values ? this.values[name] === true : def; },
    async load() {
      try {
        const r = await fetch(`/api/flags?platform=web&device=${encodeURIComponent(clientId())}&version=${WEB_VERSION}`, { cache: 'no-store' });
        if (!r.ok) return;
        const d = await r.json();
        if (d && d.flags) { this.values = d.flags; store.set('flags', d.flags); }
        document.documentElement.dataset.flags = Object.keys(this.values).filter((k) => this.values[k]).join(' ');
      } catch { /* keep the last answer */ }
    },
  };
  window.styxFlags = flags;
  window.styxPlayer = { forceMigrate: () => player.forceMigrate() };

  /**
   * Anonymous playback telemetry (see web/src/telemetry.js): start (time to first frame),
   * stall, switch, error, stop. Batched every minute and when the player closes; the batch is
   * keyed by the same client id as /api/ping. Off when the `telemetry` flag is off.
   */
  const telemetry = {
    queue: [],
    push(ev) {
      if (!flags.on('telemetry', true)) return;
      this.queue.push({ at: Date.now(), ...ev });
      if (this.queue.length >= 40) this.flush();
    },
    flush(unloading = false) {
      if (!this.queue.length) return;
      const body = JSON.stringify({ device: clientId(), platform: 'web', version: WEB_VERSION, network: 'direct', events: this.queue.splice(0, 50) });
      if (unloading && navigator.sendBeacon) { navigator.sendBeacon('/api/telemetry', new Blob([body], { type: 'application/json' })); return; }
      fetch('/api/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true, cache: 'no-store' }).catch(() => {});
    },
  };

  // Cast to a paired TV (web/src/cast.js). Pair once with the code the TV shows (Home → Pair
  // phone); then "Send to <TV>" in a card's long-press menu or the player's 📺 opens it there.
  const cast = {
    tvs: [],
    enabled() { return flags.on('cast', true); },
    async refresh() {
      if (!this.enabled()) { this.tvs = []; return; }
      try { this.tvs = (await api('/api/cast/targets?phone=' + encodeURIComponent(clientId()))).tvs || []; } catch { /* keep */ }
      const b = $('p-cast');
      if (b) b.classList.toggle('hidden', !this.enabled());
    },
    async send(tv, e) {
      try {
        await api('/api/cast/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: clientId(), tv: tv.id, cmd: 'open', event: e }) });
        // Handed off: the phone stops playing that game (and gives back any premium slot).
        const here = !$('player').classList.contains('hidden') && player.event && player.event.id === e.id;
        if (here) player.close();
        appToast(here ? `Now playing on ${tv.name}` : `Sent to ${tv.name}`, 'ok');
        return true;
      } catch (err) {
        appToast(err.message);
        this.refresh();
        return false;
      }
    },
    async claim(code) {
      const r = await api('/api/cast/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: clientId(), code }) });
      await this.refresh();
      return r.tv;
    },
    async unpair(tv) {
      try { await api('/api/cast/unpair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: clientId(), tv: tv.id }) }); } catch { /* next refresh shows it */ }
      await this.refresh();
      appToast(`Removed ${tv.name}`, 'ok');
    },
  };

  let appToastTimer = null;
  /** Phones: a sheet opening takes the toast down (it sat on the sheet's last row). */
  function hideToast() {
    clearTimeout(appToastTimer);
    $('toast').classList.add('hidden');
  }
  /**
   * `kind` 'ok' for a success (Sent / Paired / Removed); anything else reads as an error on phones.
   * `sub` (phones): a quieter second line under the message ("Now in Your teams").
   */
  function appToast(text, kind, sub) {
    if (!$('player').classList.contains('hidden')) return player.toast(text);
    const t = $('toast');
    if (sub && isPhone()) {
      const tx = el('span', 'tt');
      tx.append(el('b', null, text), el('small', null, sub));
      t.replaceChildren(tx);
    } else t.textContent = text;
    t.classList.toggle('two', !!sub && isPhone());
    t.classList.toggle('error', kind !== 'ok');
    t.classList.remove('hidden');
    clearTimeout(appToastTimer);
    appToastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
  }

  function setAccount(a) {
    const changed = !account || a.signedIn !== account.signedIn || a.premium !== account.premium || a.iptv !== account.iptv;
    account = { signedIn: !!a.signedIn, premium: a.premium === true ? true : a.premium === false ? false : null, iptv: !!a.iptv };
    store.set('account', account);
    if (a.pool) {
      pool = {
        shared: !!a.pool.shared,
        used: Number(a.pool.used) || 0,
        max: Number(a.pool.max) || 5,
        sharedIptv: !!a.pool.sharedIptv,
        sharedPremium: a.pool.sharedPremium === true ? true : a.pool.sharedPremium === false ? false : null,
      };
      store.set('pool', pool);
    }
    if (changed) { lastLayoutKey = ''; render(); renderAccountButton(); }
    else renderAccountButton();
  }

  /** Hide premium-only games from the regular rows: no own premium, and no shared pool. */
  function premiumHidden() {
    if (account.signedIn) return account.premium === false;
    if (pool.shared) return pool.sharedPremium === false;
    return true;
  }

  function hasLiveTv() {
    return account.iptv || (pool.shared && pool.sharedIptv);
  }

  function usesOwnAccount() {
    return account.signedIn && account.premium !== false;
  }

  async function loadAccount() {
    try {
      setAccount(await api('/api/account'));
    } catch { /* keep the cached state */ }
  }

  // ---------------------------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------------------------

  async function api(path, init) {
    const res = await fetch(path, { cache: 'no-store', ...(init || {}) });
    if (res.status === 401) { // session expired or cleared: back to the password screen
      location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
      await new Promise(() => {}); // never resolves; the page is navigating away
    }
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { msg = (await res.json()).error || msg; } catch { /* plain */ }
      throw new Error(msg);
    }
    return res.json();
  }

  async function loadSchedule(userVisible) {
    if (userVisible) $('status').textContent = 'Refreshing…';
    try {
      const s = await api('/api/schedule');
      s.receivedAt = Date.now();
      snapshot = s;
      snapshotCached = false;
      scheduleError = '';
      store.set(SNAPSHOT_KEY, s); // painted instantly on the next launch, like the app's disk snapshot
      renderBg();
      loadGames(); // phones only: team colours / codes and closeness for the score list
    } catch (e) {
      scheduleError = e.message || 'Failed to fetch';
      if (!snapshot) showProblem(navigator.onLine === false ? 'You’re offline.\nConnect to the internet, then tap Retry.' : 'Could not load the schedule.\n' + e.message);
      else if (isPhone()) renderBg(); // the offline bar, the footer, and "Last seen" once the copy is old
      else $('status').textContent = 'Offline · ' + e.message;
    }
  }

  const ENDED_RE = /^\s*(final.*|ft|full[ -]?time|ended|finished|game over)\s*$/i;

  function mergeStatus(root) {
    if (!snapshot || !root || !root.m) return;
    const byId = new Map(snapshot.events.map((e) => [e.id, e]));
    for (const [id, st] of Object.entries(root.m)) {
      const e = byId.get(id);
      if (!e || !st) continue;
      const cls = String(st.vCls || '');
      const txt = String(st.vTxt || '').trim();
      const ended = st.esEnd === 1 || cls.includes('final') || ENDED_RE.test(txt);
      const live = !ended && (st.lw === true || cls.includes('live'));
      if (live || ended) {
        e.live = live;
        e.ended = ended;
        const label = ended ? String(st.endLab || txt).trim() : txt;
        if (label) e.liveText = label;
        const sc = String(st.vSc || '').trim();
        if (sc) e.score = sc;
      }
    }
  }

  async function refreshStatus() {
    if (!snapshot || document.hidden) return;
    try {
      mergeStatus(await api('/api/status'));
      if (isPhone()) rerank(); // a game that just ended gives up its 🔥 number
      for (const [, cards] of cardsById) for (const c of cards) bindDynamic(c, c._event);
      if (isPhone()) { refreshPhoneCounts(); updateStatusText(); refreshPhoneSheet(); }
      player.updateHud();
    } catch { /* optional */ }
  }

  // ---------------------------------------------------------------------------------------------
  // Home rendering
  // ---------------------------------------------------------------------------------------------

  const rowOrder = (a, b) => {
    const ga = a.ended ? 2 : a.live ? 0 : 1;
    const gb = b.ended ? 2 : b.live ? 0 : 1;
    if (ga !== gb) return ga - gb;
    if (a.live) {
      const ra = a.hotRank > 0 ? a.hotRank : 1e9;
      const rb = b.hotRank > 0 ? b.hotRank : 1e9;
      if (ra !== rb) return ra - rb;
    }
    return a.startTs - b.startTs;
  };

  function favoritesFirst(list) {
    if (favorites.isEmpty()) return list;
    const mine = list.filter((e) => favorites.matches(e));
    return mine.length ? mine.concat(list.filter((e) => !favorites.matches(e))) : list;
  }

  function buildRows(s) {
    const rows = [];
    favorites.categories = new Map(s.categories.map((c) => [c.id, c.name]));
    // Without a premium account, games that only have premium servers are kept out of the regular
    // rows and collected under their own chip, like the app does. With one, every game passes.
    const hidden = premiumHidden();
    if (!hidden && filterName === PREMIUM_CHIP) { filterName = null; store.set('filter_category', null); }
    // Phones: a remembered Premium Only on a day without premium-only games opens on All.
    if (isPhone() && filterName === PREMIUM_CHIP && !s.events.some((e) => e.premium)) { filterName = null; store.set('filter_category', null); }
    const premiumOnly = hidden && filterName === PREMIUM_CHIP;
    const filter = filterName && !premiumOnly ? s.categories.find((c) => c.name === filterName) : null;
    if (filterName && !filter && !premiumOnly) { filterName = null; store.set('filter_category', null); }
    const events = hidden ? s.events.filter((e) => !!e.premium === premiumOnly) : s.events;

    const byCat = new Map();
    for (const c of s.categories) byCat.set(c.id, []);
    for (const e of events) {
      if (!byCat.has(e.categoryId)) {
        byCat.set(e.categoryId, []);
        s.categories.push({ id: e.categoryId, name: e.categoryId ? 'Category ' + e.categoryId : 'Other', liveCount: 0, soonCount: 0 });
      }
      byCat.get(e.categoryId).push(e);
    }
    for (const list of byCat.values()) list.sort(rowOrder);

    if (!filter && !premiumOnly) {
      const byId = new Map(s.events.map((e) => [e.id, e]));
      let recent = recents.load().map((it) => byId.get(it.event.id) || it.event);
      // Phones: only games still in the schedule (a saved copy's LIVE and score are frozen), none locked.
      if (isPhone()) recent = recent.filter((e) => byId.get(e.id) === e && !(hidden && e.premium));
      recent = recent.slice(0, MAX_CONTINUE);
      if (recent.length) rows.push({ title: 'Continue watching', sub: 'Games you opened recently', events: recent });
    }
    if (!favorites.isEmpty()) {
      const mine = events.filter((e) => favorites.matches(e) && (!filter || e.categoryId === filter.id)).sort(rowOrder);
      if (mine.length) rows.push({ title: 'Your teams', sub: 'Starred teams and leagues', events: mine });
    }
    const live = events.filter((e) => e.live && !e.ended && (!filter || e.categoryId === filter.id)).sort(rowOrder);
    if (live.length) rows.push({ title: 'Live now', sub: `${live.length} live`, events: favoritesFirst(live) });

    for (const c of s.categories) {
      if (filter && c !== filter) continue;
      const list = byCat.get(c.id) || [];
      if (!list.length) continue;
      rows.push({ title: c.name, sub: categorySub(list), events: favoritesFirst(list), category: true });
    }
    return { rows: isPhone() ? phoneRows(rows, filter, premiumOnly) : rows, filter, premiumOnly };
  }

  function categorySub(list) {
    let liveN = 0, endedN = 0;
    for (const e of list) { if (e.ended) endedN++; else if (e.live) liveN++; }
    const upcoming = list.length - liveN - endedN;
    const parts = [];
    if (liveN) parts.push(`${liveN} live`);
    if (upcoming || !liveN) parts.push(`${upcoming} upcoming`);
    if (endedN) parts.push(`${endedN} final`);
    return parts.join(' · ');
  }

  /**
   * Phones: Your teams, then Live now, then Continue watching, then the leagues - and a game shows
   * up only in the first of those that lists it (the TV repeats live games in every row; on a
   * phone that doubled the scrolling). With a league (or Premium Only) selected it is one page of
   * that league's games, live first, in time groups.
   */
  function phoneRows(rows, filter, premiumOnly) {
    if (filter || premiumOnly) {
      const seen = new Set();
      const events = [];
      for (const r of rows) for (const e of r.events) if (!seen.has(e.id)) { seen.add(e.id); events.push(e); }
      events.sort(phoneOrder);
      return events.length ? [{ kind: 'page', title: filter ? filter.name : 'Premium', sub: '', events, page: true, grouped: true, mixed: !!premiumOnly }] : [];
    }
    const rank = (r) => (r.title === 'Your teams' ? 0 : r.title === 'Live now' ? 1 : r.title === 'Continue watching' ? 2 : 3);
    const seen = new Set();
    const out = [];
    let liveTaken = 0;
    const stale = phoneStale();
    for (const r of rows.map((r, i) => [r, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0])) {
      let events = r.events.filter((e) => !seen.has(e.id));
      if (r.title === 'Live now') liveTaken = r.events.length - events.length;
      for (const e of events) seen.add(e.id);
      if (!events.length) continue;
      const kind = r.category ? 'cat' : r.title === 'Your teams' ? 'fav' : r.title === 'Live now' ? 'live' : 'recent';
      // Live now reads #1, #2, #3... down the list (rerank numbers the live games in that order).
      if (kind === 'live') events = events.slice().sort((a, b) => (rankOf(a) || 1e9) - (rankOf(b) || 1e9));
      else if (kind === 'fav') events = events.slice().sort(phoneOrder); // its live games #1, #2... too
      // Live now: the count only when it differs from the dateline's ("5 more live" after Your teams).
      // An old copy (offline): what was live when it was saved, never "Live now".
      const ranked = kind === 'live' ? events.filter((e) => rankOf(e) > 0).length : 0;
      const sub = kind === 'cat' ? phoneSub(events)
        : kind === 'live' ? (stale ? 'Not updating' : liveTaken ? `${events.length} more live` : ranked >= 2 ? 'Most watched first' : '')
          : kind === 'fav' ? `${events.length} ${events.length === 1 ? 'game' : 'games'}`
            : 'Opened recently';
      const title = kind === 'live' && stale ? 'Last seen live' : r.title;
      out.push({ ...r, title, events, sub, subLive: kind === 'live' && !!liveTaken && !stale, kind, grouped: kind === 'cat', mixed: kind !== 'cat' });
    }
    return out;
  }
  /** rowOrder with the live games by the phone's own numbers (#1, #2... as their tiles read). */
  const phoneOrder = (a, b) => {
    if (a.live && !a.ended && b.live && !b.ended) {
      const d = (rankOf(a) || 1e9) - (rankOf(b) || 1e9);
      if (d) return d;
    }
    return rowOrder(a, b);
  };
  /** "8:59 PM" (this device's clock format). */
  const clockTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  /** categorySub for phones: no zero parts ("5 final", never "0 upcoming · 5 final"). */
  function phoneSub(list, skipLive) {
    let liveN = 0, endedN = 0;
    for (const e of list) { if (e.ended) endedN++; else if (e.live) liveN++; }
    const upcoming = list.length - liveN - endedN;
    const parts = [];
    if (liveN && !skipLive) parts.push(`${liveN} live`);
    if (upcoming) parts.push(`${upcoming} upcoming`);
    if (endedN) parts.push(`${endedN} final`);
    return parts.join(' · ');
  }

  function render() {
    const s = snapshot;
    if (!s) return;
    if (isPhone()) {
      // Phones: one bad scraped value must never leave the page half built behind "Loading events…"
      // (or stop the boot sequence): a failed build is rebuilt by the next render.
      try {
        rerank(); // before phoneRows, which orders Live now by these numbers
        const { rows, filter, premiumOnly } = buildRows(s);
        renderChips(s); // after buildRows, which drops a saved filter that no longer applies
        renderPhone(s, rows, filter, premiumOnly);
        refreshPhoneSheet();
      } catch (err) {
        lastLayoutKey = '';
        $('overlay').classList.add('hidden');
        console.error('Styx Sports: phone render', err);
      }
      return;
    }
    renderChips(s);
    const { rows, filter, premiumOnly } = buildRows(s);
    const key = rows.map((r) => r.title + ':' + r.events.map((e) => e.id).join(',')).join('|');
    if (key === lastLayoutKey && cardsById.size) {
      // Same cards in the same places: refresh the changing bits without disturbing scroll/focus.
      for (const [, cards] of cardsById) for (const c of cards) bindDynamic(c, byId(c._event.id) || c._event);
      updateStatusText();
      return;
    }
    lastLayoutKey = key;
    cardsById.clear();
    const root = $('rows');
    root.replaceChildren();
    for (const r of rows) root.appendChild(renderRow(r));
    if (!rows.length) {
      const msg = premiumOnly ? 'No premium-only games right now.' : filter ? `No ${filter.name} games right now.` : 'No games listed right now.';
      root.appendChild(el('div', 'empty', msg));
    }
    if (premiumOnly) {
      const note = el('div', 'note');
      note.append(account.signedIn
        ? 'These games only have premium servers on the site, and this account does not seem to have premium. '
        : pool.shared ? 'These games only have premium servers on the site, and the shared account’s premium servers were locked. '
          : 'These games only have premium servers on the site. ');
      if (!account.signedIn) {
        const b = el('button', 'link-btn', 'Sign in to your premium account');
        b.onclick = () => acct.open();
        note.append(b, ' to watch them.');
      }
      root.appendChild(note);
    }
    $('overlay').classList.add('hidden');
    updateStatusText();
    restoreFocus();
  }

  function byId(id) {
    return snapshot ? snapshot.events.find((e) => e.id === id) : null;
  }

  function updateStatusText() {
    if (!snapshot) return;
    const live = snapshot.events.filter((e) => e.live && !e.ended).length;
    const t = new Date(snapshot.fetchedAt || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    $('status').textContent = snapshotCached ? `Saved ${t} · updating…` : `Updated ${t} · ${live} live`;
    const site = $('open-site');
    if (site && snapshot.base) site.href = snapshot.base + '/';
    // Phones draw the outward arrow as the row's trailing accessory (CSS), not in the label.
    if (site) { const label = isPhone() ? 'Open the site' : 'Open the site ↗'; if (site.textContent !== label) site.textContent = label; }
    if (isPhone()) updatePhoneStatus(t);
  }

  function renderChips(s) {
    if (isPhone()) return renderPhoneChips(s);
    const nav = $('chips');
    nav.replaceChildren();
    const mk = (name, label) => {
      const b = el('button', 'chip' + ((name || null) === (filterName || null) ? ' selected' : ''), label);
      b.onclick = () => { filterName = name; store.set('filter_category', name); lastLayoutKey = ''; render(); };
      return b;
    };
    nav.appendChild(mk(null, 'All'));
    const hidden = premiumHidden();
    for (const c of s.categories) if (s.events.some((e) => e.categoryId === c.id && (!hidden || !e.premium))) nav.appendChild(mk(c.name, c.name));
    if (hidden && s.events.some((e) => e.premium)) {
      const b = mk(PREMIUM_CHIP, PREMIUM_CHIP);
      b.classList.add('premium');
      nav.appendChild(b);
    }
    if (hasLiveTv()) {
      // Opens the Live TV screen; never a filter (HomeActivity's Live TV chip).
      const b = el('button', 'chip livetv', '📺 Live TV');
      b.onclick = () => liveTv.open();
      nav.appendChild(b);
    }
    const sel = nav.querySelector('.selected');
    if (sel) sel.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  function renderRow(r) {
    if (isPhone()) return renderPhoneRow(r);
    const row = el('section', 'row');
    const head = el('div', 'row-head');
    head.appendChild(el('span', 'row-title', r.title));
    head.appendChild(el('span', 'row-sub', r.sub));
    row.appendChild(head);
    const strip = el('div', 'strip');
    for (const e of r.events) strip.appendChild(createCard(e));
    row.appendChild(strip);
    return row;
  }

  const LEAGUE_NAMES = {
    epl: 'Premier League', laliga: 'La Liga', seriea: 'Serie A', ligue1: 'Ligue 1', bundesliga: 'Bundesliga',
    bundesliga2: '2. Bundesliga', mls: 'MLS', championship: 'Championship', leagueone: 'League One',
    leaguetwo: 'League Two', eredivisie: 'Eredivisie', ligamx: 'Liga MX', portugal: 'Primeira Liga',
    argentina: 'Argentine Primera', brazil: 'Brasileirão', colombia: 'Colombian Primera A',
    ucl: 'Champions League', uel: 'Europa League',
  };

  function prettyLeague(key) {
    if (!key) return '';
    const known = LEAGUE_NAMES[key.toLowerCase()];
    if (known) return known;
    const s = key.replace(/[-_]/g, ' ');
    return s.length <= 4 ? s.toUpperCase() : s[0].toUpperCase() + s.slice(1);
  }

  function startLabel(ts) {
    if (!ts) return 'Upcoming';
    const d = new Date(ts * 1000);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return sameDay ? time : d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
  }

  function crest(url) {
    const img = el('img', 'crest');
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    if (url) {
      img.src = url;
      img.onerror = () => { img.removeAttribute('src'); img.classList.add('placeholder'); };
    } else {
      img.classList.add('placeholder');
    }
    return img;
  }

  function team(name, crestUrl) {
    const col = el('div', 'team');
    col.appendChild(crest(crestUrl));
    col.appendChild(el('div', 'team-name', name));
    return col;
  }

  // Phones (portrait) get a score list instead of the TV's card strips: one row per game, and
  // each game listed once (see phoneRows).
  const phoneMq = matchMedia('(max-width: 600px)');
  const isPhone = () => phoneMq.matches;
  // Phones keep their place across a rebuild themselves (renderPhone); the browser's own restore on
  // the player's history.back() would undo that (it jumps back to the old offset).
  const syncScrollRestore = () => { try { history.scrollRestoration = isPhone() ? 'manual' : 'auto'; } catch { /* old browsers */ } };
  syncScrollRestore();
  phoneMq.addEventListener('change', () => {
    syncScrollRestore();
    hideMenu(); // the phone sheet and the TV's floating menu are different things
    // A phone's two-line toast ("Starred ..." / "Now in Your teams") has no TV styles: it goes.
    if ($('toast').classList.contains('two')) hideToast();
    lastLayoutKey = '';
    phoneChipsKey = '';
    phoneChipsShape = '';
    phonePage = null;
    render();
    renderAccountButton();
    // Open overlays built for the other layout: the phone's icons in them are sized by phone styles only.
    acct.relayout();
    if (liveTv.isOpen()) liveTv.syncTitle();
    if (!$('install-hint').classList.contains('hidden')) pwa.hintText();
    loadGames();
  });

  /** "LIVE  Q3 4:12"; just "LIVE" when the status text says nothing more (Redzone's is "Live"). */
  function liveLabel(e) {
    return 'LIVE' + (e.liveText && e.liveText.toLowerCase() !== 'live' ? '  ' + e.liveText : '');
  }

  // =============================================================================================
  // Phone Home (portrait, <= 600px wide): the "editorial broadcast" score list
  // =============================================================================================
  // Everything in this block runs only behind isPhone(); the TV / desktop / sideways-phone paths
  // stay as they were. Same data as the TV (the schedule, merged with /api/status), plus
  // /api/games for what the schedule lacks: team brand colours, short codes, closeness and heat.
  // Without /api/games the list still renders, in neutral colours with locally computed closeness.

  /** Static, trusted icon markup only (never data). */
  const icon = (markup) => {
    const t = document.createElement('template');
    t.innerHTML = markup.trim();
    return t.content.firstChild;
  };
  const I = {
    star: '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M10 1.8l2.47 5.18 5.69.7-4.2 3.9 1.1 5.63L10 14.43 4.94 17.2l1.1-5.63-4.2-3.9 5.69-.7z"/></svg>',
    starO: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M10 2.3l2.3 4.9 5.3.66-3.9 3.64 1.02 5.25L10 14.17l-4.72 2.58 1.02-5.25-3.9-3.64 5.3-.66z"/></svg>',
    flame: '<svg viewBox="0 0 10 12" fill="currentColor" aria-hidden="true"><path d="M5.3 0c.3 2-1 3-1.9 4.2C2.5 5.3 1 6.3 1 8.3 1 10.4 2.8 12 5 12s4-1.5 4-3.8c0-1.6-.8-2.8-1.6-3.6.1 1-.3 1.8-1 2.2C6.7 4.5 6.6 1.6 5.3 0z"/></svg>',
    bolt: '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M7 0L1.5 7H5.5L4.5 12 10.5 5H6.5z"/></svg>',
    play: '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M2.5 1.2v9.6c0 .5.5.8.9.5l7.4-4.8c.4-.3.4-.8 0-1L3.4.7c-.4-.3-.9 0-.9.5z"/></svg>',
    tv: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3.5" width="16" height="11" rx="2"/><path d="M7 17.5h6"/></svg>',
    plus: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M10 6.5v7M6.5 10h7"/></svg>',
    minus: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M6.5 10h7"/></svg>',
    flag: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 3h1.6v18H5z"/><path d="M7 4h12v9H7z" fill-opacity=".18"/><path d="M7 4h3v3H7zm6 0h3v3h-3zm-3 3h3v3h-3zm6 0h3v3h-3zM7 10h3v3H7zm6 0h3v3h-3z"/></svg>',
    bcast: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="2"/><path d="M7.8 7.8a6 6 0 000 8.4M16.2 7.8a6 6 0 010 8.4M5 5a10 10 0 000 14M19 5a10 10 0 010 14"/></svg>',
    check: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M6.6 10.3l2.3 2.3 4.5-4.9"/></svg>',
    info: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M10 9v4.6"/><circle cx="10" cy="6.4" r=".4" fill="currentColor"/></svg>',
    share: '<svg viewBox="0 0 16 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Share"><path d="M5.2 7.5H3.5A1.5 1.5 0 002 9v8a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0014 17V9a1.5 1.5 0 00-1.5-1.5h-1.7"/><path d="M8 1.5v10.5M5 4.5l3-3 3 3"/></svg>',
  };

  /** The lead (hero) game's id, kept while it still qualifies (see pickLead). */
  let phoneLeadId = null;
  /** What the chips row was last built from, so a refresh does not reset its sideways scroll. */
  let phoneChipsKey = '';
  let phoneChipsShape = '';
  /** The iOS band glow last written to :root. */
  let phoneGlow = '';
  /** The Next up lead starts first of every game listed ("UP NEXT"); else it is "COMING UP". */
  let phoneLeadNext = true;
  /** Phone sheet: the card focus goes back to on close, and the pair view's keyboard listener. */
  let sheetReturn = null;
  let sheetKeyboard = null;

  // --- /api/games enrichment -------------------------------------------------------------------

  const TEAM_META_KEY = 'team_meta';
  const TEAM_META_MAX = 400;
  const GAMES_MIN_GAP_MS = 50_000;
  const HEX_RE = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  const cleanColors = (c) => (Array.isArray(c) ? c.map(String).filter((x) => HEX_RE.test(x)).slice(0, 2) : []);

  /**
   * The server's own team table (design/teams.json: "Name|CODE|primary|secondary;..."), so a first
   * visit paints the real codes and colours before /api/games answers (it never flips BOR -> BMN).
   * /api/games stays the authority: its answer overrides an entry here.
   */
  const KNOWN_TEAMS = new Map();
  for (const row of 'Arizona Cardinals|ARI|97233F|000000;Atlanta Falcons|ATL|A71930|000000;Baltimore Ravens|BAL|241773|9E7C0C;Buffalo Bills|BUF|00338D|C60C30;Carolina Panthers|CAR|0085CA|101820;Chicago Bears|CHI|0B162A|C83803;Cincinnati Bengals|CIN|FB4F14|000000;Cleveland Browns|CLE|311D00|FF3C00;Dallas Cowboys|DAL|003594|869397;Denver Broncos|DEN|FB4F14|002244;Detroit Lions|DET|0076B6|B0B7BC;Green Bay Packers|GB|203731|FFB612;Houston Texans|HOU|03202F|A71930;Indianapolis Colts|IND|002C5F|A2AAAD;Jacksonville Jaguars|JAX|006778|D7A22A;Kansas City Chiefs|KC|E31837|FFB81C;Las Vegas Raiders|LV|000000|A5ACAF;Los Angeles Chargers|LAC|0080C6|FFC20E;Los Angeles Rams|LAR|003594|FFA300;Miami Dolphins|MIA|008E97|FC4C02;Minnesota Vikings|MIN|4F2683|FFC62F;New England Patriots|NE|002244|C60C30;New Orleans Saints|NO|D3BC8D|101820;New York Giants|NYG|0B2265|A71930;New York Jets|NYJ|125740|000000;Philadelphia Eagles|PHI|004C54|A5ACAF;Pittsburgh Steelers|PIT|FFB612|101820;San Francisco 49ers|SF|AA0000|B3995D;Seattle Seahawks|SEA|002244|69BE28;Tampa Bay Buccaneers|TB|D50A0A|34302B;Tennessee Titans|TEN|0C2340|4B92DB;Washington Commanders|WAS|5A1414|FFB612;Arizona Diamondbacks|ARI|A71930|E3D4AD;Atlanta Braves|ATL|CE1141|13274F;Baltimore Orioles|BAL|DF4601|000000;Boston Red Sox|BOS|BD3039|0C2340;Chicago Cubs|CHC|0E3386|CC3433;Chicago White Sox|CWS|27251F|C4CED4;Cincinnati Reds|CIN|C6011F|000000;Cleveland Guardians|CLE|00385D|E50022;Colorado Rockies|COL|333366|C4CED4;Detroit Tigers|DET|0C2340|FA4616;Houston Astros|HOU|002D62|EB6E1F;Kansas City Royals|KC|004687|BD9B60;Los Angeles Angels|LAA|BA0021|003263;Los Angeles Dodgers|LAD|005A9C|EF3E42;Miami Marlins|MIA|00A3E0|EF3340;Milwaukee Brewers|MIL|12284B|FFC52F;Minnesota Twins|MIN|002B5C|D31145;New York Mets|NYM|002D72|FF5910;New York Yankees|NYY|0C2340|C4CED3;Oakland Athletics|OAK|003831|EFB21E;Athletics|ATH|003831|EFB21E;Philadelphia Phillies|PHI|E81828|002D72;Pittsburgh Pirates|PIT|27251F|FDB827;San Diego Padres|SD|2F241D|FFC425;San Francisco Giants|SF|FD5A1E|27251F;Seattle Mariners|SEA|0C2C56|005C5C;St. Louis Cardinals|STL|C41E3A|0C2340;Tampa Bay Rays|TB|092C5C|8FBCE6;Texas Rangers|TEX|003278|C0111F;Toronto Blue Jays|TOR|134A8E|1D2D5C;Washington Nationals|WSH|AB0003|14225A;Atlanta Hawks|ATL|E03A3E|C1D32F;Boston Celtics|BOS|007A33|BA9653;Brooklyn Nets|BKN|000000|FFFFFF;Charlotte Hornets|CHA|1D1160|00788C;Chicago Bulls|CHI|CE1141|000000;Cleveland Cavaliers|CLE|860038|FDBB30;Dallas Mavericks|DAL|00538C|002B5E;Denver Nuggets|DEN|0E2240|FEC524;Detroit Pistons|DET|C8102E|1D42BA;Golden State Warriors|GSW|1D428A|FFC72C;Houston Rockets|HOU|CE1141|000000;Indiana Pacers|IND|002D62|FDBB30;Los Angeles Clippers|LAC|C8102E|1D428A;LA Clippers|LAC|C8102E|1D428A;Los Angeles Lakers|LAL|552583|FDB927;Memphis Grizzlies|MEM|5D76A9|12173F;Miami Heat|MIA|98002E|F9A01B;Milwaukee Bucks|MIL|00471B|EEE1C6;Minnesota Timberwolves|MIN|0C2340|236192;New Orleans Pelicans|NOP|0C2340|C8102E;New York Knicks|NYK|006BB6|F58426;Oklahoma City Thunder|OKC|007AC1|EF6100;Orlando Magic|ORL|0077C0|C4CED4;Philadelphia 76ers|PHI|006BB6|ED174C;Phoenix Suns|PHX|1D1160|E56020;Portland Trail Blazers|POR|E03A3E|000000;Sacramento Kings|SAC|5A2D81|63727A;San Antonio Spurs|SAS|C4CED4|000000;Toronto Raptors|TOR|CE1141|000000;Utah Jazz|UTA|002B5C|F9A01B;Washington Wizards|WAS|002B5C|E31837;Anaheim Ducks|ANA|F47A38|B9975B;Boston Bruins|BOS|FFB81C|000000;Buffalo Sabres|BUF|003087|FFB81C;Calgary Flames|CGY|D2001C|FAAF19;Carolina Hurricanes|CAR|CE1126|000000;Chicago Blackhawks|CHI|CF0A2C|000000;Colorado Avalanche|COL|6F263D|236192;Columbus Blue Jackets|CBJ|002654|CE1126;Dallas Stars|DAL|006847|8F8F8C;Detroit Red Wings|DET|CE1126|FFFFFF;Edmonton Oilers|EDM|041E42|FF4C00;Florida Panthers|FLA|041E42|C8102E;Los Angeles Kings|LAK|111111|A2AAAD;Minnesota Wild|MIN|154734|A6192E;Montreal Canadiens|MTL|AF1E2D|192168;Nashville Predators|NSH|FFB81C|041E42;New Jersey Devils|NJD|CE1126|000000;New York Islanders|NYI|00539B|F47D30;New York Rangers|NYR|0038A8|CE1126;Ottawa Senators|OTT|DA1A32|B79257;Philadelphia Flyers|PHI|F74902|000000;Pittsburgh Penguins|PIT|000000|FCB514;San Jose Sharks|SJS|006D75|EA7200;Seattle Kraken|SEA|001628|99D9D9;St. Louis Blues|STL|002F87|FCB514;Tampa Bay Lightning|TBL|002868|FFFFFF;Toronto Maple Leafs|TOR|00205B|FFFFFF;Utah Hockey Club|UTA|71AFE5|090909;Utah Mammoth|UTA|71AFE5|090909;Vancouver Canucks|VAN|00205B|00843D;Vegas Golden Knights|VGK|B4975A|333F42;Washington Capitals|WSH|041E42|C8102E;Winnipeg Jets|WPG|041E42|004C97'.split(';')) {
    const [n, short, c1, c2] = row.split('|');
    KNOWN_TEAMS.set(n.toLowerCase(), { short, colors: ['#' + c1, '#' + c2], known: true });
  }

  /**
   * Team identity (short code, two brand colours) by team name - kept in localStorage so the
   * first paint from the saved schedule already has colours - and per-game closeness / heat by id.
   */
  const meta = {
    teams: new Map(),
    games: new Map(),
    fetchedAt: 0,
    loading: false,
    restore() {
      const saved = store.get(TEAM_META_KEY, null);
      if (!saved || typeof saved !== 'object') return;
      for (const [k, v] of Object.entries(saved)) {
        if (v && typeof v === 'object') this.teams.set(k, { short: String(v.short || '').slice(0, 5), colors: cleanColors(v.colors), known: !!v.known });
      }
    },
    team(name) { const k = String(name || '').toLowerCase(); return this.teams.get(k) || KNOWN_TEAMS.get(k) || null; },
    /** Takes an /api/games answer; true when any team's colours or code changed (cards need rebuilding). */
    ingest(doc) {
      let changed = false;
      const games = new Map();
      for (const g of (doc && Array.isArray(doc.games) && doc.games) || []) {
        if (!g || g.id == null) continue;
        games.set(String(g.id), { statusText: String(g.statusText || ''), score: g.score || null, closeness: +g.closeness || 0, heat: +g.heat || 0 });
        for (const t of [g.home, g.away]) {
          if (!t || !t.name) continue;
          const k = String(t.name).toLowerCase();
          const next = { short: String(t.short || '').slice(0, 5), colors: cleanColors(t.colors), known: !!t.known };
          const prev = this.teams.get(k) || KNOWN_TEAMS.get(k);
          if (!prev || prev.short !== next.short || prev.known !== next.known || prev.colors.join() !== next.colors.join()) changed = true;
          this.teams.delete(k); // newest last, so the cap drops the oldest
          this.teams.set(k, next);
        }
      }
      this.games = games;
      while (this.teams.size > TEAM_META_MAX) this.teams.delete(this.teams.keys().next().value);
      if (changed) store.set(TEAM_META_KEY, Object.fromEntries(this.teams));
      return changed;
    },
  };
  meta.restore();

  /** Phones only, next to each schedule load (at most once per 50 s). Never shows an error. */
  async function loadGames() {
    if (!isPhone() || meta.loading || Date.now() - meta.fetchedAt < GAMES_MIN_GAP_MS) return;
    meta.loading = true;
    try {
      const doc = await api('/api/games');
      meta.fetchedAt = Date.now();
      if (meta.ingest(doc)) lastLayoutKey = ''; // team colours are set when a card is built
      renderBg();
    } catch { /* optional: the schedule alone still renders */ } finally {
      meta.loading = false;
    }
  }

  // --- team colours ----------------------------------------------------------------------------

  const hexRgb = (h) => {
    h = String(h).replace('#', '');
    if (h.length === 3) h = h.replace(/./g, '$&$&');
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  function rgbHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (mx + mn) / 2;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  }
  function hslRgb(h, s, l) {
    const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [f(0) * 255, f(8) * 255, f(4) * 255];
  }
  const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
  const hsla = (h, s, l, a = 1) => `hsla(${h.toFixed(0)}, ${(s * 100).toFixed(0)}%, ${(l * 100).toFixed(0)}%, ${a})`;
  const lum = (rgb) => {
    const c = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
  const isNeutral = ([, s, l]) => s < 0.12 && (l < 0.1 || l > 0.92);
  const PLACEHOLDER_COLORS = new Set(['#1b5e20', '#333333', '#1f2a44']); // games.js league / default fills, not a team
  const SILVER = rgbHsl(hexRgb('#a5acaf'));

  /** The colours to paint a team with, or null (neutral grey): known teams always; crest-derived
   *  colours too, unless they are a placeholder or identical on both sides (league colours). */
  function trusted(m, other) {
    if (!m || !m.colors || !m.colors.length) return null;
    if (m.known) return m.colors;
    if (PLACEHOLDER_COLORS.has(String(m.colors[0]).toLowerCase())) return null;
    if (other && other.colors && other.colors.join().toLowerCase() === m.colors.join().toLowerCase()) return null;
    return m.colors;
  }
  /** Primary, unless it is near-black or near-white (then the secondary). [h, s, l] or null. */
  function teamBase(colors) {
    if (!colors) return null;
    let c = rgbHsl(hexRgb(colors[0]));
    if ((c[2] < 0.1 || (c[1] < 0.15 && c[2] > 0.92)) && colors[1]) c = rgbHsl(hexRgb(colors[1]));
    return c;
  }
  /** Edge bars, glows: bright enough to read on black. */
  function accentOf(b) {
    if (!b) return 'hsl(0, 0%, 38%)';
    const [h, s, l] = b;
    return hsla(h, s < 0.12 ? s : clampN(s, 0.45, 0.85), clampN(l, 0.42, 0.62));
  }
  /** Panels white text sits on (hero halves, score bug, monograms): luminance capped at 0.13. */
  function deepOf(b, dl = 0, maxLum = 0.13) {
    let [h, s0, l0] = b || [220, 0.06, 0.2];
    // Gold / yellow cannot be darkened without turning olive: deepen it as bronze (amber) instead.
    if (s0 >= 0.3 && h >= 38 && h <= 68) { h = 33 - (h - 38) / 10; s0 = Math.max(s0, 0.85); }
    const s = Math.min(s0, 0.85);
    let l = clampN(l0 + dl, 0.14, 0.34);
    while (l > 0.08 && lum(hslRgb(h, s, l)) > maxLum) l -= 0.02;
    return hsla(h, s, l);
  }

  // Team names: "Las Vegas Raiders" = city "Las Vegas" + nickname "Raiders".
  const NICK2 = new Set(['red sox', 'white sox', 'blue jays', 'maple leafs', 'blue jackets', 'golden knights', 'red wings', 'trail blazers', 'red bulls', 'hockey club', 'golden bears']);
  const CLUB_WORD = /^(fc|afc|cf|sc|ac|as|cd|sv|vfb|vfl|tsg|rb|ss|us|1)$/i;
  function splitName(name) {
    const w = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (w.length < 2) return { city: [], nick: w };
    const two = w.length >= 3 && NICK2.has(w.slice(-2).join(' ').toLowerCase());
    return { city: w.slice(0, two ? -2 : -1), nick: w.slice(two ? -2 : -1) };
  }
  /** What the lead prints under the big code: the nickname in the US leagues ("Raiders"), else the name. */
  function nickOf(name, e) {
    const L = leagueName(catName(e));
    if (!(FOOTBALL.has(L) || HOCKEY.has(L) || BASKETBALL.has(L) || BASEBALL.has(L))) return name;
    const { city, nick } = splitName(name);
    return city.length && city.length + nick.length <= 4 && nick.join(' ').length >= 3 ? nick.join(' ') : name;
  }
  /**
   * A code for a team in neither table: the server's rule (initials() in web/src/games.js: first
   * letters of up to three words, or a one-word name's first three), so /api/games agrees with it.
   * Accents are folded first (Beşiktaş -> BES, São Paulo -> SP, Fenerbahçe -> FEN); a name with no
   * Latin letters at all (Greek, Arabic...) uses its own letters (Ολυμπιακός -> ΟΛΥ), never "?".
   */
  const FOLD = { ß: 'ss', ẞ: 'SS', ø: 'o', Ø: 'O', ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', ı: 'i', þ: 'th', Þ: 'TH', ð: 'd', Ð: 'D' };
  function nameWords(name) {
    const f = String(name || '').normalize('NFD').replace(/\p{M}/gu, '').replace(/[ßẞøØłŁđĐæÆœŒıþÞðÐ]/g, (c) => FOLD[c]);
    const latin = f.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    if (latin.some((w) => /[A-Za-z]/.test(w))) return latin;
    // Arabic names: the article "ال" would start every code.
    return f.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean).map((w) => (/^ال./u.test(w) && [...w].length > 3 ? w.slice(2) : w));
  }
  const first3 = (w) => [...w].slice(0, 3).join('');
  function codeOf(name) {
    const w = nameWords(name);
    if (!w.length) return '?';
    if (w.length === 1) return first3(w[0]).toUpperCase();
    return w.slice(0, 3).map((x) => [...x][0]).join('').toUpperCase();
  }
  /** Both sides got the same code (two "NY"s, two "MAN"s): codes built from the nickname instead. */
  function distinctCodes(a, b) {
    const tries = (name) => {
      const w = nameWords(name).filter((x, i, all) => all.length < 2 || !CLUB_WORD.test(x));
      if (w.length < 2) return [first3(w[0] || '?').toUpperCase()];
      const city = w.slice(0, -1).map((x) => [...x][0]).join('').slice(0, 2), nick = w[w.length - 1];
      return [first3(city + nick), first3(nick), city + [...nick].slice(-1).join('')].map((x) => x.toUpperCase());
    };
    const ta = tries(a), tb = tries(b);
    for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
      const x = ta[Math.min(i, ta.length - 1)], y = tb[Math.min(i, tb.length - 1)];
      if (x !== y) return [x, y];
    }
    return null;
  }
  /** Both sides of a game: code, colour base, accent; with the same-hue fix (away switches colour). */
  function looks(e) {
    const mh = meta.team(e.home), ma = e.away ? meta.team(e.away) : null;
    const ch = e.away ? trusted(mh, ma)
      : trusted(mh ? { ...mh, known: mh.known || !PLACEHOLDER_COLORS.has(String(mh.colors[0] || '').toLowerCase()) } : null, null);
    const ca = e.away ? trusted(ma, mh) : null;
    const bh = teamBase(ch);
    let ba = teamBase(ca);
    if (bh && ba && hueDist(bh[0], ba[0]) < 22 && bh[1] > 0.3 && ba[1] > 0.3) {
      const alt = ca && ca[1] ? rgbHsl(hexRgb(ca[1])) : null;
      ba = alt && !isNeutral(alt) && hueDist(alt[0], bh[0]) >= 22 ? alt : SILVER;
    }
    const side = (name, m, base) => ({ name, code: (m && m.short) || codeOf(name), base, accent: accentOf(base) });
    const home = side(e.home, mh, bh), away = e.away ? side(e.away, ma, ba) : null;
    if (away && home.code === away.code) {
      const d = distinctCodes(e.home, e.away);
      if (d) [home.code, away.code] = d;
    }
    return { home, away };
  }

  // --- period / closeness / heat ---------------------------------------------------------------
  // Verbatim from web/src/games.js (lines 21-42, 130-194) so the phone agrees with /api/games.

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
  // Looked up with scraped names: no prototype ("constructor", "__proto__" are not leagues).
  const LEAGUE_ALIASES = Object.assign(Object.create(null), { 'NCAA Football': 'NCAAF', 'College Football': 'NCAAF', 'NCAA Basketball': 'NCAAB', 'College Basketball': 'NCAAB', 'Football': 'Soccer', 'Formula 1': 'F1' });
  const FOOTBALL = new Set(['NFL', 'NCAAF', 'CFL', 'XFL', 'UFL']);
  const BASEBALL = new Set(['MLB']);
  const BASKETBALL = new Set(['NBA', 'WNBA', 'NCAAB']);
  const HOCKEY = new Set(['NHL']);
  const SOCCER = new Set(['Soccer', 'MLS', 'EPL', 'Premier League', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1', 'Champions League', 'UEFA']);
  const leagueName = (raw) => LEAGUE_ALIASES[raw] || raw || 'Other';
  const toInt = (v) => { const n = parseInt(String(v ?? '').trim(), 10); return Number.isFinite(n) ? n : null; };
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  function parsePeriod(text) {
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
  function gameState(e, statusText) {
    const p = parsePeriod(statusText);
    if (e.ended || FINAL_RE.test(statusText)) return 'final';
    if (!e.live) return 'pre';
    if (DELAY_RE.test(statusText)) return 'delayed';
    if (p.half) return 'halftime';
    return 'live';
  }
  function closeness(league, state, period, score) {
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
  function heat(e, state, close) {
    const rank = e.hotRank > 0 ? clamp01(1 - (e.hotRank - 1) / 10) : (e.hot ? 0.5 : 0);
    if (state === 'final') return clamp01(0.15 * rank);
    if (state === 'pre') return clamp01(0.3 * rank);
    return clamp01(0.55 * rank + 0.45 * close);
  }

  const catName = (e) => favorites.categories.get(e.categoryId) || '';
  /**
   * prettyLeague for the phone: always a string. A scraped league key such as "constructor" or
   * "__proto__" is read as a plain key ("Constructor"), never as one of Object.prototype's members
   * (prettyLeague, which the TV layout uses, is left exactly as it was).
   */
  function leagueLabel(key) {
    if (!key || typeof key !== 'string') return '';
    const k = key.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(LEAGUE_NAMES, k)) return LEAGUE_NAMES[k];
    const s = key.replace(/[-_]/g, ' ');
    return s.length <= 4 ? s.toUpperCase() : s[0].toUpperCase() + s.slice(1);
  }
  /** "2 - 1"; a short bracketed tail ("2 - 2 (4-3 pens)", "1 - 1 (aet)") is kept as `extra`. */
  function scoreOf(e) {
    const m = /^\s*(\d+)\s*[-–:]\s*(\d+)\s*(?:\(\s*([^()]{1,20}?)\s*\))?\s*$/.exec(e.score || '');
    return m ? { home: +m[1], away: +m[2], extra: m[3] || '' } : null;
  }
  /** The /api/games values, only while they describe the same moment as the live schedule. */
  function freshMeta(e) {
    const g = meta.games.get(String(e.id));
    if (!g) return null;
    if (g.statusText.trim().toLowerCase() !== String(e.liveText || '').trim().toLowerCase()) return null;
    const sc = scoreOf(e);
    const gs = g.score && g.score.home != null ? g.score : null;
    if (!!gs !== !!sc || (gs && (+gs.home !== sc.home || +gs.away !== sc.away))) return null;
    return g;
  }
  function closenessOf(e) {
    const g = freshMeta(e);
    if (g) return g.closeness;
    return closeness(leagueName(catName(e)), gameState(e, e.liveText || ''), parsePeriod(e.liveText), scoreOf(e) || { home: null, away: null });
  }
  function heatOf(e) {
    const g = freshMeta(e);
    return g ? g.heat : heat(e, gameState(e, e.liveText || ''), closenessOf(e));
  }

  const ord = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
  /** What the status column and the lead's clock box say, from the live status text. */
  function periodView(e) {
    const v = { main: '', unit: '', segs: null, bar: null, brk: false, phrase: '' };
    if (!e.live || e.ended) return v;
    const label = String(e.liveText || '').trim();
    const L = leagueName(catName(e));
    const quarters = FOOTBALL.has(L) || BASKETBALL.has(L);
    const segN = quarters ? 4 : HOCKEY.has(L) ? 3 : 0;
    const unit = quarters ? 'QTR' : HOCKEY.has(L) ? 'PER' : '';
    let m;
    if (/^(half|halftime|half[- ]time|ht)$/i.test(label)) {
      v.brk = true; v.main = SOCCER.has(L) ? 'HT' : 'HALF'; v.phrase = 'at halftime';
      if (segN) v.segs = { n: segN, done: segN / 2, active: 0 };
      else if (SOCCER.has(L)) v.bar = 0.5;
    } else if ((m = /^(?:(\d)(?:st|nd|rd|th)?\s+int(?:ermission|\.)?|int(?:ermission|\.)?\s*(\d))$/i.exec(label))) {
      const n = +(m[1] || m[2]); // hockey: "2nd Intermission", "INT 2"
      v.brk = true; v.main = `${ord(n).toUpperCase()} INT`; v.phrase = `in the ${ord(n)} intermission`;
      if (segN) v.segs = { n: segN, done: Math.min(n, segN), active: 0 };
    } else if ((m = /^(?:(ot|overtime)\s+)?int(?:ermission|\.)?$/i.exec(label))) {
      // "Intermission", "OT Intermission": a break too (never "in overtime", never cut mid-word).
      v.brk = true; v.main = m[1] ? 'OT INT' : 'INT'; v.phrase = m[1] ? 'in the overtime intermission' : 'in the intermission';
      if (segN && m[1]) v.segs = { n: segN, done: segN, active: 0 };
    } else if ((m = /^end(?:\s+of)?(?:\s+the)?\s+(ot|overtime|regulation|reg)\.?$/i.exec(label))) {
      const ot = /^o/i.test(m[1]); // "End of Regulation", "End of OT"
      v.brk = true; v.main = ot ? 'END OT' : 'END REG'; v.phrase = ot ? 'after overtime' : 'after regulation';
      if (segN) v.segs = { n: segN, done: segN, active: 0 };
    } else if ((m = /^end(?:\s+of)?(?:\s+the)?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(?:period|per|quarter|qtr))?$/i.exec(label)) && !BASEBALL.has(L)) {
      v.brk = true; v.main = 'END ' + ord(+m[1]).toUpperCase(); v.phrase = `after the ${ord(+m[1])}`;
      if (segN) v.segs = { n: segN, done: Math.min(+m[1], segN), active: 0 };
    } else if ((m = /^(?:q\s?(\d)|(\d)(?:st|nd|rd|th)(?:\s+(?:quarter|qtr|period|per))?)(?:\s+(\d{1,2}:\d{2}))?$/i.exec(label))) {
      const n = +(m[1] || m[2]);
      v.main = ord(n).toUpperCase(); v.unit = m[3] || unit; v.phrase = `in the ${ord(n)}`;
      if (segN && n <= segN) v.segs = { n: segN, done: n - 1, active: n };
    } else if ((m = /^(top|bot|bottom|mid|middle|end)\s+(?:of\s+)?(?:the\s+)?(\d{1,2})/i.exec(label))) {
      const half = m[1].toLowerCase().slice(0, 3);
      v.main = { top: 'TOP', bot: 'BOT', mid: 'MID', end: 'END' }[half] + ' ' + m[2]; v.unit = 'INN';
      v.brk = half === 'mid' || half === 'end';
      v.phrase = `${half === 'bot' ? 'bottom' : half === 'mid' ? 'middle' : half} of the ${ord(+m[2])}`;
    } else if ((m = /^(\d{1,3})(?:\+(\d+))?\s*'$/.exec(label))) {
      v.main = label.replace(/\s/g, ''); v.unit = 'MIN'; v.bar = Math.min(1, +m[1] / 90); v.phrase = `at ${v.main}`;
    } else if (/^(ot|overtime|so|shootout|et|extra time)\b/i.test(label)) {
      v.main = /^(so|shootout)/i.test(label) ? 'SO' : 'OT'; v.phrase = 'in overtime';
    } else if (DELAY_RE.test(label)) {
      v.brk = true; v.main = /postponed/i.test(label) ? 'PPD' : /suspend/i.test(label) ? 'SUSP' : 'DELAY'; v.phrase = 'in a delay';
    } else if (label && !/^live$/i.test(label)) {
      // Anything else: as many whole words as fit the column (never "2ND INTER", "INTERMISS…");
      // a first word too long for it leaves just LIVE.
      const u = label.toUpperCase();
      if (u.length <= 9) v.main = u;
      else {
        let fit = '';
        for (const w of u.split(/\s+/)) { if ((fit ? fit.length + 1 : 0) + w.length > 9) break; fit += (fit ? ' ' : '') + w; }
        v.main = fit ? fit + '…' : '';
      }
    }
    return v;
  }
  const isClose = (e) => !!e.live && !e.ended && !!e.away && !periodView(e).brk && !!scoreOf(e) && closenessOf(e) >= 0.75;

  // --- start times and time groups -------------------------------------------------------------

  const timeFormat = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
  const dayDiff = (ms) => {
    const a = new Date(); a.setHours(0, 0, 0, 0);
    const b = new Date(ms); b.setHours(0, 0, 0, 0);
    return Math.round((b - a) / 864e5);
  };
  /** A game that should have started this many minutes ago but is not live: no longer "starting". */
  const OVERDUE_MIN = 20;
  /** Their group: due, not live yet (the tile says "DUE 9:38 PM"). */
  const AWAITING = 'Awaiting start';
  /**
   * Today / Tonight / Tomorrow / Overnight, or null (a weekday). An evening runs to 5 AM, so a 2 AM
   * game is tonight's. After midnight (before 5 AM) the rest of that night is "Overnight" - never
   * grouped with this evening's games - and the coming night past midnight is "Tomorrow". The words
   * only ever move forward in time, so the groups sort by their earliest start.
   */
  function dayWord(ms) {
    const dd = dayDiff(ms), hr = new Date(ms).getHours();
    if (new Date().getHours() < 5) {
      if (dd <= 0) return hr < 5 ? 'Overnight' : hr >= 17 ? 'Tonight' : 'Today';
      return dd === 1 ? 'Tomorrow' : null;
    }
    if (dd <= 0) return hr >= 17 ? 'Tonight' : 'Today';
    if (dd === 1) return hr < 5 ? 'Tonight' : 'Tomorrow';
    return null;
  }
  /** "Tonight" + "11:00" + "PM" (24-hour locales have no AM/PM part). `late`: due, not live yet. */
  /** "11:00" + "PM" (24-hour locales: no AM/PM part). */
  function hmParts(d) {
    let hm = '', ap = '';
    for (const p of timeFormat.formatToParts(d)) { if (p.type === 'dayPeriod') ap += p.value; else hm += p.value; }
    return { hm: hm.trim(), ap };
  }
  /**
   * A start time the phone can show, else 0 ("Upcoming"): the scraped data-time is only checked to
   * be a number, and one past the Date range (a YYYYMMDDHHMMSS value) makes Intl throw RangeError.
   */
  const phoneTs = (ts) => (ts && Number.isFinite(new Date(ts * 1000).getTime()) ? ts : 0);
  function startParts(ts) {
    ts = phoneTs(ts);
    if (!ts) return { kick: 'Upcoming', hm: '', ap: '', soon: false, late: false, mins: null, text: 'upcoming' };
    const d = new Date(ts * 1000);
    const { hm, ap } = hmParts(d);
    const mins = Math.round((d.getTime() - Date.now()) / 6e4);
    const late = mins <= -OVERDUE_MIN;
    // Due on an earlier day and hours ago (a game listed since yesterday afternoon): say which day.
    // Last night's late games just say "Due" - at 12:30 AM, 11:00 PM is plainly last night.
    const ago = late && dayDiff(d.getTime()) < 0 && mins < -6 * 60;
    let kick;
    if (late) kick = ago ? 'Due ' + d.toLocaleDateString([], { weekday: 'short' }) : 'Due';
    else if (mins <= 0) kick = 'Starting';
    else if (mins <= 60) kick = `In ${mins} min`;
    else kick = dayWord(d.getTime()) || d.toLocaleDateString([], { weekday: 'short' });
    const at = timeFormat.format(d);
    const text = late ? `due ${ago ? d.toLocaleDateString([], { weekday: 'long' }) + ' ' : ''}at ${at}, not live yet`
      : mins <= 0 ? `any moment now, at ${at}` : mins <= 60 ? `in ${mins} minutes, at ${at}`
        : `${(dayWord(d.getTime()) || d.toLocaleDateString([], { weekday: 'long' })).toLowerCase()} at ${at}`;
    return { kick, hm, ap, soon: !late && mins <= 60, late, mins, text };
  }
  function groupOf(e) {
    if (e.ended) return 'Final';
    if (e.live) return 'Live';
    if (!phoneTs(e.startTs)) return 'Upcoming';
    const ms = e.startTs * 1000, mins = Math.round((ms - Date.now()) / 6e4);
    if (mins <= -OVERDUE_MIN) return AWAITING;
    if (mins <= 60) return 'Starting soon';
    return dayWord(ms) || new Date(ms).toLocaleDateString([], { weekday: 'long' });
  }
  /** Fixed places; every other group (Overnight, Today, Tonight, Tomorrow, a weekday) by its earliest start. */
  const GROUP_RANK = { Live: 0, 'Starting soon': 1, [AWAITING]: 90, Final: 99 };
  function groupEvents(list) {
    const groups = new Map();
    for (const e of list) {
      const g = groupOf(e);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(e);
    }
    // Awaiting start: the most recently due first (one due since yesterday afternoon goes last).
    const due = groups.get(AWAITING);
    if (due) due.sort((a, b) => (b.startTs || 0) - (a.startTs || 0));
    const first = (l) => Math.min(...l.map((e) => e.startTs || Infinity));
    return [...groups.entries()].sort((a, b) => (GROUP_RANK[a[0]] ?? 50) - (GROUP_RANK[b[0]] ?? 50) || first(a[1]) - first(b[1]));
  }

  // --- rows, lead, page ------------------------------------------------------------------------

  /**
   * The lead (hero) game: the hottest in-play two-team game of the first section that has one (a
   * game at a break only when nothing is in play), moved to the top of its section. Sticky: the
   * current lead stays until it stops qualifying or another is 0.15 heat hotter. None on the
   * Premium Only page of a viewer who cannot play those games.
   */
  function pickLead(rows, premiumOnly) {
    if (premiumOnly) return (phoneLeadId = null);
    // Only games in the current schedule: a saved copy (an old "Continue watching" entry) has a frozen score.
    const current = new Set(snapshot.events);
    const two = (e) => !!e.away && current.has(e);
    const inPlay = (e) => two(e) && e.live && !e.ended;
    const take = (r, best) => {
      r.events = [best].concat(r.events.filter((e) => e !== best));
      r.leadId = best.id;
      return best.id;
    };
    const pass = (test) => {
      for (const r of rows) {
        const c = r.events.filter(test);
        if (!c.length) continue;
        let best = c.reduce((a, b) => (heatOf(b) > heatOf(a) ? b : a));
        const cur = c.find((e) => e.id === phoneLeadId);
        if (cur && heatOf(best) - heatOf(cur) < 0.15) best = cur;
        return take(r, best);
      }
      return null;
    };
    // Nothing in play: "Next up" - the first section's soonest game (not an overdue one); of games
    // starting together, the hottest. "UP NEXT" only when no game listed further down starts sooner.
    const notStarted = (e) => current.has(e) && !e.live && !e.ended && !!phoneTs(e.startTs) && groupOf(e) !== AWAITING;
    const nextUp = () => {
      let first = Infinity;
      for (const r of rows) for (const e of r.events) if (notStarted(e) && e.startTs < first) first = e.startTs;
      for (const r of rows) {
        const c = r.events.filter((e) => two(e) && notStarted(e));
        if (!c.length) continue;
        const t = Math.min(...c.map((e) => e.startTs));
        const same = c.filter((e) => e.startTs === t);
        const rank = (e) => (e.hotRank > 0 ? e.hotRank : 1e9);
        const cur = same.find((e) => e.id === phoneLeadId);
        phoneLeadNext = t <= first;
        return take(r, cur || same.reduce((a, b) => (rank(b) < rank(a) ? b : a)));
      }
      return null;
    };
    // After the last game: the latest final with a score.
    const lastFinal = () => {
      for (const r of rows) {
        const c = r.events.filter((e) => two(e) && e.ended && !!scoreOf(e));
        if (c.length) return take(r, c.reduce((a, b) => ((b.startTs || 0) > (a.startTs || 0) ? b : a)));
      }
      return null;
    };
    // Something listed is on air but has no two-team lead (NFL RedZone, a fight card): no hero at
    // all - never a game hours away, or one already over, above a live one.
    const onAir = rows.some((r) => r.events.some((e) => current.has(e) && e.live && !e.ended));
    return (phoneLeadId = pass((e) => inPlay(e) && !!scoreOf(e) && !periodView(e).brk)
      || pass((e) => inPlay(e) && !!scoreOf(e))
      || pass((e) => inPlay(e))
      || (onAir ? null : nextUp() || lastFinal()));
  }

  /**
   * Live now reads "Most watched first", but its lead is picked for being in play and close, so it
   * can be #3 above #1 (at halftime) and #2. Then the subtitle says why the lead comes first, and
   * the lead's eyebrow drops its number (r.leadOffRank), so the list never contradicts itself.
   */
  function leadRankNote(rows) {
    for (const r of rows) {
      // A league's page and Your teams list their live games #1, #2... too (phoneOrder): a lead
      // picked over a better-ranked game drops its number there as well (their subtitles stay), and
      // so does Live now under Your teams ("5 more live": that count stays its subtitle).
      const listed = r.kind === 'page' || r.kind === 'fav' || (r.kind === 'live' && r.subLive);
      if (r.leadId == null || !(listed || (r.kind === 'live' && r.sub === 'Most watched first'))) continue;
      const lead = r.events.find((e) => e.id === r.leadId);
      const rk = lead ? rankOf(lead) : 0;
      const above = r.events.filter((e) => e !== lead && rankOf(e) > 0 && (!rk || rankOf(e) < rk));
      if (!lead || !above.length) continue;
      r.leadOffRank = true;
      if (listed) continue;
      r.sub = above.every((e) => periodView(e).brk) && !periodView(lead).brk ? 'In play, then most watched' : 'Featured, then most watched';
    }
  }

  /**
   * Hot ranks as shown on phones: "most watched" only means something for a game on air, so only
   * the live games this viewer can see are numbered, 1..n by (rank, heat, id) - Live now reads #1,
   * #2, #3 with no gaps (the schedule's own ranks also count finals, upcoming and locked games, and
   * can list two #1s). Signed-out viewers' premium-only games, listed under their own chip, are
   * numbered among themselves. Finals and games not started have no number; an old copy, none at all.
   */
  let phoneRanks = new Map();
  function rerank() {
    phoneRanks = new Map();
    if (!snapshot || phoneStale()) return;
    // heatOf reads each game's league from these names (buildRows sets the same map, but after this
    // runs): without them the first paint ranked tied games as 'Other' and swapped them a moment later.
    if (Array.isArray(snapshot.categories)) favorites.categories = new Map(snapshot.categories.map((c) => [c.id, c.name]));
    const hidden = premiumHidden();
    const pools = hidden ? [snapshot.events.filter((e) => !e.premium), snapshot.events.filter((e) => e.premium)] : [snapshot.events];
    for (const pool of pools) {
      const list = pool.filter((e) => e.hotRank > 0 && e.live && !e.ended);
      if (list.length < 2) continue; // one game on air is not "#1 most watched"
      const h = new Map(list.map((e) => [e, heatOf(e)]));
      list.sort((a, b) => a.hotRank - b.hotRank || h.get(b) - h.get(a) || String(a.id).localeCompare(String(b.id)));
      list.forEach((e, i) => phoneRanks.set(e.id, i + 1));
    }
  }
  const rankOf = (e) => (e.live && !e.ended ? phoneRanks.get(e.id) || 0 : 0);

  const visibleEvents = () => (premiumHidden() ? snapshot.events.filter((e) => !e.premium) : snapshot.events);
  const dayLabel = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const todayLabel = () => dayLabel(Date.now());

  // A rebuild replaces every card, so the browser cannot keep the reader's place: renderPhone
  // keeps one game at the same height itself, and a poll's rebuild waits while a finger is down
  // or the list is moving (a mis-tap on a card that just slid under the thumb).
  let renderIsBg = false;
  let touching = false;
  let lastMoveAt = 0;
  let deferTimer = null;
  /** The game to hold still across the next rebuild (the one just played, set by player.close). */
  let phoneAnchorId = null;
  /** The filter the cards in #rows were built for (a rebuild of the same page keeps the place). */
  let phonePage = null;
  // A finger is down from its touchstart to its touchend. Touch events keep going to the node they
  // started on even after a rebuild takes it out of the page (a chip, when a live count changes),
  // and then never reach window: the end is also heard on that node, and a finger that has neither
  // moved nor started for 8 s no longer holds rebuilds back.
  let touchAt = 0;
  const touchEnd = (ev) => { touching = !!(ev.touches && ev.touches.length); lastMoveAt = Date.now(); };
  addEventListener('touchstart', (ev) => {
    touching = true; lastMoveAt = touchAt = Date.now();
    const t = ev.target;
    if (t && t !== window && t.addEventListener) for (const k of ['touchend', 'touchcancel']) t.addEventListener(k, touchEnd, { passive: true, once: true });
  }, { passive: true, capture: true });
  addEventListener('touchmove', () => { touchAt = Date.now(); }, { passive: true, capture: true });
  for (const t of ['touchend', 'touchcancel']) addEventListener(t, touchEnd, { passive: true, capture: true });
  const fingerDown = () => touching && Date.now() - touchAt < 8000;
  addEventListener('scroll', () => { lastMoveAt = Date.now(); }, { passive: true });
  /** render() for polls (schedule, /api/games): may be held back on phones, never on a tap. */
  function renderBg() {
    renderIsBg = true;
    try { render(); } finally { renderIsBg = false; }
  }

  function phoneAnchor() {
    const below = $('chips').getBoundingClientRect().bottom + 4;
    const want = phoneAnchorId;
    phoneAnchorId = null;
    // A game just played or starred is followed even from the top of the page.
    if (want && cardsById.has(want)) {
      const r = cardsById.get(want)[0].getBoundingClientRect();
      if (r.bottom > below && r.top < innerHeight) return { id: want, top: r.top };
    }
    if (scrollY <= 0) return null;
    for (const c of $('rows').querySelectorAll('.card')) {
      const r = c.getBoundingClientRect();
      if (r.bottom > below) return r.top < innerHeight ? { id: c.dataset.id, top: r.top } : null;
    }
    return null;
  }

  /**
   * A rebuild that moved games above the reader can leave the page too short to hold their place
   * (a section at the end emptied): #rows keeps the missing height until they scroll back up.
   */
  let rowsPin = null;
  addEventListener('scroll', () => {
    if (rowsPin && scrollY <= rowsPin.natMax) { $('rows').style.minHeight = ''; rowsPin = null; }
  }, { passive: true });

  /** render(), phone branch: rebuilds #rows only when the layout key changes. */
  function renderPhone(s, rows, filter, premiumOnly) {
    const lid = pickLead(rows, premiumOnly);
    leadRankNote(rows);
    const teaser = teaserData(s, filter, premiumOnly);
    if (teaser) teaser.alone = !rows.length;
    const stale = phoneStale();
    // Names and crests too: they are drawn once, when a card is built (the site can fill in or
    // correct a team under the same game id; an in-place update would leave the old one on screen).
    const who = (e) => JSON.stringify([e.home, e.away || '', e.crestHome || '', e.crestAway || '']);
    const key = 'phone:' + (filterName || '') + '|'
      + rows.map((r) => r.title + ':' + (r.leadId || '') + (r.leadOffRank ? '!' : '') + ':' + (r.kind === 'live' ? r.sub + ':' : '') + r.events.map((e) => e.id + (r.grouped ? '@' + groupOf(e) : '') + who(e)).join(',')).join('|')
      + (teaser ? `|T${teaser.n}/${teaser.live}` : '') + (stale ? '|S' : '');
    const inPlace = () => {
      for (const [, cards] of cardsById) for (const c of cards) bindDynamic(c, byId(c._event.id) || c._event);
      refreshPhoneRowCounts(); // the head and subtitles follow the same games as the cards
      updateStatusText();
    };
    if (key === lastLayoutKey && cardsById.size) {
      updateGlow(lid ? byId(lid) : null, premiumOnly);
      return inPlace();
    }
    clearTimeout(deferTimer);
    const samePage = cardsById.size > 0 && phonePage === (filterName || '');
    if (renderIsBg && samePage && (fingerDown() || Date.now() - lastMoveAt < 900)) {
      inPlace();
      deferTimer = setTimeout(renderBg, 1000);
      return;
    }
    updateGlow(lid ? byId(lid) : null, premiumOnly);
    const anchor = samePage ? phoneAnchor() : null;
    phoneAnchorId = null;
    phonePage = filterName || '';
    lastLayoutKey = key;
    cardsById.clear();
    const root = $('rows');
    root.replaceChildren();
    root.style.minHeight = '';
    rowsPin = null;
    if (filter || premiumOnly) root.appendChild(pageHead(filter ? filter.name : 'Premium', rows[0] ? rows[0].events : []));
    else root.appendChild(dateline());
    if (premiumOnly && rows.length) root.appendChild(premiumNote()); // no sign-in pitch over an empty page
    let teaserPlaced = false;
    for (const r of rows) {
      const sec = renderPhoneRow(r);
      if (r.kind === 'live' && teaser) { sec.appendChild(teaserEl(teaser)); teaserPlaced = true; }
      root.appendChild(sec);
    }
    // Every game listed is premium-only: the teaser is the page (no "Quiet for now" above it).
    if (!rows.length && !teaser) {
      root.appendChild(emptyState(premiumOnly ? 'No premium-only games right now.' : filter ? `No ${filter.name} games right now.` : 'No games listed right now.'));
    }
    if (teaser && !teaserPlaced) root.appendChild(teaserEl(teaser));
    for (const n of root.querySelectorAll('.teaser-names')) fitNames(n);
    fitPhoneCards();
    $('overlay').classList.add('hidden');
    updateStatusText();
    restoreFocus();
    if (anchor) {
      const c = cardsById.get(anchor.id);
      if (c) {
        const dy = c[0].getBoundingClientRect().top - anchor.top;
        if (Math.abs(dy) >= 1) {
          // A poll's rebuild (nobody asked for it) holds the place even past the new end of the
          // page; after a tap (star, player closed) the page simply ends where it ends.
          const natMax = document.documentElement.scrollHeight - innerHeight;
          const short = scrollY + dy - natMax;
          if (short > 0 && renderIsBg) {
            root.style.minHeight = (root.offsetHeight + Math.ceil(short)) + 'px';
            rowsPin = { natMax };
          }
          scrollBy(0, dy);
        }
      }
    }
  }

  /** All phone cards in #rows. */
  const phoneCards = () => [...cardsById.values()].flat().filter((c) => c._phone);

  /**
   * Team names by measured fit: a tile stays at 16px while each of its names fits on one line,
   * else both lines drop to 14.5px together (and may wrap to two). Read everything, then write.
   */
  function fitTiles(cards) {
    const tiles = cards.filter((c) => c._names && c.isConnected);
    if (!tiles.length) return;
    for (const c of tiles) {
      c.classList.remove('tight');
      for (const n of c._names) if (n._plain != null) { n.textContent = n._plain; n._plain = null; n.classList.remove('hy'); }
    }
    const n0 = tiles[0]._names[0];
    const oneLine = parseFloat(getComputedStyle(n0).lineHeight) || parseFloat(getComputedStyle(n0).fontSize) * 1.15;
    const tight = tiles.filter((c) => c._names.some((n) => n.offsetHeight > oneLine * 1.5));
    for (const c of tight) c.classList.add('tight');
    // A single word wider than its line (Wolverhampton at a large text size) breaks with a hyphen
    // ("Wolver-hampton"), never at any letter, and that name may use a third line. Found by letting
    // words overflow for one measurement (on the plain names); only those words get soft hyphens -
    // elsewhere a hyphen would split words that fit on the next line. The browser's own
    // hyphenation is no help here: its dictionaries skip proper names.
    for (const c of tiles) c.classList.add('words');
    const long = [];
    for (const c of tiles) for (const n of c._names) if (n.scrollWidth > n.clientWidth + 1) long.push([n, n.clientWidth, getComputedStyle(n)]);
    for (const c of tiles) {
      c.classList.remove('words');
      for (const n of c._names) n.classList.remove('hy');
    }
    if (!long.length) return;
    const ctx = fitNames.ctx || (fitNames.ctx = document.createElement('canvas').getContext('2d'));
    for (const [n, w, cs] of long) {
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const text = n.textContent;
      const words = text.split(/(\s+)/);
      let wide = words.map((x) => /\S/.test(x) && ctx.measureText(x).width > w * 0.97);
      if (!wide.some(Boolean)) wide = words.map((x) => [...x].length >= 10); // the measurement disagreed: every long word
      n._plain = text;
      n.textContent = words.map((x, i) => (wide[i] ? softHyphens(x) : x)).join('');
      n.classList.add('hy');
    }
  }

  /**
   * Soft hyphens in a long name, splitting it into parts of about nine letters at a break between
   * two consonants (Wolver|hampton, Mönchen|gladbach) - never inside ch, th, ck, gl, tr...
   */
  const VOWEL = /[aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýÿœ]/i;
  const NO_SPLIT = new Set(['ch', 'ck', 'gh', 'ph', 'sh', 'th', 'wh', 'qu', 'bl', 'br', 'cl', 'cr', 'dr', 'fl', 'fr', 'gl', 'gr', 'pl', 'pr', 'tr', 'sc']);
  function softHyphens(word) {
    const ch = [...word];
    const n = ch.length;
    const parts = Math.ceil(n / 9);
    if (parts < 2) return word;
    const letter = (c) => /\p{L}/u.test(c) && !VOWEL.test(c);
    const cand = [];
    for (let i = 3; i <= n - 3; i++) if (letter(ch[i - 1]) && letter(ch[i]) && !NO_SPLIT.has((ch[i - 1] + ch[i]).toLowerCase())) cand.push(i);
    const cuts = new Set();
    for (let k = 1; k < parts; k++) {
      const t = (n * k) / parts;
      let best = -1;
      for (const i of cand) if (!cuts.has(i) && (best < 0 || Math.abs(i - t) < Math.abs(best - t))) best = i;
      if (best >= 0) cuts.add(best);
    }
    return ch.map((c, i) => (cuts.has(i) ? '­' : '') + c).join('');
  }

  /**
   * The lead's eyebrow: the longest wording that fits left of the diagonal ("#2 most watched",
   * "#2 watched", "#2"), dropping words - never cutting one. Nothing fits: no eyebrow at all.
   */
  function fitLeadTop(card) {
    const eb = card._eyebrow;
    const alts = card._eyebrowAlts || [];
    if (!eb || !card.isConnected) return;
    eb.classList.remove('hidden');
    const span = eb.querySelector('span');
    if (!span || !alts.length) return;
    for (const t of alts) {
      span.textContent = t;
      if (span.scrollWidth <= span.clientWidth + 0.5) return;
    }
    eb.classList.add('hidden');
  }

  function fitPhoneCards() {
    const cards = phoneCards();
    fitTiles(cards);
    for (const c of cards) if (c._eyebrow) { fitLeadTop(c); fitLeadDek(c); }
  }
  // Back from the background (the reader may have changed their text size meanwhile): measure again.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && isPhone()) requestAnimationFrame(fitPhoneCards); });
  // A width change (split view, a resized desktop window) re-measures; iOS toolbar height changes do not.
  let fitW = innerWidth, fitTimer = null;
  addEventListener('resize', () => {
    if (!isPhone() || innerWidth === fitW) return;
    fitW = innerWidth;
    clearTimeout(fitTimer);
    fitTimer = setTimeout(fitPhoneCards, 120);
  }, { passive: true });
  // A text size change while the app is open (iOS Larger Text through -apple-system-body, a
  // browser's font size) re-flows every name at the same width: a 1rem probe resizes exactly then.
  if ('ResizeObserver' in window) {
    const probe = el('span');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:1rem;height:1rem;visibility:hidden;pointer-events:none';
    document.body.appendChild(probe);
    let remW = 0;
    new ResizeObserver(() => {
      const w = probe.offsetWidth;
      if (!w || w === remW) return;
      const first = !remW;
      remW = w;
      if (first || !isPhone()) return;
      clearTimeout(fitTimer);
      fitTimer = setTimeout(fitPhoneCards, 60);
    }).observe(probe);
  }

  function dateline() {
    const d = el('div', 'dateline');
    const lv = el('span', 'lv');
    lv.append(el('i', 'pulse'), el('span', 'n', ''));
    d.append(el('span', 'd', todayLabel()), lv);
    return d;
  }

  /** The footer's "Updated 8:59 PM · 6 live" and the dateline count: games this viewer can see. */
  function updatePhoneStatus(t) {
    const stale = phoneStale();
    const saved = clockTime(snapshotAt());
    const liveN = stale ? 0 : visibleEvents().filter((e) => e.live && !e.ended).length;
    // Signed out, premium-only games are listed under their chip: count them too, separately.
    const premLive = premiumHidden() && !stale ? snapshot.events.filter((e) => e.premium && e.live && !e.ended).length : 0;
    const count = filterName === PREMIUM_CHIP && premiumHidden() ? `${premLive} live`
      : `${liveN} live${premLive ? ` · ${premLive} on premium` : ''}`;
    const fs = $('foot-status');
    if (fs) fs.textContent = scheduleError ? `Offline · saved ${saved}` : snapshotCached ? `Saved ${saved} · updating…` : `Updated ${t} · ${count}`;
    const dl = document.querySelector('#rows > .dateline');
    if (dl) {
      // An old copy: the day it was saved, and when ("As of 8:59 PM"), in grey - nothing pulses.
      dl.querySelector('.d').textContent = stale ? dayLabel(snapshotAt()) : todayLabel();
      dl.querySelector('.n').textContent = stale ? `As of ${saved}` : liveN ? `${liveN} live` : `${premLive} live on premium`;
      // ...said once: with the offline bar up, the bar says when ("Scores from 8:59 PM").
      dl.querySelector('.lv').classList.toggle('hidden', stale ? !!scheduleError : !liveN && !premLive);
      dl.classList.toggle('stale', stale);
    }
    updateOfflineBar(saved);
  }

  /**
   * Under the chips while the schedule cannot be loaded: "Offline · Scores from 8:59 PM", Retry.
   * (The TV layout keeps its own status line; this bar is phone-only.)
   */
  let retrying = false;
  function updateOfflineBar(saved) {
    const bar = $('offline-bar');
    if (!bar) return;
    const show = isPhone() && !!scheduleError && !!snapshot;
    bar.classList.toggle('hidden', !show);
    if (!show) return;
    const day = dayDiff(snapshotAt()) < 0 ? new Date(snapshotAt()).toLocaleDateString([], { weekday: 'short' }) + ' ' : '';
    const tx = $('offline-text');
    tx.replaceChildren(el('b', null, navigator.onLine === false ? 'Offline' : 'Can’t update'), el('span', null, `Scores from ${day}${saved}`));
    const b = $('offline-retry');
    b.disabled = retrying;
    b.textContent = retrying ? 'Trying…' : 'Retry';
  }
  if ($('offline-retry')) $('offline-retry').addEventListener('click', async () => {
    if (retrying) return;
    retrying = true;
    updateOfflineBar(clockTime(snapshotAt()));
    const t0 = Date.now();
    await loadSchedule(true);
    // Long enough to read as an attempt, even when the network says no at once.
    await new Promise((r) => setTimeout(r, Math.max(0, 700 - (Date.now() - t0))));
    retrying = false;
    updateOfflineBar(clockTime(snapshotAt()));
  });

  function pageHead(title, list) {
    const h = el('div', 'page-h');
    h._title = title;
    h._list = list; // refreshPhoneCounts counts them again after a status poll
    h.appendChild(el('h1', null, title));
    if (list.length) {
      const sum = el('div', 'sum');
      const was = list.filter((e) => e.live && !e.ended).length;
      const stale = phoneStale();
      const liveN = stale ? 0 : was;
      if (liveN) {
        const lv = el('span', 'lv');
        lv.append(el('i', 'pulse'), `${liveN} live`);
        sum.append(lv);
      } else if (stale && was) sum.append(el('span', null, `${was} live at ${clockTime(snapshotAt())}`));
      const rest = phoneSub(list, true);
      if (rest) {
        if (liveN || (stale && was)) sum.append(el('span', null, '·'));
        sum.append(el('span', null, rest));
      }
      h.appendChild(sum);
    }
    return h;
  }

  /**
   * After a status poll (scores and live / final in place, no rebuild): the chips' live counts, a
   * league page's "3 live · 1 upcoming" and each league section's subtitle, counted again so they
   * agree with the dateline and the footer. The cards stay where they are until the next rebuild.
   */
  function refreshPhoneCounts() {
    renderPhoneChips(snapshot, true);
    refreshPhoneRowCounts();
  }
  /**
   * The rows' and the page head's counts, from the current snapshot's games: a schedule poll that
   * kept the layout replaces every game object, and the rows still hold the ones they were built
   * from. Live now under Your teams ("5 more live") is counted again too.
   */
  function refreshPhoneRowCounts() {
    if (!snapshot) return;
    const cur = new Map(snapshot.events.map((e) => [e.id, e]));
    const now = (list) => list.map((e) => cur.get(e.id) || e);
    for (const row of document.querySelectorAll('#rows > .row')) {
      const r = row._r;
      const more = r && r.kind === 'live' && r.subLive;
      const sub = r && (r.kind === 'cat' || more) ? row.querySelector('.row-sub') : null;
      if (!sub) continue;
      const list = now(r.events);
      let text;
      if (more) {
        const n = list.filter((e) => e.live && !e.ended).length;
        text = n ? `${n} more live` : '';
        sub.classList.toggle('live', n > 0);
      } else text = phoneSub(list);
      if (sub.textContent !== text) sub.textContent = text;
    }
    const h = document.querySelector('#rows > .page-h');
    if (!h || !h._list) return;
    const sum = h.querySelector('.sum');
    const fresh = pageHead(h._title, now(h._list)).querySelector('.sum');
    if (sum && fresh && sum.innerHTML === fresh.innerHTML) return;
    if (sum) sum.remove();
    if (fresh) h.appendChild(fresh);
  }

  function premiumNote() {
    const note = el('div', 'note');
    note.append(account.signedIn
      ? 'These games only have premium servers, and this account does not seem to have premium.'
      : pool.shared ? 'These games only have premium servers, and the shared account’s premium servers were locked. '
        : 'These games only have premium servers. ');
    if (!account.signedIn) {
      const b = el('button', 'link-btn', 'Sign in to your premium account');
      b.onclick = () => acct.open();
      note.append(b, '\u00a0to\u00a0watch.'); // never a lone last word
    }
    return note;
  }

  /**
   * Viewers who cannot play premium-only games (signed out, or an account without premium): what
   * the premium chip holds in this view (All, or the selected league). An old copy claims no live games.
   */
  function teaserData(s, filter, premiumOnly) {
    if (!premiumHidden() || premiumOnly) return null;
    const list = s.events.filter((e) => e.premium && (!filter || e.categoryId === filter.id)).sort(rowOrder);
    if (!list.length) return null;
    const live = phoneStale() ? 0 : list.filter((e) => e.live && !e.ended).length;
    return { n: list.length, live, league: filter ? filter.name : '', names: list.map((e) => (e.away ? `${e.home} vs ${e.away}` : e.home)) };
  }

  function teaserEl(t) {
    const box = el('div', 'teaser' + (t.alone ? ' alone' : ''));
    const k = el('div', 'teaser-k');
    k.append(icon(I.star), 'Premium only');
    const lg = t.league ? t.league + ' ' : '';
    // "premium servers" never splits across lines; no "more" when nothing else is listed.
    const p = el('p', 'teaser-p', t.alone
      ? (t.n === 1 ? `The one ${lg}game listed is on premium\u00a0servers` : `All ${t.n} ${lg}games listed are on premium\u00a0servers`)
      : `${t.n} more ${t.n === 1 ? 'game is' : 'games are'} on premium\u00a0servers`);
    if (t.live) { p.append(' — '); p.append(el('em', null, `${t.live} live now.`)); } else p.append('.');
    const acts = el('div', 'teaser-acts');
    // Signed in already (an account without premium): no Sign in - its sheet only offers Sign out.
    if (!account.signedIn) {
      const signIn = el('button', 'pill-btn gold', 'Sign in');
      signIn.type = 'button';
      signIn.onclick = () => acct.open();
      acts.append(signIn);
    }
    const see = el('button', 'pill-btn ghost', 'See them');
    see.type = 'button';
    see.onclick = () => { filterName = PREMIUM_CHIP; store.set('filter_category', PREMIUM_CHIP); lastLayoutKey = ''; render(); scrollTo(0, 0); };
    acts.append(see);
    const names = el('p', 'teaser-names', t.names.join(', '));
    names._names = t.names;
    box.append(k, p);
    if (account.signedIn) box.append(el('p', 'teaser-note', 'This account does not seem to have premium.'));
    box.append(names, acts);
    return box;
  }

  /** Whole names only: as many as fit on the line, then "+ N more" (measured once per rebuild). */
  function fitNames(node) {
    const names = node._names || [];
    const w = node.clientWidth;
    if (!names.length || !w) return;
    const cs = getComputedStyle(node);
    const ctx = fitNames.ctx || (fitNames.ctx = document.createElement('canvas').getContext('2d'));
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const text = (k) => names.slice(0, k).join(', ') + (k < names.length ? ` + ${names.length - k} more` : '');
    let k = names.length;
    while (k > 1 && ctx.measureText(text(k)).width > w) k--;
    node.textContent = text(k);
    node.classList.toggle('one', k === 1 && ctx.measureText(text(1)).width > w); // a single long name may wrap
  }

  function emptyState(msg) {
    const box = el('div', 'empty');
    box.append(el('h3', null, 'Quiet for now.'), el('p', null, msg));
    if (filterName) {
      const b = el('button', 'pill-btn ghost', 'Show all games');
      b.type = 'button';
      b.onclick = () => { filterName = null; store.set('filter_category', null); lastLayoutKey = ''; render(); scrollTo(0, 0); };
      box.append(b);
    }
    return box;
  }

  /** The iOS status-bar band: a soft glow in the lead game's colours (gold on the Premium page). */
  function updateGlow(leadE, premiumOnly) {
    let a = 'transparent', b = 'transparent';
    const glow = (base, l, alpha) => (base ? hsla(base[0], Math.min(base[1], 0.85), l, alpha) : 'rgba(255, 255, 255, .07)');
    if (premiumOnly) { a = 'rgba(245, 185, 66, .34)'; b = 'rgba(245, 185, 66, .16)'; } else if (leadE) {
      const L = looks(leadE);
      a = glow(L.home.base, 0.42, 0.55);
      b = glow(L.away && L.away.base, 0.5, 0.4);
    }
    if (a + '|' + b === phoneGlow) return;
    phoneGlow = a + '|' + b;
    document.documentElement.style.setProperty('--glow-a', a);
    document.documentElement.style.setProperty('--glow-b', b);
  }

  /** A chip's live count ("NFL 3"), or none. */
  function setChipCount(b, n) {
    let c = b.querySelector('.n');
    if (!n) { if (c) c.remove(); return; }
    if (!c) b.appendChild((c = el('span', 'n')));
    c.textContent = String(n);
    c.setAttribute('aria-label', `${n} live`);
  }

  /**
   * Sport filters with live counts; rebuilt only when they change (keeps the row's scroll).
   * `countsOnly` (a status poll): the same chips with new counts are updated in place instead.
   */
  function renderPhoneChips(s, countsOnly) {
    const nav = $('chips');
    const hidden = premiumHidden();
    const vis = hidden ? s.events.filter((e) => !e.premium) : s.events;
    const items = [{ name: null, label: 'All', n: 0 }];
    const stale = phoneStale(); // an old copy: no live counts
    for (const c of s.categories) {
      const list = vis.filter((e) => e.categoryId === c.id);
      // The selected league stays even when it has no games, so its empty page still shows the filter.
      if (list.length || c.name === filterName) items.push({ name: c.name, label: c.name, n: stale ? 0 : list.filter((e) => e.live && !e.ended).length });
    }
    if (hidden && s.events.some((e) => e.premium)) items.push({ name: PREMIUM_CHIP, label: PREMIUM_CHIP, n: 0, cls: 'premium' });
    const tv = hasLiveTv();
    const key = JSON.stringify([filterName || null, tv, items]);
    if (key === phoneChipsKey && nav.children.length) return;
    const shape = JSON.stringify([filterName || null, tv, items.map((it) => it.name)]);
    if (countsOnly && shape === phoneChipsShape && nav.children.length === items.length + (tv ? 1 : 0)) {
      phoneChipsKey = key;
      items.forEach((it, i) => setChipCount(nav.children[i], it.n));
      chipEdges();
      return;
    }
    phoneChipsKey = key;
    phoneChipsShape = shape;
    nav.replaceChildren();
    for (const it of items) {
      const on = (it.name || null) === (filterName || null);
      const b = el('button', 'chip' + (it.cls ? ' ' + it.cls : '') + (on ? ' selected' : ''), it.label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(on));
      setChipCount(b, it.n);
      b.onclick = () => { filterName = it.name; store.set('filter_category', it.name); lastLayoutKey = ''; render(); scrollTo(0, 0); };
      nav.appendChild(b);
    }
    if (tv) {
      // Opens the Live TV screen; never a filter (HomeActivity's Live TV chip).
      const b = el('button', 'chip livetv');
      b.type = 'button';
      b.append(icon(I.tv), 'Live TV');
      b.onclick = () => liveTv.open();
      nav.appendChild(b);
    }
    // Centre the selected chip by scrolling the row itself (scrollIntoView can move the page), but
    // start the row at a chip's edge: never a neighbour cut down to a sliver ("• 2") at the fade.
    // At the end of the row that can take a little extra room after the last chip (--tail).
    const sel = nav.querySelector('.selected');
    nav.style.setProperty('--tail', '0px');
    if (sel) {
      const nr = nav.getBoundingClientRect(), pad = 16;
      const box = (c) => { const r = c.getBoundingClientRect(); return { l: r.left - nr.left + nav.scrollLeft, r: r.right - nr.left + nav.scrollLeft }; };
      const max = nav.scrollWidth - nav.clientWidth, sb = box(sel);
      let x = Math.max(0, Math.min(max, (sb.l + sb.r) / 2 - nav.clientWidth / 2));
      if (x > 0) {
        const boxes = [...nav.children].map(box);
        const cut = boxes.find((b) => b.l < x + pad - 0.5 && b.r > x + pad + 0.5);
        if (cut) {
          const shows = (v) => v >= 0 && sb.l - v >= pad - 0.5 && sb.r - v <= nav.clientWidth - pad + 0.5;
          const next = boxes.find((b) => b.l >= cut.r);
          const opts = [cut.l - pad, next ? next.l - pad : -1].filter(shows);
          if (opts.length) x = opts.sort((a, b) => Math.abs(a - x) - Math.abs(b - x))[0];
          if (x > max) nav.style.setProperty('--tail', Math.ceil(x - max) + 'px');
        }
      }
      nav.scrollLeft = x;
    } else nav.scrollLeft = 0;
    chipEdges();
  }

  /** The chips row fades only on a side with more chips past it (none at the start or the end). */
  function chipEdges() {
    const n = $('chips');
    const max = n.scrollWidth - n.clientWidth;
    n.classList.toggle('at-start', n.scrollLeft <= 1);
    n.classList.toggle('at-end', n.scrollLeft >= max - 1);
  }
  $('chips').addEventListener('scroll', () => { if (isPhone()) chipEdges(); }, { passive: true });

  /** renderRow, phone branch: a Bodoni head, then the games - in time groups for a league. */
  function renderPhoneRow(r) {
    const row = el('section', 'row');
    row._r = r;
    row.setAttribute('aria-label', r.title);
    if (!r.page) {
      const head = el('div', 'row-head');
      const title = el('h2', 'row-title', r.title);
      if (r.kind === 'fav') title.appendChild(icon(I.star));
      head.append(title, el('span', 'row-sub' + (r.subLive ? ' live' : ''), r.sub));
      row.appendChild(head);
    }
    const groups = r.grouped ? groupEvents(r.events) : [['', r.events]];
    const kickers = r.page || groups.length > 1;
    // The lead opens its section, above the time-group kickers: its own flag already says LIVE /
    // UP NEXT and its clock box the day, so "TONIGHT" over "TONIGHT 3:00 AM" is never stacked.
    const leadE = r.leadId != null ? r.events.find((e) => e.id === r.leadId) : null;
    // One game that cannot be drawn (bad scraped data) is left out; the rest of the list still is.
    const card = (e, ctx) => {
      try { return createCard(e, ctx); } catch (err) { console.error('Styx Sports: game', e && e.id, err); return document.createTextNode(''); }
    };
    if (leadE) {
      const strip = el('div', 'strip');
      strip.appendChild(card(leadE, { lead: true, mixed: !!r.mixed, page: !!r.page || r.kind === 'cat', offRank: !!r.leadOffRank }));
      if (!store.get('held_once', false)) strip.appendChild(el('div', 'hold-hint', 'Press and hold any game to star a team or send it to your TV'));
      row.appendChild(strip);
    }
    for (const [g, all] of groups) {
      const list = leadE ? all.filter((e) => e !== leadE) : all;
      if (!list.length) continue;
      if (kickers && g) row.appendChild(el('div', 'kicker', g === 'Live' && phoneStale() ? 'Last seen live' : g));
      const strip = el('div', 'strip');
      for (const e of list) strip.appendChild(card(e, { lead: false, mixed: !!r.mixed, page: !!r.page }));
      row.appendChild(strip);
    }
    return row;
  }

  // --- tiles and the lead card -----------------------------------------------------------------

  /** A crest, or a team-colour monogram when there is none or it fails (the lead shows the code only). */
  function crestEl(t, url, noMono) {
    const mono = () => {
      if (noMono) return document.createTextNode('');
      const m = el('span', 'mono' + (t.code.length >= 4 ? ' m4' : t.code.length === 3 ? ' m3' : ''), t.code);
      m.setAttribute('aria-hidden', 'true');
      if (t.base) m.style.setProperty('--mc', deepOf(t.base, 0.06));
      return m;
    };
    if (!url) return mono();
    const img = el('img', 'crest');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => img.replaceWith(mono());
    img.src = url;
    return img;
  }

  /** Single-title events (NFL Redzone, UFC 309, a race): a glyph in place of crests. */
  const glyphCode = (e) => {
    const k = `${catName(e)} ${e.league || ''} ${e.home}`.toLowerCase();
    return /\bnfl\b/.test(k) ? 'NFL' : /\bufc\b/.test(k) ? 'UFC' : '';
  };
  function glyphEl(e, L) {
    const g = el('span', 'glyph');
    g.setAttribute('aria-hidden', 'true');
    const k = `${catName(e)} ${e.league || ''} ${e.home}`.toLowerCase();
    const code = glyphCode(e);
    if (code) g.appendChild(el('b', null, code));
    else if (/motor|nhra|\bf1\b|formula|nascar|indy|moto ?gp|\brace\b/.test(k)) g.appendChild(icon(I.flag));
    else g.appendChild(icon(I.bcast));
    if (L.home.base) {
      g.style.setProperty('--g1', deepOf(L.home.base, 0.06));
      g.style.setProperty('--g2', deepOf(L.home.base, -0.06));
    }
    return g;
  }

  function buildTile(card, e, L) {
    const bars = el('span', 'bars');
    bars.setAttribute('aria-hidden', 'true');
    for (const side of e.away ? [L.home, L.away] : [L.home]) {
      const i = el('i');
      i.style.setProperty('--c', side.accent);
      bars.appendChild(i);
    }
    const teams = el('span', 't-teams');
    if (!e.away) {
      card.classList.add('single');
      const one = el('span', 't-single');
      const tx = el('span', 't-tx');
      tx.append(el('span', 'single-title', e.home));
      // The league under the title only when it says something new: not when the title or the
      // glyph already names it ("NFL Redzone", "UFC 309"), nor under that league's own heading.
      const lg = leagueLabel(e.league) || catName(e);
      const said = !lg || e.home.toLowerCase().includes(lg.toLowerCase()) || glyphCode(e) === lg.toUpperCase()
        || (!card._phone.mixed && lg.toLowerCase() === catName(e).toLowerCase());
      if (!said) tx.append(el('span', 't-meta', lg));
      one.append(glyphEl(e, L), tx);
      teams.appendChild(one);
    } else {
      card._names = [];
      const line = (name, url, look) => {
        const l = el('span', 'team-line');
        const n = el('span', 'tl-name', name);
        card._names.push(n);
        l.append(crestEl(look, url), n);
        if (favorites.teams.has(name.toLowerCase())) {
          const st = icon(I.star);
          st.setAttribute('class', 'tl-star');
          l.appendChild(st);
        }
        const sc = el('span', 'tl-score');
        l.appendChild(sc);
        teams.appendChild(l);
        return [l, sc];
      };
      [card._homeLine, card._homeScore] = line(e.home, e.crestHome, L.home);
      [card._awayLine, card._awayScore] = line(e.away, e.crestAway, L.away);
    }
    card._status = el('span', 't-status');
    card._status.setAttribute('aria-hidden', 'true');
    card.append(bars, teams, card._status);
  }

  /** The lead's league tag: a short name ("College Football" -> NCAAF), at most about 10 letters. */
  const TAG_SHORT = Object.assign(Object.create(null), LEAGUE_ALIASES, { 'NCAA College Football': 'NCAAF', 'NCAA Men\'s Basketball': 'NCAAB', 'Australian Rules Football': 'AFL', 'Aussie Rules': 'AFL', 'Champions League': 'UCL', 'Premier League': 'EPL', 'Europa League': 'UEL' });
  function tagLabel(name) {
    const n = String(TAG_SHORT[name] || name || '');
    if (n.length <= 10) return n;
    const first = n.split(/\s+/)[0];
    return first.length >= 3 && first.length <= 10 ? first : n;
  }

  function buildLead(card, e, L) {
    card.classList.add('lead');
    card._looks = L;
    const panel = (k, b) => {
      card.style.setProperty(`--${k}`, deepOf(b, 0.02));
      card.style.setProperty(`--${k}-hi`, deepOf(b, 0.12));
      card.style.setProperty(`--${k}-lo`, deepOf(b, -0.1));
    };
    // Two unknown teams: a cool and a warm graphite, so the split still reads as two sides.
    const neutral = !L.home.base && !L.away.base;
    panel('h1', L.home.base || (neutral ? [214, 0.14, 0.25] : null));
    panel('h2', L.away.base || (neutral ? [30, 0.08, 0.14] : null));
    card.style.setProperty('--a1', L.home.base ? hsla(L.home.base[0], Math.min(L.home.base[1], 0.85), 0.45, 0.5) : 'rgba(255, 255, 255, .08)');
    card.style.setProperty('--a2', L.away.base ? hsla(L.away.base[0], Math.min(L.away.base[1], 0.85), 0.5, 0.4) : 'rgba(255, 255, 255, .06)');
    const bg = el('span', 'lead-bg');
    bg.setAttribute('aria-hidden', 'true');
    bg.append(el('i', 'lead-l'), el('i', 'lead-r'), el('i', 'lead-seam'), el('i', 'lead-shade'));
    const inner = el('span', 'lead-in');
    inner.setAttribute('aria-hidden', 'true'); // the card's aria-label says it all
    const top = el('span', 'lead-top');
    card._eyebrow = el('span', 'lead-eyebrow');
    card._flag = el('span', 'lead-flag');
    // Left of the diagonal: the league tag (not on that league's page or under its own section
    // title, which already say it) and the eyebrow; capped short of the seam (CSS), fitted by fitLeadTop.
    const lt = el('span', 'lead-lt');
    if (!card._phone.page) lt.appendChild(el('span', 'lead-tag', tagLabel(catName(e) || leagueLabel(e.league))));
    lt.appendChild(card._eyebrow);
    top.append(lt, card._flag);
    // The broadcast-red LIVE flag, unless the panel under it is red too (then a dark flag, red ring).
    const fb = L.away.base || null;
    const fh = fb && fb[1] >= 0.3 && fb[0] >= 38 && fb[0] <= 68 ? 33 : fb && fb[0]; // deepOf turns gold to bronze
    card.classList.toggle('red-panel', !!fb && fb[1] >= 0.25 && hueDist(fh, 0) < 25);
    const teams = el('span', 'lead-teams');
    const side = (t, url, right) => {
      // .nocrest: no crest (or it failed) - the name gets the crest's room and stays on short screens.
      const s = el('span', 'ht' + (right ? ' r' : '') + (url ? '' : ' nocrest'));
      const tx = el('span', 'ht-tx');
      tx.append(el('span', 'ht-code', t.code), el('span', 'ht-name', nickOf(t.name, e)));
      const c = crestEl(t, url, true);
      if (url) c.addEventListener('error', () => s.classList.add('nocrest'));
      s.append(c, tx);
      return s;
    };
    teams.append(side(L.home, e.crestHome, false), side(L.away, e.crestAway, true));
    const line = el('span', 'lead-line');
    card._homeScore = el('span', 'lead-score l');
    card._awayScore = el('span', 'lead-score r');
    card._clock = el('span', 'lead-clock');
    line.append(card._homeScore, card._clock, card._awayScore);
    const foot = el('span', 'lead-foot');
    card._dek = el('span', 'lead-dek');
    card._watch = el('span', 'watch');
    foot.append(card._dek, card._watch);
    inner.append(top, teams, line, foot);
    card.append(bg, inner);
  }

  function trackerEl(pv) {
    if (pv.segs) {
      const t = el('span', 'trk');
      for (let i = 1; i <= pv.segs.n; i++) t.appendChild(el('i', i <= pv.segs.done ? 'd' : i === pv.segs.active ? 'a' : null));
      return t;
    }
    if (pv.bar != null) {
      const b = el('span', 'mbar');
      const i = el('i');
      i.style.width = Math.round(pv.bar * 100) + '%';
      b.appendChild(i);
      return b;
    }
    return null;
  }

  /** A score that changes from one number to another gets a short bump. */
  function setScore(node, text) {
    if (node.textContent === text) return;
    const changed = node.textContent !== '' && text !== '';
    node.textContent = text;
    if (changed) { node.classList.remove('bump'); void node.offsetWidth; node.classList.add('bump'); }
  }

  function spokenStatus(e, pv) {
    if (e.ended) return 'final';
    if (e.live && phoneStale()) return `last seen live${pv.phrase ? ', ' + pv.phrase : ''}, at ${clockTime(snapshotAt())}`;
    if (e.live) return pv.brk ? (pv.main === 'HALF' || pv.main === 'HT' ? 'halftime' : `live, ${pv.phrase || 'break'}`) : `live${pv.phrase ? ', ' + pv.phrase : ''}`;
    const sp = startParts(e.startTs);
    return sp.late ? sp.text : 'starts ' + sp.text;
  }

  /** bindDynamic, phone branch: everything /api/status changes (state, period, score). */
  function bindPhone(card, e) {
    card._event = e;
    const pv = periodView(e);
    const sc = scoreOf(e);
    const showScore = !!sc && (!!e.live || !!e.ended);
    const lead = showScore ? Math.sign(sc.home - sc.away) : 0;
    const stale = !!e.live && !e.ended && phoneStale(); // live in an old copy: "Last seen", in grey
    card.classList.toggle('live', !!e.live && !e.ended && !stale);
    card.classList.toggle('stale', stale);
    card.classList.toggle('final', !!e.ended);
    card.classList.toggle('pre', !e.live && !e.ended);
    card.classList.toggle('brk', pv.brk);
    if (card._homeScore) {
      // A live lead without a score shows the team codes where the numbers go.
      const codes = !!card._clock && !showScore && !!e.live && !e.ended;
      setScore(card._homeScore, showScore ? String(sc.home) : codes ? card._looks.home.code : '');
      setScore(card._awayScore, showScore ? String(sc.away) : codes ? card._looks.away.code : '');
      if (card._homeLine) {
        card._homeLine.classList.toggle('trailing', lead < 0);
        card._awayLine.classList.toggle('trailing', lead > 0);
        card._homeLine.classList.toggle('win', !!e.ended && lead > 0);
        card._awayLine.classList.toggle('win', !!e.ended && lead < 0);
      } else {
        card._homeScore.classList.toggle('trailing', lead < 0);
        card._awayScore.classList.toggle('trailing', lead > 0);
      }
    }
    if (card._clock) bindLead(card, e, pv, sc, lead);
    else bindStatus(card, e, pv);
    // A score slot that appears (or goes) changes the names' room: measure this tile again.
    if (card._names && card._scored !== showScore) {
      const was = card._scored;
      card._scored = showScore;
      if (was !== undefined && card.isConnected) fitTiles([card]);
    }
    const names = e.away ? `${e.home}${showScore ? ' ' + sc.home : ''}, ${e.away}${showScore ? ' ' + sc.away : ''}${showScore && sc.extra ? ` (${sc.extra})` : ''}` : e.home;
    const rk = rankOf(e);
    card.setAttribute('aria-label', `${names}, ${spokenStatus(e, pv)}${rk ? `, number ${rk} most watched` : ''}${e.premium ? ', premium only' : ''}. Press and hold for options.`);
  }

  /** The tile's stadium-board column: LIVE + period + tracker (or CLOSE), a start time, or FINAL; then tags. */
  function bindStatus(card, e, pv) {
    const sp = !e.live && !e.ended ? startParts(e.startTs) : null;
    const stale = !!e.live && !e.ended && phoneStale();
    const close = !stale && isClose(e);
    const proTag = !!e.premium && filterName !== PREMIUM_CHIP;
    const rk = rankOf(e);
    // The flame: a number for a live game (its place among those on air now), a bare flame for a
    // big game not started yet, none on a final or on an old copy's games.
    const hot = !e.ended && !stale && (!!rk || (!e.live && (!!e.hot || e.hotRank > 0)) || (!!e.live && !!e.hot));
    const extra = !sp && !stale ? (scoreOf(e) || {}).extra || '' : ''; // "4-3 pens" after the score
    const sig = [e.live, e.ended, e.liveText, rk, hot, proTag, close, stale, sp && sp.text, sp && sp.kick, catName(e), extra].join('|');
    if (card._sig === sig) return;
    card._sig = sig;
    const col = card._status;
    col.replaceChildren();
    if (e.ended) {
      const t = String(e.liveText || '').trim();
      col.appendChild(el('span', 's-final', /^final\s*\/\s*\w+$/i.test(t) ? t.toUpperCase().replace(/\s/g, '') : 'FINAL'));
      if (extra) col.appendChild(el('span', 's-xtra', extra));
    } else if (stale) {
      // Live when the copy was saved, long ago: where it was, in grey, never a red LIVE.
      col.appendChild(el('span', 's-kick long', 'Last seen'));
      if (pv.main) col.appendChild(el('span', 's-main' + (pv.main.length > 5 ? ' long' : ''), pv.main));
      else {
        const at = hmParts(new Date(snapshotAt()));
        const t = el('span', 's-time', at.hm);
        if (at.ap) t.appendChild(el('small', null, at.ap));
        col.appendChild(t);
      }
    } else if (e.live) {
      col.appendChild(el('span', 's-flag', 'LIVE'));
      if (pv.main) col.appendChild(el('span', 's-main' + (pv.main.length > 5 ? ' long' : ''), pv.main));
      if (extra) col.appendChild(el('span', 's-xtra', extra));
      if (close) {
        const c = el('span', 's-close');
        c.append(icon(I.bolt), 'CLOSE');
        col.appendChild(c);
      } else {
        const t = trackerEl(pv);
        if (t) col.appendChild(t);
      }
    } else {
      col.appendChild(el('span', 's-kick' + (sp.soon ? ' soon' : '') + (sp.late ? ' late' : '') + (sp.kick.length > 7 ? ' long' : ''), sp.kick));
      const t = el('span', 's-time', sp.hm);
      if (sp.ap) t.appendChild(el('small', null, sp.ap));
      col.appendChild(t);
    }
    const tags = el('span', 's-tags');
    if (hot) {
      const h = el('span', 's-hot');
      h.append(icon(I.flame), rk ? `#${rk}` : '');
      tags.appendChild(h);
    }
    if (proTag) {
      const p = el('span', 's-pro');
      p.append(icon(I.star), rk ? '' : 'PRO');
      tags.appendChild(p);
    }
    if (tags.childNodes.length) col.appendChild(tags);
    else if (card._phone.mixed && e.away) {
      const lg = leagueLabel(e.league) || catName(e);
      if (lg) col.appendChild(el('span', 's-league', lg));
    }
  }

  /** "Kickoff", "Puck drop", ... for the Next up lead. */
  function startVerb(e) {
    const L = leagueName(catName(e));
    return FOOTBALL.has(L) || SOCCER.has(L) ? 'Kickoff' : HOCKEY.has(L) ? 'Puck drop' : BASEBALL.has(L) ? 'First pitch' : BASKETBALL.has(L) ? 'Tip-off' : 'Starts';
  }
  /** "in 25 min", "in 3 hours", "tonight", "on Tuesday". */
  function untilPhrase(sp, ts) {
    if (sp.mins <= 0) return 'any moment now';
    if (sp.mins < 60) return `in ${sp.mins} min`;
    if (sp.mins < 6 * 60) { const h = Math.round(sp.mins / 60); return `in ${h} hour${h === 1 ? '' : 's'}`; }
    const w = dayWord(ts * 1000);
    return w ? w.toLowerCase() : 'on ' + new Date(ts * 1000).toLocaleDateString([], { weekday: 'long' });
  }

  /**
   * The lead in any state: in play (scores), live without a score (the codes take the numbers'
   * place), Next up (kickoff time in the clock box) or the latest final.
   */
  function bindLead(card, e, pv, sc, lead) {
    // 'stale': live in an old copy (offline for a while) - the last score seen, in grey, no pulse.
    const mode = e.ended ? 'final' : e.live ? (phoneStale() ? 'stale' : sc ? 'live' : 'noscore') : 'pre';
    const close = mode === 'live' && isClose(e);
    const sp = mode === 'pre' ? startParts(e.startTs) : null;
    const rk = card._phone.offRank ? 0 : rankOf(e); // Live now's "Featured, then most watched": no "#3" over #1
    const saved = mode === 'stale' ? clockTime(snapshotAt()) : '';
    // "in 5 hours" counts down by itself: part of the signature, so a poll's rebind redraws it.
    const until = sp && sp.mins != null ? untilPhrase(sp, e.startTs) : '';
    const sig = [mode, e.liveText, e.score, rk, close, sp && sp.kick, sp && sp.hm, sp && sp.soon, until, phoneLeadNext, saved].join('|');
    if (card._sig === sig) return;
    card._sig = sig;
    const L = card._looks;
    const playing = mode === 'live' || mode === 'noscore';
    const half = pv.main === 'HALF' || pv.main === 'HT';
    card.classList.toggle('noscore', mode === 'noscore' || (mode === 'stale' && !sc));
    card.classList.toggle('stale', mode === 'stale');
    card._flag.replaceChildren(...(playing ? [el('i', 'pulse')] : []),
      mode === 'pre' ? (phoneLeadNext ? 'UP NEXT' : 'COMING UP') : mode === 'final' ? 'FINAL' : mode === 'stale' ? 'LAST SEEN'
        : pv.brk ? (half ? 'HALFTIME' : 'BREAK') : 'LIVE');
    card._flag.classList.toggle('on', playing && !pv.brk);
    card._flag.classList.toggle('brk', playing && pv.brk);
    card._flag.classList.toggle('quiet', !playing);
    // Eyebrow wordings, longest first; fitLeadTop keeps the longest that fits.
    card._eyebrow.replaceChildren();
    card._eyebrow.classList.toggle('close', close);
    const lg = leagueLabel(e.league);
    let alts = [];
    if (close) {
      card._eyebrow.append(icon(I.bolt));
      alts = rk ? [`Close game · #${rk}`, `Close · #${rk}`, 'Close'] : ['Close game', 'Close'];
    } else if (rk && mode !== 'final') {
      card._eyebrow.append(icon(I.flame));
      alts = [`#${rk} most watched`, `#${rk} watched`, `#${rk}`];
    } else if (e.league && lg !== catName(e)) alts = [lg];
    card._eyebrowAlts = alts;
    if (alts.length) card._eyebrow.append(el('span', null, alts[0]));
    if (card.isConnected) fitLeadTop(card);
    // The call to action by state: Watch while it plays or is about to; a quieter Open for a game
    // hours away; none on a final (there is nothing left to watch).
    const soon = mode === 'pre' && (sp.soon || sp.late);
    card._watch.className = 'watch' + ((mode === 'pre' && !soon) || mode === 'stale' ? ' ghost' : '') + (mode === 'final' ? ' hidden' : '');
    card._watch.replaceChildren(...(playing || soon ? [icon(I.play), 'Watch'] : ['Open']));
    let parts;
    if (mode === 'pre') {
      const t = el('b', null, sp.hm);
      if (sp.ap) t.appendChild(el('small', null, sp.ap));
      // Over the time, the list's own words: "IN 25 MIN" (orange) or "STARTING" inside the hour,
      // else the day ("TONIGHT", "TUESDAY").
      const day = sp.soon || sp.late || !sp.hm ? sp.kick
        : dayWord(e.startTs * 1000) || new Date(e.startTs * 1000).toLocaleDateString([], { weekday: 'long' });
      parts = [el('small', 'kick' + (sp.soon ? ' soon' : ''), day), t];
    } else if (mode === 'final') {
      const ft = String(e.liveText || '').trim();
      parts = [el('b', null, /^final\s*\/\s*\w+$/i.test(ft) ? ft.toUpperCase().replace(/\s/g, '') : 'FINAL')];
    } else if (mode === 'stale') {
      if (pv.main) {
        parts = [el('b', null, pv.main)];
        if (pv.unit) parts.push(el('small', null, pv.unit));
      } else {
        const at = hmParts(new Date(snapshotAt()));
        parts = [el('small', null, 'AS OF'), el('b', null, `${at.hm}${at.ap ? ' ' + at.ap : ''}`)];
      }
    } else {
      parts = [el('b', null, pv.main || 'LIVE')];
      if (pv.unit) parts.push(el('small', null, pv.unit));
      const t = trackerEl(pv);
      if (t) parts.push(t);
    }
    card._clock.replaceChildren(...parts);
    // The summary: two short Bodoni lines that stay inside the home team's panel. Each line is a
    // list of wordings, longest first; fitLeadDek keeps the longest that fits - a score is never
    // cut ("BUF leads 131–1…"): "BUF leads 131–128", then "BUF 131–128", then "131–128".
    let a = [], b = [];
    const said = (hi, lo, verb, who) => [`${who} ${verb} ${hi}–${lo}`, `${who} ${hi}–${lo}`, `${hi}–${lo}`];
    const tied = (word, hi, lo) => [`${word} ${hi}–${lo}`, `${hi}–${lo}`];
    // "in the 2nd intermission" -> "2nd intermission" when the line is short of room.
    const phrase = (p) => (p ? [p, p.replace(/^(in|at|after) the /, '')].filter((x, i, all) => all.indexOf(x) === i) : []);
    if (mode === 'pre') {
      a = [startVerb(e)];
      // Inside the hour the clock box already says "IN 25 MIN": the verb alone.
      b = (sp.soon && sp.mins > 0) || !until ? [] : [until];
    } else if (mode === 'stale') {
      if (sc) {
        const hi = Math.max(sc.home, sc.away), lo = Math.min(sc.home, sc.away);
        a = lead === 0 ? tied('Tied', hi, lo) : said(hi, lo, 'led', (lead > 0 ? L.home : L.away).code);
      } else a = ['Last seen'];
      b = pv.phrase ? phrase(pv.phrase) : [`at ${saved}`];
    } else if (sc) {
      const hi = Math.max(sc.home, sc.away), lo = Math.min(sc.home, sc.away);
      const winner = (lead > 0 ? L.home : L.away).code;
      if (mode === 'final') {
        // Level after a shootout ("2 - 2 (4-3 pens)") was not a draw: the score and the shootout's own words.
        a = lead === 0 ? (sc.extra ? [`${hi}–${lo}`] : tied(SOCCER.has(leagueName(catName(e))) ? 'Drawn' : 'Tied', hi, lo)) : said(hi, lo, 'won', winner);
        b = sc.extra ? [`(${sc.extra})`] : /\b(ot|overtime|so|shootout|pen|penalties|aet)\b/i.test(String(e.liveText || '')) ? ['after overtime'] : [];
      } else {
        a = lead === 0 ? tied('Tied', hi, lo) : said(hi, lo, 'leads', winner);
        b = sc.extra ? [`(${sc.extra})`] : phrase(pv.phrase);
      }
    } else {
      a = [pv.brk && pv.phrase ? pv.phrase[0].toUpperCase() + pv.phrase.slice(1) : 'Underway'];
      b = pv.brk ? [] : phrase(pv.phrase);
    }
    card._dekAlts = [a, b];
    card._dek.replaceChildren(el('span', null, a[0]), ...(b.length ? [el('span', null, b[0])] : []));
    if (card.isConnected) fitLeadDek(card);
  }

  /** The lead's summary lines: for each, the longest wording that fits left of the diagonal. */
  function fitLeadDek(card) {
    const alts = card._dekAlts;
    if (!alts || !card.isConnected) return;
    const spans = card._dek.children;
    alts.forEach((list, i) => {
      const span = spans[i];
      if (!span || list.length < 2) return;
      for (const t of list) {
        span.textContent = t;
        if (span.scrollWidth <= span.clientWidth + 0.5) return;
      }
    });
  }

  // --- the long-press sheet (#menu as a bottom sheet) ------------------------------------------

  /** A TV-style score bug for the top of the sheet. */
  function bugEl(e) {
    const L = looks(e);
    const pv = periodView(e);
    const sc = scoreOf(e);
    const show = !!sc && (!!e.live || !!e.ended);
    // Three-digit scores (basketball): smaller numerals and crests, so a code is never cut ("B… 128").
    const bug = el('div', 'bug' + (show && Math.max(sc.home, sc.away) >= 100 ? ' big' : ''));
    bug.setAttribute('aria-hidden', 'true');
    if (!e.away) {
      const t = el('div', 'bug-team');
      t.style.setProperty('--p1', deepOf(L.home.base, 0.1));
      t.style.setProperty('--p2', deepOf(L.home.base, -0.04));
      t.append(glyphEl(e, L), el('b', null, e.home));
      bug.appendChild(t);
    } else {
      const lead = show ? Math.sign(sc.home - sc.away) : 0;
      const side = (look, url, score, trailing) => {
        const t = el('div', 'bug-team' + (trailing ? ' trailing' : ''));
        t.style.setProperty('--p1', deepOf(look.base, 0.1));
        t.style.setProperty('--p2', deepOf(look.base, -0.04));
        t.append(crestEl(look, url, true), el('b', 'code', look.code)); // no crest: the code alone (never "BMN BMN")
        if (show) t.appendChild(el('span', 'sc', String(score)));
        return t;
      };
      bug.append(side(L.home, e.crestHome, show && sc.home, lead < 0), side(L.away, e.crestAway, show && sc.away, lead > 0));
    }
    const clock = el('div', 'bug-clock');
    if (e.ended) clock.appendChild(el('b', null, 'FINAL'));
    else if (e.live && phoneStale()) {
      // Live in an old copy (offline for a while), as on its tile: where it was, in grey - no LIVE.
      clock.appendChild(el('span', 's-kick', 'Last seen'));
      const at = hmParts(new Date(snapshotAt()));
      clock.appendChild(el('b', null, pv.main || `${at.hm} ${at.ap}`.trim()));
    } else if (e.live) {
      clock.appendChild(el('span', 's-flag', 'LIVE'));
      if (pv.main) clock.appendChild(el('b', null, pv.main));
    } else {
      const sp = startParts(e.startTs);
      clock.append(el('span', 's-kick', sp.kick), el('b', null, `${sp.hm} ${sp.ap}`.trim()));
    }
    if (show && sc.extra && !(e.live && !e.ended && phoneStale())) clock.appendChild(el('span', 's-kick', sc.extra)); // "4-3 pens"
    bug.appendChild(clock);
    return bug;
  }
  /** A narrow sheet (320px, 3-digit scores): the crests go before a team code would be cut. */
  function fitBug(bug) {
    if (!bug || !bug.isConnected) return;
    bug.classList.remove('tight');
    if ([...bug.querySelectorAll('.bug-team')].some((t) => t.scrollWidth > t.clientWidth + 0.5)) bug.classList.add('tight');
  }
  /** The bug's inputs: an open sheet swaps it only when one of them changed (a poll's new score). */
  const bugSig = (e) => [e.home, e.away, e.live, e.ended, e.liveText, e.score, e.startTs, e.crestHome, e.crestAway, phoneStale()].join('|');

  /**
   * A poll while the long-press sheet is open: its score bug follows the game (the tile under the
   * scrim already did), and a game that ended loses Send to TV, as a sheet built for a final has none.
   */
  function refreshPhoneSheet() {
    const menu = $('menu');
    if (menu._eventId == null || menu.classList.contains('hidden') || !menu.classList.contains('sheet')) return;
    const e = byId(menu._eventId);
    if (!e) return;
    const old = menu.querySelector(':scope > .bug');
    const sig = bugSig(e) + '|' + (meta.games.size || 0);
    if (old && menu._bugSig !== sig) {
      menu._bugSig = sig;
      const fresh = bugEl(e);
      if (fresh.innerHTML !== old.innerHTML || fresh.className !== old.className) {
        old.replaceWith(fresh);
        fitBug(fresh);
      }
    }
    if (e.ended) {
      const parts = [...menu.querySelectorAll(':scope > .cast-part')];
      if (parts.length) {
        const had = parts.some((n) => n.contains(document.activeElement));
        for (const n of parts) n.remove();
        const c = had && menu.querySelector('.sh-cancel');
        if (c) c.focus({ preventScroll: true });
      }
    }
  }

  /** Turns #menu into a bottom-sheet dialog with a grab handle; stays up if a sheet is already open. */
  function sheetStart(label) {
    const menu = $('menu');
    const open = menu.classList.contains('sheet') && !menu.classList.contains('hidden');
    menu.className = 'menu sheet' + (open ? '' : ' hidden');
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-modal', 'true');
    menu.setAttribute('aria-label', label);
    menu.style.left = '';
    menu.style.top = '';
    if (sheetKeyboard) { window.visualViewport.removeEventListener('resize', sheetKeyboard); sheetKeyboard = null; }
    menu.style.removeProperty('--kb');
    menu.replaceChildren(el('div', 'grab'));
    menu._eventId = null; // set again by the long-press sheet (refreshPhoneSheet follows that game)
    return menu;
  }
  /** True while an open phone sheet has its own history entry (Back closes the sheet, not the app). */
  let sheetEntry = false;
  function sheetShow(menu, focusEl) {
    $('scrim').classList.remove('hidden');
    menu.classList.remove('hidden');
    menu.scrollTop = 0;
    fitBug(menu.querySelector(':scope > .bug'));
    hideToast();
    if (!sheetEntry) { sheetEntry = true; history.pushState({ sheet: true }, ''); }
    const f = focusEl || menu.querySelector('button');
    if (f) f.focus({ preventScroll: true });
  }
  function sheetButton(iconMarkup, label, sub, cls) {
    const b = el('button', cls || null);
    b.type = 'button';
    const ic = el('span', 'sh-ic');
    ic.appendChild(icon(iconMarkup));
    const lbl = el('span', 'sh-lbl', label);
    if (sub) lbl.appendChild(el('small', null, sub));
    b.append(ic, lbl);
    return b;
  }
  function cancelButton() {
    const c = el('button', 'sh-cancel', 'Cancel');
    c.type = 'button';
    c.onclick = () => hideMenu();
    return c;
  }

  /** showFavoritesMenu, phone branch: score bug, star each team and the league, Send to TV. */
  function showPhoneSheet(e) {
    if (!store.get('held_once', false)) {
      store.set('held_once', true);
      // The hint line under the lead goes; the game under the finger stays where it is.
      const c = cardsById.get(e.id);
      const y0 = c ? c[0].getBoundingClientRect().top : 0;
      for (const n of document.querySelectorAll('.hold-hint')) n.remove();
      if (c) { const dy = c[0].getBoundingClientRect().top - y0; if (Math.abs(dy) >= 1) scrollBy(0, dy); }
    }
    const a = document.activeElement;
    sheetReturn = a && a._event && a._event.id === e.id ? a : null;
    const title = e.away ? `${e.home} vs ${e.away}` : e.home;
    const league = e.league || catName(e) || '';
    const menu = sheetStart(title);
    menu.appendChild(bugEl(e));
    menu._eventId = e.id;
    menu._bugSig = bugSig(e) + '|' + (meta.games.size || 0);
    const t = el('p', 'sheet-title');
    t.appendChild(el('b', null, title));
    const where = leagueLabel(league) || catName(e);
    if (where && !title.toLowerCase().includes(where.toLowerCase())) t.append(` · ${where}`); // never "NFL Redzone · NFL"
    menu.append(t, el('div', 'menu-title', 'Favorites'));
    const fav = el('div', 'sh-group');
    const star = (on, label, fn) => {
      const b = sheetButton(on ? I.star : I.starO, `${on ? 'Unstar' : 'Star'} ${label}`);
      b.querySelector('.sh-ic').classList.add('gold');
      b.onclick = () => {
        fn();
        hideMenu();
        // The game moves to (or out of) Your teams: the list follows it, so it stays under the finger.
        phoneAnchorId = e.id;
        lastLayoutKey = '';
        render();
        // Two deliberate lines (never a "·" or a lone word wrapping): what happened, then where it went.
        appToast(on ? `Unstarred ${label}` : `Starred ${label}`, 'ok', on || filterName ? '' : 'Now in Your teams');
      };
      fav.appendChild(b);
    };
    if (e.home) star(favorites.teams.has(e.home.toLowerCase()), e.home, () => favorites.toggleTeam(e.home));
    if (e.away) star(favorites.teams.has(e.away.toLowerCase()), e.away, () => favorites.toggleTeam(e.away));
    if (league) star(favorites.leagues.has(league.toLowerCase()), leagueLabel(league), () => favorites.toggleLeague(league));
    menu.appendChild(fav);
    if (!e.ended) addCastItems(menu, e); // a final has nothing left to send to a TV
    menu.appendChild(cancelButton());
    sheetShow(menu);
  }

  /** The player's Send to TV button on a phone: the same TV list, as a sheet. */
  function showPhoneCastSheet(e, from) {
    sheetReturn = from || null;
    const menu = sheetStart('Send to TV');
    if (cast.enabled()) addCastItems(menu, e);
    menu.appendChild(cancelButton());
    sheetShow(menu);
  }

  /**
   * One TV in the sheet. Online: "Plays there, stops here", and a tap sends the game. App closed: the
   * row is dimmed and says what to do; a tap keeps the sheet up and points at that line (no send, no
   * error toast - the TV cannot take it until Styx Sports is open on it).
   */
  function tvRow(tv, e) {
    const off = !tv.online;
    const b = sheetButton(I.tv, tv.name, off ? 'Open Styx Sports on the TV first' : 'Plays there, stops here', off ? 'off' : null);
    b.dataset.tv = tv.id;
    b.appendChild(el('span', 'sh-aux' + (off ? '' : ' on'), off ? 'App closed' : 'Online'));
    if (off) b.setAttribute('aria-disabled', 'true');
    b.onclick = () => {
      if (!off) { hideMenu(); cast.send(tv, e); return; }
      const sub = b.querySelector('.sh-lbl small');
      sub.classList.remove('nudge');
      void sub.offsetWidth; // restart the nudge on every tap
      sub.classList.add('nudge');
    };
    return b;
  }

  /** addCastItems, phone branch: one row per paired TV (online state), Pair, Remove. */
  function addPhoneCastItems(menu, e) {
    menu.appendChild(el('div', 'menu-title cast-part', 'Send to TV'));
    const g = el('div', 'sh-group cast-part');
    for (const tv of cast.tvs) g.appendChild(tvRow(tv, e));
    const pair = sheetButton(I.plus, cast.tvs.length ? 'Pair another TV…' : 'Pair a TV…');
    pair.onclick = () => showPhonePairForm(e);
    g.appendChild(pair);
    if (cast.tvs.length) {
      const manage = sheetButton(I.minus, 'Remove a TV…');
      manage.onclick = () => showPhoneRemove();
      g.appendChild(manage);
    }
    menu.appendChild(g);
    // The list above is the last known state: a TV switched on (or off) since then turns its row
    // as soon as the check comes back, while the sheet is up.
    cast.refresh().then(() => {
      if (!g.isConnected) return;
      for (const b of g.querySelectorAll('button[data-tv]')) {
        const tv = cast.tvs.find((v) => v.id === b.dataset.tv);
        if (!tv || !tv.online === b.classList.contains('off')) continue;
        const had = document.activeElement === b;
        const nb = tvRow(tv, e);
        b.replaceWith(nb);
        if (had) nb.focus({ preventScroll: true });
      }
    });
  }

  function showPhoneRemove() {
    const menu = sheetStart('Remove a TV');
    menu.appendChild(el('div', 'menu-title', 'Remove a TV'));
    const g = el('div', 'sh-group');
    for (const tv of cast.tvs) {
      const b = sheetButton(I.minus, `Remove ${tv.name}`, null, 'danger');
      b.onclick = () => { hideMenu(); cast.unpair(tv); };
      g.appendChild(b);
    }
    menu.append(g, cancelButton());
    sheetShow(menu);
  }

  /** showPairForm, phone branch: the TV's 6-digit code; with `e`, the game is sent right after. */
  function showPhonePairForm(e) {
    const menu = sheetStart('Pair a TV');
    menu.append(el('div', 'menu-title', 'Pair a TV'), el('div', 'menu-note', 'On the TV, open Styx Sports and choose Pair phone. Enter the code it shows:'));
    const input = document.createElement('input');
    Object.assign(input, { className: 'cast-code', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 7, placeholder: '000000' });
    input.setAttribute('aria-label', 'TV code');
    const err = el('p', 'sh-err hidden');
    err.setAttribute('role', 'alert');
    const go = el('button', 'sh-primary', 'Pair');
    go.type = 'button';
    const submit = async () => {
      go.disabled = true;
      err.classList.add('hidden');
      try {
        const tv = await cast.claim(input.value.replace(/\D/g, ''));
        hideMenu();
        appToast(`Paired with ${tv.name}`, 'ok');
        if (e) cast.send(cast.tvs.find((v) => v.id === tv.id) || tv, e);
      } catch (ex) {
        go.disabled = false;
        err.textContent = ex.message; // in the sheet: a toast would sit behind the keyboard
        err.classList.remove('hidden');
      }
    };
    go.onclick = submit;
    input.onkeydown = (ev) => { if (ev.key === 'Enter') submit(); };
    menu.append(input, err, go, cancelButton());
    sheetShow(menu, input);
    // Keep the sheet above the on-screen keyboard (an installed app's layout viewport does not shrink).
    const vv = window.visualViewport;
    if (vv) {
      sheetKeyboard = () => menu.style.setProperty('--kb', Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)) + 'px');
      vv.addEventListener('resize', sheetKeyboard);
      sheetKeyboard();
    }
  }

  /** `ctx` (phones): { lead, mixed, page } from renderPhoneRow - the hero card, a tile in a mixed-league section, under a league's own title. */
  function createCard(e, ctx) {
    const card = el('button', 'card');
    card.type = 'button';
    card.tabIndex = 0;
    card._event = e;
    card.dataset.id = e.id;

    if (isPhone()) {
      // A score tile (team-colour edge bars, team lines, a stadium-board status column) or the lead game.
      card.classList.add('game-row');
      card._phone = ctx || { lead: false, mixed: false };
      const L = looks(e);
      if (card._phone.lead) buildLead(card, e, L);
      else buildTile(card, e, L);
    } else {
      const top = el('div', 'card-top');
      card._pill = el('span', 'pill');
      card._badges = el('span', 'badges');
      top.append(card._pill, card._badges);
      card.appendChild(top);
      const mid = el('div', 'card-mid');
      if (!e.away) {
        card._middle = el('div', 'single-title', e.home);
        mid.appendChild(card._middle);
      } else {
        card._middle = el('div', 'mid-text');
        mid.append(team(e.home, e.crestHome), card._middle, team(e.away, e.crestAway));
      }
      card.appendChild(mid);
      card.appendChild(el('div', 'card-league', prettyLeague(e.league)));
    }
    bindDynamic(card, e);

    card.onclick = () => openEvent(card._event);
    card.oncontextmenu = (ev) => { ev.preventDefault(); showFavoritesMenu(card._event, ev.clientX, ev.clientY); };
    let pressTimer = null;
    const cancel = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
    if (isPhone()) {
      // Long-press: 550 ms without moving more than 10px opens the menu. Only a press that opened it
      // swallows its touchend (so no click follows); any other tap - a finger that rolled a pixel or
      // two included - stays a tap and plays the game.
      let pressFired = false, px = 0, py = 0;
      card.addEventListener('touchstart', (ev) => {
        cancel();
        pressFired = false;
        if (ev.touches.length !== 1) return;
        px = ev.touches[0].clientX; py = ev.touches[0].clientY;
        pressTimer = setTimeout(() => {
          pressTimer = null;
          pressFired = true;
          showFavoritesMenu(card._event, px, py);
        }, 550);
      }, { passive: true });
      card.addEventListener('touchend', (ev) => {
        cancel();
        if (pressFired && ev.cancelable) ev.preventDefault();
        pressFired = false;
      });
      card.addEventListener('touchcancel', () => { cancel(); pressFired = false; }, { passive: true });
      card.addEventListener('touchmove', (ev) => {
        if (!pressTimer) return;
        const t = ev.touches[0];
        if (ev.touches.length !== 1 || Math.abs(t.clientX - px) > 10 || Math.abs(t.clientY - py) > 10) cancel();
      }, { passive: true });
    } else {
      // The TV layout (a sideways phone) keeps the long-press it always had.
      card.addEventListener('touchstart', (ev) => {
        pressTimer = setTimeout(() => {
          pressTimer = null;
          const t = ev.touches[0];
          showFavoritesMenu(card._event, t.clientX, t.clientY);
        }, 550);
      }, { passive: true });
      card.addEventListener('touchend', (ev) => { if (!pressTimer) ev.preventDefault(); cancel(); });
      card.addEventListener('touchmove', cancel, { passive: true });
    }
    card.addEventListener('focus', () => {
      focusedId = e.id;
      card.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
      prefetch.focus(card._event || e);
    });
    card.addEventListener('blur', () => { if (prefetch.wanted === e.id) prefetch.blur(); });
    // A mouse resting on a card counts like focus (touch screens have no hover; they start cold).
    card.addEventListener('pointerenter', (ev) => { if (ev.pointerType === 'mouse') prefetch.focus(card._event || e); });
    card.addEventListener('pointerleave', (ev) => { if (ev.pointerType === 'mouse' && prefetch.wanted === e.id && document.activeElement !== card) prefetch.blur(); });

    let list = cardsById.get(e.id);
    if (!list) cardsById.set(e.id, (list = []));
    list.push(card);
    return card;
  }

  function bindDynamic(card, e) {
    if (card._phone) {
      try { bindPhone(card, e); } catch (err) { console.error('Styx Sports: game', e && e.id, err); }
      return;
    }
    card._event = e;
    const pill = card._pill;
    if (e.ended) {
      pill.textContent = 'FINAL';
      pill.classList.remove('live');
    } else if (e.live) {
      pill.textContent = liveLabel(e);
      pill.classList.add('live');
    } else {
      pill.textContent = startLabel(e.startTs);
      pill.classList.remove('live');
    }
    if (card._homeScore) {
      const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(e.score || '');
      card._homeScore.textContent = m ? m[1] : '';
      card._awayScore.textContent = m ? m[2] : '';
      const lead = m && (e.live || e.ended) ? Math.sign(Number(m[1]) - Number(m[2])) : 0;
      card._homeLine.classList.toggle('trailing', lead < 0);
      card._awayLine.classList.toggle('trailing', lead > 0);
    } else if (e.away) {
      if (e.score) {
        card._middle.textContent = e.score.replace(' - ', '–');
        card._middle.classList.remove('muted');
      } else {
        card._middle.textContent = 'vs';
        card._middle.classList.add('muted');
      }
    }
    const starred = favorites.matches(e);
    const parts = [];
    if (starred) parts.push('★');
    if (e.hot) parts.push(e.hotRank > 0 ? `🔥 #${e.hotRank}` : '🔥');
    if (e.premium) parts.push('PRO');
    card._badges.textContent = parts.join('   ');
    card._badges.classList.toggle('hot', e.hot && !starred);
  }

  function restoreFocus() {
    if (focusedId && cardsById.has(focusedId) && document.activeElement && document.activeElement.classList.contains('card')) {
      cardsById.get(focusedId)[0].focus({ preventScroll: true });
    }
  }

  function showProblem(msg) {
    $('overlay').classList.remove('hidden');
    $('overlay-msg').textContent = msg;
    $('overlay-retry').classList.remove('hidden');
    document.querySelector('#overlay .spinner').classList.add('hidden');
  }

  // ---------------------------------------------------------------------------------------------
  // Favorites menu
  // ---------------------------------------------------------------------------------------------

  function showFavoritesMenu(e, x, y) {
    if (isPhone()) return showPhoneSheet(e);
    const menu = $('menu');
    floatingMenu(menu);
    menu.replaceChildren();
    menu.appendChild(el('div', 'menu-title', 'Favorites'));
    const item = (label, fn) => {
      const b = el('button', null, label);
      b.onclick = () => { fn(); hideMenu(); lastLayoutKey = ''; render(); };
      menu.appendChild(b);
    };
    if (e.home) item((favorites.teams.has(e.home.toLowerCase()) ? '★ Unstar ' : '☆ Star ') + e.home, () => favorites.toggleTeam(e.home));
    if (e.away) item((favorites.teams.has(e.away.toLowerCase()) ? '★ Unstar ' : '☆ Star ') + e.away, () => favorites.toggleTeam(e.away));
    const league = e.league || favorites.categories.get(e.categoryId) || '';
    if (league) {
      const lk = league.toLowerCase();
      item((favorites.leagues.has(lk) ? '★ Unstar ' : '☆ Star ') + prettyLeague(league), () => favorites.toggleLeague(lk));
    }
    addCastItems(menu, e);
    menu.classList.remove('hidden');
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - h - 8)) + 'px';
    const first = menu.querySelector('button');
    if (first) first.focus();
  }

  /** "Send to <TV>" for each paired TV, then "Pair a TV…". */
  function addCastItems(menu, e) {
    if (!cast.enabled()) return;
    if (menu.classList.contains('sheet')) return addPhoneCastItems(menu, e);
    menu.appendChild(el('div', 'menu-title', 'Send to TV'));
    for (const tv of cast.tvs) {
      const b = el('button', null, `📺 ${tv.name}${tv.online ? '' : ' (app closed)'}`);
      b.onclick = () => { hideMenu(); cast.send(tv, e); };
      menu.appendChild(b);
    }
    const pair = el('button', null, cast.tvs.length ? '＋ Pair another TV…' : '📺 Pair a TV…');
    pair.onclick = () => showPairForm(e, menu.offsetLeft, menu.offsetTop);
    menu.appendChild(pair);
    if (cast.tvs.length) {
      const manage = el('button', null, 'Remove a TV…');
      manage.onclick = () => {
        menu.replaceChildren(el('div', 'menu-title', 'Remove a TV'));
        for (const tv of cast.tvs) {
          const b = el('button', null, `✕ ${tv.name}`);
          b.onclick = () => { hideMenu(); cast.unpair(tv); };
          menu.appendChild(b);
        }
      };
      menu.appendChild(manage);
    }
    cast.refresh(); // online state for next time
  }

  /** Enter the TV's 6-digit code; with `e`, the game is sent right after pairing. */
  function showPairForm(e, x, y) {
    if (isPhone()) return showPhonePairForm(e);
    const menu = $('menu');
    floatingMenu(menu);
    menu.replaceChildren(el('div', 'menu-title', 'Pair a TV'));
    menu.appendChild(el('div', 'menu-note', 'On the TV, open Styx Sports and choose Pair phone. Enter the code it shows:'));
    const input = document.createElement('input');
    Object.assign(input, { className: 'cast-code', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 7, placeholder: '000000' });
    menu.appendChild(input);
    const go = el('button', null, 'Pair');
    const submit = async () => {
      go.disabled = true;
      try {
        const tv = await cast.claim(input.value.replace(/\D/g, ''));
        hideMenu();
        appToast(`Paired with ${tv.name}`, 'ok');
        if (e) {
          const t = cast.tvs.find((v) => v.id === tv.id) || tv;
          cast.send(t, e);
        }
      } catch (err) {
        go.disabled = false;
        appToast(err.message);
      }
    };
    go.onclick = submit;
    input.onkeydown = (ev) => { if (ev.key === 'Enter') submit(); };
    menu.appendChild(go);
    menu.classList.remove('hidden');
    menu.style.left = Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)) + 'px';
    input.focus();
  }

  function hideMenu(fromHistory) {
    const menu = $('menu');
    const wasOpen = !menu.classList.contains('hidden');
    menu.classList.add('hidden');
    if (!menu.classList.contains('sheet')) return;
    // Phone sheet: give back its history entry, drop the scrim and the keyboard lift, and give
    // focus back to the game it was for.
    if (wasOpen && sheetEntry) {
      sheetEntry = false;
      if (fromHistory !== true && history.state && history.state.sheet) popOwnEntry();
    }
    $('scrim').classList.add('hidden');
    menu.style.removeProperty('--kb');
    if (sheetKeyboard) { window.visualViewport.removeEventListener('resize', sheetKeyboard); sheetKeyboard = null; }
    if (wasOpen && sheetReturn && menu.contains(document.activeElement) && sheetReturn.isConnected) sheetReturn.focus({ preventScroll: true });
    sheetReturn = null;
  }
  /** The TV / desktop menu: a small floating list (undoes the phone sheet if the screen turned). */
  function floatingMenu(menu) {
    menu.classList.remove('sheet');
    menu.setAttribute('role', 'menu');
    menu.removeAttribute('aria-modal');
    menu.removeAttribute('aria-label');
    $('scrim').classList.add('hidden');
  }
  // A tap outside the menu closes it. On phones the tap on the scrim closes the sheet on `click`
  // instead, so the scrim is still there to take that click (never the game card under it).
  // A cached index.html from before #scrim existed (the service worker refreshes each shell file on
  // its own): add it, so this file never stops at a missing element.
  if (!$('scrim')) {
    const s = el('div', 'scrim hidden');
    s.id = 'scrim';
    s.setAttribute('aria-hidden', 'true');
    $('menu').before(s);
  }
  document.addEventListener('pointerdown', (ev) => { if (!$('menu').contains(ev.target) && ev.target !== $('scrim')) hideMenu(); });
  $('scrim').addEventListener('click', () => hideMenu());

  /**
   * Phones: a bottom sheet follows a downward drag that starts on its header (grab handle, score
   * bug, titles) and closes past 80px or on a flick; otherwise it springs back.
   */
  function dragToDismiss(sheet, canStart, close) {
    let y0 = 0, t0 = 0, dy = 0, active = false;
    const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
    sheet.addEventListener('touchstart', (ev) => {
      if (!isPhone() || ev.touches.length !== 1 || sheet.scrollTop > 0 || !canStart(ev)) return;
      active = true; dy = 0; y0 = ev.touches[0].clientY; t0 = Date.now();
      sheet.style.transition = 'none';
    }, { passive: true });
    sheet.addEventListener('touchmove', (ev) => {
      if (!active) return;
      dy = Math.max(0, ev.touches[0].clientY - y0);
      ev.preventDefault(); // the sheet moves, not the page under it
      sheet.style.transform = dy ? `translateY(${dy}px)` : '';
    }, { passive: false });
    const end = () => {
      if (!active) return;
      active = false;
      const flick = dy > 24 && dy / Math.max(1, Date.now() - t0) > 0.5;
      const reset = () => { sheet.style.transform = ''; sheet.style.transition = ''; };
      if (dy > 80 || flick) {
        if (reduce()) { reset(); close(); return; }
        sheet.style.transition = 'transform .18s cubic-bezier(.4, 0, 1, 1)';
        sheet.style.transform = 'translateY(100%)';
        setTimeout(() => { close(); reset(); }, 180);
      } else if (dy) {
        sheet.style.transition = reduce() ? 'none' : 'transform .22s cubic-bezier(.2, .8, .2, 1)';
        sheet.style.transform = '';
        setTimeout(reset, 240);
      } else reset();
    };
    sheet.addEventListener('touchend', end);
    sheet.addEventListener('touchcancel', end);
  }
  const headerTouch = (sheet, sel) => (ev) => !!ev.target.closest(sel) || ev.touches[0].clientY - sheet.getBoundingClientRect().top < 44;
  dragToDismiss($('menu'), (ev) => $('menu').classList.contains('sheet') && headerTouch($('menu'), '.grab, .bug, .sheet-title, .menu-title, .menu-note')(ev), () => hideMenu());
  const acctCard = document.querySelector('#acct .acct-card');
  dragToDismiss(acctCard, headerTouch(acctCard, '.acct-title'), () => acct.close());

  // ---------------------------------------------------------------------------------------------
  // Keyboard navigation (D-pad style)
  // ---------------------------------------------------------------------------------------------

  document.addEventListener('keydown', (ev) => {
    if (!$('menu').classList.contains('hidden')) {
      if (ev.key === 'Escape') hideMenu();
      return;
    }
    if (acct.isOpen()) {
      if (ev.key === 'Escape') acct.close();
      return;
    }
    if (!$('player').classList.contains('hidden')) return player.onKey(ev);
    if (liveTv.isOpen()) return liveTv.onKey(ev);
    const a = document.activeElement;
    if ((ev.key === 'r' || ev.key === 'R') && !(a && a.tagName === 'INPUT')) { // the app's Menu key
      ev.preventDefault();
      loadSchedule(true);
      return;
    }
    const isCard = a && a.classList.contains('card');
    const strips = [...document.querySelectorAll('.strip')];
    if (!strips.length) return;
    if (!isCard) {
      if (ev.key.startsWith('Arrow') && !(a && (a.tagName === 'INPUT' || a.classList.contains('chip') || a.tagName === 'A' || a.tagName === 'BUTTON'))) {
        ev.preventDefault();
        strips[0].querySelector('.card').focus();
      }
      return;
    }
    const strip = a.parentElement;
    const cards = [...strip.children].filter((n) => n.classList.contains('card'));
    const i = cards.indexOf(a);
    const ri = strips.indexOf(strip);
    let target = null;
    // Phones list each group top to bottom: Up / Down walk the games, then the next group.
    if (isPhone() && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
      const down = ev.key === 'ArrowDown';
      const near = (s) => { const c = [...s.children].filter((n) => n.classList.contains('card')); return down ? c[0] : c[c.length - 1]; };
      target = cards[down ? i + 1 : i - 1] || (strips[down ? ri + 1 : ri - 1] && near(strips[down ? ri + 1 : ri - 1]))
        || (down ? null : document.querySelector('.chip.selected') || document.querySelector('.chip'));
      ev.preventDefault();
      if (target) target.focus();
      return;
    }
    switch (ev.key) {
      case 'ArrowLeft': target = cards[i - 1] || a; break;
      case 'ArrowRight': target = cards[i + 1] || a; break;
      case 'ArrowUp':
        if (ri === 0) { target = document.querySelector('.chip.selected') || document.querySelector('.chip'); break; }
        target = nearestCard(strips[ri - 1], a); break;
      case 'ArrowDown': if (strips[ri + 1]) target = nearestCard(strips[ri + 1], a); break;
      case 'Enter': case ' ': ev.preventDefault(); a.click(); return;
      case 'ContextMenu': case 'f': case 'F': {
        ev.preventDefault();
        const r = a.getBoundingClientRect();
        showFavoritesMenu(a._event, r.left + 20, r.top + 20);
        return;
      }
      default: return;
    }
    ev.preventDefault();
    if (target) target.focus();
  });

  function nearestCard(strip, from) {
    const fx = from.getBoundingClientRect().left + from.offsetWidth / 2;
    let best = null, bestD = Infinity;
    for (const c of strip.children) {
      if (!c.classList.contains('card')) continue;
      const r = c.getBoundingClientRect();
      const d = Math.abs(r.left + r.width / 2 - fx);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  // Chips: Left/Right between chips, Down back into the rows.
  $('chips').addEventListener('keydown', (ev) => {
    const a = document.activeElement;
    if (!a.classList.contains('chip')) return;
    if (ev.key === 'ArrowLeft' && a.previousElementSibling) { ev.preventDefault(); a.previousElementSibling.focus(); }
    if (ev.key === 'ArrowRight' && a.nextElementSibling) { ev.preventDefault(); a.nextElementSibling.focus(); }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); const c = document.querySelector('.card'); if (c) c.focus(); }
  });

  // ---------------------------------------------------------------------------------------------
  // Player (NativePlayerActivity.java)
  // ---------------------------------------------------------------------------------------------

  const player = {
    root: $('player'), video: $('video'), video2: $('video2'),
    hls: null, event: null, servers: [], current: -1, failed: new Set(), resolved: new Map(),
    generation: 0, everPlayed: false, retried: false, manual: false, open: false, embedMode: false,
    hudTimer: null, stallTimer: null, startTimer: null, impatience: null, toastTimer: null,
    /** Self-healing: stall/error counts on the current stream, the migration under way, the standby element. */
    health: { stalls: [], long: 0, errors: [] }, migrating: null, standby: null, degraded: new Set(),
    /** Live TV: playing a channel of the account's playlist instead of a game (◀ ▶ = channels). */
    channelMode: false, channels: [], channelGroup: '',
    /** Shared-pool lease id (the same clientId used for /api/ping). Empty when using your own account. */
    slot: null, hbTimer: null,

    /**
     * Own account: the slot is bookkeeping only (the shared account usually *is* this account,
     * so the connection counts against the same 5 and shows on /stats), never a reason to skip
     * premium. Shared account: no slot, no premium.
     */
    async takeSlot(kind, label) {
      if (this.slot) return true;
      const own = usesOwnAccount();
      if (!pool.shared) return own;
      try {
        const r = await api('/api/pool/acquire', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: clientId(), kind, label: String(label || '').slice(0, 80), platform: 'web' }),
        });
        if (r.used != null) pool.used = r.used;
        if (r.max) pool.max = r.max;
        if (!r.granted) return own;
        this.slot = clientId();
        this.clearTimer('hbTimer');
        this.hbTimer = setInterval(() => this.beatSlot(label), 20_000);
        return true;
      } catch {
        return own;
      }
    },

    beatSlot(label) {
      if (!this.slot) return;
      fetch('/api/pool/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: this.slot, label: String(label || '').slice(0, 80) }),
        cache: 'no-store',
        keepalive: true,
      }).then((res) => res.json()).then((d) => {
        if (d && d.granted === false) this.slot = null;
        if (d && d.used != null) pool.used = d.used;
      }).catch(() => {});
    },

    dropSlot() {
      this.clearTimer('hbTimer');
      if (!this.slot) return;
      const id = this.slot;
      this.slot = null;
      fetch('/api/pool/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
        cache: 'no-store',
        keepalive: true,
      }).catch(() => {});
    },

    slotQuery() {
      return this.slot ? '&slot=' + encodeURIComponent(this.slot) : '';
    },

    openFor(e) {
      this.event = e;
      this.channelMode = false;
      this.servers = [];
      this.current = -1;
      this.failed = new Set();
      // What was resolved while the card had focus plays straight away (resolve() finds it).
      const ahead = prefetch.fresh(e.id);
      this.resolved = new Map(ahead ? ahead.streams : []);
      this.pre = new Set(this.resolved.keys());
      this.pagePre = ahead && ahead.page ? ahead.page : null;
      this.askedAt = performance.now();
      this.dropStandby();
      this.degraded = new Set();
      this.everPlayed = false;
      this.retried = false;
      this.manual = false;
      this.open = true;
      this.embedMode = false;
      this.embeddable = {};
      this.generation++;
      this.root.classList.remove('hidden');
      this.root.classList.remove('idle');
      this.hideEmbed();
      document.body.style.overflow = 'hidden';
      $('p-servers').replaceChildren();
      $('p-unmute').classList.add('hidden');
      this.primeForSound();
      this.updateHud();
      this.status('Connecting…', true);
      this.root.focus();
      history.pushState({ player: true }, '');
      this.resolvePage();
    },

    close(fromHistory) {
      if (!this.open) return;
      this.open = false;
      this.generation++;
      this.clearTimers();
      this.dropStandby();
      this.stopPlayback();
      telemetry.flush();
      this.hideEmbed();
      this.root.classList.add('hidden');
      document.body.style.overflow = '';
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      // (A phone sheet closed a moment ago may still be going back over its own entry: pop ours too.)
      if (!fromHistory && history.state && (history.state.player || (history.state.sheet && ownPops > 0))) popOwnEntry();
      if (this.channelMode) {
        this.channelMode = false;
        liveTv.render(); // "Recently watched" may have gained this channel
        liveTv.focusCurrent(); // the Live TV screen is still open underneath
        return;
      }
      this.dropSlot();
      lastLayoutKey = '';
      if (isPhone() && this.event) phoneAnchorId = this.event.id; // its card stays where the viewer left it
      render();
      const cards = cardsById.get(this.event && this.event.id);
      if (cards) cards[0].focus({ preventScroll: false });
    },

    // --- Live TV channel mode (LiveTvActivity -> NativePlayerActivity channel intent) ---------

    openChannel(list, idx, groupName) {
      this.event = null;
      this.channelMode = true;
      this.channels = list;
      this.channelGroup = groupName;
      this.servers = [];
      this.failed = new Set();
      this.resolved = new Map();
      this.everPlayed = false;
      this.retried = false;
      this.manual = true;
      this.open = true;
      this.embedMode = false;
      this.embeddable = {};
      this.generation++;
      this.root.classList.remove('hidden');
      this.root.classList.remove('idle');
      this.hideEmbed();
      document.body.style.overflow = 'hidden';
      $('p-unmute').classList.add('hidden');
      this.primeForSound();
      this.root.focus();
      history.pushState({ player: true }, '');
      this.tuneTo(idx);
    },

    /**
     * Called synchronously from the tap that opens the player. On a phone that tap is the only
     * user gesture there will be, and the stream takes seconds to resolve - longer than WebKit's
     * gesture window - so the real play() with sound would be refused and every game would start
     * muted behind "Tap to unmute" (seen on an iPhone 17 Pro Max). A play() *now*, on the still
     * empty element, marks it user-activated for good; the promise just aborts when the source is
     * attached.
     */
    primeForSound() {
      this.video.muted = false;
      const p = this.video.play();
      if (p && p.catch) p.catch(() => {});
    },

    async tuneTo(idx, isRetry = false) {
      const n = this.channels.length;
      if (!n) return;
      idx = (idx + n) % n;
      this.current = idx;
      this.retried = isRetry;
      if (!isRetry) this.askedAt = performance.now();
      this.pre = null;
      const gen = ++this.generation;
      this.clearTimers();
      this.stopPlayback();
      this.hideEmbed();
      const ch = this.channels[idx];
      liveTv.recordRecent(ch);
      this.updateHud();
      this.renderServers();
      this.status(`Tuning to ${ch.n}…`, true);
      this.showHud();
      let data;
      try {
        data = await api('/api/iptv/token?u=' + encodeURIComponent(ch.u) + this.slotQuery());
      } catch (e) {
        if (gen !== this.generation) return;
        return this.channelFailed(e.message);
      }
      if (gen !== this.generation) return;
      this.play({ server: ch.n, hls: data.hls, direct: data.direct || null, cdn: data.cdn || null, playable: true });
    },

    channelFailed(why) {
      const ch = this.channels[this.current];
      console.warn('[styx] channel ' + (ch ? ch.n : '?') + ' failed: ' + why);
      if (this.everPlayed && this.teleCurrent) telemetry.push({ kind: 'error', code: why, cdn: this.teleCurrent.cdn, premium: true, relay: this.teleCurrent.relay });
      this.clearTimers();
      this.stopPlayback();
      this.everPlayed = false;
      this.status(`${ch ? ch.n : 'This channel'} isn’t responding.`, false);
      const actions = $('p-actions');
      actions.replaceChildren();
      const btn = (label, fn, primary) => {
        const b = el('button', 'btn' + (primary ? ' primary' : ''), label);
        b.onclick = fn;
        actions.appendChild(b);
        return b;
      };
      btn('Try again', () => this.tuneTo(this.current), true).focus();
      if (this.channels.length > 1) btn('Next channel', () => this.tuneTo(this.current + 1));
      btn('Back to channels', () => this.close());
    },

    async resolvePage() {
      const gen = this.generation;
      let data = this.pagePre; // the server tabs, when the card's focus already fetched them
      this.pagePre = null;
      try {
        if (!data) data = await api('/api/stream?only=servers&page=' + encodeURIComponent(this.event.url));
      } catch (e) {
        if (gen !== this.generation) return;
        telemetry.push({ kind: 'fail', game: this.event.id, code: 'page: ' + e.message });
        return this.allFailed('Could not open this game.\n' + e.message, false);
      }
      if (gen !== this.generation) return;
      const all = data.servers || [];
      // Own account, or a shared-pool slot: premium tabs first. A locked account (or a full
      // pool) falls through to the free servers like any other miss.
      const own = usesOwnAccount();
      const poolOk = !account.signedIn && pool.shared && pool.sharedPremium !== false;
      const wantPremium = all.some((s) => s.premium) && (own || poolOk);
      if (wantPremium) {
        const title = this.event.away ? `${this.event.home} vs ${this.event.away}` : this.event.home;
        const got = await this.takeSlot('game', title);
        if (gen !== this.generation) return;
        if (!got) this.status(`Premium is full (${pool.used}/${pool.max}). Using a free server.`, false);
      }
      const premiumLocked = account.premium === false || (poolOk && !this.slot && !own);
      const premium = all.filter((s) => s.premium && (own || this.slot));
      const free = all.filter((s) => !s.premium);
      this.servers = premiumLocked ? free.concat(premium) : premium.concat(free);
      if (!this.servers.length) {
        if (!all.length) return this.allFailed('No servers listed for this game.', false);
        return this.premiumOnly();
      }
      const active = all[data.activeIndex];
      let start = 0;
      if (this.servers.includes(active) && (!premium.length || premiumLocked)) start = this.servers.indexOf(active);
      // Prefer the server that worked last time for this game, unless a premium server has
      // just become available and should get its chance first.
      const remembered = store.get('server_' + this.event.id, null);
      if (remembered) {
        const idx = this.servers.findIndex((s) => s.name === remembered);
        if (idx >= 0 && (this.servers[idx].premium || !premium.length || premiumLocked)) start = idx;
      }
      this.renderServers();
      this.switchTo(start, false);
    },

    /** Every server is premium and none is available to us. */
    premiumOnly() {
      if (account.signedIn) {
        return this.allFailed('This stream is for the site’s premium members only.\nPick another game from the home screen.', false);
      }
      if (pool.shared) {
        return this.allFailed(`All ${pool.max} shared premium connections are in use right now.\nFree servers aren’t listed for this game — try again in a minute.`, true);
      }
      this.allFailed('This stream is for the site’s premium members only.\nSign in to your premium account to watch it, or pick another game.', false);
      const b = el('button', 'btn primary', 'Sign in');
      b.onclick = () => {
        // Phones: the account sheet takes over the player's history entry (Back then closes the
        // sheet). Popping it and pushing a new one would race: the async back() lands after the
        // push and takes the sheet's entry with it, so Back would leave the app.
        if (isPhone() && history.state && history.state.player) {
          this.close(true);
          history.replaceState({ acct: true }, '');
          acct.entry = true;
        } else {
          this.close();
        }
        acct.open();
      };
      $('p-actions').prepend(b);
      b.focus();
    },

    renderServers() {
      const box = $('p-servers');
      box.replaceChildren();
      if (this.channelMode) {
        const n = this.channels.length;
        box.appendChild(el('span', 'hint', `Channel ${this.current + 1} of ${n} · ${this.channelGroup}`));
        return;
      }
      this.servers.forEach((s, i) => {
        const emb = this.embeddable && this.embeddable[i];
        const cls = 'server' + (i === this.current ? ' current' : '') + (this.failed.has(i) && !emb ? ' failed' : '') + (emb ? ' embed' : '') + (s.premium ? ' premium' : '');
        const b = el('button', cls, (s.premium ? '★ ' : '') + s.name + (emb ? ' ▣' : ''));
        b.title = emb ? 'Plays in the embedded player (may show ads)' : s.premium ? 'Premium server (your account)' : '';
        b.onclick = () => this.switchTo(i, true);
        box.appendChild(b);
      });
      if (this.servers.length) {
        const mode = this.embedMode ? ' · embedded' : '';
        $('p-servers').appendChild(el('span', 'hint', `Server ${this.current + 1} of ${this.servers.length}${mode}`));
      }
      // On phones the list scrolls sideways; keep the playing server in view.
      const cur = box.querySelector('.server.current');
      if (cur && box.scrollWidth > box.clientWidth) cur.scrollIntoView({ inline: 'center', block: 'nearest' });
    },

    async switchTo(index, manual) {
      if (!this.servers.length) return;
      index = (index + this.servers.length) % this.servers.length;
      this.current = index;
      this.manual = manual;
      this.retried = false;
      // A hand-picked server: the wait the viewer feels starts now (an automatic fail-over keeps
      // the original press, so its start time counts the failed server too).
      if (manual) this.askedAt = performance.now();
      const gen = ++this.generation;
      this.clearTimers();
      this.dropStandby(); // a switch by hand or by the sweep supersedes any migration under way
      this.stopPlayback();
      this.hideEmbed();
      this.renderServers();
      const s = this.servers[index];
      this.status(`Connecting to ${s.name}…\n\n→ tries the next server`, true);
      this.showHud();

      if (!manual) {
        // Embed hosts can take 15–20 s; race the next server after a while.
        this.impatience = setTimeout(() => this.raceNext(gen), IMPATIENCE_MS);
      }
      const stream = await this.resolve(s);
      if (gen !== this.generation) return;
      this.clearTimer('impatience');
      if (playable(stream)) return this.play(stream);
      // Not playable through our proxy (a CDN whose token is bound to the minting IP). If the site has an
      // embeddable player for it, that plays from the viewer's own IP — but with the site's ads.
      // On a manual pick, go straight there; on auto fallback, exhaust the clean servers first.
      if (stream && stream.embed) {
        if (manual) return this.enterEmbed(s, stream);
        this.embeddable = this.embeddable || {};
        this.embeddable[this.current] = stream;
      }
      const why = !stream ? 'no stream' : stream.state === 'gate' ? 'premium only'
        : !stream.hls && !stream.direct ? 'no playable stream' : stream.warming ? `channel ${stream.cdn} still warming up`
          : stream.cdnStatus === 0 ? `CDN ${stream.cdn} unreachable from this network`
            : `CDN ${stream.cdn} refused (${stream.cdnStatus})`;
      this.onFailure(why, stream);
    },

    /**
     * The current server is slow to answer: try the others, one after another, and take the
     * first that is playable. Servers that turn out unplayable are marked failed so the normal
     * fallback does not visit them again.
     */
    async raceNext(gen) {
      const tried = new Set([this.current]);
      let idx = this.current;
      for (;;) {
        idx = this.nextIndex(idx);
        if (idx < 0 || tried.has(idx)) return;
        tried.add(idx);
        const s = this.servers[idx];
        const stream = await this.resolve(s);
        if (gen !== this.generation) return; // the current server answered (or the user moved on)
        if (playable(stream)) {
          this.generation++;
          this.current = idx;
          this.retried = false;
          this.renderServers();
          this.play(stream);
          return;
        }
        console.warn(`[styx] race: ${s.name} unplayable`, stream && stream.log);
        if (stream && stream.embed) { this.embeddable = this.embeddable || {}; this.embeddable[idx] = stream; }
        this.failed.add(idx);
        this.renderServers();
      }
    },

    async resolve(s) {
      if (this.resolved.has(s.pageUrl)) return this.resolved.get(s.pageUrl);
      try {
        const q = '/api/stream?server=' + encodeURIComponent(s.pageUrl) + '&name=' + encodeURIComponent(s.name) + (s.premium ? '&premium=1' : '') + this.slotQuery();
        const data = await api(q);
        const stream = data.stream || { server: s.name, hls: null };
        // The Worker never touches the premium CDN (its panel bans the account for requests
        // from many addresses), so it cannot say whether that playlist is up or still a
        // warming.ts placeholder; this browser is the only thing that can look.
        if (stream.ownAddressOnly && stream.direct) await checkDirect(stream);
        // Remember both outcomes; a CDN that refuses us will not change its mind in a minute.
        // Playable results are dropped again when a playing stream dies (see onFailure).
        this.resolved.set(s.pageUrl, stream);
        if (s.premium && account.signedIn) {
          // What the site gave a premium tab tells us whether the account really has premium.
          if (stream.hls || stream.direct || stream.embed) setAccount({ ...account, premium: true });
          else if (stream.state === 'gate') setAccount({ ...account, premium: false });
        }
        return stream;
      } catch (e) {
        return { server: s.name, hls: null, error: e.message };
      }
    },

    /**
     * `stream.direct` (the CDN's own URL) is tried before the proxied `stream.hls` path: the
     * premium CDN binds its segments to the IP that opened the playlist, which only the browser
     * itself can satisfy. If the direct attempt dies before the first frame (CORS, blocked
     * network, ...) the same stream is retried through the proxy before the server is failed.
     */
    play(stream, sourceIdx = 0) {
      const v = this.video;
      const gen = this.generation;
      const sources = [stream.direct, stream.hls].filter(Boolean);
      const src = sources[sourceIdx] || sources[0];
      const viaDirect = !!stream.direct && sourceIdx === 0;
      let started = false;
      // Telemetry: what this attempt is, when the viewer asked for it (the press or the switch,
      // not this call: resolving is part of the wait), and whether we are inside a stall.
      const t0 = this.askedAt || performance.now();
      const server = this.channelMode ? null : this.servers[this.current];
      const tele = {
        game: this.channelMode ? 'tv' : String(this.event ? this.event.id : ''),
        server: stream.server || '',
        cdn: stream.cdn || src,
        premium: !!(server && server.premium),
        relay: !viaDirect,
      };
      // Resolved before the press (prefetch): reported as a "pre" start.
      if (server && this.pre && this.pre.has(server.pageUrl)) tele.pre = true;
      this.teleCurrent = tele;
      this.health = { stalls: [], long: 0, errors: [] };
      const ctx = { gen, tele, t0, started: false, stallAt: 0 };
      ctx.fail = (why) => {
        if (gen !== this.generation) return;
        if (!ctx.started) telemetry.push({ kind: 'error', code: why, cdn: tele.cdn, premium: tele.premium, relay: tele.relay });
        if (!ctx.started && sourceIdx + 1 < sources.length) {
          console.warn(`[styx] ${stream.server}: ${why} (${viaDirect ? 'direct' : 'proxy'}); retrying via ${viaDirect ? 'proxy' : 'direct'}`);
          this.generation++;
          this.clearTimer('startTimer');
          this.clearTimer('stallTimer');
          this.stopPlayback();
          this.play(stream, sourceIdx + 1);
          return;
        }
        this.onFailure(why);
      };
      this.status(`Connecting to ${stream.server}…`, true);
      this.startTimer = setTimeout(() => ctx.fail('start timeout'), START_TIMEOUT_MS);
      this.bind(v, ctx);

      if (window.Hls && Hls.isSupported()) {
        const hls = this.makeHls(viaDirect);
        this.hls = hls;
        this.bindHls(hls, ctx);
        hls.on(Hls.Events.MANIFEST_PARSED, () => { if (gen === this.generation) this.tryPlay(); });
        hls.loadSource(src);
        hls.attachMedia(v);
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = src;
        v.onloadedmetadata = () => this.tryPlay();
      } else {
        this.allFailed('This browser cannot play HLS video.', true);
      }
    },

    makeHls(viaDirect) {
      return new Hls({
        lowLatencyMode: false,
        liveSyncDurationCount: 4, // a little extra runway: every segment takes a hop through the proxy
        manifestLoadingTimeOut: 15000,
        levelLoadingTimeOut: 15000,
        fragLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: viaDirect ? 1 : 2, // a CORS refusal shows up as a manifest error
        levelLoadingMaxRetry: 3,
        fragLoadingMaxRetry: 3,
      });
    },

    /** The on-screen element's events for one attempt: first frame, stalls, end, error. */
    bind(v, ctx) {
      const { gen, tele } = ctx;
      v.onplaying = () => {
        if (gen !== this.generation) return;
        if (!ctx.started) {
          telemetry.push({ kind: 'start', ...tele, ttff: Math.round(performance.now() - ctx.t0) });
          this.watchStart = Date.now();
        } else if (ctx.stallAt) {
          const dur = Math.round(performance.now() - ctx.stallAt);
          telemetry.push({ kind: 'stall', cdn: tele.cdn, premium: tele.premium, relay: tele.relay, duration: dur, position: Math.round(v.currentTime * 1000) });
          if (dur > DEGRADE_LONG_STALL_MS) this.health.long++;
          this.checkHealth();
        }
        ctx.stallAt = 0;
        ctx.started = true;
        this.clearTimer('startTimer');
        this.clearTimer('stallTimer');
        this.hideStatus();
        if (!this.everPlayed) {
          this.everPlayed = true;
          this.failed.clear();
          this.renderServers();
          if (this.manual && this.event && this.servers[this.current]) store.set('server_' + this.event.id, this.servers[this.current].name);
        }
        this.showHud();
      };
      v.onwaiting = () => {
        if (gen !== this.generation) return;
        if (ctx.started && !ctx.stallAt) {
          ctx.stallAt = performance.now();
          this.health.stalls.push(ctx.stallAt);
          this.health.stalls = this.health.stalls.filter((t) => ctx.stallAt - t <= DEGRADE_WINDOW_MS);
          this.checkHealth();
        }
        if (this.everPlayed) this.status('Buffering…', true);
        this.clearTimer('stallTimer');
        this.stallTimer = setTimeout(() => { if (gen === this.generation) this.onFailure('stalled'); }, STALL_MS);
      };
      v.onended = () => { if (gen === this.generation) this.onFailure('ended'); };
      v.onerror = () => { if (gen === this.generation && !this.hls) ctx.fail('media error'); };
    },

    /** hls.js errors for the on-screen attempt: fatal ones fail it, a burst of load errors degrades it. */
    bindHls(hls, ctx) {
      const { gen } = ctx;
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (gen !== this.generation) return;
        if (data.fatal) {
          const code = data.response && data.response.code ? ` HTTP ${data.response.code}` : '';
          ctx.fail(`${data.type}/${data.details}${code}`);
        } else if (ctx.started && /LoadError|LoadTimeOut/.test(data.details || '')) {
          const now = performance.now();
          this.health.errors.push(now);
          this.health.errors = this.health.errors.filter((t) => now - t <= DEGRADE_ERROR_WINDOW_MS);
          this.checkHealth();
        }
      });
    },

    // --- Self-healing: leave a degraded stream for the next best server without a black screen ----
    // (NativePlayerActivity.checkHealth / migrate / swapToStandby)

    checkHealth() {
      if (this.channelMode || this.embedMode || !this.everPlayed || this.migrating || this.standby) return;
      const h = this.health;
      const why = h.stalls.length >= DEGRADE_STALLS ? 'stalls' : h.long >= DEGRADE_LONG_STALLS ? 'long-stalls' : h.errors.length >= DEGRADE_ERRORS ? 'errors' : null;
      if (why) this.migrate(why);
    },

    /** The current stream is degraded: ready the next best server in the hidden second element. */
    async migrate(why) {
      const from = this.servers[this.current];
      if (!from) return;
      this.degraded.add(from.pageUrl);
      // Next best in preference order: not this one, not failed, not one already left as
      // degraded; premium tabs only with a slot or an account of our own.
      const canPremium = !!this.slot || usesOwnAccount();
      let idx = -1;
      for (let i = 0; i < this.servers.length; i++) {
        const s = this.servers[i];
        if (i === this.current || this.failed.has(i) || this.degraded.has(s.pageUrl)) continue;
        if (s.premium && !canPremium) continue;
        idx = i;
        break;
      }
      if (idx < 0) { console.info(`[styx] ${from.name} is degraded (${why}) but there is no other server to move to`); return; }
      const to = this.servers[idx];
      const token = {};
      this.migrating = { why, idx, token, askedAt: performance.now() };
      console.info(`[styx] ${from.name} is degraded (${why}); readying ${to.name} alongside`);
      this.resolved.delete(to.pageUrl); // fresh: signed playlist URLs are short-lived
      const stream = await this.resolve(to);
      if (!this.migrating || this.migrating.token !== token) return;
      if (!playable(stream)) return this.standbyFailed(`no playable stream (${stream && (stream.state || stream.error)})`);
      this.startStandby(stream);
    },

    startStandby(stream) {
      const el = this.video2;
      const src = stream.direct || stream.hls;
      const sb = { el, stream, hls: null, timer: null, onError: null };
      this.standby = sb;
      el.muted = true;
      el.onplaying = () => { if (this.standby === sb) this.swapToStandby(true); };
      el.onended = () => { if (this.standby === sb) this.standbyFailed('ended'); };
      el.onerror = () => { if (this.standby === sb && !sb.hls) this.standbyFailed('media error'); };
      sb.timer = setTimeout(() => { if (this.standby === sb) this.standbyFailed('no video after ' + STANDBY_TIMEOUT_MS / 1000 + 's'); }, STANDBY_TIMEOUT_MS);
      if (window.Hls && Hls.isSupported()) {
        sb.hls = this.makeHls(!!stream.direct);
        sb.onError = (_, data) => { if (this.standby === sb && data.fatal) this.standbyFailed(`${data.type}/${data.details}`); };
        sb.hls.on(Hls.Events.ERROR, sb.onError);
        sb.hls.on(Hls.Events.MANIFEST_PARSED, () => { if (this.standby === sb) el.play().catch(() => {}); });
        sb.hls.loadSource(src);
        sb.hls.attachMedia(el);
      } else {
        el.src = src;
        el.onloadedmetadata = () => { if (this.standby === sb) el.play().catch(() => {}); };
      }
      console.info(`[styx] standby: ${stream.server} via ${stream.cdn || src}`);
    },

    /**
     * The standby becomes the element on screen and the degraded one is stopped: with frames
     * (`ready`) the swap is seamless; promoted early (the old stream died first) it shows the
     * connecting overlay and the usual first-frame handling takes it from there.
     */
    swapToStandby(ready) {
      const sb = this.standby;
      const mig = this.migrating;
      if (!sb || !mig) return;
      const from = this.servers[this.current];
      const to = this.servers[mig.idx];
      const wasMuted = this.video.muted;
      console.info(`[styx] ${ready ? 'switching to' : 'promoting'} ${to.name} (${mig.why})`);
      clearTimeout(sb.timer);
      this.clearTimers();
      this.stopPlayback(); // the degraded element: stop telemetry, hls, handlers
      if (from) telemetry.push({ kind: 'switch', from: from.name, to: to.name, reason: 'degraded-' + mig.why });

      const old = this.video;
      old.classList.add('standby');
      sb.el.classList.remove('standby');
      sb.el.onplaying = sb.el.onended = sb.el.onerror = sb.el.onloadedmetadata = null;
      if (sb.hls && sb.onError) sb.hls.off(Hls.Events.ERROR, sb.onError);
      this.video = sb.el;
      this.video2 = old;
      this.hls = sb.hls;
      this.standby = null;
      this.migrating = null;
      this.current = mig.idx;
      this.retried = false;
      this.manual = false;
      this.video.muted = wasMuted;
      $('p-unmute').classList.toggle('hidden', !wasMuted);

      const gen = ++this.generation;
      const tele = { game: String(this.event ? this.event.id : ''), server: sb.stream.server || '', cdn: sb.stream.cdn || (sb.stream.direct || sb.stream.hls), premium: !!to.premium, relay: !sb.stream.direct };
      this.teleCurrent = tele;
      this.health = { stalls: [], long: 0, errors: [] };
      const ctx = { gen, tele, t0: mig.askedAt, started: ready, stallAt: 0, fail: (why) => this.onFailure(why) };
      this.bind(this.video, ctx);
      if (this.hls) this.bindHls(this.hls, ctx);
      this.renderServers();
      this.updateHud();
      if (!ready) {
        this.everPlayed = false;
        this.status(`Connecting to ${to.name}…`, true);
        this.startTimer = setTimeout(() => ctx.fail('start timeout'), START_TIMEOUT_MS);
        return;
      }
      telemetry.push({ kind: 'start', ...tele, ttff: Math.round(performance.now() - mig.askedAt) });
      this.watchStart = Date.now();
      this.hideStatus();
      this.showHud();
      this.toast(`Switched to ${to.name} for a steadier stream`);
    },

    /** The standby did not get going: drop it and try the next candidate for the same reason. */
    standbyFailed(why) {
      const mig = this.migrating;
      if (!mig) return;
      console.warn(`[styx] standby ${this.servers[mig.idx] ? this.servers[mig.idx].name : '?'} failed: ${why}`);
      this.failed.add(mig.idx);
      this.dropStandby();
      this.migrate(mig.why);
    },

    /** Forget any migration in progress (a switch by hand or by the sweep, or closing). */
    dropStandby() {
      const sb = this.standby;
      this.migrating = null;
      if (!sb) return;
      this.standby = null;
      clearTimeout(sb.timer);
      if (sb.hls) { try { sb.hls.destroy(); } catch { /* ignore */ } }
      sb.el.onplaying = sb.el.onended = sb.el.onerror = sb.el.onloadedmetadata = null;
      try { sb.el.pause(); } catch { /* ignore */ }
      sb.el.removeAttribute('src');
      try { sb.el.load(); } catch { /* ignore */ }
    },

    /** Console: `styxPlayer.forceMigrate()` - "the stream is degraded" on demand, to watch the swap. */
    forceMigrate() {
      if (!this.everPlayed || this.migrating || this.standby) return false;
      const now = performance.now();
      while (this.health.stalls.length < DEGRADE_STALLS) this.health.stalls.push(now);
      this.checkHealth();
      return true;
    },

    toast(text) {
      const t = $('p-toast');
      if (!t) return;
      t.textContent = text;
      t.classList.remove('hidden');
      this.clearTimer('toastTimer');
      this.toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
    },

    /**
     * Fallback for servers our proxy can't reach (IP-bound CDN tokens): load the site's own
     * player in a sandboxed iframe, which runs from the viewer's own IP. Pop-ups and top-level
     * navigation are blocked by the sandbox; we keep our top bar (title/score/close) and server
     * switcher overlaid, but can't control the cross-origin video, so no pause/HUD-on-video.
     */
    enterEmbed(server, stream) {
      const gen = ++this.generation;
      this.clearTimers();
      this.stopPlayback();
      this.current = this.servers.indexOf(server);
      if (this.current < 0) this.current = 0;
      this.embedMode = true;
      this.everPlayed = true; // treat as "watching": switching away can fail over normally
      this.failed.delete(this.current);
      this.hideStatus();
      this.renderServers();
      this.updateHud();
      const frame = $('p-embed');
      // Reload even if the src is unchanged, so switching back re-mints a fresh token.
      frame.src = 'about:blank';
      requestAnimationFrame(() => { if (gen === this.generation) frame.src = stream.embed; });
      frame.classList.remove('hidden');
      $('p-embed-note').classList.remove('hidden');
      this.showHud();
      if (this.manual) store.set('server_' + this.event.id, server.name);
    },

    hideEmbed() {
      this.embedMode = false;
      const frame = $('p-embed');
      frame.classList.add('hidden');
      if (frame.src && frame.src !== 'about:blank') frame.src = 'about:blank';
      $('p-embed-note').classList.add('hidden');
    },

    firstEmbeddable() {
      if (!this.embeddable) return -1;
      if (this.embeddable[this.current]) return this.current;
      for (let i = 0; i < this.servers.length; i++) if (this.embeddable[i]) return i;
      return -1;
    },

    tryPlay() {
      const v = this.video;
      v.muted = false;
      const p = v.play();
      if (p && p.catch) {
        p.catch((err) => {
          if (err && err.name === 'NotAllowedError') {
            // Autoplay with sound was blocked (the click was too long ago): start muted.
            v.muted = true;
            v.play().catch(() => {});
            $('p-unmute').classList.remove('hidden');
          }
        });
      }
    },

    stopPlayback() {
      if (this.watchStart && this.teleCurrent) {
        const t = this.teleCurrent;
        telemetry.push({ kind: 'stop', cdn: t.cdn, premium: t.premium, relay: t.relay, duration: Date.now() - this.watchStart });
      }
      this.watchStart = 0;
      if (this.hls) { try { this.hls.destroy(); } catch { /* ignore */ } this.hls = null; }
      const v = this.video;
      v.onplaying = v.onwaiting = v.onended = v.onerror = v.onloadedmetadata = null;
      try { v.pause(); } catch { /* ignore */ }
      v.removeAttribute('src');
      try { v.load(); } catch { /* ignore */ }
    },

    onFailure(why, stream) {
      if (this.channelMode) {
        // A channel that died mid-stream gets one fresh start before we give up on it.
        const wasPlaying = this.everPlayed && this.video.currentTime > 0;
        if (wasPlaying && !this.retried) return this.tuneTo(this.current, true);
        return this.channelFailed(why);
      }
      const s = this.servers[this.current];
      console.warn('[styx] ' + (s ? s.name : '?') + ' failed: ' + why, stream && stream.log);
      this.clearTimers();
      const wasPlaying = this.everPlayed && this.video.currentTime > 0;
      if (wasPlaying && this.teleCurrent) telemetry.push({ kind: 'error', code: why, cdn: this.teleCurrent.cdn, premium: this.teleCurrent.premium, relay: this.teleCurrent.relay });
      if (this.standby && this.migrating) {
        // The degraded stream died before its replacement was ready: the replacement goes on
        // screen now (with the connecting overlay) rather than starting over on it.
        return this.swapToStandby(false);
      }
      const wasPre = s && this.pre && this.pre.has(s.pageUrl);
      if ((wasPlaying || wasPre) && !this.retried) {
        // A playing stream that died (the playlist probably expired), or one resolved while the
        // card had focus whose signed URL went stale before the click: fetch a fresh one once.
        this.retried = true;
        this.resolved.delete(s.pageUrl);
        if (wasPre) this.pre.delete(s.pageUrl);
        this.status('Reconnecting…', true);
        const gen = ++this.generation;
        this.stopPlayback();
        this.resolve(s).then((fresh) => {
          if (gen !== this.generation) return;
          if (playable(fresh)) this.play(fresh); else this.onFailure('reconnect failed');
        });
        return;
      }
      this.failed.add(this.current);
      this.everPlayed = false;
      const next = this.nextIndex(this.current);
      if (next < 0) {
        // Nothing plays cleanly. If any server has an embeddable player, use it (viewer's IP).
        const embIdx = this.firstEmbeddable();
        if (embIdx >= 0) return this.enterEmbed(this.servers[embIdx], this.embeddable[embIdx]);
        const gated = this.servers.length && [...this.failed].every((i) => {
          const r = this.resolved.get(this.servers[i].pageUrl);
          return r && r.state === 'gate';
        });
        if (gated) return this.premiumOnly();
        if (this.event) telemetry.push({ kind: 'fail', game: this.event.id, code: 'no server played' });
        return this.allFailed('None of the servers are responding right now.', true);
      }
      this.status(`${s.name} isn't responding — trying ${this.servers[next].name}`, true);
      telemetry.push({ kind: 'switch', from: s.name, to: this.servers[next].name, reason: why });
      this.renderServers();
      this.switchTo(next, false);
    },

    nextIndex(from) {
      for (let k = 1; k <= this.servers.length; k++) {
        const i = (from + k) % this.servers.length;
        if (!this.failed.has(i)) return i;
      }
      return -1;
    },

    allFailed(msg, showRetry) {
      this.clearTimers();
      this.stopPlayback();
      this.status(msg, false);
      const actions = $('p-actions');
      actions.replaceChildren();
      const btn = (label, fn, primary) => {
        const b = el('button', 'btn' + (primary ? ' primary' : ''), label);
        b.onclick = fn;
        actions.appendChild(b);
        return b;
      };
      let first = null;
      if (showRetry) first = btn('Retry', () => { this.failed.clear(); this.resolved.clear(); if (this.pre) this.pre.clear(); this.switchTo(this.current < 0 ? 0 : this.current, true); }, true);
      if (this.event && this.event.url) {
        const a = el('a', 'btn', 'Open on the site');
        a.href = this.event.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        actions.appendChild(a);
      }
      btn('Back to home', () => this.close(), !first);
      (first || actions.firstChild).focus();
    },

    status(text, spinner) {
      $('p-panel').classList.remove('hidden');
      $('p-msg').textContent = text;
      $('p-spinner').classList.toggle('hidden', !spinner);
      if (spinner) $('p-actions').replaceChildren();
      this.root.classList.remove('idle');
    },

    hideStatus() { $('p-panel').classList.add('hidden'); },

    updateHud() {
      if (!this.open) return;
      if (this.channelMode) {
        const ch = this.channels[this.current];
        const pill = $('p-pill');
        pill.textContent = 'LIVE TV';
        pill.classList.add('live');
        $('p-title').textContent = ch ? ch.n : '';
        $('p-score').textContent = this.channelGroup || '';
        return;
      }
      if (!this.event) return;
      const e = byId(this.event.id) || this.event;
      const pill = $('p-pill');
      if (e.ended) { pill.textContent = 'FINAL'; pill.classList.remove('live'); }
      else if (e.live) { pill.textContent = liveLabel(e); pill.classList.add('live'); }
      else { pill.textContent = startLabel(e.startTs); pill.classList.remove('live'); }
      $('p-title').textContent = e.away ? `${e.home} vs ${e.away}` : e.home;
      $('p-score').textContent = e.score ? e.score.replace(' - ', '–') : '';
    },

    showHud() {
      this.root.classList.remove('idle');
      this.clearTimer('hudTimer');
      // Pointer events over the embedded (cross-origin) player never reach us, so an auto-hidden
      // HUD could not be brought back with the mouse. Keep it visible in embed mode.
      if (this.embedMode) return;
      this.hudTimer = setTimeout(() => {
        if ($('p-panel').classList.contains('hidden')) this.root.classList.add('idle');
      }, HUD_HIDE_MS);
    },

    togglePause() {
      if (this.embedMode) { this.showHud(); return; } // can't reach into the cross-origin player
      const v = this.video;
      if (v.paused) { v.play().catch(() => {}); this.hideStatus(); }
      else { v.pause(); this.status('Paused', false); }
      this.showHud();
    },

    manualSwitch(delta) {
      if (this.channelMode) { if (this.channels.length > 1) this.tuneTo(this.current + delta); return; }
      if (this.servers.length < 2) { this.status('This game has only one server', false); setTimeout(() => this.everPlayed && this.hideStatus(), 1500); return; }
      this.failed.clear();
      const from = this.servers[this.current], to = this.servers[(this.current + delta + this.servers.length) % this.servers.length];
      telemetry.push({ kind: 'switch', from: from ? from.name : '', to: to ? to.name : '', reason: 'manual' });
      this.switchTo(this.current + delta, true);
    },

    onKey(ev) {
      const panelButtons = !$('p-panel').classList.contains('hidden') && $('p-actions').children.length;
      switch (ev.key) {
        case 'Escape': case 'Backspace': case 'MediaStop': ev.preventDefault(); this.close(); return;
        case 'ArrowLeft': case 'MediaTrackPrevious': ev.preventDefault(); this.manualSwitch(-1); return;
        case 'ArrowRight': case 'MediaTrackNext': ev.preventDefault(); this.manualSwitch(1); return;
        case ' ': case 'MediaPlayPause': case 'k':
          if (panelButtons) return;
          ev.preventDefault(); this.togglePause(); return;
        case 'Enter':
          if (panelButtons || document.activeElement.tagName === 'BUTTON' || document.activeElement.tagName === 'A') return;
          ev.preventDefault(); this.togglePause(); return;
        case 'MediaPlay': if (!this.embedMode) this.video.play().catch(() => {}); return;
        case 'MediaPause': if (!this.embedMode) this.video.pause(); return;
        case 'ArrowUp': case 'ArrowDown': case 'i': ev.preventDefault(); this.root.classList.contains('idle') ? this.showHud() : this.root.classList.add('idle'); return;
        case 'f': ev.preventDefault(); this.toggleFullscreen(); return;
        case 'm': this.video.muted = !this.video.muted; $('p-unmute').classList.toggle('hidden', !this.video.muted); return;
        case 'r': this.channelMode ? this.tuneTo(this.current) : this.switchTo(this.current, true); return;
        default:
      }
    },

    toggleFullscreen() {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else if (this.root.requestFullscreen) this.root.requestFullscreen().catch(() => {});
      else if (this.video.webkitEnterFullscreen) this.video.webkitEnterFullscreen();
    },

    clearTimer(name) { if (this[name]) { clearTimeout(this[name]); this[name] = null; } },
    clearTimers() { for (const t of ['hudTimer', 'stallTimer', 'startTimer', 'impatience']) this.clearTimer(t); },
  };

  function playable(stream) {
    // A premium-CDN stream comes with `direct` only: the Worker never proxies that CDN.
    return !!(stream && (stream.hls || stream.direct) && stream.playable !== false);
  }

  /**
   * Fetches a direct-only playlist once from this browser, the way hls.js will, and fills in
   * what the Worker could not: `playable` (the CDN answered with a playlist), `warming` (its
   * only segment is the CDN's warming.ts placeholder - the channel is still spinning up, try
   * another server), `cdnStatus`. A CDN this network refuses shows up as status 0.
   */
  async function checkDirect(stream) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 10_000);
      const r = await fetch(stream.direct, { cache: 'no-store', signal: ctl.signal });
      clearTimeout(t);
      const text = (await r.text()).slice(0, 4096);
      stream.cdnStatus = r.status;
      stream.warming = /warming\.ts/i.test(text);
      stream.playable = r.ok && text.trimStart().startsWith('#EXTM3U') && !stream.warming;
    } catch (e) {
      stream.cdnStatus = 0;
      stream.playable = false;
      stream.error = e.message;
    }
    return stream;
  }

  /**
   * Zero-wait start (4.0 phase 2.1, see Prefetch.java): resolve a game's stream while its card
   * has focus (or the mouse rests on it) so opening it plays instead of spinning. After 600 ms
   * the server tabs and the best free server are resolved; after 2 s, when this browser can
   * play premium tabs and the `prewarm` flag is on, a *pre-warm* pool lease is taken
   * (`acquire { prewarm: true }`: granted only while two slots stay free, dropped by the Worker
   * after 60 s unless the player converts it) and the first named premium tab is resolved too.
   * The player's own acquire for the same game converts the pre-warm (same client id), so a
   * hand-off must never be followed by a release. Results older than 90 s are not trusted.
   */
  const prefetch = {
    FREE_MS: 600, PREMIUM_MS: 2_000, TTL_MS: 90_000,
    GENERIC: /^server\s*\d+$/i,
    entries: new Map(), wanted: '', timers: [], prewarmFor: null, handedOff: '',

    entry(id) {
      let en = this.entries.get(id);
      if (en && performance.now() - en.at > this.TTL_MS) { this.entries.delete(id); en = null; }
      if (!en) {
        en = { id, page: null, streams: new Map(), at: performance.now(), premiumTried: false };
        this.entries.set(id, en);
        while (this.entries.size > 8) this.entries.delete(this.entries.keys().next().value);
      }
      return en;
    },
    fresh(id) {
      const en = this.entries.get(id);
      return en && performance.now() - en.at <= this.TTL_MS ? en : null;
    },

    /** A card gained focus / the pointer rests on it. */
    focus(e) {
      this.blur();
      if (!e || !e.url || e.ended || player.open) return;
      this.wanted = e.id;
      this.handedOff = '';
      if (this.prewarmFor && this.prewarmFor !== e.id) this.release();
      this.timers = [
        setTimeout(() => this.warm(e, false), this.FREE_MS),
        setTimeout(() => this.warm(e, true), this.PREMIUM_MS),
      ];
    },
    blur() {
      this.wanted = '';
      for (const t of this.timers) clearTimeout(t);
      this.timers = [];
    },
    /** The player is opening this game: its acquire takes over any pre-warm lease. */
    handOff(id) {
      this.handedOff = id;
      if (this.prewarmFor === id) this.prewarmFor = null;
    },
    /** Gives a pre-warm lease back (left the page or moved to another game before playing). */
    release() {
      if (!this.prewarmFor) return;
      this.prewarmFor = null;
      fetch('/api/pool/release', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: clientId() }), cache: 'no-store', keepalive: true,
      }).catch(() => {});
    },

    async warm(e, premium) {
      if (this.wanted !== e.id) return;
      try {
        const en = this.entry(e.id);
        if (!en.page) {
          en.page = await api('/api/stream?only=servers&pre=1&page=' + encodeURIComponent(e.url));
          if (this.wanted !== e.id) return;
        }
        if (!e.live) return; // tabs known; no stream worth a slot or an embed chain yet
        const all = en.page.servers || [];
        const own = usesOwnAccount();
        const poolOk = !account.signedIn && pool.shared && pool.sharedPremium !== false;
        const canPremium = own || poolOk;
        const named = all.filter((s) => s.premium && !this.GENERIC.test(s.name));
        const remembered = store.get('server_' + e.id, null);
        let pick = null;
        let slot = '';
        if (!premium) {
          // A browser that will start on a premium tab gains nothing from a free resolve.
          if (canPremium && named.length) return;
          const free = all.filter((s) => !s.premium);
          pick = free.find((s) => s.name === remembered) || (all[en.page.activeIndex] && !all[en.page.activeIndex].premium ? all[en.page.activeIndex] : null) || free[0] || null;
        } else {
          if (en.premiumTried || !canPremium || !flags.on('prewarm', true)) return;
          pick = named.find((s) => s.name === remembered) || named[0] || null;
          if (!pick) return;
          en.premiumTried = true;
          if (pool.shared) {
            const r = await api('/api/pool/acquire', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: clientId(), kind: 'game', label: (e.away ? `${e.home} vs ${e.away}` : e.home).slice(0, 80), platform: 'web', prewarm: true }),
            });
            if (r.used != null) pool.used = r.used;
            if (!r.granted) { console.info(`[styx] no pre-warm for ${e.id} (${r.used}/${r.max})`); return; }
            if (this.handedOff === e.id) return; // opened while the pool answered: the player owns the slot
            this.prewarmFor = e.id;
            if (this.wanted !== e.id) return this.release(); // moved on while the pool answered
            slot = '&slot=' + encodeURIComponent(clientId());
          } else if (!own) {
            return;
          }
        }
        if (!pick || en.streams.has(pick.pageUrl)) return;
        const t0 = performance.now();
        const data = await api('/api/stream?pre=1&server=' + encodeURIComponent(pick.pageUrl) + '&name=' + encodeURIComponent(pick.name) + (pick.premium ? '&premium=1' : '') + slot);
        const stream = data.stream || null;
        if (stream && stream.ownAddressOnly && stream.direct) await checkDirect(stream);
        if (playable(stream)) {
          en.streams.set(pick.pageUrl, stream);
          console.info(`[styx] ${e.id}: ${pick.name}${pick.premium ? ' (premium)' : ''} ready ahead in ${Math.round(performance.now() - t0)} ms`);
        } else {
          console.info(`[styx] ${e.id}: ${pick.name} not playable ahead`, stream && (stream.state || stream.error));
          if (premium && this.prewarmFor === e.id) this.release(); // nothing to hold the slot for
        }
      } catch (err) {
        console.warn(`[styx] prefetch ${e.id} failed: ${err.message}`);
      }
    },
  };
  // Leaving the page (or backgrounding the tab) before a game opened: the slot goes back now.
  document.addEventListener('visibilitychange', () => { if (document.hidden && !player.open) prefetch.release(); });
  window.addEventListener('pagehide', () => { if (!player.open) prefetch.release(); });

  // Player UI wiring.
  $('p-close').onclick = () => player.close();
  $('p-cast').onclick = (ev) => {
    const e = player.event;
    if (!e) return;
    if (isPhone()) return showPhoneCastSheet(e, ev.currentTarget);
    const menu = $('menu');
    floatingMenu(menu);
    menu.replaceChildren();
    addCastItems(menu, e);
    menu.classList.remove('hidden');
    const r = ev.currentTarget.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = (r.bottom + 6) + 'px';
  };
  $('p-fs').onclick = () => player.toggleFullscreen();
  $('p-unmute').onclick = () => { player.video.muted = false; $('p-unmute').classList.add('hidden'); };
  // On a touch screen the first tap on a hidden HUD only brings it back; a mouse click always
  // toggles pause (the HUD reappears on any pointer movement there anyway).
  let tapRevealedHud = false;
  player.video.onclick = () => {
    if (tapRevealedHud) { tapRevealedHud = false; return; }
    if ($('p-panel').classList.contains('hidden')) player.togglePause();
  };
  player.video.ondblclick = () => player.toggleFullscreen();
  player.root.addEventListener('pointermove', () => player.showHud());
  player.root.addEventListener('pointerdown', (ev) => {
    tapRevealedHud = ev.pointerType === 'touch' && player.root.classList.contains('idle');
    player.showHud();
  });
  // Overlays push a history entry so the TV/phone Back button closes them. When we close one
  // ourselves we pop that entry, and must not treat the resulting popstate as another Back.
  let ownPops = 0;
  let ownPopsReset = null;
  function popOwnEntry() {
    ownPops++;
    history.back();
    // The browser may drop a programmatic back(); do not let that swallow a real Back later.
    clearTimeout(ownPopsReset);
    ownPopsReset = setTimeout(() => { ownPops = 0; }, 1500);
  }
  window.addEventListener('popstate', () => {
    if (ownPops > 0) { ownPops--; return; }
    // Phones: Back closes the top sheet first (it may sit over the player).
    if (sheetEntry) { if ($('menu').classList.contains('hidden')) sheetEntry = false; else hideMenu(true); return; }
    if (acct.entry) { acct.close(true); return; }
    if (player.open) player.close(true);
    else if (liveTv.isOpen()) liveTv.close(true);
  });

  function openEvent(e) {
    if (!e.url) return;
    recents.record(e);
    prefetch.blur();
    prefetch.handOff(e.id); // the player's own acquire takes over any pre-warm lease
    player.openFor(e);
  }

  // ---------------------------------------------------------------------------------------------
  // Premium account (AccountActivity.java): the site's TV sign-in flow
  // ---------------------------------------------------------------------------------------------

  const POLL_MS = 3000;

  const acct = {
    root: $('acct'), code: null, pollTimer: null, tickTimer: null, busy: false,
    /** Phones: the sheet has a history entry (Back closes it). */
    entry: false,

    isOpen() { return !this.root.classList.contains('hidden'); },

    open() {
      const was = this.isOpen();
      this.root.classList.remove('hidden');
      this.render();
      if (!account.signedIn) this.getCode();
      if (isPhone()) {
        hideToast();
        if (!was && !this.entry) { this.entry = true; history.pushState({ acct: true }, ''); }
      }
    },

    close(fromHistory) {
      this.stop();
      this.root.classList.add('hidden');
      if (this.entry) {
        this.entry = false;
        if (fromHistory !== true && history.state && history.state.acct) popOwnEntry();
      }
      $('account').focus();
    },

    stop() {
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
      if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    },

    render() {
      const body = $('acct-body');
      const actions = $('acct-actions');
      body.replaceChildren();
      actions.replaceChildren();
      const btn = (label, fn, primary) => {
        const b = el('button', 'btn' + (primary ? ' primary' : ''), label);
        b.onclick = fn;
        actions.appendChild(b);
        return b;
      };
      // Phones: status lines in the sheet's icon-row style (the phone's SVG icons, not ✓ / 📺 glyphs).
      const phone = isPhone();
      const iconLine = (markup, cls, text) => this.iconLine(markup, cls, text);
      if (account.signedIn) {
        $('acct-title').textContent = 'Premium account';
        body.appendChild(el('p', 'acct-lead', 'You are signed in to StreamEast. Games open on this account’s premium servers first and fall back to the free ones.'));
        if (phone) {
          body.appendChild(account.premium === true ? iconLine(I.check, 'ok', 'Premium servers are unlocked on this account.')
            : account.premium === false ? iconLine(I.info, null, 'This account does not seem to have premium: its premium servers were locked. Free servers are used instead.')
              : iconLine(I.info, null, 'Premium status is checked the first time you open a game.'));
          body.appendChild(iconLine(I.tv, account.iptv ? 'ok' : null, account.iptv
            ? 'Live TV: this account’s channel list opens from the Live TV chip.'
            : 'This account has no Live TV playlist.'));
          this.reAddTip(body);
          btn('Sign out', () => this.signOut());
          btn('Close', () => this.close(), true).focus();
          return;
        }
        const prem = account.premium === true ? '✓  Premium servers are unlocked on this account.'
          : account.premium === false ? 'This account does not seem to have premium: its premium servers were locked. Free servers are used instead.'
            : 'Premium status is checked the first time you open a game.';
        body.appendChild(el('p', 'acct-line' + (account.premium === true ? ' ok' : ''), prem));
        body.appendChild(el('p', 'acct-line', account.iptv
          ? '📺  Live TV: this account’s channel list is available from the home screen.'
          : 'This account has no Live TV playlist.'));
        btn('Sign out', () => this.signOut());
        btn('Close', () => this.close(), true).focus();
        return;
      }
      $('acct-title').textContent = 'Sign in to your premium account';
      if (pool.shared && pool.sharedPremium !== false) body.appendChild(this.sharedLine(phone));
      body.appendChild(el('p', 'acct-lead', 'Sign in to your StreamEast account and Styx Sports will use its premium servers automatically. Without an account it keeps using the free ones.'));
      const steps = el('ol', 'acct-steps');
      const link = el('a', null, 'auth.streamea.st/activate');
      link.id = 'acct-link';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const s1 = el('li');
      // The QR code is hidden on phones (they *are* the phone), so the words about it go too.
      s1.append(el('span', 'phone-hide', 'On your phone (or in a new tab), go to '), el('span', 'phone-only', 'Open '),
        link, el('span', 'phone-hide', ' — or scan the code.'), el('span', 'phone-only', '.'));
      steps.append(s1, el('li', null, 'Sign in to your StreamEast account.'), el('li', null, 'Under QR Sign In, enter the code shown here.'));
      body.appendChild(steps);
      const row = el('div', 'acct-row');
      const codeBox = el('div', 'acct-codebox');
      codeBox.append(el('div', 'acct-your', 'Your code'), el('div', 'acct-code', '--- ---'), el('div', 'acct-expires', ''));
      codeBox.lastChild.id = 'acct-expires';
      codeBox.children[1].id = 'acct-code';
      const qr = el('img', 'acct-qr');
      qr.id = 'acct-qr';
      qr.alt = 'QR code for the sign-in page';
      qr.referrerPolicy = 'no-referrer';
      row.append(codeBox, qr);
      body.appendChild(row);
      body.appendChild(el('p', 'acct-status', 'Getting your code…')).id = 'acct-status';
      if (phone) this.reAddTip(body);
      btn('Get new code', () => this.getCode());
      btn('Cancel', () => this.close(), true);
    },

    iconLine(markup, cls, text) {
      const p = el('p', 'acct-line ic' + (cls ? ' ' + cls : ''));
      const ic = el('span', 'acct-ic');
      ic.appendChild(icon(markup));
      p.append(ic, el('span', null, text));
      return p;
    },

    /** Signed out while the shared premium account is on: the line that says so. */
    sharedLine(phone) {
      const text = `Shared premium is already active for everyone: ${pool.used} of ${pool.max} connections in use. Sign in here to use your own account instead — or to share it on the stats page and add 5 more connections for everyone.`;
      const p = phone ? this.iconLine(I.star, 'ok gold', text) : el('p', 'acct-line ok', '★  ' + text);
      p.classList.add('acct-shared');
      return p;
    },

    waitingText() { return isPhone() ? 'Waiting for you to enter the code…' : 'Waiting for you to enter the code on your phone…'; },

    /**
     * The layout flipped (a phone turned, a window crossed 600px) with the dialog open: its
     * layout-dependent parts are rebuilt in the new layout's style (the phone's icon rows are sized
     * only by the phone styles). Signed out, only those parts are swapped, so the code stays up.
     */
    relayout() {
      if (!this.isOpen()) return;
      // Opened sideways (no entry there) and now the phone sheet: Back closes it, as when opened here.
      if (isPhone() && !this.entry) { this.entry = true; history.pushState({ acct: true }, ''); }
      if (account.signedIn) { this.render(); return; }
      const body = $('acct-body');
      const shared = body.querySelector('.acct-shared');
      if (shared) shared.replaceWith(this.sharedLine(isPhone()));
      const tip = body.querySelector('.acct-tip');
      if (tip) tip.remove();
      if (isPhone()) this.reAddTip(body);
      const st = $('acct-status');
      if (st && !st.classList.contains('error') && /^Waiting for you to enter the code/.test(st.textContent)) this.setStatus(this.waitingText());
    },

    /**
     * An iPhone install from before the opaque status bar keeps a blurred band over the header
     * (iOS reads the bar style only when the app is added). Re-adding fixes it but wipes the app's
     * storage, so it is only explained here, on request - never pushed as a prompt.
     */
    reAddTip(body) {
      if (!pwa.oldInstall()) return;
      body.appendChild(el('p', 'acct-tip', 'Header blurred under the clock? Remove Styx Sports from your Home Screen and add it again from Safari. You will need to sign in and pair your TV again.'));
    },

    setStatus(text, error) {
      const s = $('acct-status');
      if (!s) return;
      s.textContent = text;
      s.classList.toggle('error', !!error);
    },

    async getCode() {
      if (this.busy) return;
      this.busy = true;
      this.stop();
      this.code = null;
      this.setStatus('Getting your code…');
      const codeEl = $('acct-code');
      if (codeEl) codeEl.textContent = '--- ---';
      try {
        const c = await api('/api/account/code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: store.get('device_id', '') }),
        });
        if (!this.isOpen() || account.signedIn) return;
        this.code = c;
        store.set('device_id', c.deviceId);
        $('acct-code').textContent = c.display;
        const link = $('acct-link');
        link.href = c.activateUrl;
        link.textContent = c.activateDisplay;
        $('acct-qr').src = 'https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=0&color=f5f5f5&bgcolor=171717&data=' + encodeURIComponent(c.activateUrl);
        this.setStatus(this.waitingText());
        this.tick();
        this.tickTimer = setInterval(() => this.tick(), 1000);
        this.pollTimer = setInterval(() => this.poll(), POLL_MS);
      } catch (e) {
        this.setStatus('Something went wrong: ' + e.message, true);
      } finally {
        this.busy = false;
      }
    },

    tick() {
      if (!this.code) return;
      const left = Math.max(0, this.code.expiresAt - Math.floor(Date.now() / 1000));
      const ex = $('acct-expires');
      if (ex) ex.textContent = `Code expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      if (left <= 0) {
        this.stop();
        this.setStatus('That code expired. Get a new one to try again.', true);
      }
    },

    async poll() {
      if (!this.code || !this.isOpen()) return this.stop();
      let d;
      try {
        d = await api(`/api/account/poll?code=${encodeURIComponent(this.code.code)}&device_id=${encodeURIComponent(this.code.deviceId)}`);
      } catch (e) {
        this.setStatus('Still waiting… (' + e.message + ')');
        return;
      }
      if (!this.isOpen()) return this.stop();
      switch (d.status) {
        case 'approved':
          this.stop();
          this.setStatus('Signing in…');
          setAccount(d.account);
          this.render();
          $('status').textContent = 'Signed in. Premium servers will be used when available.';
          if (account.iptv) liveTv.data = null;
          return;
        case 'pending':
          return;
        case 'expired':
          this.stop();
          this.setStatus('That code expired. Get a new one to try again.', true);
          return;
        case 'used':
          this.stop();
          this.setStatus('That code was already used. Get a new one to try again.', true);
          return;
        default:
          this.stop();
          this.setStatus('The account service did not accept that code (' + d.status + '). Get a new one to try again.', true);
      }
    },

    async signOut() {
      const actions = $('acct-actions');
      for (const b of actions.children) b.disabled = true;
      try {
        await api('/api/account/logout', { method: 'POST' });
      } catch { /* the cookie is gone either way */ }
      liveTv.data = null;
      setAccount({ signedIn: false, premium: null, iptv: false });
      $('status').textContent = 'Signed out.';
      this.close();
    },
  };

  function renderAccountButton() {
    const b = $('account');
    if (!account.signedIn && pool.shared && pool.sharedPremium !== false) {
      // Phones: the long label collides with the centred wordmark at 375px (the title keeps it).
      b.textContent = isPhone() ? `★ ${pool.used}/${pool.max}` : `★ Premium ${pool.used}/${pool.max}`;
      b.classList.add('premium');
      b.title = 'Shared premium account: connections in use. Click to sign in with your own account instead.';
      return;
    }
    if (!account.signedIn) { b.textContent = 'Sign in'; b.classList.remove('premium'); b.title = 'Sign in to your premium account'; return; }
    if (account.premium === false) { b.textContent = 'Signed in'; b.classList.remove('premium'); b.title = 'Signed in (no premium on this account)'; return; }
    // Phones: the word in its own span, so a 320px screen can show the gold star alone (CSS).
    if (isPhone()) b.replaceChildren('★', el('span', 'acct-word', ' Premium'));
    else b.textContent = '★ Premium';
    b.classList.add('premium');
    b.title = 'Signed in to your premium account';
  }

  $('account').onclick = () => acct.open();
  $('acct-close').onclick = () => acct.close();
  // A tap on the backdrop closes the dialog on `click`, not pointerdown: the backdrop is still there
  // to take that click, so it never lands on the chip or game under it (phones show live content
  // above the sheet). Only a press that also started on the backdrop counts.
  // TV layouts with a mouse (or pen) still close on the press, as they always have: its click never
  // reaches the page, and the press itself leaves the focus on the page, not on Sign in, so the arrow
  // keys go straight back into the rows. A touch there closes on the click and ends the same way.
  let acctDownOnBackdrop = false;
  $('acct').addEventListener('pointerdown', (ev) => {
    acctDownOnBackdrop = ev.target === $('acct');
    if (acctDownOnBackdrop && !isPhone() && ev.pointerType !== 'touch') { acctDownOnBackdrop = false; acct.close(); }
  });
  $('acct').addEventListener('click', (ev) => {
    if (ev.target === $('acct') && acctDownOnBackdrop) {
      acct.close();
      if (!isPhone() && document.activeElement === $('account')) $('account').blur();
    }
    acctDownOnBackdrop = false;
  });

  // ---------------------------------------------------------------------------------------------
  // Live TV (LiveTvActivity.java): the premium account's IPTV channel list
  // ---------------------------------------------------------------------------------------------

  const IPTV_RECENT_MAX = 24;
  const RECENT_GROUP = '★ Recently watched';
  const SEARCH_MAX = 400;

  const liveTv = {
    root: $('livetv'), data: null, loading: null, group: null, query: '', focusedChannel: -1,

    isOpen() { return !this.root.classList.contains('hidden'); },

    /** Phones title it with the line TV icon; elsewhere the original "📺 Live TV" (also on a turn: phoneMq). */
    syncTitle() {
      const title = this.root.querySelector('.lt-title');
      if (title && title._phone !== isPhone()) {
        title._phone = isPhone();
        title.replaceChildren(...(title._phone ? [icon(I.tv), 'Live TV'] : ['📺 Live TV']));
      }
    },

    async open() {
      this.syncTitle();
      this.root.classList.remove('hidden');
      document.body.style.overflow = 'hidden';
      history.pushState({ livetv: true }, '');
      $('lt-search').value = this.query;
      if (pool.shared) {
        const got = await player.takeSlot('tv', 'Live TV');
        if (!got) {
          this.message(`All ${pool.max} shared premium connections are in use.\nLive TV counts toward the same connections as games.`, false);
          return;
        }
      }
      if (!this.data) await this.load(false);
      else this.render();
    },

    close(fromHistory) {
      if (!this.isOpen()) return;
      this.root.classList.add('hidden');
      document.body.style.overflow = '';
      if (!fromHistory && history.state && history.state.livetv) popOwnEntry();
      if (!player.open) player.dropSlot();
      const chip = document.querySelector('.chip.livetv');
      if (chip) chip.focus();
    },

    async load(refresh) {
      if (this.loading) return this.loading;
      this.message('Loading channels…', true);
      $('lt-groups').replaceChildren();
      $('lt-channels').replaceChildren();
      this.loading = (async () => {
        try {
          const q = [refresh ? 'refresh=1' : '', player.slot ? 'slot=' + encodeURIComponent(player.slot) : ''].filter(Boolean).join('&');
          this.data = await api('/api/iptv' + (q ? '?' + q : ''));
          this.message(null);
          if (!this.group || !this.groups().some((g) => g.n === this.group)) this.group = this.groups()[0] ? this.groups()[0].n : null;
          this.render();
        } catch (e) {
          this.message('Could not load the channel list.\n' + e.message, false);
        } finally {
          this.loading = null;
        }
      })();
      return this.loading;
    },

    message(text, spinner) {
      const m = $('lt-msg');
      if (!text) { m.classList.add('hidden'); return; }
      m.classList.remove('hidden');
      m.replaceChildren();
      if (spinner) m.appendChild(el('div', 'spinner'));
      m.appendChild(el('div', 'overlay-msg', text));
      if (!spinner) {
        const b = el('button', 'btn primary', 'Retry');
        b.onclick = () => this.load(true);
        m.appendChild(b);
      }
    },

    recents() { return store.get('iptv_recent', []); },

    recordRecent(ch) {
      const list = this.recents().filter((c) => c.u !== ch.u);
      list.unshift({ n: ch.n, l: ch.l, u: ch.u });
      store.set('iptv_recent', list.slice(0, IPTV_RECENT_MAX));
    },

    /** Recently watched (when any) first, then the playlist's groups, sports first (as served). */
    groups() {
      if (!this.data) return [];
      const recent = this.recents();
      return recent.length ? [{ n: RECENT_GROUP, c: recent }].concat(this.data.groups) : this.data.groups;
    },

    channelsToShow() {
      const q = this.query.trim().toLowerCase();
      if (q) {
        const out = [];
        for (const g of this.data.groups) {
          for (const c of g.c) {
            if (c.n.toLowerCase().includes(q)) { out.push({ ...c, g: g.n }); if (out.length >= SEARCH_MAX) return { list: out, title: `Search: ${this.query.trim()}`, capped: true }; }
          }
        }
        return { list: out, title: `Search: ${this.query.trim()}` };
      }
      const g = this.groups().find((x) => x.n === this.group) || this.groups()[0];
      return { list: g ? g.c : [], title: g ? g.n : '' };
    },

    render() {
      if (!this.data) return;
      const groups = $('lt-groups');
      groups.replaceChildren();
      const searching = !!this.query.trim();
      for (const g of this.groups()) {
        const b = el('button', 'lt-group' + (!searching && g.n === this.group ? ' selected' : ''));
        b.append(el('span', 'lt-group-name', g.n), el('span', 'lt-group-n', String(g.c.length)));
        b.onclick = () => { this.group = g.n; this.query = ''; $('lt-search').value = ''; this.render(); };
        groups.appendChild(b);
      }
      const { list, title, capped } = this.channelsToShow();
      $('lt-sub').textContent = `${title} · ${list.length}${capped ? '+' : ''} channel${list.length === 1 ? '' : 's'} · ${this.data.count.toLocaleString()} total`;
      const grid = $('lt-channels');
      grid.replaceChildren();
      if (!list.length) {
        grid.appendChild(el('div', 'empty', searching ? 'No channel matches that.' : 'No channels in this group.'));
        return;
      }
      list.forEach((c, i) => {
        const cell = el('button', 'lt-channel');
        cell.type = 'button';
        const logo = el('img', 'lt-logo');
        logo.alt = '';
        logo.loading = 'lazy';
        logo.referrerPolicy = 'no-referrer';
        if (c.l && /^https:/i.test(c.l)) {
          logo.src = c.l;
          logo.onerror = () => { logo.removeAttribute('src'); logo.classList.add('placeholder'); };
        } else {
          logo.classList.add('placeholder');
        }
        cell.append(logo, el('div', 'lt-name', c.n));
        if (c.g) cell.appendChild(el('div', 'lt-cgroup', c.g));
        cell.onclick = () => { this.focusedChannel = i; player.openChannel(list, i, title); };
        cell.addEventListener('focus', () => { this.focusedChannel = i; });
        grid.appendChild(cell);
      });
      const sel = groups.querySelector('.selected');
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    },

    focusCurrent() {
      const cells = $('lt-channels').children;
      const i = player.current >= 0 && player.current < cells.length ? player.current : this.focusedChannel;
      const c = cells[i] || cells[0];
      if (c && c.focus) c.focus();
    },

    /** D-pad in the channel grid: ◀ ▶ by one, ▲ ▼ by a row, ◀ from the first column into the groups. */
    onKey(ev) {
      const a = document.activeElement;
      if (ev.key === 'Escape') { ev.preventDefault(); this.close(); return; }
      if (a === $('lt-search')) {
        if (ev.key === 'ArrowDown' || ev.key === 'Enter') { ev.preventDefault(); const c = $('lt-channels').querySelector('.lt-channel'); if (c) c.focus(); }
        return;
      }
      if (a && a.classList.contains('lt-group')) {
        if (ev.key === 'ArrowUp' && a.previousElementSibling) { ev.preventDefault(); a.previousElementSibling.focus(); }
        else if (ev.key === 'ArrowDown' && a.nextElementSibling) { ev.preventDefault(); a.nextElementSibling.focus(); }
        else if (ev.key === 'ArrowRight' || ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); a.click(); const c = $('lt-channels').querySelector('.lt-channel'); if (ev.key === 'ArrowRight' && c) c.focus(); }
        return;
      }
      if (a && a.classList.contains('lt-channel')) {
        const cells = [...$('lt-channels').children];
        const i = cells.indexOf(a);
        const cols = Math.max(1, Math.round($('lt-channels').clientWidth / (a.offsetWidth + 12)));
        let t = null;
        switch (ev.key) {
          case 'ArrowLeft': if (i % cols === 0) { t = $('lt-groups').querySelector('.selected') || $('lt-groups').firstElementChild; } else t = cells[i - 1]; break;
          case 'ArrowRight': t = cells[i + 1] || a; break;
          case 'ArrowUp': t = i - cols >= 0 ? cells[i - cols] : $('lt-search'); break;
          case 'ArrowDown': t = cells[Math.min(cells.length - 1, i + cols)]; break;
          case 'Enter': case ' ': ev.preventDefault(); a.click(); return;
          default: return;
        }
        ev.preventDefault();
        if (t) t.focus();
        return;
      }
      if (ev.key.startsWith('Arrow')) {
        ev.preventDefault();
        const c = $('lt-channels').querySelector('.lt-channel') || $('lt-groups').firstElementChild;
        if (c) c.focus();
      }
    },
  };

  $('lt-close').onclick = () => liveTv.close();
  $('lt-refresh').onclick = () => liveTv.load(true);
  $('lt-search').addEventListener('input', (ev) => { liveTv.query = ev.target.value; liveTv.render(); });

  // ---------------------------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------------------------

  $('refresh').onclick = () => loadSchedule(true);
  $('overlay-retry').onclick = () => {
    $('overlay-retry').classList.add('hidden');
    document.querySelector('#overlay .spinner').classList.remove('hidden');
    $('overlay-msg').textContent = 'Loading events…';
    loadSchedule(false);
  };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { loadSchedule(false); refreshStatus(); loadAccount(); ping(); }
  });

  // Anonymous "I'm open" ping so /stats can show who is watching (clientId is defined up top).
  const PING_MS = 60_000;
  function ping() {
    if (document.hidden) return;
    fetch('/api/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: clientId(), platform: 'web', device: deviceHint() }),
      cache: 'no-store',
      keepalive: true,
    }).catch(() => {});
  }
  // The Worker names browsers from the User-Agent for /stats. Safari on iPad calls itself a
  // Mac; only the touch screen tells them apart, so that one case is decided here.
  function deviceHint() {
    if (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1) return 'iPad · Safari';
    return undefined;
  }
  ping();
  setInterval(ping, PING_MS);
  setInterval(() => telemetry.flush(), TELEMETRY_MS);
  window.addEventListener('pagehide', () => telemetry.flush(true));

  flags.load();
  setInterval(() => { if (!document.hidden) flags.load(); }, FLAGS_MS);
  cast.refresh();

  // Installable app (4.0 phase 4.2): a service worker for an instant start (sw.js), and on a
  // phone's second visit a one-time hint to put it on the home screen.
  const pwa = {
    deferred: null,
    standalone() { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; },
    ios() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1); },
    start() {
      if ('serviceWorker' in navigator) {
        if (flags.on('pwa', true)) navigator.serviceWorker.register('/sw.js').catch(() => {});
        else navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
      }
      addEventListener('beforeinstallprompt', (ev) => { ev.preventDefault(); this.deferred = ev; this.maybeHint(); });
      addEventListener('appinstalled', () => this.done());
      store.set('visits', store.get('visits', 0) + 1);
      this.maybeHint();
    },
    maybeHint() {
      if (this.standalone() || store.get('install_hint_done', false) || store.get('visits', 0) < 2) return;
      if (!matchMedia('(pointer: coarse)').matches || !flags.on('pwa', true)) return;
      const ios = this.ios();
      if (!ios && !this.deferred) return; // elsewhere only once the browser says it can install
      this.hintText();
      $('install-go').classList.toggle('hidden', ios);
      $('install-hint').classList.remove('hidden');
    },
    /** The hint's words for the current layout (run again when the phone turns: phoneMq). */
    hintText() {
      const ios = this.ios();
      if (isPhone()) {
        // Two short lines: a title, then where to tap (the iOS Share icon drawn, not a ⎙ glyph).
        const how = el('span', 'hint-how');
        if (ios) {
          const sh = icon(I.share);
          sh.setAttribute('class', 'ios-share');
          how.append('Tap ', sh, ' then Add to Home Screen');
        } else how.append('Opens like an app from your home screen');
        $('install-text').replaceChildren(el('b', null, ios ? 'Get the Styx Sports app' : 'Install Styx Sports'), how);
      } else {
        $('install-text').textContent = ios
          ? 'Put Styx Sports on your Home Screen: tap Share ⎙, then “Add to Home Screen”.'
          : 'Install Styx Sports as an app on this phone.';
      }
    },
    /**
     * An install from before the opaque status bar (black-translucent: iOS reads it only when the
     * app is added) - its header sits under a blurred band. Shown as a tip in the account sheet.
     */
    oldInstall() {
      if (!this.standalone() || !this.ios() || !isPhone() || innerHeight <= innerWidth) return false;
      const probe = el('div');
      probe.style.cssText = 'position:absolute;visibility:hidden;padding-top:env(safe-area-inset-top,0px)';
      document.body.appendChild(probe);
      const insetTop = parseFloat(getComputedStyle(probe).paddingTop) || 0;
      probe.remove();
      return insetTop > 0;
    },
    done() { store.set('install_hint_done', true); $('install-hint').classList.add('hidden'); },
  };
  // Phones lift the toast above the hint by the hint's real height (2 to 4 lines, by width and copy).
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => document.documentElement.style.setProperty('--hint-h', $('install-hint').offsetHeight + 'px')).observe($('install-hint'));
  }
  $('install-x').onclick = () => pwa.done();
  $('install-go').onclick = async () => {
    const d = pwa.deferred;
    pwa.done();
    if (d) { d.prompt(); try { await d.userChoice; } catch { /* dismissed */ } }
  };
  pwa.start();
  // Free the shared premium slot the moment the tab goes away (the lease would expire anyway).
  window.addEventListener('pagehide', () => player.dropSlot());

  renderAccountButton();
  loadAccount();

  // Paint the last saved schedule at once; the fresh one replaces it when it arrives.
  const saved = store.get(SNAPSHOT_KEY, null);
  if (saved && Array.isArray(saved.events) && Array.isArray(saved.categories) && saved.events.length) {
    snapshot = saved;
    snapshotCached = true;
    // Never lets a bad saved copy stop the fetch and the polling below from starting.
    try { render(); } catch (err) { lastLayoutKey = ''; console.error('Styx Sports: saved schedule', err); }
  }
  loadSchedule(false);
  setInterval(() => { if (!document.hidden) loadSchedule(false); }, SCHEDULE_MS);
  setInterval(refreshStatus, STATUS_MS);
})();
