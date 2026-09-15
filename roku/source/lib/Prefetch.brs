' Zero-wait start (4.0 phase 2.1; Prefetch.java / app.js `prefetch`): resolve a game's stream
' while its card merely has focus, so OK plays instead of spinning.
'
' Task thread (NetTask "prefetch" op). HomeScreen schedules a free pass 600 ms after a card gains
' focus (stream page + best free server) and a premium pass at 2 s (first named premium tab under
' a *pre-warm* pool lease: acquire { prewarm: true }, granted only while two slots stay free,
' dropped by the Worker after 60 s unless the player acquires for real - same device id, same
' slot). Results live in m.global.prefetch for PlayerScreen; anything older than 90 s is ignored
' there (playlist URLs are signed and short-lived).

' The site's generic "Server N" premium tabs are third-party embeds no native player reads; the
' named ones ("Redzone 1", "Raiders") are the site's own players and resolve.
function Prefetch_isGeneric(name as string) as boolean
    return re("(?i)^server\s*\d+$", "").IsMatch(name.Trim())
end function

' First named premium tab, or invalid.
function Prefetch_namedPremium(servers as object) as dynamic
    for each s in servers
        if s.premium = true and not Prefetch_isGeneric(s.name) then return s
    end for
    return invalid
end function

' Some premium is reachable from this device (mirrors PlayerScreen.premiumCapable).
function Prefetch_premiumCapable() as boolean
    if Account_isSignedIn() then return Account_premiumKnown() <> "no"
    return Pool_sharedAvailable()
end function

' One server tab to a playable stream, the way this device can (the "resolveServer" op and the
' prefetch share this). viaPool: this device holds a pool slot.
'  - Premium tab without an account of our own: the Worker reads it with the shared account.
'  - Otherwise this device resolves it; a premium tab our session gets no player for (the site
'    does not hand every session the same premium player) is retried through the Worker.
function Prefetch_resolveServer(cfg as object, server as object, page as dynamic, viaPool as boolean) as object
    if server.premium = true and viaPool and not Account_isSignedIn()
        return Resolver_checked(Pool_resolveShared(server))
    end if
    out = Resolver_resolve(cfg.parser, server, page)
    if out.hlsUrl = invalid and server.premium = true and viaPool and out.state <> "gate" and out.state <> "warming"
        logi("Resolver", server.name + ": no player for this session; asking the web player")
        shared = Resolver_checked(Pool_resolveShared(server))
        if shared.hlsUrl <> invalid or shared.state = "warming" then out = shared
    end if
    return out
end function

' The prefetch itself. `preferred`: the server name remembered for this game ("" when none).
' `known`: { servers, activeIndex } from an earlier pass, so the tabs are not fetched again
' (without the HTML, the active server's page is re-read if it is the one resolved).
' -> { ok, id, page: { servers, activeIndex }, key (server pageUrl), stream, prewarm, tookMs }
function Prefetch_run(cfg as object, e as object, premium as boolean, preferred = "" as string, known = invalid as dynamic) as object
    out = { ok: false, id: e.id, prewarm: false }
    clock = CreateObject("roTimespan")
    if type(known) = "roAssociativeArray" and type(known.servers) = "roArray" and known.servers.Count() > 0
        page = { servers: known.servers, activeIndex: known.activeIndex, html: invalid }
    else
        page = Resolver_page(cfg.parser, e.url)
        if page.error <> invalid
            out.error = page.error
            return out
        end if
    end if
    out.page = { servers: page.servers, activeIndex: page.activeIndex }
    out.ok = true
    ' Not on yet: the tabs are known, but there is no stream worth a slot or an embed chain.
    if e.live <> true then return out
    if not isStr(preferred) then preferred = ""

    pick = invalid
    viaPool = false
    if not premium
        ' A device that will start on a premium tab gains nothing from a free resolve, and a slow
        ' embed host would only hold up the premium pass behind it.
        if Prefetch_premiumCapable() and Prefetch_namedPremium(page.servers) <> invalid then return out
        ' The server that worked last time, else the page's active tab, else the first free one.
        for each s in page.servers
            if s.premium <> true and preferred <> "" and s.name = preferred then pick = s
        end for
        if pick = invalid and page.servers[page.activeIndex].premium <> true then pick = page.servers[page.activeIndex]
        if pick = invalid
            for each s in page.servers
                if s.premium <> true and pick = invalid then pick = s
            end for
        end if
    else
        if not Prefetch_premiumCapable() or not Flags_onDefault(cfg, "prewarm", true) then return out
        for each s in page.servers
            if s.premium = true and preferred <> "" and s.name = preferred then pick = s
        end for
        if pick = invalid then pick = Prefetch_namedPremium(page.servers)
        if pick = invalid then return out
        r = Pool_acquire("game", Event_title(e), true)
        if r.granted <> true
            if r.ok = true
                logi("Prefetch", e.id + ": no pre-warm (" + r.used.ToStr() + "/" + r.max.ToStr() + ")")
            else
                logi("Prefetch", e.id + ": no pre-warm (" + strOr(r.error, "pool unreachable") + ")")
            end if
            return out
        end if
        out.prewarm = true
        viaPool = true
    end if
    if pick = invalid then return out

    st = Prefetch_resolveServer(cfg, pick, page, viaPool)
    out.tookMs = clock.TotalMilliseconds()
    if st.hlsUrl <> invalid
        out.key = pick.pageUrl
        out.stream = st
        tag = ""
        if pick.premium = true then tag = " (premium)"
        logi("Prefetch", e.id + ": " + pick.name + tag + " ready in " + out.tookMs.ToStr() + " ms via " + hostOf(st.hlsUrl))
    else
        logi("Prefetch", e.id + ": " + pick.name + " not playable ahead (state=" + strOr(st.state, "") + ")")
        ' Nothing to hold the slot for: HomeScreen gives a pre-warm back when `key` is missing.
    end if
    return out
end function
