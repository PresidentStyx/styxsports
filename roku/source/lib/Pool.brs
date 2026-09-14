' The shared premium account's connection pool (sports.styxam.com/api/pool, see web/src/pool.js).
'
' The site caps a premium account at 5 simultaneous connections, and one account is lent to
' every viewer across web, APK and Roku. Before this device uses a premium server or opens Live
' TV it takes a lease on one of the slots; the lease is renewed every 20 s while something plays
' and dropped when playback stops (a missed one expires after 45 s). Free streams never need
' one. The Worker never hands out the account's cookies: the device keeps using its own signed-in
' session for the site itself; the pool only keeps the total under 5.
'
' Task/main thread only (blocking HTTP). Each call returns { ok, granted, used, max, error }.

function Pool_base() as string
    return "https://sports.styxam.com/api/pool"
end function

' The device id shared with /api/ping: one random UUID per install, kept in the registry.
function Pool_clientId() as string
    id = Store_readStr("client_id", "")
    if id = ""
        di = CreateObject("roDeviceInfo")
        id = di.GetRandomUUID()
        Store_writeStr("client_id", id)
    end if
    return id
end function

' What this Roku is called on /stats: the name its owner gave it in Settings ("Living Room")
' and the model ("Roku Streaming Stick 4K"), or just the model when no name was set.
function Pool_deviceName() as string
    di = CreateObject("roDeviceInfo")
    model = di.GetModelDisplayName()
    if model = "" then model = "Roku"
    given = di.GetFriendlyName()
    if given = invalid then given = ""
    given = given.Trim()
    if given = "" or LCase(given) = LCase(model) then return model
    return given + " · " + model
end function

' kind: "game" | "tv". label: game title or channel name (shown on /stats).
function Pool_acquire(kind as string, label as string) as object
    body = { id: Pool_clientId(), kind: kind, label: Left(label, 80), platform: "roku" }
    ' Signed in here: the lease is on this device's own account. It only takes a shared slot when
    ' that account is one of the shared ones, which the Worker tells from the playlist URL's
    ' fingerprint (never the URL itself).
    if Account_isSignedIn()
        body.own = true
        fp = Pool_fingerprint(Account_playlistUrl())
        if fp <> "" then body.acct = fp
    end if
    return Pool_call("/acquire", body)
end function

' First 8 bytes of SHA-256 as hex, like the Worker's fingerprint(); "" without a URL.
function Pool_fingerprint(iptvUrl as string) as string
    u = iptvUrl.Trim()
    if u = "" then return ""
    ba = CreateObject("roByteArray")
    ba.FromAsciiString(u)
    digest = CreateObject("roEVPDigest")
    if digest.Setup("sha256") <> 0 then return ""
    hex = digest.Process(ba)
    return LCase(Left(hex, 16))
end function

function Pool_heartbeat(label as string) as object
    body = { id: Pool_clientId() }
    if label <> "" then body.label = Left(label, 80)
    return Pool_call("/heartbeat", body)
end function

function Pool_release() as object
    return Pool_call("/release", { id: Pool_clientId() })
end function

' ---------------------------------------------------------------------------------------------
' The shared account itself (never its cookies). A device with no sign-in of its own plays the
' premium tabs and Live TV through the Worker while it holds a lease: the Worker reads the site
' with the shared session and hands back the playlist URL, which this device then plays from its
' own IP. What is shared is refreshed with every presence ping and kept in the registry so the
' home screen can decide synchronously (Premium Only chip, Live TV chip).
' ---------------------------------------------------------------------------------------------

function Pool_webBase() as string
    return "https://sports.styxam.com"
end function

' GET /api/pool/info -> registry. Also folds the same fields out of an acquire reply.
sub Pool_refreshInfo()
    r = Http_get(Pool_base() + "/info", "", 6000)
    if not r.ok then return
    data = parseJsonSafe(r.body)
    if type(data) <> "roAssociativeArray" then return
    Pool_noteInfo(data)
end sub

sub Pool_noteInfo(data as object)
    if data.shared = invalid then return
    Store_writeStr("pool_shared", boolStr(data.shared = true))
    Store_writeStr("pool_iptv", boolStr(data.sharedIptv = true))
    if data.sharedPremium = true
        Store_writeStr("pool_premium", "yes")
    else if data.sharedPremium = false
        Store_writeStr("pool_premium", "no")
    else
        Store_writeStr("pool_premium", "")
    end if
end sub

function boolStr(b as boolean) as string
    if b then return "1"
    return "0"
end function

' Someone shared an account and this device has none of its own: premium comes from the pool.
function Pool_sharedAvailable() as boolean
    return not Account_isSignedIn() and Store_readStr("pool_shared", "0") = "1" and Store_readStr("pool_premium", "") <> "no"
end function

