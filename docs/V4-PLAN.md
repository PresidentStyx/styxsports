# Styx Sports 4.0 — plan

Four clients (APK, Roku, web, phone), one new look, one shared "game state" brain in the
Worker. Home becomes a network-style front page driven by live game state; pressing Watch is
instant because the stream was resolved while the card had focus; the player grows a score
bug and a game switcher with live scores; streams heal themselves; the phone becomes a real
app (PWA, push, cast-to-TV); the updater becomes boring and reliable; a status page tells
viewers the truth when something's off. Design tokens and a shared remote grammar make it
feel identical everywhere.

Out of scope for 4.0, deliberately: Live TV gets nothing beyond tokens and the remote grammar.

Progress is tracked in the checklist at the end of each phase.

---

## Phase 0 — Baseline audits (before anything new)

Hard requirements from the owner: the APK updater must work *very consistently*, and mobile
must be solid. Both double as the safety net for shipping 4.0 to everyone.

### 0.1 Updater audit (APK)
- Read the updater path end to end (update check → GitHub latest release → download →
  install intent); document when it runs today, what it does on a failed download, how it
  compares versions.
- Test matrix (Chromecast + office TV over the SSH tunnel; emulator for edge cases):
  - Fresh launch with a newer release → prompt within 10 s.
  - Already in foreground when a release publishes → prompt within the check interval,
    no force-stop.
  - Download interrupted (Wi-Fi off mid-download) → retry/resume, no half-installed state.
  - Installed version newer than latest (dev builds) → no prompt.
  - GitHub unreachable (office-style block) → silent skip, retry later; fallback through the
    Worker (`/apk`) when raw GitHub is blocked.
  - Device off for weeks → prompt on first launch.
- Deliverable: checklist in the README release section + fixes for anything failing. Full
  hardening is Phase 5.

