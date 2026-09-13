' Blocking HTTP with a shared, persistent cookie jar. Call from Task threads only.
'
' The site fronts its pages with a cookie-based SSO redirect chain and the premium account is a
' cookie session, so every request runs with the same jar: cookies are loaded into the transfer
' before a request and written back to the registry after it. roUrlTransfer follows redirects
' itself (collecting cookies along the way).

function Http_UA() as string
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
end function

function Http_defaultTimeoutMs() as integer
    return 12000
end function

' ---------------------------------------------------------------------------------------------
' Public API. Each returns {ok, code, body, headers, error}.
' ---------------------------------------------------------------------------------------------

function Http_get(url as string, referer = "" as string, timeoutMs = 0 as integer) as object
    return Http_request("GET", url, "", referer, timeoutMs, {})
end function

' Convenience: body text or invalid (logs the failure).
function Http_getText(url as string, referer = "" as string, timeoutMs = 0 as integer) as dynamic
    r = Http_get(url, referer, timeoutMs)
    if r.ok then return r.body
    logi("Http", "GET failed " + url + ": " + r.error)
    return invalid
end function

function Http_postForm(url as string, formBody as string, referer = "" as string) as object
    headers = {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
        "X-Requested-With": "XMLHttpRequest"
    }
    return Http_request("POST", url, formBody, referer, 0, headers)
end function

function Http_postJson(url as string, jsonBody as string) as object
    return Http_request("POST", url, jsonBody, "", 0, { "Content-Type": "application/json" })
end function

' Where a request ended up after redirects. roUrlTransfer follows them itself and never says
' where it landed, but the headers it reports include every hop's Location, so the chain can be
' replayed: each Location is resolved against the URL before it.
function Http_finalUrl(r as object, requestedUrl as string) as string
    url = requestedUrl
    if type(r.headersArray) <> "roArray" then return url
    for each h in r.headersArray
        for each k in h
            if LCase(k) = "location" and isStr(h[k]) and h[k] <> "" then url = absoluteUrl(h[k], url)
        end for
    end for
    return url
end function

' Follows the redirect chain and returns the HTML's canonical/og:url origin when the page names
' one, else the requested URL's origin. (roUrlTransfer does not expose the final URL.)
function Http_landingOrigin(url as string) as string
    r = Http_get(url)
    if not r.ok then return ""
    canon = firstGroup("<link[^>]*rel=""canonical""[^>]*href=""(https?://[^""/]+)", r.body, invalid)
    if canon = invalid then canon = firstGroup("property=""og:url""[^>]*content=""(https?://[^""/]+)", r.body, invalid)
    if canon <> invalid then return canon
    return originOf(url)
end function

' ---------------------------------------------------------------------------------------------
' Core
' ---------------------------------------------------------------------------------------------

function Http_request(method as string, url as string, body as string, referer as string, timeoutMs as integer, extraHeaders as object) as object
    result = { ok: false, code: 0, body: "", headers: {}, headersArray: [], error: "" }
    if timeoutMs <= 0 then timeoutMs = Http_defaultTimeoutMs()

    xfer = CreateObject("roUrlTransfer")
    port = CreateObject("roMessagePort")
    xfer.SetMessagePort(port)
    xfer.SetUrl(url)
    if startsWith(LCase(url), "https")
        xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
        xfer.InitClientCertificates()
    end if
    xfer.EnableEncodings(true)
    xfer.EnableCookies()
    xfer.RetainBodyOnError(true)
    xfer.AddHeader("User-Agent", Http_UA())
    xfer.AddHeader("Accept", "text/html,application/json,*/*")
    xfer.AddHeader("Accept-Language", "en-US,en;q=0.9")
    if Len(referer) > 0 then xfer.AddHeader("Referer", referer)
    for each k in extraHeaders
        xfer.AddHeader(k, extraHeaders[k])
    end for
    CookieJar_applyTo(xfer)

    started = false
    if method = "POST"
        started = xfer.AsyncPostFromString(body)
    else
        started = xfer.AsyncGetToString()
    end if
    if not started
        result.error = "could not start request"
        return result
    end if

    msg = wait(timeoutMs, port)
    if msg = invalid
        xfer.AsyncCancel()
        result.error = "timeout after " + (timeoutMs / 1000).ToStr() + "s"
        return result
    end if
    if type(msg) <> "roUrlEvent"
        result.error = "unexpected event"
        return result
    end if

    CookieJar_collectFrom(xfer)
    result.code = msg.GetResponseCode()
    result.body = msg.GetString()
    result.headers = msg.GetResponseHeaders()
    result.headersArray = msg.GetResponseHeadersArray()
    if result.code >= 200 and result.code < 300
        result.ok = true
    else if result.code > 0
        result.error = "HTTP " + result.code.ToStr() + " for " + url
    else
        result.error = msg.GetFailureReason()
        if isEmpty(result.error) then result.error = "network error " + result.code.ToStr()
    end if
    return result
