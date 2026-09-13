' AccountActivity in SceneGraph: same copy, same sizes (Android dp x 2), same states.

sub init()
    m.left = m.top.findNode("left")
    m.title = m.top.findNode("title")
    m.lead = m.top.findNode("lead")
    m.steps = m.top.findNode("steps")
    m.statusText = m.top.findNode("statusText")
    m.buttons = m.top.findNode("buttons")
    m.card = m.top.findNode("card")
    m.cardBg = m.top.findNode("cardBg")
    m.codeLabel = m.top.findNode("codeLabel")
    m.code = m.top.findNode("code")
    m.countdown = m.top.findNode("countdown")
    m.qrFrame = m.top.findNode("qrFrame")
    m.qr = m.top.findNode("qr")
    m.scan = m.top.findNode("scan")
    m.pollTimer = m.top.findNode("pollTimer")
    m.tickTimer = m.top.findNode("tickTimer")
    m.layoutTimer = m.top.findNode("layoutTimer")
    m.closeTimer = m.top.findNode("closeTimer")

    ' Fonts and colours from AccountActivity.buildUi()
    m.title.font = Ui_font(Ui_sp(28), true)
    m.title.color = Ui_color("text")
    m.lead.font = Ui_font(Ui_sp(15), false)
    m.lead.color = Ui_color("muted")
    m.lead.lineSpacing = Int(Ui_linePitch(Ui_sp(15)) * 0.15 + 0.5)  ' setLineSpacing(0, 1.15)
    m.steps.font = Ui_font(Ui_sp(16), false)
    m.steps.color = Ui_color("text")
    m.steps.lineSpacing = Int(Ui_linePitch(Ui_sp(16)) * 0.35 + 0.5) ' setLineSpacing(0, 1.35)
    m.statusText.font = Ui_font(Ui_sp(14), false)
    m.statusText.color = Ui_color("muted")
    m.codeLabel.font = Ui_font(Ui_sp(13), false)
    m.codeLabel.color = Ui_color("muted")
    m.code.font = Ui_font(Ui_sp(54), true)
    m.code.color = Ui_color("muted")
    m.countdown.font = Ui_font(Ui_sp(13), false)
    m.countdown.color = Ui_color("muted")
    m.scan.font = Ui_font(Ui_sp(12), false)
    m.scan.color = Ui_color("muted")

    m.buttonDefs = []
    m.buttonNodes = []
    m.buttonIndex = 0
    m.codeInfo = invalid
    m.busy = false
    m.finishing = false
    m.pollTimer.observeField("fire", "onPollTimer")
    m.tickTimer.observeField("fire", "onTick")
    m.layoutTimer.observeField("fire", "layout")
    m.closeTimer.observeField("fire", "closeScreen")
end sub

sub onStart()
    if not m.top.start then return
    m.cfg = m.global.config
    if m.cfg = invalid then m.cfg = Config_load()
    if Account_isSignedIn() then showSignedIn() else beginSignIn()
end sub

' ---------------------------------------------------------------------------------------------
' Layout: a row padded 72x40 dp with both columns centred vertically (LinearLayout gravity)
' ---------------------------------------------------------------------------------------------

sub layout()
    cardVisible = m.card.visible
    leftW = 1920 - 288
    if cardVisible then leftW -= 680
    textW = leftW - 80

    ' --- left column
    m.title.width = leftW
    m.lead.width = textW
    m.steps.width = textW
    m.statusText.width = leftW
    y = 60
    y += 52
    m.title.translation = [0, y]
    m.title.height = Ui_lineHeight(Ui_sp(28))
    y += m.title.height + 16
    m.lead.translation = [0, y]
    y += Ui_labelHeight(m.lead, Ui_sp(15), 0) + 44
    m.steps.translation = [0, y]
    y += Ui_labelHeight(m.steps, Ui_sp(16), 0) + 44
    m.statusText.translation = [0, y]
    y += Ui_labelHeight(m.statusText, Ui_sp(14), 0)
    if m.buttonNodes.Count() > 0
        y += 36
        m.buttons.translation = [0, y]
        x = 0
        bh = 0
        for each p in m.buttonNodes
            p.translation = [x, 0]
            x += p.pillWidth + 24
            if p.pillHeight > bh then bh = p.pillHeight
        end for
        y += bh
    end if
    m.left.translation = [144, Int((1080 - y) / 2)]

    ' --- code card (340 dp wide, 30x26 dp padding, children centred)
    if cardVisible
        cy = 52
        m.codeLabel.translation = [60, cy]
        m.codeLabel.height = Ui_lineHeight(Ui_sp(13))
        cy += m.codeLabel.height + 12
        m.code.translation = [60, cy]
        m.code.height = Ui_lineHeight(Ui_sp(54))
        cy += m.code.height + 4
        m.countdown.translation = [60, cy]
        m.countdown.height = Ui_lineHeight(Ui_sp(13))
        cy += m.countdown.height + 36
        m.qrFrame.translation = [140, cy]
        m.qr.translation = [156, cy + 16]
        cy += 400 + 24
        m.scan.translation = [60, cy]
        m.scan.height = Ui_lineHeight(Ui_sp(12))
        cy += m.scan.height + 52
        m.cardBg.height = cy
        m.card.translation = [1920 - 144 - 680, Int((1080 - cy) / 2)]
    end if