function Pool_sharedIptv() as boolean
    return not Account_isSignedIn() and Store_readStr("pool_shared", "0") = "1" and Store_readStr("pool_iptv", "0") = "1"
end function

' Resolves one premium server tab through the Worker with this device's lease. Returns a
' Resolver stream record { server, hlsUrl, playerOrigin, state, error? } - hlsUrl is the raw CDN
' URL when the CDN allows cross-origin play (it does for the premium ones), else the Worker's
' signed /hls/ proxy path.
function Pool_resolveShared(server as object) as object
    out = { server: server, hlsUrl: invalid, playerOrigin: "", state: "" }
    q = "?server=" + urlEncode(server.pageUrl) + "&name=" + urlEncode(server.name) + "&premium=1&slot=" + urlEncode(Pool_clientId())
    r = Http_get(Pool_webBase() + "/api/stream" + q, "", 30000)
    if not r.ok
        out.error = r.error
        if r.code = 401 then out.error = "the pool lease was not accepted"
        return out
    end if
    data = parseJsonSafe(r.body)
    if type(data) <> "roAssociativeArray" or type(data.stream) <> "roAssociativeArray"
        out.error = "bad reply from the web player"
        return out
    end if
    s = data.stream
    if isStr(s.state) then out.state = s.state
    if s.warming = true
        out.state = "warming"
        out.error = "The stream is still starting up on the server"
        return out
    end if
    if isStr(s.direct) and s.direct <> ""
        out.hlsUrl = s.direct
    else if isStr(s.hls) and s.hls <> ""
        out.hlsUrl = Pool_webBase() + s.hls
    else if out.state = "gate"
        out.error = "Premium server is locked on the shared account"
    else
        out.error = "No playable stream on " + server.name
    end if
    logi("Pool", server.name + " via web: state=" + out.state + " cdn=" + strOr(s.cdn, "-") + " direct=" + boolStr(isStr(s.direct) and s.direct <> ""))
    return out
end function

' The shared account's Live TV list from the Worker (/api/iptv, already grouped, sports first),
' written into the same cachefs:/ files Iptv_fetch produces. Returns the index or { error }.
function Pool_fetchIptv() as object
    r = Http_get(Pool_webBase() + "/api/iptv?slot=" + urlEncode(Pool_clientId()), "", 90000)
    if not r.ok
        if r.code = 401 then return { error: "the pool lease was not accepted" }
        if r.code = 403 then return { error: "no pool slot" }
        return { error: r.error }
    end if
    data = parseJsonSafe(r.body)
    if type(data) <> "roAssociativeArray" or type(data.groups) <> "roArray" then return { error: strOr(data.error, "bad channel list") }
    Iptv_clearGroupFiles()
    idx = { fetchedAt: nowSeconds(), channelCount: 0, groups: [] }
    i = 0
    for each g in data.groups
        if type(g.c) = "roArray" and g.c.Count() > 0
            channels = []
            for each c in g.c
                if isStr(c.u) and startsWith(c.u, "http")
                    logo = ""
                    if isStr(c.l) and startsWith(c.l, "http") then logo = c.l
                    channels.Push({ name: strOr(c.n, "Channel"), logo: logo, group: strOr(g.n, "Other"), url: c.u, tvgId: "" })
                end if
            end for
            if channels.Count() > 0
                path = Iptv_groupPath(i)
                WriteAsciiFile(path, FormatJson(channels))
                idx.groups.Push({ name: strOr(g.n, "Other"), count: channels.Count(), file: path })
                idx.channelCount += channels.Count()
                i += 1
            end if
        end if
    end for
    if idx.groups.Count() = 0 then return { error: "the shared account's playlist has no channels" }
    WriteAsciiFile(Iptv_indexPath(), FormatJson(idx))
    logi("Pool", "shared playlist: " + idx.channelCount.ToStr() + " channels in " + idx.groups.Count().ToStr() + " groups")
    return idx
end function

function Pool_call(path as string, body as object) as object
    out = { ok: false, granted: false, used: 0, max: 5, error: "" }
    r = Http_request("POST", Pool_base() + path, FormatJson(body), "", 6000, { "Content-Type": "application/json" })
    if not r.ok
        out.error = r.error
        logi("Pool", path + " failed: " + r.error)
        return out
    end if
    data = parseJsonSafe(r.body)
    if type(data) <> "roAssociativeArray"
        out.error = "bad reply"
        return out
    end if
    out.ok = true
    out.granted = (data.granted = true)
    Pool_noteInfo(data) ' acquire replies carry the shared-account facts too
    if data.used <> invalid then out.used = toInt(data.used)
    if data.max <> invalid and toInt(data.max) > 0 then out.max = toInt(data.max)
    if isStr(data.error) then out.error = data.error
    logi("Pool", path + " -> granted=" + out.granted.ToStr() + " " + out.used.ToStr() + "/" + out.max.ToStr())
    return out
end function
