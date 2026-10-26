#!/usr/bin/env node
/**
 * Create (or complete) the GitHub Release for the current package version and
 * upload the packed npm tarball as a release asset.
 *
 * Auth: same stored GitHub credential as `git push` (via `git credential fill`)
 * or GITHUB_TOKEN.
 *
 * Usage:
 *   node tools/create-github-release.mjs           # create release + upload tarball
 *   node tools/create-github-release.mjs --dry-run # print what would happen
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const OWNER = process.env.DSH_REPO_OWNER ?? 'Lancang-hzau'
const REPO = process.env.DSH_PLUGIN_REPO ?? 'dsh-live-terminal'
const dryRun = process.argv.includes('--dry-run')

/** Run the npm CLI without a shell (avoids quoted/escaped argument issues). */
function npm(args, options) {
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return execFileSync(process.execPath, [npmCli, ...args], options)
}

function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  const input = 'protocol=https\nhost=github.com\n\n'
  const out = execFileSync('git', ['credential', 'fill'], { input, encoding: 'utf8' })
  const match = out.match(/^password=(.+)$/m)
  if (!match) throw new Error('no stored GitHub credential; set GITHUB_TOKEN')
  return match[1].trim()
}

const token = githubToken()
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'dsh-live-terminal-release',
  'X-GitHub-Api-Version': '2022-11-28',
}

async function api(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const data = text.length > 0 ? JSON.parse(text) : undefined
  if (!res.ok) {
    const error = new Error(`${method} ${path} -> ${res.status} ${data?.message ?? text.slice(0, 300)}`)
    error.status = res.status
    throw error
  }
  return data
}

async function main() {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const tag = `v${pkg.version}`
  console.log(`package: ${pkg.name}@${pkg.version} (tag ${tag})`)

  let release
  try {
    release = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${tag}`)
    console.log(`release exists: ${release.html_url}`)
  } catch (error) {
    if (error.status !== 404) throw error
    if (dryRun) {
      console.log(`would create release ${tag} for ${OWNER}/${REPO}`)
      return
    }
    release = await api('POST', `/repos/${OWNER}/${REPO}/releases`, {
      tag_name: tag,
      name: tag,
      generate_release_notes: true,
      body: [
        `npm: [\`${pkg.name}@${pkg.version}\`](https://www.npmjs.com/package/${pkg.name})`,
        '',
        '### Highlights (1.2.x)',
        '',
        '- Visible right-sidebar terminal panel (xterm.js + real PTY), with a compact 32px chrome, session strip, rename/pin, follow toggle and a status bar that only appears when needed.',
        '- Agent foreground `pwsh`/`bash` commands are mirrored live (visibility measured from shell-ready), the panel auto-opens once per DSH session, and short commands stay hidden.',
        '- Readable auto-clean: success terminals close after 8s, failures after 30s; hover pauses the countdown temporarily and leaving resumes it; one-click keep pins the terminal. Closed output stays searchable in a persisted recent-command history.',
        '- 17 `live_terminal_*` tools: run/screenshot/send/read/search/wait/expect/status/signal/resize/exec/list/history/open/close/rename/export, with text/ANSI/PNG screenshots, keys/bracketed paste, cwd/shell/env, and history fallback.',
        '- Multi-client input lease (`/take-control`), replay/export, localhost port links, per-DSH-session quotas, and honest sandbox disclosure plus `requireSandbox` fallback.',
        '- UI/UX: copy selection, right-click menu, `Ctrl+F` search, history view, config dialog, global failure toasts, first-run welcome, focus management, AA contrast, narrow-sidebar and reduced-motion support.',
        '- Validation: 232/232 host tests, typecheck, deterministic client build, 16/16 real-guest UI smoke and 17/17 real-agent local acceptance.',
        '',
        '### Fixed in 1.2.2',
        '',
        '- Finished command tabs no longer get stuck as “closed but still open”: hover pauses auto-close temporarily and leaving resumes it, clicking/selecting a tab no longer pauses forever, and paused tabs show an explicit “已暂停” badge.',
        '- Close failures now reconcile the session list instead of leaving a phantom closed tab; a host terminate failure no longer turns `/close` into a 500.',
        '',
        '### Install',
        '',
        '```powershell',
        `dsh plugin --profile desktop add ${pkg.name}`,
        '```',
        '',
        'Desktop DSH loads plugins at startup: fully quit and reopen DeepSeek Harness after installing.',
      ].join('\n'),
    })
    console.log(`release created: ${release.html_url}`)
  }

  const temp = mkdtempSync(join(tmpdir(), 'dsh-release-'))
  try {
    // Build first (prepack output would pollute `npm pack --json`), then pack.
    execFileSync('node', ['tools/build-client.mjs'], { stdio: 'inherit' })
    const packed = npm(['pack', '--pack-destination', temp, '--json', '--ignore-scripts'], {
      encoding: 'utf8',
      cwd: process.cwd(),
    })
    const info = JSON.parse(packed.trim())[0]
    const tarball = join(temp, info.filename)
    console.log(`tarball: ${info.filename} (${info.size} bytes)`)

    const assets = await api('GET', `/repos/${OWNER}/${REPO}/releases/${release.id}/assets`)
    const existing = assets.find((asset) => asset.name === info.filename)
    if (existing) {
      console.log(`asset already present: ${existing.browser_download_url}`)
      return
    }
    if (dryRun) {
      console.log(`would upload asset ${info.filename}`)
      return
    }

    const body = readFileSync(tarball)
    const res = await fetch(
      `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(info.filename)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'dsh-live-terminal-release',
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(body.length),
        },
        body,
      },
    )
    const text = await res.text()
    const data = text.length > 0 ? JSON.parse(text) : undefined
    if (!res.ok) throw new Error(`upload failed: ${res.status} ${data?.message ?? text.slice(0, 300)}`)
    console.log(`asset uploaded: ${data.browser_download_url}`)
    console.log(`release: ${release.html_url}`)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
