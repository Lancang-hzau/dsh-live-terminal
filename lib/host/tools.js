/**
 * Model-facing `live_terminal_*` tools.
 *
 * Definitions use hand-written JSON Schema (no schema DSL) and are registered
 * directly through `ctx.tools.register`, because this plugin is not part of the
 * DeepSeek Harness package tree and must not import `@deepseek-ai/*`.
 *
 * The `live_` prefix avoids colliding with the official experimental
 * persistent-terminal bundle's `terminal_*` tools.
 */

/** Largest model-facing tool text; longer output keeps the tail. */
const MAX_RENDER_CHARS = 16_000
/** Default byte bound for `live_terminal_read`. */
const DEFAULT_READ_BYTES = 16 * 1024

/** Shared SessionInfo JSON Schema (must stay in sync with session.js `info`). */
const SESSION_INFO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    kind: { type: 'string', enum: ['command', 'interactive'] },
    owner: { type: 'string', enum: ['agent', 'user'] },
    sessionId: { type: 'string' },
    agentId: { type: 'string' },
    command: { type: 'string' },
    cwd: { type: 'string' },
    cols: { type: 'integer' },
    rows: { type: 'integer' },
    state: { type: 'string', enum: ['running', 'exited', 'failed'] },
    exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    error: { type: 'string' },
    createdAt: { type: 'number' },
    updatedAt: { type: 'number' },
  },
  required: ['id', 'title', 'kind', 'owner', 'cwd', 'cols', 'rows', 'state', 'exitCode', 'createdAt', 'updatedAt'],
}

const CURSOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    x: { type: 'integer' },
    y: { type: 'integer' },
  },
  required: ['x', 'y'],
}

/**
 * Register every `live_terminal_*` tool.
 * @param {any} ctx plugin context (tools service already injected).
 * @param {{ get registry(): any, config: object, logger?: any }} plugin host plugin state.
 * @returns {void}
 */
