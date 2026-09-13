# Styx Sports (Android TV / Fire TV)

![Styx Sports](art/logo-banner.png)

A small native Android TV app for StreamEast: a real TV-style home screen
built from the site's schedule and a native full-screen player.

- Shows up in the Android TV / Google TV / Fire TV launcher (leanback entry + banner).
- **Native home**: rows per sport ("Live Now" first) of focusable cards with
  team crests, live clock and score, kick-off time, trending / premium badges.
  D-pad moves between cards, **OK** opens the stream, **Menu** refreshes,
  **Back** exits. Live clocks and scores refresh every 30 s, the schedule every 5 min.
- **Sport chips** under the logo (All · MLB · Soccer · UFC · CFB …) filter the
  rows; the pick is remembered.
- **Continue Watching** row: the games you opened in the last few hours.
- **Premium account** (**Sign in** button, top right): signs in to a StreamEast
  account with the site's own TV flow — the screen shows a 6-character code and a
  QR code; on your phone open `auth.streamea.st/activate`, sign in and type the
  code. The session is kept in the app's cookie store, so from then on every
  stream page the app reads is signed in and the account's **premium servers
  are used first**, with the free ones as fallback. Without an account (or with
  one that has no premium) premium-only games are kept out of the regular rows
  and collected under a **★ Premium Only** chip; the player offers **Sign in for
  premium** when a game has no free server. **Sign out** is on the same screen.
- **Live TV** (**📺 Live TV** chip, premium accounts only): the account's IPTV
  playlist as its own screen — channel groups down the left (sports groups first),
  the selected group's channels with logos on the right, **★ Recently watched**
  at the top once you have used it. **OK** plays a channel in the native player;
  **◀ ▶** there zap through the group. The app finds the personal playlist link
  on the account page's IPTV tab by itself (nothing to type), downloads the
  ~11k-channel list once, keeps it on disk and refreshes it every 12 h (or on
  **Menu**). Signing out deletes the playlist and the link.
- **Favorites**: long-press **OK** on a card to star either team or the league/sport.
  Starred games get a ★, sort first in every row and fill a **Your Teams** row.
- **Native player**: picking a game resolves the stream page to its HLS playlist
  and plays it with ExoPlayer (hardware decode, no web player, no ads).
  **◀ ▶** (or channel / media prev-next keys) switch between the site's free
  servers, **OK** or Play/Pause pauses, **Up/Down** shows the HUD (title, live
  clock, score, "Server 2 of 4"), **Menu** reconnects, **Back** returns home.
  A server that fails to start, stalls or returns an error is retried once with
  a fresh playlist and then skipped automatically; the server that worked is
  remembered per game. If no server can be played natively, the site's own web
  player is offered as a fallback (below).
- The schedule is parsed from the site's match cards (the site has no event
  JSON; the cards carry everything as `data-*` attributes) plus its live-status
  feed. The last result is cached, so the home paints instantly on launch.
- If the site's domain changes, the app follows the mirror links on the
  gateway page to find the new one, and remembers it.
- **WebView player** (fallback, or `nativePlayer: false`): the stream page opens in a WebView with the site's header, chat,
  newsletter and promos hidden by injected CSS, so the video is the page.
  Dark loading screen instead of a white flash; no scrollbars or text selection.
- In the WebView, D-pad drives an on-screen pointer; **OK** clicks (hold OK +
  D-pad to drag). Pointer near a screen edge scrolls the page.
  **Back** leaves fullscreen video → goes back → returns to the home screen.
  **Menu** reloads. **Play/Pause** toggles a same-origin `<video>`.
- **Open website** (top right) falls back to browsing the full site in the
  WebView, in case the parser ever breaks; `nativeHome: false` in the remote
  config makes that the default.
- Fullscreen HTML5 video is supported.
- Top-level navigation is pinned to allowed hosts; pop-under ads, redirect
  chains and `market://`-style links are dropped so the remote never gets stuck.
  `target="_blank"` links are rewritten to open in place.
