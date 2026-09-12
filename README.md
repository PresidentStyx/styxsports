# Styx Sports (Android TV / Fire TV)

A tiny native Android TV app that wraps `https://v5.gostreameast.link/` in a
fullscreen WebView, tuned for a TV remote.

- Shows up in the Android TV / Google TV / Fire TV launcher (leanback entry + banner).
- D-pad drives an on-screen pointer; **OK** clicks (hold OK + D-pad to drag).
- Pointer near a screen edge scrolls the page.
- **Back** leaves fullscreen video → goes back in history → exits.
- **Menu** reloads the page. **Play/Pause** toggles a same-origin `<video>`.
- Fullscreen HTML5 video is supported.
- Top-level navigation is pinned to `*streameast*` hosts; pop-under ads, redirect
  chains and `market://`-style links are dropped so the remote never gets stuck.
- Desktop user-agent so the site serves its full layout on a 1080p screen.
- No third-party libraries; the APK is ~40 KB.

## Install with Downloader (Fire Stick / Google TV)

1. On the TV, enable installs from unknown sources for **Downloader**
   (Fire TV: Settings → My Fire TV → Developer Options → Install unknown apps;
   Google TV: Settings → Apps → Security & restrictions → Unknown sources).
2. Host `dist/StyxSports-v1.0.apk` somewhere the TV can reach (a GitHub release,
   or any HTTP URL on your LAN).
3. In Downloader, enter that URL, wait for the download, then choose **Install**.

## Build locally

Requirements: JDK 17 and an Android SDK with `platforms;android-35` and
`build-tools;35.0.0`. Point `local.properties` at the SDK (`sdk.dir=...`).

```powershell
.\gradlew.bat assembleRelease
# → app\build\outputs\apk\release\StyxSports-release-v1.0.apk
```

The release build is signed with the local debug keystore unless a
`keystore.properties` file (git-ignored) is present:

```
storeFile=keystore/styxsports.jks
storePassword=...
keyAlias=...
keyPassword=...
```

## Build in GitHub Actions

`.github/workflows/build.yml` builds the release APK on every push and uploads it
as a workflow artifact. Pushing a tag such as `v1.0` also attaches the APK to a
GitHub Release, which gives Downloader a stable public URL. To sign with your own
key in CI, add the secrets `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`
and `KEY_PASSWORD`.

## Changing the site

Edit `HOME_URL` and `ALLOWED_HOST_FRAGMENTS` in
`app/src/main/java/com/styxsports/tv/MainActivity.java`, bump `versionCode` in
`app/build.gradle`, and rebuild.
