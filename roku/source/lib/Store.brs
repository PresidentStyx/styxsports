' Small persisted viewer state in the registry: starred teams/leagues, recently watched games
' (Continue Watching), the remembered sport chip. Any thread.

function Store_section() as object
    return CreateObject("roRegistrySection", "styx")
end function

function Store_readJson(key as string, fallback as dynamic) as dynamic
    sec = Store_section()
    if not sec.Exists(key) then return fallback
    v = parseJsonSafe(sec.Read(key))
    if v = invalid then return fallback
    return v
end function

sub Store_writeJson(key as string, v as dynamic)
    sec = Store_section()
    sec.Write(key, FormatJson(v))
    sec.Flush()
end sub

function Store_readStr(key as string, fallback as string) as string
    sec = Store_section()
    if sec.Exists(key) then return sec.Read(key)
    return fallback
end function

sub Store_writeStr(key as string, v as string)
    sec = Store_section()
    sec.Write(key, v)
    sec.Flush()
end sub

' ---------------------------------------------------------------------------------------------
' Favorites: { teams: {key: true}, leagues: {key: true} }
' ---------------------------------------------------------------------------------------------

function Fav_key(s as dynamic) as string
    return LCase(trimStr(s))
end function

function Fav_load() as object
    f = Store_readJson("favorites", invalid)
    if type(f) <> "roAssociativeArray" or f.teams = invalid or f.leagues = invalid then f = { teams: {}, leagues: {} }
    return f
end function

function Fav_isTeam(f as object, name as dynamic) as boolean
    k = Fav_key(name)
    return k <> "" and f.teams[k] = true
end function

function Fav_isLeague(f as object, league as dynamic) as boolean
    k = Fav_key(league)
    return k <> "" and f.leagues[k] = true
end function

' The event's league key, or its sport category name when the card has no league.
function Fav_leagueOf(e as object, categoryNames as object) as string
    if not isEmpty(e.league) then return e.league
    n = categoryNames[e.cat.ToStr()]
    if isStr(n) then return n
    return ""
end function

function Fav_matches(f as object, e as object, categoryNames as object) as boolean
    return Fav_isTeam(f, e.home) or Fav_isTeam(f, e.away) or Fav_isLeague(f, Fav_leagueOf(e, categoryNames))
end function

function Fav_isEmpty(f as object) as boolean
    return f.teams.Count() = 0 and f.leagues.Count() = 0
end function

' Returns the new state.
function Fav_toggleTeam(f as object, name as string) as boolean
    k = Fav_key(name)
    if k = "" then return false
    now = true
    if f.teams[k] = true
        f.teams.Delete(k)
        now = false
    else
        f.teams[k] = true
    end if
    Store_writeJson("favorites", f)
    return now
end function

function Fav_toggleLeague(f as object, league as string) as boolean
    k = Fav_key(league)
    if k = "" then return false
    now = true
    if f.leagues[k] = true
        f.leagues.Delete(k)
        now = false
    else
        f.leagues[k] = true
    end if
    Store_writeJson("favorites", f)
    return now
end function

' ---------------------------------------------------------------------------------------------
' Continue Watching: last games opened, newest first (ids + the event record)
' ---------------------------------------------------------------------------------------------

function Recent_load() as object
    r = Store_readJson("recentGames", [])
    if type(r) <> "roArray" then return []
    return r
end function

sub Recent_record(e as object)
    list = Recent_load()
    kept = []
    for each x in list
        if x.id <> e.id then kept.Push(x)
    end for
    kept.Unshift({ id: e.id, home: e.home, away: e.away, url: e.url, cat: e.cat, league: e.league, ch: e.ch, ca: e.ca, ts: e.ts, at: nowSeconds() })
    while kept.Count() > 8
        kept.Pop()
    end while
    Store_writeJson("recentGames", kept)
end sub

' ---------------------------------------------------------------------------------------------
' Remembered chip
' ---------------------------------------------------------------------------------------------

function Filter_load() as string
    return Store_readStr("filter", "")
end function

sub Filter_save(v as string)
    Store_writeStr("filter", v)
end sub
