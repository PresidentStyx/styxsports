sub init()
    m.lead = m.top.findNode("lead")
    m.signIn = m.top.findNode("signIn")
    m.signedIn = m.top.findNode("signedIn")
    m.steps = m.top.findNode("steps")
    m.code = m.top.findNode("code")
    m.countdown = m.top.findNode("countdown")
    m.statusText = m.top.findNode("statusText")
    m.qr = m.top.findNode("qr")
    m.premiumText = m.top.findNode("premiumText")
    m.iptvText = m.top.findNode("iptvText")
    m.buttons = m.top.findNode("buttons")
    m.pollTimer = m.top.findNode("pollTimer")
    m.tickTimer = m.top.findNode("tickTimer")

    m.buttonDefs = []
    m.buttonNodes = []
    m.buttonIndex = 0
    m.codeInfo = invalid
    m.busy = false
    m.pollTimer.observeField("fire", "onPollTimer")
    m.tickTimer.observeField("fire", "onTick")
end sub

sub onStart()
    if not m.top.start then return
    m.cfg = m.global.config
    if m.cfg = invalid then m.cfg = Config_load()
    if Account_isSignedIn() then showSignedIn() else beginSignIn()
end sub

' ---------------------------------------------------------------------------------------------
' Signed out: request a code, show it (+ QR), poll until approved
' ---------------------------------------------------------------------------------------------

sub beginSignIn()
    m.signIn.visible = true
    m.signedIn.visible = false
    m.lead.text = "Sign in to your StreamEast account and Styx Sports will use its premium servers automatically. Without an account it keeps using the free ones."
    display = Account_activateDisplay(m.cfg)
    m.steps.text = "1.  On your phone, go to " + display + " (or scan the code)" + Chr(10) + "2.  Sign in to your StreamEast account" + Chr(10) + "3.  Under QR Sign In, enter the code shown here"
    activateUrl = Account_activateUrl(m.cfg)
    m.qr.uri = "https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=0&data=" + urlEncode(activateUrl)
    setButtons([{ key: "newcode", text: "Get new code" }, { key: "cancel", text: "Cancel" }])
    requestCode()
end sub

sub requestCode()
    if m.busy then return
    m.busy = true
    m.codeInfo = invalid
    m.code.text = "--- ---"
    m.countdown.text = ""
    m.statusText.text = "Getting your code…"
    m.pollTimer.control = "stop"
    m.tickTimer.control = "stop"
    Ui_task("accountCode", {}, "onCode")
end sub

sub onCode(ev as object)
    m.busy = false
    r = ev.getData()
    if r = invalid then return
    if r.ok <> true
        m.statusText.text = "Something went wrong: " + strOr(r.error, "unknown error")
        return
    end if
    m.codeInfo = r
    m.code.text = Account_displayCode(r.code)
    m.statusText.text = "Waiting for you to enter the code on your phone…"
    onTick()
    m.tickTimer.control = "start"
    m.pollTimer.control = "start"
end sub

sub onTick()
    if m.codeInfo = invalid then return
    remaining = m.codeInfo.expiresAt - nowSeconds()
    if remaining <= 0
        m.countdown.text = ""
        m.tickTimer.control = "stop"
        m.pollTimer.control = "stop"
        m.statusText.text = "That code expired. Get a new one to try again."
        m.codeInfo = invalid
        return
    end if
    mins = Int(remaining / 60)
    secs = remaining - mins * 60
    m.countdown.text = "Code expires in " + mins.ToStr() + ":" + padZero(secs)
end sub

sub onPollTimer()
    if m.codeInfo = invalid then return
    Ui_task("accountPoll", { code: m.codeInfo }, "onPoll")
end sub

sub onPoll(ev as object)
    r = ev.getData()
    if r = invalid or m.codeInfo = invalid then return
    st = strOr(r.status, "pending")
    if st = "approved"
        m.tickTimer.control = "stop"
        m.code.text = "Approved"
        m.countdown.text = ""
        m.statusText.text = "Signing in…"
        token = strOr(r.token, "")
        m.codeInfo = invalid
        Ui_task("accountComplete", { token: token }, "onComplete")
    else if st = "used"
        m.statusText.text = "That code was already used. Get a new one to try again."
        m.tickTimer.control = "stop"
        m.codeInfo = invalid
    else if st = "expired" or st = "invalid"
        m.statusText.text = "That code expired. Get a new one to try again."
        m.tickTimer.control = "stop"
        m.codeInfo = invalid
    else
        m.pollTimer.control = "start"
    end if
end sub

sub onComplete(ev as object)
    r = ev.getData()
    if r = invalid then return
    if r.ok = true
        showToast("Signed in. Premium servers will be used when available.")
        showSignedIn()
    else
        m.statusText.text = "Something went wrong: " + strOr(r.error, "unknown error")
        m.code.text = "--- ---"
    end if
end sub

' ---------------------------------------------------------------------------------------------
' Signed in
' ---------------------------------------------------------------------------------------------

sub showSignedIn()
    m.signIn.visible = false
    m.signedIn.visible = true
    m.pollTimer.control = "stop"
    m.tickTimer.control = "stop"
    m.lead.text = "You are signed in to StreamEast. Games open on this account's premium servers first and fall back to the free ones."
    p = Account_premiumKnown()
    if p = "yes"
        m.premiumText.text = Chr(10003) + "  Premium servers are unlocked on this account."
    else if p = "no"
        m.premiumText.text = "This account does not seem to have premium: its premium servers were locked. Free servers are used instead."
    else
        m.premiumText.text = "Premium status is checked the first time you open a game."
    end if
    if Account_hasIptv()
        m.iptvText.text = "Live TV: this account's IPTV channel list is available from the Live TV chip on the home screen."
    else
        m.iptvText.text = ""
    end if
    setButtons([{ key: "signout", text: "Sign out" }, { key: "back", text: "Back" }])
end sub

sub signOut()
    if m.busy then return
    m.busy = true
    m.premiumText.text = "Signing out…"
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
    x = 0
    for each d in defs
        p = m.buttons.createChild("Pill")
        p.minWidth = 220
        p.text = d.text
        p.translation = [x, 0]
        x += p.pillWidth + 20
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
        requestCode()
    else if k = "cancel" or k = "back"
        closeScreen()
    else if k = "signout"
        signOut()
    end if
end sub

sub closeScreen()
    m.pollTimer.control = "stop"
    m.tickTimer.control = "stop"
    m.top.close = true
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
