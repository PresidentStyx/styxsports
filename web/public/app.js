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
      snapshot = s;
      snapshotCached = false;
      store.set(SNAPSHOT_KEY, s); // painted instantly on the next launch, like the app's disk snapshot
      render();
    } catch (e) {
      if (!snapshot) showProblem('Could not load the schedule.\n' + e.message);
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
      for (const [, cards] of cardsById) for (const c of cards) bindDynamic(c, c._event);
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
      const recent = recents.load().map((it) => byId.get(it.event.id) || it.event).slice(0, MAX_CONTINUE);
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
      let liveN = 0, endedN = 0;
      for (const e of list) { if (e.ended) endedN++; else if (e.live) liveN++; }
      const upcoming = list.length - liveN - endedN;
      let sub = liveN > 0 ? `${liveN} live · ${upcoming} upcoming` : `${upcoming} upcoming`;
      if (endedN > 0) sub += ` · ${endedN} final`;
      rows.push({ title: c.name, sub, events: favoritesFirst(list) });
    }
    return { rows, filter, premiumOnly };
  }

  function render() {
    const s = snapshot;
    if (!s) return;
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
  }

  function renderChips(s) {
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

  function createCard(e) {
    const card = el('button', 'card');
    card.type = 'button';
    card.tabIndex = 0;
    card._event = e;
    card.dataset.id = e.id;

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
    bindDynamic(card, e);

    card.onclick = () => openEvent(card._event);
    card.oncontextmenu = (ev) => { ev.preventDefault(); showFavoritesMenu(card._event, ev.clientX, ev.clientY); };
    let pressTimer = null;
    card.addEventListener('touchstart', (ev) => {
      pressTimer = setTimeout(() => {
        pressTimer = null;
        const t = ev.touches[0];
        showFavoritesMenu(card._event, t.clientX, t.clientY);
      }, 550);
    }, { passive: true });
    const cancel = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
    card.addEventListener('touchend', (ev) => { if (!pressTimer) ev.preventDefault(); cancel(); });
    card.addEventListener('touchmove', cancel, { passive: true });
    card.addEventListener('focus', () => {
      focusedId = e.id;
      card.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    });

    let list = cardsById.get(e.id);
    if (!list) cardsById.set(e.id, (list = []));
    list.push(card);
    return card;
  }

  function bindDynamic(card, e) {
    card._event = e;
    const pill = card._pill;
    if (e.ended) {
      pill.textContent = 'FINAL';
      pill.classList.remove('live');
    } else if (e.live) {
      pill.textContent = 'LIVE' + (e.liveText ? '  ' + e.liveText : '');
      pill.classList.add('live');
    } else {
      pill.textContent = startLabel(e.startTs);
      pill.classList.remove('live');
    }
    if (e.away) {
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
    const menu = $('menu');
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
    menu.classList.remove('hidden');
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - h - 8)) + 'px';
    const first = menu.querySelector('button');
    if (first) first.focus();
  }

  function hideMenu() { $('menu').classList.add('hidden'); }
  document.addEventListener('pointerdown', (ev) => { if (!$('menu').contains(ev.target)) hideMenu(); });

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
    const cards = [...strip.children];
    const i = cards.indexOf(a);
    const ri = strips.indexOf(strip);
    let target = null;
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
    root: $('player'), video: $('video'),
    hls: null, event: null, servers: [], current: -1, failed: new Set(), resolved: new Map(),
    generation: 0, everPlayed: false, retried: false, manual: false, open: false, embedMode: false,
    hudTimer: null, stallTimer: null, startTimer: null, impatience: null,
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
      this.resolved = new Map();
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
      this.stopPlayback();
      this.hideEmbed();
      this.root.classList.add('hidden');
      document.body.style.overflow = '';
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      if (!fromHistory && history.state && history.state.player) popOwnEntry();
      if (this.channelMode) {
        this.channelMode = false;
        liveTv.render(); // "Recently watched" may have gained this channel
        liveTv.focusCurrent(); // the Live TV screen is still open underneath
        return;
      }
      this.dropSlot();
      lastLayoutKey = '';
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
      this.root.focus();
      history.pushState({ player: true }, '');
      this.tuneTo(idx);
    },

    async tuneTo(idx, isRetry = false) {
      const n = this.channels.length;
      if (!n) return;
      idx = (idx + n) % n;
      this.current = idx;
      this.retried = isRetry;
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
      this.play({ server: ch.n, hls: data.hls, direct: data.direct || null, playable: true });
    },

    channelFailed(why) {
      const ch = this.channels[this.current];
      console.warn('[styx] channel ' + (ch ? ch.n : '?') + ' failed: ' + why);
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
      let data;
      try {
        data = await api('/api/stream?only=servers&page=' + encodeURIComponent(this.event.url));
      } catch (e) {
        if (gen !== this.generation) return;
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
      b.onclick = () => { this.close(); acct.open(); };
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
      const gen = ++this.generation;
      this.clearTimers();
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
      const fail = (why) => {
        if (gen !== this.generation) return;
        if (!started && sourceIdx + 1 < sources.length) {
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
      this.startTimer = setTimeout(() => fail('start timeout'), START_TIMEOUT_MS);

      const onReady = () => {
        if (gen !== this.generation) return;
        started = true;
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
      v.onplaying = onReady;
      v.onwaiting = () => {
        if (gen !== this.generation) return;
        if (this.everPlayed) this.status('Buffering…', true);
        this.clearTimer('stallTimer');
        this.stallTimer = setTimeout(() => { if (gen === this.generation) this.onFailure('stalled'); }, STALL_MS);
      };
      v.onended = () => { if (gen === this.generation) this.onFailure('ended'); };
      v.onerror = () => { if (gen === this.generation && !this.hls) fail('media error'); };

      if (window.Hls && Hls.isSupported()) {
        const hls = new Hls({
          lowLatencyMode: false,
          liveSyncDurationCount: 4, // a little extra runway: every segment takes a hop through the proxy
          manifestLoadingTimeOut: 15000,
          levelLoadingTimeOut: 15000,
          fragLoadingTimeOut: 20000,
          manifestLoadingMaxRetry: viaDirect ? 1 : 2, // a CORS refusal shows up as a manifest error
          levelLoadingMaxRetry: 3,
          fragLoadingMaxRetry: 3,
        });
        this.hls = hls;
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (gen !== this.generation) return;
          if (data.fatal) {
            const code = data.response && data.response.code ? ` HTTP ${data.response.code}` : '';
            fail(`${data.type}/${data.details}${code}`);
          }
        });
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
      if (wasPlaying && !this.retried) {
        // A playing stream that died: the playlist probably expired; fetch a fresh one once.
        this.retried = true;
        this.resolved.delete(s.pageUrl);
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
        return this.allFailed('None of the servers are responding right now.', true);
      }
      this.status(`${s.name} isn't responding — trying ${this.servers[next].name}`, true);
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
      if (showRetry) first = btn('Retry', () => { this.failed.clear(); this.resolved.clear(); this.switchTo(this.current < 0 ? 0 : this.current, true); }, true);
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
      else if (e.live) { pill.textContent = 'LIVE' + (e.liveText ? '  ' + e.liveText : ''); pill.classList.add('live'); }
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

  // Player UI wiring.
  $('p-close').onclick = () => player.close();
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
    if (player.open) player.close(true);
    else if (liveTv.isOpen()) liveTv.close(true);
  });

  function openEvent(e) {
    if (!e.url) return;
    recents.record(e);
    player.openFor(e);
  }

  // ---------------------------------------------------------------------------------------------
  // Premium account (AccountActivity.java): the site's TV sign-in flow
  // ---------------------------------------------------------------------------------------------

  const POLL_MS = 3000;

  const acct = {
    root: $('acct'), code: null, pollTimer: null, tickTimer: null, busy: false,

    isOpen() { return !this.root.classList.contains('hidden'); },

    open() {
      this.root.classList.remove('hidden');
      this.render();
      if (!account.signedIn) this.getCode();
    },

    close() {
      this.stop();
      this.root.classList.add('hidden');
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
      if (account.signedIn) {
        $('acct-title').textContent = 'Premium account';
        body.appendChild(el('p', 'acct-lead', 'You are signed in to StreamEast. Games open on this account’s premium servers first and fall back to the free ones.'));
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
      if (pool.shared && pool.sharedPremium !== false) {
        body.appendChild(el('p', 'acct-line ok', `★  Shared premium is already active for everyone: ${pool.used} of ${pool.max} connections in use. Sign in here to use your own account instead — or to share it on the stats page and add 5 more connections for everyone.`));
      }
      body.appendChild(el('p', 'acct-lead', 'Sign in to your StreamEast account and Styx Sports will use its premium servers automatically. Without an account it keeps using the free ones.'));
      const steps = el('ol', 'acct-steps');
      const link = el('a', null, 'auth.streamea.st/activate');
      link.id = 'acct-link';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const s1 = el('li');
      s1.append('On your phone (or in a new tab), go to ', link, ' — or scan the code.');
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
      btn('Get new code', () => this.getCode());
      btn('Cancel', () => this.close(), true);
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
        this.setStatus('Waiting for you to enter the code on your phone…');
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
      b.textContent = `★ Premium ${pool.used}/${pool.max}`;
      b.classList.add('premium');
      b.title = 'Shared premium account: connections in use. Click to sign in with your own account instead.';
      return;
    }
    if (!account.signedIn) { b.textContent = 'Sign in'; b.classList.remove('premium'); b.title = 'Sign in to your premium account'; return; }
    if (account.premium === false) { b.textContent = 'Signed in'; b.classList.remove('premium'); b.title = 'Signed in (no premium on this account)'; return; }
    b.textContent = '★ Premium';
    b.classList.add('premium');
    b.title = 'Signed in to your premium account';
  }

  $('account').onclick = () => acct.open();
  $('acct-close').onclick = () => acct.close();
  $('acct').addEventListener('pointerdown', (ev) => { if (ev.target === $('acct')) acct.close(); });

  // ---------------------------------------------------------------------------------------------
  // Live TV (LiveTvActivity.java): the premium account's IPTV channel list
  // ---------------------------------------------------------------------------------------------

  const IPTV_RECENT_MAX = 24;
  const RECENT_GROUP = '★ Recently watched';
  const SEARCH_MAX = 400;

  const liveTv = {
    root: $('livetv'), data: null, loading: null, group: null, query: '', focusedChannel: -1,

    isOpen() { return !this.root.classList.contains('hidden'); },

    async open() {
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
  // Free the shared premium slot the moment the tab goes away (the lease would expire anyway).
  window.addEventListener('pagehide', () => player.dropSlot());

  renderAccountButton();
  loadAccount();

  // Paint the last saved schedule at once; the fresh one replaces it when it arrives.
  const saved = store.get(SNAPSHOT_KEY, null);
  if (saved && Array.isArray(saved.events) && Array.isArray(saved.categories) && saved.events.length) {
    snapshot = saved;
    snapshotCached = true;
    render();
  }
  loadSchedule(false);
  setInterval(() => { if (!document.hidden) loadSchedule(false); }, SCHEDULE_MS);
  setInterval(refreshStatus, STATUS_MS);
})();
