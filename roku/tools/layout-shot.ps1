<#
.SYNOPSIS
  Draws a picture of what the sideloaded Styx Sports channel is showing right now.

.DESCRIPTION
  Some Roku TVs (e.g. Hisense R6) return a black image from the developer screenshot utility.
  This tool asks the running channel to dump the absolute geometry of every visible node
  (ECP /input?cmd=dump -> "@@L {json}" lines on the debug console, see Ui.brs Dev_dumpTree) and
  renders those rectangles and labels with System.Drawing. Geometry, colors and truncation flags
  come from the device; only the glyph shapes are approximated.

  Labels the device reports as ellipsized are underlined in red.

.EXAMPLE
  .\tools\layout-shot.ps1 -Ip 192.168.1.254 -Out $env:TEMP\home.png
#>
param(
    [string]$Ip = $env:ROKU_IP,
    [string]$Out = "$env:TEMP\roku-layout.png",
    [int]$WaitMs = 3500,
    [switch]$KeepJson,
    [switch]$Guide,
    # Keys to inject (ECP /input?cmd=key) before the dump, e.g. -Keys down,right,OK
    [string[]]$Keys = @(),
    [int]$KeyDelayMs = 400,
    # Re-render a previously saved .jsonl (from -KeepJson) without touching the device
    [string]$FromJson = ''
)
Add-Type -AssemblyName System.Drawing

if ($FromJson) {
    $lines = Get-Content $FromJson | Where-Object { $_ -like '@@L *' }
} else {
    if (-not $Ip) { throw "Pass -Ip or set ROKU_IP" }
    # --- 1. connect to the debug console first so nothing is missed -----------------------------
    $client = [System.Net.Sockets.TcpClient]::new()
    $client.Connect($Ip, 8085)
    $stream = $client.GetStream()
    $buf = New-Object byte[] 65536
    $sb = New-Object System.Text.StringBuilder
    function Drain([int]$ms) {
        $sw = [Diagnostics.Stopwatch]::StartNew()
        while ($sw.ElapsedMilliseconds -lt $ms) {
            if ($stream.DataAvailable) {
                $n = $stream.Read($buf, 0, $buf.Length)
                if ($n -gt 0) { [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $n)) }
            } else { Start-Sleep -Milliseconds 50 }
        }
    }
    Drain 800
    [void]$sb.Clear()   # throw away the console backlog

    # --- 2. drive, then ask the channel to dump ------------------------------------------------
    $Keys = @($Keys | ForEach-Object { $_ -split ',' } | Where-Object { $_ })   # -File passes "a,b" as one string
    foreach ($k in $Keys) {
        & curl.exe -s -o NUL -X POST "http://${Ip}:8060/input?cmd=key&key=$k"
        Drain $KeyDelayMs
    }
    if ($Keys.Count -gt 0) { Drain 500; [void]$sb.Clear() }
    & curl.exe -s -o NUL -X POST "http://${Ip}:8060/input?cmd=dump"
    Drain $WaitMs
    $client.Close()
    $lines = $sb.ToString() -split "`r?`n" | Where-Object { $_ -like '@@L *' }
}
if ($lines.Count -eq 0) { throw "No layout lines received. Is the channel running and built with the dump hook?" }
$nodes = foreach ($l in $lines) { try { $l.Substring(4) | ConvertFrom-Json } catch { } }
if ($KeepJson) { $lines | Set-Content ([IO.Path]::ChangeExtension($Out, '.jsonl')) }

