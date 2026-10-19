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
  const state = { written: [], snapshots: 0, serializeCalls: [], snapshotCalls: [] }
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
    plainTail(maxBytes) {
      return { text: `recent output (${maxBytes})`, truncated: false }
    },
    visibleText() {
      return kind === 'command' ? 'command screen' : 'interactive screen'
    },
    fullText() {
      return kind === 'command' ? 'scrollback\ncommand screen' : 'scrollback\ninteractive screen'
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
  for (const extra of options.extra ?? []) sessions.set(extra.id, extra)
  const calls = { created: [], waited: [], ensured: 0, closed: [] }
  return {
    calls,
    command,
    interactive,
    sessions: [...sessions.values()],
    list: () => [...sessions.values()].map((session) => session.info),
    lookup: (id) => sessions.get(id),
    resolveForAgent: () => (options.noDefault === true ? undefined : interactive),
    resolveRecentForAgent: () => (options.noRecent === true ? undefined : command),
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
    async close(id) {
      calls.closed.push(id)
      return true
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
    config: { interceptShellTools: true, commandTimeoutMs: 180_000, maxOutputBytes: 262_144, ...configOverrides },
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

test('registers exactly the seven live_terminal_* tools with JSON Schema parameters', () => {
  const { definitions } = setup(fakeRegistry())
  assert.deepEqual([...definitions.keys()].sort(), [
    'live_terminal_close',
    'live_terminal_list',
    'live_terminal_open',
    'live_terminal_read',
    'live_terminal_run',
    'live_terminal_screenshot',
    'live_terminal_send',
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
    output: 'command output',
    exitCode: 0,
    timedOut: false,
    aborted: false,
    stillRunning: false,
  })
  assert.equal(registry.calls.created.length, 1)
  assert.equal(registry.calls.created[0].command, 'Get-ChildItem')
  assert.equal(registry.calls.created[0].agentId, 'agent-1')
  assert.equal(registry.calls.ensured, 0, 'must not touch the interactive terminal')
  assert.equal(registry.calls.waited.length, 1, 'wait:true goes through waitForCommandSession')
  assert.match(text, /^\[terminal command-1\]/)
  assert.ok(text.includes('command output'))
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
  assert.ok(text.includes('keeps running until it exits or the terminal is closed'))
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

test('live_terminal_screenshot withScrollback returns scrollback text and ANSI', async () => {
  const { definitions } = setup(fakeRegistry())
  const { value } = await runTool(definitions, 'live_terminal_screenshot', { withScrollback: true })
  assert.equal(value.text, 'scrollback\ncommand screen')
  assert.ok(value.ansi.includes('ansi-command'))
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
  const { value } = await runTool(definitions, 'live_terminal_send', { text: 'hi' })
  assert.deepEqual(value, { ok: true, terminalId: 'terminal-1' })
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

  const none = setup(fakeRegistry({ noDefault: true }))
  await assert.rejects(() => runTool(none.definitions, 'live_terminal_read', {}), /no default interactive terminal/)
})

test('live_terminal_read accepts an explicit command terminal id', async () => {
  const { definitions } = setup(fakeRegistry())
  const { value } = await runTool(definitions, 'live_terminal_read', { terminalId: 'command-1' })
  assert.equal(value.terminalId, 'command-1')
  assert.equal(value.state, 'exited')
})

test('live_terminal_list lists sessions', async () => {
  const { definitions } = setup(fakeRegistry())
  const { value, text } = await runTool(definitions, 'live_terminal_list', {})
  assert.equal(value.terminals.length, 2)
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
  assert.deepEqual(closed.value, { ok: true })
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
  assert.deepEqual(own.value, { ok: true, terminalId: 'terminal-1' })
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
  assert.deepEqual(own.value, { ok: true })
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
