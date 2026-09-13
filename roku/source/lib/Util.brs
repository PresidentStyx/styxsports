' Small, thread-safe helpers shared by screens and tasks.

' ---------------------------------------------------------------------------------------------
' Strings
' ---------------------------------------------------------------------------------------------

function isStr(v as dynamic) as boolean
    return type(v) = "String" or type(v) = "roString"
end function

function strOr(v as dynamic, fallback as string) as string
    if isStr(v) then return v
    return fallback
end function

function isEmpty(s as dynamic) as boolean
    return not isStr(s) or Len(s) = 0
end function

function startsWith(s as string, prefix as string) as boolean
    if Len(prefix) > Len(s) then return false
    return Left(s, Len(prefix)) = prefix
end function

function endsWith(s as string, suffix as string) as boolean
    if Len(suffix) > Len(s) then return false
    return Right(s, Len(suffix)) = suffix
end function

function contains(s as string, needle as string) as boolean
    return Instr(1, s, needle) > 0
end function

function trimStr(s as dynamic) as string
    if not isStr(s) then return ""
    return s.Trim()
end function

function replaceAll(s as string, find as string, repl as string) as string
    if Len(find) = 0 then return s
    return s.Replace(find, repl)
end function

function toInt(v as dynamic) as integer
    if type(v) = "roInt" or type(v) = "Integer" or type(v) = "roInteger" then return v
    if type(v) = "roFloat" or type(v) = "Float" or type(v) = "Double" or type(v) = "roDouble" then return Int(v)
    if isStr(v)
        t = v.Trim()
        if Len(t) = 0 then return 0
        if CreateObject("roRegex", "^-?\d+$", "").IsMatch(t) then return t.ToInt()
    end if
    return 0
end function

' Unix seconds as a double-ish value; the site's data-time fits in a 32-bit int until 2038.
function toLong(v as dynamic) as integer
    return toInt(v)
end function

function nowSeconds() as integer
    return CreateObject("roDateTime").AsSeconds()
end function

function nowMillis() as longinteger
    dt = CreateObject("roDateTime")
    return CDbl(dt.AsSeconds()) * 1000 + dt.GetMilliseconds()
end function

function padZero(n as integer) as string
    if n < 10 then return "0" + n.ToStr()
    return n.ToStr()
end function

function reverseStr(s as string) as string
    out = ""
    for i = Len(s) to 1 step -1
        out += Mid(s, i, 1)
    end for
    return out
end function

function joinArr(parts as object, sep as string) as string
    out = ""
    for each p in parts
        if Len(out) > 0 then out += sep
        out += p
    end for
    return out
end function

function urlEncode(s as string) as string
    return CreateObject("roUrlTransfer").Escape(s)
end function

' ---------------------------------------------------------------------------------------------
' Regex helpers (PCRE via roRegex). Patterns come from ParserRules and are Java/PCRE compatible.
' ---------------------------------------------------------------------------------------------

function re(pattern as string, flags = "s" as string) as object
    ' A leading (?i) (Java style, as config.json overrides may use) becomes the "i" flag.
    if startsWith(pattern, "(?i)")
        pattern = Mid(pattern, 5)
        if not contains(flags, "i") then flags += "i"
    end if
    return CreateObject("roRegex", pattern, flags)
end function

' First capture group of the first match, or fallback.
function firstGroup(pattern as string, s as string, fallback as dynamic) as dynamic
    if isEmpty(s) then return fallback
    mt = re(pattern).Match(s)
    if mt.Count() > 1 and mt[1] <> invalid then return mt[1]
    return fallback
end function

' All matches; each entry is [full, g1, g2, ...].
function matchAll(pattern as string, s as string) as object
    if isEmpty(s) then return []
    return re(pattern).MatchAll(s)
end function

' All matches with their positions: [{ m: [full, g1, ...], start, stop }] (1-based, stop = index
' just after the match). Positions come from a sequential Instr on the full match text, which is
' portable (roRegex exposes no offsets).
function matchSpans(pattern as string, s as string) as object
    out = []
    cursor = 1
    for each mt in matchAll(pattern, s)
        full = mt[0]
        if full <> invalid and Len(full) > 0
            at = Instr(cursor, s, full)
            if at > 0
                out.Push({ m: mt, start: at, stop: at + Len(full) })
                cursor = at + Len(full)
            end if
        end if
    end for
    return out
end function

' name="value" pairs of an HTML tag.
function tagAttrs(tag as string) as object
    out = {}
    for each mt in matchAll("([a-zA-Z][\w-]*)=""([^""]*)""", tag)
        out[mt[1]] = mt[2]
    end for
    return out
end function

