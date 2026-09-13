' EventCard: HomeActivity.createCard() + teamColumn() + bindDynamic() in SceneGraph. All sizes
' are the Android dp values doubled (Android TV 1080p runs at density 2).

sub init()
    m.card = m.top.findNode("card")
    m.bg = m.top.findNode("bg")
    m.pillBg = m.top.findNode("pillBg")
    m.pill = m.top.findNode("pill")
    m.badges = m.top.findNode("badges")
    m.starIcon = m.top.findNode("starIcon")
    m.flameIcon = m.top.findNode("flameIcon")
    m.hotText = m.top.findNode("hotText")
    m.premIcon = m.top.findNode("premIcon")
    m.premText = m.top.findNode("premText")
    m.crestHome = m.top.findNode("crestHome")
    m.crestAway = m.top.findNode("crestAway")
    m.home = m.top.findNode("home")
    m.away = m.top.findNode("away")
    m.middle = m.top.findNode("middle")
    m.single = m.top.findNode("single")
    m.league = m.top.findNode("league")
    m.scaleAnim = m.top.findNode("scaleAnim")
    m.scaleInterp = m.top.findNode("scaleInterp")

    m.pill.font = Ui_font(Ui_sp(11), true)
    m.hotText.font = Ui_font(Ui_sp(11), true)
    m.premText.font = Ui_font(Ui_sp(11), true)
    m.home.font = Ui_font(Ui_sp(12.5), false)
    m.away.font = Ui_font(Ui_sp(12.5), false)
    m.middle.font = Ui_font(Ui_sp(17), true)
    m.single.font = Ui_font(Ui_sp(16), true)
    m.league.font = Ui_font(Ui_sp(11), false)
    m.home.color = Ui_color("text")
    m.away.color = Ui_color("text")
    m.single.color = Ui_color("text")
    m.league.color = Ui_color("muted")
    m.premText.text = "Premium"
    m.premText.color = Ui_color("gold")
    m.premIcon.blendColor = Ui_color("gold")
    m.starIcon.blendColor = Ui_color("gold")

    ' Vertical bands, as Android lays the card out: 12 dp top padding, the status line (11 sp pill
    ' with 3 dp padding), the team band taking the rest, the league line, 10 dp bottom padding.
    m.topH = Ui_lineHeight(Ui_sp(11)) + 12
    m.leagueH = Ui_lineHeight(Ui_sp(11))
    m.midTop = 24 + m.topH
    m.midH = 300 - 20 - m.leagueH - m.midTop
    m.pillBg.height = m.topH
    m.pill.height = m.topH
    m.hotText.height = m.topH
    m.premText.height = m.topH
    m.middle.height = Ui_lineHeight(Ui_sp(17))
    m.league.height = m.leagueH
    m.league.translation = [28, 300 - 20 - m.leagueH]
end sub

sub onRelayout()
    onContent()
end sub

' Layout dump tool: cards live in the scene tree, so Dev_dumpTree reaches them directly.

