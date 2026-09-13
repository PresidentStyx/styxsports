' Styx Sports for Roku.
'
' Entry point: creates the SceneGraph scene and pumps messages until the channel exits. Everything
' else lives in components/ (screens, tasks) and source/lib/ (shared, thread-safe helpers).

sub Main(args as dynamic)
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.setMessagePort(port)
    scene = screen.CreateScene("MainScene")
    screen.show()
    scene.launchArgs = args

    ' ECP "input" messages (curl -X POST "http://<roku>:8060/input?cmd=dump") reach us here; they
    ' drive the developer tools (layout dump, key injection). Harmless in normal use.
    input = CreateObject("roInput")
    input.setMessagePort(port)

    while true
        msg = wait(0, port)
        if type(msg) = "roSGScreenEvent"
            if msg.isScreenClosed()
                ' Home key / exit while a premium stream or Live TV was open: give the shared
                ' premium slot back now instead of letting the lease time out (45 s).
                g = screen.getGlobalNode()
                if g <> invalid and g.leaseHeld = true then Pool_release()
                return
            end if
        else if type(msg) = "roInputEvent"
            info = msg.getInfo()
            if info <> invalid and info.cmd <> invalid then scene.devCmd = FormatJson(info)
        end if
    end while
end sub
