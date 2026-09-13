' Home: HomeActivity in SceneGraph. Same rows, same text, same geometry (Android dp x 2), same
' focus behaviour: the focused card is centred in its row and the row is scrolled near the top.
' Cached snapshot paints first; a full refresh runs at launch and every 10 minutes, live
' clocks/scores every 30 seconds.

' Geometry (px). Android: bar pad 48/22/48/10 dp, chips pad 48/2/48/4, scroller pad 8 top / 120
' bottom, row header pad 48/14/48/2, strip pad 10 top/bottom, card 292x150 + 14 right margin.
' Heights that wrap text (buttons, chips, row titles) follow the font metrics, like the Android
' views do, so the screen lines up with the APK at its font scale.
function homeGeometry() as object
    buttonH = Ui_lineHeight(Ui_sp(13)) + 32   ' pillButton: 13 sp bold, 8 dp vertical padding
    chipH = Ui_lineHeight(Ui_sp(13)) + 24     ' chip: 13 sp bold, 6 dp vertical padding
    barContentH = buttonH
    if barContentH < 60 then barContentH = 60 ' wordmark
    barH = 44 + barContentH + 20
    chipsY = barH + 4
    scrollerY = chipsY + chipH + 8
    headerH = Ui_lineHeight(Ui_sp(20))        ' row title: 20 sp bold
    stripTop = 28 + headerH + 4 + 20
    return {
        padX: 96
        barH: barH, barCenterY: 44 + Int(barContentH / 2), buttonH: buttonH
        chipsY: chipsY, chipH: chipH
        cardW: 584, cardH: 300, cardGap: 28
        rowH: stripTop + 300 + 20, headerTop: 28, headerH: headerH, stripTop: stripTop
        scrollerY: scrollerY, scrollerH: 1080 - scrollerY, scrollPadTop: 16, scrollPadBottom: 240
        chipGap: 16
    }
end function

' Static chrome placed from the geometry (the XML holds the default, font-scale 1.0 values).
sub applyGeometry()
    g = m.g
    scroller = m.top.findNode("scroller")
    scroller.translation = [0, g.scrollerY]
    scroller.clippingRect = [0, 0, 1920, g.scrollerH]
    m.top.findNode("chromeBg").height = g.scrollerY
    m.top.findNode("wordmark").translation = [g.padX, g.barCenterY - 30]
    m.topButtons.translation = [1824, g.barCenterY - Int(g.buttonH / 2)]
    statusH = Ui_lineHeight(Ui_sp(13))
    m.status.height = statusH
    m.status.translation = [g.padX + 392, g.barCenterY - Int(statusH / 2)]
    versionH = Ui_lineHeight(Ui_sp(11))
    m.version.height = versionH
    m.version.translation = [1824, g.barCenterY - Int(versionH / 2)]
    m.top.findNode("chipsRow").translation = [0, g.chipsY]
end sub

sub init()
    m.g = homeGeometry()
    m.status = m.top.findNode("status")
    m.version = m.top.findNode("version")
    m.topButtons = m.top.findNode("topButtons")
    m.chips = m.top.findNode("chips")
    m.rowsGroup = m.top.findNode("rowsGroup")
    m.rowsAnim = m.top.findNode("rowsAnim")
    m.rowsInterp = m.top.findNode("rowsInterp")
    m.chipsAnim = m.top.findNode("chipsAnim")
    m.chipsInterp = m.top.findNode("chipsInterp")
    m.overlay = m.top.findNode("overlay")
    m.overlayLogo = m.top.findNode("overlayLogo")
    m.spinner = m.top.findNode("spinner")
    m.overlayMessage = m.top.findNode("overlayMessage")
    m.overlayButtons = m.top.findNode("overlayButtons")
    m.statusTimer = m.top.findNode("statusTimer")
    m.fullTimer = m.top.findNode("fullTimer")
    m.layoutTimer = m.top.findNode("layoutTimer")

    m.status.font = Ui_font(Ui_sp(13), false)
    m.status.color = Ui_color("muted")
    m.version.font = Ui_font(Ui_sp(11), false)
    m.version.color = Ui_color("muted")
    m.version.text = "v" + CreateObject("roAppInfo").GetVersion()
    applyGeometry()
    m.overlayMessage.font = Ui_font(Ui_sp(16), false)
    m.overlayMessage.color = Ui_color("muted")
    m.spinner.poster.uri = "pkg:/images/ui/spinner.png"
    m.spinner.poster.width = 72
    m.spinner.poster.height = 72

    m.premiumFilter = "__premium__"
    m.liveTvChip = "__livetv__"
    m.focusArea = "rows"
    m.rowIndex = 0
    m.colIndex = 0
    m.chipIndex = 0
    m.topIndex = 0
    m.overlayIndex = 0
    m.chipDefs = []
    m.chipNodes = []
    m.topDefs = []
    m.topNodes = []
    m.rowDefs = []
    m.rowNodes = []
    m.scrollY = 0
    m.filter = Filter_load()
    if m.filter = m.liveTvChip then m.filter = ""
    m.fav = Fav_load()
    m.categoryNames = {}
    m.loading = false
    m.lastError = ""
    m.showingProblem = false
    m.accountChecking = false
    m.everFocusedRows = false
    m.focusedEventId = ""
    m.renderedSignedIn = Account_isSignedIn()
    m.renderedLiveTv = hasLiveTv()
    m.renderedPremiumHidden = premiumHidden()

    m.global.observeField("poolInfoAt", "onPoolInfo")
    m.statusTimer.observeField("fire", "onStatusTick")
    m.fullTimer.observeField("fire", "onFullTick")
    m.layoutTimer.observeField("fire", "onLayoutTick")

    buildTopButtons()
    m.snapshot = Site_cached()
    if m.snapshot <> invalid
        Events_sort(m.snapshot.events)
        render(true)
    else
        showLoading()
    end if
    startFullRefresh()
    m.statusTimer.control = "start"
    m.fullTimer.control = "start"
    recheckAccount(false)