end sub

sub relayoutSoon()
    layout()
    m.layoutTimer.control = "start"
end sub

' ---------------------------------------------------------------------------------------------
' Signed out: request a code, show it (+ QR), poll until approved
' ---------------------------------------------------------------------------------------------

sub beginSignIn()
    stopTimers()
    m.finishing = false
    m.codeInfo = invalid
    m.card.visible = true
    m.lead.text = "Sign in to your StreamEast account and Styx Sports will use its premium servers automatically. Without an account it keeps using the free ones."
    display = Account_activateDisplay(m.cfg)
    m.steps.text = "1.  On your phone, go to " + display + " (or scan the code)" + Chr(10) + "2.  Sign in to your StreamEast account" + Chr(10) + "3.  Under QR Sign In, enter the code shown here"
    m.code.text = "--- ---"
    m.code.color = Ui_color("muted")
    m.countdown.text = ""
    activateUrl = Account_activateUrl(m.cfg)
    m.qr.uri = "https://api.qrserver.com/v1/create-qr-code/?size=368x368&margin=0&data=" + urlEncode(activateUrl)
    m.statusText.text = "Getting your code…"
    setButtons([{ key: "cancel", text: "Cancel" }])
    relayoutSoon()
    requestCode()
end sub

sub requestCode()
    if m.busy then return
    m.busy = true
    Ui_task("accountCode", {}, "onCode")
end sub

sub onCode(ev as object)
    m.busy = false
    r = ev.getData()
    if r = invalid then return
    if r.ok <> true
        m.statusText.text = "Something went wrong: " + strOr(r.error, "unknown error")
        setButtons([{ key: "newcode", text: "Retry" }, { key: "cancel", text: "Cancel" }])
        relayoutSoon()
        return
    end if
    m.codeInfo = r
    m.code.text = Account_displayCode(r.code)
    m.code.color = Ui_color("gold")
    m.statusText.text = "Waiting for you to enter the code on your phone…"
    setButtons([{ key: "newcode", text: "Get new code" }, { key: "cancel", text: "Cancel" }])
    relayoutSoon()
    onTick()
    m.tickTimer.control = "start"
    m.pollTimer.control = "start"
end sub

sub onTick()
    if m.codeInfo = invalid then return
    remaining = m.codeInfo.expiresAt - nowSeconds()
    if remaining <= 0
        onCodeGone("That code expired. Get a new one to try again.")
        return
    end if
    mins = Int(remaining / 60)
    secs = remaining - mins * 60
    m.countdown.text = "Code expires in " + mins.ToStr() + ":" + padZero(secs)
    if remaining <= 60 then m.countdown.color = Ui_color("hot") else m.countdown.color = Ui_color("muted")
end sub

sub onPollTimer()
    if m.codeInfo = invalid then return
    Ui_task("accountPoll", { code: m.codeInfo }, "onPoll")
end sub

sub onPoll(ev as object)
    r = ev.getData()
    if r = invalid or m.codeInfo = invalid or m.finishing then return
    st = strOr(r.status, "pending")
    if st = "approved"
        stopTimers()
        m.finishing = true
        m.code.text = "Approved"
        m.code.color = Ui_color("text")
        m.countdown.text = ""
        m.statusText.text = "Signing in…"
        token = strOr(r.token, "")
        m.codeInfo = invalid
        setButtons([])
        relayoutSoon()
        Ui_task("accountComplete", { token: token }, "onComplete")
    else if st = "used"
        onCodeGone("That code was already used. Get a new one to try again.")
    else if st = "expired" or st = "invalid"
        onCodeGone("That code expired. Get a new one to try again.")
    else
        m.pollTimer.control = "start"
    end if
