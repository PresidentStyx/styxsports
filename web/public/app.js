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
  let filterName = store.get('filter_category', null);
  let lastLayoutKey = '';
  const cardsById = new Map(); // id -> [card elements]
  let focusedId = null;

  // ---------------------------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------------------------

  async function api(path) {
    const res = await fetch(path, { cache: 'no-store' });
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
    const filter = filterName ? s.categories.find((c) => c.name === filterName) : null;
    if (filterName && !filter) { filterName = null; store.set('filter_category', null); }

    const byCat = new Map();
    for (const c of s.categories) byCat.set(c.id, []);
    for (const e of s.events) {
      if (!byCat.has(e.categoryId)) {
        byCat.set(e.categoryId, []);
        s.categories.push({ id: e.categoryId, name: e.categoryId ? 'Category ' + e.categoryId : 'Other', liveCount: 0, soonCount: 0 });
      }
      byCat.get(e.categoryId).push(e);
    }
    for (const list of byCat.values()) list.sort(rowOrder);

    if (!filter) {
      const byId = new Map(s.events.map((e) => [e.id, e]));
      const recent = recents.load().map((it) => byId.get(it.event.id) || it.event).slice(0, MAX_CONTINUE);
      if (recent.length) rows.push({ title: 'Continue watching', sub: 'Games you opened recently', events: recent });
    }
    if (!favorites.isEmpty()) {
      const mine = s.events.filter((e) => favorites.matches(e) && (!filter || e.categoryId === filter.id)).sort(rowOrder);
      if (mine.length) rows.push({ title: 'Your teams', sub: 'Starred teams and leagues', events: mine });
    }
    const live = s.events.filter((e) => e.live && !e.ended && (!filter || e.categoryId === filter.id)).sort(rowOrder);
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
    return { rows, filter };
  }

  function render() {
    const s = snapshot;
    if (!s) return;
    renderChips(s);
    const { rows, filter } = buildRows(s);
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
      root.appendChild(el('div', 'empty', filter ? `No ${filter.name} games right now.` : 'No games listed right now.'));
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
    $('status').textContent = `Updated ${t} · ${live} live`;
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
    for (const c of s.categories) if (s.events.some((e) => e.categoryId === c.id)) nav.appendChild(mk(c.name, c.name));
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
    if (!$('player').classList.contains('hidden')) return player.onKey(ev);
    const a = document.activeElement;
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

    openFor(e) {
      this.event = e;
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
      if (!fromHistory && history.state && history.state.player) history.back();
      lastLayoutKey = '';
      render();
      const cards = cardsById.get(this.event && this.event.id);
      if (cards) cards[0].focus({ preventScroll: false });
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
      this.servers = all.filter((s) => !s.premium);
      if (!this.servers.length) {
        return this.allFailed(all.length ? 'This game only has premium servers on the site.' : 'No servers listed for this game.', false);
      }
      let start = Math.max(0, this.servers.indexOf(all[data.activeIndex]));
      const remembered = store.get('server_' + this.event.id, null);
      if (remembered) {
        const idx = this.servers.findIndex((s) => s.name === remembered);
        if (idx >= 0) start = idx;
      }
      this.renderServers();
      this.switchTo(start, false);
    },

    renderServers() {
      const box = $('p-servers');
      box.replaceChildren();
      this.servers.forEach((s, i) => {
        const emb = this.embeddable && this.embeddable[i];
        const cls = 'server' + (i === this.current ? ' current' : '') + (this.failed.has(i) && !emb ? ' failed' : '') + (emb ? ' embed' : '');
        const b = el('button', cls, s.name + (emb ? ' ▣' : ''));
        b.title = emb ? 'Plays in the embedded player (may show ads)' : '';
        b.onclick = () => this.switchTo(i, true);
        box.appendChild(b);
      });
      if (this.servers.length) {
        const mode = this.embedMode ? ' · embedded' : '';
        $('p-servers').appendChild(el('span', 'hint', `Server ${this.current + 1} of ${this.servers.length}${mode}`));
      }
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
      // Not playable through our proxy (usually a CDN that refuses Cloudflare). If the site has an
      // embeddable player for it, that plays from the viewer's own IP — but with the site's ads.
      // On a manual pick, go straight there; on auto fallback, exhaust the clean servers first.
      if (stream && stream.embed) {
        if (manual) return this.enterEmbed(s, stream);
        this.embeddable = this.embeddable || {};
        this.embeddable[this.current] = stream;
      }
      const why = !stream ? 'no stream' : stream.state === 'gate' ? 'premium only'
        : !stream.hls ? 'no playable stream' : `CDN ${stream.cdn} refused (${stream.cdnStatus})`;
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
        const data = await api('/api/stream?server=' + encodeURIComponent(s.pageUrl) + '&name=' + encodeURIComponent(s.name));
        const stream = data.stream || { server: s.name, hls: null };
        // Remember both outcomes; a CDN that refuses us will not change its mind in a minute.
        // Playable results are dropped again when a playing stream dies (see onFailure).
        this.resolved.set(s.pageUrl, stream);
        return stream;
      } catch (e) {
        return { server: s.name, hls: null, error: e.message };
      }
    },

    play(stream) {
      const v = this.video;
      const gen = this.generation;
      this.status(`Connecting to ${stream.server}…`, true);
      this.startTimer = setTimeout(() => { if (gen === this.generation) this.onFailure('start timeout'); }, START_TIMEOUT_MS);

      const onReady = () => {
        if (gen !== this.generation) return;
        this.clearTimer('startTimer');
        this.clearTimer('stallTimer');
        this.hideStatus();
        if (!this.everPlayed) {
          this.everPlayed = true;
          this.failed.clear();
          this.renderServers();
          if (this.manual) store.set('server_' + this.event.id, this.servers[this.current].name);
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
      v.onerror = () => { if (gen === this.generation && !this.hls) this.onFailure('media error'); };

      if (window.Hls && Hls.isSupported()) {
        const hls = new Hls({
          lowLatencyMode: false,
          liveSyncDurationCount: 4, // a little extra runway: every segment takes a hop through the proxy
          manifestLoadingTimeOut: 15000,
          levelLoadingTimeOut: 15000,
          fragLoadingTimeOut: 20000,
          manifestLoadingMaxRetry: 2,
          levelLoadingMaxRetry: 3,
          fragLoadingMaxRetry: 3,
        });
        this.hls = hls;
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (gen !== this.generation) return;
          if (data.fatal) {
            const code = data.response && data.response.code ? ` HTTP ${data.response.code}` : '';
            this.onFailure(`${data.type}/${data.details}${code}`);
          }
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => { if (gen === this.generation) this.tryPlay(); });
        hls.loadSource(stream.hls);
        hls.attachMedia(v);
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = stream.hls;
        v.onloadedmetadata = () => this.tryPlay();
      } else {
        this.allFailed('This browser cannot play HLS video.', true);
      }
    },

    /**
     * Fallback for servers our proxy can't reach (CDNs that block Cloudflare): load the site's own
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
        return this.allFailed(gated ? 'This game only has premium servers on the site.' : 'None of the servers are responding right now.', true);
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
      if (!this.open || !this.event) return;
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
        case 'r': this.switchTo(this.current, true); return;
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
    return !!(stream && stream.hls && stream.playable !== false);
  }

  // Player UI wiring.
  $('p-close').onclick = () => player.close();
  $('p-fs').onclick = () => player.toggleFullscreen();
  $('p-unmute').onclick = () => { player.video.muted = false; $('p-unmute').classList.add('hidden'); };
  player.video.onclick = () => { if ($('p-panel').classList.contains('hidden')) player.togglePause(); };
  player.video.ondblclick = () => player.toggleFullscreen();
  player.root.addEventListener('pointermove', () => player.showHud());
  player.root.addEventListener('pointerdown', () => player.showHud());
  window.addEventListener('popstate', () => { if (player.open) player.close(true); });

  function openEvent(e) {
    if (!e.url) return;
    recents.record(e);
    player.openFor(e);
  }

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
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadSchedule(false); refreshStatus(); } });

  loadSchedule(false);
  setInterval(() => { if (!document.hidden) loadSchedule(false); }, SCHEDULE_MS);
  setInterval(refreshStatus, STATUS_MS);
})();
