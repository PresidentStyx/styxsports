# Generates the UI chrome the Android app draws with XML shape drawables: rounded card / chip /
# button / pill backgrounds as 9-patch PNGs (Roku Rectangles have no corner radius, Posters stretch
# 9-patches), the crest placeholder, and the glyphs Android gets from its emoji font (star, flame,
# TV) as white silhouettes that Poster.blendColor tints at runtime.
#
# Android TV renders at density 2.0 for 1080p, so every dp in HomeActivity is 2 px here.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot          # roku/
$out = Join-Path $root 'images\ui'
New-Item -ItemType Directory -Force -Path $out | Out-Null

function Rgb([string]$hex) {
    $hex = $hex.TrimStart('#')
    if ($hex.Length -eq 6) { $hex = 'FF' + $hex }
    return [System.Drawing.Color]::FromArgb([Convert]::ToInt32($hex, 16))
}

function RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    if ($d -le 0) { $p.AddRectangle([System.Drawing.RectangleF]::new($x, $y, $w, $h)); return $p }
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

# A 9-patch rounded rectangle: corners of radius r, a 4 px stretchable middle in both axes.
function NinePatch([string]$name, [int]$r, [string]$fill, [int]$stroke, [string]$strokeColor) {
    $core = 2 * $r + 4
    $bmp = New-Object System.Drawing.Bitmap ($core + 2), ($core + 2)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $path = RoundedPath 1 1 $core $core $r
    $brush = New-Object System.Drawing.SolidBrush (Rgb $fill)
    $g.FillPath($brush, $path)
    if ($stroke -gt 0) {
        $inset = $stroke / 2.0
        $sp = RoundedPath (1 + $inset) (1 + $inset) ($core - $stroke) ($core - $stroke) ([Math]::Max(0, $r - $inset))
        $pen = New-Object System.Drawing.Pen (Rgb $strokeColor), $stroke
        $g.DrawPath($pen, $sp)
        $pen.Dispose()
    }
    $g.Dispose()
    # Stretch markers: black pixels on the top row / left column over the 4 px middle.
    $black = [System.Drawing.Color]::Black
    for ($i = 0; $i -lt 4; $i++) {
        $bmp.SetPixel(1 + $r + $i, 0, $black)
        $bmp.SetPixel(0, 1 + $r + $i, $black)
    }
    $bmp.Save((Join-Path $out "$name.9.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "wrote $name.9.png (r=$r fill=$fill stroke=$stroke $strokeColor)"
}

# Android palette (res/values/colors.xml).
$surface = '#171717'; $surfaceFocused = '#242424'; $outline = '#262626'; $outlineStrong = '#343434'
$accent = '#FFFFFF'; $live = '#DC2626'; $pillTime = '#2E2E2E'

# Text-wrapping shapes are sized for the APK's font scale (Ui.brs Ui_sp / Ui_lineHeight):
# 13 sp -> 30 px text, 40 px line; 14 sp -> 33/44; 15 sp -> 35/47. Android caps a corner radius at
# half the height, so the small capsules use that.

# card_bg.xml: 12dp radius; 1dp outline, focused 3dp white on the lighter surface.
NinePatch 'card' 24 $surface 2 $outline
NinePatch 'card_focus' 24 $surfaceFocused 6 $accent
# chip_bg.xml: 18dp radius (chips are 40 + 2*12 = 64 px tall -> capsule at 32).
NinePatch 'chip' 32 $surface 2 $outlineStrong
NinePatch 'chip_selected' 32 $surfaceFocused 4 $accent
NinePatch 'chip_focus' 32 $accent 0 $accent
# button_bg.xml: 20dp radius (buttons are 40 + 2*16 = 72 px tall -> capsule at 36).
NinePatch 'button' 36 $surface 2 $outlineStrong
NinePatch 'button_focus' 36 $accent 0 $accent
# AccountActivity: 15 sp buttons padded 22x11 dp are 47 + 44 = 91 px tall (radius 20 dp = 40 px);
# the code card is surface + 1 dp strong outline with 18 dp corners; the player's HUD pill too.
NinePatch 'button_lg' 40 $surface 2 $outlineStrong
NinePatch 'button_lg_focus' 40 $accent 0 $accent
NinePatch 'panel' 36 $surface 2 $outlineStrong
# NativePlayerActivity / LiveTvActivity buttons: 14 sp bold padded 18x9 dp -> 44 + 36 = 80 px (capsule at 40).
NinePatch 'button_md' 40 $surface 2 $outlineStrong
NinePatch 'button_md_focus' 40 $accent 0 $accent
# pillBackground(): 5dp radius, live red or the neutral time grey.
NinePatch 'pill_live' 10 $live 0 $live
NinePatch 'pill_time' 10 $pillTime 0 $pillTime
# LiveTvActivity: group rows are surface (shown group: surface_focused) with 12 dp corners and no
# outline; the list/grid selector is a 3 dp white ring with 12 dp corners drawn over the item.
NinePatch 'row' 24 $surface 0 $surface
NinePatch 'row_active' 24 $surfaceFocused 0 $surfaceFocused
NinePatch 'ring' 24 '#00000000' 6 $accent
# Player HUD pills reuse the same shapes; the overlay panels are plain rectangles.

# crest_placeholder.xml: 38dp oval in the outline colour.
$bmp = New-Object System.Drawing.Bitmap 76, 76
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)
$g.FillEllipse((New-Object System.Drawing.SolidBrush (Rgb $outline)), 0, 0, 75, 75)
$g.Dispose()
$bmp.Save((Join-Path $out 'crest_placeholder.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host 'wrote crest_placeholder.png'

# Loading spinner: the Material indeterminate ring (white accent), 36 dp; BusySpinner rotates it.
$bmp = New-Object System.Drawing.Bitmap 72, 72
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 6
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawArc($pen, 5, 5, 62, 62, -90, 270)
$pen.Dispose(); $g.Dispose()
$bmp.Save((Join-Path $out 'spinner.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host 'wrote spinner.png'

# Glyphs Android draws from its emoji/symbol fonts. Rendered white at 64 px so they stay crisp when
# scaled down; Poster.blendColor tints them (gold star, orange flame, dark star on a white chip).
function Glyph([string]$name, [string]$text, [string]$fontName) {
    $size = 64
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear([System.Drawing.Color]::Transparent)
    $font = [System.Drawing.Font]::new($fontName, [float]44, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
    $g.DrawString($text, $font, [System.Drawing.Brushes]::White, [System.Drawing.RectangleF]::new(0, 0, $size, $size), $fmt)
    $g.Dispose()
    # Trim to the glyph's bounding box so the Poster sizes it like a text glyph would sit.
    $minX = $size; $minY = $size; $maxX = -1; $maxY = -1
    for ($y = 0; $y -lt $size; $y++) { for ($x = 0; $x -lt $size; $x++) {
        if ($bmp.GetPixel($x, $y).A -gt 8) {
            if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
            if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
        }
    } }
    $rect = New-Object System.Drawing.Rectangle $minX, $minY, ($maxX - $minX + 1), ($maxY - $minY + 1)
    $crop = $bmp.Clone($rect, $bmp.PixelFormat)
    $crop.Save((Join-Path $out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host "wrote $name.png ($($crop.Width)x$($crop.Height))"
    $crop.Dispose(); $bmp.Dispose()
}
Glyph 'star' ([string][char]0x2605) 'Segoe UI Symbol'
Glyph 'flame' ([char]::ConvertFromUtf32(0x1F525)) 'Segoe UI Emoji'
Glyph 'tv' ([char]::ConvertFromUtf32(0x1F4FA)) 'Segoe UI Emoji'
Glyph 'tri_l' ([string][char]0x25C0) 'Segoe UI Symbol'
Glyph 'tri_r' ([string][char]0x25B6) 'Segoe UI Symbol'

# Player HUD scrims: GradientDrawable 0xCC000000 -> transparent, top-down and bottom-up. Drawn as
# 8x256 strips that the Poster stretches (scaleToFill) over the HUD's height.
function Scrim([string]$name, [bool]$topDown) {
    $bmp = New-Object System.Drawing.Bitmap 8, 256
    for ($y = 0; $y -lt 256; $y++) {
        $t = $y / 255.0
        if (-not $topDown) { $t = 1 - $t }
        $a = [int][Math]::Round(204 * (1 - $t))
        $c = [System.Drawing.Color]::FromArgb($a, 0, 0, 0)
        for ($x = 0; $x -lt 8; $x++) { $bmp.SetPixel($x, $y, $c) }
    }
    $bmp.Save((Join-Path $out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "wrote $name.png"
}
Scrim 'scrim_top' $true
Scrim 'scrim_bottom' $false

# Top-bar wordmark at the Android size: 196x30 dp = 392x60 px.
$repo = Split-Path -Parent $root
$wordmark = [System.Drawing.Image]::FromFile((Join-Path $repo 'web\public\wordmark.png'))
$h = 60; $w = [int][Math]::Round($wordmark.Width * $h / $wordmark.Height)
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.Clear([System.Drawing.Color]::Transparent)
$g.DrawImage($wordmark, 0, 0, $w, $h)
$g.Dispose()
$bmp.Save((Join-Path $root 'images\wordmark.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose(); $wordmark.Dispose()
Write-Host "wrote wordmark.png ($w x $h)"
