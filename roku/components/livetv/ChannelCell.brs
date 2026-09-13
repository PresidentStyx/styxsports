' One channel card (see ChannelCell.xml).

sub init()
    m.bg = m.top.findNode("bg")
    m.logo = m.top.findNode("logo")
    m.placeholder = m.top.findNode("placeholder")
    m.name = m.top.findNode("name")
    m.ring = m.top.findNode("ring")
    m.fs = Ui_sp(13)
    m.name.font = Ui_font(m.fs, false)
    m.name.color = Ui_color("text")
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
    m.name.text = Iptv_displayName({ name: c.name })
    ' Android's TextView is as tall as its (up to two) lines and sits under the logo; the label
    ' gets that height with the text centred in it so the glyphs land where Roboto puts them.
    m.name.height = Ui_labelHeight(m.name, m.fs, 2)
    if c.logo <> ""
        if m.logo.uri <> c.logo then m.logo.uri = c.logo
        m.logo.visible = true
        m.placeholder.visible = false
    else
        m.logo.uri = ""
        m.logo.visible = false
        m.placeholder.visible = true
    end if
end sub

sub onLogoStatus()
    if m.logo.loadStatus = "failed"
        m.logo.visible = false
        m.placeholder.visible = true
    end if
end sub

sub onFocus()
    m.ring.visible = m.top.itemHasFocus and m.top.gridHasFocus
end sub
