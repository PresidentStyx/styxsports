sub init()
    m.video = m.top.findNode("video")
    m.hud = m.top.findNode("hud")
    m.hudPillBg = m.top.findNode("hudPillBg")
    m.hudPill = m.top.findNode("hudPill")
    m.hudTitle = m.top.findNode("hudTitle")
    m.hudScore = m.top.findNode("hudScore")
    m.hudServer = m.top.findNode("hudServer")
    m.hudHint = m.top.findNode("hudHint")
    m.loading = m.top.findNode("loading")
    m.loadingText = m.top.findNode("loadingText")
    m.panel = m.top.findNode("panel")
    m.panelTitle = m.top.findNode("panelTitle")
    m.panelText = m.top.findNode("panelText")
    m.panelButtons = m.top.findNode("panelButtons")
    m.hudTimer = m.top.findNode("hudTimer")
    m.retryTimer = m.top.findNode("retryTimer")
    m.scoreTimer = m.top.findNode("scoreTimer")

    m.channelMode = false
    m.servers = []          ' game: [{name, pageUrl, active, premium}]  channel: [{name, logo, url, ...}]
    m.streams = {}          ' server index -> resolved stream (game mode)
    m.failed = {}           ' server index -> true
    m.index = -1
    m.pendingIndex = -1
    m.started = false
    m.panelDefs = []
    m.panelNodes = []
    m.panelIndex = 0
    m.resolveSeq = 0
    m.pendingNext = -1

    m.video.observeField("state", "onVideoState")
    m.hudTimer.observeField("fire", "onHudTimer")
    m.retryTimer.observeField("fire", "onRetryTimer")
    m.scoreTimer.observeField("fire", "onScoreTick")
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
        showPanel("Nothing to play", "This screen was opened without a game or channel.", [{ key: "back", text: "Back" }])
    end if
end sub

sub onResumed()
    ' Back from the account screen: a fresh sign-in unlocks premium servers, so try again.
    if m.top.resumed and m.panel.visible and Account_isSignedIn() then retryAll()
end sub

' ---------------------------------------------------------------------------------------------
' Game mode
' ---------------------------------------------------------------------------------------------

sub startGame()
    e = m.top.event
    m.hudTitle.text = Event_title(e)
    updatePill()
    m.hudServer.text = ""
    m.hudHint.text = Chr(9664) + " " + Chr(9654) + " change server   ·   OK  info   ·   Back  close"
    showHud(false)
    setLoading("Finding streams…")
    m.resolveSeq += 1
    Ui_task("resolvePage", { url: e.url, seq: m.resolveSeq }, "onPage")
    if e.live then m.scoreTimer.control = "start"
end sub

sub onPage(ev as object)
    r = ev.getData()
    if r = invalid then return
    if r.ok <> true
        showPanel("Could not open this game", strOr(r.error, "unknown error"), [{ key: "retry", text: "Try again" }, { key: "back", text: "Back" }])
        return
    end if
    m.servers = r.servers
    m.streams = {}
    m.failed = {}
    m.streams[r.activeIndex.ToStr()] = r.stream

    ' Signed in: premium servers first (they are the better ones). Signed out: skip them.
    start = r.activeIndex
    signedIn = Account_isSignedIn()
    if signedIn
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
            showPremiumOnlyPanel()
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
    m.video.control = "stop"
    m.panel.visible = false
    updateServerLabel()
    if m.channelMode
        c = m.servers[i]
        m.hudTitle.text = Iptv_displayName(c)
        setLoading("Loading " + Iptv_displayName(c) + "…")
        showHud(true)
        playUrl(c.url, "", c.name)
        return
    end if
    s = m.servers[i]
    setLoading("Loading " + s.name + "…")
    showHud(true)
    cached = m.streams[i.ToStr()]
    if cached <> invalid
        playStream(cached)
    else
        m.resolveSeq += 1
        m.pendingIndex = i
        Ui_task("resolveServer", { server: s, seq: m.resolveSeq }, "onServerResolved")
    end if
