' Render-thread helpers shared by the screens.

' The Android app's palette (app/src/main/res/values/colors.xml), so both apps look the same.
function Ui_color(name as string) as string
    if name = "bg" then return "0x0A0A0AFF"
    if name = "card" or name = "surface" or name = "pill" then return "0x171717FF"
    if name = "cardFocus" or name = "surfaceFocused" then return "0x242424FF"
    if name = "line" or name = "outline" then return "0x262626FF"
    if name = "outlineStrong" then return "0x343434FF"
    if name = "text" then return "0xF5F5F5FF"
    if name = "dim" or name = "muted" then return "0x9E9E9EFF"
    if name = "live" then return "0xDC2626FF"
    if name = "pillTime" then return "0x2E2E2EFF"
    if name = "hot" then return "0xFB923CFF"
    if name = "gold" then return "0xF5B942FF"
    if name = "accent" or name = "pillOn" then return "0xFFFFFFFF"
    if name = "scrim" then return "0x000000B0"
    return "0xFFFFFFFF"
end function

' ---------------------------------------------------------------------------------------------
' Fonts. Android TV draws the app in Roboto at density 2 (1 dp = 2 px at 1080p), so a 13 sp label
' there is a 26 px Roboto label here. Font nodes are cached per component (m is the component).
' ---------------------------------------------------------------------------------------------

function Ui_font(size as integer, bold as boolean) as object
    if m.uiFonts = invalid then m.uiFonts = {}
    key = size.ToStr()
    if bold then key += "b"
    f = m.uiFonts[key]
    if f = invalid
        f = CreateObject("roSGNode", "Font")
        if bold then f.uri = "pkg:/fonts/Roboto-Bold.ttf" else f.uri = "pkg:/fonts/Roboto-Regular.ttf"
        f.size = size
        m.uiFonts[key] = f
    end if
    return f
end function

' Android sp -> px. Android TV 1080p runs at density 2, and the APK runs with the system font
' size one step up (font_scale 1.15, as on the Chromecast with Google TV). Android 14 applies
' that scale non-linearly - small text grows the full 15%, 20 sp about 9%, 28 sp about 1%, and
' 30 sp and up not at all - so this is the platform's 1.15 lookup table (FontScaleConverter),
' interpolated linearly between the listed sizes. Matching it keeps chips, buttons, titles and
' cards the same size as on the APK.
function Ui_spToDp(sp as float) as float
    xs = [8.0, 10.0, 12.0, 14.0, 18.0, 20.0, 24.0, 30.0, 100.0]
    ys = [9.2, 11.5, 13.8, 16.4, 19.8, 21.8, 25.2, 30.0, 100.0]
    if sp <= xs[0] then return sp * ys[0] / xs[0]
    for i = 1 to xs.Count() - 1
        if sp <= xs[i]
            return ys[i - 1] + (sp - xs[i - 1]) * (ys[i] - ys[i - 1]) / (xs[i] - xs[i - 1])
        end if
    end for
    return sp
end function

function Ui_sp(sp as float) as integer
    return Int(Ui_spToDp(sp) * 2 + 0.5)
end function

' Width of a label's text. boundingRect() is only right once the label has been through a frame;
' before that, estimate from Roboto's average glyph widths (callers re-measure a frame later).
function Ui_textWidth(label as object) as integer
    ' Measure unconstrained: a label that already has a width reports its (possibly ellipsized)
    ' rendered text, which would shrink the pill a little on every re-measure.
    if label.width <> 0 then label.width = 0
    r = label.boundingRect()
    if r <> invalid and r.width <> invalid and r.width > 0 then return Int(r.width + 0.5)
    return Ui_estimateWidth(label.text, label.font)
end function

' Crest image URL the Poster can load. The site serves SVG crests (Android rasterises them with
' androidsvg); Roku has no SVG decoder, so those go through wsrv.nl, which returns a PNG.
function Ui_crestUrl(url as string, sizePx as integer) as string
    if url = "" then return ""
    if LCase(Right(url, 4)) <> ".svg" and Instr(1, LCase(url), ".svg?") = 0 then return url
    return "https://wsrv.nl/?url=" + Ui_pctEncode(url) + "&w=" + sizePx.ToStr() + "&h=" + sizePx.ToStr() + "&fit=contain&output=png"
