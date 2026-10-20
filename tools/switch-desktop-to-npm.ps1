# Switch the Desktop DSH profile from the local `link:` package to the npm release,
# or restore the local link again with -RestoreLink.
#
# IMPORTANT: DeepSeek Harness must be fully closed first. While the Desktop app
# is running it keeps the profile's node_modules/dsh-live-terminal directory
# open, so pnpm cannot replace the link (EPERM rename). This script refuses to
# run while a "DeepSeek Harness" process exists.
#
# Usage (from the repo root, with DSH closed):
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\switch-desktop-to-npm.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\switch-desktop-to-npm.ps1 -RestoreLink
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\switch-desktop-to-npm.ps1 -Version 1.2.0
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\switch-desktop-to-npm.ps1 -DryRun
#
# Kept ASCII-only: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.

param(
  [string]$Version = '1.2.0',
  [switch]$RestoreLink,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$repoPath = (Resolve-Path $repo).Path
$dsh = 'D:\DSH\resources\runtime\cli\bin\dsh.cmd'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$manifestPath = Join-Path $dshHome 'profiles\desktop\package.json'
$installedPath = Join-Path $dshHome 'profiles\desktop\node_modules\dsh-live-terminal'

$target = if ($RestoreLink) { "link:$($repoPath -replace '\\', '/')" } else { "dsh-live-terminal@$Version" }
if ($DryRun) {
  Write-Host "target: $target"
  Write-Host "command: `"$dsh`" plugin --profile desktop add `"$target`" --registry=https://registry.npmjs.org"
  exit 0
}

$running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($running) {
  Write-Host 'DeepSeek Harness is running. Fully quit it first, then re-run this script.'
  Write-Host ("Running PIDs: " + (($running | Select-Object -ExpandProperty Id) -join ', '))
  Write-Host 'The running host keeps node_modules/dsh-live-terminal open, so pnpm cannot replace the link.'
  exit 2
}

Write-Host "[1/3] setting dsh-live-terminal dependency to: $target"
& $dsh plugin --profile desktop add $target --registry=https://registry.npmjs.org
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed with exit code $LASTEXITCODE" }

Write-Host '[2/3] keeping dsh-live-terminal selected in the profile bundles'
node (Join-Path $repo 'tools\enable-desktop-bundle.mjs')

Write-Host '[3/3] verifying the installed package'
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$dependency = $manifest.dependencies.'dsh-live-terminal'
$item = Get-Item $installedPath -Force -ErrorAction Stop
$isLink = $item.LinkType -ne $null -and $item.LinkType -ne ''
$packageJson = Join-Path $installedPath 'package.json'
$installedVersion = if (Test-Path $packageJson) { (Get-Content $packageJson -Raw -Encoding UTF8 | ConvertFrom-Json).version } else { 'missing' }
$clientBundle = Join-Path $installedPath 'lib\client.js'
$clientSha = if (Test-Path $clientBundle) { (Get-FileHash $clientBundle -Algorithm SHA256).Hash } else { 'missing' }

Write-Host "  dependency: $dependency"
Write-Host "  installed version: $installedVersion"
Write-Host "  node_modules entry is a link/junction: $isLink"
Write-Host "  client bundle sha256: $clientSha"

$expected = if ($RestoreLink) { $null } else { $Version }
if (-not $RestoreLink) {
  if ($isLink) { throw 'node_modules/dsh-live-terminal is still a link (pnpm may not have finished); check the profile manually.' }
  if ($installedVersion -ne $expected) { throw "installed version $installedVersion does not match expected $expected" }
}

Write-Host ''
Write-Host 'Done. Reopen DeepSeek Harness to load the selected package.'
if (-not $RestoreLink) {
  Write-Host "Verify with: dsh plugin --profile desktop add is no longer needed; check Settings > Plugins for version $Version."
}
