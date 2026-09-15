' Port of NativePlayerActivity: the ExoPlayer is a Video node, the HUD / status panel are drawn
' with the same fonts, colours and spacing (Android dp x 2).

sub init()
    m.video = m.top.findNode("video")
    m.hud = m.top.findNode("hud")
    m.hudTop = m.top.findNode("hudTop")
    m.hudBottom = m.top.findNode("hudBottom")
    m.topScrim = m.top.findNode("topScrim")
    m.bottomScrim = m.top.findNode("bottomScrim")
    m.hudPillBg = m.top.findNode("hudPillBg")
    m.hudPill = m.top.findNode("hudPill")
    m.hudTitle = m.top.findNode("hudTitle")
    m.hudScore = m.top.findNode("hudScore")
    m.hudServer = m.top.findNode("hudServer")
    m.hudHint = m.top.findNode("hudHint")
    m.hintLeft = m.top.findNode("hintLeft")
    m.hintRight = m.top.findNode("hintRight")
    m.hudHintText = m.top.findNode("hudHintText")
    m.hudAnim = m.top.findNode("hudAnim")
    m.hudInterp = m.top.findNode("hudInterp")
    m.status = m.top.findNode("status")
    m.spinner = m.top.findNode("spinner")
    m.statusText = m.top.findNode("statusText")
    m.statusButtons = m.top.findNode("statusButtons")
    m.hudTimer = m.top.findNode("hudTimer")
    m.retryTimer = m.top.findNode("retryTimer")
    m.scoreTimer = m.top.findNode("scoreTimer")
    m.layoutTimer = m.top.findNode("layoutTimer")

    ' --- type: pill 12 sp bold, title 22 sp bold, score 16 sp, server 16 sp bold, hint 13 sp, status 17 sp
    m.hudPill.font = Ui_font(Ui_sp(12), true)
    m.hudPill.color = "0xFFFFFFFF"
    m.hudTitle.font = Ui_font(Ui_sp(22), true)
    m.hudTitle.color = "0xFFFFFFFF"
    m.hudScore.font = Ui_font(Ui_sp(16), false)
    m.hudScore.color = "0xDDDDDDFF"
    m.hudServer.font = Ui_font(Ui_sp(16), true)
    m.hudServer.color = "0xFFFFFFFF"
    m.hudHintText.font = Ui_font(Ui_sp(13), false)
    m.hudHintText.color = "0xBBBBBBFF"
    m.hintLeft.blendColor = "0xBBBBBBFF"
    m.hintRight.blendColor = "0xBBBBBBFF"
    m.statusText.font = Ui_font(Ui_sp(17), false)
    m.statusText.color = "0xFFFFFFFF"
    m.spinner.poster.uri = "pkg:/images/ui/spinner.png"
    m.spinner.poster.width = 80
    m.spinner.poster.height = 80
    m.hudPillBg.visible = false
    m.hudPill.visible = false
    m.hudScore.visible = false

    m.channelMode = false
    m.servers = []          ' game: [{name, pageUrl, active, premium}]  channel: [{name, logo, url, ...}]
    m.streams = {}          ' server index -> resolved stream (game mode)
    m.failed = {}           ' server index -> true
    m.index = -1
    m.pendingIndex = -1
    m.started = false
    m.everPlayed = false
    m.paused = false
    m.hudShown = true
    m.statusDefs = []
    m.statusNodes = []
    m.statusIndex = 0
    m.resolveSeq = 0
    m.pendingNext = -1
    m.activeIndex = 0
    ' Shared premium pool (Pool.brs): why we are on a free server, if the pool said no.
    m.leaseSeq = 0
    m.poolNote = ""
    m.poolFull = false
    m.poolUsed = 0
    m.poolMax = 5
    ' Playback telemetry (Telemetry.brs): the attempt on screen, flushed every minute.
    m.attempt = invalid
    m.telemetryTimer = m.top.findNode("telemetryTimer")
    ' Self-healing (4.0 phase 2.2; NativePlayerActivity DEGRADE_*): a stream that keeps playing
    ' but badly - 3 stalls within 2 min, or 2 stalls longer than 15 s - is left for the next best
    ' server, resolved in the background while it limps on, then switched to with a "Switching…"
    ' note; the error screen only when every candidate fails. One Video node: the switch itself
    ' is a moment of black, never a spinner over a dead stream.
    m.health = { stalls: [], long: 0, stallAt: 0 }
    m.migrating = invalid   ' { why, from, idx, seq, askedAt } while a candidate is being readied
    m.degraded = {}         ' server index -> true: left as degraded, not migrated back to this sitting

    m.video.observeField("state", "onVideoState")
    m.hudTimer.observeField("fire", "onHudTimer")
    m.retryTimer.observeField("fire", "onRetryTimer")
    m.scoreTimer.observeField("fire", "onScoreTick")
    m.layoutTimer.observeField("fire", "onLayoutTimer")
    m.telemetryTimer.observeField("fire", "onTelemetryTimer")
    m.telemetryTimer.control = "start"
    setHint()
    layoutHud()