end function

' Percent-encodes everything but RFC 3986 unreserved characters (render-thread safe; roUrlTransfer is not).
function Ui_pctEncode(s as string) as string
    keep = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
    out = ""
    bytes = CreateObject("roByteArray")
    bytes.FromAsciiString(s)
    for i = 0 to bytes.Count() - 1
        b = bytes[i]
        ch = Chr(b)
        if b < 128 and Instr(1, keep, ch) > 0
            out += ch
        else
            hex = StrI(b, 16)
            if Len(hex) < 2 then hex = "0" + hex
            out += "%" + UCase(hex)
        end if
    end for
    return out
end function

function Ui_estimateWidth(text as string, font as object) as integer
    size = 26
    bold = false
    if font <> invalid
        if font.hasField("size") then size = font.size
        if font.hasField("uri") and Instr(1, font.uri, "Bold") > 0 then bold = true
    end if
    w = 0.0
    for i = 1 to Len(text)
        ch = Mid(text, i, 1)
        code = Asc(ch)
        if ch = " "
            w += 0.25
        else if (code >= 65 and code <= 90) or (code >= 48 and code <= 57)
            w += 0.64
        else if code >= 97 and code <= 122
            w += 0.52
        else if ch = "." or ch = "," or ch = ":" or ch = "'" or ch = "i" or ch = "l"
            w += 0.27
        else
            w += 0.55
        end if
    end for
    if bold then w = w * 1.05
    return Int(w * size + 0.5)
end function

' Height of a single-line Android TextView of this text size: Roboto's top+bottom including the
' font padding (~1.34 em; measured 1.33-1.37 on the APK). Roku labels get this as their explicit
' height with the text centred, which puts glyphs where Android puts them.
function Ui_lineHeight(size as integer) as integer
    return Int(size * 1.34 + 0.5)
end function

' Distance between baselines of consecutive wrapped lines (ascent+descent, ~1.17 em) - the same
' on Android and on Roku, whose Label uses the font's own line pitch.
function Ui_linePitch(size as integer) as integer
    return Int(size * 1.172 + 0.5)
end function

' Android TextView height for `lines` lines: one padded line plus the extra lines at the pitch.
function Ui_textHeight(size as integer, lines as integer) as integer
    if lines < 1 then lines = 1
    return Ui_lineHeight(size) + (lines - 1) * Ui_linePitch(size)
end function

' LiveTvActivity geometry shared by the screen and its list items (1 dp = 2 px):
' group row = 15 sp line + 2 x 11 dp padding; channel cell = 112 dp tall, 4 across the grid.
function Ui_liveTvRowHeight() as integer
    return Ui_lineHeight(Ui_sp(15)) + 44
end function

function Ui_liveTvCellSize() as object
    return [259, 224]
end function

' Height of a (possibly wrapped) label, as Android would size the TextView: the line count is
' measured when the label has been rendered, otherwise estimated from the text width. An empty
' label still counts one line, like an Android TextView.
function Ui_labelHeight(label as object, fontSize as integer, maxLines as integer) as integer
    if label.text = "" then return Ui_lineHeight(fontSize)
    lines = Ui_labelLines(label, fontSize)
    if maxLines > 0 and lines > maxLines then lines = maxLines
    return Ui_textHeight(fontSize, lines) + (lines - 1) * label.lineSpacing
end function

' Number of lines a label renders (measured when possible, else estimated from the text width).
function Ui_labelLines(label as object, fontSize as integer) as integer
    pitch = Ui_linePitch(fontSize) + label.lineSpacing
    if pitch < 1 then pitch = 1
    lines = 0
    if label.wrap
        r = label.boundingRect()
        if r <> invalid and r.height <> invalid and r.height > 0 then lines = Int((r.height + pitch / 2) / pitch)
    end if
    if lines < 1
        lines = 1
        if label.wrap and label.width > 0
            est = Ui_estimateWidth(label.text, label.font)
            lines = Int((est + label.width - 1) / label.width)
            ' explicit line breaks
            parts = label.text.Split(Chr(10))
            if parts.Count() > lines then lines = parts.Count()
        end if
    end if
    if lines < 1 then lines = 1
    return lines