# --- 3. render -----------------------------------------------------------------------------------
function ToColor($c) {
    # Roku colors are 0xRRGGBBAA; the dump delivers them as signed 32-bit ints (or hex strings).
    if ($null -eq $c) { return [System.Drawing.Color]::FromArgb(255, 255, 255, 255) }
    if ($c -is [string]) {
        $h = $c -replace '^0x', '' -replace '^#', ''
        if ($h.Length -eq 6) { $h += 'FF' }
        $u = [Convert]::ToUInt32($h, 16)
    } else {
        $u = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int64]$c), 0)
    }
    $r = ($u -shr 24) -band 0xFF; $g = ($u -shr 16) -band 0xFF; $b = ($u -shr 8) -band 0xFF; $a = $u -band 0xFF
    return [System.Drawing.Color]::FromArgb($a, $r, $g, $b)
}
function Brush($color) { return [System.Drawing.SolidBrush]::new($color) }
function Pen($color, [float]$width) { return [System.Drawing.Pen]::new($color, $width) }

# The channel's own fonts (pkg:/fonts/Roboto-*.ttf) so text measures like it does on the device.
$rokuRoot = Split-Path -Parent $PSScriptRoot
$fontCollection = [System.Drawing.Text.PrivateFontCollection]::new()
Get-ChildItem (Join-Path $rokuRoot 'fonts') -Filter *.ttf -ErrorAction SilentlyContinue | ForEach-Object { $fontCollection.AddFontFile($_.FullName) }
function MakeFont([string]$uri, [float]$size) {
    $family = $null
    if ($uri -match 'Roboto') { $family = $fontCollection.Families | Where-Object { $_.Name -eq 'Roboto' } | Select-Object -First 1 }
    $style = if ($uri -match 'Bold') { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
    if ($family) { return [System.Drawing.Font]::new($family, $size, $style, [System.Drawing.GraphicsUnit]::Pixel) }
    # system fonts: Roku's default face is close to a slightly condensed Segoe UI
    if (-not $uri -and $size -ge 27) { $style = [System.Drawing.FontStyle]::Bold }
    return [System.Drawing.Font]::new('Segoe UI', ($size * 0.78), $style, [System.Drawing.GraphicsUnit]::Pixel)
}

# Images: pkg:/ paths resolve into the roku/ folder; http crests are fetched once into a cache.
$imageCache = @{}
$crestDir = Join-Path $env:TEMP 'roku-crests'
New-Item -ItemType Directory -Force -Path $crestDir | Out-Null
function LoadImage([string]$uri) {
    if (-not $uri) { return $null }
    if ($imageCache.ContainsKey($uri)) { return $imageCache[$uri] }
    $img = $null
    try {
        if ($uri -like 'pkg:/*') {
            $path = Join-Path $rokuRoot ($uri.Substring(5) -replace '/', '\')
            if (Test-Path $path) { $img = [System.Drawing.Image]::FromFile($path) }
        } elseif ($uri -match '^https?://') {
            $sha = [System.Security.Cryptography.SHA1]::Create()
            $name = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($uri))) -replace '-', '').Substring(0, 24)
            $path = Join-Path $crestDir "$name.img"
            if (-not (Test-Path $path)) {
                try { Invoke-WebRequest -Uri $uri -OutFile $path -TimeoutSec 8 -UseBasicParsing -ErrorAction Stop } catch { }
            }
            if ((Test-Path $path) -and (Get-Item $path).Length -gt 0) { $img = [System.Drawing.Image]::FromFile($path) }
        }
    } catch { $img = $null }
    $imageCache[$uri] = $img
    return $img
}
# Stretch a 9-patch (1 px marker border; black on the top row / left column = stretch region).
function DrawNinePatch($g, $img, [float]$x, [float]$y, [float]$w, [float]$h) {
    $bm = [System.Drawing.Bitmap]$img
    $iw = $bm.Width - 2; $ih = $bm.Height - 2
    $sx1 = -1; $sx2 = -1; $sy1 = -1; $sy2 = -1
    for ($i = 1; $i -le $iw; $i++) { $p = $bm.GetPixel($i, 0); if ($p.A -gt 128 -and $p.R -lt 64) { if ($sx1 -lt 0) { $sx1 = $i }; $sx2 = $i } }
    for ($i = 1; $i -le $ih; $i++) { $p = $bm.GetPixel(0, $i); if ($p.A -gt 128 -and $p.R -lt 64) { if ($sy1 -lt 0) { $sy1 = $i }; $sy2 = $i } }
    if ($sx1 -lt 0) { $sx1 = 1; $sx2 = $iw }
    if ($sy1 -lt 0) { $sy1 = 1; $sy2 = $ih }
    $srcX = @(1, $sx1, ($sx2 + 1), ($iw + 1))            # column boundaries in source
    $srcY = @(1, $sy1, ($sy2 + 1), ($ih + 1))
    $leftW = $sx1 - 1; $rightW = $iw + 1 - ($sx2 + 1); $topH = $sy1 - 1; $botH = $ih + 1 - ($sy2 + 1)
    $dstX = @($x, ($x + $leftW), ($x + $w - $rightW), ($x + $w))
    $dstY = @($y, ($y + $topH), ($y + $h - $botH), ($y + $h))
    $g.InterpolationMode = 'NearestNeighbor'
    $g.PixelOffsetMode = 'Half'
    for ($r = 0; $r -lt 3; $r++) {
        for ($c = 0; $c -lt 3; $c++) {
            $sw = $srcX[$c + 1] - $srcX[$c]; $sh = $srcY[$r + 1] - $srcY[$r]
            $dw = $dstX[$c + 1] - $dstX[$c]; $dh = $dstY[$r + 1] - $dstY[$r]
            if ($sw -le 0 -or $sh -le 0 -or $dw -le 0 -or $dh -le 0) { continue }
            $dst = [System.Drawing.RectangleF]::new($dstX[$c], $dstY[$r], $dw, $dh)
            $src = [System.Drawing.RectangleF]::new($srcX[$c], $srcY[$r], $sw, $sh)
            $g.DrawImage($img, $dst, $src, [System.Drawing.GraphicsUnit]::Pixel)
        }
    }
    $g.InterpolationMode = 'HighQualityBicubic'
    $g.PixelOffsetMode = 'Default'
}
# Poster.blendColor: multiply the image by the colour (white glyphs become gold / orange / dark).
function TintAttributes($color) {
    $m = [System.Drawing.Imaging.ColorMatrix]::new()
    $m.Matrix00 = $color.R / 255.0; $m.Matrix11 = $color.G / 255.0; $m.Matrix22 = $color.B / 255.0; $m.Matrix33 = $color.A / 255.0
    $a = [System.Drawing.Imaging.ImageAttributes]::new()
    $a.SetColorMatrix($m)
    return $a
}