### 0.2 Mobile audit (web on phone)
- Every screen at 360×780 and 390×844, portrait and landscape, iOS Safari and Android
  Chrome: login, Home, player, server picker, sign-in, stats. Tap targets < 44 px, overflow,
  fixed-position bugs with the iOS keyboard/URL bar, and whether the player uses native HLS
  on iOS (hls.js can't run there).
- Deliverable: defect list folded into Phase 4; blocking ones fixed immediately.

*Effort: 2 sessions. Exit: both checklists green or itemized.*

---

## Phase 1 — Foundations (idea 9 + tokens + flags)

### 1.1 Game State Service (Worker)
- Spike: capture the schedule and status feed for a full day across leagues; document which
  fields exist per league (score, period/inning, clock, situation, possession, final).
- `web/src/games.js` produces one normalized shape for all clients:

  ```json
  {
    "id": "nfl-dal-nyg-2026-09-14",
    "league": "NFL", "leagueLogo": "/img/leagues/nfl.png",
    "home": { "id": "nyg", "name": "New York Giants", "short": "NYG", "crest": "...", "colors": ["#0B2265", "#A71930"] },
    "away": { "id": "dal", "name": "Dallas Cowboys",  "short": "DAL", "crest": "...", "colors": ["#003594", "#869397"] },
    "state": "live | pre | final | halftime | delayed",
    "score": { "home": 21, "away": 24 },
    "period": { "label": "Q4", "clock": "4:12" },
    "situation": { "text": "3rd & 7 · DAL", "possession": "away" },
    "startsAt": 1789430400000,
    "heat": 0.87,
    "closeness": 0.9,
    "streams": { "pageUrl": "...", "premiumCapable": true },
    "scoring": [ { "at": 1789431000000, "team": "away", "delta": 7, "score": { "home": 14, "away": 21 } } ]
  }
  ```
- Derived scoring timeline: diff consecutive 30 s status snapshots → scoring events with
  timestamps, no plays feed needed. Powers "what did I miss", big-moment badges, plays panel.
- `closeness` per league (NFL: one-score game in Q4/OT; MLB: 9th+ within 2; NBA: within 6 in
  last 5 min; soccer: within 1 after 70'; NHL: within 1 in 3rd). `heat` = existing 🔥 order
  + closeness + viewer count.
- Endpoints: `GET /api/games` (edge-cached 15 s), `GET /api/games/:id`,
  `GET /api/games/live-summary` (scores only, ~1 KB, polled every 15 s by score bug and
  switcher). APK keeps its direct path but adopts the same shape.

### 1.2 Telemetry
- `POST /api/telemetry`: `{ device, platform, version, network: "direct"|"relay", events: [...] }`
  with kinds `start` (game, server, cdn family, premium, ttff), `stall` (duration, position),
  `switch` (from/to, reason), `error` (code, cdn), `update` (from → to, outcome).
- `Telemetry` Durable Object (SQLite), hourly rollups: per-CDN-family success rate and
  median TTFF, stalls per viewer-hour, per-platform/version counts. Raw 7 days, rollups 90.
- Clients batch every 60 s and on player close. Device id = Presence id.
- `/stats` gains "Playback health" and a per-CDN table; feeds the Phase 5 status page.

### 1.3 Design tokens
- `design/tokens.json`: colors, spacing, radii, type scale (Android 14 non-linear font
  scaling documented so Roku matches), motion durations, focus ring.
- `design/teams.json`: league → team → `{ id, short, colors[2] }`, seeded from crest
  dominant colors, hand-corrected. Unknown teams fall back to league colors.
- `design/build.mjs` emits `web/public/tokens.css`, `app/src/main/res/values/tokens.xml`,
  `roku/source/Tokens.brs`. CI fails if outputs are stale.

### 1.4 Remote flags in `config.json`
- `features: { hero, gameCenter, prewarm, ... }` per platform, `minVersion`, `pinned`
  (device-id prefix → version, for rollbacks), `rollout` percentages (device-id hash).
  Read at launch and every 6 h.

*Effort: 4–5 sessions. Exit: `/api/games` live for all leagues with a field-coverage table;
`/stats` shows telemetry from the APK; tokens generated for all three targets; flags read
by all clients.*

---

## Phase 2 — Speed you can feel (idea 2) + self-healing stream

### 2.1 Zero-wait start
- Focus 600 ms → background resolve, cached 90 s (servers, best server, direct/proxy/ts).
  APK `StreamResolver` on `io`; web `/api/stream` on focus/hover; Roku `NetTask` op.
- `/api/stream?pre=1` for telemetry separation; stream-page edge cache 30 s.
- Premium pre-warm policy: focus ≥ 2 s AND ≥ 2 pool slots free; hold ≤ 60 s; one per device;
  `acquire { prewarm: true }` shown distinctly on `/stats`.
- Cold launch from cached schedule (APK SharedPreferences; web localStorage → PWA cache;
  Roku cachefs), silent refresh.
- Targets (telemetry): median TTFF < 1.5 s free / < 3 s premium when pre-resolved; cold
  launch → interactive Home < 1 s.

### 2.2 Self-healing stream
- Degradation: 3 stalls in 2 min, or two stalls longer than the rebuffer runway, or an HTTP
  error burst → migrate.
- APK: second `ExoPlayer` prepared on the next-best source, swap surface at READY. Web:
  hidden second `<video>`, swap on `canplay`. Roku: single Video node — switch with last
  frame as poster and a "Switching…" pill; error screen only when every candidate fails.
- "Next best" = per-device source memory (telemetry) + premium-first / named-tab logic.
- `switch` telemetry with reason.

*Effort: 4 sessions. Exit: TTFF targets on Chromecast + office TV + Roku + phone; induced
degradation migrates without an error screen on all four.*

---

## Phase 3 — The visible 4.0: Home (idea 1) + Game Center (idea 3)

Design once; build APK → web/phone → Roku.

### 3.1 Design spec
- Screens: Home (hero, rows, chips), Game card states, Player + score bug, Player +
  switcher, Ambient pause, What's new. Mockups in a canvas, TV and phone proportions.
- Remote grammar, final: **Up** score bug · **Down** game switcher · **Left/Right**
  server (games) / channel (Live TV) · **OK** play/pause · **Long-OK** options · **Back**
  close overlay, then exit. Phone: swipe up/down, tap for controls.

### 3.2 Home
- Hero row: top 1–3 games by heat, team-color gradient, crests, score, period/clock,
  situation, Watch / Details; rotates every 8 s unfocused.
- Rows: Live now (heat), Starting soon (countdown, auto-promotes at `startsAt`), by league,
  Finals (collapsed).
- Cards: team-color edge gradient; badges LIVE / Close game / OT / Halftime / Final /
  Premium crown; upcoming shows local time and countdown < 60 min.
- Header pool pill: "Premium: 4 of 10 free".
- APK Views + tokens.xml; web vanilla JS + tokens.css, hero = swipeable carousel on phones;
  Roku SceneGraph `HeroCard` + `RowList`, pixel-matched with `layout-shot.ps1`.

### 3.3 Game Center (player)
- Score bug (Up): crests, score, period/clock, situation; MLB count/outs/diamond;
  auto-hides 8 s unless pinned (Up twice). Rendered by us on every platform.
- Game switcher (Down): strip of other live games with scores and heat; polls
  `live-summary` every 15 s while open; OK switches in place (pre-resolved, ~1 s) keeping the
  current stream until the new one is READY.
- "What did I miss": 5 s card on entry with last 3 scoring events + situation.
- Auto-hop alerts (opt-in): same-league game crosses closeness threshold → corner toast,
  OK jumps; 5 min cooldown per game.
- Plays panel (Long-OK → Plays): scoring timeline.
- Roku: overlays over the Video node; polling via `NetTask`; in-place switch via Phase 2.

*Effort: 8–10 sessions. Exit: side-by-side screenshots of all four matching the spec;
switcher hop < 2 s; score bug within 30 s of the feed.*

---

## Phase 4 — Mobile as a first-class platform

### 4.1 Portrait-first player
- Portrait: video, score bug, switcher as a vertical list, servers. Landscape → fullscreen
  (Fullscreen API + orientation lock; iOS native video fullscreen).
- PiP: `video.requestPictureInPicture()` / iOS video PiP; on `visibilitychange` when enabled.
  iOS needs native HLS on the `<video>` element (tie to 0.2).
- Controls ≥ 44 px; swipe up = score bug, swipe down = switcher, double-tap = play/pause.

### 4.2 PWA
- `manifest.webmanifest` (icons 192/512 + maskable, standalone, theme color from tokens),
  iOS meta + splash.
- Service worker: cache-first shell + tokens; stale-while-revalidate `/api/games`; never
  caches `/hls/`, `/ts/`, auth; passes the gate cookie.
- Add-to-Home-Screen nudge after second visit; iOS instructions. `/install` gets a Phone tab.

### 4.3 Follow teams + push
- Team picker; stored locally on all platforms, synced `PUT /api/follows` under device id.
  Home prioritizes followed teams; "Your teams" strip when live or within 24 h.
- Web push: VAPID secrets; `POST /api/push/subscribe` → `Push` DO. Cron every minute:
  kickoff in 15 min for followed teams; close-game alerts (closeness ≥ 0.85, once per game).
  Workers-compatible web-push lib. Deep-links to the game. iOS only as installed PWA (16.4+).

### 4.4 Cast to TV from the phone
- Pairing: TV shows a 4-digit code (Settings → Pair a phone); phone enters once; Worker
  records a shared `household` on both Presence records.
- Command inbox in `Presence`: `POST /api/cast { target, cmd: "open", gameId }` and
  `cmd: "key"`. APK + web-TV via WebSocket to the DO (hibernation API); Roku polls
  `/api/cast/inbox` every 3 s while foreground.
- Phone UI: "Send to <TV>" on every card; remote page (D-pad, OK, Back, play/pause); "Now
  playing on TV" with the score bug.

*Effort: 6–7 sessions. Exit: installable on iPhone and Android from `/install`; push arrives
for a followed team's kickoff on both; cast opens a game on Chromecast, office TV, a Roku;
Lighthouse PWA audit passes.*

---

## Phase 5 — Trust: updater hardening + status page

### 5.1 Updater hardening (APK)
- Checks: launch; foreground resume if > 1 h since last; WorkManager periodic 6 h
  (network-constrained). GitHub latest-release API with Worker fallback (`/api/release`
  mirrors tag, size, sha256, notes).
- `DownloadManager` (resumable), app cache, SHA-256 verified against
  `StyxSports.apk.sha256` published by CI; mismatch → delete, retry next check.
- "Update on next exit": defer while a stream plays; prompt on return to Home or
  background. Prompt shows What's new from release notes.
- `config.json`: `minVersion` (blocking prompt below it), `pinned` rollbacks, `rollout`.
- `update` telemetry (prompted / downloaded / installed / failed) → `/stats` adoption.
- Roku: compares its version to `/api/release`, shows "Update available — reinstall from
  your phone" banner.
- Re-run the Phase 0 matrix plus: kill mid-download and relaunch (resumes); corrupt APK on
  disk (rejected); pin a device to 3.9 remotely (stops offering 4.0).

### 5.2 Status page
- `/status` (open): site reachability (schedule fetch age), premium account state (no
  credentials), pool slots free, per-CDN health from telemetry (15 min, green/yellow/red +
  reason), current release versions, manual notice line from `config.json`.
- In-app footer on Home (all platforms): one line ("All systems normal · Premium 4 free");
  OK/tap opens the page or a detail card.

*Effort: 4 sessions. Exit: matrix green on two TVs; `/status` reflects an induced outage
within 15 min.*

---

## Phase 6 — Polish (idea 8) and the release train

### 6.1 Polish
- Ambient pause (> 10 s): blurred last frame, centered score bug, "Resumes at live ·
  back-buffer N min"; Roku static poster + score.
- Sleep timer (30/60/90/end of game).
- Tonight's slate: Home idle > 5 min → rotating live scores and upcoming games.
- Sound design: hop, kickoff chime for followed teams, alert; off by default on Roku.
- Team-colored accent when a followed team is live.
- What's new in 4.0 splash: 4 slides (Home, Game Center + remote grammar, speed +
  self-healing, phone app + cast) with a "show me the remote" overlay.

### 6.2 Release train
- Beta channel in `config.json` (`beta` device list → `v4.0-beta.N` tags). Owner's devices
  and the office TV go beta.
- Staged rollout for `v4.0`: 10% → 50% → 100% over three days via `rollout`, watching
  adoption and stall rates; `pinned` rollback ready.
- Roku 4.0 zip on `/roku`; both Rokus via `deploy.ps1`.
- Web ships dark behind `features` flags; flipped the same day as the APK.
- `versionName 4.0`, `versionCode 30` (room for 3.9.x hotfixes).

*Effort: 3 sessions + rollout days.*

---

## Sequence

| Phase | What lands | Sessions | Visible? |
|---|---|---|---|
| 0 | Updater + mobile audits, blocking fixes | 2 | Fixes only |
| 1 | Game state service, telemetry, tokens, flags | 4–5 | No |
| 2 | Zero-wait start, pre-warm, self-healing | 4 | Feels faster |
| 3 | New Home + Game Center on all four | 8–10 | The big one |
| 4 | Portrait player, PWA, push, cast | 6–7 | Phone becomes an app |
| 5 | Updater hardening, status page | 4 | Reliability |
| 6 | Polish, What's new, staged rollout | 3 + rollout | Launch |

Phases 4 and 5 can interleave with 3.

## Risks
- Feed coverage: situation data may not exist for every league; the Phase 1 spike settles it
  before UI design; the score bug degrades to score + period + clock.
- Pre-warm pool contention: bounded by the ≥ 2-free rule and the 60 s hold; visible on
  `/stats`; flag to disable.
- Worker load from pre-resolve: 30 s edge cache + per-device debounce; telemetry measures it.
- Roku iteration speed: Roku last in each phase; screenshot tooling for pixel matching.
- iOS: PiP/push only with native HLS on the video element and an installed PWA.
- Premium TS relay over a 3-hour game on one Worker subrequest is unproven; self-healing
  covers a drop; telemetry will show it.

## Needed from the owner
- Design sitting at the start of Phase 3.
- Team-color corrections once `teams.json` is seeded.
- TVs/Rokus available for the Phase 0 and 5 matrices.
- Go-ahead per phase (each touches the deployed Worker).

---

## Progress

### Phase 0
- [ ] 0.1 Updater path documented
- [ ] 0.1 Test matrix run and results recorded
- [ ] 0.2 Mobile audit run and defects listed
- [ ] Blocking fixes shipped
