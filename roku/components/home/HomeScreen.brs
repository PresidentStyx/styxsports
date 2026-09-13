' Home: schedule rows with live scores, sport chips, account button. Cached snapshot paints
' first; a full refresh runs at launch and every 10 minutes, clocks/scores every 30 seconds.

sub init()
    m.status = m.top.findNode("status")
    m.topButtons = m.top.findNode("topButtons")
    m.chipClip = m.top.findNode("chipClip")
    m.chips = m.top.findNode("chips")
    m.rows = m.top.findNode("rows")
    m.message = m.top.findNode("message")
    m.hint = m.top.findNode("hint")
    m.statusTimer = m.top.findNode("statusTimer")
    m.fullTimer = m.top.findNode("fullTimer")

    m.premiumFilter = "__premium__"
    m.liveTvChip = "__livetv__"
    m.focusArea = "rows"
    m.chipIndex = 0
    m.topIndex = 0
    m.chipDefs = []
    m.chipNodes = []
    m.topDefs = []
    m.topNodes = []
    m.filter = Filter_load()
    if m.filter = m.liveTvChip then m.filter = ""
    m.fav = Fav_load()
    m.categoryNames = {}
    m.loading = false
    m.lastError = ""
    m.retryOnOk = false
    m.accountChecking = false
    m.renderedSignedIn = Account_isSignedIn()
    m.renderedLiveTv = Account_hasIptv()

    m.rows.observeField("rowItemSelected", "onRowItemSelected")
    m.statusTimer.observeField("fire", "onStatusTick")
    m.fullTimer.observeField("fire", "onFullTick")

    m.hint.text = "OK  watch   ·   * (options)  star a team   ·   Up  sports"

    m.snapshot = Site_cached()
    if m.snapshot <> invalid
        Events_sort(m.snapshot.events)
        render(true)
    else
        showMessage("Loading games…")
        buildTopButtons()
    end if
    startFullRefresh()
    m.statusTimer.control = "start"
    m.fullTimer.control = "start"
    recheckAccount(false)
end sub

' The scene attached us and handed over focus: focus can only land on the rows now.
sub onStart()
    if m.top.start then focusRows()
end sub

' Back from another screen: the account may have changed (sign-in, Live TV discovered).
sub onResumed()
    if not m.top.resumed then return
    m.fav = Fav_load()
    signedIn = Account_isSignedIn()
    if signedIn <> m.renderedSignedIn or Account_hasIptv() <> m.renderedLiveTv
        if m.filter = m.premiumFilter and signedIn then m.filter = ""
        if m.snapshot <> invalid then render(true) else buildTopButtons()
    else
        refreshStars()
    end if
    recheckAccount(false)
end sub

' ---------------------------------------------------------------------------------------------
' Data
' ---------------------------------------------------------------------------------------------

sub startFullRefresh()
    if m.loading then return
    m.loading = true
    m.status.text = "Refreshing…"
    Ui_task("schedule", {}, "onSchedule")
end sub

sub onSchedule(ev as object)
    m.loading = false
    r = ev.getData()
    if r = invalid then return
    if r.ok = true
        m.lastError = ""
        m.snapshot = r
        render(false)
    else
        m.lastError = strOr(r.error, "unknown error")
        if m.snapshot = invalid
            showMessage("Could not load the schedule." + Chr(10) + m.lastError + Chr(10) + Chr(10) + "Press OK to try again.")
            m.retryOnOk = true
        end if
        updateStatus()
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
    content = m.rows.content
    if content = invalid then return
    for ri = 0 to content.getChildCount() - 1
        row = content.getChild(ri)
        for i = 0 to row.getChildCount() - 1
            n = row.getChild(i)
            u = byId[n.id]
            if u <> invalid and (n.live <> u.live or n.ended <> u.ended or n.lt <> u.lt or n.sc <> u.sc)
                n.live = u.live
                n.ended = u.ended
                n.lt = u.lt
                n.sc = u.sc
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
    if r.signedIn <> m.renderedSignedIn or r.hasIptv <> m.renderedLiveTv
        if m.snapshot <> invalid then render(true) else buildTopButtons()
    end if
