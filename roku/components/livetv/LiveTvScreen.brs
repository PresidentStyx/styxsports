' Live TV: LiveTvActivity in SceneGraph. Groups down the left, the shown group's channels on the
' right; the shown group is remembered across launches (Recently watched aside), like Android.

sub init()
    m.title = m.top.findNode("title")
    m.subtitle = m.top.findNode("subtitle")
    m.hint = m.top.findNode("hint")
    m.hintA = m.top.findNode("hintA")
    m.hintB = m.top.findNode("hintB")
    m.triL = m.top.findNode("triL")
    m.triR = m.top.findNode("triR")
    m.groups = m.top.findNode("groups")
    m.grid = m.top.findNode("grid")
    m.statusPanel = m.top.findNode("statusPanel")
    m.spinner = m.top.findNode("spinner")
    m.statusText = m.top.findNode("statusText")
    m.statusButtons = m.top.findNode("statusButtons")

    m.index = invalid
    m.groupList = []
    m.channels = []
    m.shownIndex = -1
    m.loading = false
    m.leaseDenied = false
    m.statusNodes = []
    m.statusIndex = 0

    styleChrome()
    m.groups.observeField("itemFocused", "onGroupFocused")
    m.groups.observeField("itemSelected", "onGroupSelected")
    m.grid.observeField("itemSelected", "onChannelSelected")
end sub

' ---------------------------------------------------------------------------------------------
' Chrome (fonts, colours, geometry from LiveTvActivity.buildUi)
' ---------------------------------------------------------------------------------------------

sub styleChrome()
    ' Top bar: 22 dp top / 14 dp bottom padding; the tallest child (title over subtitle) sets the
    ' bar height and everything is centred on it.
    titleH = Ui_lineHeight(Ui_sp(22))
    subH = Ui_lineHeight(Ui_sp(13))
    hintH = Ui_lineHeight(Ui_sp(13))
    contentH = titleH + subH
    barCenter = 44 + Int(contentH / 2)
    m.title.font = Ui_font(Ui_sp(22), true)
    m.title.color = Ui_color("text")
    m.title.height = titleH
    m.title.translation = [532, 44]
    m.subtitle.font = Ui_font(Ui_sp(13), false)
    m.subtitle.color = Ui_color("muted")
    m.subtitle.height = subH
    m.subtitle.translation = [532, 44 + titleH]
    m.top.findNode("wordmark").translation = [96, barCenter - 30]

    ' Hint: "OK watch · ◀ ▶ in player change channel · Menu refresh", right-aligned at the 48 dp
    ' padding. The arrows are glyph posters (Roboto has none), sized like the 13 sp glyphs.
    for each l in [m.hintA, m.hintB]
        l.font = Ui_font(Ui_sp(13), false)
        l.color = Ui_color("muted")
        l.height = hintH
    end for
    g = Int(Ui_sp(13) * 0.8 + 0.5)
    gy = Int((hintH - g) / 2)
    aw = Ui_textWidth(m.hintA)
    bw = Ui_textWidth(m.hintB)
    m.hintA.width = aw + 2
    m.hintA.translation = [0, 0]
    m.triL.width = g
    m.triL.height = g
    m.triL.translation = [aw, gy]
    m.triR.width = g
    m.triR.height = g
    m.triR.translation = [aw + g + 6, gy]
    m.hintB.width = bw + 2
    m.hintB.translation = [aw + 2 * g + 6, 0]
    hintW = aw + 2 * g + 6 + bw
    m.hint.translation = [1824 - hintW, barCenter - Int(hintH / 2)]
    ' The titles column takes what is left between the wordmark and the hint (16 dp gap).
    titlesW = (1824 - hintW - 32) - 532
    m.title.width = titlesW
    m.subtitle.width = titlesW

    ' Body starts under the bar.
    barH = 44 + contentH + 28
    bodyH = 1080 - barH - 32
    rowH = Ui_liveTvRowHeight()
    m.top.findNode("groupsClip").translation = [80, barH]
    m.top.findNode("groupsClip").clippingRect = [0, 0, 600, bodyH]
    m.groups.itemSize = [568, rowH]
    m.groups.numRows = Int((bodyH - 16 + 4) / (rowH + 4))
    m.top.findNode("gridClip").translation = [712, barH]
    m.top.findNode("gridClip").clippingRect = [0, 0, 1128, bodyH]
    cell = Ui_liveTvCellSize()
    m.grid.itemSize = cell
    m.grid.numRows = Int((bodyH - 16 + 20) / (cell[1] + 20))

    m.statusText.font = Ui_font(Ui_sp(17), false)
    m.statusText.color = Ui_color("text")
    m.spinner.poster.uri = "pkg:/images/ui/spinner.png"
    m.spinner.poster.width = 88
    m.spinner.poster.height = 88
