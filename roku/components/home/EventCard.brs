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
    m.score = m.top.findNode("score")
    m.star = m.top.findNode("star")
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
    hasScore = c.sc <> "" and c.away <> ""
    if c.away = ""
        ' Single-title card (UFC card, F1 session, ...): one big block, up to three lines.
        m.home.translation = [22, 56]
        m.home.width = 396
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
            m.home.width = 258 - homeX
            m.away.width = 258 - awayX
        else
            m.home.width = 418 - homeX
            m.away.width = 418 - awayX
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
    m.league.width = 290 - w

    if c.pro
        m.tag.text = "PREMIUM"
    else if c.hot
        m.tag.text = "HOT"
        m.tag.color = "0xFF8A80FF"
    else
        m.tag.text = ""
    end if
    if c.pro then m.tag.color = Ui_color("gold")

    m.score.text = c.sc
    m.score.visible = hasScore
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
