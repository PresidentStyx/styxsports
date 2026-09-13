' The premium account's IPTV playlist: an M3U of ~11k live channels in ~200 groups, with logos.
'
' Downloaded with the account's personal link (HLS variant: Roku's player does not take raw
' MPEG-TS), parsed on a Task thread and stored in cachefs:/ as one small group index plus one
' JSON file per group, so screens read only the group they show instead of copying 11k records
' across the thread boundary.
'
' Channel: { name, logo, group, url, tvgId }
' Group index: { fetchedAt, channelCount, groups: [{ name, count, file }] }

function Iptv_freshSeconds() as integer
    return 12 * 60 * 60
end function

function Iptv_recentGroup() as string
    return Chr(9733) + " Recently watched"
end function

function Iptv_indexPath() as string
    return "cachefs:/iptv_groups.json"
end function

function Iptv_groupPath(i as integer) as string
    return "cachefs:/iptv_g" + i.ToStr() + ".json"
end function

' ---------------------------------------------------------------------------------------------
' Cache (any thread)
' ---------------------------------------------------------------------------------------------

function Iptv_cachedIndex() as dynamic
    if not fileExists(Iptv_indexPath()) then return invalid
    idx = parseJsonSafe(ReadAsciiFile(Iptv_indexPath()))
    if type(idx) <> "roAssociativeArray" or type(idx.groups) <> "roArray" or idx.groups.Count() = 0 then return invalid
    return idx
end function

function Iptv_isFresh(idx as object) as boolean
    return nowSeconds() - toInt(idx.fetchedAt) < Iptv_freshSeconds()
end function

' Channels of one group from the index (empty array when the file is gone).
function Iptv_groupChannels(g as object) as object
    if g.name = Iptv_recentGroup() then return Iptv_recents()
    if not fileExists(g.file) then return []
    arr = parseJsonSafe(ReadAsciiFile(g.file))
    if type(arr) <> "roArray" then return []
    return arr
end function

' The index's groups with "Recently watched" first when there are any.
function Iptv_groupsWithRecent(idx as object) as object
    recent = Iptv_recents()
    if recent.Count() = 0 then return idx.groups
    out = [{ name: Iptv_recentGroup(), count: recent.Count(), file: "" }]
    out.Append(idx.groups)
    return out
end function

sub Iptv_clearCache()
    if fileExists(Iptv_indexPath())
        idx = Iptv_cachedIndex()
        if idx <> invalid
            for each g in idx.groups
                if g.file <> "" then DeleteFile(g.file)
            end for
        end if
        DeleteFile(Iptv_indexPath())
    end if
    sec = CreateObject("roRegistrySection", "iptv")
    sec.Delete("recent")
    sec.Flush()
end sub

' ---------------------------------------------------------------------------------------------
' Download + parse (Task thread). Returns the index or { error }.
' ---------------------------------------------------------------------------------------------

function Iptv_fetch() as object
    plus = Account_playlistUrl()
    if plus = "" then return { error: "This account has no IPTV playlist" }
    sep = "?"
    if contains(plus, "?") then sep = "&"
    r = Http_get(plus + sep + "output=hls", "", 60000)
    if not r.ok then return { error: r.error }
    parsed = Iptv_parse(r.body)
    if parsed.channelCount = 0 then return { error: "the playlist has no channels" }
    if parsed.hlsCount * 2 < parsed.channelCount
        logi("Iptv", "hls variant unusable (" + parsed.hlsCount.ToStr() + "/" + parsed.channelCount.ToStr() + ")")
        return { error: "the playlist's HLS links are unavailable right now" }
    end if
    Iptv_clearGroupFiles()
    idx = { fetchedAt: nowSeconds(), channelCount: parsed.channelCount, groups: [] }
    i = 0
    for each g in parsed.groups
        path = Iptv_groupPath(i)
        WriteAsciiFile(path, FormatJson(g.channels))
        idx.groups.Push({ name: g.name, count: g.channels.Count(), file: path })
        i += 1
    end for
    WriteAsciiFile(Iptv_indexPath(), FormatJson(idx))
    logi("Iptv", "playlist: " + parsed.channelCount.ToStr() + " channels in " + idx.groups.Count().ToStr() + " groups")
    return idx
end function

sub Iptv_clearGroupFiles()
    idx = Iptv_cachedIndex()
    if idx = invalid then return
    for each g in idx.groups
        if g.file <> "" then DeleteFile(g.file)
    end for
end sub

' { groups: [{name, channels}], channelCount, hlsCount }
function Iptv_parse(m3u as string) as object
    byGroup = {}
    order = []
    count = 0
    hls = 0
    ' One pass with a single regex: the #EXTINF line and the URL line that follows it.
    rx = re("#EXTINF:([^\r\n]*)[\r\n]+(https?://[^\r\n]+)", "")
    for each mt in rx.MatchAll(m3u)
        c = Iptv_channel(mt[1], mt[2].Trim())
        if c <> invalid
            if byGroup[c.group] = invalid
                byGroup[c.group] = []
                order.Push(c.group)
            end if
            byGroup[c.group].Push(c)
            count += 1
            if contains(c.url, ".m3u8") then hls += 1
        end if
    end for
    ' Sports groups first (this is a sports app), everything else in the playlist's order.
    sports = []
    rest = []
    for each name in order
        g = { name: name, channels: byGroup[name] }
        if Iptv_isSports(name) then sports.Push(g) else rest.Push(g)
    end for
    sports.Append(rest)
    return { groups: sports, channelCount: count, hlsCount: hls }
end function

function Iptv_isSports(group as string) as boolean
    g = LCase(group)
    return contains(g, "sport") or contains(g, "espn") or contains(g, "bein") or contains(g, "desport") or contains(g, "esporte") or contains(g, "dazn") or contains(g, "ppv")
end function

function Iptv_channel(extinf as string, url as string) as dynamic
    if not startsWith(url, "http") then return invalid
    comma = 0
    for i = Len(extinf) to 1 step -1
        if Mid(extinf, i, 1) = ","
            comma = i
            exit for
        end if
    end for
    name = ""
    attrsPart = extinf
    if comma > 0
        name = Mid(extinf, comma + 1).Trim()
        attrsPart = Left(extinf, comma - 1)
    end if
    logo = ""
    group = ""
    tvgId = ""
    for each a in matchAll("([A-Za-z][\w-]*)=""([^""]*)""", attrsPart)
        k = LCase(a[1])
        if k = "tvg-logo"
            logo = a[2].Trim()
        else if k = "group-title"
            group = a[2].Trim()
        else if k = "tvg-id"
            tvgId = a[2].Trim()
        else if k = "tvg-name" and name = ""
            name = a[2].Trim()
        end if
    end for
    if name = "" then name = "Channel"
    if group = "" then group = "Other"
    if not startsWith(logo, "http") then logo = ""
    return { name: name, logo: logo, group: group, url: url, tvgId: tvgId }
end function

' Strips a redundant country prefix ("US: ESPN" -> "ESPN") for the grid.
function Iptv_displayName(c as object) as string
    n = c.name
    mt = re("^[A-Z]{2,3}\s*[:|\-]\s*(.+)$", "").Match(n)
    if mt.Count() > 1 and mt[1] <> invalid and Len(mt[1]) > 1 then return mt[1]
    return n
end function

' ---------------------------------------------------------------------------------------------
' Recently watched (registry, any thread)
' ---------------------------------------------------------------------------------------------

function Iptv_recents() as object
    sec = CreateObject("roRegistrySection", "iptv")
    if not sec.Exists("recent") then return []
    arr = parseJsonSafe(sec.Read("recent"))
    if type(arr) <> "roArray" then return []
    return arr
end function

sub Iptv_recordRecent(c as object)
    list = Iptv_recents()
    kept = []
    for each x in list
        if x.url <> c.url then kept.Push(x)
    end for
    kept.Unshift({ name: c.name, logo: c.logo, group: c.group, url: c.url, tvgId: "" })
    ' The registry is small (16 KB for the whole channel), so keep this list short.
    while kept.Count() > 12
        kept.Pop()
    end while
    sec = CreateObject("roRegistrySection", "iptv")
    sec.Write("recent", FormatJson(kept))
    sec.Flush()
end sub