export function registerTools(ctx, plugin) {
  const config = plugin.config
  const register = (definition) => {
    ctx.effect(() => ctx.tools.register(definition), `dsh-live-terminal: tool ${definition.name}`)
  }

  register({
    name: 'live_terminal_run',
    description:
      'Run a command in its own new visible terminal in the terminal panel, so the user can watch it live. This is a one-shot command terminal (not the interactive shell used by live_terminal_send): each call opens a separate terminal, so output stays clean and no shell prompt/marker text pollutes the screen. Returns the terminalId, the captured output and the exit code. Use the returned terminalId with live_terminal_screenshot to read the screen afterwards; use wait:false for a long-running command and follow up with live_terminal_screenshot/live_terminal_read.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: { type: 'string', description: 'PowerShell command to run in the visible command terminal.' },
        description: { type: 'string', description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI).' },
        wait: { type: 'boolean', description: 'Wait for completion (default true). Set false to return immediately while the command keeps running; follow up with live_terminal_screenshot or live_terminal_read.' },
        timeoutMs: { type: 'number', description: 'Maximum wait in milliseconds before the command terminal is terminated (default from plugin config).' },
      },
      required: ['command'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          terminalId: { type: 'string' },
          title: { type: 'string' },
          output: { type: 'string' },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          timedOut: { type: 'boolean' },
          aborted: { type: 'boolean' },
          stillRunning: { type: 'boolean' },
        },
        required: ['terminalId', 'title', 'output', 'exitCode', 'timedOut', 'aborted', 'stillRunning'],
      },
      render: (args, value) => textContent(renderRun(args, value, config)),
    },
    async execute(args, exec) {
      const registry = requireRegistry(plugin)
      const agent = requireAgent(exec)
      const command = typeof args.command === 'string' ? args.command : ''
      if (command.trim().length === 0) throw new Error('command must be a non-empty string')
      const timeoutMs = positiveNumber(args.timeoutMs) ?? config.commandTimeoutMs
      const session = await registry.createCommandSession({
        command,
        agent,
        agentId: agent.id,
        sessionId: agent.session?.id,
        timeoutMs,
        signal: exec.signal,
      })
      if (args.wait === false) {
        registry
          .waitForCommandSession(session, { timeoutMs })
          .catch((error) => plugin.logger?.warn?.(`[dsh-live-terminal] background command failed: ${error instanceof Error ? error.message : String(error)}`))
        return {
          terminalId: session.id,
          title: session.title,
          output: '',
          exitCode: null,
          timedOut: false,
          aborted: false,
          stillRunning: true,
        }
      }
      const result = await registry.waitForCommandSession(session, { timeoutMs, signal: exec.signal })
      return {
        terminalId: session.id,
        title: session.title,
        output: result.output,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        aborted: result.aborted,
        stillRunning: false,
      }
    },
  })

  register({
    name: 'live_terminal_screenshot',
    description:
      'Take a text screenshot of the visible terminal panel (the current screen, as the user sees it). Without terminalId it captures the agent\'s most recent visible terminal (preferring the command terminal created by live_terminal_run), so it can be called right after a run. Use it to inspect TUI/full-screen programs or finished command output. Optionally include the retained scrollback and its ANSI serialization.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        terminalId: { type: 'string', description: 'Terminal id from live_terminal_run/list/open; defaults to the agent\'s most recent visible terminal (command preferred).' },
        withScrollback: { type: 'boolean', description: 'Include retained scrollback text and ANSI serialization (default false).' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          terminalId: { type: 'string' },
          title: { type: 'string' },
          state: { type: 'string', enum: ['running', 'exited', 'failed'] },
          cols: { type: 'integer' },
          rows: { type: 'integer' },
          cursor: CURSOR_SCHEMA,
          text: { type: 'string' },
          ansi: { type: 'string' },
        },
        required: ['terminalId', 'title', 'state', 'cols', 'rows', 'cursor', 'text'],
      },
      render: (_args, value) => textContent(renderScreenshot(value)),
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const session = resolveForScreenshot(plugin, agent, args.terminalId)
      const snapshot = session.snapshot()
      const withScrollback = args.withScrollback === true
      const value = {
        terminalId: session.id,
        title: session.title,
        state: session.state,
        cols: session.cols,
        rows: session.rows,
        cursor: snapshot.cursor,
        text: withScrollback ? session.fullText() : session.visibleText(),
      }
      if (withScrollback) value.ansi = snapshot.screen
      return value
    },
  })

  register({
    name: 'live_terminal_send',
    description:
      'Send raw text to the agent\'s interactive terminal in the visible terminal panel. By default Enter is submitted after the text; set submit false for control characters or incomplete REPL input. Use this for interactive programs, prompts and Ctrl-C (`\\u0003`). The interactive terminal is created on first use; use live_terminal_open to create an additional visible interactive terminal.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        terminalId: { type: 'string', description: 'Terminal id; defaults to the agent\'s interactive terminal (created lazily).' },
        text: { type: 'string', description: 'UTF-8 text to write (may contain control characters).' },
        submit: { type: 'boolean', description: 'Append Enter after the text (default true).' },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', const: true },
          terminalId: { type: 'string' },
        },
        required: ['ok', 'terminalId'],
      },
      render: (args, value) => {
        const bytes = Buffer.byteLength(String(args.text ?? ''), 'utf8')
        const submit = args.submit === false ? ' (no Enter)' : ' + Enter'
        return textContent(`sent ${bytes} bytes to terminal ${value.terminalId}${submit}`)
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const session = await resolveForSend(plugin, agent, args.terminalId, exec.signal)
      if (session.state !== 'running') {
        throw new Error(`terminal ${session.id} has exited; open a new interactive terminal with live_terminal_open first`)
      }
      const text = typeof args.text === 'string' ? args.text : ''
      await session.write(text + (args.submit === false ? '' : '\r'))
      return { ok: true, terminalId: session.id }
    },
  })

  register({
    name: 'live_terminal_read',
    description:
      'Read the tail of the recent plain-text output of a visible terminal (ANSI stripped) without sending input. Use the terminalId returned by live_terminal_run to read a command terminal (including one started with wait:false); without terminalId it reads the agent\'s interactive terminal.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        terminalId: { type: 'string', description: 'Terminal id; defaults to the agent\'s interactive terminal.' },
        maxBytes: { type: 'number', description: 'Maximum retained UTF-8 bytes to return (default 16384).' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          terminalId: { type: 'string' },
          state: { type: 'string', enum: ['running', 'exited', 'failed'] },
          text: { type: 'string' },
        },
        required: ['terminalId', 'state', 'text'],
      },
      render: (_args, value) => textContent(boundText(value.text.length > 0 ? value.text : '(no retained output)')),
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const session = resolveForRead(plugin, agent, args.terminalId)
      const requested = positiveNumber(args.maxBytes)
      const maxBytes = requested === undefined ? DEFAULT_READ_BYTES : Math.min(Math.floor(requested), config.maxOutputBytes)
      const tail = session.plainTail(maxBytes)
      return { terminalId: session.id, state: session.state, text: tail.text }
    },
  })

  register({
    name: 'live_terminal_list',
    description: 'List the terminals of the visible terminal panel with their ids, kinds and lifecycle states.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          terminals: { type: 'array', items: SESSION_INFO_SCHEMA },
        },
        required: ['terminals'],
      },
      render: (_args, value) => textContent(renderList(value.terminals)),
    },
    async execute() {
      const registry = requireRegistry(plugin)
      return { terminals: registry.list() }
    },
  })

  register({
    name: 'live_terminal_open',
    description:
      'Open a new visible interactive terminal in the terminal panel. Use this for interactive programs, REPLs or long-lived shells the user should watch. Returns the new terminal id.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Display title for the new terminal.' },
        cwd: { type: 'string', description: 'Working directory (absolute, or relative to the session workspace).' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          terminalId: { type: 'string' },
          info: SESSION_INFO_SCHEMA,
        },
        required: ['terminalId', 'info'],
      },
      render: (_args, value) =>
        textContent(`opened terminal ${value.terminalId}: ${value.info.title} (${value.info.cols}x${value.info.rows}) in ${value.info.cwd}`),
    },
    async execute(args, exec) {
      const registry = requireRegistry(plugin)
      const agent = requireAgent(exec)
      const session = await registry.createInteractive({
        agent,
        agentId: agent.id,
        sessionId: agent.session?.id,
        owner: 'agent',
        title: typeof args.title === 'string' && args.title.trim().length > 0 ? args.title.trim().slice(0, 200) : undefined,
        cwd: typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : undefined,
        signal: exec.signal,
      })
      await session.waitReady({ signal: exec.signal })
      return { terminalId: session.id, info: session.info }
    },
  })

  register({
    name: 'live_terminal_close',
    description: 'Close one visible terminal and terminate its process tree.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        terminalId: { type: 'string', description: 'Terminal id to close.' },
      },
      required: ['terminalId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', const: true },
        },
        required: ['ok'],
      },
      render: (args, value) => textContent(`closed terminal ${String(args.terminalId ?? '')}${value.ok === true ? '' : ' (unknown outcome)'}`),
    },
    async execute(args, exec) {
      const registry = requireRegistry(plugin)
      if (typeof args.terminalId !== 'string' || args.terminalId.length === 0) throw new Error('terminalId is required')
      if (registry.lookup(args.terminalId) === undefined) throw new Error(`terminal ${args.terminalId} not found`)
      await registry.close(args.terminalId)
      return { ok: true }
    },
  })
}

