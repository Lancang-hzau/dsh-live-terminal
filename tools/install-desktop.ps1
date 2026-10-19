# Install dsh-terminal-panel into the running Desktop DSH profile.
# - builds the browser bundle first
# - links the package into ~/.dsh/profiles/desktop (official dsh plugin CLI)
# - selects the bundle in the profile manifest so the host composes it
# - polls the running Desktop host until the plugin is live
#
# It never modifies D:\DSH. Run from anywhere:  powershell -File tools\install-desktop.ps1
# Kept ASCII-only: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$pkg = Join-Path $repo 'packages\dsh-terminal-panel'
$dsh = 'D:\DSH\resources\runtime\cli\bin\dsh.cmd'
$base = 'http://127.0.0.1:58966'

Write-Host '[1/4] building client bundle'
node (Join-Path $repo 'tools\build-client.mjs')

Write-Host '[2/4] linking package into the desktop profile'
& $dsh plugin --profile desktop add $pkg
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed with exit code $LASTEXITCODE" }

Write-Host '[3/4] selecting the bundle in the profile manifest'
node (Join-Path $repo 'tools\enable-desktop-bundle.mjs')

Write-Host '[4/4] waiting for the running Desktop host to load the plugin (HMR)'
$deadline = (Get-Date).AddSeconds(75)
$live = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-WebRequest -Uri "$base/plugins/dsh-terminal-panel/client.js" -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -eq 200) {
      try {
        $r2 = Invoke-WebRequest -Uri "$base/dsh-terminal-panel/sessions" -UseBasicParsing -TimeoutSec 5
        Write-Host "  auth route answered $($r2.StatusCode)"
      } catch {
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode } else { $code = 0 }
        if ($code -eq 401 -or $code -eq 403) {
          $live = $true
          Write-Host "  plugin routes are live (auth returned $code as expected)"
          break
        }
        Write-Host "  waiting for routes ($code) ..."
      }
    }
  } catch {
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode } else { $code = 'ERR' }
    Write-Host "  client bundle not served yet ($code) ..."
  }
}

if ($live) {
  Write-Host ''
  Write-Host 'SUCCESS: dsh-terminal-panel is live in the Desktop host.'
  Write-Host 'If the panel is not visible yet, refresh the DSH page (Ctrl+R); the right sidebar'
  Write-Host 'start page now has a "Terminal Panel" entry.'
} else {
  Write-Warning 'Plugin files are installed but the running Desktop host did not expose the routes within 75s.'
  Write-Warning 'Fully quit and reopen DeepSeek Harness, then check the right sidebar.'
  exit 2
}