end function

' ---------------------------------------------------------------------------------------------
' Text formats copied from HomeActivity so the cards read the same on both apps.
' ---------------------------------------------------------------------------------------------

' Status pill: "LIVE  2nd Q 4:12" / "FINAL" / "7:30 PM" / "Tue 7:30 PM" / "Upcoming".
function Ui_pillLabel(e as object) as string
    if e.ended then return "FINAL"
    if e.live
        if isEmpty(e.lt) or UCase(e.lt) = "LIVE" then return "LIVE"
        return "LIVE  " + e.lt
    end if
    if e.ts <= 0 then return "Upcoming"
    return Ui_clock(e.ts)
end function

' "h:mm a" of a unix time, for the status line.
function Ui_timeOf(ts as integer) as string
    dt = CreateObject("roDateTime")
    dt.FromSeconds(ts)
    dt.ToLocalTime()
    h = dt.GetHours()
    ampm = "AM"
    if h >= 12 then ampm = "PM"
    h12 = h mod 12
    if h12 = 0 then h12 = 12
    return h12.ToStr() + ":" + padZero(dt.GetMinutes()) + " " + ampm
end function

' HomeActivity.prettyLeague: known keys get their proper name, others are title-cased.
function Ui_prettyLeague(key as string) as string
    if key = "" then return ""
    names = {
        epl: "Premier League", laliga: "La Liga", seriea: "Serie A", ligue1: "Ligue 1"
        bundesliga: "Bundesliga", bundesliga2: "2. Bundesliga", mls: "MLS", championship: "Championship"
        leagueone: "League One", leaguetwo: "League Two", eredivisie: "Eredivisie", ligamx: "Liga MX"
        portugal: "Primeira Liga", argentina: "Argentine Primera", brazil: "Brasileirão"
        colombia: "Colombian Primera A", ucl: "Champions League", uel: "Europa League"
    }
    known = names[LCase(key)]
    if known <> invalid then return known
    s = key.Replace("-", " ").Replace("_", " ")
    if Len(s) <= 4 then return UCase(s)
    return UCase(Left(s, 1)) + Mid(s, 2)
end function

' ---------------------------------------------------------------------------------------------
' Layout dump (developer tool). Prints one "@@L {json}" line per visible node with its absolute
' scene rectangle so tools/layout-shot.ps1 can draw a picture of the screen; this TV model
' returns black images from the Roku screenshot utility.
' ---------------------------------------------------------------------------------------------

sub Dev_dumpTree(node as object, parentShown as boolean)
    if node = invalid then return
    shown = parentShown
    if node.hasField("visible") and node.visible = false then shown = false
    if node.hasField("opacity") and node.opacity = 0 then shown = false
    if shown then Dev_dumpOne(node)
    ' Lists render their own items (which observe m.global.dumpTick and dump themselves).
    st = node.subtype()
    if st = "RowList" or st = "MarkupGrid" or st = "MarkupList" or st = "Video" then return
    for i = 0 to node.getChildCount() - 1
        Dev_dumpTree(node.getChild(i), shown)
    end for
end sub