end sub

' ---------------------------------------------------------------------------------------------
' Rendering
' ---------------------------------------------------------------------------------------------

sub showMessage(text as string)
    m.message.text = text
    m.message.visible = text <> ""
end sub

sub render(keepFocus as boolean)
    m.renderedSignedIn = Account_isSignedIn()
    m.renderedLiveTv = Account_hasIptv()
    m.categoryNames = {}
    for each c in m.snapshot.categories
        m.categoryNames[c.id.ToStr()] = c.name
    end for
    buildTopButtons()
    buildChips()
    buildRows(keepFocus)
    updateStatus()
end sub

sub updateStatus()
    if m.snapshot = invalid
        if m.lastError <> "" then m.status.text = m.lastError
        return
    end if
    live = 0
    for each e in m.snapshot.events
        if e.live then live += 1
    end for
    t = m.snapshot.events.Count().ToStr() + " games · " + live.ToStr() + " live · updated " + Ui_ago(toInt(m.snapshot.fetchedAt))
    if m.lastError <> "" then t += "  ·  refresh failed: " + m.lastError
    m.status.text = t
end sub

' --- top bar buttons ---------------------------------------------------------------------------

sub buildTopButtons()
    for each n in m.topNodes
        m.topButtons.removeChild(n)
    end for
    m.topDefs = []
    m.topNodes = []
    m.topDefs.Push({ key: "refresh", text: "Refresh", accent: "" })
    if Account_isSignedIn()
        label = "Account"
        if Account_premiumKnown() = "yes" then label = "Premium " + Chr(10003)
        m.topDefs.Push({ key: "account", text: label, accent: "gold" })
    else
        m.topDefs.Push({ key: "account", text: "Sign in", accent: "" })
    end if
    ' Right-aligned: lay out from the right edge leftwards.
    x = 0
    for i = m.topDefs.Count() - 1 to 0 step -1
        d = m.topDefs[i]
        p = m.topButtons.createChild("Pill")
        p.pillHeight = 48
        p.minWidth = 130
        p.accent = d.accent
        p.text = d.text
        x -= p.pillWidth
        p.translation = [x, 0]
        x -= 16
        m.topNodes.Unshift(p)
    end for
    if m.topIndex >= m.topDefs.Count() then m.topIndex = m.topDefs.Count() - 1
    styleTop()
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
    signedIn = Account_isSignedIn()

    m.chipDefs.Push({ key: "", text: "All", accent: "" })
    hasPremiumOnly = false
    for each e in m.snapshot.events
        if e.pro then hasPremiumOnly = true
    end for
    if hasPremiumOnly and not signedIn then m.chipDefs.Push({ key: m.premiumFilter, text: "Premium Only", accent: "gold" })
    for each c in m.snapshot.categories
        n = 0
        for each e in m.snapshot.events
            if e.cat = c.id and (signedIn or not e.pro) then n += 1
        end for
        if n > 0 then m.chipDefs.Push({ key: "cat:" + c.id.ToStr(), text: c.name, accent: "" })
    end for
    if Account_hasIptv() then m.chipDefs.Push({ key: m.liveTvChip, text: "Live TV", accent: "accent" })

    ' If the remembered chip is gone (sport not on today), fall back to All.
    found = false
    for i = 0 to m.chipDefs.Count() - 1
        if m.chipDefs[i].key = m.filter then found = true
    end for
    if not found then m.filter = ""

    x = 0
    for i = 0 to m.chipDefs.Count() - 1
        d = m.chipDefs[i]
        p = m.chips.createChild("Pill")
        p.minWidth = 96
        p.accent = d.accent
        p.text = d.text
        p.translation = [x, 0]
        x += p.pillWidth + 14
        m.chipNodes.Push(p)
        if d.key = m.filter then m.chipIndex = i
    end for
    styleChips()