end sub

' ---------------------------------------------------------------------------------------------
' Lifecycle
' ---------------------------------------------------------------------------------------------

sub onStart()
    if not m.top.start then return
    ' Live TV streams count toward the shared premium account's 5 connections like games do:
    ' take a slot in the pool first (app.js: takeSlot('tv')). Denied -> say so, offer Retry.
    ' Without an account of our own the list itself comes through the Worker, which only
    ' answers a device holding a lease.
    if (Account_isSignedIn() or Pool_sharedIptv()) and not m.global.leaseHeld
        m.leaseDenied = false
        showStatus("Connecting…", true)
        Ui_task("poolAcquire", { kind: "tv", label: "Live TV" }, "onLease")
        return
    end if
    begin()
end sub

sub onLease(ev as object)
    r = ev.getData()
    if r = invalid then return
    if r.granted = true
        m.global.leaseLabel = "Live TV"
        m.global.leaseHeld = true
        m.top.holdsLease = true ' the scene releases it when this screen is popped
        begin()
        return
    end if
    m.leaseDenied = true
    if r.ok = true
        mx = r.max.ToStr()
        msg = "All " + mx + " shared premium connections are in use right now (" + r.used.ToStr() + "/" + mx + ")." + Chr(10) + "Live TV counts toward the same " + mx + " as games — try again in a minute."
    else
        msg = "Couldn’t reach the premium pool (" + strOr(r.error, "network error") + ")." + Chr(10) + "Live TV needs one of the shared account’s connections."
    end if
    showError(msg)
end sub

' Retry / Menu: a denied slot is asked for again; otherwise the channel list is refreshed.
sub retryStatus()
    if m.leaseDenied = true
        onStart()
        return
    end if
    showStatus("Loading your channel list…", true)
    load(true)
end sub

sub begin()
    idx = Iptv_cachedIndex()
    if idx <> invalid
        applyIndex(idx, true)
        if not Iptv_isFresh(idx) then load(false)
    else
        showStatus("Loading your channel list…", true)
        load(false)
    end if
end sub

sub onResumed()
    ' Back from the player: recently watched may have changed.
    if m.top.resumed and m.index <> invalid then applyIndex(m.index, false)
end sub

' ---------------------------------------------------------------------------------------------
' Data
' ---------------------------------------------------------------------------------------------

sub load(force as boolean)
    if m.loading then return
    m.loading = true
    if m.index <> invalid then m.subtitle.text = "Refreshing the channel list…"
    Ui_task("iptvLoad", { force: force }, "onLoaded")
end sub

sub onLoaded(ev as object)
    m.loading = false
    r = ev.getData()
    if r = invalid then return
    if r.ok = true
        applyIndex(r.index, m.index = invalid)
        if r.warning <> invalid then m.subtitle.text = m.subtitle.text + "  ·  refresh failed: " + r.warning
    else if m.index = invalid
        showError("Could not load the channel list: " + strOr(r.error, "unknown error"))
    else
        bindSubtitle()
        m.subtitle.text = m.subtitle.text + "  ·  refresh failed: " + strOr(r.error, "")
    end if
end sub

sub bindSubtitle()
    idx = m.index
    m.subtitle.text = Ui_thousands(toInt(idx.channelCount)) + " channels · " + idx.groups.Count().ToStr() + " groups · updated " + Ui_timeOf(toInt(idx.fetchedAt))
end sub

