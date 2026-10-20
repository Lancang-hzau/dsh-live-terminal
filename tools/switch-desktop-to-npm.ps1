# Switch the Desktop DSH profile from the local `link:` package to the npm release,
# or restore the local link again with -RestoreLink.
#
# IMPORTANT: DeepSeek Harness must be fully closed first. While the Desktop app
# is running it keeps the profile's node_modules/dsh-live-terminal directory
# open, so the package cannot be replaced. This script refuses to run while a
# "DeepSeek Harness" process exists.
#
# Note on junctions: a `link:` dependency is installed as a Windows junction.
# pnpm replaces packages by renaming a temp directory over the old entry, which
# fails with EPERM when the destination is an existing junction. Worse, the
# failed-install cleanup deletes top-level entries of the linked repo's .git
# (HEAD, config, index, logs, ...); this was reproduced with a temp profile and
# is what corrupted this repository's git metadata during earlier switch
# attempts. The script therefore removes the junction first (rmdir deletes only
# the reparse point; the linked repo directory is never modified) and restores
# the link if the install fails. Removing the junction first makes the install
# succeed (verified with a temp profile copy).
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
$profileDir = Join-Path $dshHome 'profiles\desktop'
$manifestPath = Join-Path $profileDir 'package.json'
$nodeModules = Join-Path $profileDir 'node_modules'
$installedPath = Join-Path $nodeModules 'dsh-live-terminal'
$linkTarget = "link:$($repoPath -replace '\\', '/')"
$target = if ($RestoreLink) { $linkTarget } else { "dsh-live-terminal@$Version" }

if ($DryRun) {
  Write-Host "target: $target"
  Write-Host "command: `"$dsh`" plugin --profile desktop add `"$target`" --registry=https://registry.npmjs.org"
  exit 0
}

$running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($running) {
  Write-Host 'DeepSeek Harness is running. Fully quit it first, then re-run this script.'
  Write-Host ("Running PIDs: " + (($running | Select-Object -ExpandProperty Id) -join ', '))
  Write-Host 'The running host keeps node_modules/dsh-live-terminal open, so it cannot be replaced.'
  exit 2
}

try {
  Write-Host '[1/4] preparing node_modules/dsh-live-terminal'
  if (Test-Path $installedPath) {
    $item = Get-Item $installedPath -Force
    if ($item.LinkType) {
      Write-Host "  removing existing $($item.LinkType) entry (the linked repo is not touched)"
      & cmd /c rmdir "$installedPath"
      if (Test-Path $installedPath) { throw "failed to remove $installedPath" }
    } else {
      Write-Host '  existing installed package is a real directory; pnpm will replace it'
    }
  } else {
    Write-Host '  no existing installed package'
  }
  # Remove temp directories left behind by earlier failed pnpm imports.
  Get-ChildItem $nodeModules -Filter 'dsh-live-terminal_tmp_*' -Directory -Force -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

  Write-Host "[2/4] setting dsh-live-terminal dependency to: $target"
  & $dsh plugin --profile desktop add $target --registry=https://registry.npmjs.org
  if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed with exit code $LASTEXITCODE" }

  Write-Host '[3/4] keeping dsh-live-terminal selected in the profile bundles'
  node (Join-Path $repo 'tools\enable-desktop-bundle.mjs')
  if ($LASTEXITCODE -ne 0) { throw "enable-desktop-bundle.mjs failed with exit code $LASTEXITCODE" }

  Write-Host '[4/4] verifying the installed package'
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

  if (-not $RestoreLink) {
    if ($isLink) { throw 'node_modules/dsh-live-terminal is still a link after the install; check the profile manually.' }
    if ($installedVersion -ne $Version) { throw "installed version $installedVersion does not match expected $Version" }
  }
} catch {
  Write-Host ''
  Write-Host ("ERROR: " + $_.Exception.Message)
  if (-not $RestoreLink) {
    Write-Host 'Restoring the local link so the Desktop profile keeps working...'
    & $dsh plugin --profile desktop add $linkTarget --registry=https://registry.npmjs.org
    Write-Host 'Restored the local link. Fix the error above and run the script again.'
  }
  exit 1
}

Write-Host ''
Write-Host 'Done. Reopen DeepSeek Harness to load the selected package.'
if (-not $RestoreLink) {
  Write-Host "Verify in Settings > Plugins that dsh-live-terminal is version $Version."
}