end sub

' The scene sets `start` once every argument field is in place.
sub onStart()
    if m.started or not m.top.start then return
    if m.top.channelGroup <> invalid and m.top.channelGroup.channels <> invalid
        m.started = true
        startChannels()
    else if m.top.event <> invalid and not isEmpty(m.top.event.url)
        m.started = true
        startGame()
    else
        showStatusWithActions("Nothing to play." + Chr(10) + "This screen was opened without a game or channel.", [{ key: "back", text: "Back to home" }])
    end if
end sub

sub onResumed()
    ' Back from the account screen: a fresh sign-in unlocks premium servers, so try again.
    if m.top.resumed and panelUp() and Account_isSignedIn() then retryAll()
end sub

' ---------------------------------------------------------------------------------------------
' Game mode
' ---------------------------------------------------------------------------------------------

sub startGame()
    e = m.top.event
    bindHud()
    showHud()
    showStatus("Connecting…", true)
    m.askedAt = Telemetry_now()
    if e.live then m.scoreTimer.control = "start"
    ' What Home resolved while the card had focus (Prefetch.brs): the server tabs, and streams
    ' that play straight away. Anything older than 90 s is not trusted (signed, IP-bound URLs).
    pf = m.global.prefetch
    if pf <> invalid and pf.id = e.id and pf.page <> invalid and pf.at <> invalid and nowSeconds() - pf.at < 90
        logi("Player", "stream page from prefetch")
        m.pre = pf.streams
        if m.pre = invalid then m.pre = {}
        applyPage({ ok: true, servers: pf.page.servers, activeIndex: pf.page.activeIndex, stream: invalid })
        return
    end if
    m.pre = {}
    m.resolveSeq += 1
    ' preferPremium: the active free server's embed chain is skipped when a premium tab will be
    ' tried first anyway (up to 20 s on a slow embed host).
    Ui_task("resolvePage", { url: e.url, seq: m.resolveSeq, preferPremium: premiumCapable() }, "onPage")
end sub

sub onPage(ev as object)
    r = ev.getData()
    if r = invalid then return
    applyPage(r)
end sub

sub applyPage(r as object)
    if r.ok <> true
        showStatusWithActions("Couldn’t open this game." + Chr(10) + strOr(r.error, "unknown error"), retryBackButtons())
        return
    end if
    m.servers = r.servers
    m.streams = {}
    m.failed = {}
    m.degraded = {}
    m.migrating = invalid
    if r.stream <> invalid then m.streams[r.activeIndex.ToStr()] = r.stream
    m.activeIndex = r.activeIndex
    ' Pre-resolved streams sit under their server's index; their start is reported as "pre".
    m.preIndex = {}
    if m.pre <> invalid
        for i = 0 to m.servers.Count() - 1
            st = m.pre[m.servers[i].pageUrl]
            if st <> invalid and st.hlsUrl <> invalid
                m.streams[i.ToStr()] = st
                m.preIndex[i.ToStr()] = true
            end if
        end for
        if m.preIndex.Count() > 0 then logi("Player", m.preIndex.Count().ToStr() + " server(s) pre-resolved")
    end if

    ' Signed in with premium tabs on the page: this device's session is the shared premium
    ' account, so take a slot in its 5-connection pool before touching a premium server (like
    ' app.js resolvePage). Denied: the free servers are used and the viewer is told.
    if wantsLease()
        showStatus("Connecting…", true)
        m.leaseSeq += 1
        Ui_task("poolAcquire", { kind: "game", label: Event_title(m.top.event), seq: m.leaseSeq }, "onPageLease")
        return
    end if
    arrangeServers()
end sub

' A premium server may be used only with a pool slot (signed in, account not known to be locked).
function wantsLease() as boolean
    if m.channelMode or not premiumCapable() then return false
    if m.global.leaseHeld then return false
    for each s in m.servers
        if s.premium = true then return true
    end for
    return false
end function

' Some premium is reachable from this device: its own signed-in account (not known to be
' locked), or the account shared through the pool (resolved via the Worker, see Pool.brs).
function premiumCapable() as boolean
    if Account_isSignedIn() then return Account_premiumKnown() <> "no"
    return Pool_sharedAvailable()
end function

function premiumAllowed() as boolean
    return m.global.leaseHeld and premiumCapable()
end function

sub onPageLease(ev as object)
    r = ev.getData()
    if r = invalid or m.servers.Count() = 0 then return
    noteLease(r, "game")
    arrangeServers()
end sub

' Records a pool answer: granted -> the scene heartbeats the lease from now on; otherwise the
' player says why it is on a free server.
sub noteLease(r as object, kind as string)
    if r.granted = true
        m.global.leaseLabel = leaseLabel()
        m.global.leaseHeld = true
        ' The scene releases the slot when this screen is popped (any way it closes).
        if not m.channelMode then m.top.holdsLease = true
        m.poolNote = ""
        m.poolFull = false
    else
        m.poolFull = (r.ok = true)
        if r.ok = true
            m.poolNote = "Premium is full (" + r.used.ToStr() + "/" + r.max.ToStr() + "). Using a free server."
        else
            m.poolNote = "Couldn’t reach the premium pool. Using a free server."
        end if
        m.poolUsed = r.used
        m.poolMax = r.max
    end if
