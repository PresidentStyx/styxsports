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

    while true
        msg = wait(0, port)
        if type(msg) = "roSGScreenEvent"
            if msg.isScreenClosed() then return
        end if
    end while
end sub