end sub

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
        if s.premium and not Account_isSignedIn()
            onFailure("premium", "This server is for the site's premium members")
        else if s.premium and stream.state = "gate"
            Account_notePremium(false)
            onFailure("gated", "Premium server is locked on this account")
        else
            onFailure("noplayer", "No playable stream on " + s.name)
        end if
        return
    end if
    origin = stream.playerOrigin
    playUrl(stream.hlsUrl, origin, Event_title(m.top.event))
end sub

sub playUrl(url as string, origin as string, title as string)
    m.video.control = "stop"
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
    g = m.top.channelGroup
    m.servers = g.channels
    m.hudPillBg.visible = false
    m.hudPill.visible = false
    m.hudScore.text = ""
    m.hudHint.text = Chr(9664) + " " + Chr(9654) + " change channel   ·   OK  info   ·   Back  channels"
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
        m.loading.visible = false
        m.panel.visible = false
        m.failed = {}
        if m.channelMode
            Iptv_recordRecent(m.servers[m.index])
        else if m.index >= 0 and m.servers[m.index].premium
            Account_notePremium(true)
        end if
        m.hudTimer.control = "start"
    else if st = "buffering"
        if not m.loading.visible and not m.hud.visible then setLoading("")
    else if st = "error"
        onFailure("error", strOr(m.video.errorMsg, "playback error") + " (" + m.video.errorCode.ToStr() + ")")
    else if st = "finished"
        onFailure("ended", "The stream ended")
    end if
end sub

sub onFailure(kind as string, detail as string)
    if m.index < 0 then return
    logi("Player", "server " + m.index.ToStr() + " failed: " + kind + " - " + detail)
    m.failed[m.index.ToStr()] = true
    m.video.control = "stop"

    if m.channelMode
        c = m.servers[m.index]
        text = "Try again, or press Left/Right for another channel." + Chr(10) + Chr(10) + detail
        showPanel(Iptv_displayName(c) + " is not playing right now", text, [{ key: "retry", text: "Try again" }, { key: "back", text: "Back to channels" }])
        return
    end if

    ' Is there an untried server left? Sweep with a pause so the site is not hammered.
    nextIdx = nextUntried()
    if nextIdx >= 0
        setLoading(m.servers[m.index].name + " failed · trying " + m.servers[nextIdx].name + "…")
        m.pendingNext = nextIdx
        m.retryTimer.control = "start"
        return
    end if

    ' Everything failed. Signed out with premium servers around: offer sign-in.
    signedIn = Account_isSignedIn()
    hasPremium = false
    for each s in m.servers
        if s.premium then hasPremium = true
    end for
    if not signedIn and hasPremium
        showPremiumOnlyPanel()
    else
        text = "All " + m.servers.Count().ToStr() + " servers failed. The stream may not have started yet, or the site is having trouble." + Chr(10) + Chr(10) + detail
        showPanel("None of the servers are playing right now", text, [{ key: "retry", text: "Try all again" }, { key: "back", text: "Back" }])
    end if
end sub

function nextUntried() as integer
    signedIn = Account_isSignedIn()
    n = m.servers.Count()
    for offset = 1 to n - 1
        i = (m.index + offset) mod n
        if m.failed[i.ToStr()] = invalid
            if signedIn or not m.servers[i].premium then return i
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
    m.panel.visible = false
    if m.channelMode
        switchTo(m.index)
    else
        startGame()
    end if
end sub

sub showPremiumOnlyPanel()
    text = "This stream is for the site's premium members." + Chr(10) + "Sign in to your premium account to watch it, or pick another game."
    showPanel("Premium members only", text, [{ key: "signin", text: "Sign in for premium" }, { key: "back", text: "Back" }])
end sub

' ---------------------------------------------------------------------------------------------
' HUD
' ---------------------------------------------------------------------------------------------

sub setLoading(text as string)
    m.loadingText.text = text
    m.loading.visible = true
end sub

sub showHud(autoHide as boolean)
    m.hud.visible = true
    m.hudTimer.control = "stop"
    if autoHide then m.hudTimer.control = "start"
end sub

sub onHudTimer()
    if m.video.state = "playing" then m.hud.visible = false
end sub

