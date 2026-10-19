#!/usr/bin/env node
/**
 * Open the awesome-dsh-plugin catalog PR for dsh-live-terminal.
 *
 * The catalog repo (https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
 * requires the plugin repository to be at least 1 day old, so this script
 * checks that gate before creating anything.
 *
 * The fork branch `add-dsh-live-terminal` is expected to already exist on
 * <owner>/awesome-dsh-plugin (created by this repo's release workflow).
 *
 * Usage:
 *   node tools/open-catalog-pr.mjs            # check readiness only (default)
 *   node tools/open-catalog-pr.mjs --create   # open the PR when the age gate passes
 *   node tools/open-catalog-pr.mjs --create --force   # bypass the local age check
 *
 * Auth: uses the same stored git credential as `git push` (via
 * `git credential fill`), or GITHUB_TOKEN when present. The token never leaves
 * this process except in the Authorization header to api.github.com.
 */

import { execFileSync } from 'node:child_process'

const OWNER = process.env.DSH_REPO_OWNER ?? 'Lancang-hzau'
const PLUGIN_REPO = process.env.DSH_PLUGIN_REPO ?? 'dsh-live-terminal'
const CATALOG_OWNER = process.env.DSH_CATALOG_OWNER ?? 'awesome-dsh-plugin'
const CATALOG_REPO = process.env.DSH_CATALOG_REPO ?? 'awesome-dsh-plugin'
const BRANCH = process.env.DSH_CATALOG_BRANCH ?? 'add-dsh-live-terminal'
const ENTRY = `data/plugins/${OWNER}__${PLUGIN_REPO}.yml`
const DAY_MS = 24 * 60 * 60 * 1000

const args = new Set(process.argv.slice(2))
const create = args.has('--create')
const force = args.has('--force')

/** Read a GitHub token from env or the stored git credential (never printed). */
function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  const input = 'protocol=https\nhost=github.com\n\n'
  const out = execFileSync('git', ['credential', 'fill'], { input, encoding: 'utf8' })
  const match = out.match(/^password=(.+)$/m)
  if (!match) throw new Error('no stored GitHub credential; set GITHUB_TOKEN or run git push once')
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
    const error = new Error(`${method} ${path} -> ${res.status} ${data?.message ?? text.slice(0, 200)}`)
    error.status = res.status
    error.data = data
    throw error
  }
  return data
}

const pluginRepo = await api('GET', `/repos/${OWNER}/${PLUGIN_REPO}`)
const createdAt = Date.parse(pluginRepo.created_at)
const ageMs = Date.now() - createdAt
const readyAt = new Date(createdAt + DAY_MS)
const ready = ageMs >= DAY_MS

console.log(`plugin repo:      ${pluginRepo.full_name} (public=${!pluginRepo.private})`)
console.log(`created at:       ${pluginRepo.created_at} (age ${(ageMs / 3_600_000).toFixed(1)} h)`)
console.log(`catalog gate:     ${ready ? 'PASSED' : `not yet - earliest ${readyAt.toISOString()}`}`)
console.log(`catalog entry:    ${ENTRY} on branch ${OWNER}:${BRANCH}`)

let fork = undefined
try {
  fork = await api('GET', `/repos/${OWNER}/${CATALOG_REPO}`)
  console.log(`fork:             ${fork.full_name} (parent ${fork.parent?.full_name ?? '?'})`)
} catch (error) {
  if (error.status !== 404) throw error
  console.log(`fork:             missing (create it: https://github.com/${CATALOG_OWNER}/${CATALOG_REPO}/fork)`)
}

try {
  const branch = await api('GET', `/repos/${OWNER}/${CATALOG_REPO}/branches/${encodeURIComponent(BRANCH)}`)
  console.log(`branch:           ${BRANCH} @ ${branch.commit.sha.slice(0, 8)}`)
} catch (error) {
  if (error.status !== 404) throw error
  console.log(`branch:           missing (push ${ENTRY} to ${OWNER}/${CATALOG_REPO}:${BRANCH})`)
}

const existing = await api('GET', `/repos/${CATALOG_OWNER}/${CATALOG_REPO}/pulls?head=${OWNER}:${BRANCH}&state=all`)
if (existing.length > 0) {
  console.log(`existing PR:      #${existing[0].number} ${existing[0].html_url} (${existing[0].state})`)
  process.exit(0)
}

if (!create) {
  console.log('')
  console.log(ready ? 'Ready. Run with --create to open the catalog PR.' : 'Waiting for the 1-day repo-age gate; rerun with --create after it passes (or --force).')
  process.exit(0)
}
if (!ready && !force) {
  console.error(`Age gate not reached; earliest ${readyAt.toISOString()} (use --force only if maintainers agree).`)
  process.exit(2)
}

const pr = await api('POST', `/repos/${CATALOG_OWNER}/${CATALOG_REPO}/pulls`, {
  title: `Add ${OWNER}/${PLUGIN_REPO}`,
  head: `${OWNER}:${BRANCH}`,
  base: 'main',
  body: [
    `Adds [${OWNER}/${PLUGIN_REPO}](${pluginRepo.html_url}) to the **UI** section.`,
    '',
    'Visible terminal panel for DeepSeek Harness (DSH): streams agent shell commands into an in-app',
    'terminal live and lets the agent capture the terminal screen as text.',
    '',
    `- npm: \`${pluginRepo.name}\` (auto-mapped from the package \`repository\` field)`,
    '- `dsh.bundle` manifest at the repository root; installable with `dsh plugin add dsh-live-terminal`',
    '- screenshots declared in `screenshots.json` (4 images under `docs/screenshots/`)',
    '- repository is public, has the `dsh-plugin` topic, and the entry file only adds a single plugin',
    '',
    'Entry file:',
    '```yaml',
    `url: ${pluginRepo.html_url}`,
    `name: ${OWNER}/${PLUGIN_REPO}`,
    'category: ui',
    'description:',
    "  en: Visible terminal panel that streams the agent's shell commands into an in-app terminal and lets the agent capture the terminal screen as text.",
    '  zh: 可见终端面板：把 agent 的 shell 命令实时显示在应用内终端，并支持 agent 以文本方式截取终端屏幕。',
    '```',
  ].join('\n'),
})

console.log('')
console.log(`PR opened: ${pr.html_url}`)
