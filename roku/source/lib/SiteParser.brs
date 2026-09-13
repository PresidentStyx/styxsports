' Extracts events from the site's listing HTML. Every match card carries its data as attributes
' (data-match-id, data-time, data-team-names, ...), which is what this reads.
'
' Event record: { id, cat, home, away, url, ts, live, ended, hot, rank, pro, league, ch, ca, lt, sc }
' Snapshot:     { fetchedAt, base, categories: [{id, name, live, soon}], events: [...] }

function Event_new() as object
    return {
        id: "", cat: 0, home: "", away: "", url: "", ts: 0
        live: false, ended: false, hot: false, rank: 0, pro: false
        league: "", ch: "", ca: "", lt: "", sc: ""
    }
end function

function Event_title(e as object) as string
    if isEmpty(e.away) then return e.home
    return e.home + " vs " + e.away
end function

function Snapshot_new(base as string) as object
    return { fetchedAt: 0, base: base, categories: [], events: [] }
end function

function Snapshot_category(s as object, id as integer) as dynamic
    for each c in s.categories
        if c.id = id then return c
    end for
    return invalid
end function

' ---------------------------------------------------------------------------------------------
' Listing page
' ---------------------------------------------------------------------------------------------

function Parser_parseListing(p as object, html as string, baseUrl as string) as object
    s = Snapshot_new(baseUrl)
    Parser_parseCategories(p, html, s)
    s.events.Append(Parser_parseCards(p, html, baseUrl))
    return s
end function

sub Parser_parseCategories(p as object, html as string, into as object)
    spans = matchSpans(p.catButton, html)
    for i = 0 to spans.Count() - 1
        a = tagAttrs(spans[i].m[0])
        cat = a["data-m-cat"]
        ' A non-numeric data-m-cat is the "All" entry.
        if isStr(cat) and re("^\d+$", "").IsMatch(cat)
            inner = ""
            endTag = Instr(spans[i].stop, html, "</button>")
            if endTag > 0 then inner = Mid(html, spans[i].stop, endTag - spans[i].stop)
            id = cat.ToInt()
            if Snapshot_category(into, id) = invalid
                into.categories.Push({
                    id: id
                    name: htmlUnescape(firstGroup(p.catLabel, inner, "Category " + cat)).Trim()
                    live: toInt(firstGroup(p.catLive, inner, "0"))
                    soon: toInt(firstGroup(p.catSoon, inner, "0"))
                })
            end if
        end if
    end for
end sub

' Every match card in an HTML fragment (a page or an AJAX payload).
function Parser_parseCards(p as object, html as string, baseUrl as string) as object
    out = []
    if isEmpty(html) then return out
    spans = matchSpans(p.cardStart, html)
    for i = 0 to spans.Count() - 1
        bodyStart = spans[i].stop
        if i + 1 < spans.Count()
            bodyEnd = spans[i + 1].start
        else
            bodyEnd = bodyStart + 6000
            if bodyEnd > Len(html) + 1 then bodyEnd = Len(html) + 1
        end if
        body = Mid(html, bodyStart, bodyEnd - bodyStart)
        e = Parser_parseCard(p, spans[i].m, body, baseUrl)
        if e <> invalid then out.Push(e)
    end for
    return out
end function

