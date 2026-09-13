# Generates the Roku channel artwork (channel-store tile, splash screens, in-app wordmark) from the
# web version's wordmark/icon so all three apps share one look. Run from anywhere; needs Windows.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot          # roku/
$repo = Split-Path -Parent $root                   # repo root
$out = Join-Path $root 'images'
New-Item -ItemType Directory -Force -Path $out | Out-Null

$wordmark = [System.Drawing.Image]::FromFile((Join-Path $repo 'web\public\wordmark.png'))
$bg = [System.Drawing.Color]::FromArgb(255, 10, 10, 10)

function Compose([int]$w, [int]$h, [double]$fill, [string]$path, [bool]$jpeg) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear($bg)
    $scale = [Math]::Min(($w * $fill) / $wordmark.Width, ($h * $fill) / $wordmark.Height)
    $dw = [int]($wordmark.Width * $scale); $dh = [int]($wordmark.Height * $scale)
    $g.DrawImage($wordmark, [int](($w - $dw) / 2), [int](($h - $dh) / 2), $dw, $dh)
    $g.Dispose()
    if ($jpeg) {
        $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
        $params = New-Object System.Drawing.Imaging.EncoderParameters 1
        $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]90)
        $bmp.Save($path, $codec, $params)
    } else {
        $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    $bmp.Dispose()
    Write-Host "wrote $path ($w x $h)"
}

Compose 540 405 0.78 (Join-Path $out 'mm_icon_focus_fhd.png') $false
Compose 290 218 0.78 (Join-Path $out 'mm_icon_focus_hd.png') $false
Compose 246 140 0.78 (Join-Path $out 'mm_icon_focus_sd.png') $false
Compose 1920 1080 0.42 (Join-Path $out 'splash_fhd.jpg') $true
Compose 1280 720 0.42 (Join-Path $out 'splash_hd.jpg') $true

# In-app wordmark: transparent, 52 px tall (the top bar height).
$h = 52; $w = [int]($wordmark.Width * $h / $wordmark.Height)
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.Clear([System.Drawing.Color]::Transparent)
$g.DrawImage($wordmark, 0, 0, $w, $h)
$g.Dispose()
$bmp.Save((Join-Path $out 'wordmark.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "wrote wordmark.png ($w x $h)"
$wordmark.Dispose()