end sub

' The scene attached us and handed over focus.
sub onStart()
    if m.top.start
        m.top.setFocus(true)
        focusRows()
    end if
end sub

' Back from another screen: the account may have changed (sign-in, Live TV discovered).
sub onResumed()
    if not m.top.resumed then return
    m.top.setFocus(true)
    m.fav = Fav_load()
    if Account_isSignedIn() <> m.renderedSignedIn or hasLiveTv() <> m.renderedLiveTv or premiumHidden() <> m.renderedPremiumHidden
        if m.filter = m.premiumFilter and not premiumHidden() then m.filter = ""
        if m.snapshot <> invalid then render(true) else buildTopButtons()
    else
        refreshStars()
    end if
    recheckAccount(false)
end sub

' The presence ping learned what the shared account offers (first launch: nothing was known).
sub onPoolInfo()
    if hasLiveTv() <> m.renderedLiveTv or premiumHidden() <> m.renderedPremiumHidden
        if m.filter = m.premiumFilter and not premiumHidden() then m.filter = ""
        if m.snapshot <> invalid then render(true) else buildTopButtons()
    end if
end sub

' No premium anywhere: no own account with premium, and no shared account in the pool.
function premiumHidden() as boolean
    own = Account_isSignedIn() and Account_premiumKnown() <> "no"
    return not own and not Pool_sharedAvailable()
end function

' Live TV: the own account's playlist, or the shared account's through the Worker.
function hasLiveTv() as boolean
    return Account_hasIptv() or Pool_sharedIptv()
end function

' ---------------------------------------------------------------------------------------------
' Data
' ---------------------------------------------------------------------------------------------

sub startFullRefresh()
    if m.loading then return
    m.loading = true
    if m.snapshot <> invalid then m.status.text = "Refreshing…"
    Ui_task("schedule", {}, "onSchedule")
end sub

sub onSchedule(ev as object)
    m.loading = false
    r = ev.getData()
    if r = invalid then return
    if r.ok = true
        logi("Home", "schedule: " + r.events.Count().ToStr() + " events, " + r.categories.Count().ToStr() + " categories from " + strOr(r.base, "?"))
        m.lastError = ""
        m.snapshot = r
        render(true)
    else
        m.lastError = strOr(r.error, "unknown error")
        logi("Home", "schedule failed: " + m.lastError)
        if m.snapshot = invalid or m.snapshot.events.Count() = 0
            showProblem("Couldn't load the schedule." + Chr(10) + m.lastError)
        else
            m.status.text = "Offline · showing schedule from " + Ui_timeOf(toInt(m.snapshot.fetchedAt))
        end if
    end if
end sub

sub onStatusTick()
    if m.snapshot = invalid or m.loading then return
    Ui_task("status", { snapshot: m.snapshot }, "onStatus")
end sub

sub onStatus(ev as object)
    r = ev.getData()
    if r = invalid or r.ok <> true or m.snapshot = invalid then return
    ' Update in place so focus and scroll positions survive.
    byId = {}
    for each e in r.events
        byId[e.id] = e
    end for
    for each e in m.snapshot.events
        u = byId[e.id]
        if u <> invalid
            e.live = u.live
            e.ended = u.ended
            e.lt = u.lt
            e.sc = u.sc
        end if
    end for
    for each rn in m.rowNodes
        for each card in rn.cards
            n = card.content
            u = byId[n.id]
            if u <> invalid and (n.live <> u.live or n.ended <> u.ended or n.lt <> u.lt or n.sc <> u.sc)
                n.live = u.live
                n.ended = u.ended
                n.lt = u.lt
                n.sc = u.sc
                card.relayout = true
            end if
        end for
    end for
    updateStatus()
end sub

sub onFullTick()
    startFullRefresh()
    recheckAccount(false)
end sub

sub recheckAccount(force as boolean)
    if not Account_isSignedIn() then return
    if not force and not Account_isStale() and not Account_iptvStale() then return
    if m.accountChecking = true then return
    m.accountChecking = true
    Ui_task("accountStatus", { force: force }, "onAccountStatus")