end sub

function leaseLabel() as string
    if m.channelMode
        if m.index >= 0 and m.index < m.servers.Count() then return Iptv_displayName(m.servers[m.index])
        return "Live TV"
    end if
    return Event_title(m.top.event)
end function

' Picks the first server to try: a premium tab when we hold a slot (they are the better ones),
' else the page's active free server. Premium-only pages without a slot show why.
sub arrangeServers()
    start = m.activeIndex
    if premiumAllowed()
        if not m.servers[start].premium
            for i = 0 to m.servers.Count() - 1
                if m.servers[i].premium
                    start = i
                    exit for
                end if
            end for
        end if
    else
        allPremium = true
        for each s in m.servers
            if not s.premium then allPremium = false
        end for
        if allPremium
            if premiumCapable() and m.poolFull = true
                showPoolFullPanel()
            else
                showPremiumOnlyPanel()
            end if
            return
        end if
        if m.servers[start].premium
            for i = 0 to m.servers.Count() - 1
                if not m.servers[i].premium
                    start = i
                    exit for
                end if
            end for
        end if
    end if
    switchTo(start)
end sub

sub switchTo(i as integer)
    if i < 0 or i >= m.servers.Count() then return
    m.index = i
    m.paused = false
    m.migrating = invalid ' a switch by hand or by the sweep supersedes any migration under way
    m.video.control = "stop"
    Telemetry_stop(m.attempt)
    m.attempt = invalid
    hideStatus()
    bindServerLabel()
    if m.channelMode
        c = m.servers[i]
        m.hudTitle.text = Iptv_displayName(c)
        layoutHud()
        showStatus(connectingTo(Iptv_displayName(c)), true)
        showHud()
        ' The Live TV screen holds the pool slot; keep /stats showing what is on.
        if m.global.leaseHeld then m.global.leaseLabel = Iptv_displayName(c)
        ' Check the playlist from here first: it redirects to the edge that serves the (IP-bound)
        ' segments, and a warming.ts placeholder means the channel has no video yet.
        m.resolveSeq += 1
        m.pendingIndex = i
        Ui_task("checkPlaylist", { url: c.url, seq: m.resolveSeq }, "onChannelChecked")
        return
    end if
    s = m.servers[i]
    showStatus(connectingTo(s.name), true)
    showHud()
    ' A premium tab picked by hand (or after the lease was lost): (re)acquire a slot first.
    if s.premium = true and premiumCapable() and not m.global.leaseHeld
        m.leaseSeq += 1
        m.pendingIndex = i
        Ui_task("poolAcquire", { kind: "game", label: Event_title(m.top.event), seq: m.leaseSeq }, "onSwitchLease")
        return
    end if
    resolveCurrent(i)
end sub

sub onChannelChecked(ev as object)
    r = ev.getData()
    if r = invalid or m.pendingIndex < 0 then return
    i = m.pendingIndex
    m.pendingIndex = -1
    if i <> m.index or not m.channelMode then return ' user zapped on
    c = m.servers[i]
    if r.ok = true and r.warming = true
        onFailure("warming", "warming.ts placeholder")
    else if r.ok <> true and r.code >= 400
        onFailure("cdn", strOr(r.error, "HTTP " + r.code.ToStr()))
    else
        url = c.url
        if r.ok = true and isStr(r.url) and r.url <> "" then url = r.url
        playUrl(url, "", c.name)
    end if
end sub

sub onSwitchLease(ev as object)
    r = ev.getData()
    if r = invalid or m.pendingIndex < 0 then return
    i = m.pendingIndex
    m.pendingIndex = -1
    if i <> m.index then return ' user moved on
    noteLease(r, "game")
    if r.granted = true
        resolveCurrent(i)
    else
        onFailure("pool", m.poolNote)
    end if
end sub

sub resolveCurrent(i as integer)
    s = m.servers[i]
    cached = m.streams[i.ToStr()]
    if cached <> invalid
        playStream(cached)
    else
        m.resolveSeq += 1
        m.pendingIndex = i
        ' A premium tab without an account of our own goes through the Worker, which reads the
        ' page with the shared account (our lease vouches for us) and hands back the playlist.
        op = "resolveServer"
        if s.premium = true and not Account_isSignedIn() then op = "resolveShared"
        Ui_task(op, { server: s, seq: m.resolveSeq, viaPool: m.global.leaseHeld }, "onServerResolved")
    end if
end sub

' np_connecting_to: "Connecting to %1$s…\n\n▶ tries the next server" (the arrow is not in Roboto).
' While the pool turned us down, the reason leads the message.
function connectingTo(name as string) as string
    text = "Connecting to " + name + "…" + Chr(10) + Chr(10) + "Right tries the next server"
    if not isEmpty(m.poolNote) then text = m.poolNote + Chr(10) + Chr(10) + text
    return text
end function

