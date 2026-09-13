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
tools/layout-shot.ps1    draws what the running channel shows (see Developer tools)
deploy.ps1               build + sideload
```

## Developer tools

Hisense Roku TVs return a black image from Roku's screenshot utility, and refuse ECP `keypress`
(403), so the channel carries two small hooks reachable only over the LAN while sideloaded
(`main.brs` -> `MainScene.onDevCmd`):

```powershell
# picture of the current screen: every visible node's device-measured rectangle, text, colour,
# drawn with System.Drawing; labels the device reports as ellipsized are underlined in red and
# listed. Geometry is exact, glyphs are approximate.
.\tools\layout-shot.ps1 -Ip <RokuIp> -Out $env:TEMP\home.png

# remote keys (down/up/left/right/ok/back/options/play) routed through the same code as real keys
curl -X POST "http://<RokuIp>:8060/input?cmd=key&key=down"
```

`layout-shot.ps1` uses the RowList/MarkupGrid geometry to place their items, because Roku reports
item rectangles in an internal coordinate space.

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

## Verified on a device (Hisense 58R6+, Roku OS 15.3.4)

- Schedule loads through the SSO cookie handshake (50+ games, 4 categories), home renders with
  three rows of 572px cards, chips and top buttons; no label truncation reported by the device.
- Opening a game resolves the server list (11-14 servers) and plays Server 1 over native HLS
  (`Video.state = playing`); HUD shows period, score, server counter.
- Premium Only chip shows the premium-flagged cards; the account screen issues a device code and
  QR and polls for approval.
- Still to try with a signed-in account: premium server playback and the Live TV screen.

Things learned the hard way, in case they bite again:

1. `roFileSystem` is MAIN/TASK-only; on the render thread use `MatchFiles` / `ReadAsciiFile`.
2. `roUrlTransfer.GetCookies()` records carry `Expires` as an `roDateTime`, which `FormatJson`
   rejects; the jar stores a normalized form (`CookieJar_normalize`).
3. `Label.boundingRect()` is unreliable before the first frame; `Pill` takes the larger of the
   measurement and a character-count estimate.
4. Registry size: cookies + config + favorites + recents must stay under 16 KB total.
