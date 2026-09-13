' Turns a stream page into something playable (Task thread).
'
' A stream page lists its servers as tabs and embeds the active one as an iframe. The embed is a
' wrapper page around the real player page, which holds the HLS playlist URL (signed, expiring)
' in a script. Every hop is fetched with the previous page as Referer because the embed hosts
' return 403 without one, and the CDN expects the player page's origin as Referer/Origin.
' Premium servers have no iframe: the page itself carries a Clappr player whose playlist URL is
' a (reversed) base64 literal.
'
' Server: { name, pageUrl, active, premium }
' Stream: { server, hlsUrl (or invalid), playerOrigin, state }

function Resolver_ignoreSrc() as string
    return "(?i)about:blank|sso-frame|streamea\.st|chat|recaptcha|google|facebook|twitter|histats|doubleclick|adsystem"
end function

' The stream page: { servers: [...], activeIndex, html } or { error }.
function Resolver_page(p as object, streamPageUrl as string) as object
    r = Http_get(streamPageUrl)
    if not r.ok then return { error: r.error }
    servers = Resolver_parseServers(p, r.body, streamPageUrl)
    activeIndex = 0
    for i = 0 to servers.Count() - 1
        if servers[i].active then activeIndex = i
    end for
    if servers.Count() = 0
        servers.Push({ name: "Server 1", pageUrl: streamPageUrl, active: true, premium: false })
    end if
    logi("Resolver", "stream page: " + servers.Count().ToStr() + " servers, active=" + activeIndex.ToStr())
    return { servers: servers, activeIndex: activeIndex, html: r.body }
end function

function Resolver_parseServers(p as object, html as string, pageUrl as string) as object
    out = []
    for each mt in matchAll(p.serverItem, html)
        classes = strOr(mt[1], "")
        href = mt[2]
        inner = strOr(mt[3], "")
        name = htmlUnescape(firstGroup(p.serverName, inner, "")).Trim()
        if Len(name) = 0 then name = "Server " + (out.Count() + 1).ToStr()
        out.Push({
            name: name
            pageUrl: absoluteUrl(href, pageUrl)
            active: contains(classes, p.serverActiveClass)
            premium: contains(classes, p.serverProClass)
        })
    end for
    return out
end function

' Resolves one server; reuses the page HTML when it is the page's active server.
function Resolver_resolve(p as object, server as object, page as dynamic) as object
    html = invalid
    if page <> invalid and page.servers[page.activeIndex].pageUrl = server.pageUrl then html = page.html
    if html = invalid
        r = Http_get(server.pageUrl)
        if not r.ok then return { server: server, hlsUrl: invalid, playerOrigin: "", state: "", error: r.error }
        html = r.body
    end if
    return Resolver_fromHtml(p, server, html)
end function

function Resolver_fromHtml(p as object, server as object, pageHtml as string) as object
    state = firstGroup(p.playerState, pageHtml, "")
    embedUrl = Resolver_mainEmbed(p, pageHtml, server.pageUrl)
    if embedUrl = invalid
        inline = Resolver_findHls(p, pageHtml)
        if inline <> invalid
            logi("Resolver", server.name + ": inline hls on " + hostOf(inline))
            return { server: server, hlsUrl: inline, playerOrigin: originOf(server.pageUrl), state: state }
        end if
        logi("Resolver", server.name + ": no embed (state=" + state + ")")
        return { server: server, hlsUrl: invalid, playerOrigin: "", state: state }
    end if

    hopUrl = embedUrl
    hopReferer = server.pageUrl
    for depth = 0 to 3
        r = Http_get(hopUrl, hopReferer, 22000)
        if not r.ok
            ' Embed hosts are flaky: one dropped connection is not a verdict (timeouts are).
            if not contains(r.error, "timeout") then r = Http_get(hopUrl, hopReferer, 22000)
            if not r.ok
                logi("Resolver", server.name + ": hop " + depth.ToStr() + " failed: " + r.error)
                exit for
            end if
        end if
        hls = Resolver_findHls(p, r.body)
        if hls <> invalid
            logi("Resolver", server.name + ": hls at depth " + depth.ToStr() + " on " + hostOf(hopUrl))
            return { server: server, hlsUrl: hls, playerOrigin: originOf(hopUrl), state: state, embedUrl: embedUrl }
        end if
        nextUrl = Resolver_firstEmbed(p, r.body, hopUrl)
        if nextUrl = invalid
            logi("Resolver", server.name + ": dead end at " + hostOf(hopUrl))
            exit for
        end if
        hopReferer = hopUrl
        hopUrl = nextUrl
    end for
    logi("Resolver", server.name + ": embed only (no hls found)")
    return { server: server, hlsUrl: invalid, playerOrigin: "", state: state, embedUrl: embedUrl }
end function

' Playlist URL in a player page: plain first, then atob(...), then any long base64 literal that
' decodes (plain or reversed) to a playlist URL.
function Resolver_findHls(p as object, html as string) as dynamic
    plain = firstGroup(p.hlsUrl, html, invalid)
    if plain <> invalid then return jsUnescape(plain)
    viaAtob = Resolver_decodedPlaylist(p.hlsUrlBase64, html)
    if viaAtob <> invalid then return viaAtob
    return Resolver_decodedPlaylist(p.base64Literal, html)
end function

function Resolver_decodedPlaylist(pattern as string, html as string) as dynamic
    for each mt in matchAll(pattern, html)
        decoded = base64Decode(mt[1]).Trim()
        if Len(decoded) > 0
            if Resolver_isPlaylistUrl(decoded) then return decoded
            reversed = reverseStr(decoded).Trim()
            if Resolver_isPlaylistUrl(reversed) then return reversed
        end if
    end for
    return invalid
end function

function Resolver_isPlaylistUrl(s as string) as boolean
    if not startsWith(s, "http") then return false
    if not (contains(s, ".m3u8") or contains(s, "/hls")) then return false
    return not contains(s, Chr(10))
end function

' The stream page's player iframe: the configured id first, else the first off-site iframe.
function Resolver_mainEmbed(p as object, html as string, pageUrl as string) as dynamic
    ignore = re(Resolver_ignoreSrc(), "")
    byId = firstGroup(p.embedIframe, html, invalid)
    if byId <> invalid and not ignore.IsMatch(byId) then return absoluteUrl(byId, pageUrl)
    pageHost = hostOf(pageUrl)
    for each mt in matchAll(p.anyIframe, html)
        src = mt[1]
        if not isEmpty(src) and not ignore.IsMatch(src)
            absSrc = absoluteUrl(src, pageUrl)
            if hostOf(absSrc) <> pageHost then return absSrc
        end if
    end for
    return invalid
end function

function Resolver_firstEmbed(p as object, html as string, pageUrl as string) as dynamic
    ignore = re(Resolver_ignoreSrc(), "")
    for each mt in matchAll(p.anyIframe, html)
        src = mt[1]
        if not isEmpty(src) and not ignore.IsMatch(src) then return absoluteUrl(src, pageUrl)
    end for
    return invalid
end function
