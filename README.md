# Styx Sports (Android TV / Fire TV)

![Styx Sports](art/logo-banner.png)

A tiny native Android TV app that wraps StreamEast in a fullscreen WebView,
tuned for a TV remote.

- Shows up in the Android TV / Google TV / Fire TV launcher (leanback entry + banner).
- D-pad drives an on-screen pointer; **OK** clicks (hold OK + D-pad to drag).
- Pointer near a screen edge scrolls the page.
- **Back** leaves fullscreen video → goes back in history → exits.
- **Menu** reloads the page. **Play/Pause** toggles a same-origin `<video>`.
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
| `homeUrl`              | Page loaded on launch. Change this when the site moves domains.             |
| `allowedHostFragments` | Top-level navigation is allowed only to hosts containing one of these.      |
| `blockedHostFragments` | Any request to a host containing one of these is dropped (ad blocking).     |
| `userAgent`            | Override the built-in desktop UA; empty = default.                          |
| `pageScript`           | Extra JavaScript run after every page load; empty = none.                   |

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

`art/styx-wordmark.png` is the source wordmark. `art/make-logo.ps1` regenerates
the launcher icons, the TV banner and `art/logo-banner.png` from it.
