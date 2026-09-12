# Regenerates the wordmark, launcher icons and TV banner from art/styx-wordmark.png.
# "SPORTS" is set in Bodoni Moda Black (art/fonts, OFL licence) to match the Didone "STYX" mark.
# Usage: powershell -ExecutionPolicy Bypass -File art\make-logo.ps1

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$res  = Join-Path $root "app\src\main\res"
$src  = Join-Path $root "art\styx-wordmark.png"
$fontFile = Join-Path $root "art\fonts\BodoniModa[opsz,wght].ttf"

# Neutral dark palette (matches res/values/colors.xml).
$bgTop    = [System.Drawing.Color]::FromArgb(255, 24, 24, 24)
$bgBottom = [System.Drawing.Color]::FromArgb(255, 6, 6, 6)
$white    = [System.Drawing.Color]::White

# --- Font: Bodoni Moda, heaviest instance available ------------------------------------------
$pfc = New-Object System.Drawing.Text.PrivateFontCollection
$pfc.AddFontFile($fontFile)
$family = $pfc.Families | Where-Object { $_.Name -match 'Black' } | Select-Object -First 1
if (-not $family) { $family = $pfc.Families | Where-Object { $_.Name -match 'ExtraBold|Bold' } | Select-Object -First 1 }
if (-not $family) { $family = $pfc.Families[0] }
$fontStyle = [System.Drawing.FontStyle]::Regular
if (-not $family.IsStyleAvailable($fontStyle)) { $fontStyle = [System.Drawing.FontStyle]::Bold }
Write-Host "SPORTS face: $($family.Name)"

# Pixel size that gives this face a cap height of $capPx.
function Font-ForCapHeight([single]$capPx) {
    # Bodoni Moda cap height is ~0.70 em; measure once and correct.
    $probe = New-Object System.Drawing.Font $family, 100, $fontStyle, ([System.Drawing.GraphicsUnit]::Pixel)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddString('S', $family, [int]$fontStyle, 100, [System.Drawing.PointF]::Empty, [System.Drawing.StringFormat]::GenericTypographic)
    $capAt100 = $path.GetBounds().Height
    $probe.Dispose()
    return New-Object System.Drawing.Font $family, ([single](100 * $capPx / $capAt100)), $fontStyle, ([System.Drawing.GraphicsUnit]::Pixel)
}

# --- Crop the wordmark to its opaque bounds once -------------------------------------------
$full = New-Object System.Drawing.Bitmap $src
$minX = $full.Width; $minY = $full.Height; $maxX = 0; $maxY = 0
for ($y = 0; $y -lt $full.Height; $y++) {
    for ($x = 0; $x -lt $full.Width; $x++) {
        if ($full.GetPixel($x, $y).A -gt 24) {
            if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
            if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
        }
    }
}
$cropRect = New-Object System.Drawing.Rectangle $minX, $minY, ($maxX - $minX + 1), ($maxY - $minY + 1)
$word = $full.Clone($cropRect, $full.PixelFormat)
$full.Dispose()
$wordAspect = $word.Width / $word.Height

function New-Graphics($bmp) {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.TextRenderingHint  = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    return $g
}

# Draws text as filled glyph outlines (crisper than DrawString for display sizes) with tracking.
# $y is the top of the capitals. Returns the total width.
function Draw-Caps($g, [string]$text, $font, $brush, [single]$x, [single]$y, [single]$tracking, [bool]$measureOnly = $false) {
    $fmt = [System.Drawing.StringFormat]::GenericTypographic
    $total = 0
    for ($i = 0; $i -lt $text.Length; $i++) {
        $ch = [string]$text[$i]
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $path.AddString($ch, $font.FontFamily, [int]$font.Style, $font.Size, [System.Drawing.PointF]::Empty, $fmt)
        $b = $path.GetBounds()
        if (-not $measureOnly) {
            $m = New-Object System.Drawing.Drawing2D.Matrix
            $m.Translate($x - $b.X, $y - $b.Y)
            $path.Transform($m)
            $g.FillPath($brush, $path)
        }
        $adv = $b.Width + $tracking
        $x += $adv; $total += $adv
        $path.Dispose()
    }
    return $total - $tracking
}

function Save-Png($bmp, $path) {
    New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "wrote $path"
}

