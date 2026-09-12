# Styx Sports (Android TV / Fire TV)

![Styx Sports](art/logo-banner.png)

A small native Android TV app for StreamEast: a real TV-style home screen
built from the site's schedule, with a WebView only for the player.

- Shows up in the Android TV / Google TV / Fire TV launcher (leanback entry + banner).
- **Native home**: rows per sport ("Live Now" first) of focusable cards with
  team crests, live clock and score, kick-off time, trending / premium badges.
  D-pad moves between cards, **OK** opens the stream, **Menu** refreshes,
  **Back** exits. Live clocks refresh every minute, the schedule every 5.
- The schedule is parsed from the site's match cards (the site has no event
  JSON; the cards carry everything as `data-*` attributes) plus its live-status
  feed. The last result is cached, so the home paints instantly on launch.
- If the site's domain changes, the app follows the mirror links on the
  gateway page to find the new one, and remembers it.
- **Player**: the stream page opens in a WebView with the site's header, chat,
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
- **Self-updating**: checks GitHub Releases on launch and offers a one-click install.

## Install with Downloader (Fire Stick / Google TV)

1. On the TV, enable installs from unknown sources for **Downloader**
   (Fire TV: Settings → My Fire TV → Developer Options → Install unknown apps;
   Google TV: Settings → Apps → Security & restrictions → Unknown sources).
2. In Downloader, enter the Downloader code for this app, or the URL
   `https://github.com/PresidentStyx/styxsports/releases/latest/download/StyxSports.apk`.
3. Choose **Install**.

After that, updates are offered inside the app. The first time you accept one,
Android asks you to allow Styx Sports to install apps (same toggle as for
Downloader); every later update is a single **Install** click.

## Making changes

### Without a new APK (remote config)

Edit [`config.json`](config.json) and push to `master`. Every TV picks it up on
the next launch (raw.githubusercontent.com caches for up to ~5 minutes).

| Key                    | Purpose                                                                     |
|------------------------|-----------------------------------------------------------------------------|
| `homeUrl`              | Gateway page: used by "Open website", the WebView-only mode, and domain discovery. |
| `dataBaseUrl`          | Site origin whose listing HTML the native home parses (e.g. `https://v2.streameast.ga`). Auto-discovered via `homeUrl` when it fails. |
| `nativeHome`           | `false` = kill switch: launch straight into the WebView on `homeUrl`.       |
| `allowedHostFragments` | Top-level navigation is allowed only to hosts containing one of these.      |
| `blockedHostFragments` | Any request to a host containing one of these is dropped (ad blocking).     |
| `userAgent`            | Override the built-in desktop UA; empty = default.                          |
| `pageScript`           | Extra JavaScript run after every page load; empty = none.                   |
| `playerCss`            | CSS injected into stream pages opened from the home screen (hides site chrome, makes the player fill the width). Empty = built-in default. |
| `playerScript`         | JavaScript run on stream pages opened from the home screen; empty = none.   |
| `playerViewportWidth`  | CSS px width stream pages are laid out at in the player (default 1280, desktop layout scaled to fit the TV). 0 = leave the site's own viewport. |
| `directPlayer`         | `true` (default): picking a game resolves the stream page's player embed and shows just the video full screen with autoplay; OK = play/pause, Back = home. `false`: show the site's stream page (server tabs etc.) as before. Falls back to the stream page automatically when there is no free embed (premium gate, not started). |

What the parser relies on (all on the `dataBaseUrl` front page): the category
band buttons (`.m-cat-band__item[data-m-cat]`), the match cards
(`.m-card` with `data-match-id`, `data-time`, `data-team-names`, `data-cat-id`,
`data-league-key`, `data-hot-rank`, `data-pro-only`, `data-mark-home/away`,
and an `href`), the "Load more" buttons (`.m-show-more[data-ids]`, fetched
through `/ajax/ajax_match_cards.php`), and `/data/espn_status_batch.json` for
live clocks and scores. If the site changes that markup, flip `nativeHome` to
`false` until the parser is updated.

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
