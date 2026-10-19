import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import { DEFAULT_CONFIG, resolveConfig } from '../lib/index.js'
import { normalizeDimensions, TerminalRegistry } from '../lib/host/registry.js'

/**
 * Controllable PTY handle double (the real handle's output is a Node Readable).
 * @returns {any} fake handle.
 */
function fakeHandle() {
  const output = new PassThrough()
  const outcome = Promise.withResolvers()
  let terminated = false
  return {
    output,
    done: outcome.promise,
    writes: [],
    resizes: [],
    get terminated() {
      return terminated
    },
    push(text) {
      output.write(Buffer.from(text, 'utf8'))
    },
    finish(value = { exitCode: 0, signal: null }) {
      outcome.resolve(value)
      output.end()
    },
    async write(data) {
      this.writes.push(data)
    },
    async resize(cols, rows) {
      this.resizes.push([cols, rows])
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
 * Subprocess double that records spawn specs and returns controllable handles.
 * @returns {any} fake subprocess service.
 */
function fakeProcessSubprocess() {
  const spawned = []
  return {
    spawned,
    async terminalEnvironment() {
      return { platform: 'windows', defaultShell: 'cmd.exe' }
    },
    async resolveExecutable(name) {
      return `C:\\resolved\\${name}.exe`
    },
    async spawnTerminal(spec) {
      const handle = fakeHandle()
      spawned.push({ spec, handle })
      return handle
    },
  }
}

/**
 * @param {any} subprocess fake subprocess service.
 * @param {object} [configOverrides] config overrides.
 * @returns {TerminalRegistry} registry.
 */
function processRegistry(subprocess, configOverrides = {}) {
  return new TerminalRegistry({
    subprocess,
    workingDirectory: { defaultDirectory: 'C:\\host-start-dir' },
    sessions: undefined,
    config: resolveConfig({ ...configOverrides }),
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

test('normalizeDimensions clamps invalid values to defaults', () => {
  assert.deepEqual(normalizeDimensions(100, 40), { cols: 100, rows: 40 })
  assert.deepEqual(normalizeDimensions(undefined, undefined), { cols: 120, rows: 30 })
  assert.deepEqual(normalizeDimensions(1, 0), { cols: 120, rows: 30 })
  assert.deepEqual(normalizeDimensions(9999, 9999), { cols: 120, rows: 30 })
  assert.deepEqual(normalizeDimensions(2, 1), { cols: 2, rows: 1 })
})

test('resolveConfig applies defaults', () => {
  assert.deepEqual(resolveConfig(undefined), { ...DEFAULT_CONFIG })
  assert.deepEqual(resolveConfig(null), { ...DEFAULT_CONFIG })
  assert.deepEqual(resolveConfig('nonsense'), { ...DEFAULT_CONFIG })
})

test('resolveConfig clamps numeric bounds and parses flags', () => {
  const config = resolveConfig({
    interceptShellTools: false,
    shellPath: '  C:\\pwsh.exe  ',
    scrollback: 5,
    maxOutputBytes: 1,
    maxSessions: 999,
    commandTimeoutMs: -1,
    retainExited: 999,
  })
  assert.equal(config.interceptShellTools, false)
  assert.equal(config.shellPath, 'C:\\pwsh.exe')
  assert.equal(config.scrollback, 5)
  assert.equal(config.maxOutputBytes, 1024)
  assert.equal(config.maxSessions, 128)
  assert.equal(config.commandTimeoutMs, 1000)
  assert.equal(config.retainExited, 128)
})

/**
 * Registry with fake services for the pure cwd-resolution logic.
 * @param {{ store?: any, query?: any }} [options] session store / query overrides.
 * @returns {TerminalRegistry} registry under test.
 */
function fakeRegistry(options = {}) {
  const store = options.store ?? {
    get(id) {
      return id === 'live-session' ? { id, projectedCwd: 'C:\\workspace\\project', header: { cwd: 'C:\\header\\dir' } } : undefined
    },
    list() {
      return [{ id: 'session-fallback', header: { cwd: 'C:\\fallback\\dir' } }]
    },
  }
  return new TerminalRegistry({
    subprocess: {},
    workingDirectory: {
      defaultDirectory: 'C:\\host-start-dir',
      get(session) {
        return session.projectedCwd ?? null
      },
    },
    getSessionStore: () => store,
    getSessionQuery: () => options.query,
    config: resolveConfig(undefined),
  })
}

/**
 * Session-query double returning the live-preferred corpus records.
 * @param {any[]} records corpus records.
 * @returns {any} fake `ctx.sessionQuery`.
 */
function fakeSessionQuery(records) {
  return {
    async filterSessions(filters) {
      const ids = filters?.[0]?.values ?? []
      return records.filter((record) => ids.includes(record.header.id))
    },
    async listSessions() {
      return records
    },
  }
}

test('resolveSessionCwd resolves the committed cwd of a live session', async () => {
  const registry = fakeRegistry()
  assert.equal(await registry.resolveSessionCwd('live-session'), 'C:\\workspace\\project')
})

test('resolveSessionCwd falls back to the durable session header cwd', async () => {
  const registry = fakeRegistry()
  assert.equal(await registry.resolveSessionCwd('session-fallback'), 'C:\\fallback\\dir')
})

test('resolveSessionCwd tolerates the optional session- prefix both ways', async () => {
  const registry = fakeRegistry()
  assert.equal(await registry.resolveSessionCwd('fallback'), 'C:\\fallback\\dir')
  assert.equal(await registry.resolveSessionCwd('session-live-session'), 'C:\\workspace\\project')
})

test('resolveSessionCwd resolves persisted (not live) sessions through ctx.sessionQuery', async () => {
  const query = fakeSessionQuery([
    { header: { id: 'session-persisted', cwd: 'C:\\persisted\\dir' }, live: false, persisted: true },
    { header: { id: 'session-no-cwd' }, live: false, persisted: true },
  ])
  const registry = fakeRegistry({ store: { get: () => undefined, list: () => [] }, query })
  assert.equal(await registry.resolveSessionCwd('session-persisted'), 'C:\\persisted\\dir')
  assert.equal(await registry.resolveSessionCwd('persisted'), 'C:\\persisted\\dir')
  assert.equal(await registry.resolveSessionCwd('session-no-cwd'), undefined)
  assert.equal(await registry.resolveSessionCwd('session-unknown'), undefined)
})

test('resolveSessionCwd survives a throwing session query', async () => {
  const throwing = {
    async filterSessions() {
      throw new Error('disabled')
    },
    async listSessions() {
      throw new Error('disabled')
    },
  }
  const registry = fakeRegistry({ store: { get: () => undefined, list: () => [] }, query: throwing })
  assert.equal(await registry.resolveSessionCwd('session-persisted'), undefined)
})

test('resolveSessionCwd resolves the store lazily at call time', async () => {
  let provided
  const registry = new TerminalRegistry({
    subprocess: {},
    workingDirectory: { get: () => 'C:\\late\\dir' },
    getSessionStore: () => provided,
    config: resolveConfig(undefined),
  })
  assert.equal(await registry.resolveSessionCwd('late-session'), undefined)
  provided = { get: (id) => (id === 'late-session' ? { id } : undefined) }
  assert.equal(await registry.resolveSessionCwd('late-session'), 'C:\\late\\dir')
})

test('resolveSessionCwd returns undefined for unknown or empty session ids', async () => {
  const registry = fakeRegistry()
  assert.equal(await registry.resolveSessionCwd('offline-session'), undefined)
  assert.equal(await registry.resolveSessionCwd(''), undefined)
  assert.equal(await registry.resolveSessionCwd(undefined), undefined)
})

test('resolveSessionCwd tolerates missing session services', async () => {
  const registry = new TerminalRegistry({
    subprocess: {},
    workingDirectory: undefined,
    getSessionStore: () => undefined,
    getSessionQuery: () => undefined,
    config: resolveConfig(undefined),
  })
  assert.equal(await registry.resolveSessionCwd('live-session'), undefined)
})

test('resolveCwd falls back to the default directory without an agent', async () => {
  const registry = fakeRegistry()
  assert.equal(await registry.resolveCwd(undefined, undefined), 'C:\\host-start-dir')
  assert.equal(await registry.resolveCwd(undefined, 'relative-dir'), 'C:\\host-start-dir\\relative-dir')
  assert.equal(await registry.resolveCwd(undefined, 'C:\\absolute'), 'C:\\absolute')
})

test('list and lookup operate on registered sessions only', () => {
  const registry = fakeRegistry()
  assert.deepEqual(registry.list(), [])
  assert.equal(registry.lookup('missing'), undefined)
  assert.equal(registry.size, 0)
})

test('createCommandSession spawns the built-in-compatible one-shot argv and waits for exit', async () => {
  const subprocess = fakeProcessSubprocess()
  const registry = processRegistry(subprocess)
  try {
    const session = await registry.createCommandSession({
      command: "Write-Output 'hi'",
      cwd: 'C:\\work',
      cols: 100,
      rows: 40,
      title: 'cmd',
    })
    assert.equal(registry.lookup(session.id)?.id, session.id)
    const { spec, handle } = subprocess.spawned[0]
    assert.deepEqual(spec.argv, [
      'C:\\resolved\\pwsh.exe',
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Write-Output 'hi'",
    ])
    assert.equal(spec.cwd, 'C:\\work')
    assert.equal(spec.cols, 100)
    assert.equal(spec.rows, 40)
    assert.equal(spec.terminalType, 'xterm-256color')
    assert.equal(spec.shellActivity, false)
    assert.equal(spec.graceMs, 1000)
    handle.push("hi\r\n")
    handle.finish({ exitCode: 0, signal: null })
    const result = await registry.waitForCommandSession(session, { timeoutMs: 2000 })
    assert.equal(result.output, 'hi')
    assert.equal(result.exitCode, 0)
    assert.equal(result.timedOut, false)
    assert.equal(result.aborted, false)
    assert.equal(session.state, 'exited')
  } finally {
    await registry.dispose()
  }
})

test('waitForCommandSession times out by terminating the PTY and returning partial output', async () => {
  const subprocess = fakeProcessSubprocess()
  const registry = processRegistry(subprocess)
  try {
    const session = await registry.createCommandSession({ command: 'Start-Sleep 60', cwd: 'C:\\work' })
    const { handle } = subprocess.spawned[0]
    handle.push('partial line\r\n')
    await waitFor(() => session.snapshot().text.includes('partial line'))
    const result = await registry.waitForCommandSession(session, { timeoutMs: 120, signal: undefined })
    assert.equal(result.timedOut, true)
    assert.equal(result.exitCode, null)
    assert.equal(result.signal, 'SIGTERM')
    assert.equal(handle.terminated, true)
    assert.ok(result.output.includes('partial line'))
  } finally {
    await registry.dispose()
  }
})

test('ensureAgentTerminal reuses one interactive terminal per agent and recreates after exit', async () => {
  const subprocess = fakeProcessSubprocess()
  const registry = processRegistry(subprocess)
  try {
    const agent = { id: 'agent-1', session: { id: 'session-1' } }
    const first = await registry.ensureAgentTerminal(agent)
    const second = await registry.ensureAgentTerminal(agent)
    assert.equal(first.id, second.id)
    assert.equal(subprocess.spawned.length, 1)
    assert.equal(first.info.owner, 'agent')
    assert.equal(first.info.sessionId, 'session-1')
    subprocess.spawned[0].handle.finish({ exitCode: 0, signal: null })
    await waitFor(() => first.state === 'exited')
    const third = await registry.ensureAgentTerminal(agent)
    assert.notEqual(third.id, first.id)
    assert.equal(subprocess.spawned.length, 2)
  } finally {
    await registry.dispose()
  }
})

test('close terminates the process and removes the session', async () => {
  const subprocess = fakeProcessSubprocess()
  const registry = processRegistry(subprocess)
  try {
    const session = await registry.createInteractive({ cwd: 'C:\\work' })
    const { handle } = subprocess.spawned[0]
    assert.equal(await registry.close(session.id), true)
    assert.equal(registry.lookup(session.id), undefined)
    assert.equal(handle.terminated, true)
    assert.equal(await registry.close(session.id), false)
  } finally {
    await registry.dispose()
  }
})

test('maxSessions is enforced when nothing exited can be pruned', async () => {
  const subprocess = fakeProcessSubprocess()
  const registry = processRegistry(subprocess, { maxSessions: 1 })
  try {
    await registry.createInteractive({ cwd: 'C:\\work' })
    await assert.rejects(() => registry.createInteractive({ cwd: 'C:\\work' }), /limit reached/)
  } finally {
    await registry.dispose()
  }
})

test('resolveRecentForAgent prefers the newest command session of that agent', async () => {
  const subprocess = fakeProcessSubprocess()
  const registry = processRegistry(subprocess)
  try {
    const agent = { id: 'agent-1', session: { id: 'session-1' } }
    await registry.createInteractive({ agent, agentId: 'agent-1', owner: 'agent' })
    const firstCommand = await registry.createCommandSession({ command: 'one', agent, agentId: 'agent-1' })
    const secondCommand = await registry.createCommandSession({ command: 'two', agent, agentId: 'agent-1' })
    const otherAgentCommand = await registry.createCommandSession({ command: 'other', agentId: 'agent-2' })
    assert.equal(registry.resolveRecentForAgent(agent)?.id, secondCommand.id)
    assert.notEqual(secondCommand.id, firstCommand.id)
    assert.equal(registry.resolveRecentForAgent({ id: 'agent-2' })?.id, otherAgentCommand.id)
    assert.equal(registry.resolveRecentForAgent({ id: 'unknown-agent' }), undefined)
    assert.equal(registry.resolveRecentForAgent(undefined), undefined)
  } finally {
    await registry.dispose()
  }
})

test('resolveRecentForAgent falls back to the agent interactive session', async () => {
  const subprocess = fakeProcessSubprocess()
  const registry = processRegistry(subprocess)
  try {
    const agent = { id: 'agent-3', session: { id: 'session-3' } }
    const interactive = await registry.createInteractive({ agent, agentId: 'agent-3', owner: 'agent' })
    assert.equal(registry.resolveRecentForAgent(agent)?.id, interactive.id)
  } finally {
    await registry.dispose()
  }
})

