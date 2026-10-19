import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import { TerminalPanelSession } from '../lib/host/session.js'

/**
 * Controllable PTY handle double built on a PassThrough stream (the real
 * handle's `output` is a Node Readable).
 * @returns {any} fake handle.
 */
function fakeHandle() {
  const output = new PassThrough()
  const outcome = Promise.withResolvers()
  const writes = []
  const resizes = []
  let terminated = false
  return {
    output,
    done: outcome.promise,
    writes,
    resizes,
    get terminated() {
      return terminated
    },
    push(bytes) {
      output.write(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'))
    },
    finish(value = { exitCode: 0, signal: null }) {
      outcome.resolve(value)
      output.end()
    },
    fail(error) {
      outcome.reject(error)
      output.end()
    },
    async write(data) {
      writes.push(data)
    },
    async resize(cols, rows) {
      resizes.push([cols, rows])
    },
    async terminate() {
      if (terminated) return
      terminated = true
      outcome.resolve({ exitCode: 1, signal: null })
      output.end()
    },
  }
}

/**
 * @param {any} handle fake handle.
 * @param {object} [overrides] session option overrides.
 * @returns {any} session under test.
 */
function makeSession(handle, overrides = {}) {
  return new TerminalPanelSession({
    id: 'session-1',
    title: 'test',
    kind: 'interactive',
    owner: 'user',
    handle,
    cwd: 'C:\\work',
    cols: 40,
    rows: 10,
    scrollback: 100,
    maxOutputBytes: 1024,
    ...overrides,
  })
}

/**
 * @param {() => boolean} predicate condition.
 * @param {number} [timeoutMs] wait budget.
 * @returns {Promise<void>} resolves when the condition holds.
 */
async function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('decodes split UTF-8 chunks through a streaming decoder', async () => {
  const handle = fakeHandle()
  const session = makeSession(handle)
  const bytes = Buffer.from('你好!', 'utf8')
  handle.push(bytes.subarray(0, 4))
  handle.push(bytes.subarray(4))
  await waitFor(() => session.snapshot().text.includes('你好!'))
  assert.equal(session.snapshot().text, '你好!')
  handle.finish()
  await session.whenExited
  assert.equal(session.state, 'exited')
  await session.dispose()
})

test('mirrors output into the visible screen and a plain-text tail', async () => {
  const handle = fakeHandle()
  const session = makeSession(handle)
  handle.push('\u001B[31mred\u001B[0m\r\nnext')
  await waitFor(() => session.visibleText().includes('next'))
  assert.equal(session.visibleText(), 'red\nnext')
  assert.equal(session.plainText(), 'red\nnext')
  assert.equal(session.plainTail(3).text, 'ext')
  handle.finish()
  await session.whenExited
  await session.dispose()
})

test('broadcasts output frames with monotonic sequence numbers', async () => {
  const handle = fakeHandle()
  const session = makeSession(handle)
  const events = []
  session.subscribe((name, data) => events.push({ name, data }))
  handle.push('one\r\n')
  await waitFor(() => events.filter((event) => event.name === 'output').length === 1)
  handle.push('two')
  await waitFor(() => events.filter((event) => event.name === 'output').length === 2)
  const outputs = events.filter((event) => event.name === 'output')
  assert.equal(outputs[0].data.seq, 1)
  assert.equal(outputs[1].data.seq, 2)
  assert.equal(outputs[0].data.chunk, 'one\r\n')
  assert.equal(outputs[1].data.chunk, 'two')
  handle.finish()
  await session.whenExited
  const names = events.map((event) => event.name)
  assert.ok(names.includes('state'))
  assert.ok(names.includes('exit'))
  const exit = events.find((event) => event.name === 'exit')
  assert.equal(exit.data.exitCode, 0)
  assert.equal(events.find((event) => event.name === 'state').data.info.state, 'exited')
  await session.dispose()
})

test('subscription disposer stops delivery', async () => {
  const handle = fakeHandle()
  const session = makeSession(handle)
  const events = []
  const dispose = session.subscribe((name) => events.push(name))
  dispose()
  handle.push('data')
  await waitFor(() => session.snapshot().text === 'data')
  assert.deepEqual(events, [])
  handle.finish()
  await session.whenExited
  await session.dispose()
})

test('write is serialised and rejects after exit', async () => {
  const handle = fakeHandle()
  const session = makeSession(handle)
  await session.write('hello\r')
  assert.deepEqual(handle.writes, ['hello\r'])
  handle.finish()
  await session.whenExited
  await assert.rejects(() => session.write('after exit'), /not running/)
  await session.dispose()
})

test('resize applies to the PTY and the mirror and broadcasts state', async () => {
  const handle = fakeHandle()
  const session = makeSession(handle)
  const events = []
  session.subscribe((name, data) => events.push({ name, data }))
  await session.resize(120, 30)
  assert.deepEqual(handle.resizes, [[120, 30]])
  assert.equal(session.cols, 120)
  assert.equal(session.rows, 30)
  assert.equal(events.filter((event) => event.name === 'state').length, 1)
  handle.finish()
  await session.whenExited
  await session.dispose()
})

test('terminate ends the session and reports exit', async () => {
  const handle = fakeHandle()
  const session = makeSession(handle)
  await session.terminate()
  await session.whenExited
  assert.equal(handle.terminated, true)
  assert.equal(session.state, 'exited')
  await session.dispose()
})

test('failed process completion publishes a failed state with the error message', async () => {
  const handle = fakeHandle()
  const session = makeSession(handle)
  handle.fail(new Error('pty exploded'))
  await session.whenExited
  assert.equal(session.state, 'failed')
  assert.equal(session.error, 'pty exploded')
  assert.equal(session.info.error, 'pty exploded')
  await session.dispose()
})

test('output stream failure marks the session failed and terminates the process tree', async () => {
  const handle = fakeHandle()
  const session = makeSession(handle)
  handle.output.destroy(new Error('pty read exploded'))
  await session.whenExited
  assert.equal(session.state, 'failed')
  assert.equal(session.error, 'pty read exploded')
  // The process tree must be killed so a failed session cannot leak an orphan shell.
  assert.equal(handle.terminated, true)
  await session.dispose()
})

test('waitReady returns after the shell output becomes quiet', async () => {
  const handle = fakeHandle()
  const session = makeSession(handle)
  handle.push('PowerShell 7.4.0\r\nPS C:\\work> ')
  const startedAt = Date.now()
  await session.waitReady({ quietMs: 20, timeoutMs: 2000 })
  assert.ok(Date.now() - startedAt >= 20)
  handle.finish()
  await session.whenExited
  await session.dispose()
})

test('snapshot(options.scrollback) bounds the serialized scrollback', async () => {
  const handle = fakeHandle()
  const session = makeSession(handle, { cols: 20, rows: 3 })
  try {
    // 10 lines on a 3-row terminal: the first 7 lines scroll out of the viewport.
    const lines = Array.from({ length: 10 }, (_entry, index) => `line-${index + 1}`).join('\r\n')
    handle.push(lines)
    await waitFor(() => session.visibleText().includes('line-10'))

    const unbounded = session.snapshot()
    assert.ok(unbounded.screen.includes('line-7'), 'default snapshot keeps the whole retained buffer')
    assert.ok(unbounded.screen.includes('line-8'))
    assert.ok(unbounded.screen.includes('line-10'))

    const viewportOnly = session.snapshot({ scrollback: 0 })
    assert.ok(!viewportOnly.screen.includes('line-7'), 'scrollback:0 excludes lines scrolled out of the viewport')
    assert.ok(viewportOnly.screen.includes('line-8'), 'scrollback:0 still serializes the viewport')
    assert.ok(viewportOnly.screen.includes('line-10'))
    assert.equal(viewportOnly.text, session.visibleText(), 'visible text is unaffected by the scrollback bound')
  } finally {
    handle.finish()
    await session.whenExited
    await session.dispose()
  }
})
