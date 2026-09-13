sub init()
    m.ring = m.top.findNode("ring")
    m.bg = m.top.findNode("bg")
    m.stripe = m.top.findNode("stripe")
    m.whenBg = m.top.findNode("whenBg")
    m.when = m.top.findNode("when")
    m.league = m.top.findNode("league")
    m.tag = m.top.findNode("tag")
    m.crestHome = m.top.findNode("crestHome")
    m.crestAway = m.top.findNode("crestAway")
    m.home = m.top.findNode("home")
    m.away = m.top.findNode("away")
    m.scoreHome = m.top.findNode("scoreHome")
    m.scoreAway = m.top.findNode("scoreAway")
    m.star = m.top.findNode("star")
    m.global.observeField("dumpTick", "onDumpTick")
end sub

' Layout dump tool (see Ui.brs): RowList items are not reachable from the scene tree.
sub onDumpTick()
    Dev_dumpItem(m.top)
end sub

sub onContent()
    c = m.top.itemContent
    if c = invalid then return

    m.home.text = c.home
    m.away.text = c.away
    m.crestHome.uri = c.ch
    m.crestAway.uri = c.ca
    m.crestHome.visible = c.ch <> ""
    m.crestAway.visible = c.ca <> ""
    ' "31 - 24" -> per-team scores; anything else is shown whole on the home line.
    scoreHome = ""
    scoreAway = ""
    if c.sc <> "" and c.away <> ""
        parts = c.sc.Split("-")
        if parts.Count() = 2
            scoreHome = parts[0].Trim()
            scoreAway = parts[1].Trim()
        else
            scoreHome = c.sc.Trim()
        end if
    end if
    hasScore = scoreHome <> ""

    if c.away = ""
        ' Single-title card (UFC card, F1 session, ...): one big block, up to three lines.
        m.home.translation = [22, 56]
        m.home.width = 528
        m.home.height = 134
        m.home.wrap = true
        m.home.maxLines = 3
        m.away.visible = false
        m.crestHome.visible = false
        m.crestAway.visible = false
    else
        m.home.wrap = false
        m.home.maxLines = 1
        m.home.height = 64
        m.away.visible = true
        ' Names start after the crest (or at the left edge when there is none) and stop short of
        ' the score column when a score is showing.
        homeX = 92
        awayX = 92
        if c.ch = "" then homeX = 22
        if c.ca = "" then awayX = 22
        m.home.translation = [homeX, 56]
        m.away.translation = [awayX, 126]
        if hasScore
            m.home.width = 472 - homeX
            m.away.width = 472 - awayX
        else
            m.home.width = 550 - homeX
            m.away.width = 550 - awayX
        end if
    end if

    m.league.text = UCase(c.league)
    m.when.text = Ui_whenLabel(Ui_eventFromNode(c))
    if c.live
        m.whenBg.color = Ui_color("live")
        m.when.color = "0xFFFFFFFF"
        m.stripe.color = Ui_color("live")
    else if c.ended
        m.whenBg.color = "0x2A2A2AFF"
        m.when.color = Ui_color("dim")
        m.stripe.color = "0x00000000"
    else
        m.whenBg.color = "0x2A2A2AFF"
        m.when.color = Ui_color("text")
        m.stripe.color = "0x00000000"
    end if
    ' Widen the time pill for long labels ("2nd Q 04:12", "Tue 7:30 PM").
    r = m.when.boundingRect()
    w = 90
    if r <> invalid and r.width <> invalid then w = Int(r.width) + 24
    if w < 90 then w = 90
    if w > 200 then w = 200
    m.whenBg.width = w
    m.when.width = w
    m.league.translation = [w + 36, 14]
    m.league.width = 360 - (w + 36)

    if c.pro
        m.tag.text = "PREMIUM"
    else if c.hot
        m.tag.text = "HOT"
        m.tag.color = "0xFF8A80FF"
    else
        m.tag.text = ""
    end if
    if c.pro then m.tag.color = Ui_color("gold")

    m.scoreHome.text = scoreHome
    m.scoreAway.text = scoreAway
    m.scoreHome.visible = hasScore
    m.scoreAway.visible = hasScore and scoreAway <> ""
    if c.starred then m.star.text = Chr(9733) else m.star.text = ""
end sub

sub onFocus()
    p = m.top.focusPercent
    if not (m.top.rowHasFocus and m.top.rowListHasFocus) then p = 0
    if p > 0.5
        m.ring.color = "0xFFFFFFFF"
        m.bg.color = Ui_color("cardFocus")
    else
        m.ring.color = "0x00000000"
        m.bg.color = Ui_color("card")
    end if
end sub
