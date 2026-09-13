sub init()
    m.bg = m.top.findNode("bg")
    m.ring = m.top.findNode("ring")
    m.label = m.top.findNode("label")
    relayout()
end sub

sub relayout()
    m.label.text = m.top.text
    h = m.top.pillHeight
    textW = 0
    r = m.label.boundingRect()
    if r <> invalid and r.width <> invalid then textW = Int(r.width)
    w = textW + 44
    if w < m.top.minWidth then w = m.top.minWidth
    ' The ring is a 3 px frame drawn around the pill when focused.
    m.ring.translation = [-3, -3]
    m.ring.width = w + 6
    m.ring.height = h + 6
    m.bg.width = w
    m.bg.height = h
    m.label.width = w
    m.label.height = h
    m.top.pillWidth = w
    restyle()
end sub

sub restyle()
    accent = m.top.accent
    if m.top.selected
        m.bg.color = Ui_color("pillOn")
        m.label.color = "0x0A0A0AFF"
    else if accent = "gold"
        m.bg.color = "0x2A2410FF"
        m.label.color = Ui_color("gold")
    else if accent = "live"
        m.bg.color = "0x2A1212FF"
        m.label.color = "0xFF8A80FF"
    else
        m.bg.color = Ui_color("pill")
        m.label.color = Ui_color("text")
    end if
    if m.top.focused
        m.ring.color = "0xFFFFFFFF"
        if not m.top.selected then m.bg.color = "0x2E2E2EFF"
    else
        m.ring.color = "0x00000000"
    end if
end sub
