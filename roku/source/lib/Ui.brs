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