/**
 * Resolve an explicitly addressed session.
 * @param {any} registry terminal registry.
 * @param {string} terminalId explicit terminal id.
 * @returns {any} session.
 */
function requireExplicit(registry, terminalId) {
  if (typeof terminalId !== 'string' || terminalId.length === 0) throw new Error('terminalId must be a non-empty string')
  const session = registry.lookup(terminalId)
  if (session === undefined) throw new Error(`terminal ${terminalId} not found`)
  return session
}

/**
 * Resolve the send target: explicit id, else the agent's default interactive
 * terminal, creating that terminal lazily on first use.
 * @param {{ get registry(): any }} plugin plugin state.
 * @param {any} agent owning agent.
 * @param {string | undefined} terminalId explicit id.
 * @param {AbortSignal} [signal] creation cancellation.
 * @returns {Promise<any>} interactive session.
 */
async function resolveForSend(plugin, agent, terminalId, signal) {
  const registry = requireRegistry(plugin)
  if (typeof terminalId === 'string' && terminalId.length > 0) return requireExplicit(registry, terminalId)
  const existing = registry.resolveForAgent(agent)
  if (existing !== undefined) return existing
  return registry.ensureAgentTerminal(agent, { signal })
}

/**
 * Resolve the read target: explicit id, else the agent's default interactive
 * terminal. Reading never creates a terminal implicitly.
 * @param {{ get registry(): any }} plugin plugin state.
 * @param {any} agent owning agent.
 * @param {string | undefined} terminalId explicit id.
 * @returns {any} session.
 */
function resolveForRead(plugin, agent, terminalId) {
  const registry = requireRegistry(plugin)
  if (typeof terminalId === 'string' && terminalId.length > 0) return requireExplicit(registry, terminalId)
  const existing = registry.resolveForAgent(agent)
  if (existing === undefined) {
    throw new Error('no default interactive terminal for this agent; use live_terminal_open or live_terminal_send first, or pass a terminalId from live_terminal_run')
  }
  return existing
}