- Requests to known ad networks are blocked.
- Desktop user-agent so the site serves its full layout on a 1080p screen.
- **Remote config**: site URL, host lists, UA and page script come from
  [`config.json`](config.json), fetched on every launch.
- **Self-updating**: checks GitHub Releases on launch, downloads a newer APK in
  the background and shows a single **Install now** card.
- Crash reporter shows what happened on the next launch; force-stops, background
  kills and updates are recognised from the OS exit reason and not reported.

## Install with Downloader (Fire Stick / Google TV)

1. On the TV, enable installs from unknown sources for **Downloader**
   (Fire TV: Settings → My Fire TV → Developer Options → Install unknown apps;
   Google TV: Settings → Apps → Security & restrictions → Unknown sources).
2. In Downloader, enter code **4602383**. If the code fails, enter
   `sports.styxam.com/apk` (short for
   `https://github.com/PresidentStyx/styxsports/releases/latest/download/StyxSports.apk`).
3. Choose **Install**.

After that, updates are offered inside the app. The first time you accept one,
Android asks you to allow Styx Sports to install apps (same toggle as for
Downloader); every later update is a single **Install** click.

## Web version — sports.styxam.com

The same app in a browser (laptop, phone, or a TV browser), served by a
Cloudflare Worker from [`web/`](web/):

- `web/src/` is the Worker: a JavaScript twin of the app's `SiteParser` /
  `SiteRepository` / `StreamResolver` (same regex rules, same `parser`
  overrides from `config.json`), plus an HLS proxy. The proxy exists because the
  stream CDNs want the player page's origin as `Referer`/`Origin`, which a
  browser cannot send itself. Playlist URIs are rewritten to signed `/hls/…`
  paths so the Worker cannot be used as a general proxy. The site's pages sit
  behind an SSO cookie handshake, so redirects are followed by hand with a
  cookie jar (anonymous reads share one per isolate; a signed-in viewer's own
  jar rides along in their account cookie). Team crests are proxied too
  (`/img`). `/apk` redirects to the
  latest release; `/install` is the install guide for the Android TV / Fire TV
  and Roku apps (the **Get the TV app** button). Both stay outside the password.
- `web/public/` is the front end (no build step): the home screen with sport
  chips, Continue watching, Your teams (right-click / long-press a card to
  star), Live now and per-sport rows; premium-only games sit under a
  **★ Premium Only** chip like in the app. The last schedule is kept in
  `localStorage` and painted before the first fetch answers. Live clocks and
  scores refresh every 30 s. Arrow keys move between cards like a D-pad, Enter
  plays, Esc closes, R refreshes. A web manifest lets phones and TV browsers
  add it to the home screen as a full-screen app. Under 600 px wide (a phone
  held upright) the sideways strips become two-column grids on one scrolling
  page, the top bar is one line with the sport chips under it, the player's
  server list scrolls sideways, a first tap on the hidden player HUD only
  brings it back (it does not pause), and Live TV puts the groups in a strip
  across the top over a three-column channel grid (`@media (max-width: 600px)`
  in `app.css`).
- **Premium account** (`web/src/account.js`, the twin of `Account.java`): the
  **Sign in** button runs the site's TV flow — the Worker asks the account
  service for a code, the viewer enters it at `auth.streamea.st/activate`
  (link, or QR for TV browsers), and `/api/account/poll` swaps the approved code
  for a session. Each viewer's site cookies live in their own AES-GCM-encrypted,
  HttpOnly `styx_acct` cookie (key derived from `HLS_SECRET`); nothing is
  stored server-side and nothing is shared between viewers. Signed in,
  `/api/stream` reads the stream page with that viewer's cookies, so the premium
  servers come back as real players; the player tries them first (★ chips) and
  falls back to the free ones, and learns from the first premium tab whether the
  account really has premium (a `gate` state flips it to free-only).