$imgW = 1920; $imgH = 1080
$bmp = [System.Drawing.Bitmap]::new($imgW, $imgH)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = 'AntiAliasGridFit'
$g.Clear((ToColor '0x0A0A0AFF'))

$ellipsized = @()
$counts = @{}
$lists = @{}          # cid -> RowList / MarkupGrid line
$dx = 0; $dy = 0      # offset applied to nodes inside the current list item
$skipItem = $false
$seenItems = @{}

foreach ($n in $nodes) {
    if ($null -eq $n) { continue }
    $counts[$n.t] = 1 + [int]$counts[$n.t]

    if ($n.t -eq 'RowList' -or $n.t -eq 'MarkupGrid' -or $n.t -eq 'MarkupList') {
        if ($n.t -eq 'RowList') {
            # which row is at the top: fixedFocus keeps the focused row there; floatingFocus only
            # scrolls once the focus would leave the visible rows
            $firstRow = [int]$n.rf
            if ($n.vfs -eq 'floatingFocus') { $firstRow = [Math]::Max(0, [int]$n.rf - [int]$n.nr + 1) }
            $n | Add-Member -NotePropertyName firstRow -NotePropertyValue $firstRow -Force
        }
        if ($n.cid) { $lists[$n.cid] = $n }
        if ($n.t -eq 'RowList' -and $n.rows) {
            # row titles are drawn by the RowList itself and are not dumped; recreate them
            $first = [int]$n.firstRow
            $font = [System.Drawing.Font]::new('Segoe UI', ([float]$n.lf * 0.78), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
            for ($vr = 0; $vr -lt [int]$n.nr -and ($first + $vr) -lt $n.rows.Count; $vr++) {
                $ty = [float]$n.ty + $vr * ([float]$n.ih + [float]$n.rs) + [float]$n.lo
                $g.DrawString([string]$n.rows[$first + $vr], $font, (Brush ([System.Drawing.Color]::FromArgb(255, 242, 242, 242))), [float]$n.tx, $ty)
            }
        }
    }

    if ($n.t -eq 'Item') {
        # RowList/MarkupGrid/MarkupList items report rectangles in an internal coordinate space
        # (local for the focused row, row-relative elsewhere, parked off-screen items all at one
        # spot), so items are placed purely from the list geometry. Children are drawn by their
        # offset from the item's own rectangle, whose origin is the item's origin.
        $skipItem = $true; $dx = 0; $dy = 0
        $list = $lists[[string]$n.cid]
        if ($null -eq $list) { continue }                       # stale content in a recycled item
        $key = "$($n.cid)/$($n.row)/$($n.col)"
        if ($seenItems[$key]) { continue }
        $seenItems[$key] = $true
        if ($list.t -eq 'RowList') {
            $vr = [int]$n.row - [int]$list.firstRow
            if ($vr -lt 0 -or $vr -ge [int]$list.nr) { continue }
            $firstCol = 0
            if ([int]$n.row -eq [int]$list.rf) { $firstCol = [int]$list.rc }   # fixedFocusWrap: focused item sits first
            $vc = [int]$n.col - $firstCol
            if ($vc -lt 0) { continue }
            $cardX = [float]$list.tx + $vc * ([float]$list.iw + [float]$list.is)
            if ($cardX -ge [float]$list.tx + [float]$list.iwTotal) { continue }   # clipped by the RowList
            $cardY = [float]$list.ty + $vr * ([float]$list.ih + [float]$list.rs) + ([float]$list.lo + [float]$list.lf - 2)
        } else {
            $nc = [Math]::Max(1, [int]$list.nc)
            $r = [Math]::Floor([int]$n.col / $nc); $c = [int]$n.col % $nc
            $focusRow = [Math]::Floor([int]$list.fi / $nc)
            $first = [Math]::Max(0, $focusRow - [int]$list.nr + 1)
            if ($r -lt $first -or $r -ge $first + [int]$list.nr) { continue }
            $cardX = [float]$list.tx + $c * ([float]$list.iw + [float]$list.sx)
            $cardY = [float]$list.ty + ($r - $first) * ([float]$list.ih + [float]$list.sy)
        }
        $dx = $cardX - [float]$n.x
        $dy = $cardY - [float]$n.y
        $skipItem = $false
        continue
    }
    if ($skipItem) { continue }

    $x = [float]$n.x + $dx; $y = [float]$n.y + $dy; $w = [float][Math]::Max(0, $n.w); $h = [float][Math]::Max(0, $n.h)
    if ($y -ge $imgH -or $x -ge $imgW) { continue }
    $rect = [System.Drawing.RectangleF]::new($x, $y, $w, $h)
    switch ($n.t) {
        'Rectangle' {
            $c = ToColor $n.color
            if ($c.A -gt 0) { $g.FillRectangle((Brush $c), $rect) }
        }
        'Poster' {
            if ($w -le 0 -or $h -le 0) { break }
            $img = LoadImage ([string]$n.uri)
            if ($null -eq $img) {
                # unavailable image: dashed outline (an http crest that would not download, or a bad path)
                $pen = Pen ([System.Drawing.Color]::FromArgb(140, 120, 160, 200)) 1
                $pen.DashStyle = 'Dash'
                $g.DrawRectangle($pen, $x, $y, $w, $h)
                break
            }
            if ([string]$n.uri -like '*.9.png') {
                DrawNinePatch $g $img $x $y $w $h
            } else {
                # scaleToFit: aspect-fit inside the rect, centred (Roku's default for these posters);
                # scaleToFill stretches to the rect (gradient scrims)
                if ($n.fill) { $dw = $w; $dh = $h } else {
                    $s = [Math]::Min($w / $img.Width, $h / $img.Height)
                    $dw = $img.Width * $s; $dh = $img.Height * $s
                }
                $dst = [System.Drawing.RectangleF]::new($x + ($w - $dw) / 2, $y + ($h - $dh) / 2, $dw, $dh)
                $tint = if ($n.bc) { ToColor $n.bc } else { [System.Drawing.Color]::White }
                if ($tint.ToArgb() -ne [System.Drawing.Color]::White.ToArgb()) {
                    $dstI = [System.Drawing.Rectangle]::new([int][Math]::Round($dst.X), [int][Math]::Round($dst.Y), [int][Math]::Max(1, [Math]::Round($dw)), [int][Math]::Max(1, [Math]::Round($dh)))
                    $g.DrawImage($img, $dstI, 0, 0, $img.Width, $img.Height, [System.Drawing.GraphicsUnit]::Pixel, (TintAttributes $tint))
                } else {
                    $g.DrawImage($img, $dst)
                }
            }
        }
        'Label' {
            $size = if ($n.fs) { [float]$n.fs } else { 24 }
            $font = MakeFont ([string]$n.fu) $size
            # GenericTypographic: no GDI+ side padding, so text takes the width the device measured
            $fmt = [System.Drawing.StringFormat]::new([System.Drawing.StringFormat]::GenericTypographic)
            # The device says whether the text was ellipsized; GDI's Roboto is a hair wider than
            # Roku's, so only trim when the device did (else the render would cut text that fits).
            if ($n.ell) {
                $fmt.Trimming = 'EllipsisCharacter'
                $fmt.FormatFlags = if ($n.wrap) { 0 } else { 'NoWrap' }
            } else {
                $fmt.Trimming = 'None'
                $fmt.FormatFlags = if ($n.wrap) { 'NoClip' } else { 'NoWrap, NoClip' }
                if (-not $n.wrap) {
                    $slackX = switch ($n.ha) { 'center' { $x - 20 } 'right' { $x - 40 } default { $x } }
                    $rect = [System.Drawing.RectangleF]::new($slackX, $y, ($w + 40), $h)
                }
            }
            $fmt.Alignment = switch ($n.ha) { 'center' { 'Center' } 'right' { 'Far' } default { 'Near' } }
            $fmt.LineAlignment = switch ($n.va) { 'center' { 'Center' } 'bottom' { 'Far' } default { 'Near' } }
            $g.DrawString([string]$n.text, $font, (Brush (ToColor $n.color)), $rect, $fmt)
            if ($n.ell) {
                $g.DrawLine((Pen ([System.Drawing.Color]::Red) 3), $x, ($y + $h - 2), ($x + $w), ($y + $h - 2))
                $ellipsized += "$($n.id): '$($n.text)' in $($n.w)px"
            }
        }
        default {
            # RowList / MarkupGrid / LabelList / Video: dotted outline so their bounds are visible
            $pen = Pen ([System.Drawing.Color]::FromArgb(110, 61, 139, 255)) 1
            $pen.DashStyle = 'Dot'
            if ($w -gt 0 -and $h -gt 0) { $g.DrawRectangle($pen, $x, $y, $w, $h) }
        }
    }
}
if ($Guide) {
    # safe-area guide (Roku: 5% inset)
    $guide = Pen ([System.Drawing.Color]::FromArgb(70, 255, 255, 0)) 1
    $guide.DashStyle = 'Dash'
    $g.DrawRectangle($guide, 96, 54, 1728, 972)
}
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Host ("rendered {0} nodes ({1}) -> {2}" -f $nodes.Count, (($counts.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ', '), $Out)
if ($ellipsized.Count -gt 0) {
    Write-Host "ellipsized labels (device-reported):"
    $ellipsized | Sort-Object -Unique | ForEach-Object { Write-Host "  $_" }
}