end sub

sub styleChips()
    for i = 0 to m.chipNodes.Count() - 1
        p = m.chipNodes[i]
        p.selected = (m.chipDefs[i].key = m.filter)
        p.focused = (m.focusArea = "chips" and i = m.chipIndex)
    end for
    ' Keep the focused chip on screen.
    if m.chipIndex >= 0 and m.chipIndex < m.chipNodes.Count()
        p = m.chipNodes[m.chipIndex]
        left = p.translation[0]
        right = left + p.pillWidth
        shift = m.chips.translation[0]
        if right + shift > 1776 then shift = 1776 - right
        if left + shift < 0 then shift = -left
        m.chips.translation = [shift, 0]
    end if
end sub

sub selectChip(i as integer)
    if i < 0 or i >= m.chipDefs.Count() then return
    key = m.chipDefs[i].key
    if key = m.liveTvChip
        m.top.navigate = { screen: "LiveTvScreen" }
        return
    end if
    m.filter = key
    Filter_save(key)
    styleChips()
    buildRows(false)
end sub

' --- rows --------------------------------------------------------------------------------------

sub buildRows(keepFocus as boolean)
    signedIn = Account_isSignedIn()
    focused = m.rows.rowItemFocused
    rows = []
    all = m.snapshot.events

    if m.filter = m.premiumFilter
        for each c in m.snapshot.categories
            list = []
            for each e in all
                if e.pro and e.cat = c.id then list.Push(e)
            end for
            if list.Count() > 0 then rows.Push({ title: c.name, events: list })
        end for
        other = []
        for each e in all
            if e.pro and Snapshot_category(m.snapshot, e.cat) = invalid then other.Push(e)
        end for
        if other.Count() > 0 then rows.Push({ title: "Other", events: other })

    else if startsWith(m.filter, "cat:")
        catId = Mid(m.filter, 5).ToInt()
        live = []
        upcoming = []
        finished = []
        for each e in all
            if e.cat = catId and (signedIn or not e.pro)
                if e.live
                    live.Push(e)
                else if e.ended
                    finished.Push(e)
                else
                    upcoming.Push(e)
                end if
            end if
        end for
        if live.Count() > 0 then rows.Push({ title: "Live now", events: live })
        if upcoming.Count() > 0 then rows.Push({ title: "Upcoming", events: upcoming })
        if finished.Count() > 0 then rows.Push({ title: "Finished", events: finished })

    else
        visible = []
        for each e in all
            if signedIn or not e.pro then visible.Push(e)
        end for
        byId = {}
        for each e in visible
            byId[e.id] = e
        end for
        cont = []
        for each r in Recent_load()
            e = byId[r.id]
            if e <> invalid and not e.ended then cont.Push(e)
        end for
        if cont.Count() > 0 then rows.Push({ title: "Continue watching", events: cont })
        mine = []
        for each e in visible
            if Fav_matches(m.fav, e, m.categoryNames) and not e.ended then mine.Push(e)
        end for
        if mine.Count() > 0 then rows.Push({ title: Chr(9733) + " Your teams", events: mine })
        live = []
        for each e in visible
            if e.live then live.Push(e)
        end for
        if live.Count() > 0 then rows.Push({ title: "Live now", events: live })
        for each c in m.snapshot.categories
            list = []
            for each e in visible
                if e.cat = c.id then list.Push(e)
            end for
            if list.Count() > 0 then rows.Push({ title: c.name, events: list })
        end for
        other = []
        for each e in visible
            if Snapshot_category(m.snapshot, e.cat) = invalid then other.Push(e)
        end for
        if other.Count() > 0 then rows.Push({ title: "Other", events: other })
    end if

    root = CreateObject("roSGNode", "ContentNode")
    for each row in rows
        rn = root.createChild("ContentNode")
        rn.title = row.title
        ' Favourites first within a row (rows arrive in schedule order already).
        starred = []
        rest = []
        for each e in row.events
            if Fav_matches(m.fav, e, m.categoryNames) then starred.Push(e) else rest.Push(e)
        end for
        for each e in starred
            rn.appendChild(Ui_eventNode(e, true))
        end for
        for each e in rest
            rn.appendChild(Ui_eventNode(e, false))
        end for
    end for
    m.rows.content = root

    if rows.Count() = 0
        if m.filter = m.premiumFilter
            showMessage("No premium-only games right now.")
        else
            showMessage("No games listed here right now.")
        end if
        m.retryOnOk = false
    else
        showMessage("")
        if keepFocus and focused <> invalid and focused.Count() = 2 and focused[0] < rows.Count()
            item = focused[1]
            if item >= rows[focused[0]].events.Count() then item = 0
            m.rows.jumpToRowItem = [focused[0], item]
        else
            m.rows.jumpToRowItem = [0, 0]
        end if
    end if