- **Live TV** (`/api/iptv`): a premium account's M3U Plus playlist, read off the
  account page's IPTV tab, downloaded with `output=hls` (browsers play HLS
  only), parsed into groups (sports first) and kept at the edge for 6 h under a
  key derived from the playlist URL. The **📺 Live TV** chip opens a group /
  channel screen with search and a Recently watched group; channels play
  through the same `/hls/` proxy (the panel sends no CORS headers), signed per
  channel by `/api/iptv/token`, which only accepts URLs from that viewer's own
  playlist. ◀ ▶ in the player switch channels.
- **Premium and Live TV play direct, not through the proxy.** The premium CDN
  (`tv.steast.io` → `edge-N.iptv4.net/auth/…`) binds its segment tokens to the
  IP that passed the `/auth/` hop, and every Worker subrequest leaves Cloudflare
  from a different IP, so through `/hls/` the playlist loads and every segment
  404s. All hops send `Access-Control-Allow-Origin: *`, so `/api/stream` and
  `/api/iptv/token` also return the raw URL as `direct` when CORS allows it, and
  the player tries that first (one fixed IP: the viewer's), falling back to the
  proxied path if the direct attempt dies before the first frame. A playlist
  whose only segment is `warming.ts` (the CDN spinning a channel up) is reported
  as `warming` and not playable, so the player moves on instead of looping it.
- **Shared premium account** (`web/src/pool.js`, the `Pool` Durable Object): the
  site sells premium per account with a hard cap of 5 simultaneous connections
  (Live TV tabs and IPTV apps count together). One account can be lent to every
  viewer: sign in with it on the home page, then press **Share** on `/stats`;
  the Worker copies that session into the Durable Object (the cookies never
  reach a browser). A viewer without their own account takes a *lease* on one
  of the 5 slots before a premium server or Live TV is resolved
  (`/api/pool/acquire`), renews it every 20 s while the player is open
  (`/api/pool/heartbeat`) and drops it on close or `pagehide`
  (`/api/pool/release`; a missed lease expires after 45 s). Premium resolves
  and `/api/iptv` only borrow the shared cookies when the request carries a
  live lease id (`slot=`); when all slots are taken the player uses the free
  servers and says so. `/stats` shows the slots in use, who holds them, and
  has **Stop sharing**. `POOL_SLOTS` overrides the cap. Viewers signed in with
  their own account take a lease too (the shared account usually *is* that
  account, so its connection counts against the same 5 and shows on `/stats`),
  but a full pool never keeps them off premium. `/api/pool/acquire`,
  `/heartbeat`, `/release` and `/api/pool/info` (`{ shared, sharedIptv,
  sharedPremium, used, max }`, no cookies) are outside the password gate like
  `/api/ping`, so the Android and Roku apps can join the same pool.
- **Who is watching** (`web/src/presence.js`, the `Presence` Durable Object):
  every client posts `{ id, platform, device? }` to `/api/ping` once a minute
  and drops off after 3 minutes of silence. `device` is what the device calls
  itself: the APK sends the Android device name plus make and model ("DM TV ·
  Google Chromecast"), the Roku its friendly name plus model ("Living Room ·
  Roku Express 4K+"), and browsers are described by the Worker from the
  User-Agent ("iPhone · Safari", "Windows PC · Chrome"; an iPad tells the
  page itself because Safari there claims to be a Mac). `/stats` lists the
  devices with their platform, last ping, and — since the ping id is also the
  pool lease id — what premium stream each one holds; the ids themselves
  never leave the Worker.
- **Devices without their own sign-in use the shared account through the
  Worker.** A live lease id is also accepted in place of the site password on
  `/api/stream`, `/api/iptv` and `/api/iptv/token` (`slot=`), and `/hls/` paths
  are open because they are HMAC-signed by the Worker. So a Roku (or APK) that
  is not signed in learns from `/api/pool/info` that an account is shared,
  takes a lease, asks `/api/stream?server=…&premium=1&slot=<lease>` for a
  premium tab and gets back the playlist URL (`direct` when the CDN allows
  cross-origin play, which the premium CDNs do; the signed proxy path
  otherwise) - never the cookies - then plays it from its own IP, which is what
  the IP-bound premium CDN needs anyway. Live TV works the same way from
  `/api/iptv?slot=`. The Roku shows the Live TV chip and stops hiding premium
  cards as soon as the ping learns an account is shared. A signed-in device
  whose own session gets no player for a premium tab (see below) also falls
  back to this.
- **Two kinds of premium tab.** The site's *named* premium tabs ("Redzone 1",
  "Raiders", "FOX") carry an inline Clappr player with the playlist as a
  reversed-base64 literal, which every client resolves. Its generic *"Server N"*
  premium tabs are `embed.st/embed-seast/...` iframes: a 462-byte page whose
  obfuscated `bundle-seast.js` picks the source through its own protobuf API,
  so no native client can read them (the web falls back to the iframe). The
  Android player therefore tries named premium tabs before generic ones and
  sweeps failures in list order rather than around the circle, so a remembered
  tab near the end no longer skips the good ones before it.
- **How the apps play the premium CDN** (`StreamResolver.checkPlaylist`,
  `Resolver_checkPlaylist`): on Android and Roku the playlist is fetched once
  from the device itself - never through a proxy - following the 302 to
  `edge-N.iptv4.net/auth/<token>`, and the *final* URL is what the player gets,
  so the root-relative `/hls/<token>` segments resolve against the edge that
  authorised them. Measured against the CDN: the `/auth/` URL keeps answering
  for 40 s+ and its segment tokens stay valid for 25 s+ from the same IP; a
  channel with no viewer is (re)started by the first request and repeats the
  same six-segment playlist for 30-40 s (or serves only `warming.ts`) before the
  sequence jumps to live. So `warming.ts` is reported as `warming` and the
  server skipped; ExoPlayer is given 6 target durations (not 3) before it
  calls a live playlist stuck, one `BEHIND_LIVE_WINDOW` error rejoins the live
  edge in place before the server counts as failed, and a premium tab gets 35 s
  (not 20) to show its first frame. Once playing, a stall is a stall for every
  server (15 s, then re-resolve / next server): a first attempt at giving
  premium tabs 45 s and no race made the APK "buffer way more" than before.
  The 6 s race is kept for premium tabs but only against a *free* server (a
  second premium tab would cost the account a connection and start another
  channel warming). Roku's `roUrlTransfer` reports every hop's
  `Location` in `GetResponseHeadersArray()`, which is how `Http_finalUrl` learns
  where a redirect ended.
  The player uses hls.js with the same server switching (← →, or the server
  chips), automatic fallback and a 6 s "race" to the next server when the first
  one is slow.
- The resolver follows the same embed chains as the app, plus two shapes the
  embed hosts use: a player page whose `<iframe>` starts as `about:blank` and
  gets its real URL from `api/player.php?id=N` (`playerApiPath`,
  `playerChannelId`, `playerApiFallback`), and a loader that ships the player
  setup as an XOR/offset char-code array (`charcodeLoader`). Hops that answer
  403/429/5xx are retried; every Worker subrequest leaves Cloudflare from a
  different IPv4 address, so a retry is also a fresh IP.
- That rotating egress IP is also the one thing the Worker cannot work around:
  a CDN that binds its playlist token to the exact IP that loaded the player
  page rejects the Worker's next request from a different one. The Worker
  checks each playlist once when resolving a server and flags such servers
  `playable: false`.
  Those servers are marked `▣` in the player and play through the site's own
  embed in a sandboxed `<iframe>` instead — that runs from the viewer's IP, so
  it works, but it carries the site's ads and can't be controlled by our HUD
  (pop-ups and top-level navigation are blocked by the sandbox). The clean
  native player is always tried first; the embed is used when a server is
  picked manually or when no server plays natively.
  Servers on the site's primary CDN family work.

Deploy (after `npx wrangler login` once):

```
cd web
npx wrangler deploy
npx wrangler secret put HLS_SECRET   # any long random string; signs the /hls paths
```

`wrangler.jsonc` declares `sports.styxam.com` as a custom domain, so the first
deploy creates the DNS record and certificate on the `styxam.com` zone.

## Roku channel — roku/

Roku is not Android and has no browser, so [`roku/`](roku/) is a third build of
the same app, written in BrightScript/SceneGraph. It talks to the site
directly from the Roku (so the Cloudflare-blocked CDNs are not an issue: the
stream plays from the viewer's own IP) and reads the same `config.json` /
`parser` overrides as the APK. What it does: the home screen (chips, Continue
watching, ★ Your teams, Live now, per-sport rows, live scores every 30 s, `*`
on a card to star a team or league), the player (Roku's native HLS player with
the player page's origin as `Referer`/`Origin`, ◀ ▶ server switching, automatic
fallback, premium servers first when signed in, Premium-only gate when not),
the premium account sign-in (same code + QR flow), and Live TV (the account's
IPTV list, HLS variant only; Roku cannot play raw MPEG-TS).

Roku killed private channels in 2022, so it is installed by **sideloading**:
put the Roku in developer mode once (remote: Home ×3, Up ×2, Right, Left,
Right, Left, Right → enable the installer → set a password → it reboots), then
from a PC on the same network:

```
cd roku
.\deploy.ps1 -RokuIp 192.168.1.50 -Password <dev password>
```

That validates and packages the channel (`npx bsc`, first run installs the
tools) and pushes it to the Roku, replacing the previous sideload. There is no
self-update: rerun the script to update. Only one sideloaded channel fits per
device. Debug output: `telnet <RokuIp> 8085`. See [`roku/README.md`](roku/README.md)
for the layout of the code and what still needs a real device to verify.

Viewers do not need a PC: `deploy.ps1` also copies each build to
`web/public/StyxSports.zip`, which the site serves at
[`sports.styxam.com/roku`](https://sports.styxam.com/roku) (outside the
password gate, like `/apk`). The Roku part of `/install` walks a phone through
it: remote combo → note the Roku's `http://192.168.x.x` → download the zip on
the phone → open that address in the phone's browser (`rokudev` + the password
they chose) → Upload → Install. Redeploy the Worker after building a new
channel so the zip on the site is current.

## Making changes

### Without a new APK (remote config)

Edit [`config.json`](config.json) and push to `master`. Every TV picks it up on
the next launch (raw.githubusercontent.com caches for up to ~5 minutes).

| Key                    | Purpose                                                                     |
|------------------------|-----------------------------------------------------------------------------|
| `homeUrl`              | Gateway page: used by "Open website", the WebView-only mode, and domain discovery. |
| `dataBaseUrl`          | Site origin whose listing HTML the native home parses (e.g. `https://v2.streameast.ga`). Auto-discovered via `homeUrl` when it fails. |
| `authBaseUrl`          | The site's account service (default `https://auth.streamea.st`): TV sign-in codes (`/device/code`, `/device/poll`, `/device/login`), account status (`/my-account/`) and sign-out (`/logout/`). |
| `nativeHome`           | `false` = kill switch: launch straight into the WebView on `homeUrl`.       |
| `allowedHostFragments` | Top-level navigation is allowed only to hosts containing one of these.      |
| `blockedHostFragments` | Any request to a host containing one of these is dropped (ad blocking).     |
| `userAgent`            | Override the built-in desktop UA; empty = default.                          |
| `pageScript`           | Extra JavaScript run after every page load; empty = none.                   |
| `playerCss`            | CSS injected into stream pages opened from the home screen (hides site chrome, makes the player fill the width). Empty = built-in default. |
| `playerScript`         | JavaScript run on stream pages opened from the home screen; empty = none.   |
| `playerViewportWidth`  | CSS px width stream pages are laid out at in the player (default 1280, desktop layout scaled to fit the TV). 0 = leave the site's own viewport. |
| `nativePlayer`         | `true` (default): games play in the built-in ExoPlayer (server switching, HUD, auto-fallback). `false`: the WebView player below. |
| `directPlayer`         | WebView player only. `true` (default): resolve the stream page's player embed and show just the video full screen with autoplay; OK = play/pause, Back = home. `false`: show the site's stream page (server tabs etc.). Falls back to the stream page automatically when there is no free embed (premium gate, not started). |
| `parser`               | Object of site-markup rules (regexes, `data-*` attribute names, the status feed path, server-tab and player-embed patterns). Every key is optional and overrides the built-in default in [`ParserRules.java`](app/src/main/java/com/styxsports/tv/ParserRules.java); use it to repair parsing when the site changes its HTML without shipping an APK. |

What the parser relies on (all on the `dataBaseUrl` front page): the category
band buttons (`.m-cat-band__item[data-m-cat]`), the match cards
(`.m-card` with `data-match-id`, `data-time`, `data-team-names`, `data-cat-id`,
`data-league-key`, `data-hot-rank`, `data-pro-only`, `data-mark-home/away`,
and an `href`), the "Load more" buttons (`.m-show-more[data-ids]`, fetched
through `/ajax/ajax_match_cards.php`), and `/data/espn_status_batch.json` for
live clocks and scores. The player relies on the stream page's server tabs
(`li.se-stream > a[href]`, `.is-active` / `.is-pro`), its `iframe#iframe` embed,
and a playlist URL inside the embed chain (a quoted `….m3u8…` string or a
base64 `atob("…")` argument). Premium servers have no iframe: the stream page
itself carries a Clappr player whose playlist URL is a base64 literal of the
*reversed* URL (`atob(s).split('').reverse().join('')`), so the resolver also
tries every long base64 literal on the page, plain and reversed
(`base64Literal`). Live TV reads the personal playlist links off
`authBaseUrl/my-account/?tab=iptv` (`input.acc-iptv-url-input` with ids
`iptv-m3u-plus` and `acc-epg-xmltv`; `iptvUrlInput`) and fetches the M3U Plus
list with `?output=hls` (falls back to the plain MPEG-TS list). If the site
changes any of that, patch the matching `parser` key in `config.json`; as a
last resort flip `nativePlayer` / `nativeHome` to `false`.

### With a new APK (code changes)

1. Bump `versionCode` and `versionName` in `app/build.gradle`
   (`versionName` must equal the git tag without the `v`).
2. Commit, then tag and push: `git tag v1.3 && git push origin master v1.3`.
3. GitHub Actions builds, signs and attaches `StyxSports.apk` to the release.
   Installed apps see the new tag on next launch and offer to update.

The release must be signed with the **same key** as the build already on the TV,
otherwise Android refuses the update. CI reads that key from the repository
secrets `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`;
tag builds fail if they are missing. Locally the same key is used automatically
(the machine's debug keystore), or drop in a git-ignored `keystore.properties`:

```
storeFile=keystore/styxsports.jks
storePassword=...
keyAlias=...
keyPassword=...
```

## Build locally

Requirements: JDK 17 and an Android SDK with `platforms;android-35` and
`build-tools;35.0.0`. Point `local.properties` at the SDK (`sdk.dir=...`).

```powershell
.\gradlew.bat assembleRelease
# → app\build\outputs\apk\release\StyxSports.apk
```

## Logo

`art/styx-wordmark.png` is the source "STYX" mark. `art/make-logo.ps1` sets "SPORTS" beside it in
Bodoni Moda Black (`art/fonts`, SIL Open Font License) and regenerates the in-app wordmark, the
launcher icons, the TV banner and `art/logo-banner.png`.