/**
 * Resolve the screenshot target: explicit id, else the agent's most recent
 * visible terminal (preferring a command terminal).
 * @param {{ get registry(): any }} plugin plugin state.
 * @param {any} agent owning agent.
 * @param {string | undefined} terminalId explicit id.
 * @returns {any} session.
 */
function resolveForScreenshot(plugin, agent, terminalId) {
  const registry = requireRegistry(plugin)
  if (typeof terminalId === 'string' && terminalId.length > 0) return requireExplicit(registry, terminalId)
  const recent = registry.resolveRecentForAgent(agent)
  if (recent === undefined) {
    throw new Error('no visible terminal for this agent yet; run a command with live_terminal_run or open a terminal with live_terminal_open first')
  }
  return recent
}

/**
 * @param {{ get registry(): any }} plugin plugin state.
 * @returns {any} terminal registry.
 */
function requireRegistry(plugin) {
  const registry = plugin.registry
  if (registry === undefined) {
    throw new Error('the visible terminal backend is unavailable (subprocess/workingDirectory services are missing)')
  }
  return registry
}

/**
 * @param {any} exec tool execution context.
 * @returns {any} owning agent.
 */
function requireAgent(exec) {
  const agent = exec?.agent
  if (agent === undefined || agent === null) throw new Error('this terminal tool requires an initiating agent')
  return agent
}

/**
 * @param {unknown} value candidate number.
 * @returns {number | undefined} positive finite number.
 */
function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * @param {string} text model-facing text.
 * @returns {{ type: 'text', text: string }[]} content blocks.
 */
function textContent(text) {
  return [{ type: 'text', text }]
}

/**
 * Bound one model-facing text while keeping its tail.
 * @param {string} text content.
 * @returns {string} bounded content.
 */
function boundText(text) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= MAX_RENDER_CHARS) return value
  return `[output truncated: showing the last ${MAX_RENDER_CHARS} characters]\n${value.slice(-MAX_RENDER_CHARS)}`
}

/**
 * Render one `live_terminal_run` result.
 *
 * The first line always exposes the terminalId: the model needs it to call
 * live_terminal_screenshot / live_terminal_read on the command terminal.
 *
 * @param {any} args tool arguments.
 * @param {any} value tool value.
 * @param {any} config plugin config.
 * @returns {string} model-facing text.
 */
function renderRun(args, value, config) {
  const lines = []
  const status = value.stillRunning
    ? 'running'
    : value.timedOut
      ? 'timed out'
      : value.aborted
        ? 'aborted'
        : value.exitCode === null
          ? 'exited'
          : `exit ${value.exitCode}`
  lines.push(`[terminal ${value.terminalId}] ${value.title} (${status})`)
  lines.push(value.output.length > 0 ? value.output : '(no output)')
  if (value.timedOut) lines.push(`[timed out after ${positiveNumber(args.timeoutMs) ?? config.commandTimeoutMs}ms; terminal terminated]`)
  if (value.aborted) lines.push('[aborted; terminal terminated]')
  if (value.stillRunning) {
    lines.push(`[still running; use live_terminal_screenshot or live_terminal_read with terminalId ${value.terminalId} to follow it]`)
  }
  if (!value.timedOut && !value.aborted && value.exitCode !== null && value.exitCode !== 0) {
    lines.push(`[exit code: ${value.exitCode}]`)
  }
  return boundText(lines.join('\n'))
}

/**
 * Render one `live_terminal_screenshot` result.
 * @param {any} value tool value.
 * @returns {string} model-facing text.
 */
function renderScreenshot(value) {
  const header = `[terminal ${value.title} ${value.cols}x${value.rows} cursor (${value.cursor.x},${value.cursor.y}) ${value.state}]`
  return boundText(`${header}\n${value.text.length > 0 ? value.text : '(empty screen)'}`)
}

/**
 * Render one `live_terminal_list` result.
 * @param {any[]} terminals session infos.
 * @returns {string} model-facing text.
 */
function renderList(terminals) {
  if (terminals.length === 0) return '(no terminal sessions)'
  return terminals
    .map((session) => {
      const status = session.state === 'running' ? 'running' : `${session.state} exit=${session.exitCode ?? 'null'}`
      return `${session.id} [${session.kind}/${session.owner}] ${status} ${session.cols}x${session.rows} ${session.title} (${session.cwd})`
    })
    .join('\n')
}