end sub

' Stars changed on another screen or via the dialog: restyle without rebuilding.
sub refreshStars()
    content = m.rows.content
    if content = invalid then return
    for r = 0 to content.getChildCount() - 1
        row = content.getChild(r)
        for i = 0 to row.getChildCount() - 1
            n = row.getChild(i)
            s = Fav_matches(m.fav, Ui_eventFromNode(n), m.categoryNames)
            if n.starred <> s then n.starred = s
        end for
    end for
end sub

' ---------------------------------------------------------------------------------------------
' Focus + keys
' ---------------------------------------------------------------------------------------------

sub focusRows()
    if m.rows.content <> invalid and m.rows.content.getChildCount() > 0
        m.focusArea = "rows"
        m.rows.setFocus(true)
    else
        m.focusArea = "chips"
        m.top.setFocus(true)
    end if
    styleChips()
    styleTop()
end sub

sub focusChips()
    m.focusArea = "chips"
    m.top.setFocus(true)
    styleChips()
    styleTop()
end sub

sub focusTop()
    m.focusArea = "top"
    m.top.setFocus(true)
    styleChips()
    styleTop()
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false

    if m.focusArea = "chips"
        if key = "left"
            if m.chipIndex > 0 then m.chipIndex -= 1
            styleChips()
            return true
        else if key = "right"
            if m.chipIndex < m.chipNodes.Count() - 1 then m.chipIndex += 1
            styleChips()
            return true
        else if key = "OK"
            if m.retryOnOk = true and m.snapshot = invalid
                startFullRefresh()
            else
                selectChip(m.chipIndex)
            end if
            return true
        else if key = "down"
            focusRows()
            return true
        else if key = "up"
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
            focusChips()
            return true
        else if key = "OK"
            activateTop(m.topIndex)
            return true
        end if

    else
        ' RowList has focus: it consumes what it can; "up" past the first row lands here.
        if key = "up"
            focusChips()
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
        startFullRefresh()
        recheckAccount(true)
    else if k = "account"
        m.top.navigate = { screen: "AccountScreen" }
    end if
end sub

sub onRowItemSelected(ev as object)
    sel = ev.getData()
    content = m.rows.content
    if sel = invalid or sel.Count() < 2 or content = invalid then return
    row = content.getChild(sel[0])
    if row = invalid then return
    n = row.getChild(sel[1])
    if n = invalid then return
    e = Ui_eventFromNode(n)
    Recent_record(e)
    m.top.navigate = { screen: "PlayerScreen", event: e, base: strOr(m.snapshot.base, "") }
end sub

' --- favourites dialog -------------------------------------------------------------------------

sub openStarDialog()
    content = m.rows.content
    focused = m.rows.rowItemFocused
    if content = invalid or focused = invalid or focused.Count() < 2 then return
    row = content.getChild(focused[0])
    if row = invalid then return
    n = row.getChild(focused[1])
    if n = invalid then return
    e = Ui_eventFromNode(n)
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
end sub
