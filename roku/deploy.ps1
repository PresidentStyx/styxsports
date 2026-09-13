<#
.SYNOPSIS
  Builds the Roku channel and sideloads it onto a Roku in developer mode.

.EXAMPLE
  .\deploy.ps1 -RokuIp 192.168.1.50 -Password mypass
  .\deploy.ps1 -RokuIp 192.168.1.50 -Password mypass -BuildOnly

.NOTES
  One-time setup on the Roku: press Home x3, Up x2, Right, Left, Right, Left, Right on the remote,
  enable the installer, accept the agreement, set a password, let it reboot. Write the IP down.
  Only one sideloaded channel can exist per device; deploying again replaces it.
  Debug console: telnet <RokuIp> 8085
#>
param(
    [string]$RokuIp = $env:ROKU_IP,
    [string]$Password = $env:ROKU_PASSWORD,
    [switch]$BuildOnly
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path node_modules)) {
    Write-Host "Installing build tools (first run)..."
    npm install --no-audit --no-fund | Out-Null
}

Write-Host "Validating + packaging..."
& npx bsc
if ($LASTEXITCODE -ne 0) { throw "bsc reported errors; not deploying." }
$zip = Join-Path $PSScriptRoot 'out\StyxSports.zip'
if (-not (Test-Path $zip)) { throw "Package not found at $zip" }
Write-Host ("Built {0} ({1:N0} KB)" -f $zip, ((Get-Item $zip).Length / 1KB))
# The web serves this zip at sports.styxam.com/roku so a viewer can install from a phone
# (see web/public/install.html). Deploy the Worker after building to publish the new one.
$webCopy = Join-Path $PSScriptRoot '..\web\public\StyxSports.zip'
Copy-Item $zip $webCopy -Force
Write-Host "Copied to web/public/StyxSports.zip (run 'npx wrangler deploy' in web/ to publish it)"
if ($BuildOnly) { exit 0 }

if (-not $RokuIp) { $RokuIp = Read-Host "Roku IP address" }
if (-not $Password) { $Password = Read-Host "Roku developer password" }

# The installer wants digest auth as user 'rokudev'. curl.exe ships with Windows 10+.
Write-Host "Removing the previous sideloaded channel (if any)..."
& curl.exe -s -S --digest -u "rokudev:$Password" -F "mysubmit=Delete" -F "archive=" "http://$RokuIp/plugin_install" | Out-Null

Write-Host "Installing on $RokuIp ..."
$resp = & curl.exe -s -S --digest -u "rokudev:$Password" -F "mysubmit=Install" -F "archive=@$zip" "http://$RokuIp/plugin_install"
if ($LASTEXITCODE -ne 0) { throw "Upload failed (is the Roku on, in developer mode, and is the password right?)" }
if ($resp -match 'Install Success|Identical to previous version') {
    Write-Host "Installed. The channel is launching on the Roku."
} elseif ($resp -match '<font color="red">([^<]*)</font>') {
    throw "Roku said: $($Matches[1])"
} else {
    Write-Host "Upload finished; check the TV. (Unexpected response from the installer.)"
}
Write-Host "Logs: telnet $RokuIp 8085"
