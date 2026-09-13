' Render-thread helpers shared by the screens.

function Ui_color(name as string) as string
    if name = "bg" then return "0x0A0A0AFF"
    if name = "card" then return "0x161616FF"
    if name = "cardFocus" then return "0x232323FF"
    if name = "line" then return "0x2A2A2AFF"
    if name = "text" then return "0xF2F2F2FF"
    if name = "dim" then return "0x9A9A9AFF"
    if name = "live" then return "0xE53935FF"
    if name = "gold" then return "0xF5C518FF"
    if name = "accent" then return "0x3D8BFFFF"
    if name = "pill" then return "0x1F1F1FFF"
    if name = "pillOn" then return "0xF2F2F2FF"
    if name = "scrim" then return "0x000000B0"
    return "0xFFFFFFFF"
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
    if st = "RowList" or st = "MarkupGrid" or st = "Video" then return
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
    else if st = "MarkupGrid"
        line.cid = ""
        if node.content <> invalid then line.cid = node.content.id
        ap = Dev_absPos(node)
        line.tx = ap[0]
        line.ty = ap[1]
        line.nc = node.numColumns
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

' Called by RowList / MarkupGrid item components when m.global.dumpTick changes. Emits an "Item"
' header (which list content it belongs to, row/col) followed by the item's own nodes; the tool
' positions the item from the list geometry and draws the children by their offsets.
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
    e.pro = n.pro
    e.league = n.league
    e.ch = n.ch
    e.ca = n.ca
    e.lt = n.lt
    e.sc = n.sc
    return e
end function