end function

' ---------------------------------------------------------------------------------------------
' Cookie jar (registry section "cookies", key "jar", JSON array of Roku cookie records)
' ---------------------------------------------------------------------------------------------

' Stored jar is a plain, JSON-safe form: [{ domain, path, name, value, exp }] where exp is unix
' seconds (0 = session cookie). roUrlTransfer's own cookie records carry Expires as an roDateTime,
' which FormatJson cannot serialize, so records are normalized on the way in and rebuilt on the
' way out.
function CookieJar_load() as object
    sec = CreateObject("roRegistrySection", "cookies")
    if not sec.Exists("jar") then return []
    arr = parseJsonSafe(sec.Read("jar"))
    if type(arr) <> "roArray" then return []
    now = nowSeconds()
    out = []
    for each c in arr
        exp = toInt(c.exp)
        if exp = 0 or exp > now then out.Push(c)
    end for
    return out
end function

sub CookieJar_save(cookies as object)
    sec = CreateObject("roRegistrySection", "cookies")
    sec.Write("jar", FormatJson(cookies))
    sec.Flush()
end sub

sub CookieJar_clear()
    sec = CreateObject("roRegistrySection", "cookies")
    sec.Delete("jar")
    sec.Flush()
end sub

sub CookieJar_applyTo(xfer as object)
    jar = CookieJar_load()
    if jar.Count() = 0 then return
    records = []
    for each c in jar
        exp = toInt(c.exp)
        dt = CreateObject("roDateTime")
        if exp > 0 then dt.FromSeconds(exp) else dt.FromSeconds(nowSeconds() + 31536000)
        records.Push({ Domain: c.domain, Path: strOr(c.path, "/"), Name: c.name, Value: strOr(c.value, ""), Expires: dt })
    end for
    xfer.AddCookies(records)
end sub

' Merges the transfer's cookie cache back into the jar (same domain+path+name replaces).
sub CookieJar_collectFrom(xfer as object)
    fresh = xfer.GetCookies("", "")
    if type(fresh) <> "roArray" or fresh.Count() = 0 then return
    jar = CookieJar_load()
    for each c in fresh
        rec = CookieJar_normalize(c)
        if rec = invalid then goto nextCookie
        key = rec.domain + "|" + rec.path + "|" + rec.name
        replaced = false
        for i = 0 to jar.Count() - 1
            j = jar[i]
            jk = LCase(strOr(j.domain, "")) + "|" + strOr(j.path, "/") + "|" + strOr(j.name, "")
            if jk = key
                jar[i] = rec
                replaced = true
                exit for
            end if
        end for
        if not replaced then jar.Push(rec)
        nextCookie:
    end for
    CookieJar_save(jar)
end sub

function CookieJar_normalize(c as object) as dynamic
    name = strOr(c.Name, "")
    if name = "" then return invalid
    exp = 0
    if c.Expires <> invalid
        if type(c.Expires) = "roDateTime"
            exp = c.Expires.AsSeconds()
        else
            exp = toInt(c.Expires)
        end if
    end if
    return {
        domain: LCase(strOr(c.Domain, ""))
        path: strOr(c.Path, "/")
        name: name
        value: strOr(c.Value, "")
        exp: exp
    }
end function
