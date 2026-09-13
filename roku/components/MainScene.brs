sub init()
    m.top.backgroundColor = Ui_color("bg")
    m.top.backgroundUri = ""
    m.screens = m.top.findNode("screens")
    m.stack = []

    ' Shared config for every screen; refreshed in the background right away. dumpTick is bumped by
    ' the "dump" dev command so RowList/MarkupGrid items (not reachable from the tree) dump too.
    m.global.addFields({ config: Config_load(), dumpTick: 0 })
    m.configTask = Ui_task("config", {}, "onConfigRefreshed")

    pushScreen("HomeScreen", {})
end sub

sub onConfigRefreshed(ev as object)
    r = ev.getData()
    if r <> invalid and r.changed = true then m.global.config = Config_load()
end sub

' Developer commands (only reachable from the LAN via ECP while sideloaded):
'   cmd=dump           print the on-screen layout as JSON lines for tools/layout-shot.ps1
'   cmd=key&key=down   act on a remote key (this TV refuses ECP keypress with 403); screens
'                      implement `devKey` and route it through the same code as real keys
sub onDevCmd()
    info = parseJsonSafe(m.top.devCmd)
    if info = invalid or info.cmd = invalid then return
    if info.cmd = "dump"
        Dev_dumpTree(m.top, true)
        m.global.dumpTick = m.global.dumpTick + 1
    else if info.cmd = "key" and info.key <> invalid
        key = LCase(info.key)
        if key = "ok" then key = "OK"
        if key = "back" and m.stack.Count() > 1
            popScreen()
        else if m.stack.Count() > 0
            top = m.stack.Peek()
            if top.hasField("devKey") then top.devKey = key
        end if
    end if
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
