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
 * @param {{ available?: string[], failFirstSpawn?: boolean, spawnDelayMs?: number }} [options] behaviour overrides.
 * @returns {any} fake subprocess service.
 */
function fakeProcessSubprocess(options = {}) {
  const spawned = []
  let spawnFailures = options.failFirstSpawn === true ? 1 : 0
  return {
    spawned,
    async terminalEnvironment() {
      return { platform: 'windows', defaultShell: 'cmd.exe' }
    },
    async resolveExecutable(name) {
      if (Array.isArray(options.available) && !options.available.includes(name)) {
        throw new Error(`${name} not found`)
      }
      return `C:\\resolved\\${name}.exe`
    },
    async spawnTerminal(spec) {
      if (options.spawnDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.spawnDelayMs))
      }
      if (spawnFailures > 0) {
        spawnFailures -= 1
        throw new Error('spawn boom')
      }
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
    // `waitForExit` unrefs its timeout timer on purpose (a pending command wait
    // must not keep the Host alive). Node 22's test runner treats an event loop
    // holding only unref'd timers as drained and cancels the pending test, so
    // hold the loop with a ref'd timer for the duration of this wait.
    const keepAlive = setTimeout(() => {}, 2_000)
    let result
    try {
      result = await registry.waitForCommandSession(session, { timeoutMs: 120, signal: undefined })
    } finally {
      clearTimeout(keepAlive)
    }
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

test('createCommandSession resolves the command shell per shellKindHint', async () => {
  const subprocess = fakeProcessSubprocess()
  const registry = processRegistry(subprocess)
  try {
    const bashSession = await registry.createCommandSession({ command: 'echo hi', cwd: 'C:\\work', shellKindHint: 'bash' })
    const pwshSession = await registry.createCommandSession({ command: 'Write-Output hi', cwd: 'C:\\work' })
    assert.equal(bashSession.kind, 'command')
    assert.equal(pwshSession.kind, 'command')
    assert.equal(subprocess.spawned[0].spec.argv[0], 'C:\\resolved\\bash.exe')
    assert.deepEqual(subprocess.spawned[0].spec.argv.slice(1), ['-c', 'echo hi'])
    assert.equal(subprocess.spawned[1].spec.argv[0], 'C:\\resolved\\pwsh.exe')
  } finally {
    await registry.dispose()
  }
})

test('shell resolution is cached separately per shell-kind hint', async () => {
  const subprocess = fakeProcessSubprocess()
  const resolved = []
  const resolveExecutable = subprocess.resolveExecutable.bind(subprocess)
  subprocess.resolveExecutable = async (name, ...rest) => {
    resolved.push(name)
    return resolveExecutable(name, ...rest)
  }
  const registry = processRegistry(subprocess)
  try {
    await registry.createCommandSession({ command: 'one', cwd: 'C:\\work', shellKindHint: 'bash' })
    await registry.createCommandSession({ command: 'two', cwd: 'C:\\work', shellKindHint: 'bash' })
    await registry.createCommandSession({ command: 'three', cwd: 'C:\\work' })
    // The bash hint resolves bash once; the hint-less path still resolves pwsh once.
    assert.deepEqual(resolved, ['bash', 'pwsh'])
  } finally {
    await registry.dispose()
  }
})

test('createCommandSession rejects when the hinted shell is unavailable and keeps capacity usable', async () => {
  const subprocess = fakeProcessSubprocess({ available: ['pwsh', 'powershell'] })
  const registry = processRegistry(subprocess, { maxSessions: 1 })
  try {
    await assert.rejects(
      () => registry.createCommandSession({ command: 'echo hi', cwd: 'C:\\work', shellKindHint: 'bash' }),
      /no usable shell found for shell kind bash/,
    )
    assert.equal(subprocess.spawned.length, 0)
    assert.equal(registry.size, 0)
    const session = await registry.createCommandSession({ command: 'Write-Output hi', cwd: 'C:\\work' })
    assert.equal(registry.size, 1)
    assert.equal(registry.lookup(session.id)?.id, session.id)
  } finally {
    await registry.dispose()
  }
})

test('maxSessions is atomic when creations run concurrently', async () => {
  const subprocess = fakeProcessSubprocess({ spawnDelayMs: 40 })
  const registry = processRegistry(subprocess, { maxSessions: 1 })
  try {
    const results = await Promise.allSettled([
      registry.createInteractive({ cwd: 'C:\\work' }),
      registry.createInteractive({ cwd: 'C:\\work' }),
    ])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.match(String(rejected[0].reason?.message ?? rejected[0].reason), /limit/)
    assert.equal(registry.size, 1)
  } finally {
    await registry.dispose()
  }
})

test('a failed spawn releases the reserved capacity slot', async () => {
  const subprocess = fakeProcessSubprocess({ failFirstSpawn: true })
  const registry = processRegistry(subprocess, { maxSessions: 1 })
  try {
    await assert.rejects(() => registry.createInteractive({ cwd: 'C:\\work' }), /spawn boom/)
    assert.equal(registry.size, 0)
    const session = await registry.createInteractive({ cwd: 'C:\\work' })
    assert.equal(registry.size, 1)
    assert.equal(registry.lookup(session.id)?.id, session.id)
  } finally {
    await registry.dispose()
  }
})

test('capacity pressure closes exited sessions before reclaiming live agent terminals', async () => {
  const subprocess = fakeProcessSubprocess()
  const registry = processRegistry(subprocess, { maxSessions: 2 })
  try {
    const agent = { id: 'agent-1', session: { id: 'session-1' } }
    const defaultTerminal = await registry.ensureAgentTerminal(agent)
    const command = await registry.createCommandSession({ command: 'exit', agent, agentId: 'agent-1' })
    const commandHandle = subprocess.spawned[1].handle
    commandHandle.finish({ exitCode: 0, signal: null })
    await waitFor(() => command.state === 'exited')
    const extra = await registry.createInteractive({ agent, agentId: 'agent-1', owner: 'agent' })
    assert.equal(registry.lookup(command.id), undefined, 'exited session must be reclaimed first')
    assert.equal(registry.lookup(defaultTerminal.id)?.id, defaultTerminal.id)
    assert.equal(registry.lookup(extra.id)?.id, extra.id)
    assert.equal(registry.size, 2)
  } finally {
    await registry.dispose()
  }
})

test('capacity pressure reclaims agent-owned non-default interactive sessions but keeps user terminals', async () => {
  const subprocess = fakeProcessSubprocess()
  const registry = processRegistry(subprocess, { maxSessions: 2 })
  try {
    const agent = { id: 'agent-1', session: { id: 'session-1' } }
    const user = await registry.createInteractive({ cwd: 'C:\\work', owner: 'user' })
    const extra = await registry.createInteractive({ agent, agentId: 'agent-1', owner: 'agent' })
    const fresh = await registry.createInteractive({ agent, agentId: 'agent-1', owner: 'agent' })
    assert.equal(registry.lookup(user.id)?.id, user.id, 'user terminals must never be reclaimed')
    assert.equal(registry.lookup(extra.id), undefined, 'the oldest agent extra terminal is reclaimed')
    assert.equal(registry.lookup(fresh.id)?.id, fresh.id)
    assert.equal(registry.size, 2)
  } finally {
    await registry.dispose()
  }
})

test('capacity pressure never reclaims the agent default interactive terminal', async () => {
  const subprocess = fakeProcessSubprocess()
  const registry = processRegistry(subprocess, { maxSessions: 2 })
  try {
    const agent = { id: 'agent-1', session: { id: 'session-1' } }
    const defaultTerminal = await registry.ensureAgentTerminal(agent)
    const user = await registry.createInteractive({ cwd: 'C:\\work', owner: 'user' })
    await assert.rejects(
      () => registry.createInteractive({ agent, agentId: 'agent-1', owner: 'agent' }),
      /limit/,
    )
    assert.equal(registry.lookup(defaultTerminal.id)?.id, defaultTerminal.id)
    assert.equal(registry.lookup(user.id)?.id, user.id)
    assert.equal(registry.size, 2)
  } finally {
    await registry.dispose()
  }
})

test('capacity pressure during agent-terminal startup keeps the starting default terminal', async () => {
  const subprocess = fakeProcessSubprocess()
  const registry = processRegistry(subprocess, { maxSessions: 2 })
  try {
    const agent = { id: 'agent-1', session: { id: 'session-1' } }
    // Spawned but still inside ensureAgentTerminal's waitReady quiet window:
    // the terminal must be protected from reclamation without being published
    // as the agent's default before it is ready.
    const starting = registry.ensureAgentTerminal(agent)
    await waitFor(() => registry.size === 1)
    assert.equal(registry.resolveForAgent(agent), undefined, 'a starting default terminal must not be published yet')
    const user = await registry.createInteractive({ cwd: 'C:\\work', owner: 'user' })
    await assert.rejects(
      () => registry.createInteractive({ cwd: 'C:\\work', owner: 'user' }),
      /limit/,
      'user terminals are not reclaimable, so pressure must fail instead of closing the starting default terminal',
    )
    const defaultTerminal = await starting
    assert.equal(registry.lookup(defaultTerminal.id)?.id, defaultTerminal.id)
    assert.equal(registry.resolveForAgent(agent)?.id, defaultTerminal.id)
    assert.equal(registry.lookup(user.id)?.id, user.id)
    assert.equal(registry.size, 2)
  } finally {
    await registry.dispose()
  }
})