sub onServerResolved(ev as object)
    r = ev.getData()
    if r = invalid or m.pendingIndex < 0 then return
    i = m.pendingIndex
    m.pendingIndex = -1
    if i <> m.index then return ' user moved on
    m.streams[i.ToStr()] = r
    playStream(r)
end sub

sub playStream(stream as object)
    s = stream.server
    if stream.hlsUrl = invalid
        if s.premium and not premiumCapable()
            onFailure("premium", "This server is for the site's premium members")
        else if s.premium and stream.state = "gate"
            if Account_isSignedIn() then Account_notePremium(false)
            onFailure("gated", strOr(stream.error, "Premium server is locked on this account"))
        else if stream.state = "warming"
            ' The CDN's warming.ts placeholder: no video yet on this server, try another.
            onFailure("warming", strOr(stream.error, "still starting up"))
        else
            onFailure("noplayer", strOr(stream.error, "No playable stream on " + s.name))
        end if
        return
    end if
    origin = stream.playerOrigin
    playUrl(stream.hlsUrl, origin, Event_title(m.top.event))
end sub

sub playUrl(url as string, origin as string, title as string)
    m.video.control = "stop"
    ' Telemetry: a relayed stream (through the Worker) carries its CDN inside a signed token,
    ' so the player origin names its family instead.
    relay = startsWith(url, Pool_webBase() + "/")
    cdn = hostOf(url)
    if relay and origin <> "" then cdn = hostOf(origin)
    premium = m.channelMode
    if not m.channelMode and m.index >= 0 and m.servers[m.index].premium = true then premium = true
    game = "tv"
    if not m.channelMode and m.top.event <> invalid then game = strOr(m.top.event.id, "")
    m.attempt = Telemetry_attempt(game, serverName(m.index), cdn, premium, relay)
    m.health = { stalls: [], long: 0, stallAt: 0 }
    ' Time to first frame counts from the press (or the Left/Right switch), not from here:
    ' resolving is part of the wait. A stream Home resolved ahead is a "pre" start.
    if m.askedAt <> invalid then m.attempt.startedAt = m.askedAt
    if m.preIndex <> invalid and m.preIndex[m.index.ToStr()] = true then m.attempt.pre = true
    m.video.setCertificatesFile("common:/certs/ca-bundle.crt")
    m.video.initClientCertificates()
    m.video.addHeader("User-Agent", Http_UA())
    if origin <> ""
        m.video.addHeader("Referer", origin + "/")
        m.video.addHeader("Origin", origin)
    end if
    c = CreateObject("roSGNode", "ContentNode")
    c.url = url
    c.title = title
    c.streamFormat = "hls"
    c.live = true
    m.video.content = c
    m.video.control = "play"
end sub

' ---------------------------------------------------------------------------------------------
' Channel mode
' ---------------------------------------------------------------------------------------------

sub startChannels()
    m.channelMode = true
    m.askedAt = Telemetry_now()
    g = m.top.channelGroup
    m.servers = g.channels
    m.hudPillBg.visible = false
    m.hudPill.visible = false
    m.hudScore.text = ""
    m.hudScore.visible = false
    setHint()
    i = m.top.channelIndex
    if i < 0 or i >= m.servers.Count() then i = 0
    switchTo(i)
end sub

' ---------------------------------------------------------------------------------------------
' Video state
' ---------------------------------------------------------------------------------------------

sub onVideoState()
    st = m.video.state
    if st = "playing"
        if m.attempt <> invalid
            if m.attempt.firstFrameAt = 0 then Telemetry_start(m.attempt) else Telemetry_stallEnded(m.attempt, Int(m.video.position * 1000))
        end if
        if m.health.stallAt > 0
            if Telemetry_now() - m.health.stallAt > DEGRADE_LONG_STALL_MS() then m.health.long += 1
            m.health.stallAt = 0
            checkHealth()
        end if
        m.everPlayed = true
        m.paused = false
        hideStatus()
        m.failed = {}
        m.poolNote = ""
        if m.channelMode
            Iptv_recordRecent(m.servers[m.index])
        else if m.index >= 0 and m.servers[m.index].premium
            Account_notePremium(true)
        end if
        bindServerLabel()
        m.hudTimer.control = "start"
    else if st = "buffering"
        Telemetry_stallBegan(m.attempt)
        if m.everPlayed and not m.status.visible then showStatus("Buffering…", true)
        if m.everPlayed and m.health.stallAt = 0
            now = Telemetry_now()
            m.health.stallAt = now
            kept = []
            for each t in m.health.stalls
                if now - t <= DEGRADE_WINDOW_MS() then kept.Push(t)
            end for
            kept.Push(now)
            m.health.stalls = kept
            checkHealth()
        end if
    else if st = "paused"
        m.paused = true
        bindServerLabel()
    else if st = "error" or st = "finished"
        ' A stopped video still reports "finished" after its "error": while a resolve is already
        ' under way for the next attempt, that echo is not a second failure.
        if m.pendingIndex >= 0 then return
        if st = "finished"
            onFailure("ended", "The stream ended")
        else
            ' errorInfo names the URL and the HTTP status behind the generic message (debug console only).
            if type(m.video.errorInfo) = "roAssociativeArray" then logi("Player", "errorInfo " + FormatJson(m.video.errorInfo))
            onFailure("error", strOr(m.video.errorMsg, "playback error") + " (" + m.video.errorCode.ToStr() + ")")
        end if
    end if