end sub

sub onAccountStatus(ev as object)
    m.accountChecking = false
    r = ev.getData()
    if r = invalid then return
    if r.signedIn <> m.renderedSignedIn or hasLiveTv() <> m.renderedLiveTv or premiumHidden() <> m.renderedPremiumHidden
        if m.snapshot <> invalid then render(true) else buildTopButtons()
    end if
end sub

' ---------------------------------------------------------------------------------------------
' Overlay (loading / problem), HomeActivity.buildOverlay: logo, spinner, message, Retry
' ---------------------------------------------------------------------------------------------

sub showLoading()
    m.showingProblem = false
    m.overlay.visible = true
    m.spinner.visible = true
    m.spinner.control = "start"
    m.overlayButtons.visible = false
    m.overlayMessage.text = "Loading today’s games…"
    layoutOverlay()
end sub

sub showProblem(message as string)
    m.showingProblem = true
    m.overlay.visible = true
    m.spinner.visible = false
    m.spinner.control = "stop"
    m.overlayButtons.visible = true
    m.overlayMessage.text = message
    if m.overlayButtons.getChildCount() = 0
        p = m.overlayButtons.createChild("Pill")
        p.kind = "button"
        p.text = "Retry"
    end if
    m.overlayIndex = 0
    m.focusArea = "overlay"
    styleOverlay()
    layoutOverlay()
end sub

sub hideOverlay()
    m.overlay.visible = false
    m.spinner.control = "stop"
    m.showingProblem = false
    if m.focusArea = "overlay" then m.focusArea = "rows"
end sub

' Vertical box centred on the screen: logo 46 dp, spinner 36 dp (+28 top), message (+18), buttons (+22).
sub layoutOverlay()
    msgH = Ui_labelHeight(m.overlayMessage, Ui_sp(16), 0)
    total = 92
    if m.spinner.visible then total += 56 + 72
    total += 36 + msgH
    if m.overlayButtons.visible then total += 44 + m.g.buttonH
    y = Int((1080 - total) / 2)
    m.overlayLogo.translation = [660, y]
    y += 92
    if m.spinner.visible
        m.spinner.translation = [924, y + 56]
        y += 56 + 72
    end if
    m.overlayMessage.translation = [96, y + 36]
    y += 36 + msgH
    if m.overlayButtons.visible and m.overlayButtons.getChildCount() > 0
        p = m.overlayButtons.getChild(0)
        m.overlayButtons.translation = [Int((1920 - p.pillWidth) / 2), y + 44]
    end if
end sub

sub styleOverlay()
    for i = 0 to m.overlayButtons.getChildCount() - 1
        m.overlayButtons.getChild(i).focused = (m.focusArea = "overlay" and i = m.overlayIndex)
    end for
end sub

' ---------------------------------------------------------------------------------------------
' Rendering
' ---------------------------------------------------------------------------------------------

sub render(keepFocus as boolean)
    m.renderedSignedIn = Account_isSignedIn()
    m.renderedLiveTv = hasLiveTv()
    m.renderedPremiumHidden = premiumHidden()
    m.categoryNames = {}
    for each c in m.snapshot.categories
        m.categoryNames[c.id.ToStr()] = c.name
    end for
    buildTopButtons()
    buildChips()
    buildRows(keepFocus)
    updateStatus()
    ' Labels measure as 0 until they have been through a frame: re-run the width-dependent
    ' layout a moment later so pills, badges and headers are sized to their real text.
    m.layoutTimer.control = "start"
end sub

sub onLayoutTick()
    for each p in m.topNodes
        p.relayout = true
    end for
    for each p in m.chipNodes
        p.relayout = true
    end for
    for each rn in m.rowNodes
        for each card in rn.cards
            card.relayout = true
        end for
    end for
    for i = 0 to m.overlayButtons.getChildCount() - 1
        m.overlayButtons.getChild(i).relayout = true
    end for
    layoutTopBar()
    layoutChips(false)
    layoutRowHeaders()
    layoutOverlay()
end sub

' "Updated 2:15 PM · 3 live"
sub updateStatus()
    if m.snapshot = invalid then return
    live = 0
    for each e in m.snapshot.events
        if e.live then live += 1
    end for
    m.status.text = "Updated " + Ui_timeOf(toInt(m.snapshot.fetchedAt)) + " · " + live.ToStr() + " live"
end sub

' --- top bar -----------------------------------------------------------------------------------

