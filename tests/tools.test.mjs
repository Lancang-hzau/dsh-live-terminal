import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerTools } from '../lib/host/tools.js'
import { validateValue } from './helpers/schema.mjs'

const agent = { id: 'agent-1', session: { id: 'session-1' } }

/**
 * Plain `SessionInfo` values for the fake sessions.
 * @param {string} id session id.
 * @param {'command' | 'interactive'} kind session kind.
 * @param {object} [overrides] field overrides.
 * @returns {any} session info.
 */
function sessionInfo(id, kind, overrides = {}) {
  const info = {
    id,
    title: kind === 'command' ? 'Get-ChildItem' : 'PowerShell',
    kind,
    owner: 'agent',
    agentId: 'agent-1',
    cwd: 'C:\\work',
    cols: 120,
    rows: 30,
    state: kind === 'command' ? 'exited' : 'running',
    exitCode: kind === 'command' ? 0 : null,
    signal: null,
    startedAt: 1000,
    endedAt: kind === 'command' ? 1100 : null,
    durationMs: kind === 'command' ? 100 : null,
    shellKind: 'pwsh',
    ports: [],
    sandbox: { mode: 'danger-full-access', confined: false, required: false },
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
  for (const key of Object.keys(info)) {
    if (info[key] === undefined) delete info[key]
  }
  return info
}

/**
 * Session double with the subset the tools use.
 * @param {string} id session id.
 * @param {'command' | 'interactive'} kind session kind.
 * @param {object} [overrides] session info overrides.
 * @returns {any} fake session.
 */
function fakeSession(id, kind, overrides = {}) {
  const info = sessionInfo(id, kind, overrides)
  const state = { written: [], snapshots: 0, serializeCalls: [], snapshotCalls: [], signals: [] }
  const exit = Promise.withResolvers()
  return {
    id,
    title: info.title,
    kind,
    owner: info.owner,
    agentId: info.agentId,
    state: info.state,
    cols: info.cols,
    rows: info.rows,
    info,
    whenExited: exit.promise,
    _exit: exit,
    _state: state,
    async waitReady() {},
    async write(data) {
      state.written.push(data)
    },
    async sendSignal(name) {
      state.signals.push(name)
      return { delivered: name }
    },
    async resize(cols, rows) {
      this.cols = cols
      this.rows = rows
    },
    plainTail(maxBytes) {
      return { text: `recent output (${maxBytes})`, truncated: false }
    },
    readLines({ offset = 0, lines = 50 } = {}) {
      return { text: `lines ${offset}-${lines}`, startLine: offset, endLine: offset + lines, totalLines: 100, truncated: false }
    },
    visibleText() {
      return kind === 'command' ? 'command screen' : 'interactive screen'
    },
    fullText() {
      return kind === 'command' ? 'scrollback\ncommand screen' : 'scrollback\ninteractive screen'
    },
    exportText(format = 'text') {
      return { text: `${format}-export`, bytes: Buffer.byteLength(`${format}-export`, 'utf8'), truncated: false }
    },
    serialize(options) {
      state.serializeCalls.push(options)
      return `ansi-${kind}`
    },
    snapshot(options) {
      state.snapshots += 1
      state.snapshotCalls.push(options)
      return { info, screen: this.serialize(options), text: `${kind} screen`, cursor: { x: 3, y: 4 }, seq: 2 }
    },
  }
}

/**
 * Registry double covering every registry call the tools make.
 * @param {{ noDefault?: boolean, noRecent?: boolean, waitResult?: object, waitThrows?: boolean, extra?: any[] }} [options] behaviour overrides.
 * @returns {any} registry duplicate with typed call recording.
 */
function fakeRegistry(options = {}) {
  const command = fakeSession('command-1', 'command')
  const interactive = fakeSession('terminal-1', 'interactive')
  const sessions = new Map([
    [command.id, command],
    [interactive.id, interactive],
  ])
  if (options.empty === true) sessions.clear()
  for (const extra of options.extra ?? []) sessions.set(extra.id, extra)
  const historyEntries = options.historyEntries ?? []
  const calls = { created: [], waited: [], ensured: 0, closed: [], renamed: [], waitedExit: [] }
  return {
    calls,
    command,
    interactive,
    historyEntries,
    sessions: [...sessions.values()],
    history: {
      size: historyEntries.length,
      get: (id) => historyEntries.find((entry) => entry.id === id),
    },
    historyList: (limit = 10) => historyEntries.slice(0, limit),
    list: () => [...sessions.values()].map((session) => session.info),
    lookup: (id) => sessions.get(id),
    resolveForAgent: () => (options.noDefault === true || options.empty === true ? undefined : interactive),
    resolveRecentForAgent: () => (options.noRecent === true || options.empty === true ? undefined : command),
    sandboxFor: () => ({ mode: 'danger-full-access', confined: false, required: false }),
    async ensureAgentTerminal() {
      calls.ensured += 1
      return interactive
    },
    async createInteractive() {
      return interactive
    },
    async createCommandSession(createOptions) {
      calls.created.push(createOptions)
      return command
    },
    async waitForCommandSession(session, waitOptions) {
      calls.waited.push({ session, waitOptions })
      if (options.waitThrows === true) throw new Error('wait failed')
      const result = options.waitResult ?? {}
      return {
        output: result.output ?? 'command output',
        truncated: result.truncated ?? false,
        exitCode: Object.hasOwn(result, 'exitCode') ? result.exitCode : 0,
        signal: Object.hasOwn(result, 'signal') ? result.signal : null,
        timedOut: result.timedOut ?? false,
        aborted: result.aborted ?? false,
      }
    },
    async waitForExit(sessionId, waitOptions) {
      calls.waitedExit.push({ sessionId, waitOptions })
      const result = options.waitForExitResult ?? {}
      return {
        terminalId: result.terminalId ?? sessionId,
        state: result.state ?? 'exited',
        exitCode: Object.hasOwn(result, 'exitCode') ? result.exitCode : 0,
        signal: Object.hasOwn(result, 'signal') ? result.signal : null,
        durationMs: result.durationMs ?? 123,
        timedOut: result.timedOut ?? false,
        matched: result.matched ?? false,
        text: result.text ?? 'wait output',
        truncated: result.truncated ?? false,
      }
    },
    async close(id) {
      calls.closed.push(id)
      return true
    },
    async setTitle(id, title) {
      calls.renamed.push({ id, title })
      return { ...(sessions.get(id)?.info ?? sessionInfo(id, 'interactive', { title })), title }
    },
    resolveCwd: async () => 'C:\\work',
  }
}

/**
 * Plugin double plus a fake context that captures tool definitions.
 * @param {any} [registry] registry double.
 * @param {any} [configOverrides] config overrides.
 * @returns {{ definitions: Map<string, any>, plugin: any }} captured definitions and plugin.
 */
function setup(registry, configOverrides = {}) {
  const definitions = new Map()
  const ctx = {
    effect: (factory) => {
      const dispose = factory()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    tools: {
      register(definition) {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
    },
  }
  const plugin = {
    config: {
      interceptShellTools: true,
      commandTimeoutMs: 180_000,
      maxOutputBytes: 262_144,
      historyPath: '',
      historyPersist: false,
      autoCloseCommandDelayMs: 8000,
      autoCloseFailedDelayMs: 30000,
      autoCloseToolTerminals: true,
      requireSandbox: false,
      allowUnconfined: true,
      ...configOverrides,
    },
    registry,
    logger: {
      infos: [],
      warns: [],
      info(message) {
        this.infos.push(message)
      },
      warn(message) {
        this.warns.push(message)
      },
    },
  }
  registerTools(ctx, plugin)
  return { definitions, plugin, logger: plugin.logger }
}

/**
 * Execute one tool and validate its value/render against its declared schema.
 * @param {Map<string, any>} definitions captured definitions.
 * @param {string} name tool name.
 * @param {any} args tool arguments.
 * @param {any} [execOverrides] execution overrides.
 * @returns {Promise<{ value: any, text: string }>} validated tool outcome.
 */
async function runTool(definitions, name, args, execOverrides = {}) {
  const definition = definitions.get(name)
  assert.ok(definition, `tool ${name} registered`)
  const exec = { agent, signal: new AbortController().signal, ...execOverrides }
  const value = await definition.execute(args, exec)
  assert.deepEqual(validateValue(definition.output.schema, value), [])
  const blocks = definition.output.render(args, value)
  assert.ok(Array.isArray(blocks) && blocks.length > 0)
  assert.equal(blocks[0].type, 'text')
  return { value, text: blocks[0].text }
}

/**
 * @param {any} definition tool definition.
 * @returns {void}
 */
function assertParameterSchema(definition) {
  const parameters = definition.parameters
  assert.equal(parameters.type, 'object', `${definition.name} parameters must be an object-rooted JSON Schema`)
  assert.equal(parameters.additionalProperties, false)
  assert.ok(Array.isArray(parameters.required), `${definition.name} parameters.required must be an array`)
  for (const key of parameters.required) assert.ok(Object.hasOwn(parameters.properties, key))
  for (const [key, property] of Object.entries(parameters.properties)) {
    assert.ok(property.type !== undefined || Array.isArray(property.oneOf), `${definition.name}.${key} needs a JSON Schema type`)
  }
}

test('registers every live_terminal_* tool with JSON Schema parameters', () => {
  const { definitions } = setup(fakeRegistry())
  assert.deepEqual([...definitions.keys()].sort(), [
    'live_terminal_close',
    'live_terminal_exec',
    'live_terminal_expect',
    'live_terminal_export',
    'live_terminal_history',
    'live_terminal_list',
    'live_terminal_open',
    'live_terminal_read',
    'live_terminal_rename',
    'live_terminal_resize',
    'live_terminal_run',
    'live_terminal_screenshot',
    'live_terminal_search',
    'live_terminal_send',
    'live_terminal_signal',
    'live_terminal_status',
    'live_terminal_wait',
  ])
  for (const definition of definitions.values()) {
    assertParameterSchema(definition)
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 20)
    assert.equal(typeof definition.output.schema, 'object')
    assert.equal(typeof definition.output.render, 'function')
  }
})

test('live_terminal_run creates a dedicated command session and returns its id', async () => {
  const registry = fakeRegistry()
  const { definitions } = setup(registry)
  const { value, text } = await runTool(definitions, 'live_terminal_run', {
    command: 'Get-ChildItem',
    description: 'List files',
  })
  assert.deepEqual(value, {
    terminalId: 'command-1',
    title: 'Get-ChildItem',
    cwd: 'C:\\work',
    output: 'command output',
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    stillRunning: false,
    durationMs: 100,
    truncated: false,
    ports: [],
    sandbox: { mode: 'danger-full-access', confined: false, required: false },
  })
  assert.equal(registry.calls.created.length, 1)
  assert.equal(registry.calls.created[0].command, 'Get-ChildItem')
  assert.equal(registry.calls.created[0].agentId, 'agent-1')
  assert.equal(registry.calls.created[0].origin, 'tool')
  assert.equal(registry.calls.created[0].keepOpen, false)
  assert.equal(registry.calls.ensured, 0, 'must not touch the interactive terminal')
  assert.equal(registry.calls.waited.length, 1, 'wait:true goes through waitForCommandSession')
  assert.match(text, /^\[terminal command-1\]/)
  assert.ok(text.includes('command output'))
})

test('live_terminal_run exposes keepOpen and passes it through', async () => {
  const registry = fakeRegistry()
  const { definitions } = setup(registry)
  const runToolDefinition = definitions.get('live_terminal_run')
  const keepOpenProperty = runToolDefinition.parameters.properties.keepOpen
  assert.equal(keepOpenProperty.type, 'boolean')
  assert.match(keepOpenProperty.description, /auto-close|auto close|stay open/i)
  assert.match(runToolDefinition.description, /closes automatically|auto-close/i)

  const { value, text } = await runTool(definitions, 'live_terminal_run', { command: 'Get-Date', keepOpen: true })
  assert.equal(registry.calls.created[0].origin, 'tool')
  assert.equal(registry.calls.created[0].keepOpen, true)
  assert.equal(value.terminalId, 'command-1')
  assert.ok(text.includes('keepOpen:true') || !text.includes('closes automatically'), 'render must not promise auto-close when keepOpen is set')
})

test('live_terminal_screenshot documents formats, scrollback and closed-terminal fallback', () => {
  const { definitions } = setup(fakeRegistry())
  const screenshot = definitions.get('live_terminal_screenshot')
  assert.match(screenshot.description, /format:"text"/)
  assert.match(screenshot.description, /format:"ansi"/)
  assert.match(screenshot.description, /format:"png"/)
  assert.match(screenshot.description, /withScrollback:true/)
  assert.match(screenshot.description, /visible terminal/)
})

test('live_terminal_run render always exposes the terminalId for screenshot follow-up', async () => {
  const registry = fakeRegistry()
  const { definitions } = setup(registry)
  for (const args of [{ command: 'Get-Date' }, { command: 'Get-Date', wait: false }]) {
    const { value, text } = await runTool(definitions, 'live_terminal_run', args)
    assert.ok(text.includes(value.terminalId), `render must mention terminalId ${value.terminalId}`)
  }
})

test('live_terminal_run with wait:false returns immediately without enforcing the timeout', async () => {
  const registry = fakeRegistry()
  const { definitions, logger } = setup(registry)
  const { value, text } = await runTool(definitions, 'live_terminal_run', { command: 'Start-Sleep 5', wait: false })
  // waitForCommandSession enforces timeoutMs by terminating the PTY, so a
  // background command must never go through it (otherwise it is killed after
  // the default 180s with no notification).
  assert.equal(registry.calls.waited.length, 0, 'waitForCommandSession must not be called for wait:false')
  assert.equal(value.stillRunning, true)
  assert.equal(value.output, '')
  assert.equal(value.exitCode, null)
  assert.equal(value.terminalId, 'command-1')
  assert.ok(text.includes('still running'))
  assert.ok(text.includes('live_terminal_wait'))
  assert.ok(text.includes('command-1'))

  // The session exit is still observed and logged.
  registry.command._exit.resolve({ exitCode: 0, signal: null })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(logger.infos.length, 1)
  assert.match(logger.infos[0], /background command command-1 exited \(exitCode=0\)/)
})

test('live_terminal_run with wait:false logs a background command failure', async () => {
  const registry = fakeRegistry()
  const { definitions, logger } = setup(registry)
  await runTool(definitions, 'live_terminal_run', { command: 'boom', wait: false })
  assert.equal(registry.calls.waited.length, 0)
  registry.command._exit.reject(new Error('pty exploded'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(logger.warns.some((line) => line.includes('background command command-1 failed: pty exploded')))
})

test('live_terminal_run maps timeout and abort outcomes', async () => {
  const timeoutRegistry = fakeRegistry({ waitResult: { timedOut: true, exitCode: null, signal: 'SIGTERM' } })
  const timeout = await runTool(setup(timeoutRegistry).definitions, 'live_terminal_run', { command: 'sleep' })
  assert.equal(timeout.value.timedOut, true)
  assert.equal(timeout.value.exitCode, null)
  assert.ok(timeout.text.includes('timed out'))

  const abortRegistry = fakeRegistry({ waitResult: { aborted: true, exitCode: null, signal: 'SIGTERM' } })
  const aborted = await runTool(setup(abortRegistry).definitions, 'live_terminal_run', { command: 'sleep' })
  assert.equal(aborted.value.aborted, true)
  assert.ok(aborted.text.includes('aborted'))
})

test('live_terminal_screenshot defaults to the most recent agent session (command preferred)', async () => {
  const { definitions } = setup(fakeRegistry())
  const { value, text } = await runTool(definitions, 'live_terminal_screenshot', {})
  assert.equal(value.terminalId, 'command-1')
  assert.equal(value.text, 'command screen')
  assert.match(text, /^\[terminal Get-ChildItem 120x30 cursor \(3,4\) exited\]/)
})

test('live_terminal_screenshot honours an explicit terminalId', async () => {
  const { definitions } = setup(fakeRegistry())
  const { value } = await runTool(definitions, 'live_terminal_screenshot', { terminalId: 'terminal-1' })
  assert.equal(value.terminalId, 'terminal-1')
  assert.equal(value.text, 'interactive screen')
})

test('live_terminal_screenshot withScrollback returns scrollback text and format:ansi returns ANSI', async () => {
  const { definitions } = setup(fakeRegistry())
  const { value } = await runTool(definitions, 'live_terminal_screenshot', { withScrollback: true })
  assert.equal(value.text, 'scrollback\ncommand screen')
  assert.equal(value.scrollback, 'scrollback\ncommand screen')
  assert.equal(value.ansi, undefined)

  const ansi = await runTool(definitions, 'live_terminal_screenshot', { format: 'ansi', withScrollback: true })
  assert.equal(ansi.value.ansi, 'ansi-command')
  assert.equal(ansi.value.scrollback, 'scrollback\ncommand screen')
  assert.equal(ansi.value.text, 'command screen', 'format:ansi keeps the visible screen as text')
})

test('live_terminal_screenshot bounds withScrollback text and ANSI', async () => {
  const registry = fakeRegistry()
  const { definitions } = setup(registry, { maxOutputBytes: 8 })
  const { value } = await runTool(definitions, 'live_terminal_screenshot', { withScrollback: true })
  // fullText is 'scrollback\ncommand screen' (24 UTF-8 bytes) → tail-bounded to 8 bytes.
  assert.match(value.text, /^\[scrollback truncated: last 8 bytes\]\n/)
  assert.ok(value.text.endsWith('d screen'))
  assert.deepEqual(registry.command._state.serializeCalls.at(-1), { scrollback: 500 })
  assert.deepEqual(registry.command._state.snapshotCalls.at(-1), { scrollback: 500 })
})

test('live_terminal_screenshot fails clearly when the agent has no visible terminal', async () => {
  const { definitions } = setup(fakeRegistry({ noRecent: true }))
  await assert.rejects(() => runTool(definitions, 'live_terminal_screenshot', {}), /no visible terminal/)
})

test('live_terminal_send defaults to the interactive terminal and creates it lazily', async () => {
  const registry = fakeRegistry({ noDefault: true })
  const { definitions } = setup(registry)
  const { value, text } = await runTool(definitions, 'live_terminal_send', { text: 'hi' })
  assert.deepEqual(value, { ok: true, terminalId: 'terminal-1', sent: 3, keys: [] })
  assert.match(text, /sent 2 bytes to terminal terminal-1 \+ Enter/)
  assert.equal(registry.calls.ensured, 1)
  assert.deepEqual(registry.interactive._state.written, ['hi\r'])
})

test('live_terminal_send supports submit:false and rejects an exited target', async () => {
  const registry = fakeRegistry()
  const { definitions } = setup(registry)
  await runTool(definitions, 'live_terminal_send', { text: '\u0003', submit: false })
  assert.deepEqual(registry.interactive._state.written, ['\u0003'])

  const exited = fakeRegistry()
  exited.interactive.state = 'exited'
  await assert.rejects(
    () => runTool(setup(exited).definitions, 'live_terminal_send', { text: 'x' }),
    /has exited; open a new interactive terminal/,
  )
})

test('live_terminal_read defaults to the interactive terminal without creating one', async () => {
  const { definitions } = setup(fakeRegistry())
  const { value } = await runTool(definitions, 'live_terminal_read', { maxBytes: 2048 })
  assert.equal(value.terminalId, 'terminal-1')
  assert.equal(value.state, 'running')
  assert.equal(value.text, 'recent output (2048)')
  assert.equal(value.truncated, false)
  assert.equal(value.signal, null)
  assert.deepEqual(value.ports, [])

  // With no interactive terminal, no recent command and no history there is
  // nothing to read; the error names the next action.
  const none = setup(fakeRegistry({ empty: true, noDefault: true }))
  await assert.rejects(() => runTool(none.definitions, 'live_terminal_read', {}), /no visible terminal/)
})

test('live_terminal_read/status/screenshot fall back to closed-command history', async () => {
  const entry = {
    id: 'closed-1',
    title: 'build',
    command: 'npm run build',
    cwd: 'C:\\work',
    kind: 'command',
    agentId: 'agent-1',
    exitCode: 1,
    signal: null,
    startedAt: 1000,
    endedAt: 1500,
    durationMs: 500,
    cols: 120,
    rows: 30,
    reason: 'auto-close',
    text: 'build failed output',
    truncated: false,
    ports: [],
    sandbox: { mode: 'danger-full-access', confined: false, required: false },
  }
  const registry = fakeRegistry({ historyEntries: [entry] })

  const read = await runTool(setup(registry).definitions, 'live_terminal_read', { terminalId: 'closed-1' })
  assert.equal(read.value.terminalId, 'closed-1')
  assert.equal(read.value.state, 'exited')
  assert.equal(read.value.text, 'build failed output')
  assert.equal(read.value.exitCode, 1)
  assert.equal(read.value.durationMs, 500)

  const status = await runTool(setup(registry).definitions, 'live_terminal_status', { terminalId: 'closed-1' })
  assert.equal(status.value.terminalId, 'closed-1')
  assert.equal(status.value.running, false)
  assert.equal(status.value.title, 'build')
  assert.equal(status.value.cwd, 'C:\\work')
  assert.equal(status.value.exitCode, 1)

  const shot = await runTool(setup(registry).definitions, 'live_terminal_screenshot', { terminalId: 'closed-1' })
  assert.equal(shot.value.state, 'exited')
  assert.equal(shot.value.text, 'build failed output')
  assert.equal(shot.value.warnings.length, 1)
  assert.match(shot.value.warnings[0], /history/)
})

test('live_terminal_read accepts an explicit command terminal id', async () => {
  const { definitions } = setup(fakeRegistry())
  const { value } = await runTool(definitions, 'live_terminal_read', { terminalId: 'command-1' })
  assert.equal(value.terminalId, 'command-1')
  assert.equal(value.state, 'exited')
  assert.equal(value.exitCode, 0)
  assert.equal(value.durationMs, 100)
})

test('live_terminal_list lists sessions', async () => {
  const { definitions } = setup(fakeRegistry())
  const { value, text } = await runTool(definitions, 'live_terminal_list', {})
  assert.equal(value.terminals.length, 2)
  assert.equal(value.historyCount, 0)
  assert.ok(text.includes('command-1'))
})

test('live_terminal_open creates an interactive session and returns its info', async () => {
  const { definitions } = setup(fakeRegistry())
  const { value, text } = await runTool(definitions, 'live_terminal_open', { title: 'build' })
  assert.equal(value.terminalId, 'terminal-1')
  assert.equal(value.info.id, 'terminal-1')
  assert.ok(text.includes('opened terminal terminal-1'))
})

test('live_terminal_close closes an existing terminal and rejects unknown ids', async () => {
  const registry = fakeRegistry()
  const { definitions } = setup(registry)
  const closed = await runTool(definitions, 'live_terminal_close', { terminalId: 'command-1' })
  assert.deepEqual(closed.value, { ok: true, historyId: 'command-1' })
  assert.deepEqual(registry.calls.closed, ['command-1'])
  await assert.rejects(() => runTool(definitions, 'live_terminal_close', { terminalId: 'missing' }), /not found/)
})

/**
 * Registry with a user-owned terminal and a terminal owned by another agent.
 * @returns {any} registry double.
 */
function ownershipRegistry() {
  const userTerminal = fakeSession('user-1', 'interactive', { owner: 'user', agentId: undefined })
  const crossTerminal = fakeSession('cross-1', 'interactive', { agentId: 'agent-2' })
  return fakeRegistry({ extra: [userTerminal, crossTerminal] })
}

test('live_terminal_list only exposes own and user-owned terminals', async () => {
  const { definitions } = setup(ownershipRegistry())
  const { value } = await runTool(definitions, 'live_terminal_list', {})
  assert.deepEqual(value.terminals.map((terminal) => terminal.id).sort(), [
    'command-1',
    'terminal-1',
    'user-1',
  ])

  const anonymous = await runTool(definitions, 'live_terminal_list', {}, { agent: undefined })
  assert.deepEqual(anonymous.value.terminals.map((terminal) => terminal.id), ['user-1'])
})

test('live_terminal_send only writes to the agent own terminals', async () => {
  const registry = ownershipRegistry()
  const { definitions } = setup(registry)
  await assert.rejects(
    () => runTool(definitions, 'live_terminal_send', { terminalId: 'user-1', text: 'x' }),
    /user-owned and read-only/,
  )
  await assert.rejects(
    () => runTool(definitions, 'live_terminal_send', { terminalId: 'cross-1', text: 'x' }),
    /belongs to another agent/,
  )
  const own = await runTool(definitions, 'live_terminal_send', { terminalId: 'terminal-1', text: 'hi' })
  assert.deepEqual(own.value, { ok: true, terminalId: 'terminal-1', sent: 3, keys: [] })
})

test('live_terminal_read allows user terminals and rejects other agents', async () => {
  const { definitions } = setup(ownershipRegistry())
  const user = await runTool(definitions, 'live_terminal_read', { terminalId: 'user-1' })
  assert.equal(user.value.terminalId, 'user-1')
  await assert.rejects(
    () => runTool(definitions, 'live_terminal_read', { terminalId: 'cross-1' }),
    /belongs to another agent/,
  )
})

test('live_terminal_screenshot allows user terminals and rejects other agents', async () => {
  const { definitions } = setup(ownershipRegistry())
  const user = await runTool(definitions, 'live_terminal_screenshot', { terminalId: 'user-1' })
  assert.equal(user.value.terminalId, 'user-1')
  await assert.rejects(
    () => runTool(definitions, 'live_terminal_screenshot', { terminalId: 'cross-1' }),
    /belongs to another agent/,
  )
})

test('live_terminal_close only closes the agent own terminals', async () => {
  const registry = ownershipRegistry()
  const { definitions } = setup(registry)
  await assert.rejects(
    () => runTool(definitions, 'live_terminal_close', { terminalId: 'user-1' }),
    /user-owned and read-only/,
  )
  await assert.rejects(
    () => runTool(definitions, 'live_terminal_close', { terminalId: 'cross-1' }),
    /belongs to another agent/,
  )
  const own = await runTool(definitions, 'live_terminal_close', { terminalId: 'command-1' })
  assert.deepEqual(own.value, { ok: true, historyId: 'command-1' })
})

test('live_terminal_run forwards cwd, shell, env and dimensions', async () => {
  const registry = fakeRegistry()
  const { definitions } = setup(registry)
  const { value } = await runTool(definitions, 'live_terminal_run', {
    command: 'npm test',
    description: 'Run tests',
    cwd: 'C:\\project',
    shell: 'bash',
    cols: 100,
    rows: 40,
    env: { CI: '1' },
  })
  const created = registry.calls.created[0]
  assert.equal(created.cwd, 'C:\\project')
  assert.equal(created.shellKindHint, 'bash')
  assert.equal(created.cols, 100)
  assert.equal(created.rows, 40)
  assert.deepEqual(created.env, { CI: '1' })
  assert.equal(created.title, 'Run tests')
  assert.equal(value.cwd, 'C:\\work')
  assert.deepEqual(value.ports, [])
  assert.equal(value.sandbox.mode, 'danger-full-access')
})

test('live_terminal_run/open refuse unconfined terminals when requireSandbox is on', async () => {
  const registry = fakeRegistry()
  registry.sandboxFor = () => ({ mode: 'workspace-write', confined: false, required: true })
  const { definitions } = setup(registry, { requireSandbox: true, allowUnconfined: false })
  await assert.rejects(() => runTool(definitions, 'live_terminal_run', { command: 'x' }), /SANDBOX_REQUIRED/)
  await assert.rejects(() => runTool(definitions, 'live_terminal_open', {}), /SANDBOX_REQUIRED/)
  assert.equal(registry.calls.created.length, 0, 'no PTY may be created for a refused call')
})

test('live_terminal_send supports named keys and rejects unknown key names', async () => {
  const registry = fakeRegistry()
  const { definitions } = setup(registry)
  const { value } = await runTool(definitions, 'live_terminal_send', { text: 'npm test', keys: ['Up', 'Enter'] })
  assert.deepEqual(value.keys, ['Up', 'Enter'])
  assert.equal(value.sent, Buffer.byteLength('npm test\u001b[A\r\r', 'utf8'))
  assert.deepEqual(registry.interactive._state.written, ['npm test\u001b[A\r\r'])

  await assert.rejects(
    () => runTool(definitions, 'live_terminal_send', { text: 'x', keys: ['NotAKey'] }),
    /unknown key name/,
  )
})

test('live_terminal_wait waits for exit or a pattern without killing the terminal', async () => {
  const registry = fakeRegistry({
    waitForExitResult: { state: 'exited', exitCode: 0, durationMs: 456, matched: true, text: 'done output' },
  })
  const { definitions } = setup(registry)
  const { value, text } = await runTool(definitions, 'live_terminal_wait', { terminalId: 'command-1', timeoutMs: 5000 })
  assert.equal(value.terminalId, 'command-1')
  assert.equal(value.state, 'exited')
  assert.equal(value.exitCode, 0)
  assert.equal(value.durationMs, 456)
  assert.equal(value.matched, true)
  assert.equal(value.timedOut, false)
  assert.equal(value.text, 'done output')
  assert.match(text, /matched/)
  assert.equal(registry.calls.waitedExit[0].sessionId, 'command-1')
  assert.equal(registry.calls.waitedExit[0].waitOptions.timeoutMs, 5000)
  assert.equal(registry.calls.closed.length, 0, 'waiting must never terminate the process')
})

test('live_terminal_signal delivers signals to the agent own terminal only', async () => {
  const registry = ownershipRegistry()
  const { definitions } = setup(registry)
  const own = await runTool(definitions, 'live_terminal_signal', { terminalId: 'terminal-1', signal: 'SIGTERM' })
  assert.deepEqual(own.value, { ok: true, delivered: 'SIGTERM', terminalId: 'terminal-1' })
  await runTool(definitions, 'live_terminal_signal', { terminalId: 'terminal-1' })
  assert.deepEqual(registry.interactive._state.signals, ['SIGTERM', 'SIGINT'])
  await assert.rejects(
    () => runTool(definitions, 'live_terminal_signal', { terminalId: 'user-1' }),
    /user-owned and read-only/,
  )
})

test('live_terminal_resize resizes a running terminal and rejects an exited one', async () => {
  const registry = fakeRegistry()
  const { definitions } = setup(registry)
  const { value } = await runTool(definitions, 'live_terminal_resize', { terminalId: 'terminal-1', cols: 100.7, rows: 40.2 })
  assert.deepEqual(value, { ok: true, terminalId: 'terminal-1', cols: 100, rows: 40 })
  assert.equal(registry.interactive.cols, 100)
  assert.equal(registry.interactive.rows, 40)

  registry.interactive.state = 'exited'
  await assert.rejects(
    () => runTool(definitions, 'live_terminal_resize', { terminalId: 'terminal-1', cols: 80, rows: 24 }),
    /has exited/,
  )
})

test('live_terminal_rename renames the agent own terminal', async () => {
  const registry = fakeRegistry()
  const { definitions } = setup(registry)
  const { value } = await runTool(definitions, 'live_terminal_rename', { terminalId: 'terminal-1', title: ' build ' })
  assert.equal(value.ok, true)
  assert.equal(value.info.title, 'build')
  assert.deepEqual(registry.calls.renamed, [{ id: 'terminal-1', title: 'build' }])
  await assert.rejects(
    () => runTool(definitions, 'live_terminal_rename', { terminalId: 'terminal-1', title: '  ' }),
    /non-empty/,
  )
})

test('live_terminal_search finds lines with context and validates the regex', async () => {
  const { definitions } = setup(fakeRegistry())
  const { value } = await runTool(definitions, 'live_terminal_search', {
    terminalId: 'command-1',
    pattern: 'screen',
    contextLines: 1,
  })
  assert.equal(value.terminalId, 'command-1')
  assert.equal(value.totalLines, 2)
  assert.deepEqual(value.matches, [{ line: 2, text: 'command screen', before: ['scrollback'], after: [] }])
  assert.equal(value.truncated, false)

  await assert.rejects(
    () => runTool(definitions, 'live_terminal_search', { terminalId: 'command-1', pattern: '(', regex: true }),
    /invalid regular expression/,
  )
})

test('live_terminal_history lists recently closed commands', async () => {
  const entry = {
    id: 'closed-1',
    title: 'build',
    command: 'npm run build',
    cwd: 'C:\\work',
    kind: 'command',
    agentId: 'agent-1',
    exitCode: 0,
    signal: null,
    startedAt: 1000,
    endedAt: 1500,
    durationMs: 500,
    cols: 120,
    rows: 30,
    reason: 'auto-close',
    text: 'build output',
    truncated: false,
    ports: [],
    sandbox: { mode: 'danger-full-access', confined: false, required: false },
  }
  const registry = fakeRegistry({ historyEntries: [entry] })
  const { value } = await runTool(setup(registry).definitions, 'live_terminal_history', {})
  assert.equal(value.entries.length, 1)
  assert.equal(value.entries[0].id, 'closed-1')
  assert.equal(value.entries[0].reason, 'auto-close')
})

test('live_terminal_export returns inline text or ANSI output', async () => {
  const { definitions } = setup(fakeRegistry())
  const text = await runTool(definitions, 'live_terminal_export', { terminalId: 'command-1' })
  assert.equal(text.value.terminalId, 'command-1')
  assert.equal(text.value.text, 'text-export')
  assert.equal(text.value.path, undefined)
  assert.ok(text.value.bytes > 0)

  const ansi = await runTool(definitions, 'live_terminal_export', { terminalId: 'command-1', format: 'ansi' })
  assert.equal(ansi.value.text, 'ansi-export')
})

test('live_terminal_exec rejects an exited terminal before executing', async () => {
  const registry = fakeRegistry()
  registry.interactive.state = 'exited'
  await assert.rejects(
    () => runTool(setup(registry).definitions, 'live_terminal_exec', { command: 'pwd' }),
    /has exited/,
  )
})

test('tools fail clearly when the terminal backend is unavailable', async () => {
  const { definitions } = setup(undefined)
  await assert.rejects(() => runTool(definitions, 'live_terminal_list', {}), /backend is unavailable/)
  await assert.rejects(() => runTool(definitions, 'live_terminal_run', { command: 'x' }), /backend is unavailable/)
})

test('tools fail clearly without an initiating agent', async () => {
  const { definitions } = setup(fakeRegistry())
  await assert.rejects(
    () => runTool(definitions, 'live_terminal_run', { command: 'x' }, { agent: undefined }),
    /requires an initiating agent/,
  )
})
