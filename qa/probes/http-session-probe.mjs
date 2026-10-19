/**
 * Focused probe for H-06/H-08 failure in the final acceptance run:
 * create an interactive session over HTTP, watch its snapshot/state over time,
 * send one command and wait for the echo/output.
 *
 * Usage: node qa/probes/http-session-probe.mjs "<token-url>"
 */

import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

const url = process.argv[2]
if (!url || !/^https?:\/\//.test(url)) {
  console.error('usage: node qa/probes/http-session-probe.mjs <token-url>')
  process.exit(2)
}
const candidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]
const browserPath = process.env.DSH_TEST_BROWSER ?? candidates.find((candidate) => existsSync(candidate))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await context.newPage()

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => (document.body?.innerText?.length ?? 0) > 30, null, { timeout: 40_000 })
  await sleep(1200)

  const result = await page.evaluate(async () => {
    const jsonFetch = async (path, init) => {
      const response = await fetch(path, { credentials: 'same-origin', ...init })
      const text = await response.text()
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
      return { status: response.status, json, text }
    }
    const post = (path, body) =>
      jsonFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

    const created = await post('/dsh-terminal-panel/create', { cols: 100, rows: 30, title: 'qa-probe-http' })
    const id = created.json?.session?.id
    const trace = []
    const startedAt = Date.now()
    let nonce = null
    let sentAt = 0
    let outputSeen = false
    while (Date.now() - startedAt < 25_000) {
      const snapshot = await jsonFetch('/dsh-terminal-panel/snapshot?id=' + encodeURIComponent(id))
      const info = snapshot.json?.info
      const text = snapshot.json?.text ?? ''
      trace.push({
        t: Date.now() - startedAt,
        state: info?.state,
        textLength: text.length,
        lastLine: text.split('\n').filter((line) => line.length > 0).pop()?.slice(0, 80) ?? '',
      })
      if (nonce !== null) {
        if (text.includes(nonce)) {
          outputSeen = true
          break
        }
      } else if (/PS\s+[A-Za-z]:[\\/]/.test(text) || /PS\s+\S/.test(text)) {
        nonce = 'qa-probe-' + Date.now().toString(36)
        await post('/dsh-terminal-panel/input', { id, data: "Write-Output '" + nonce + "'\r" })
        sentAt = Date.now() - startedAt
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    const sessions = await jsonFetch('/dsh-terminal-panel/sessions')
    const info = sessions.json?.sessions?.find((session) => session.id === id)
    if (id) await post('/dsh-terminal-panel/close', { id })
    return {
      createdStatus: created.status,
      id,
      promptWaitSentAt: sentAt,
      outputSeen,
      nonce,
      trace: trace.slice(0, 30),
      finalSessionInfo: info,
    }
  })
  console.log(JSON.stringify(result, null, 2))
} finally {
  await browser.close().catch(() => {})
}