sub buildTopButtons()
    for each n in m.topNodes
        m.topButtons.removeChild(n)
    end for
    m.topDefs = []
    m.topNodes = []
    m.topDefs.Push({ key: "refresh", text: "Refresh", icon: "" })
    if not Account_isSignedIn()
        m.topDefs.Push({ key: "account", text: "Sign in", icon: "" })
    else if Account_premiumKnown() = "no"
        m.topDefs.Push({ key: "account", text: "Account", icon: "" })
    else
        m.topDefs.Push({ key: "account", text: "Premium", icon: "star" })
    end if
    for each d in m.topDefs
        p = m.topButtons.createChild("Pill")
        p.kind = "button"
        p.icon = d.icon
        p.text = d.text
        m.topNodes.Push(p)
    end for
    if m.topIndex >= m.topDefs.Count() then m.topIndex = m.topDefs.Count() - 1
    layoutTopBar()
    styleTop()
end sub

' Right to left from the 48 dp padding: version (14 dp gap), account button, 10 dp, Refresh; the
' status text fills the space between the wordmark and the buttons (20 dp gap), right-aligned.
sub layoutTopBar()
    g = m.g
    right = 1920 - g.padX
    vw = Ui_textWidth(m.version)
    m.version.width = vw + 2
    m.version.translation = [right - vw, m.version.translation[1]]
    x = right - vw - 28
    for i = m.topNodes.Count() - 1 to 0 step -1
        p = m.topNodes[i]
        x -= p.pillWidth
        p.translation = [x - 1824, 0]
        if i > 0 then x -= 20
    end for
    statusLeft = g.padX + 392
    m.status.translation = [statusLeft, m.status.translation[1]]
    m.status.width = x - 40 - statusLeft
end sub

sub styleTop()
    for i = 0 to m.topNodes.Count() - 1
        m.topNodes[i].focused = (m.focusArea = "top" and i = m.topIndex)
    end for
end sub

' --- chips -------------------------------------------------------------------------------------

sub buildChips()
    for each n in m.chipNodes
        m.chips.removeChild(n)
    end for
    m.chipDefs = []
    m.chipNodes = []
    m.chipDefs.Push({ key: "", text: "All", icon: "" })
    for each c in m.snapshot.categories
        n = 0
        for each e in m.snapshot.events
            if e.cat = c.id then n += 1
        end for
        if n > 0 then m.chipDefs.Push({ key: "cat:" + c.id.ToStr(), text: c.name, icon: "" })
    end for
    ' Without a premium account the premium-only games live in their own tab.
    if premiumHidden() then m.chipDefs.Push({ key: m.premiumFilter, text: "Premium Only", icon: "star" })
    ' With one, the account's IPTV channels get a tab of their own (a separate screen).
    if hasLiveTv() then m.chipDefs.Push({ key: m.liveTvChip, text: "Live TV", icon: "tv" })

    ' If the remembered chip is gone (sport not on today), fall back to All.
    found = false
    for i = 0 to m.chipDefs.Count() - 1
        if m.chipDefs[i].key = m.filter then found = true
    end for
    if not found then m.filter = ""

    for i = 0 to m.chipDefs.Count() - 1
        d = m.chipDefs[i]
        p = m.chips.createChild("Pill")
        p.kind = "chip"
        p.icon = d.icon
        p.text = d.text
        m.chipNodes.Push(p)
        if d.key = m.filter then m.chipIndex = i
    end for
    layoutChips(false)
    styleChips()
end sub

sub layoutChips(animate as boolean)
    x = 0
    for each p in m.chipNodes
        p.translation = [x, 0]
        x += p.pillWidth + m.g.chipGap
    end for
    m.chipsW = x - m.g.chipGap
    if m.chipsW < 0 then m.chipsW = 0
    alignChip(animate)
end sub

sub styleChips()
    for i = 0 to m.chipNodes.Count() - 1
        p = m.chipNodes[i]
        p.selected = (m.chipDefs[i].key = m.filter)
        p.focused = (m.focusArea = "chips" and i = m.chipIndex)
    end for
end sub

' Keep the focused chip centred in the scroller (HomeActivity chip focus listener).
sub alignChip(animate as boolean)
    scroll = 0
    if m.focusArea = "chips" and m.chipIndex >= 0 and m.chipIndex < m.chipNodes.Count()
        p = m.chipNodes[m.chipIndex]
        target = p.translation[0] + Int(p.pillWidth / 2) - 960 + m.g.padX
        maxScroll = m.chipsW + m.g.padX * 2 - 1920
        if maxScroll < 0 then maxScroll = 0
        if target > maxScroll then target = maxScroll
        if target > 0 then scroll = target
    else
        ' Unfocused: hold whatever scroll was reached (Android keeps it); default to the start.
        cur = m.chips.translation[0]
        scroll = m.g.padX - cur
        if scroll < 0 then scroll = 0
    end if
    moveTo(m.chips, m.chipsAnim, m.chipsInterp, [m.g.padX - scroll, 0], animate)
end sub

sub selectChip(i as integer)
    if i < 0 or i >= m.chipDefs.Count() then return
    key = m.chipDefs[i].key
    if key = m.liveTvChip
        m.top.navigate = { screen: "LiveTvScreen" }
        return
    end if
    if key = m.filter then return
    m.filter = key
    Filter_save(key)
    styleChips()
    buildRows(false)
    m.layoutTimer.control = "start"
end sub