' LiveTvActivity.onPlaylist + bindGroups: show the remembered group on the first bind, otherwise
' keep the group that was showing.
sub applyIndex(idx as object, restoreSelection as boolean)
    m.index = idx
    hideStatus()
    bindSubtitle()

    target = ""
    if restoreSelection or m.shownIndex < 0
        target = rememberedGroup()
    else if m.shownIndex < m.groupList.Count()
        target = m.groupList[m.shownIndex].name
    end if

    m.groupList = Iptv_groupsWithRecent(idx)
    if m.groupList.Count() = 0
        showError("Could not load the channel list: the playlist has no channels")
        return
    end if
    root = CreateObject("roSGNode", "ContentNode")
    root.id = "groups"
    at = 0
    for i = 0 to m.groupList.Count() - 1
        g = m.groupList[i]
        n = root.createChild("GroupNode")
        n.name = g.name
        n.count = g.count
        n.active = false
        if target <> "" and g.name = target then at = i
    end for
    m.groups.content = root
    m.groups.jumpToItem = at
    m.shownIndex = -1
    showGroup(at, true)
    if restoreSelection or not m.grid.hasFocus() then m.groups.setFocus(true)
end sub

sub onGroupFocused()
    showGroup(m.groups.itemFocused, false)
end sub

' OK on a group moves over to its channels.
sub onGroupSelected()
    if m.grid.content <> invalid and m.grid.content.getChildCount() > 0 then m.grid.setFocus(true)
end sub

sub showGroup(i as integer, force as boolean)
    if i < 0 or i >= m.groupList.Count() then return
    if not force and i = m.shownIndex then return
    g = m.groupList[i]
    sameName = m.shownIndex >= 0 and m.shownIndex < m.groupList.Count() and m.groupList[m.shownIndex].name = g.name
    ' the shown row is the bold one
    if m.groups.content <> invalid
        if m.shownIndex >= 0 and m.shownIndex < m.groups.content.getChildCount() then m.groups.content.getChild(m.shownIndex).active = false
        if i < m.groups.content.getChildCount() then m.groups.content.getChild(i).active = true
    end if
    m.shownIndex = i
    m.channels = Iptv_groupChannels(g)
    root = CreateObject("roSGNode", "ContentNode")
    root.id = "grid"
    for each c in m.channels
        n = CreateObject("roSGNode", "ChannelNode")
        n.name = c.name
        n.logo = strOr(c.logo, "")
        n.group = g.name
        n.url = c.url
        n.title = c.name
        root.appendChild(n)
    end for
    m.grid.content = root
    if not sameName then m.grid.jumpToItem = 0
    if g.name <> Iptv_recentGroup() then rememberGroup(g.name)
end sub

' The shown group persists across launches (Android: SharedPreferences KEY_GROUP).
function rememberedGroup() as string
    sec = CreateObject("roRegistrySection", "iptv")
    if sec.Exists("group") then return sec.Read("group")
    return ""
end function

sub rememberGroup(name as string)
    sec = CreateObject("roRegistrySection", "iptv")
    if sec.Exists("group") and sec.Read("group") = name then return
    sec.Write("group", name)
    sec.Flush()
end sub

' ---------------------------------------------------------------------------------------------
' Status panel: spinner 44 dp, text (17 sp, 120x18 dp padding), buttons (+0), all centred.
' ---------------------------------------------------------------------------------------------

sub showStatus(message as string, busy as boolean)
    m.statusPanel.visible = true
    m.spinner.visible = busy
    m.spinner.control = "start"
    m.statusText.text = message
    clearStatusButtons()
    layoutStatus()
end sub

sub showError(message as string)
    showStatus(message, false)
    m.spinner.control = "stop"
    addStatusButton("Retry")
    addStatusButton("Back")
    m.statusIndex = 0
    styleStatus()
    layoutStatus()
    m.top.setFocus(true)
end sub

sub hideStatus()
    if not m.statusPanel.visible then return
    m.statusPanel.visible = false
    m.spinner.control = "stop"
    clearStatusButtons()
end sub

sub clearStatusButtons()
    for each n in m.statusNodes
        m.statusButtons.removeChild(n)
    end for
    m.statusNodes = []
end sub

sub addStatusButton(text as string)
    p = m.statusButtons.createChild("Pill")
    p.kind = "buttonMd"
    p.text = text
    m.statusNodes.Push(p)