end sub

sub onFailure(kind as string, detail as string)
    if m.index < 0 then return
    key = m.index.ToStr()
    ' The video node's "finished" after an "error" (or the other way round) is the same failure.
    if m.failed[key] = true and (kind = "error" or kind = "ended") then return
    logi("Player", "server " + key + " failed: " + kind + " - " + detail)
    m.video.control = "stop"
    ' A stream Home resolved while the card had focus can go stale before the press (signed,
    ' IP-bound URLs): resolve the same server afresh once before writing it off.
    if not m.channelMode and m.preIndex <> invalid and m.preIndex[key] = true and (kind = "error" or kind = "ended" or kind = "cdn" or kind = "timeout")
        m.preIndex.Delete(key)
        m.streams.Delete(key)
        logi("Player", "server " + key + " was pre-resolved; resolving it again")
        showStatus("Reconnecting to " + m.servers[m.index].name + "…", true)
        switchTo(m.index)
        return
    end if
    m.failed[key] = true
    ' Gated / pool-refused tabs reached no CDN; everything else is a playback failure.
    if kind <> "pool" and kind <> "premium" and kind <> "gated"
        if m.attempt = invalid
            ' Resolution failed before anything played: attribute it to the server's page.
            m.attempt = Telemetry_attempt("", serverName(m.index), "", not m.channelMode and m.servers[m.index].premium = true, false)
        end if
        Telemetry_error(m.attempt, kind)
    end if

    if m.channelMode
        c = m.servers[m.index]
        if kind = "warming"
            text = Iptv_displayName(c) + " is still starting up on the server (no video yet)." + Chr(10) + "Try again in a moment, or press Left/Right for another channel."
        else
            text = Iptv_displayName(c) + " is not playing right now." + Chr(10) + "Try again, or press Left/Right for another channel."
        end if
        showStatusWithActions(text, retryBackButtons())
        return
    end if

    ' Is there an untried server left? Sweep with a pause so the site is not hammered.
    nextIdx = nextUntried()
    if nextIdx >= 0
        Telemetry_switched(serverName(m.index), serverName(nextIdx), kind)
        if kind = "pool"
            showStatus(m.poolNote + Chr(10) + Chr(10) + "Trying " + m.servers[nextIdx].name, true)
        else if kind = "warming"
            showStatus(m.servers[m.index].name + " hasn’t started yet — trying " + m.servers[nextIdx].name, true)
        else
            showStatus(m.servers[m.index].name + " isn’t responding — trying " + m.servers[nextIdx].name, true)
        end if
        m.pendingNext = nextIdx
        m.retryTimer.control = "start"
        return
    end if

    ' Everything failed. No premium reachable with premium servers around: offer sign-in.
    capable = premiumCapable()
    hasPremium = false
    for each s in m.servers
        if s.premium then hasPremium = true
    end for
    if not capable and hasPremium
        showPremiumOnlyPanel()
    else if capable and hasPremium and m.poolFull = true and not m.global.leaseHeld
        text = "None of the free servers are playing right now, and all " + m.poolMax.ToStr() + " shared premium connections are in use." + Chr(10) + "Try again in a minute."
        showStatusWithActions(text, retryBackButtons())
    else
        showStatusWithActions("None of the servers are playing right now." + Chr(10) + "The stream may not have started yet — try again in a minute.", retryBackButtons())
    end if
end sub

' ---------------------------------------------------------------------------------------------
' Self-healing: leave a degraded stream for the next best server (NativePlayerActivity.migrate)
' ---------------------------------------------------------------------------------------------

function DEGRADE_STALLS() as integer
    return 3
end function
function DEGRADE_WINDOW_MS() as integer
    return 120000
end function
function DEGRADE_LONG_STALLS() as integer
    return 2
end function
function DEGRADE_LONG_STALL_MS() as integer
    return 15000
end function

' Is the current stream degraded enough to leave? Starts a migration when it is.
sub checkHealth()
    ' Live TV: the viewer chose this channel; it is not zapped away from on their behalf.
    if m.channelMode or not m.everPlayed or m.migrating <> invalid or m.index < 0 then return
    why = ""
    if m.health.stalls.Count() >= DEGRADE_STALLS()
        why = "stalls"
    else if m.health.long >= DEGRADE_LONG_STALLS()
        why = "long-stalls"
    end if
    if why <> "" then migrate(why)
end sub