' --- rows --------------------------------------------------------------------------------------

' HomeActivity.render(): Continue Watching, Your Teams, Live Now, then one row per sport.
function computeRows() as object
    rows = []
    s = m.snapshot
    hidden = premiumHidden()
    premiumOnly = hidden and m.filter = m.premiumFilter
    filterCat = -1
    if startsWith(m.filter, "cat:") and not premiumOnly then filterCat = Mid(m.filter, 5).ToInt()

    byId = {}
    for each e in s.events
        byId[e.id] = e
    end for

    if filterCat < 0 and not premiumOnly
        recent = []
        for each r in Recent_load()
            e = byId[r.id]
            if e = invalid
                e = Event_new()
                e.id = r.id
                e.home = strOr(r.home, "")
                e.away = strOr(r.away, "")
                e.url = strOr(r.url, "")
                e.cat = toInt(r.cat)
                e.league = strOr(r.league, "")
                e.ch = strOr(r.ch, "")
                e.ca = strOr(r.ca, "")
                e.ts = toInt(r.ts)
            end if
            recent.Push(e)
            if recent.Count() >= 6 then exit for
        end for
        recent = premiumPass(recent, hidden, false)
        if recent.Count() > 0 then rows.Push({ title: "Continue Watching", sub: "Games you opened recently", events: recent })
    end if

    if not Fav_isEmpty(m.fav)
        mine = []
        for each e in s.events
            if Fav_matches(m.fav, e, m.categoryNames) and (filterCat < 0 or e.cat = filterCat) then mine.Push(e)
        end for
        mine = premiumPass(mine, hidden, premiumOnly)
        if mine.Count() > 0 then rows.Push({ title: "Your Teams", sub: "Starred teams and leagues", events: mine })
    end if

    live = []
    for each e in s.events
        if e.live and not e.ended and (filterCat < 0 or e.cat = filterCat) then live.Push(e)
    end for
    live = premiumPass(live, hidden, premiumOnly)
    if live.Count() > 0
        subtitle = live.Count().ToStr() + " games"
        if live.Count() = 1 then subtitle = "1 game"
        rows.Push({ title: "Live Now", sub: subtitle, events: favoritesFirst(live) })
    end if

    for each c in s.categories
        if filterCat < 0 or c.id = filterCat
            list = []
            for each e in s.events
                if e.cat = c.id then list.Push(e)
            end for
            list = premiumPass(list, hidden, premiumOnly)
            if list.Count() > 0
                liveN = 0
                endedN = 0
                for each e in list
                    if e.ended
                        endedN += 1
                    else if e.live
                        liveN += 1
                    end if
                end for
                upcoming = list.Count() - liveN - endedN
                if liveN > 0
                    subtitle = liveN.ToStr() + " live · " + upcoming.ToStr() + " upcoming"
                else
                    subtitle = upcoming.ToStr() + " upcoming"
                end if
                if endedN > 0 then subtitle += " · " + endedN.ToStr() + " final"
                rows.Push({ title: c.name, sub: subtitle, events: favoritesFirst(list) })
            end if
        end if
    end for
    return rows
end function

' With premium hidden: only the premium games (premiumOnly) or only the free ones.
function premiumPass(list as object, hidden as boolean, premiumOnly as boolean) as object
    if not hidden then return list
    out = []
    for each e in list
        if e.pro = premiumOnly then out.Push(e)
    end for
    return out
end function

' Stable: starred games first, everything else in its existing order.
function favoritesFirst(list as object) as object
    if Fav_isEmpty(m.fav) then return list
    out = []
    for each e in list
        if Fav_matches(m.fav, e, m.categoryNames) then out.Push(e)
    end for
    if out.Count() = 0 then return list
    for each e in list
        if not Fav_matches(m.fav, e, m.categoryNames) then out.Push(e)
    end for
    return out
end function

