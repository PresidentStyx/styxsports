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
    [switch]$KeepJson
)
if (-not $Ip) { throw "Pass -Ip or set ROKU_IP" }
Add-Type -AssemblyName System.Drawing

# --- 1. connect to the debug console first so nothing is missed ---------------------------------
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

# --- 2. ask the channel to dump ------------------------------------------------------------------
& curl.exe -s -o NUL -X POST "http://${Ip}:8060/input?cmd=dump"
Drain $WaitMs
$client.Close()

$lines = $sb.ToString() -split "`r?`n" | Where-Object { $_ -like '@@L *' }
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

    if ($n.t -eq 'RowList' -or $n.t -eq 'MarkupGrid') {
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
        # RowList/MarkupGrid items report rectangles in an internal coordinate space (local for the
        # focused row, row-relative elsewhere, parked off-screen items all at one spot), so items
        # are placed purely from the list geometry. Children are drawn by their offset from the
        # item's own rectangle (which starts at the -4,-4 focus ring).
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
        # item rect origin is the ring at (-4,-4) relative to the card origin
        $dx = $cardX - ([float]$n.x + 4)
        $dy = $cardY - ([float]$n.y + 4)
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
            $pen = Pen ([System.Drawing.Color]::FromArgb(140, 120, 160, 200)) 1
            $pen.DashStyle = 'Dash'
            if ($n.ls -eq 'ready') { $g.FillRectangle((Brush ([System.Drawing.Color]::FromArgb(60, 120, 160, 200))), $rect) }
            if ($w -gt 0 -and $h -gt 0) { $g.DrawRectangle($pen, $x, $y, $w, $h) }
        }
        'Label' {
            $size = if ($n.fs) { [float]$n.fs } else { 24 }
            # system font uris come back empty; the channel only uses bold faces for sizes >= 27
            $style = if (($n.fu -match 'Bold') -or ($size -ge 27 -and $n.id -ne 'status')) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
            $font = [System.Drawing.Font]::new('Segoe UI', ($size * 0.78), $style, [System.Drawing.GraphicsUnit]::Pixel)
            $fmt = [System.Drawing.StringFormat]::new()
            $fmt.Trimming = 'EllipsisCharacter'
            if (-not $n.wrap) { $fmt.FormatFlags = 'NoWrap' }
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
# safe-area guide (Roku: 5% inset)
$guide = Pen ([System.Drawing.Color]::FromArgb(70, 255, 255, 0)) 1
$guide.DashStyle = 'Dash'
$g.DrawRectangle($guide, 96, 54, 1728, 972)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Host ("rendered {0} nodes ({1}) -> {2}" -f $nodes.Count, (($counts.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ', '), $Out)
if ($ellipsized.Count -gt 0) {
    Write-Host "ellipsized labels (device-reported):"
    $ellipsized | Sort-Object -Unique | ForEach-Object { Write-Host "  $_" }
}
