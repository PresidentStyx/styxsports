' Generated from design/tokens.json by design/build.mjs. Do not edit: change the JSON and run `node design/build.mjs`.

' Colors are 0xRRGGBBAA. Aliases are the names Ui_color() has always answered to.
function Tokens_color(name as string) as string
    if name = "bg" then return "0x0A0A0AFF"
    if name = "surface" or name = "card" or name = "pill" then return "0x171717FF"
    if name = "surfaceFocused" or name = "cardFocus" then return "0x242424FF"
    if name = "surfaceRaised" then return "0x1F1F1FFF"
    if name = "outline" or name = "line" then return "0x262626FF"
    if name = "outlineStrong" then return "0x343434FF"
    if name = "text" then return "0xF5F5F5FF"
    if name = "textSecondary" then return "0xDDDDDDFF"
    if name = "muted" or name = "dim" then return "0x9E9E9EFF"
    if name = "accent" or name = "focusRing" or name = "pillOn" then return "0xFFFFFFFF"
    if name = "live" then return "0xDC2626FF"
    if name = "pre" or name = "pillTime" then return "0x2E2E2EFF"
    if name = "final" then return "0x3A3A3AFF"
    if name = "halftime" then return "0xB45309FF"
    if name = "delayed" then return "0x6B7280FF"
    if name = "hot" then return "0xFB923CFF"
    if name = "gold" or name = "premium" then return "0xF5B942FF"
    if name = "ok" then return "0x22C55EFF"
    if name = "warn" then return "0xF59E0BFF"
    if name = "error" then return "0xEF4444FF"
    if name = "scrim" then return "0x000000B0"
    if name = "heroScrim" then return "0x0A0A0AE6"
    if name = "black" then return "0x000000FF"
    return "0xFFFFFFFF"
end function

function Tokens_space(name as string) as integer
    if name = "xs" then return 4
    if name = "sm" then return 8
    if name = "md" then return 12
    if name = "lg" then return 16
    if name = "xl" then return 24
    if name = "xxl" then return 32
    if name = "xxxl" then return 48
    if name = "gutter" then return 64
    return 8
end function

function Tokens_radius(name as string) as integer
    if name = "sm" then return 6
    if name = "md" then return 10
    if name = "lg" then return 14
    if name = "xl" then return 24
    if name = "pill" then return 999
    return 10
end function

function Tokens_card(name as string) as integer
    if name = "width" then return 250
    if name = "height" then return 150
    if name = "heroHeight" then return 420
    return 0
end function

' Font size in FHD pixels; weight >= 700 is bold on Roku's two-weight system font.
function Tokens_fontSize(name as string) as integer
    if name = "display" then return 56
    if name = "title" then return 36
    if name = "heading" then return 28
    if name = "body" then return 24
    if name = "caption" then return 20
    if name = "micro" then return 16
    if name = "score" then return 44
    return 24
end function

function Tokens_fontBold(name as string) as boolean
    if name = "display" then return true
    if name = "title" then return true
    if name = "heading" then return true
    if name = "body" then return false
    if name = "caption" then return false
    if name = "micro" then return false
    if name = "score" then return true
    return false
end function

' Milliseconds.
function Tokens_motion(name as string) as integer
    if name = "fast" then return 120
    if name = "base" then return 200
    if name = "slow" then return 320
    if name = "hero" then return 600
    return 200
end function

function Tokens_focusScale() as float
    return 1.06
end function
