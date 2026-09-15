' Remote feature flags from config.json (`features`, `minVersion`), resolved for this Roku.
' The rules are exactly those of the Worker's flags.js and the APK's Flags.java:
'   "hero": true                                  on everywhere
'   "hero": { "apk": true, "roku": false }        per platform (missing platform = false)
'   "hero": { "rollout": 25 }                     on for 25% of devices (stable per device id)
'   "hero": { "rollout": 50, "platforms": ["roku"], "minVersion": "1.2" }
' Usage: Flags_on(cfg, "hero"), with cfg from Config_load().

function Flags_platform() as string
    return "roku"
end function

' Whether a named feature is on for this device; unknown names are off.
function Flags_on(cfg as object, name as string) as boolean
    if cfg = invalid or type(cfg.features) <> "roAssociativeArray" then return false
    return Flags_eval(cfg.features[name], Pool_clientId(), Flags_version())
end function

' True when config.json's minVersion for Roku is above this channel version.
function Flags_updateRequired(cfg as object) as boolean
    if cfg = invalid or type(cfg.minVersion) <> "roAssociativeArray" then return false
    min = cfg.minVersion[Flags_platform()]
    if not isStr(min) or min = "" then return false
    return Flags_compareVersions(Flags_version(), min) < 0
end function

function Flags_version() as string
    return CreateObject("roAppInfo").GetVersion()
end function

function Flags_eval(spec as dynamic, deviceId as string, version as string) as boolean
    if type(spec) = "roBoolean" or type(spec) = "Boolean" then return spec
    if type(spec) <> "roAssociativeArray" then return false
    p = Flags_platform()
    if type(spec.platforms) = "roArray"
        listed = false
        for each x in spec.platforms
            if isStr(x) and x = p then listed = true
        end for
        if not listed then return false
    end if
    if Flags_isBool(spec[p]) and spec[p] = false then return false
    if isStr(spec.minVersion) and spec.minVersion <> "" and version <> "" and Flags_compareVersions(version, spec.minVersion) < 0 then return false
    if type(spec.rollout) = "roInt" or type(spec.rollout) = "roInteger" or type(spec.rollout) = "Integer" or type(spec.rollout) = "roFloat" or type(spec.rollout) = "Float" or type(spec.rollout) = "Double" or type(spec.rollout) = "roDouble"
        return Flags_bucket(deviceId) < spec.rollout
    end if
    if Flags_isBool(spec[p]) and spec[p] = true then return true
    if Flags_isBool(spec.enabled) then return spec.enabled
    return false
end function

function Flags_isBool(v as dynamic) as boolean
    return type(v) = "roBoolean" or type(v) = "Boolean"
end function

' Stable 0..99 bucket for a device id (same arithmetic as flags.js / Flags.java; stays well
' inside 32-bit integers).
function Flags_bucket(deviceId as string) as integer
    h = 0
    for i = 0 to Len(deviceId) - 1
        h = (h * 31 + Asc(Mid(deviceId, i + 1, 1))) mod 100003
    end for
    return h mod 100
end function

' -1, 0, 1 for dotted numeric versions ("3.9" < "3.10" < "4.0"); junk compares as 0.
function Flags_compareVersions(a as string, b as string) as integer
    pa = a.Split(".")
    pb = b.Split(".")
    n = pa.Count()
    if pb.Count() > n then n = pb.Count()
    for i = 0 to n - 1
        x = 0
        y = 0
        if i < pa.Count() then x = Flags_int(pa[i])
        if i < pb.Count() then y = Flags_int(pb[i])
        if x < y then return -1
        if x > y then return 1
    end for
    return 0
end function

function Flags_int(s as string) as integer
    t = s.Trim()
    if t = "" then return 0
    for i = 1 to Len(t)
        c = Mid(t, i, 1)
        if c < "0" or c > "9" then return 0
    end for
    return Val(t, 10)
end function
