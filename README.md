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
2. In Downloader, enter `sports.styxam.com/apk` (short for
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
  cookie jar. Team crests are proxied too (`/img`). `/apk` redirects to the
  latest release.
- `web/public/` is the front end (no build step): the home screen with sport
  chips, Continue watching, Your teams (right-click / long-press a card to
  star), Live now and per-sport rows; live clocks and scores refresh every
  30 s. Arrow keys move between cards like a D-pad, Enter plays, Esc closes.
  The player uses hls.js with the same server switching (← →, or the server
  chips), automatic fallback and a 6 s "race" to the next server when the first
  one is slow.
- Some CDNs refuse requests from Cloudflare's network (they answer 403 even with
  a valid token, and their tokens are bound to the IP that fetched the player
  page, so the Worker cannot mint one for the viewer either). The Worker checks
  each playlist once when resolving a server and flags it `playable: false`.
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
base64 `atob("…")` argument). If the site changes any of that, patch the matching
`parser` key in `config.json`; as a last resort flip `nativePlayer` /
`nativeHome` to `false`.

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