' The current stream is degraded: resolve the next best server while it limps on.
sub migrate(why as string)
    if m.index < 0 or m.index >= m.servers.Count() then return
    m.degraded[m.index.ToStr()] = true
    ' Next best in preference order: not this one, not failed, not one already left as
    ' degraded; premium tabs only while a slot is held (the manual path asks the pool).
    idx = -1
    for i = 0 to m.servers.Count() - 1
        if idx < 0 and i <> m.index and m.failed[i.ToStr()] = invalid and m.degraded[i.ToStr()] = invalid
            if m.servers[i].premium <> true or m.global.leaseHeld = true then idx = i
        end if
    end for
    if idx < 0
        logi("Player", serverName(m.index) + " is degraded (" + why + ") but there is no other server to move to")
        return
    end if
    m.resolveSeq += 1
    m.migrating = { why: why, from: m.index, idx: idx, seq: m.resolveSeq, askedAt: Telemetry_now() }
    logi("Player", serverName(m.index) + " is degraded (" + why + "); readying " + serverName(idx) + " alongside")
    s = m.servers[idx]
    op = "resolveServer"
    if s.premium = true and not Account_isSignedIn() then op = "resolveShared"
    Ui_task(op, { server: s, seq: m.resolveSeq, viaPool: m.global.leaseHeld }, "onMigrateResolved")
end sub

sub onMigrateResolved(ev as object)
    r = ev.getData()
    mig = m.migrating
    if r = invalid or mig = invalid then return
    if r.seq <> invalid and r.seq <> mig.seq then return
    ' The viewer moved on, or the sweep did, while the candidate resolved.
    if m.index <> mig.from
        m.migrating = invalid
        return
    end if
    if r.hlsUrl = invalid
        logi("Player", "standby " + serverName(mig.idx) + " failed: " + strOr(r.state, strOr(r.error, "no stream")))
        m.failed[mig.idx.ToStr()] = true
        m.migrating = invalid
        migrate(mig.why) ' the next candidate, same reason
        return
    end if
    m.streams[mig.idx.ToStr()] = r
    m.migrating = invalid
    logi("Player", "switching to " + serverName(mig.idx) + " (" + mig.why + ")")
    Telemetry_switched(serverName(mig.from), serverName(mig.idx), "degraded-" + mig.why)
    m.askedAt = mig.askedAt ' the new stream's start time counts from when the old one was given up on
    switchTo(mig.idx)
    showStatus("Switching to " + serverName(mig.idx) + " for a steadier stream…", true)
end sub

' Premium tabs are only in the automatic sweep while we hold a pool slot (a manual pick asks
' the pool again).
function nextUntried() as integer
    premiumOk = premiumAllowed()
    n = m.servers.Count()
    for offset = 1 to n - 1
        i = (m.index + offset) mod n
        if m.failed[i.ToStr()] = invalid
            if premiumOk or not m.servers[i].premium then return i
        end if
    end for
    return -1
end function

sub onRetryTimer()
    if m.pendingNext <> invalid and m.pendingNext >= 0
        i = m.pendingNext
        m.pendingNext = -1
        switchTo(i)
    end if
end sub

sub retryAll()
    m.failed = {}
    m.streams = {}
    hideStatus()
    if m.channelMode
        switchTo(m.index)
    else
        m.global.prefetch = {} ' Retry means fresh: what Home resolved ahead is not reused
        startGame()
    end if
end sub

sub showPremiumOnlyPanel()
    text = "This stream is for the site’s premium members only." + Chr(10) + "Sign in to your premium account to watch it, or pick another game."
    showStatusWithActions(text, [{ key: "signin", text: "Sign in for premium" }, { key: "back", text: "Back to home" }])
end sub

' Every server is premium and the shared account's connections are all taken (app.js premiumOnly).
sub showPoolFullPanel()
    text = "All " + m.poolMax.ToStr() + " shared premium connections are in use right now (" + m.poolUsed.ToStr() + "/" + m.poolMax.ToStr() + ")." + Chr(10) + "Free servers aren’t listed for this game — try again in a minute."
    showStatusWithActions(text, retryBackButtons())
end sub

function retryBackButtons() as object
    return [{ key: "retry", text: "Retry" }, { key: "back", text: "Back to home" }]
end function

' ---------------------------------------------------------------------------------------------
' HUD: NativePlayerActivity.bindHud / bindServerLabel / showHud / hideHud
' ---------------------------------------------------------------------------------------------

sub bindHud()
    e = m.top.event
    if e = invalid then return
    m.hudTitle.text = Event_title(e)
    if e.ended
        m.hudPill.text = "FINAL"
        m.hudPillBg.uri = "pkg:/images/ui/pill_time.9.png"
        m.hudPillBg.visible = true
        m.hudPill.visible = true
    else if e.live
        txt = "LIVE"
        if not isEmpty(e.lt) then txt += "  " + e.lt
        m.hudPill.text = txt
        m.hudPillBg.uri = "pkg:/images/ui/pill_live.9.png"
        m.hudPillBg.visible = true
        m.hudPill.visible = true
    else
        m.hudPillBg.visible = false
        m.hudPill.visible = false
    end if
    score = ""
    if not isEmpty(e.sc) and not isEmpty(e.away)
        score = strOr(e.home, "") + "  " + e.sc.Replace(" - ", " – ") + "  " + e.away
    end if
    m.hudScore.text = score
    m.hudScore.visible = (score <> "")
    bindServerLabel()
    layoutHud()
    relayoutSoon()