sub buildRows(keepFocus as boolean)
    ' Remember which game had focus so it can take it back after the rebuild.
    if not keepFocus then m.focusedEventId = ""
    for each rn in m.rowNodes
        m.rowsGroup.removeChild(rn.group)
        m.top.removeChild(rn.anim)
    end for
    m.rowNodes = []
    m.rowDefs = computeRows()
    if m.emptyNote <> invalid
        m.rowsGroup.removeChild(m.emptyNote)
        m.emptyNote = invalid
    end if

    g = m.g
    for ri = 0 to m.rowDefs.Count() - 1
        row = m.rowDefs[ri]
        grp = m.rowsGroup.createChild("Group")
        grp.id = "row" + ri.ToStr()
        grp.translation = [0, ri * g.rowH]
        title = grp.createChild("Label")
        title.id = "rowTitle"
        title.font = Ui_font(Ui_sp(20), true)
        title.color = Ui_color("text")
        title.text = row.title
        title.height = g.headerH
        title.vertAlign = "bottom"
        title.translation = [g.padX, g.headerTop]
        subLabel = grp.createChild("Label")
        subLabel.id = "rowSub"
        subLabel.font = Ui_font(Ui_sp(13), false)
        subLabel.color = Ui_color("muted")
        subLabel.text = row.sub
        subLabel.height = g.headerH - 6
        subLabel.vertAlign = "bottom"
        strip = grp.createChild("Group")
        strip.id = "strip" + ri.ToStr()
        strip.translation = [g.padX, g.stripTop]
        cards = []
        for ci = 0 to row.events.Count() - 1
            e = row.events[ci]
            card = strip.createChild("EventCard")
            card.id = "card"
            card.translation = [ci * (g.cardW + g.cardGap), 0]
            card.content = Ui_eventNode(e, Fav_matches(m.fav, e, m.categoryNames))
            cards.Push(card)
        end for
        anim = m.top.createChild("Animation")
        anim.duration = 0.25
        anim.easeFunction = "outQuad"
        interp = anim.createChild("Vector2DFieldInterpolator")
        interp.fieldToInterp = strip.id + ".translation"
        interp.key = [0, 1]
        interp.keyValue = [[g.padX, g.stripTop], [g.padX, g.stripTop]]
        m.rowNodes.Push({ group: grp, title: title, subLabel: subLabel, strip: strip, cards: cards, anim: anim, interp: interp, scroll: 0 })
    end for
    layoutRowHeaders()

    if m.rowDefs.Count() = 0
        hidden = premiumHidden()
        if hidden and m.filter = m.premiumFilter
            note = "No premium-only games are listed right now."
        else if startsWith(m.filter, "cat:")
            note = "Nothing in " + strOr(m.categoryNames[Mid(m.filter, 5)], "this sport") + " right now."
        else if hidden and m.snapshot.events.Count() > 0
            note = "Every game listed right now is premium-only. See the Premium Only tab, or sign in to a premium account."
        else
            showProblem("Nothing is listed right now.")
            return
        end if
        m.emptyNote = m.rowsGroup.createChild("Label")
        m.emptyNote.font = Ui_font(Ui_sp(16), false)
        m.emptyNote.color = Ui_color("muted")
        m.emptyNote.translation = [g.padX, 80]
        m.emptyNote.width = 1920 - g.padX * 2
        m.emptyNote.wrap = true
        m.emptyNote.text = note
    end if
    hideOverlay()

    ' Focus: the same game if it is still there, else the first card.
    target = [0, 0]
    if m.focusedEventId <> ""
        found = false
        for ri = 0 to m.rowDefs.Count() - 1
            for ci = 0 to m.rowDefs[ri].events.Count() - 1
                if not found and m.rowDefs[ri].events[ci].id = m.focusedEventId
                    target = [ri, ci]
                    found = true
                end if
            end for
        end for
    end if
    m.rowIndex = target[0]
    m.colIndex = target[1]
    if m.rowDefs.Count() = 0
        if m.focusArea = "rows" then focusChips()
        m.scrollY = 0
        moveTo(m.rowsGroup, m.rowsAnim, m.rowsInterp, [0, g.scrollPadTop], false)
        return
    end if
    if m.focusArea = "rows" or not m.everFocusedRows
        m.focusArea = "rows"
        m.everFocusedRows = true
    end if
    applyRowFocus(false)
    styleChips()
    styleTop()
end sub

' Header: title, then the subtitle 12 dp to its right, both sitting on the header's bottom line.
sub layoutRowHeaders()
    for each rn in m.rowNodes
        tw = Ui_textWidth(rn.title)
        rn.title.width = tw + 4
        rn.subLabel.translation = [m.g.padX + tw + 24, m.g.headerTop]
        rn.subLabel.width = 1920 - (m.g.padX + tw + 24) - m.g.padX
    end for
end sub

' Stars changed on another screen or via the dialog: restyle without rebuilding.
sub refreshStars()
    for each rn in m.rowNodes
        for each card in rn.cards
            n = card.content
            s = Fav_matches(m.fav, Ui_eventFromNode(n), m.categoryNames)
            if n.starred <> s
                n.starred = s
                card.relayout = true
            end if
        end for
    end for
end sub

' ---------------------------------------------------------------------------------------------
' Scrolling (HomeActivity.alignCard / alignRow)
' ---------------------------------------------------------------------------------------------

sub moveTo(node as object, anim as object, interp as object, target as object, animate as boolean)
    if animate
        cur = node.translation
        interp.keyValue = [[cur[0], cur[1]], [target[0], target[1]]]
        anim.control = "start"
    else
        anim.control = "stop"
        node.translation = target
    end if
end sub

' Horizontally centre the focused card inside its row's scroller (1920 wide, 96 px padding).
sub alignCard(ri as integer, animate as boolean)
    g = m.g
    rn = m.rowNodes[ri]
    n = rn.cards.Count()
    if n = 0 then return
    cardLeft = m.colIndex * (g.cardW + g.cardGap)
    target = cardLeft + Int(g.cardW / 2) - 960 + g.padX
    maxScroll = n * (g.cardW + g.cardGap) + g.padX * 2 - 1920
    if maxScroll < 0 then maxScroll = 0
    if target > maxScroll then target = maxScroll
    if target < 0 then target = 0
    rn.scroll = target
    moveTo(rn.strip, rn.anim, rn.interp, [g.padX - target, g.stripTop], animate)
