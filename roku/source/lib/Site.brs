' Loads the event listing (Task thread): configured origin first, the previously discovered one,
' then domain discovery through the gateway page when both fail. The last good snapshot is cached
' in cachefs:/ for an instant first paint.

function Site_cachePath() as string
    return "cachefs:/snapshot.json"
end function

function Site_currentBase(cfg as object) as string
    sec = CreateObject("roRegistrySection", "site")
    if sec.Exists("base") then return sec.Read("base")
    return cfg.dataBaseUrl
end function

function Site_cached() as dynamic
    if not fileExists(Site_cachePath()) then return invalid
    s = parseJsonSafe(ReadAsciiFile(Site_cachePath()))
    if type(s) <> "roAssociativeArray" or type(s.events) <> "roArray" then return invalid
    return s
end function

' Full refresh. Returns a snapshot or {error}.
function Site_fetch(cfg as object) as object
    candidates = []
    sec = CreateObject("roRegistrySection", "site")
    if sec.Exists("base") then candidates.Push(sec.Read("base"))
    already = false
    for each c in candidates
        if c = cfg.dataBaseUrl then already = true
    end for
    if not already then candidates.Push(cfg.dataBaseUrl)

    lastError = "No events found"
    for each base in candidates
        s = Site_fetchFrom(cfg.parser, base)
        if s.error <> invalid
            lastError = s.error
        else if s.events.Count() > 0
            Site_remember(base, s)
            return s
        end if
    end for

    found = Site_discoverBase(cfg)
    if found <> "" and not arrContains(candidates, found)
        s = Site_fetchFrom(cfg.parser, found)
        if s.error = invalid and s.events.Count() > 0
            Site_remember(found, s)
            return s
        end if
    end if
    return { error: lastError }
end function

' Cheap refresh of live clocks/scores for an existing snapshot (mutates events).
function Site_refreshStatus(cfg as object, s as object) as boolean
    if isEmpty(s.base) then return false
    json = Http_getText(s.base + cfg.parser.statusPath)
    if json = invalid then return false
    Parser_mergeStatus(cfg.parser, json, s.events)
    return true
end function

function Site_fetchFrom(p as object, base as string) as object
    r = Http_get(base + "/")
    if not r.ok then return { error: r.error }
    html = r.body
    s = Parser_parseListing(p, html, base)
    if s.events.Count() = 0 then return s

    seen = {}
    for each e in s.events
        seen[e.id] = true
    end for

    ' "Load more" batches through the AJAX endpoint.
    for each sm in Parser_parseShowMore(p, html)
        i = 0
        while i < sm.ids.Count()
            batch = []
            j = i
            while j < sm.ids.Count() and j < i + 50
                batch.Push(sm.ids[j])
                j += 1
            end while
            body = "category_id=" + sm.cat.ToStr() + "&ids=" + joinArr(batch, ",")
            pr = Http_postForm(base + sm.endpoint, body, base + "/")
            if pr.ok
                payload = parseJsonSafe(pr.body)
                if type(payload) = "roAssociativeArray" and payload.ok = true
                    for each e in Parser_parseCards(p, strOr(payload.html, ""), base)
                        if seen[e.id] = invalid
                            seen[e.id] = true
                            s.events.Push(e)
                        end if
                    end for
                end if
            end if
            i += 50
        end while
    end for

    ' Small categories are often not inlined on the front page; their own page lists them.
    sportPaths = []
    for each mt in matchAll(p.sportPage, html)
        if not arrContains(sportPaths, mt[1]) then sportPaths.Push(mt[1])
    end for
    for each c in s.categories
        path = ""
        if c.live + c.soon > 0 and not Site_hasEvents(s, c.id) then path = Site_sportPathFor(c.name, sportPaths)
        if path <> ""
            page = Http_getText(base + path)
            if page <> invalid
                for each e in Parser_parseCards(p, page, base)
                    if e.cat = 0 then e.cat = c.id
                    if seen[e.id] = invalid
                        seen[e.id] = true
                        s.events.Push(e)
                    end if
                end for
            end if
        end if
    end for

    json = Http_getText(base + p.statusPath)
    if json <> invalid then Parser_mergeStatus(p, json, s.events)
    s.fetchedAt = nowSeconds()
    return s
end function

function Site_hasEvents(s as object, catId as integer) as boolean
    for each e in s.events
        if e.cat = catId then return true
    end for
    return false
end function

' "MLB" -> "/mlb-streams/", else the first path starting with the slug.
function Site_sportPathFor(name as string, paths as object) as string
    slug = LCase(name.Trim()).Replace(" ", "-")
    for each p in paths
        if p = "/" + slug + "-streams/" then return p
    end for
    for each p in paths
        if startsWith(p, "/" + slug) then return p
    end for
    return ""
end function

' The gateway page links to mirror domains that redirect to the current real origin.
function Site_discoverBase(cfg as object) as string
    html = Http_getText(cfg.homeUrl)
    if html = invalid then return ""
    gatewayHost = hostOf(cfg.homeUrl)
    tried = {}
    for each mt in matchAll("href=""(https?://([^""/]+)/)""", html)
        url = mt[1]
        host = LCase(mt[2])
        if host <> gatewayHost and Config_isAllowedHost(cfg, host) and tried[host] = invalid
            tried[host] = true
            landed = Http_landingOrigin(url)
            if landed <> "" and Config_isAllowedHost(cfg, hostOf(landed)) then return landed
            if tried.Count() >= 4 then exit for
        end if
    end for
    return ""
end function

sub Site_remember(base as string, s as object)
    sec = CreateObject("roRegistrySection", "site")
    sec.Write("base", base)
    sec.Flush()
    for each e in s.events
        e.Delete("_k")
    end for
    WriteAsciiFile(Site_cachePath(), FormatJson(s))
end sub

function arrContains(arr as object, v as dynamic) as boolean
    for each x in arr
        if x = v then return true
    end for
    return false
end function