end sub

sub bindServerLabel()
    if m.index < 0 or m.servers.Count() = 0
        m.hudServer.text = ""
        return
    end if
    s = m.servers[m.index]
    n = (m.index + 1).ToStr() + " of " + m.servers.Count().ToStr()
    if m.channelMode
        label = "Channel " + n + "  ·  " + strOr(m.top.channelGroup.name, "")
    else
        label = "Server " + n + "  ·  " + s.name
    end if
    if s.premium = true then label += "   ·   Premium"
    if m.paused and m.everPlayed then label += "   ·   Paused"
    m.hudServer.text = label
end sub

sub setHint()
    if m.channelMode
        m.hudHintText.text = "change channel   ·   OK play/pause   ·   Back to channels"
    else
        m.hudHintText.text = "switch server   ·   OK play/pause   ·   Back home"
    end if
end sub

' Top: padding 48/28/48/36 dp, pill+title row, score +6 dp. Bottom: padding 48/40/48/26 dp, server, hint +4 dp.
sub layoutHud()
    titleH = Ui_lineHeight(Ui_sp(22))
    y = 56
    x = 96
    if m.hudPillBg.visible
        pw = Ui_textWidth(m.hudPill) + 36
        ph = Ui_lineHeight(Ui_sp(12)) + 12
        py = y + Int((titleH - ph) / 2)
        m.hudPillBg.width = pw
        m.hudPillBg.height = ph
        m.hudPillBg.translation = [x, py]
        m.hudPill.width = pw
        m.hudPill.height = ph
        m.hudPill.translation = [x, py]
        x += pw + 28
    end if
    m.hudTitle.translation = [x, y]
    m.hudTitle.width = 1920 - 96 - x
    m.hudTitle.height = titleH
    y += titleH
    if m.hudScore.visible
        y += 12
        m.hudScore.translation = [96, y]
        m.hudScore.width = 1728
        y += Ui_lineHeight(Ui_sp(16))
    end if
    m.topScrim.height = y + 72

    serverH = Ui_lineHeight(Ui_sp(16))
    hintH = Ui_lineHeight(Ui_sp(13))
    total = 80 + serverH + 8 + hintH + 52
    top = 1080 - total
    m.bottomScrim.translation = [0, top]
    m.bottomScrim.height = total
    m.hudServer.translation = [96, top + 80]
    m.hudServer.width = 1728
    m.hudHint.translation = [96, top + 80 + serverH + 8]
    g = 22
    gy = Int((hintH - g) / 2)
    m.hintLeft.width = g
    m.hintLeft.height = g
    m.hintLeft.translation = [0, gy]
    m.hintRight.width = g
    m.hintRight.height = g
    m.hintRight.translation = [g + 7, gy]
    m.hudHintText.translation = [2 * g + 14, 0]
end sub

sub showHud()
    m.hudTimer.control = "stop"
    bindServerLabel()
    fadeHud(true)
    if not m.paused then m.hudTimer.control = "start"
end sub

sub hideHud()
    m.hudTimer.control = "stop"
    fadeHud(false)
end sub

sub fadeHud(show as boolean)
    if m.hudShown = show and m.hudAnim.state <> "running" then return
    m.hudShown = show
    m.hudAnim.control = "stop"
    from = m.hud.opacity
    if show
        m.hudAnim.duration = 0.18
        m.hudInterp.keyValue = [from, 1.0]
    else
        m.hudAnim.duration = 0.26
        m.hudInterp.keyValue = [from, 0.0]
    end if
    m.hudAnim.control = "start"
end sub

sub onHudTimer()
    if m.video.state = "playing" then hideHud()
end sub

' ---------------------------------------------------------------------------------------------
' Centre status: spinner + message (+ buttons)
' ---------------------------------------------------------------------------------------------

sub showStatus(message as string, busy as boolean)
    m.statusText.text = message
    m.spinner.visible = busy
    if busy then m.spinner.control = "start" else m.spinner.control = "stop"
    clearStatusButtons()
    m.status.visible = true
    layoutStatus()
    relayoutSoon()
end sub

sub showStatusWithActions(message as string, buttons as object)
    showStatus(message, false)
    m.statusDefs = buttons
    x = 0
    for each b in buttons
        p = m.statusButtons.createChild("Pill")
        p.kind = "buttonMd"
        p.text = b.text
        p.translation = [x, 0]
        x += p.pillWidth + 24
        m.statusNodes.Push(p)
    end for
    m.statusIndex = 0
    styleStatus()
    layoutStatus()
end sub

sub hideStatus()
    m.status.visible = false
    m.spinner.control = "stop"
    clearStatusButtons()
end sub

sub clearStatusButtons()
    for each n in m.statusNodes
        m.statusButtons.removeChild(n)
    end for
    m.statusDefs = []
    m.statusNodes = []
end sub

function panelUp() as boolean
    return m.status.visible and m.statusNodes.Count() > 0
end function