sub onContent()
    c = m.top.content
    if c = invalid then return
    e = Ui_eventFromNode(c)

    ' --- status pill -------------------------------------------------------------------------
    m.pill.text = Ui_pillLabel(e)
    if e.live and not e.ended then m.pillBg.uri = "pkg:/images/ui/pill_live.9.png" else m.pillBg.uri = "pkg:/images/ui/pill_time.9.png"
    pw = Ui_textWidth(m.pill) + 32
    m.pillBg.width = pw
    m.pill.width = pw

    ' --- badges (right-aligned): [star]   [flame Trending|#n]   [star Premium] ------------------
    starred = c.starred = true
    color = Ui_color("gold")
    if e.hot and not starred then color = Ui_color("hot")
    m.hotText.color = color
    m.flameIcon.blendColor = color
    fs = Ui_sp(11)
    space = Int(fs * 0.25 + 0.5)
    gap = space * 3
    x = 0
    ' Laid out right to left inside the badges group (whose origin is the card's right padding edge).
    m.premText.visible = e.pro
    m.premIcon.visible = e.pro
    if e.pro
        tw = Ui_textWidth(m.premText)
        x -= tw
        m.premText.translation = [x, 0]
        m.premText.width = tw
        placeIcon(m.premIcon, x - space, 33, 31, 0.72)
        x -= space + m.premIcon.width
        x -= gap
    end if
    m.hotText.visible = e.hot
    m.flameIcon.visible = e.hot
    if e.hot
        if e.rank > 0 then m.hotText.text = "#" + e.rank.ToStr() else m.hotText.text = "Trending"
        tw = Ui_textWidth(m.hotText)
        x -= tw
        m.hotText.translation = [x, 0]
        m.hotText.width = tw
        placeIcon(m.flameIcon, x - space, 39, 51, 0.95)
        x -= space + m.flameIcon.width
        x -= gap
    end if
    m.starIcon.visible = starred
    if starred
        placeIcon(m.starIcon, x, 33, 31, 0.72)
    end if

    ' --- middle -------------------------------------------------------------------------------
    midTop = m.midTop
    midH = m.midH
    two = e.away <> ""
    m.single.visible = not two
    m.home.visible = two
    m.away.visible = two
    m.middle.visible = two
    m.crestHome.visible = two
    m.crestAway.visible = two
    if two
        m.home.text = e.home
        m.away.text = e.away
        homeUri = Ui_crestUrl(e.ch, 152)
        awayUri = Ui_crestUrl(e.ca, 152)
        if homeUri = "" then homeUri = "pkg:/images/ui/crest_placeholder.png"
        if awayUri = "" then awayUri = "pkg:/images/ui/crest_placeholder.png"
        if m.crestHome.uri <> homeUri then m.crestHome.uri = homeUri
        if m.crestAway.uri <> awayUri then m.crestAway.uri = awayUri
        layoutTeam(m.crestHome, m.home, 28, midTop, midH)
        layoutTeam(m.crestAway, m.away, 360, midTop, midH)
        m.middle.translation = [224, midTop + Int((midH - m.middle.height) / 2)]
        if e.sc <> ""
            m.middle.text = e.sc.Replace(" - ", Chr(8211))
            m.middle.color = Ui_color("text")
        else
            m.middle.text = "vs"
            m.middle.color = Ui_color("muted")
        end if
    else
        m.single.text = e.home
        h = labelHeight(m.single, Ui_sp(16), 3)
        m.single.translation = [28, midTop + Int((midH - h) / 2)]
    end if

    ' --- bottom -------------------------------------------------------------------------------
    m.league.text = Ui_prettyLeague(e.league)
end sub

' A team column (crest over a centred name, up to two lines), centred vertically in the middle band.
sub layoutTeam(crest as object, name as object, x as integer, top as integer, h as integer)
    nameH = labelHeight(name, Ui_sp(12.5), 2)
    contentH = 76 + 10 + nameH
    y = top + Int((h - contentH) / 2)
    crest.translation = [x + 60, y]
    name.translation = [x, y + 86]
end sub

' Height Android gives the wrapped TextView: measured line count when possible, else estimated.
function labelHeight(label as object, fontSize as integer, maxLines as integer) as integer
    return Ui_labelHeight(label, fontSize, maxLines)
end function

' Size a glyph poster like a text glyph of the badge font (em * frac tall), right edge at `right`,
' centred on the status line.
sub placeIcon(icon as object, right as integer, srcW as integer, srcH as integer, frac as float)
    h = Int(Ui_sp(11) * frac + 0.5)
    w = Int(h * srcW / srcH + 0.5)
    icon.width = w
    icon.height = h
    icon.translation = [right - w, Int((m.topH - h) / 2)]
end sub

sub onFocus()
    if m.top.focused
        m.bg.uri = "pkg:/images/ui/card_focus.9.png"
        animateScale(1.06)
    else
        m.bg.uri = "pkg:/images/ui/card.9.png"
        animateScale(1.0)
    end if
end sub

sub animateScale(target as float)
    cur = m.card.scale
    if cur = invalid then cur = [1, 1]
    m.scaleInterp.keyValue = [[cur[0], cur[1]], [target, target]]
    m.scaleAnim.control = "start"
end sub