end sub

sub onCodeGone(why as string)
    stopTimers()
    m.codeInfo = invalid
    m.code.text = "--- ---"
    m.code.color = Ui_color("muted")
    m.countdown.text = ""
    m.statusText.text = why
    setButtons([{ key: "newcode", text: "Get new code" }, { key: "cancel", text: "Cancel" }])
    relayoutSoon()
end sub

sub onComplete(ev as object)
    r = ev.getData()
    if r = invalid then return
    if r.ok = true
        showToast("Signed in. Premium servers will be used when available.")
        showSignedIn()
        m.closeTimer.control = "start"
    else
        m.finishing = false
        m.statusText.text = "Something went wrong: " + strOr(r.error, "unknown error")
        setButtons([{ key: "newcode", text: "Retry" }, { key: "cancel", text: "Cancel" }])
        relayoutSoon()
    end if
end sub

sub stopTimers()
    m.pollTimer.control = "stop"
    m.tickTimer.control = "stop"
end sub

' ---------------------------------------------------------------------------------------------
' Signed in
' ---------------------------------------------------------------------------------------------

sub showSignedIn()
    stopTimers()
    m.codeInfo = invalid
    m.card.visible = false
    m.lead.text = "You are signed in to StreamEast. Games open on this account's premium servers first and fall back to the free ones."
    p = Account_premiumKnown()
    if p = "yes"
        m.steps.text = "Premium servers are unlocked on this account."
    else if p = "no"
        m.steps.text = "This account does not seem to have premium: its premium servers were locked. Free servers are used instead."
    else
        m.steps.text = "Premium status is checked the first time you open a game."
    end if
    m.statusText.text = ""
    setButtons([{ key: "back", text: "Back" }, { key: "signout", text: "Sign out" }])
    relayoutSoon()
end sub

sub signOut()
    if m.busy then return
    m.busy = true
    m.statusText.text = "Signing out…"
    setButtons([])
    relayoutSoon()
    Ui_task("accountSignOut", {}, "onSignedOut")
end sub

sub onSignedOut()
    m.busy = false
    showToast("Signed out.")
    beginSignIn()
end sub

sub showToast(text as string)
    d = CreateObject("roSGNode", "Dialog")
    d.title = text
    d.buttons = ["OK"]
    d.observeField("buttonSelected", "onToastDismiss")
    m.top.getScene().dialog = d
end sub

sub onToastDismiss(ev as object)
    ev.getRoSGNode().close = true
end sub

' ---------------------------------------------------------------------------------------------
' Buttons + keys
' ---------------------------------------------------------------------------------------------

sub setButtons(defs as object)
    for each n in m.buttonNodes
        m.buttons.removeChild(n)
    end for
    m.buttonDefs = defs
    m.buttonNodes = []
    for each d in defs
        p = m.buttons.createChild("Pill")
        p.kind = "buttonLg"
        p.text = d.text
        m.buttonNodes.Push(p)
    end for
    m.buttonIndex = 0
    styleButtons()
    m.top.setFocus(true)
end sub

sub styleButtons()
    for i = 0 to m.buttonNodes.Count() - 1
        m.buttonNodes[i].focused = (i = m.buttonIndex)
    end for
end sub

sub activate()
    if m.buttonIndex < 0 or m.buttonIndex >= m.buttonDefs.Count() then return
    k = m.buttonDefs[m.buttonIndex].key
    if k = "newcode"
        beginSignIn()
    else if k = "cancel" or k = "back"
        closeScreen()
    else if k = "signout"
        signOut()
    end if
end sub

sub closeScreen()
    stopTimers()
    m.closeTimer.control = "stop"
    m.top.close = true
end sub

' Developer key injection (see MainScene.onDevCmd); this screen handles every key itself.
sub onDevKey()
    onKeyEvent(m.top.devKey, true)
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "back"
        closeScreen()
        return true
    else if key = "left"
        if m.buttonIndex > 0 then m.buttonIndex -= 1
        styleButtons()
        return true
    else if key = "right"
        if m.buttonIndex < m.buttonNodes.Count() - 1 then m.buttonIndex += 1
        styleButtons()
        return true
    else if key = "OK"
        activate()
        return true
    end if
    return false
end function
