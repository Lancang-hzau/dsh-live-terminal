import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execInSession, POLL_INTERVAL_MS, wrapPosixCommand } from '../lib/host/exec.js'

/** Matches the START marker embedded in a wrapper line. */
const START_RE = /__DSH_TERMINAL_PANEL_START_[A-Za-z0-9]+__/u
/** Matches the END marker (exit code appended) embedded in a wrapper line. */
const END_RE = /__DSH_TERMINAL_PANEL_END_[A-Za-z0-9]+:/u

/**
 * Extract the marker pair from the wrapper text the session was sent.
 * @param {string} wrapperText wrapper line written into the PTY.
 * @returns {{ start: string, end: string }} marker pair.
 */
function markersOf(wrapperText) {
  const start = START_RE.exec(wrapperText)?.[0]
  const end = END_RE.exec(wrapperText)?.[0]
  assert.ok(start, 'wrapper must contain a START marker')
  assert.ok(end, 'wrapper must contain an END marker')
  return { start, end }
}

/**
 * Fake interactive session whose `plainText()` is driven by the fake shell.
 * @param {{ onWrite?: (wrapperText: string, session: any) => void, shellKind?: string, state?: string }} [options] behaviour.
 * @returns {any} fake session.
 */
function fakeSession(options = {}) {
  const session = {
    id: 'terminal-1',
    state: options.state ?? 'running',
    shellKind: options.shellKind ?? 'pwsh',
    plainTextValue: '',
    writes: [],
    async write(data) {
      this.writes.push(data)
      options.onWrite?.(data, this)
    },
    plainText() {
      return this.plainTextValue
    },
    /** Make the next poll see a completed wrapped command. */
    complete(wrapperText, output, exitCode) {
      const { start, end } = markersOf(wrapperText)
      const body = output.length > 0 ? `\n${output}\n` : '\n'
      this.plainTextValue = `${wrapperText}\n${start}${body}${end}${exitCode}`
    },
  }
  return session
}

test('execInSession captures the output between the wrappers', async () => {
  const session = fakeSession()
  const originalWrite = session.write
  session.write = async function write(data) {
    await originalWrite.call(this, data)
    this.complete(data, 'hello\nworld', 0)
  }
  const result = await execInSession(session, 'echo hello', { timeoutMs: 1000, shellKind: 'pwsh' })
  assert.equal(result.exitCode, 0)
  assert.equal(result.timedOut, false)
  assert.equal(result.output, 'hello\nworld')
  assert.ok(result.durationMs >= 0)
  assert.equal(session.writes.length, 1)
})

test('execInSession reports the command exit code and echo:true prefix', async () => {
  const session = fakeSession()
  session.write = async (data) => session.complete(data, 'boom', 3)
  const result = await execInSession(session, 'throw', { timeoutMs: 1000, shellKind: 'pwsh', echo: true })
  assert.equal(result.exitCode, 3)
  assert.equal(result.output, 'throw\nboom')
})

test('execInSession times out without terminating the session', async () => {
  const session = fakeSession()
  const result = await execInSession(session, 'Start-Sleep 60', { timeoutMs: 100, shellKind: 'pwsh' })
  assert.equal(result.timedOut, true)
  assert.equal(result.exitCode, null)
  assert.equal(session.state, 'running', 'a timeout must leave the shell alive')
  assert.ok(result.durationMs >= 100)
})

test('execInSession rejects non-running and unsupported shells', async () => {
  await assert.rejects(
    () => execInSession(fakeSession({ state: 'exited' }), 'pwd', { shellKind: 'pwsh', timeoutMs: 1000 }),
    /is not running/,
  )
  await assert.rejects(
    () => execInSession(fakeSession({ shellKind: 'cmd' }), 'dir', { timeoutMs: 1000 }),
    /cannot execute in a "cmd" shell/,
  )
  await assert.rejects(() => execInSession(fakeSession(), '  '), /command must be a non-empty string/)
})

test('execInSession serializes concurrent calls on the same terminal', async () => {
  const session = fakeSession()
  let writeCount = 0
  session.write = async (data) => {
    writeCount += 1
    if (writeCount === 1) {
      setTimeout(() => session.complete(data, 'first', 0), 25)
    } else {
      session.complete(data, 'second', 1)
    }
  }
  const [first, second] = await Promise.all([
    execInSession(session, 'one', { timeoutMs: 2000, shellKind: 'pwsh' }),
    execInSession(session, 'two', { timeoutMs: 2000, shellKind: 'pwsh' }),
  ])
  assert.equal(first.output, 'first')
  assert.equal(first.exitCode, 0)
  assert.equal(second.output, 'second')
  assert.equal(second.exitCode, 1)
  assert.equal(writeCount, 2)
})

test('wrapPosixCommand keeps state-changing commands in the current shell', () => {
  const marker = { start: '__S__', end: '__E__:' }
  const wrapper = wrapPosixCommand("cd /tmp && echo 'hi'", marker)
  assert.match(wrapper, /printf '%s\\n' '__S__'/)
  assert.match(wrapper, /eval 'cd \/tmp && echo '\\''hi'\\'''/)
  assert.match(wrapper, /__dsh_exit=\$\?/)
  assert.match(wrapper, /printf '%s%d\\n' '__E__:' "\$__dsh_exit"/)
  assert.equal(POLL_INTERVAL_MS, 25)
})
