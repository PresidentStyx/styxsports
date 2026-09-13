sub init()
    m.top.functionName = "runJob"
end sub

sub runJob()
    op = m.top.op
    input = m.top.input
    if input = invalid then input = {}
    cfg = Config_load()
    out = {}

    if op = "config"
        out = { changed: Config_refresh() }

    else if op = "schedule"
        out = Site_fetch(cfg)
        if out.error = invalid
            Events_sort(out.events)
            out.ok = true
        end if

    else if op = "status"
        ' input.snapshot: refresh clocks/scores in place and hand the events back.
        s = input.snapshot
        ok = Site_refreshStatus(cfg, s)
        out = { ok: ok, events: s.events }

    else if op = "eventStatus"
        ' input.base, input.id: the live feed's entry for one game.
        json = Http_getText(input.base + cfg.parser.statusPath)
        entry = invalid
        if json <> invalid
            root = parseJsonSafe(json)
            if type(root) = "roAssociativeArray" and type(root.m) = "roAssociativeArray" then entry = root.m[input.id]
        end if
        if type(entry) = "roAssociativeArray"
            e = Event_new()
            e.id = input.id
            Parser_mergeStatus(cfg.parser, json, [e])
            out = { ok: true, live: e.live, ended: e.ended, lt: e.lt, sc: e.sc }
        else
            out = { ok: false }
        end if

    else if op = "resolvePage"
        ' input.url: the stream page's servers plus its active server resolved.
        page = Resolver_page(cfg.parser, input.url)
        if page.error <> invalid
            out = { error: page.error }
        else
            stream = Resolver_resolve(cfg.parser, page.servers[page.activeIndex], page)
            out = { ok: true, servers: page.servers, activeIndex: page.activeIndex, stream: stream }
        end if

    else if op = "resolveServer"
        ' input.server
        out = Resolver_resolve(cfg.parser, input.server, invalid)
        out.ok = (out.hlsUrl <> invalid)

    else if op = "accountStatus"
        signedIn = Account_refreshStatus(cfg)
        if signedIn and (input.force = true or Account_iptvStale()) then Account_discoverIptv(cfg)
        out = { ok: true, signedIn: signedIn, hasIptv: Account_hasIptv() }

    else if op = "accountCode"
        out = Account_requestCode(cfg)
        out.ok = (out.error = invalid)

    else if op = "accountPoll"
        out = Account_poll(cfg, input.code)
        out.ok = true

    else if op = "accountComplete"
        err = Account_completeSignIn(cfg, input.token)
        out = { ok: (err = ""), error: err, hasIptv: Account_hasIptv() }

    else if op = "accountSignOut"
        Account_signOut(cfg)
        out = { ok: true }

    else if op = "iptvLoad"
        ' input.force: refresh even when the cache is fresh.
        idx = Iptv_cachedIndex()
        if idx = invalid or input.force = true or not Iptv_isFresh(idx)
            if Account_playlistUrl() = "" then Account_discoverIptv(cfg)
            fresh = Iptv_fetch()
            if fresh.error = invalid
                idx = fresh
            else if idx = invalid
                out = { error: fresh.error }
            else
                out.warning = fresh.error
            end if
        end if
        if idx <> invalid
            out.ok = true
            out.index = idx
        end if

    else
        out = { error: "unknown op " + op }
    end if

    if out.ok = invalid then out.ok = false
    m.top.result = out
end sub