' ---------------------------------------------------------------------------------------------
' HTML / URL
' ---------------------------------------------------------------------------------------------

function htmlUnescape(s as dynamic) as string
    if not isStr(s) then return ""
    if Instr(1, s, "&") = 0 then return s
    r = s.Replace("&amp;", "&").Replace("&quot;", Chr(34)).Replace("&#039;", "'").Replace("&#39;", "'")
    r = r.Replace("&apos;", "'").Replace("&lt;", "<").Replace("&gt;", ">").Replace("&nbsp;", " ")
    for each mt in matchAll("&#(\d+);", r)
        r = r.Replace(mt[0], Chr(mt[1].ToInt()))
    end for
    return r
end function

' Undoes JSON/JS string escaping: \u0026 -> &, \/ -> /.
function jsUnescape(s as string) as string
    r = s
    for each mt in matchAll("\\u([0-9a-fA-F]{4})", r)
        r = r.Replace(mt[0], Chr(hexToInt(mt[1])))
    end for
    return r.Replace("\/", "/")
end function

function hexToInt(h as string) as integer
    return Val(h, 16)
end function

function hostOf(url as dynamic) as string
    if not isStr(url) then return ""
    mt = re("^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#:]+)", "").Match(url)
    if mt.Count() > 1 and mt[1] <> invalid then return LCase(mt[1])
    return ""
end function

function originOf(url as dynamic) as string
    if not isStr(url) then return ""
    mt = re("^([a-zA-Z][a-zA-Z0-9+.-]*://[^/?#]+)", "").Match(url)
    if mt.Count() > 1 and mt[1] <> invalid then return mt[1]
    return ""
end function

function stripTrailingSlash(s as string) as string
    if endsWith(s, "/") then return Left(s, Len(s) - 1)
    return s
end function

' Absolute URL from an href on a page at baseUrl (an origin or a full page URL).
function absoluteUrl(href as dynamic, baseUrl as string) as string
    h = htmlUnescape(href).Trim()
    if Len(h) = 0 then return ""
    if startsWith(h, "http://") or startsWith(h, "https://") then return h
    if startsWith(h, "//") then return "https:" + h
    origin = originOf(baseUrl)
    if Len(origin) = 0 then origin = stripTrailingSlash(baseUrl)
    if startsWith(h, "/") then return origin + h
    if startsWith(h, "?") or startsWith(h, "#")
        q = Instr(1, baseUrl, "?")
        if q > 0 then return Left(baseUrl, q - 1) + h
        return baseUrl + h
    end if
    ' relative path: resolve against the page's directory
    pathStart = Len(origin) + 1
    path = Mid(baseUrl, pathStart)
    q = Instr(1, path, "?")
    if q > 0 then path = Left(path, q - 1)
    slash = 0
    for i = Len(path) to 1 step -1
        if Mid(path, i, 1) = "/"
            slash = i
            exit for
        end if
    end for
    if slash = 0 then return origin + "/" + h
    return origin + Left(path, slash) + h
end function

' ---------------------------------------------------------------------------------------------
' Files
' ---------------------------------------------------------------------------------------------

' roFileSystem is a MAIN/TASK-only component, so it cannot be used on the render thread. The
' global MatchFiles works everywhere; split the path into dir + name and look for the name.
function fileExists(path as string) as boolean
    slash = 0
    for i = Len(path) to 1 step -1
        if Mid(path, i, 1) = "/"
            slash = i
            exit for
        end if
    end for
    if slash = 0 then return false
    dir = Left(path, slash)
    name = Mid(path, slash + 1)
    ' MatchFiles treats * ? [ ] as special; our names are plain, but escape just in case.
    pattern = ""
    for i = 1 to Len(name)
        ch = Mid(name, i, 1)
        if ch = "*" or ch = "?" or ch = "[" or ch = "]" then pattern += "\" + ch else pattern += ch
    end for
    for each f in MatchFiles(dir, pattern)
        if f = name then return true
    end for
    return false
end function

' ---------------------------------------------------------------------------------------------
' JSON / base64
' ---------------------------------------------------------------------------------------------

function parseJsonSafe(s as dynamic) as dynamic
    if not isStr(s) or Len(s) = 0 then return invalid
    return ParseJson(s)
end function

function base64Decode(s as string) as string
    ba = CreateObject("roByteArray")
    ba.FromBase64String(s)
    if ba.Count() = 0 then return ""
    return ba.ToAsciiString()
end function

' ---------------------------------------------------------------------------------------------
' Logging (prints show up on the Roku debug console, telnet port 8085)
' ---------------------------------------------------------------------------------------------

sub logi(tag as string, msg as dynamic)
    print "[" + tag + "] "; msg
end sub
