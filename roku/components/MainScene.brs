sub init()
    m.top.backgroundColor = Ui_color("bg")
    m.top.backgroundUri = ""
    m.screens = m.top.findNode("screens")
    m.stack = []

    ' Shared config for every screen; refreshed in the background right away. dumpTick is bumped by
    ' the "dump" dev command so RowList/MarkupGrid items (not reachable from the tree) dump too.
    ' leaseHeld/leaseLabel: the shared premium pool lease (see Pool.brs). A screen that gets a
    ' slot granted sets leaseHeld = true (the scene then heartbeats it); whoever owns it sets it
    ' back to false when playback stops, which releases the slot. main.brs releases on exit.
    ' poolInfoAt: bumped after each presence ping refreshed what the shared account offers.
    m.global.addFields({ config: Config_load(), dumpTick: 0, leaseHeld: false, leaseLabel: "", poolInfoAt: 0 })
    m.configTask = Ui_task("config", {}, "onConfigRefreshed")

    m.presenceTimer = m.top.findNode("presenceTimer")
    m.presenceTimer.observeField("fire", "onPresenceTick")
    m.presenceTimer.control = "start"
    presencePing()

    m.leaseTimer = m.top.findNode("leaseTimer")
    m.leaseTimer.observeField("fire", "onLeaseTick")
    m.global.observeField("leaseHeld", "onLeaseHeld")
    m.global.observeField("leaseLabel", "onLeaseLabel")

    pushScreen("HomeScreen", {})
end sub

sub onPresenceTick()
    presencePing()
end sub

sub presencePing()
    m.presenceTask = Ui_task("ping", {}, "onPinged")
end sub

sub onPinged(ev as object)
    m.global.poolInfoAt = m.global.poolInfoAt + 1
end sub

' ---------------------------------------------------------------------------------------------
' Shared premium pool lease: heartbeat while held, release when dropped
' ---------------------------------------------------------------------------------------------

sub onLeaseHeld()
    if m.global.leaseHeld
        m.leaseTimer.control = "stop"
        m.leaseTimer.control = "start"
    else
        m.leaseTimer.control = "stop"
        m.releaseTask = Ui_task("poolRelease", {}, "onLeaseReleased")
    end if
end sub

' A new label (the channel being watched, say) goes out right away so /stats stays current.
sub onLeaseLabel()
    if m.global.leaseHeld then onLeaseTick()
end sub

sub onLeaseTick()
    if not m.global.leaseHeld then return
    m.beatTask = Ui_task("poolHeartbeat", { label: m.global.leaseLabel }, "onLeaseBeat")
end sub

sub onLeaseBeat(ev as object)
    r = ev.getData()
    ' granted = false from a heartbeat means the lease expired and the slot may be someone
    ' else's now; the current stream keeps playing, but the next premium pick re-acquires.
    if r <> invalid and r.ok = true and r.granted = false and m.global.leaseHeld
        logi("Pool", "lease lost")
        m.global.leaseHeld = false
    end if
end sub

sub onLeaseReleased(ev as object)
end sub

sub onConfigRefreshed(ev as object)
    r = ev.getData()
    if r <> invalid and r.changed = true then m.global.config = Config_load()
end sub

' Developer commands (only reachable from the LAN via ECP while sideloaded):
'   cmd=dump           print the on-screen layout as JSON lines for tools/layout-shot.ps1
'   cmd=key&key=down   act on a remote key (this TV refuses ECP keypress with 403); screens
'                      implement `devKey` and route it through the same code as real keys
'   cmd=livetvdemo     seed a small stand-in channel list (no account needed) and open Live TV,
'                      to check that screen's layout on a signed-out device
'   cmd=lease&on=1|0   take / drop a slot in the shared premium pool by hand (no account needed),
'                      to watch this device's lease and heartbeats appear on sports.styxam.com/stats
sub onDevCmd()
    info = parseJsonSafe(m.top.devCmd)
    if info = invalid or info.cmd = invalid then return
    if info.cmd = "dump"
        Dev_dumpTree(m.top, true)
        m.global.dumpTick = m.global.dumpTick + 1
    else if info.cmd = "livetvdemo"
        Dev_seedLiveTv()
        pushScreen("LiveTvScreen", {})
    else if info.cmd = "play" and info.url <> invalid
        ' Play one URL in the channel player (redirect / header experiments against a test server).
        ch = { name: "dev stream", logo: "", group: "dev", url: info.url, tvgId: "" }
        pushScreen("PlayerScreen", { channelGroup: { name: "dev", channels: [ch] }, channelIndex: 0 })
    else if info.cmd = "probe" and info.url <> invalid
        ' Fetch a URL with roUrlTransfer and print status, headers and the body head.
        m.probeTask = Ui_task("probe", { url: info.url }, "onDevProbe")
    else if info.cmd = "lease"
        if info.on = "1"
            m.devLeaseTask = Ui_task("poolAcquire", { kind: "game", label: "dev lease" }, "onDevLease")
        else
            m.global.leaseHeld = false
        end if
    else if info.cmd = "key" and info.key <> invalid
        key = LCase(info.key)
        if key = "ok" then key = "OK"
        if key = "back" and m.stack.Count() > 1
            popScreen()
        else if m.stack.Count() > 0
            top = m.stack.Peek()
            if top.hasField("devKey") then top.devKey = key
        end if
    end if
