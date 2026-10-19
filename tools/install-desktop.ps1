# Install dsh-live-terminal into the Desktop DSH profile from this checkout.
# - builds the browser bundle first
# - links the package into ~/.dsh/profiles/desktop (official dsh plugin CLI)
# - selects the bundle in the profile manifest so the host composes it
# - probes the running Desktop host; Desktop does not hot-load new plugins, so a
#   full restart of DeepSeek Harness is still required afterwards.
#
# It never modifies D:\DSH. Run from anywhere:  powershell -File tools\install-desktop.ps1
# Kept ASCII-only: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.
#
# -Port probes the running Desktop GUI (informational only); it defaults to the
# current Desktop port and can be overridden when the GUI picked another one.

param([int]$Port = 54877)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$pkg = $repo
$dsh = 'D:\DSH\resources\runtime\cli\bin\dsh.cmd'
$base = "http://127.0.0.1:$Port"
$oldName = 'dsh-terminal-panel'

Write-Host '[1/5] building client bundle'
node (Join-Path $repo 'tools\build-client.mjs')

Write-Host '[2/5] removing the pre-rename package name (if present)'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$desktopManifest = Join-Path $dshHome 'profiles\desktop\package.json'
if (Test-Path $desktopManifest) {
  $manifest = Get-Content $desktopManifest -Raw | ConvertFrom-Json
  if ($manifest.dependencies.PSObject.Properties.Name -contains $oldName) {
    & $dsh plugin --profile desktop remove $oldName
  }
}

Write-Host '[3/5] linking the package into the desktop profile'
& $dsh plugin --profile desktop add $pkg
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed with exit code $LASTEXITCODE" }

Write-Host '[4/5] selecting the bundle in the profile manifest'
node (Join-Path $repo 'tools\enable-desktop-bundle.mjs')

Write-Host '[5/5] probing the running Desktop host (informational)'
$deadline = (Get-Date).AddSeconds(20)
$live = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  try {
    Invoke-WebRequest -Uri "$base/dsh-terminal-panel/sessions" -UseBasicParsing -TimeoutSec 5 | Out-Null
    Write-Host '  route answered 200 unexpectedly (no cookie should be accepted)'
  } catch {
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode } else { $code = 0 }
    if ($code -eq 401 -or $code -eq 403) {
      $live = $true
      Write-Host "  plugin host routes are live (auth returned $code as expected)"
      break
    }
    Write-Host "  not loaded yet ($code); a full DSH restart is usually required"
  }
}

Write-Host ''
if ($live) {
  Write-Host 'SUCCESS: dsh-live-terminal is composed by the running Desktop host.'
} else {
  Write-Host 'Installed. Desktop DSH does not hot-load new plugins: fully quit and reopen'
  Write-Host 'DeepSeek Harness, then the right sidebar start page shows "Terminal Panel".'
}
Write-Host 'Verify after restart:  http://127.0.0.1:<gui-port>/dsh-terminal-panel/sessions'
