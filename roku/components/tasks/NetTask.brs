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
        ' input.server; input.viaPool: we hold a lease, so a premium tab our own session gets no
        ' player for (the site does not hand every session the same premium player) is resolved
        ' through the Worker with the shared account instead.
        out = Resolver_resolve(cfg.parser, input.server, invalid)
        if out.hlsUrl = invalid and input.server.premium = true and input.viaPool = true and out.state <> "gate" and out.state <> "warming"
            logi("Resolver", input.server.name + ": no player for this session; asking the web player")
            shared = Resolver_checked(Pool_resolveShared(input.server))
            if shared.hlsUrl <> invalid or shared.state = "warming" then out = shared
        end if
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

    else if op = "ping"
        ' Anonymous "I'm open" heartbeat for sports.styxam.com/stats. Failures are ignored.
        Http_postJson("https://sports.styxam.com/api/ping", FormatJson({ id: Pool_clientId(), platform: "roku", device: Pool_deviceName() }))
        Pool_refreshInfo() ' is an account shared, does it have Live TV
        out = { ok: true }

    else if op = "resolveShared"
        ' input.server (premium tab), through the Worker with this device's pool lease.
        out = Resolver_checked(Pool_resolveShared(input.server))
        out.ok = (out.hlsUrl <> invalid)

    else if op = "poolAcquire"
        ' input.kind ("game" | "tv"), input.label: a slot in the shared premium account's pool.
        out = Pool_acquire(strOr(input.kind, "game"), strOr(input.label, ""))

    else if op = "poolHeartbeat"
        out = Pool_heartbeat(strOr(input.label, ""))

    else if op = "poolRelease"
        out = Pool_release()

    else if op = "checkPlaylist"
        ' input.url: one fetch of a playlist from this device -> { ok, url (final), warming, code, error }.
        out = Resolver_checkPlaylist(input.url, "")

    else if op = "probe"
        ' Developer: what roUrlTransfer sees for input.url (status, headers incl. redirects, body head).
        r = Http_get(input.url)
        out = { ok: r.ok, code: r.code, error: r.error, headers: r.headers, headersArray: r.headersArray, head: Left(r.body, 300) }

    else if op = "iptvLoad"
        ' input.force: refresh even when the cache is fresh.
        idx = Iptv_cachedIndex()
        if idx = invalid or input.force = true or not Iptv_isFresh(idx)
            if Account_isSignedIn()
                if Account_playlistUrl() = "" then Account_discoverIptv(cfg)
                fresh = Iptv_fetch()
            else
                ' No account here: the shared account's list, through the Worker, with our lease.
                fresh = Pool_fetchIptv()
            end if
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