end sub

sub onDevProbe(ev as object)
    r = ev.getData()
    if r <> invalid then print "[probe] "; FormatJson(r)
end sub

sub onDevLease(ev as object)
    r = ev.getData()
    if r <> invalid and r.granted = true
        m.global.leaseLabel = "dev lease"
        m.global.leaseHeld = true
    end if
end sub

' Stand-in playlist cache for cmd=livetvdemo: the shape Iptv_fetch writes, with made-up names.
sub Dev_seedLiveTv()
    names = ["UK | Sport", "UK | TNT Sport", "UK | Sky Sports", "UK | Sky Sports+", "CA | Sport", "ES | Desportes", "PT | Desporto", "BR | Esportes", "DE | Sky Sports", "US | Sport", "FR | Sport"]
    counts = [22, 31, 40, 60, 17, 65, 71, 108, 24, 45, 33]
    groups = []
    total = 0
    for i = 0 to names.Count() - 1
        chans = []
        for j = 1 to counts[i]
            nm = "Channel " + j.ToStr() + " HD"
            if j mod 3 = 1 then nm = "Eurosport " + j.ToStr() + " FHD"
            if j mod 4 = 0 then nm = "Premier Sports " + j.ToStr() + " FHD"
            chans.Push({ name: nm, logo: "", group: names[i], url: "https://example.invalid/" + j.ToStr() + ".m3u8", tvgId: "" })
        end for
        WriteAsciiFile(Iptv_groupPath(i), FormatJson(chans))
        groups.Push({ name: names[i], count: counts[i], file: Iptv_groupPath(i) })
        total += counts[i]
    end for
    WriteAsciiFile(Iptv_indexPath(), FormatJson({ fetchedAt: nowSeconds(), channelCount: total, groups: groups }))
end sub

' ---------------------------------------------------------------------------------------------
' Screen stack
' ---------------------------------------------------------------------------------------------

sub pushScreen(name as string, args as object)
    screen = CreateObject("roSGNode", name)
    if screen = invalid then return
    screen.observeField("navigate", "onNavigate")
    screen.observeField("close", "onScreenClose")
    for each k in args
        if screen.hasField(k) then screen[k] = args[k]
    end for
    if m.stack.Count() > 0
        top = m.stack.Peek()
        top.visible = false
    end if
    m.stack.Push(screen)
    m.screens.appendChild(screen)
    screen.setFocus(true)
    ' Arguments are all in place now; screens that need them to start wait for this.
    if screen.hasField("start") then screen.start = true
end sub

sub popScreen()
    if m.stack.Count() <= 1 then return
    screen = m.stack.Pop()
    screen.unobserveField("navigate")
    screen.unobserveField("close")
    m.screens.removeChild(screen)
    ' The screen that took the shared premium slot is gone: release it (playback stopped).
    if screen.hasField("holdsLease") and screen.holdsLease = true and m.global.leaseHeld then m.global.leaseHeld = false
    top = m.stack.Peek()
    top.visible = true
    top.setFocus(true)
    if top.hasField("resumed") then top.resumed = true
end sub

sub onNavigate(ev as object)
    req = ev.getData()
    if req = invalid or isEmpty(req.screen) then return
    args = {}
    for each k in req
        if k <> "screen" then args[k] = req[k]
    end for
    pushScreen(req.screen, args)
end sub

sub onScreenClose(ev as object)
    if ev.getData() = true then popScreen()
end sub

' Back on the home screen exits the channel; anywhere else it pops the screen.
function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "back"
        if m.stack.Count() > 1
            popScreen()
            return true
        end if
    end if
    return false
end function