end sub

sub styleStatus()
    for i = 0 to m.statusNodes.Count() - 1
        m.statusNodes[i].focused = (i = m.statusIndex)
    end for
end sub

sub layoutStatus()
    textH = Ui_labelHeight(m.statusText, Ui_sp(17), 0)
    total = 36 + textH + 36
    if m.spinner.visible then total += 88
    if m.statusNodes.Count() > 0 then total += m.statusNodes[0].pillHeight
    y = Int((1080 - total) / 2)
    if m.spinner.visible
        m.spinner.translation = [916, y]
        y += 88
    end if
    m.statusText.translation = [240, y + 36]
    y += 36 + textH + 36
    if m.statusNodes.Count() > 0
        x = 0
        for each p in m.statusNodes
            p.translation = [x, 0]
            x += p.pillWidth + 24
        end for
        m.statusButtons.translation = [Int((1920 - (x - 24)) / 2), y]
    end if
end sub

sub activateStatus()
    if m.statusIndex >= m.statusNodes.Count() then return
    if m.statusNodes[m.statusIndex].text = "Retry"
        retryStatus()
    else
        m.top.close = true
    end if
end sub

' ---------------------------------------------------------------------------------------------
' Selection + keys
' ---------------------------------------------------------------------------------------------

sub onChannelSelected(ev as object)
    i = ev.getData()
    if i < 0 or i >= m.channels.Count() then return
    name = ""
    if m.shownIndex >= 0 and m.shownIndex < m.groupList.Count() then name = m.groupList[m.shownIndex].name
    m.top.navigate = { screen: "PlayerScreen", channelGroup: { name: name, channels: m.channels }, channelIndex: i }
end sub

' Developer key injection (see MainScene.onDevCmd). The list and grid consume arrows and OK
' themselves, so those are reproduced here; everything else goes through onKeyEvent.
sub onDevKey()
    key = m.top.devKey
    if m.statusPanel.visible and m.statusNodes.Count() > 0
        onKeyEvent(key, true)
        return
    end if
    if m.groups.hasFocus() and m.groups.content <> invalid
        n = m.groups.content.getChildCount()
        i = m.groups.itemFocused
        if key = "down" and i < n - 1
            m.groups.jumpToItem = i + 1
            return
        else if key = "up" and i > 0
            m.groups.jumpToItem = i - 1
            return
        else if key = "OK"
            m.groups.itemSelected = i
            return
        end if
    else if m.grid.hasFocus() and m.grid.content <> invalid
        n = m.grid.content.getChildCount()
        i = m.grid.itemFocused
        cols = m.grid.numColumns
        if key = "right" and i < n - 1
            m.grid.jumpToItem = i + 1
            return
        else if key = "left" and (i mod cols) > 0
            m.grid.jumpToItem = i - 1
            return
        else if key = "down" and i + cols < n
            m.grid.jumpToItem = i + cols
            return
        else if key = "up" and i - cols >= 0
            m.grid.jumpToItem = i - cols
            return
        else if key = "OK"
            m.grid.itemSelected = i
            return
        end if
    end if
    onKeyEvent(key, true)
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if m.statusPanel.visible and m.statusNodes.Count() > 0
        if key = "left" and m.statusIndex > 0
            m.statusIndex -= 1
            styleStatus()
            return true
        else if key = "right" and m.statusIndex < m.statusNodes.Count() - 1
            m.statusIndex += 1
            styleStatus()
            return true
        else if key = "OK"
            activateStatus()
            return true
        else if key = "back"
            m.top.close = true
            return true
        else if key = "options"
            retryStatus()
            return true
        end if
        return true
    end if
    if key = "back"
        if m.grid.hasFocus()
            m.groups.setFocus(true)
            return true
        end if
        m.top.close = true
        return true
    else if key = "right" and m.groups.hasFocus()
        if m.grid.content <> invalid and m.grid.content.getChildCount() > 0 then m.grid.setFocus(true)
        return true
    else if key = "left" and m.grid.hasFocus()
        ' MarkupGrid lets "left" through at its first column.
        m.groups.setFocus(true)
        return true
    else if key = "options"
        load(true)
        return true
    end if
    return false
end function
