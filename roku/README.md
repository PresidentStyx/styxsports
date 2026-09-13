# Styx Sports for Roku

The Android TV app rebuilt as a Roku channel (BrightScript / SceneGraph). It reads the site
directly from the Roku, plays HLS in Roku's own player, and shares `config.json` (and its
`parser` regex overrides) with the APK and the web version.

## Install (sideload)

1. Put the Roku in developer mode once: on the remote press **Home ×3, Up ×2, Right, Left,
   Right, Left, Right**. Enable the *Development Application Installer*, accept the agreement,
   set a password, let it reboot. Note the IP it shows (also under Settings → Network → About).
2. On a Windows PC on the same network:

   ```
   cd roku
   .\deploy.ps1 -RokuIp 192.168.1.50 -Password <dev password>
   ```

   First run installs the build tools with npm (Node.js required). The script validates the
   code, zips it to `out/StyxSports.zip`, removes the previous sideload and installs the new one.
   Rerun it to update; there is no self-update on Roku. Only one sideloaded channel can exist per
   device. `-BuildOnly` just produces the zip (upload it by hand at `http://<RokuIp>/`).
3. Debug console (prints, crashes): `telnet <RokuIp> 8085`.

## Layout

```
manifest                 channel metadata, artwork paths
source/main.brs          entry point (roSGScreen + MainScene)
source/lib/
  Util.brs               strings, regex helpers (matchAll / matchSpans), URL + HTML helpers, base64
  Http.brs               roUrlTransfer with a persistent cookie jar (registry) - the SSO cookies and
                         the premium session live here
  Config.brs             defaults + config.json cache/refresh; Parser_defaults() = ParserRules.java
  SiteParser.brs         listing page -> categories + events; load-more controls; status feed merge
  Site.brs               full schedule fetch (listing, AJAX batches, per-sport pages, status),
                         domain discovery via the gateway, snapshot cache in cachefs:/
  Resolver.brs           stream page -> server tabs -> embed chain -> HLS URL (plain / atob /
                         reversed base64 for the premium inline player)
  Account.brs            TV sign-in flow (code, poll, login), status check, sign out, IPTV link discovery
  Iptv.brs               M3U (output=hls) download + parse; per-group JSON files in cachefs:/; recents
  Store.brs              favorites, Continue watching, remembered chip (registry)
  Ui.brs                 colours, time labels, Task launcher, EventNode <-> event record
components/
  MainScene.*            screen stack; screens navigate via `navigate` / `close` fields
  tasks/NetTask.*        the single background worker; `op` selects the job
  home/                  HomeScreen (top bar, chips, RowList), EventCard (row item), EventNode
  player/PlayerScreen.*  Video node + HUD + status panel; game mode and IPTV channel mode
  account/AccountScreen.* sign-in (code + QR via api.qrserver.com) / signed-in summary
  livetv/                LiveTvScreen (LabelList groups + MarkupGrid channels), ChannelCell, ChannelNode
  common/Pill.*          chip / button
tools/make-images.ps1    regenerates images/ from web/public/wordmark.png
deploy.ps1               build + sideload
```

## Remote

| Where | Key | Does |
|---|---|---|
| Home | ▲ from the first row | sport chips; ▲ again: Refresh / Sign in |
| Home | `*` on a card | star home team / away team / league |
| Home | `*` elsewhere, or Refresh | reload the schedule (and recheck the account) |
| Player | ◀ ▶ | previous / next server (or channel) |
| Player | OK / ▲ | show or hide the HUD; ▼ hides it |
| Player | Play/Pause | pause / resume |
| Player | `*` | try all servers again |
| Live TV | ◀ ▶ | between groups and channels; `*` refreshes the list |

## Verified so far / still to verify on a device

Without a Roku on the network nothing here has run on real hardware yet. What has been checked:

- `npx bsc` (BrighterScript) validates every file: syntax, scope, unknown functions.
- The shared libraries were executed with the `brs` interpreter against a real listing page,
  status feed and stream page: 4 categories / 57 games parsed with crests, clocks and scores;
  the JSON cache round-trips; 12 server tabs parsed with premium flags, player state and the
  embed URL; the M3U parser handles CRLF, missing logos and sports-first ordering.

First things to watch on the debug console when a device is available:

1. `roUrlTransfer.GetCookies("", "")` returning every domain's cookies (the jar). If not, the
   SSO handshake fails and pages come back empty: fix in `CookieJar_collectFrom`.
2. The account status check tells signed-in from signed-out by page content
   (`Account_refreshStatus`), because Roku hides the final URL after redirects.
3. `Video` node `addHeader` for `Referer`/`Origin` (ifHttpAgent on the node). If the CDN 403s,
   switch to `content.HttpHeaders` in `playUrl`.
4. Registry size: cookies + config + favorites + recents must stay under 16 KB total.
5. `Pill` widths come from `Label.boundingRect()` right after setting the text.