sub Dev_dumpOne(node as object)
    r = node.sceneBoundingRect()
    if r = invalid then return
    st = node.subtype()
    line = { t: st, id: node.id, x: Int(r.x), y: Int(r.y), w: Int(r.width), h: Int(r.height) }
    if st = "Label"
        line.text = node.text
        line.color = node.color
        line.ha = node.horizAlign
        line.va = node.vertAlign
        line.wrap = node.wrap
        if node.hasField("isTextEllipsized") then line.ell = node.isTextEllipsized
        f = node.font
        if f <> invalid
            if f.hasField("size") then line.fs = f.size
            if f.hasField("uri") then line.fu = f.uri
        end if
        if line.text = "" then return
    else if st = "Rectangle"
        line.color = node.color
    else if st = "Poster"
        line.uri = node.uri
        if node.hasField("loadStatus") then line.ls = node.loadStatus
        line.bc = node.blendColor
        if node.loadDisplayMode = "scaleToFill" then line.fill = true
    else if st = "RowList"
        ' Items report row-relative rectangles, so the tool lays rows out from this geometry.
        line.cid = ""
        titles = []
        if node.content <> invalid
            line.cid = node.content.id
            for i = 0 to node.content.getChildCount() - 1
                titles.Push(strOr(node.content.getChild(i).title, ""))
            end for
        end if
        line.rows = titles
        ap = Dev_absPos(node)
        line.tx = ap[0]
        line.ty = ap[1]
        line.iwTotal = Dev_arr(node.itemSize, 0, 0)
        line.ih = Dev_arr(node.itemSize, 1, 0)
        ris = Dev_arr(node.rowItemSize, 0, invalid)
        line.iw = Dev_arr(ris, 0, 0)
        rsp = Dev_arr(node.rowItemSpacing, 0, invalid)
        line.is = Dev_arr(rsp, 0, 0)
        line.rs = Dev_arr(node.rowSpacings, 0, 0)
        lo = Dev_arr(node.rowLabelOffset, 0, invalid)
        line.lo = Dev_arr(lo, 1, 0)
        line.nr = node.numRows
        line.rf = Dev_arr(node.rowItemFocused, 0, 0)
        line.rc = Dev_arr(node.rowItemFocused, 1, 0)
        line.vfs = node.vertFocusAnimationStyle
        line.lf = 30
        if node.rowLabelFont <> invalid and node.rowLabelFont.hasField("size") then line.lf = node.rowLabelFont.size
    else if st = "MarkupGrid" or st = "MarkupList"
        ' a MarkupList is a one-column grid to the tool
        line.cid = ""
        if node.content <> invalid then line.cid = node.content.id
        ap = Dev_absPos(node)
        line.tx = ap[0]
        line.ty = ap[1]
        if st = "MarkupGrid" then line.nc = node.numColumns else line.nc = 1
        line.nr = node.numRows
        line.iw = Dev_arr(node.itemSize, 0, 0)
        line.ih = Dev_arr(node.itemSize, 1, 0)
        line.sx = Dev_arr(node.itemSpacing, 0, 0)
        line.sy = Dev_arr(node.itemSpacing, 1, 0)
        line.fi = node.itemFocused
    else if st = "Video"
        line.state = node.state
    else if st = "LabelList"
        ' geometry only
    else
        ' plain groups and custom components: geometry is implied by their children
        return
    end if
    print "@@L " + FormatJson(line)
end sub

' Scene-absolute position of a node: the sum of translations up to the scene.
function Dev_absPos(node as object) as object
    x = 0
    y = 0
    n = node
    while n <> invalid
        if n.hasField("translation")
            t = n.translation
            if type(t) = "roArray" and t.Count() >= 2
                x = x + t[0]
                y = y + t[1]
            end if
        end if
        n = n.getParent()
    end while
    return [Int(x), Int(y)]
end function

function Dev_arr(arr as dynamic, i as integer, fallback as dynamic) as dynamic
    if type(arr) <> "roArray" or arr.Count() <= i then return fallback
    return arr[i]
end function

function Dev_indexOf(parent as object, child as object) as integer
    if parent = invalid or child = invalid then return -1
    for i = 0 to parent.getChildCount() - 1
        if parent.getChild(i).isSameNode(child) then return i
    end for
    return -1
end function

' Called by RowList / MarkupGrid / MarkupList item components when m.global.dumpTick changes.
' Emits an "Item" header (which list content it belongs to, row/col) followed by the item's own
' nodes; the tool positions the item from the list geometry and draws the children by their
' offsets. The list's content root needs an id for the tool to match items to it.
sub Dev_dumpItem(item as object)
    c = item.itemContent
    if c = invalid or not Dev_isShown(item) then return
    parent = c.getParent()
    if parent = invalid then return
    root = parent.getParent()
    if root = invalid
        ' grid: content -> item
        root = parent
        row = -1
        col = Dev_indexOf(root, c)
    else
        ' rowlist: content -> row -> item
        row = Dev_indexOf(root, parent)
        col = Dev_indexOf(parent, c)
    end if
    r = item.sceneBoundingRect()
    print "@@L " + FormatJson({ t: "Item", cid: strOr(root.id, ""), row: row, col: col, x: Int(r.x), y: Int(r.y), w: Int(r.width), h: Int(r.height) })
    for i = 0 to item.getChildCount() - 1
        Dev_dumpTree(item.getChild(i), true)
    end for
