sub init()
    m.ring = m.top.findNode("ring")
    m.bg = m.top.findNode("bg")
    m.logo = m.top.findNode("logo")
    m.initials = m.top.findNode("initials")
    m.name = m.top.findNode("name")
    m.logo.observeField("loadStatus", "onLogoStatus")
    m.global.observeField("dumpTick", "onDumpTick")
end sub

' Layout dump tool (see Ui.brs): grid items are not reachable from the scene tree.
sub onDumpTick()
    Dev_dumpItem(m.top)
end sub

sub onContent()
    c = m.top.itemContent
    if c = invalid then return
    shown = Iptv_displayName({ name: c.name })
    m.name.text = shown
    m.initials.text = Left(shown, 2)
    if c.logo <> ""
        m.logo.uri = c.logo
        m.logo.visible = true
        m.initials.visible = false
    else
        m.logo.uri = ""
        m.logo.visible = false
        m.initials.visible = true
    end if
end sub

sub onLogoStatus()
    if m.logo.loadStatus = "failed"
        m.logo.visible = false
        m.initials.visible = true
    end if
end sub

sub onFocus()
    p = m.top.focusPercent
    if not (m.top.itemHasFocus and m.top.gridHasFocus) then p = 0
    if p > 0.5
        m.ring.color = "0xFFFFFFFF"
        m.bg.color = Ui_color("cardFocus")
    else
        m.ring.color = "0x00000000"
        m.bg.color = Ui_color("card")
    end if
end sub
