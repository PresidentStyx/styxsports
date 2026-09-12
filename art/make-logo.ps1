# Regenerates the launcher icons and TV banner from art/styx-wordmark.png.
# Usage: powershell -ExecutionPolicy Bypass -File art\make-logo.ps1

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$res  = Join-Path $root "app\src\main\res"
$src  = Join-Path $root "art\styx-wordmark.png"

$bgTop    = [System.Drawing.Color]::FromArgb(255, 15, 23, 42)
$bgBottom = [System.Drawing.Color]::FromArgb(255, 30, 58, 138)
$accent   = [System.Drawing.Color]::FromArgb(255, 56, 189, 248)

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
    $g.TextRenderingHint  = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    return $g
}

function Draw-Tracked($g, [string]$text, $font, $brush, [single]$centerX, [single]$y, [single]$tracking) {
    $fmt = [System.Drawing.StringFormat]::GenericTypographic
    $widths = @(); $total = 0
    foreach ($ch in $text.ToCharArray()) {
        $w = $g.MeasureString([string]$ch, $font, [System.Drawing.PointF]::Empty, $fmt).Width
        $widths += $w; $total += $w
    }
    $total += $tracking * ($text.Length - 1)
    $x = $centerX - $total / 2
    for ($i = 0; $i -lt $text.Length; $i++) {
        $g.DrawString([string]$text[$i], $font, $brush, $x, $y, $fmt)
        $x += $widths[$i] + $tracking
    }
}

function Save-Png($bmp, $path) {
    New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "wrote $path"
}

# --- Launcher icon ---------------------------------------------------------------------------
function New-Icon([int]$size, [string]$out) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = New-Graphics $bmp

    $rect  = New-Object System.Drawing.Rectangle 0, 0, $size, $size
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $bgTop, $bgBottom, 45
    $r = [int]($size * 0.22)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $r * 2, $r * 2, 180, 90)
    $path.AddArc($size - $r * 2, 0, $r * 2, $r * 2, 270, 90)
    $path.AddArc($size - $r * 2, $size - $r * 2, $r * 2, $r * 2, 0, 90)
    $path.AddArc(0, $size - $r * 2, $r * 2, $r * 2, 90, 90)
    $path.CloseFigure()
    $g.FillPath($brush, $path)

    # Wordmark: 82% of width, sitting a little above centre.
    $ww = $size * 0.82; $wh = $ww / $wordAspect
    $wx = ($size - $ww) / 2; $wy = $size * 0.47 - $wh / 2
    $g.DrawImage($word, (New-Object System.Drawing.RectangleF ([single]$wx), ([single]$wy), ([single]$ww), ([single]$wh)))

    # "SPORTS" beneath in the accent colour.
    $fontPx = [single]($size * 0.13)
    $font = New-Object System.Drawing.Font('Segoe UI', $fontPx, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $ab = New-Object System.Drawing.SolidBrush $accent
    Draw-Tracked $g 'SPORTS' $font $ab ([single]($size / 2)) ([single]($wy + $wh + $size * 0.05)) ([single]($size * 0.03))

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
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $bgTop, $bgBottom, 20
    $g.FillRectangle($brush, $rect)

    $ww = $w * 0.62; $wh = $ww / $wordAspect
    $wx = ($w - $ww) / 2; $wy = $h * 0.43 - $wh / 2
    $g.DrawImage($word, (New-Object System.Drawing.RectangleF ([single]$wx), ([single]$wy), ([single]$ww), ([single]$wh)))

    # Thin accent rule then "SPORTS".
    $pen = New-Object System.Drawing.Pen $accent, ([single]($h * 0.012))
    $ruleY = [single]($wy + $wh + $h * 0.07)
    $g.DrawLine($pen, [single]($w * 0.36), $ruleY, [single]($w * 0.64), $ruleY)

    $fontPx = [single]($h * 0.12)
    $font = New-Object System.Drawing.Font('Segoe UI', $fontPx, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $ab = New-Object System.Drawing.SolidBrush $accent
    Draw-Tracked $g 'SPORTS' $font $ab ([single]($w / 2)) ([single]($ruleY + $h * 0.035)) ([single]($w * 0.02))

    $g.Dispose()
    Save-Png $bmp $out
}

New-Banner 320 180 (Join-Path $res "drawable-xhdpi\banner.png")
New-Banner 1280 720 (Join-Path $root "art\logo-banner.png")

$word.Dispose()
