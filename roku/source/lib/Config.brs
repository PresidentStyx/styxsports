' Remote config (the same config.json the Android app reads) with built-in defaults.
'
' Config_load() is cheap (registry) and safe on any thread; Config_refresh() fetches the latest
' JSON and must run in a Task. Parser rules are PCRE strings, group 1 = captured value, and can
' be overridden key by key from config.json's "parser" object.

function Config_url() as string
    return "https://raw.githubusercontent.com/PresidentStyx/styxsports/master/config.json"
end function

function Config_defaults() as object
    return {
        homeUrl: "https://v5.gostreameast.link/"
        dataBaseUrl: "https://v2.streameast.ga"
        authBaseUrl: "https://auth.streamea.st"
        allowedHostFragments: ["streameast", "streamea.st"]
        parser: Parser_defaults()
    }
end function

function Parser_defaults() as object
    return {
        ' --- listing page
        cardStart: "<(?:div|a)\s+class=""m-card\b([^""]*)""([^>]*)>"
        cardTitle: "m-card__title""[^>]*>([^<]*)<"
        cardLink: "class=""m-card__link""[^>]*?href=""([^""]+)"""
        liveText: "status-(?:live|final)""[^>]*>([^<]*)<"
        endedText: "(?i)^\s*(final.*|ft|full[ -]?time|ended|finished|game over)\s*$"
        homeScore: "data-split-home-score=""[^""]*""[^>]*>([^<]*)<"
        awayScore: "data-split-away-score=""[^""]*""[^>]*>([^<]*)<"
        catButton: "<button\b[^>]*class=""m-cat-band__item[^""]*""[^>]*>"
        catLabel: "m-cat-band__label"">([^<]*)<"
        catLive: "m-hud-live"">(\d+)<"
        catSoon: "m-hud-soon"">(\d+)<"
        showMore: "<button\b[^>]*class=""m-show-more""[^>]*>"
        sportPage: "href=""(/([a-z0-9-]+)-streams/)"""
        statusPath: "/data/espn_status_batch.json"
        attrId: "data-match-id"
        attrIdAlt: "data-mac-id"
        attrCategory: "data-cat-id"
        attrTime: "data-time"
        attrTeams: "data-team-names"
        attrHot: "data-hot-game"
        attrHotRank: "data-hot-rank"
        attrPro: "data-pro-only"
        attrLeague: "data-league-key"
        attrLeagueAlt: "data-sport-tag"
        attrMarkHome: "data-mark-home"
        attrMarkAway: "data-mark-away"
        liveClass: "m-card--live"
        hotClass: "m-card--hot"
        ' --- stream page
        serverItem: "<li\s+class=""se-stream\b([^""]*)""[^>]*>\s*<a[^>]*href=""([^""]+)""[^>]*>(.*?)</li>"
        serverName: "se-stream__name""[^>]*>([^<]*)<"
        serverActiveClass: "is-active"
        serverProClass: "is-pro"
        playerState: "id=""se-player-root""[^>]*data-state=""([^""]*)"""
        embedIframe: "<iframe[^>]*\bid=""iframe""[^>]*\ssrc=""([^""]+)"""
        anyIframe: "<iframe[^>]*\ssrc=""([^""]+)"""
        hlsUrl: "[""'](https?:[^""']+\.m3u8[^""']*)[""']"
        hlsUrlBase64: "atob\(\s*[""']([A-Za-z0-9+/=]{16,})[""']\s*\)"
        base64Literal: "[""']([A-Za-z0-9+/]{40,}={0,2})[""']"
        ' --- account page
        iptvUrlInput: "<input[^>]*\bid=""([^""]+)""[^>]*class=""acc-iptv-url-input""[^>]*\bvalue=""([^""]+)"""
    }
end function

' Defaults overlaid with the cached remote JSON (if any).
function Config_load() as object
    cfg = Config_defaults()
    sec = CreateObject("roRegistrySection", "config")
    if sec.Exists("json")
        remote = parseJsonSafe(sec.Read("json"))
        if type(remote) = "roAssociativeArray" then Config_apply(cfg, remote)
    end if
    return cfg
end function

sub Config_apply(cfg as object, o as object)
    if isStr(o.homeUrl) and startsWith(o.homeUrl, "http") then cfg.homeUrl = o.homeUrl
    if isStr(o.dataBaseUrl) and startsWith(o.dataBaseUrl, "http") then cfg.dataBaseUrl = stripTrailingSlash(o.dataBaseUrl)
    if isStr(o.authBaseUrl) and startsWith(o.authBaseUrl, "http") then cfg.authBaseUrl = stripTrailingSlash(o.authBaseUrl)
    if type(o.allowedHostFragments) = "roArray" and o.allowedHostFragments.Count() > 0
        cfg.allowedHostFragments = o.allowedHostFragments
    end if
    if type(o.parser) = "roAssociativeArray"
        for each k in o.parser
            v = o.parser[k]
            if isStr(v) and Len(v.Trim()) > 0 and cfg.parser[k] <> invalid then cfg.parser[k] = v.Trim()
        end for
    end if
end sub

' Fetches config.json and caches it. Returns true when something new was stored.
function Config_refresh() as boolean
    r = Http_get(Config_url())
    if not r.ok then return false
    o = parseJsonSafe(r.body)
    if type(o) <> "roAssociativeArray" then return false
    sec = CreateObject("roRegistrySection", "config")
    if sec.Exists("json") and sec.Read("json") = r.body then return false
    sec.Write("json", r.body)
    sec.Flush()
    return true
end function

function Config_isAllowedHost(cfg as object, host as string) as boolean
    h = LCase(host)
    for each frag in cfg.allowedHostFragments
        if contains(h, LCase(frag)) then return true
    end for
    return false
end function
