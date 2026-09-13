sub init()
    m.subtitle = m.top.findNode("subtitle")
    m.groups = m.top.findNode("groups")
    m.grid = m.top.findNode("grid")
    m.message = m.top.findNode("message")
    m.index = invalid
    m.groupList = []
    m.channels = []
    m.loading = false

    m.groups.observeField("itemFocused", "onGroupFocused")
    m.groups.observeField("itemSelected", "onGroupSelected")
    m.grid.observeField("itemSelected", "onChannelSelected")
end sub

' OK on a group moves over to its channels.
sub onGroupSelected()
    if m.grid.content <> invalid and m.grid.content.getChildCount() > 0 then m.grid.setFocus(true)
end sub

sub onStart()
    if not m.top.start then return
    idx = Iptv_cachedIndex()
    if idx <> invalid
        applyIndex(idx)
        if not Iptv_isFresh(idx) then load(false)
    else
        showMessage("Loading your channel list…")
        load(false)
    end if
end sub

sub onResumed()
    ' Back from the player: recently watched may have changed.
    if m.top.resumed and m.index <> invalid then applyIndex(m.index)
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
        applyIndex(r.index)
        if r.warning <> invalid then m.subtitle.text = m.subtitle.text + "  ·  refresh failed: " + r.warning
    else if m.index = invalid
        showMessage("Could not load the channel list: " + strOr(r.error, "unknown error") + Chr(10) + Chr(10) + "Press * to try again.")
    else
        m.subtitle.text = m.subtitle.text + "  ·  refresh failed: " + strOr(r.error, "")
    end if
end sub

sub applyIndex(idx as object)
    m.index = idx
    showMessage("")
    m.subtitle.text = Ui_thousands(toInt(idx.channelCount)) + " channels · " + idx.groups.Count().ToStr() + " groups · updated " + Ui_ago(toInt(idx.fetchedAt))

    focusedName = ""
    if m.groups.content <> invalid and m.groups.itemFocused >= 0 and m.groups.itemFocused < m.groupList.Count()
        focusedName = m.groupList[m.groups.itemFocused].name
    end if

    m.groupList = Iptv_groupsWithRecent(idx)
    root = CreateObject("roSGNode", "ContentNode")
    focusIdx = 0
    for i = 0 to m.groupList.Count() - 1
        g = m.groupList[i]
        n = root.createChild("ContentNode")
        n.title = g.name + "  (" + g.count.ToStr() + ")"
        if g.name = focusedName then focusIdx = i
    end for
    m.groups.content = root
    m.groups.jumpToItem = focusIdx
    showGroup(focusIdx)
    if not m.grid.hasFocus() then m.groups.setFocus(true)
end sub

sub onGroupFocused()
    showGroup(m.groups.itemFocused)
end sub

sub showGroup(i as integer)
    if i < 0 or i >= m.groupList.Count() then return
    g = m.groupList[i]
    m.channels = Iptv_groupChannels(g)
    root = CreateObject("roSGNode", "ContentNode")
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
    if m.channels.Count() = 0 and g.name <> Iptv_recentGroup()
        showMessage("That channel group is no longer in the playlist. Press * to refresh.")
    else
        showMessage("")
    end if
end sub

sub showMessage(text as string)
    m.message.text = text
    m.message.visible = text <> ""
end sub

' ---------------------------------------------------------------------------------------------
' Selection + keys
' ---------------------------------------------------------------------------------------------

sub onChannelSelected(ev as object)
    i = ev.getData()
    if i < 0 or i >= m.channels.Count() then return
    gi = m.groups.itemFocused
    name = ""
    if gi >= 0 and gi < m.groupList.Count() then name = m.groupList[gi].name
    m.top.navigate = { screen: "PlayerScreen", channelGroup: { name: name, channels: m.channels }, channelIndex: i }
end sub

' Developer key injection (see MainScene.onDevCmd). The LabelList and MarkupGrid consume arrows
' and OK themselves, so those are reproduced here; everything else goes through onKeyEvent.
sub onDevKey()
    key = m.top.devKey
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