end sub

' Vertically bring the focused row near the top so the rows below stay visible.
sub alignRow(ri as integer, animate as boolean)
    g = m.g
    ' Android: row.getTop() is relative to the rows column (no padding of its own), minus 6 dp.
    rowTop = ri * g.rowH
    target = rowTop - 12
    maxScroll = g.scrollPadTop + m.rowNodes.Count() * g.rowH + g.scrollPadBottom - g.scrollerH
    if maxScroll < 0 then maxScroll = 0
    if target > maxScroll then target = maxScroll
    if target < 0 then target = 0
    m.scrollY = target
    moveTo(m.rowsGroup, m.rowsAnim, m.rowsInterp, [0, g.scrollPadTop - target], animate)
end sub

' Screen x of a card's centre given its row's current scroll.
function cardCenterX(ri as integer, ci as integer) as integer
    g = m.g
    return g.padX - m.rowNodes[ri].scroll + ci * (g.cardW + g.cardGap) + Int(g.cardW / 2)
end function

' Card in row `ri` whose centre is nearest screen x (what Android's focus search picks).
function nearestCol(ri as integer, x as integer) as integer
    best = 0
    bestD = 999999
    for ci = 0 to m.rowNodes[ri].cards.Count() - 1
        d = Abs(cardCenterX(ri, ci) - x)
        if d < bestD
            bestD = d
            best = ci
        end if
    end for
    return best
end function

sub applyRowFocus(animate as boolean)
    if m.rowIndex >= m.rowNodes.Count() then m.rowIndex = m.rowNodes.Count() - 1
    if m.rowIndex < 0 then m.rowIndex = 0
    for ri = 0 to m.rowNodes.Count() - 1
        cards = m.rowNodes[ri].cards
        for ci = 0 to cards.Count() - 1
            on = (m.focusArea = "rows" and ri = m.rowIndex and ci = m.colIndex)
            if cards[ci].focused <> on then cards[ci].focused = on
        end for
    end for
    if m.rowNodes.Count() = 0 then return
    if m.colIndex >= m.rowNodes[m.rowIndex].cards.Count() then m.colIndex = 0
    if m.focusArea = "rows"
        m.focusedEventId = m.rowDefs[m.rowIndex].events[m.colIndex].id
        alignCard(m.rowIndex, animate)
        alignRow(m.rowIndex, animate)
    end if
end sub

' ---------------------------------------------------------------------------------------------
' Focus + keys
' ---------------------------------------------------------------------------------------------

sub focusRows()
    if m.rowNodes.Count() > 0
        m.focusArea = "rows"
        m.everFocusedRows = true
        applyRowFocus(true)
    else if m.chipNodes.Count() > 0
        m.focusArea = "chips"
    else
        m.focusArea = "top"
    end if
    styleChips()
    styleTop()
    alignChip(true)
end sub

sub focusChips()
    m.focusArea = "chips"
    applyRowFocus(false)
    styleChips()
    styleTop()
    alignChip(true)
end sub

sub focusTop()
    m.focusArea = "top"
    applyRowFocus(false)
    styleChips()
    styleTop()
    alignChip(true)
end sub

' Chip nearest a screen x (moving up from a card / down from a button lands on it).
function nearestChip(x as integer) as integer
    best = m.chipIndex
    bestD = 999999
    for i = 0 to m.chipNodes.Count() - 1
        p = m.chipNodes[i]
        cx = m.chips.translation[0] + p.translation[0] + Int(p.pillWidth / 2)
        d = Abs(cx - x)
        if d < bestD
            bestD = d
            best = i
        end if
    end for
    return best
end function

function nearestTop(x as integer) as integer
    best = m.topIndex
    bestD = 999999
    for i = 0 to m.topNodes.Count() - 1
        p = m.topNodes[i]
        cx = 1824 + p.translation[0] + Int(p.pillWidth / 2)
        d = Abs(cx - x)
        if d < bestD
            bestD = d
            best = i
        end if
    end for
    return best