' Vertical box centred on the screen: spinner 40 dp, message (+16 dp, max 560 dp wide), buttons (+22 dp).
sub layoutStatus()
    if not m.status.visible then return
    m.statusText.width = 1120
    textH = Ui_labelHeight(m.statusText, Ui_sp(17), 0)
    total = textH
    if m.spinner.visible then total += 80 + 32
    if m.statusNodes.Count() > 0 then total += 44 + m.statusNodes[0].pillHeight
    y = Int((1080 - total) / 2)
    if m.spinner.visible
        m.spinner.translation = [920, y]
        y += 80 + 32
    end if
    m.statusText.translation = [400, y]
    y += textH
    if m.statusNodes.Count() > 0
        y += 44
        x = 0
        for each p in m.statusNodes
            p.translation = [x, 0]
            x += p.pillWidth + 24
        end for
        rowW = x - 24
        m.statusButtons.translation = [Int((1920 - rowW) / 2), y]
    end if
end sub

sub styleStatus()
    for i = 0 to m.statusNodes.Count() - 1
        m.statusNodes[i].focused = (i = m.statusIndex)
    end for
end sub

sub activateStatus()
    if m.statusIndex < 0 or m.statusIndex >= m.statusDefs.Count() then return
    k = m.statusDefs[m.statusIndex].key
    if k = "retry"
        retryAll()
    else if k = "back"
        closeScreen()
    else if k = "signin"
        m.top.navigate = { screen: "AccountScreen" }
    end if
end sub

' Labels report their real size a frame after they change; lay out again then.
sub relayoutSoon()
    m.layoutTimer.control = "stop"
    m.layoutTimer.control = "start"
end sub

sub onLayoutTimer()
    layoutHud()
    layoutStatus()
end sub

' ---------------------------------------------------------------------------------------------
' Live score
' ---------------------------------------------------------------------------------------------

sub onScoreTick()
    e = m.top.event
    if e = invalid or m.channelMode or isEmpty(m.top.base) then return
    Ui_task("eventStatus", { base: m.top.base, id: e.id }, "onScore")
end sub

sub onScore(ev as object)
    r = ev.getData()
    if r = invalid or r.ok <> true then return
    e = m.top.event
    e.live = r.live
    e.ended = r.ended
    e.lt = r.lt
    e.sc = r.sc
    m.top.event = e
    bindHud()
end sub

' ---------------------------------------------------------------------------------------------
' Keys (NativePlayerActivity.dispatchKeyEvent)
' ---------------------------------------------------------------------------------------------

sub closeScreen()
    m.video.control = "stop"
    m.scoreTimer.control = "stop"
    m.telemetryTimer.control = "stop"
    Telemetry_stop(m.attempt)
    m.attempt = invalid
    Telemetry_flush()
    m.top.close = true
end sub

sub onTelemetryTimer()
    Telemetry_flush()
end sub

sub togglePlayPause()
    st = m.video.state
    if st = "playing"
        m.video.control = "pause"
        m.paused = true
    else if st = "paused"
        m.video.control = "resume"
        m.paused = false
    else
        return
    end if
    showHud()
end sub

sub manualSwitch(dir as integer)
    n = m.servers.Count()
    if n <= 1
        showHud()
        return
    end if
    i = (m.index + dir + n) mod n
    if not m.channelMode
        ' Skip premium servers when no premium is reachable (they only fail).
        capable = premiumCapable()
        tries = 0
        while not capable and m.servers[i].premium and tries < n
            i = (i + dir + n) mod n
            tries += 1
        end while
        m.failed = {}
    end if
    Telemetry_switched(serverName(m.index), serverName(i), "manual")
    m.askedAt = Telemetry_now() ' the wait the viewer feels starts with this press
    switchTo(i)
end sub

function serverName(i as integer) as string
    if i < 0 or i >= m.servers.Count() then return ""
    if m.channelMode then return Iptv_displayName(m.servers[i])
    return strOr(m.servers[i].name, "")
end function

' Developer key injection (see MainScene.onDevCmd); the player handles every key itself.
sub onDevKey()
    onKeyEvent(m.top.devKey, true)
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "back"
        closeScreen()
        return true
    end if

    ' The status panel's buttons take the d-pad while they are showing.
    if panelUp()
        if key = "left"
            if m.statusIndex > 0 then m.statusIndex -= 1
            styleStatus()
        else if key = "right"
            if m.statusIndex < m.statusNodes.Count() - 1 then m.statusIndex += 1
            styleStatus()
        else if key = "OK"
            activateStatus()
        else if key = "options"
            retryAll()
        end if
        return true
    end if

    if key = "left"
        manualSwitch(-1)
        return true
    else if key = "right"
        manualSwitch(1)
        return true
    else if key = "OK"
        togglePlayPause()
        return true
    else if key = "up" or key = "down"
        if m.hudShown then hideHud() else showHud()
        return true
    else if key = "play"
        togglePlayPause()
        return true
    else if key = "options"
        ' MENU: retry the current server
        m.failed = {}
        m.streams = {}
        switchTo(m.index)
        return true
    end if
    return false
end function
