' Anonymous playback telemetry for sports.styxam.com/api/telemetry (web/src/telemetry.js):
' start (time to first frame), stall, switch, error, stop. Events queue on the render thread
' (Telemetry_push, in m.telemetry) and go out through the NetTask "telemetry" op every minute
' and when the player closes. Keyed by the same client id as /api/ping. Off unless the
' `telemetry` flag in config.json is on for this device (Flags.brs).

function Telemetry_url() as string
    return "https://sports.styxam.com/api/telemetry"
end function

' --- render thread ---------------------------------------------------------------------------

' Starts a playback attempt: what is playing and from where. `cdn` is the stream host (or the
' player origin for relayed streams), `relay` whether the bytes come through the Worker.
' `startedAt` may be moved back to when the viewer asked (the press or the switch) so ttff counts
' the resolve too; `pre` marks a stream resolved before the press (HomeScreen prefetch).
function Telemetry_attempt(game as string, server as string, cdn as string, premium as boolean, relay as boolean) as object
    return { game: game, server: server, cdn: cdn, premium: premium, relay: relay, startedAt: Telemetry_now(), firstFrameAt: 0, stallAt: 0, pre: false }
end function

sub Telemetry_start(a as object)
    if a = invalid then return
    a.firstFrameAt = Telemetry_now()
    a.stallAt = 0
    ev = { kind: "start", game: a.game, server: a.server, cdn: a.cdn, premium: a.premium, relay: a.relay, ttff: a.firstFrameAt - a.startedAt }
    if a.pre = true then ev.pre = true
    Telemetry_push(ev)
end sub

sub Telemetry_stallBegan(a as object)
    if a = invalid then return
    if a.firstFrameAt > 0 and a.stallAt = 0 then a.stallAt = Telemetry_now()
end sub

sub Telemetry_stallEnded(a as object, positionMs as integer)
    if a = invalid or a.stallAt = 0 then return
    d = Telemetry_now() - a.stallAt
    a.stallAt = 0
    Telemetry_push({ kind: "stall", cdn: a.cdn, premium: a.premium, relay: a.relay, duration: d, position: positionMs })
end sub

sub Telemetry_error(a as object, code as string)
    if a = invalid then return
    Telemetry_push({ kind: "error", cdn: a.cdn, premium: a.premium, relay: a.relay, code: code })
end sub

sub Telemetry_switched(fromName as string, toName as string, reason as string)
    Telemetry_push({ kind: "switch", from: fromName, to: toName, reason: reason })
end sub

' The attempt is over; how long it was watched (nothing if it never showed a frame).
sub Telemetry_stop(a as object)
    if a = invalid or a.firstFrameAt = 0 then return
    watched = Telemetry_now() - a.firstFrameAt
    a.firstFrameAt = 0
    Telemetry_push({ kind: "stop", cdn: a.cdn, premium: a.premium, relay: a.relay, duration: watched })
end sub

sub Telemetry_push(ev as object)
    if not Telemetry_enabled() then return
    if m.telemetry = invalid then m.telemetry = []
    ev.at = Telemetry_wallMs()
    m.telemetry.Push(ev)
    if m.telemetry.Count() > 200 then m.telemetry.Shift()
    if m.telemetry.Count() >= 40 then Telemetry_flush()
end sub

' Hands the queue to a NetTask. Call from a 60 s timer and when the player closes.
sub Telemetry_flush()
    if m.telemetry = invalid or m.telemetry.Count() = 0 then return
    batch = m.telemetry
    m.telemetry = []
    ' Fire and forget (no Ui_task: this file is also compiled into NetTask, which has no Ui.brs).
    t = CreateObject("roSGNode", "NetTask")
    t.op = "telemetry"
    t.input = { events: batch }
    t.control = "RUN"
end sub

function Telemetry_enabled() as boolean
    if m.telemetryEnabledAt <> invalid and Telemetry_now() - m.telemetryEnabledAt < 300000 then return m.telemetryEnabled = true
    ' On unless config.json says "telemetry": false (same default as the web player and the APK).
    m.telemetryEnabled = Flags_onDefault(Config_load(), "telemetry", true)
    m.telemetryEnabledAt = Telemetry_now()
    return m.telemetryEnabled
end function

' --- task thread -----------------------------------------------------------------------------

sub Telemetry_post(events as object)
    if events = invalid or events.Count() = 0 then return
    body = { device: Pool_clientId(), platform: "roku", version: CreateObject("roAppInfo").GetVersion(), network: "direct", events: events }
    Http_postJson(Telemetry_url(), FormatJson(body))
end sub

' --- clocks ----------------------------------------------------------------------------------

' Monotonic milliseconds (roTimespan), for durations.
function Telemetry_now() as longinteger
    if m.telemetryClock = invalid then m.telemetryClock = CreateObject("roTimespan")
    return m.telemetryClock.TotalMilliseconds()
end function

' Wall-clock milliseconds since the epoch, for event timestamps.
function Telemetry_wallMs() as longinteger
    d = CreateObject("roDateTime")
    ms& = d.AsSeconds()
    ms& = ms& * 1000 + d.GetMilliseconds()
    return ms&
end function