end function

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false

    if m.focusArea = "overlay"
        if key = "OK" and m.showingProblem
            showLoading()
            startFullRefresh()
            return true
        end if
        return key <> "back"

    else if m.focusArea = "chips"
        if key = "left"
            if m.chipIndex > 0 then m.chipIndex -= 1
            styleChips()
            alignChip(true)
            return true
        else if key = "right"
            if m.chipIndex < m.chipNodes.Count() - 1 then m.chipIndex += 1
            styleChips()
            alignChip(true)
            return true
        else if key = "OK"
            selectChip(m.chipIndex)
            return true
        else if key = "down"
            if m.rowNodes.Count() > 0
                p = m.chipNodes[m.chipIndex]
                cx = m.chips.translation[0] + p.translation[0] + Int(p.pillWidth / 2)
                m.colIndex = nearestCol(m.rowIndex, cx)
                focusRows()
            end if
            return true
        else if key = "up"
            p = m.chipNodes[m.chipIndex]
            m.topIndex = nearestTop(m.chips.translation[0] + p.translation[0] + Int(p.pillWidth / 2))
            focusTop()
            return true
        end if

    else if m.focusArea = "top"
        if key = "left"
            if m.topIndex > 0 then m.topIndex -= 1
            styleTop()
            return true
        else if key = "right"
            if m.topIndex < m.topNodes.Count() - 1 then m.topIndex += 1
            styleTop()
            return true
        else if key = "down"
            p = m.topNodes[m.topIndex]
            m.chipIndex = nearestChip(1824 + p.translation[0] + Int(p.pillWidth / 2))
            focusChips()
            return true
        else if key = "OK"
            activateTop(m.topIndex)
            return true
        end if

    else
        if m.rowNodes.Count() = 0
            if key = "up" then focusChips()
            return true
        end if
        if key = "left"
            if m.colIndex > 0
                m.colIndex -= 1
                applyRowFocus(true)
            end if
            return true
        else if key = "right"
            if m.colIndex < m.rowNodes[m.rowIndex].cards.Count() - 1
                m.colIndex += 1
                applyRowFocus(true)
            end if
            return true
        else if key = "down"
            if m.rowIndex < m.rowNodes.Count() - 1
                x = cardCenterX(m.rowIndex, m.colIndex)
                m.rowIndex += 1
                m.colIndex = nearestCol(m.rowIndex, x)
                applyRowFocus(true)
            end if
            return true
        else if key = "up"
            x = cardCenterX(m.rowIndex, m.colIndex)
            if m.rowIndex > 0
                m.rowIndex -= 1
                m.colIndex = nearestCol(m.rowIndex, x)
                applyRowFocus(true)
            else
                m.chipIndex = nearestChip(x)
                focusChips()
            end if
            return true
        else if key = "OK"
            openFocusedEvent()
            return true
        else if key = "options"
            openStarDialog()
            return true
        end if
    end if

    if key = "options"
        startFullRefresh()
        return true
    end if
    return false
end function

sub activateTop(i as integer)
    if i < 0 or i >= m.topDefs.Count() then return
    k = m.topDefs[i].key
    if k = "refresh"
        m.status.text = "Refreshing…"
        startFullRefresh()
        recheckAccount(true)
    else if k = "account"
        m.top.navigate = { screen: "AccountScreen" }
    end if
end sub

' Developer key injection (see MainScene.onDevCmd): keys are all handled here anyway.
sub onDevKey()
    onKeyEvent(m.top.devKey, true)
end sub

function focusedEvent() as dynamic
    if m.rowIndex >= m.rowDefs.Count() then return invalid
    events = m.rowDefs[m.rowIndex].events
    if m.colIndex >= events.Count() then return invalid
    return events[m.colIndex]
end function

sub openFocusedEvent()
    e = focusedEvent()
    if e = invalid then return
    Recent_record(e)
    m.top.navigate = { screen: "PlayerScreen", event: e, base: strOr(m.snapshot.base, "") }
end sub

' --- favourites dialog (Android: long-press a card) --------------------------------------------

sub openStarDialog()
    e = focusedEvent()
    if e = invalid then return
    m.dialogEvent = e
    m.dialogChoices = []
    buttons = []
    if e.home <> ""
        m.dialogChoices.Push({ kind: "team", value: e.home })
        buttons.Push(starLabel(Fav_isTeam(m.fav, e.home), e.home))
    end if
    if e.away <> ""
        m.dialogChoices.Push({ kind: "team", value: e.away })
        buttons.Push(starLabel(Fav_isTeam(m.fav, e.away), e.away))
    end if
    league = Fav_leagueOf(e, m.categoryNames)
    if league <> ""
        m.dialogChoices.Push({ kind: "league", value: league })
        buttons.Push(starLabel(Fav_isLeague(m.fav, league), "all " + UCase(league)))
    end if
    buttons.Push("Cancel")
    d = CreateObject("roSGNode", "Dialog")
    d.title = Event_title(e)
    d.message = "Starred teams and leagues sort first and get their own row."
    d.buttons = buttons
    d.observeField("buttonSelected", "onStarChoice")
    m.top.getScene().dialog = d
end sub

function starLabel(on as boolean, what as string) as string
    if on then return "Unstar " + what
    return Chr(9733) + " Star " + what
end function

sub onStarChoice(ev as object)
    d = ev.getRoSGNode()
    i = ev.getData()
    d.close = true
    if i < 0 or i >= m.dialogChoices.Count() then return
    c = m.dialogChoices[i]
    if c.kind = "team" then Fav_toggleTeam(m.fav, c.value) else Fav_toggleLeague(m.fav, c.value)
    buildRows(true)
    m.layoutTimer.control = "start"
end sub
