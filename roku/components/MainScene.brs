sub init()
    m.top.backgroundColor = Ui_color("bg")
    m.top.backgroundUri = ""
    m.screens = m.top.findNode("screens")
    m.stack = []

    ' Shared config for every screen; refreshed in the background right away.
    m.global.addFields({ config: Config_load() })
    m.configTask = Ui_task("config", {}, "onConfigRefreshed")

    pushScreen("HomeScreen", {})
end sub

sub onConfigRefreshed(ev as object)
    r = ev.getData()
    if r <> invalid and r.changed = true then m.global.config = Config_load()
end sub

' ---------------------------------------------------------------------------------------------
' Screen stack
' ---------------------------------------------------------------------------------------------

sub pushScreen(name as string, args as object)
    screen = CreateObject("roSGNode", name)
    if screen = invalid then return
    screen.observeField("navigate", "onNavigate")
    screen.observeField("close", "onScreenClose")
    for each k in args
        if screen.hasField(k) then screen[k] = args[k]
    end for
    if m.stack.Count() > 0
        top = m.stack.Peek()
        top.visible = false
    end if
    m.stack.Push(screen)
    m.screens.appendChild(screen)
    screen.setFocus(true)
    ' Arguments are all in place now; screens that need them to start wait for this.
    if screen.hasField("start") then screen.start = true
end sub

sub popScreen()
    if m.stack.Count() <= 1 then return
    screen = m.stack.Pop()
    screen.unobserveField("navigate")
    screen.unobserveField("close")
    m.screens.removeChild(screen)
    top = m.stack.Peek()
    top.visible = true
    top.setFocus(true)
    if top.hasField("resumed") then top.resumed = true
end sub

sub onNavigate(ev as object)
    req = ev.getData()
    if req = invalid or isEmpty(req.screen) then return
    args = {}
    for each k in req
        if k <> "screen" then args[k] = req[k]
    end for
    pushScreen(req.screen, args)
end sub

sub onScreenClose(ev as object)
    if ev.getData() = true then popScreen()
end sub

' Back on the home screen exits the channel; anywhere else it pops the screen.
function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "back"
        if m.stack.Count() > 1
            popScreen()
            return true
        end if
    end if
    return false
end function
