' One channel-group row (see GroupRow.xml). Row height = 15 sp line + 2 x 11 dp padding.

sub init()
    m.bg = m.top.findNode("bg")
    m.name = m.top.findNode("name")
    m.count = m.top.findNode("count")
    m.ring = m.top.findNode("ring")
    m.w = 568
    m.fsName = Ui_sp(15)
    m.h = Ui_liveTvRowHeight()
    m.count.font = Ui_font(Ui_sp(12), false)
    m.count.color = Ui_color("muted")
    m.bg.height = m.h
    m.ring.height = m.h
    m.name.height = m.h
    m.count.height = m.h
    m.global.observeField("dumpTick", "onDumpTick")
end sub

' Layout dump tool (see Ui.brs): list items are not reachable from the scene tree.
sub onDumpTick()
    Dev_dumpItem(m.top)
end sub

sub onContent()
    c = m.top.itemContent
    if c = invalid then return
    active = (c.active = true)
    m.name.text = c.name
    m.name.font = Ui_font(m.fsName, active)
    if active then m.name.color = Ui_color("text") else m.name.color = Ui_color("muted")
    m.count.text = c.count.ToStr()
    cw = Ui_textWidth(m.count)
    m.count.width = cw + 4
    m.count.translation = [m.w - 32 - cw - 4, 0]
    ' name fills what is left of the row, 10 dp short of the count
    m.name.width = m.w - 64 - (cw + 4) - 20
    if active then m.bg.uri = "pkg:/images/ui/row_active.9.png" else m.bg.uri = "pkg:/images/ui/row.9.png"
end sub

sub onFocus()
    m.ring.visible = m.top.itemHasFocus and m.top.listHasFocus
end sub