end sub

' True when every ancestor up to the scene is visible; used by list items that dump themselves.
function Dev_isShown(node as object) as boolean
    n = node
    while n <> invalid
        if n.hasField("visible") and n.visible = false then return false
        n = n.getParent()
    end while
    return true
end function

' Starts a one-shot NetTask from a component and routes its result to `handler` (a function in
' the calling component's scope). Returns the task so callers can keep or ignore it.
function Ui_task(op as string, input as object, handler as string) as object
    t = CreateObject("roSGNode", "NetTask")
    t.op = op
    t.input = input
    t.observeField("result", handler)
    t.control = "RUN"
    return t
end function

' "LIVE", "7:30 PM", "Tue 7:30 PM", "Final" for a card.
function Ui_whenLabel(e as object) as string
    if e.live
        if not isEmpty(e.lt) then return e.lt
        return "LIVE"
    end if
    if e.ended
        if not isEmpty(e.lt) then return e.lt
        return "Final"
    end if
    if e.ts <= 0 then return "TBD"
    return Ui_clock(e.ts)
end function

function Ui_clock(ts as integer) as string
    dt = CreateObject("roDateTime")
    dt.FromSeconds(ts)
    dt.ToLocalTime()
    now = CreateObject("roDateTime")
    now.ToLocalTime()
    h = dt.GetHours()
    ampm = "AM"
    if h >= 12 then ampm = "PM"
    h12 = h mod 12
    if h12 = 0 then h12 = 12
    t = h12.ToStr() + ":" + padZero(dt.GetMinutes()) + " " + ampm
    sameDay = dt.GetYear() = now.GetYear() and dt.GetDayOfMonth() = now.GetDayOfMonth() and dt.GetMonth() = now.GetMonth()
    if sameDay then return t
    return dt.GetWeekday().Left(3) + " " + t
end function

function Ui_ago(seconds as integer) as string
    d = nowSeconds() - seconds
    if seconds <= 0 then return "never"
    if d < 60 then return "just now"
    if d < 3600 then return (d \ 60).ToStr() + " min ago"
    if d < 86400 then return (d \ 3600).ToStr() + " h ago"
    return (d \ 86400).ToStr() + " d ago"
end function

function Ui_thousands(n as integer) as string
    s = n.ToStr()
    if Len(s) <= 3 then return s
    return Left(s, Len(s) - 3) + "," + Right(s, 3)
end function

' ContentNode for the card grid built from an event record.
function Ui_eventNode(e as object, starred as boolean) as object
    n = CreateObject("roSGNode", "EventNode")
    n.id = e.id
    n.home = e.home
    n.away = e.away
    n.url = e.url
    n.cat = e.cat
    n.ts = e.ts
    n.live = e.live
    n.ended = e.ended
    n.hot = e.hot
    n.rank = toInt(e.rank)
    n.pro = e.pro
    n.league = e.league
    n.ch = e.ch
    n.ca = e.ca
    n.lt = e.lt
    n.sc = e.sc
    n.starred = starred
    n.title = Event_title(e)
    return n
end function

function Ui_eventFromNode(n as object) as object
    e = Event_new()
    e.id = n.id
    e.home = n.home
    e.away = n.away
    e.url = n.url
    e.cat = n.cat
    e.ts = n.ts
    e.live = n.live
    e.ended = n.ended
    e.hot = n.hot
    e.rank = n.rank
    e.pro = n.pro
    e.league = n.league
    e.ch = n.ch
    e.ca = n.ca
    e.lt = n.lt
    e.sc = n.sc
    return e
end function