sub updateServerLabel()
    if m.index < 0 then return
    if m.channelMode
        m.hudServer.text = "Channel " + (m.index + 1).ToStr() + " of " + m.servers.Count().ToStr() + "  ·  " + m.top.channelGroup.name
        return
    end if
    s = m.servers[m.index]
    t = s.name + "  ·  " + (m.index + 1).ToStr() + " of " + m.servers.Count().ToStr()
    if s.premium then t += "  ·  Premium"
    m.hudServer.text = t
end sub

sub updatePill()
    e = m.top.event
    if e = invalid then return
    if e.live
        m.hudPillBg.color = Ui_color("live")
        m.hudPill.text = "LIVE"
        if not isEmpty(e.lt) then m.hudPill.text = e.lt
    else if e.ended
        m.hudPillBg.color = "0x2A2A2AFF"
        m.hudPill.text = "FINAL"
    else
        m.hudPillBg.color = "0x2A2A2AFF"
        m.hudPill.text = Ui_whenLabel(e)
    end if
    r = m.hudPill.boundingRect()
    w = 90
    if r <> invalid and r.width <> invalid then w = Int(r.width) + 28
    if w < 90 then w = 90
    m.hudPillBg.width = w
    m.hudPill.width = w
    m.hudScore.text = strOr(e.sc, "")
end sub

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
    updatePill()
end sub

' ---------------------------------------------------------------------------------------------
' Status panel
' ---------------------------------------------------------------------------------------------

sub showPanel(title as string, text as string, buttons as object)
    m.loading.visible = false
    m.hud.visible = false
    m.panelTitle.text = title
    m.panelText.text = text
    for each n in m.panelNodes
        m.panelButtons.removeChild(n)
    end for
    m.panelDefs = buttons
    m.panelNodes = []
    x = 0
    for each b in buttons
        p = m.panelButtons.createChild("Pill")
        p.minWidth = 200
        p.text = b.text
        p.translation = [x, 0]
        x += p.pillWidth + 20
        m.panelNodes.Push(p)
    end for
    m.panelIndex = 0
    stylePanel()
    m.panel.visible = true
end sub

sub stylePanel()
    for i = 0 to m.panelNodes.Count() - 1
        m.panelNodes[i].focused = (i = m.panelIndex)
    end for
end sub

sub activatePanel()
    if m.panelIndex < 0 or m.panelIndex >= m.panelDefs.Count() then return
    k = m.panelDefs[m.panelIndex].key
    if k = "retry"
        retryAll()
    else if k = "back"
        closeScreen()
    else if k = "signin"
        m.top.navigate = { screen: "AccountScreen" }
    end if
end sub

' ---------------------------------------------------------------------------------------------
' Keys
' ---------------------------------------------------------------------------------------------

sub closeScreen()
    m.video.control = "stop"
    m.scoreTimer.control = "stop"
    m.top.close = true
end sub

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

    if m.panel.visible
        if key = "left"
            if m.panelIndex > 0 then m.panelIndex -= 1
            stylePanel()
            return true
        else if key = "right"
            if m.panelIndex < m.panelNodes.Count() - 1 then m.panelIndex += 1
            stylePanel()
            return true
        else if key = "OK"
            activatePanel()
            return true
        end if
        ' Left/Right to another channel still works from the channel failure panel.
        if not m.channelMode then return true
    end if

    if key = "left" or key = "right"
        if m.servers.Count() <= 1 then return true
        n = m.servers.Count()
        if key = "left" then i = (m.index - 1 + n) mod n else i = (m.index + 1) mod n
        if m.channelMode
            switchTo(i)
        else
            ' Skip premium servers when signed out (they only fail).
            signedIn = Account_isSignedIn()
            tries = 0
            while not signedIn and m.servers[i].premium and tries < n
                if key = "left" then i = (i - 1 + n) mod n else i = (i + 1) mod n
                tries += 1
            end while
            m.failed = {}
            switchTo(i)
        end if
        return true
    else if key = "OK" or key = "up"
        if m.hud.visible and m.video.state = "playing" then m.hud.visible = false else showHud(true)
        return true
    else if key = "down"
        m.hud.visible = false
        return true
    else if key = "play"
        if m.video.state = "playing"
            m.video.control = "pause"
            showHud(false)
        else if m.video.state = "paused"
            m.video.control = "resume"
            showHud(true)
        end if
        return true
    else if key = "options"
        retryAll()
        return true
    end if
    return false
end function