function Parser_parseCard(p as object, tagMatch as object, body as string, baseUrl as string) as dynamic
    classes = strOr(tagMatch[1], "")
    a = tagAttrs(strOr(tagMatch[2], ""))

    e = Event_new()
    e.id = firstNonEmpty(a[p.attrId], a[p.attrIdAlt])
    e.cat = toInt(a[p.attrCategory])
    e.ts = toLong(a[p.attrTime])
    e.live = contains(classes, p.liveClass)
    e.hot = contains(classes, p.hotClass) or a[p.attrHot] = "1"
    e.rank = toInt(a[p.attrHotRank])
    e.pro = a[p.attrPro] = "1"
    e.league = firstNonEmpty(a[p.attrLeague], a[p.attrLeagueAlt])

    names = htmlUnescape(a[p.attrTeams])
    if Len(names) > 0
        bar = Instr(1, names, "|")
        if bar > 0
            e.home = Left(names, bar - 1).Trim()
            e.away = Mid(names, bar + 1).Trim()
        else
            e.home = names.Trim()
        end if
    end if

    href = strOr(a["href"], "")
    if Len(href) = 0 then href = firstGroup(p.cardLink, body, "")
    if Len(href) = 0 then return invalid
    e.url = absoluteUrl(href, baseUrl)

    if Len(e.home) = 0 then e.home = htmlUnescape(firstGroup(p.cardTitle, body, "")).Trim()
    if Len(e.home) = 0 then e.home = htmlUnescape(firstGroup("aria-label=""([^""]+)""", body, "")).Trim()
    if Len(e.home) = 0 then return invalid
    if Len(e.id) = 0 then e.id = e.url

    e.ch = absoluteUrl(a[p.attrMarkHome], baseUrl)
    e.ca = absoluteUrl(a[p.attrMarkAway], baseUrl)

    e.lt = htmlUnescape(firstGroup(p.liveText, body, "")).Trim()
    if Len(e.lt) > 0 and re(p.endedText).IsMatch(e.lt)
        e.ended = true
        e.live = false
    end if
    hs = trimStr(firstGroup(p.homeScore, body, ""))
    as_ = trimStr(firstGroup(p.awayScore, body, ""))
    if Len(hs) > 0 and Len(as_) > 0 then e.sc = hs + " - " + as_
    return e
end function

' "Load more" controls: [{cat, endpoint, ids: [...]}]
function Parser_parseShowMore(p as object, html as string) as object
    out = []
    for each mt in matchAll(p.showMore, html)
        a = tagAttrs(mt[0])
        sm = { cat: toInt(a["data-category"]), endpoint: "/ajax/ajax_match_cards.php", ids: [] }
        if not isEmpty(a["data-endpoint"]) then sm.endpoint = a["data-endpoint"]
        if isStr(a["data-ids"])
            for each id in a["data-ids"].Split(",")
                t = id.Trim()
                if re("^[1-9]\d*$", "").IsMatch(t) then sm.ids.Push(t)
            end for
        end if
        if sm.ids.Count() > 0 then out.Push(sm)
    end for
    return out
end function

' Merges the live-status feed (clock + score keyed by match id) into events. Best effort.
sub Parser_mergeStatus(p as object, json as dynamic, events as object)
    root = parseJsonSafe(json)
    if type(root) <> "roAssociativeArray" or type(root.m) <> "roAssociativeArray" then return
    byId = {}
    for each e in events
        byId[e.id] = e
    end for
    ended_rx = re(p.endedText)
    for each id in root.m
        e = byId[id]
        st = root.m[id]
        if e <> invalid and type(st) = "roAssociativeArray"
            cls = strOr(st.vCls, "")
            txt = htmlUnescape(strOr(st.vTxt, "")).Trim()
            ' The feed keeps lw=true after the final whistle; the end is flagged separately.
            ended = (toInt(st.esEnd) = 1) or contains(cls, "final") or (Len(txt) > 0 and ended_rx.IsMatch(txt))
            live = (not ended) and (st.lw = true or contains(cls, "live"))
            if live or ended
                e.live = live
                e.ended = ended
                label = txt
                if ended then label = trimStr(strOr(st.endLab, txt))
                if Len(label) > 0 then e.lt = label
                sc = trimStr(strOr(st.vSc, ""))
                if Len(sc) > 0 then e.sc = sc
            end if
        end if
    end for
end sub

' ---------------------------------------------------------------------------------------------
' Helpers
' ---------------------------------------------------------------------------------------------

function firstNonEmpty(a as dynamic, b as dynamic) as string
    if not isEmpty(a) then return a
    if isStr(b) then return b
    return ""
end function

' Live first (hot rank, then start time), then upcoming by start, finished last.
function Event_sortKey(e as object) as string
    grp = "1"
    if e.ended then grp = "2"
    if e.live then grp = "0"
    rank = 999999
    if e.live and e.rank > 0 then rank = e.rank
    return grp + "|" + padLeft(rank.ToStr(), 7) + "|" + padLeft(e.ts.ToStr(), 12)
end function

function padLeft(s as string, width as integer) as string
    out = s
    while Len(out) < width
        out = "0" + out
    end while
    return out
end function

sub Events_sort(events as object)
    for each e in events
        e._k = Event_sortKey(e)
    end for
    events.SortBy("_k")
end sub
