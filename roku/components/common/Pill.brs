sub init()
    m.bg = m.top.findNode("bg")
    m.iconNode = m.top.findNode("iconNode")
    m.label = m.top.findNode("label")
    m.label.font = Ui_font(Ui_sp(13), true)
    relayout()
end sub

' Android: chips pad 15x6 dp around 13 sp bold text; buttons pad 16x8 dp. Height is the
' TextView's line (Ui_lineHeight) plus the vertical padding, so it tracks the font scale.
sub relayout()
    fs = Ui_sp(13)
    if m.top.kind = "button"
        padX = 32
        padY = 16
    else if m.top.kind = "buttonLg"
        ' AccountActivity buttons: 15 sp bold, 22x11 dp padding
        fs = Ui_sp(15)
        padX = 44
        padY = 22
    else if m.top.kind = "buttonMd"
        ' NativePlayerActivity buttons: 14 sp bold, 18x9 dp padding
        fs = Ui_sp(14)
        padX = 36
        padY = 18
    else
        padX = 30
        padY = 12
    end if
    h = Ui_lineHeight(fs) + padY * 2
    m.label.font = Ui_font(fs, true)
    m.label.text = m.top.text
    textW = Ui_textWidth(m.label)

    iconW = 0
    icon = m.top.icon
    m.iconNode.visible = icon <> ""
    if icon <> ""
        ' Glyphs drawn at the size the emoji font would give them inline with 13 sp text.
        if icon = "star"
            ih = Int(fs * 0.72 + 0.5)
            iw = Int(ih * 33 / 31 + 0.5)
        else if icon = "tv"
            ih = Int(fs * 0.95 + 0.5)
            iw = Int(ih * 44 / 45 + 0.5)
        else
            ih = Int(fs * 0.95 + 0.5)
            iw = Int(ih * 39 / 51 + 0.5)
        end if
        m.iconNode.uri = "pkg:/images/ui/" + icon + ".png"
        m.iconNode.width = iw
        m.iconNode.height = ih
        m.iconNode.translation = [padX, Int((h - ih) / 2)]
        iconW = iw + Int(fs * 0.25 + 0.5)
    end if

    w = padX + iconW + textW + padX
    if w < m.top.minWidth then w = m.top.minWidth
    m.bg.width = w
    m.bg.height = h
    ' Content centred (matters when minWidth stretches the pill).
    startX = Int((w - iconW - textW) / 2)
    if icon <> "" then m.iconNode.translation = [startX, m.iconNode.translation[1]]
    m.label.translation = [startX + iconW, 0]
    m.label.width = textW + 4
    m.label.height = h
    m.top.pillWidth = w
    m.top.pillHeight = h
    restyle()
end sub

sub restyle()
    kind = m.top.kind
    if kind = "buttonLg"
        kind = "button_lg"
    else if kind = "buttonMd"
        kind = "button_md"
    else if kind <> "button"
        kind = "chip"
    end if
    if m.top.focused
        m.bg.uri = "pkg:/images/ui/" + kind + "_focus.9.png"
        m.label.color = Ui_color("bg")
    else
        if m.top.selected and kind = "chip"
            m.bg.uri = "pkg:/images/ui/chip_selected.9.png"
        else
            m.bg.uri = "pkg:/images/ui/" + kind + ".9.png"
        end if
        if m.top.accent = "gold" then m.label.color = Ui_color("gold") else m.label.color = Ui_color("text")
    end if
    m.iconNode.blendColor = m.label.color
end sub