# --- Full wordmark "STYX SPORTS" on transparent ---------------------------------------------
# Used in the top bar, splash and loading overlays. STYX is the source mark; SPORTS sits on the
# same baseline at ~66% of its cap height, letter-spaced.
function New-Wordmark([int]$styxHeight, [string]$out) {
    $pad = [int]($styxHeight * 0.12)
    $ww = [int]($styxHeight * $wordAspect)
    $capPx = [single]($styxHeight * 0.66)
    $font = Font-ForCapHeight $capPx
    $tracking = [single]($capPx * 0.16)
    $gap = [int]($styxHeight * 0.34)
    $probe = New-Object System.Drawing.Bitmap 8, 8
    $pg = New-Graphics $probe
    $sw = Draw-Caps $pg 'SPORTS' $font ([System.Drawing.Brushes]::White) 0 0 $tracking $true
    $pg.Dispose(); $probe.Dispose()

    $w = $pad + $ww + $gap + [int][Math]::Ceiling($sw) + $pad
    $h = $styxHeight + 2 * $pad
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = New-Graphics $bmp
    $g.DrawImage($word, (New-Object System.Drawing.Rectangle $pad, $pad, $ww, $styxHeight))
    $brush = New-Object System.Drawing.SolidBrush $white
    # The mark's serifs sit ~2% above its bottom edge; nudge SPORTS to share the baseline.
    $baseline = $pad + $styxHeight * 0.985
    Draw-Caps $g 'SPORTS' $font $brush ([single]($pad + $ww + $gap)) ([single]($baseline - $capPx)) $tracking | Out-Null
    $g.Dispose()
    Save-Png $bmp $out
}

New-Wordmark 160 (Join-Path $res "drawable-nodpi\wordmark.png")

# --- Launcher icon ---------------------------------------------------------------------------
function New-Icon([int]$size, [string]$out) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = New-Graphics $bmp

    $rect  = New-Object System.Drawing.Rectangle 0, 0, $size, $size
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $bgTop, $bgBottom, 90
    $r = [int]($size * 0.22)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $r * 2, $r * 2, 180, 90)
    $path.AddArc($size - $r * 2, 0, $r * 2, $r * 2, 270, 90)
    $path.AddArc($size - $r * 2, $size - $r * 2, $r * 2, $r * 2, 0, 90)
    $path.AddArc(0, $size - $r * 2, $r * 2, $r * 2, 90, 90)
    $path.CloseFigure()
    $g.FillPath($brush, $path)
    $edge = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(40, 255, 255, 255)), ([single][Math]::Max(1, $size * 0.01))
    $g.DrawPath($edge, $path)

    # Wordmark: 80% of width, a little above centre.
    $ww = $size * 0.80; $wh = $ww / $wordAspect
    $wx = ($size - $ww) / 2; $wy = $size * 0.46 - $wh / 2
    $g.DrawImage($word, (New-Object System.Drawing.RectangleF ([single]$wx), ([single]$wy), ([single]$ww), ([single]$wh)))

    # "SPORTS" beneath, same face, white.
    $capPx = [single]($size * 0.105)
    $font = Font-ForCapHeight $capPx
    $tracking = [single]($capPx * 0.22)
    $sw = Draw-Caps $g 'SPORTS' $font ([System.Drawing.Brushes]::White) 0 0 $tracking $true
    $wb = New-Object System.Drawing.SolidBrush $white
    Draw-Caps $g 'SPORTS' $font $wb ([single](($size - $sw) / 2)) ([single]($wy + $wh + $size * 0.06)) $tracking | Out-Null

    $g.Dispose()
    Save-Png $bmp $out
}

New-Icon 48  (Join-Path $res "mipmap-mdpi\ic_launcher.png")
New-Icon 72  (Join-Path $res "mipmap-hdpi\ic_launcher.png")
New-Icon 96  (Join-Path $res "mipmap-xhdpi\ic_launcher.png")
New-Icon 144 (Join-Path $res "mipmap-xxhdpi\ic_launcher.png")
New-Icon 192 (Join-Path $res "mipmap-xxxhdpi\ic_launcher.png")

# --- TV banner (320x180 @ xhdpi) -------------------------------------------------------------
function New-Banner([int]$w, [int]$h, [string]$out) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = New-Graphics $bmp

    $rect  = New-Object System.Drawing.Rectangle 0, 0, $w, $h
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $bgTop, $bgBottom, 90
    $g.FillRectangle($brush, $rect)

    $ww = $w * 0.56; $wh = $ww / $wordAspect
    $wx = ($w - $ww) / 2; $wy = $h * 0.42 - $wh / 2
    $g.DrawImage($word, (New-Object System.Drawing.RectangleF ([single]$wx), ([single]$wy), ([single]$ww), ([single]$wh)))

    # Thin white rule then "SPORTS" in the same face.
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(160, 255, 255, 255)), ([single][Math]::Max(1, $h * 0.008))
    $ruleY = [single]($wy + $wh + $h * 0.075)
    $g.DrawLine($pen, [single]($w * 0.40), $ruleY, [single]($w * 0.60), $ruleY)

    $capPx = [single]($h * 0.10)
    $font = Font-ForCapHeight $capPx
    $tracking = [single]($capPx * 0.25)
    $sw = Draw-Caps $g 'SPORTS' $font ([System.Drawing.Brushes]::White) 0 0 $tracking $true
    $wb = New-Object System.Drawing.SolidBrush $white
    Draw-Caps $g 'SPORTS' $font $wb ([single](($w - $sw) / 2)) ([single]($ruleY + $h * 0.05)) $tracking | Out-Null

    $g.Dispose()
    Save-Png $bmp $out
}

New-Banner 320 180 (Join-Path $res "drawable-xhdpi\banner.png")
New-Banner 1280 720 (Join-Path $root "art\logo-banner.png")

$word.Dispose()
