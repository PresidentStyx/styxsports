' The viewer's account on the site, signed in with the site's TV flow: the TV asks the account
' service for a short code, the viewer types it (or scans the QR) on their phone, and the TV then
' swaps the approved code for a session. The session lives in the shared cookie jar, so every
' fetch is signed in from then on and stream pages hand out the premium servers.
'
' State lives in registry section "account". Network functions run on Task threads.

function Account_recheckSeconds() as integer
    return 6 * 60 * 60
end function

function Account_prefs() as object
    return CreateObject("roRegistrySection", "account")
end function

function Account_read(key as string, fallback as string) as string
    sec = Account_prefs()
    if sec.Exists(key) then return sec.Read(key)
    return fallback
end function

sub Account_write(values as object)
    sec = Account_prefs()
    for each k in values
        v = values[k]
        if v = invalid
            sec.Delete(k)
        else
            sec.Write(k, v)
        end if
    end for
    sec.Flush()
end sub

' ---------------------------------------------------------------------------------------------
' Cached state (any thread)
' ---------------------------------------------------------------------------------------------

function Account_isSignedIn() as boolean
    return Account_read("signedIn", "0") = "1"
end function

' "yes", "no" or "" (unknown until a premium server has been tried).
function Account_premiumKnown() as string
    return Account_read("premium", "")
end function

sub Account_notePremium(unlocked as boolean)
    if not Account_isSignedIn() then return
    v = "no"
    if unlocked then v = "yes"
    Account_write({ premium: v })
end sub

function Account_isStale() as boolean
    return nowSeconds() - toInt(Account_read("checkedAt", "0")) > Account_recheckSeconds()
end function

function Account_playlistUrl() as string
    return Account_read("iptvPlus", "")
end function

function Account_hasIptv() as boolean
    return Account_isSignedIn() and Account_playlistUrl() <> ""
end function

function Account_iptvStale() as boolean
    return nowSeconds() - toInt(Account_read("iptvCheckedAt", "0")) > Account_recheckSeconds()
end function

function Account_activateUrl(cfg as object) as string
    return cfg.authBaseUrl + "/activate?from=" + hostOf(Site_currentBase(cfg))
end function

function Account_activateDisplay(cfg as object) as string
    return hostOf(cfg.authBaseUrl) + "/activate"
end function

' ---------------------------------------------------------------------------------------------
' Sign-in flow (Task thread)
' ---------------------------------------------------------------------------------------------

' Asks for a fresh code: { code, deviceId, expiresAt } or { error }.
function Account_requestCode(cfg as object) as object
    deviceId = Account_read("deviceId", "")
    body = ""
    if deviceId <> "" then body = "device_id=" + urlEncode(deviceId)
    r = Http_postForm(cfg.authBaseUrl + "/device/code", body, cfg.authBaseUrl + "/tv")
    if not r.ok then return { error: r.error }
    d = parseJsonSafe(r.body)
    if type(d) <> "roAssociativeArray" then return { error: "Unexpected answer from the account service" }
    if d.success <> true then return { error: "Code request refused" }
    code = strOr(d.code, "")
    id = strOr(d.device_id, deviceId)
    if code = "" or id = "" then return { error: "Malformed code response" }
    Account_write({ deviceId: id })
    expiresAt = toInt(d.expires_at)
    if expiresAt = 0
        expiresIn = toInt(d.expires_in)
        if expiresIn = 0 then expiresIn = 600
        expiresAt = nowSeconds() + expiresIn
    end if
    return { code: code, deviceId: id, expiresAt: expiresAt }
end function

' "VH8 48Z" for the screen.
function Account_displayCode(code as string) as string
    if Len(code) = 6 then return Left(code, 3) + " " + Right(code, 3)
    return code
end function

' { status: pending|approved|used|expired|invalid, token }
function Account_poll(cfg as object, code as object) as object
    url = cfg.authBaseUrl + "/device/poll?code=" + urlEncode(code.code) + "&device_id=" + urlEncode(code.deviceId)
    r = Http_get(url, cfg.authBaseUrl + "/tv")
    if not r.ok then return { status: "pending", token: "" }
    d = parseJsonSafe(r.body)
    if type(d) <> "roAssociativeArray" then return { status: "pending", token: "" }
    return { status: strOr(d.status, "pending"), token: strOr(d.auth_token, "") }
end function

' Swaps an approved token for a session on the account service and on the mirror. Returns "" or an error.
function Account_completeSignIn(cfg as object, token as string) as string
    base = Site_currentBase(cfg)
    r = Http_get(cfg.authBaseUrl + "/device/login?token=" + urlEncode(token) + "&from=" + hostOf(base))
    if not r.ok then logi("Account", "device login: " + r.error)
    Http_get(base + "/") ' make sure the mirror ran its SSO hand-off too
    if not Account_refreshStatus(cfg) then return "Signed in, but the account service does not see a session"
    Account_write({ premium: invalid })
    Account_discoverIptv(cfg)
    return ""
end function

' Asks the account service whether the cookies still make a signed-in session.
function Account_refreshStatus(cfg as object) as boolean
    r = Http_get(cfg.authBaseUrl + "/my-account/")
    if not r.ok
        logi("Account", "status check failed: " + r.error)
        return Account_isSignedIn() ' offline: keep what we know
    end if
    ' Signed out, the service redirects to its login form instead of the account page (roUrlTransfer
    ' hides the final URL, so tell them apart by content: tabs / logout link vs. a password field).
    body = r.body
    signedIn = contains(body, "/logout") or contains(body, "acc-iptv-url-input") or contains(body, "?tab=")
    if not signedIn and not contains(body, "type=""password""") and contains(body, "my-account") then signedIn = true
    logi("Account", "account status: signedIn=" + signedIn.ToStr())
    v = "0"
    if signedIn then v = "1"
    values = { signedIn: v, checkedAt: nowSeconds().ToStr() }
    if not signedIn
        values.premium = invalid
        values.iptvPlus = invalid
        values.iptvEpg = invalid
        Iptv_clearCache()
    end if
    Account_write(values)
    return signedIn
end function

' Signs out on the account service and forgets every cookie.
sub Account_signOut(cfg as object)
    Http_get(cfg.authBaseUrl + "/logout/")
    CookieJar_clear()
    sec = Account_prefs()
    for each k in sec.GetKeyList()
        sec.Delete(k)
    end for
    sec.Flush()
    Iptv_clearCache()
end sub

' ---------------------------------------------------------------------------------------------
' IPTV playlist (premium perk)
' ---------------------------------------------------------------------------------------------

' Reads the personal playlist links off the account page's IPTV tab.
function Account_discoverIptv(cfg as object) as boolean
    r = Http_get(cfg.authBaseUrl + "/my-account/?tab=iptv")
    if not r.ok then return Account_hasIptv()
    urls = {}
    for each mt in matchAll(cfg.parser.iptvUrlInput, r.body)
        urls[mt[1]] = htmlUnescape(mt[2])
    end for
    plus = urls["iptv-m3u-plus"]
    epg = urls["acc-epg-xmltv"]
    values = { iptvCheckedAt: nowSeconds().ToStr() }
    if not isStr(plus) or not startsWith(plus, "http")
        values.iptvPlus = invalid
        values.iptvEpg = invalid
        Account_write(values)
        logi("Account", "no IPTV playlist on this account")
        return false
    end if
    values.iptvPlus = plus
    if isStr(epg) and startsWith(epg, "http") then values.iptvEpg = epg else values.iptvEpg = invalid
    Account_write(values)
    logi("Account", "IPTV playlist found on " + hostOf(plus))
    return true
end function
