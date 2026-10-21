/**
 * Model-facing `live_terminal_*` tools (v1.2.1).
 *
 * Definitions use hand-written JSON Schema (no schema DSL) and are registered
 * directly through `ctx.tools.register`, because this plugin is not part of the
 * DeepSeek Harness package tree and must not import `@deepseek-ai/*`.
 *
 * The `live_` prefix avoids colliding with the official experimental
 * persistent-terminal bundle's `terminal_*` tools.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { tailByBytes } from './ring.js'
import { bracketPaste, keySequence } from './keys.js'
import { execInSession } from './exec.js'

/** Largest model-facing tool text (characters). */
const MAX_RENDER_CHARS = 6000
/** Largest model-facing tool text (UTF-8 bytes). */
const MAX_RENDER_BYTES = 12 * 1024
/** Default byte bound for `live_terminal_read`. */
const DEFAULT_READ_BYTES = 16 * 1024
/** Scrollback rows serialized into a `withScrollback` screenshot. */
const SCREENSHOT_SCROLLBACK = 500
/** Export files larger than this are written to disk instead of returned inline. */
const EXPORT_INLINE_BYTES = 100 * 1024
/** Maximum accepted search pattern length. */
const MAX_PATTERN_CHARS = 200

/** Shared JSON Schemas. */
const PORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string' },
    port: { type: 'integer' },
    host: { type: 'string' },
    firstSeenAt: { type: 'number' },
    lastSeenAt: { type: 'number' },
  },
  required: ['url', 'port', 'host'],
}

const SANDBOX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string' },
    confined: { type: 'boolean' },
    required: { type: 'boolean' },
  },
  required: ['mode', 'confined', 'required'],
}

const SESSION_INFO_SCHEMA = {
  type: 'object',
  // Tolerant on purpose: the registry may add display-only fields in a patch
  // release without invalidating every tool result.
  additionalProperties: true,
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
    signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    error: { type: 'string' },
    createdAt: { type: 'number' },
    updatedAt: { type: 'number' },
    startedAt: { type: 'number' },
    endedAt: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    durationMs: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    shellKind: { type: 'string' },
    ports: { type: 'array', items: PORT_SCHEMA },
    sandbox: SANDBOX_SCHEMA,
    autoCloseAt: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    autoClosePaused: { type: 'boolean' },
    pinned: { type: 'boolean' },
  },
  required: ['id', 'title', 'kind', 'owner', 'cwd', 'cols', 'rows', 'state', 'exitCode', 'createdAt', 'updatedAt'],
}

const HISTORY_ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    command: { type: 'string' },
    cwd: { type: 'string' },
    kind: { type: 'string', const: 'command' },
    exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    startedAt: { type: 'number' },
    endedAt: { type: 'number' },
    durationMs: { type: 'number' },
    cols: { type: 'integer' },
    rows: { type: 'integer' },
    reason: { type: 'string', enum: ['auto-close', 'closed', 'failed'] },
    text: { type: 'string' },
    truncated: { type: 'boolean' },
    ports: { type: 'array', items: PORT_SCHEMA },
    sandbox: SANDBOX_SCHEMA,
  },
  required: ['id', 'title', 'command', 'cwd', 'exitCode', 'startedAt', 'endedAt', 'durationMs', 'text', 'truncated'],
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

const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string' },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  },
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
}

/**
 * Register every `live_terminal_*` tool.
 * @param {any} ctx plugin context (tools service already injected).
 * @param {{ get registry(): any, config: object, logger?: any, getAttachments?: () => any, resolveSandboxPolicy?: (agent: any) => any }} plugin plugin state.
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
      'Run a command in its own new visible terminal in the terminal panel, so the user can watch it live. This is a one-shot command terminal (not the interactive shell used by live_terminal_send): each call opens a separate terminal, so output stays clean and no shell prompt/marker text pollutes the screen. Returns the terminalId, the captured output, exit code, signal and duration. Use the returned terminalId with live_terminal_screenshot to read the screen afterwards; use wait:false for a long-running command and follow up with live_terminal_wait/live_terminal_screenshot/live_terminal_read. The terminal closes automatically shortly after the command exits (8s on success, 30s on failure); pass keepOpen:true to keep it open for later screenshots or inspection.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: { type: 'string', description: 'Command to run in the visible command terminal, in the selected shell dialect.' },
        description: { type: 'string', description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI as the terminal title).' },
        wait: { type: 'boolean', description: 'Wait for completion (default true). Set false to return immediately: the command keeps running until it exits or the terminal is closed (it is not killed by timeoutMs); follow up with live_terminal_wait, live_terminal_screenshot or live_terminal_read.' },
        timeoutMs: { type: 'number', description: 'When wait is true, maximum wait in milliseconds before the command terminal is terminated (default from plugin config). Ignored when wait is false.' },
        keepOpen: { type: 'boolean', description: 'Keep the terminal open after the command finishes (default false = auto-close shortly after exit, so it does not pile up tabs). Use true when the user should inspect the final screen later.' },
        cwd: { type: 'string', description: 'Working directory (absolute, or relative to the session workspace). Defaults to the agent session workspace.' },
        shell: { type: 'string', enum: ['pwsh', 'bash', 'cmd'], description: 'Shell dialect to run the command in. Defaults to the platform default (PowerShell on Windows, bash on POSIX).' },
        cols: { type: 'integer', description: 'Initial terminal columns (default: the panel width).' },
        rows: { type: 'integer', description: 'Initial terminal rows (default: the panel height).' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment variables for this command only.' },
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
          cwd: { type: 'string' },
          output: { type: 'string' },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          timedOut: { type: 'boolean' },
          aborted: { type: 'boolean' },
          stillRunning: { type: 'boolean' },
          durationMs: { type: 'number' },
          truncated: { type: 'boolean' },
          ports: { type: 'array', items: PORT_SCHEMA },
          sandbox: SANDBOX_SCHEMA,
        },
        required: ['terminalId', 'title', 'cwd', 'output', 'exitCode', 'signal', 'timedOut', 'aborted', 'stillRunning', 'durationMs', 'truncated', 'ports', 'sandbox'],
      },
      render: (args, value) => textContent(renderRun(args, value, config)),
    },
    async execute(args, exec) {
      const registry = requireRegistry(plugin)
      const agent = requireAgent(exec)
      const command = typeof args.command === 'string' ? args.command : ''
      if (command.trim().length === 0) throw new Error('command must be a non-empty string')
      const sandbox = sandboxFor(plugin, agent)
      if (requiresSandbox(config, sandbox) && sandbox.mode !== 'danger-full-access') {
        throw new Error(`SANDBOX_REQUIRED: this deployment requires the DSH file sandbox (mode=${sandbox.mode}); live_terminal_run would run unconfined. Use the built-in pwsh/bash tool instead, or set allowUnconfined/requireSandbox accordingly.`)
      }
      const timeoutMs = positiveNumber(args.timeoutMs) ?? config.commandTimeoutMs
      const session = await registry.createCommandSession({
        command,
        agent,
        agentId: agent.id,
        sessionId: agent.session?.id,
        cwd: typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : undefined,
        cols: positiveInteger(args.cols),
        rows: positiveInteger(args.rows),
        env: normalizeEnv(args.env),
        timeoutMs,
        signal: exec.signal,
        title: typeof args.description === 'string' && args.description.trim().length > 0
          ? args.description.trim().slice(0, 200)
          : undefined,
        shellKindHint: normalizeShell(args.shell),
        // Tool-created command terminals are auto-closed after they finish
        // (configurable via autoCloseToolTerminals); keepOpen opts out.
        origin: 'tool',
        keepOpen: args.keepOpen === true,
      })
      const info = session.info ?? session
      const sandboxInfo = info.sandbox ?? session.sandbox ?? sandbox
      if (args.wait === false) {
        // Do NOT route the background command through waitForCommandSession:
        // that helper enforces the timeout by terminating the session, which
        // would silently kill a long-running command. Only observe the exit so
        // the outcome still reaches the host log.
        void session.whenExited.then(
          (outcome) => plugin.logger?.info?.(`[dsh-live-terminal] background command ${session.id} exited (exitCode=${outcome?.exitCode ?? 'null'})`),
          (error) => plugin.logger?.warn?.(`[dsh-live-terminal] background command ${session.id} failed: ${error instanceof Error ? error.message : String(error)}`),
        )
        return {
          terminalId: info.id ?? session.id,
          title: info.title ?? session.title,
          cwd: info.cwd ?? session.cwd ?? '',
          output: '',
          exitCode: null,
          signal: null,
          timedOut: false,
          aborted: false,
          stillRunning: true,
          durationMs: 0,
          truncated: false,
          ports: infoPorts(session),
          sandbox: sandboxInfo,
        }
      }
      const result = await registry.waitForCommandSession(session, { timeoutMs, signal: exec.signal })
      return {
        terminalId: info.id ?? session.id,
        title: info.title ?? session.title,
        cwd: info.cwd ?? session.cwd ?? '',
        output: result.output,
        exitCode: result.exitCode,
        signal: result.signal ?? null,
        timedOut: result.timedOut,
        aborted: result.aborted,
        stillRunning: false,
        durationMs: durationOf(session),
        truncated: result.truncated === true,
        ports: infoPorts(session),
        sandbox: info.sandbox ?? session.sandbox ?? sandboxInfo,
      }
    },
    isConcurrencySafe: () => false,
  })

  register({
    name: 'live_terminal_screenshot',
    description:
      'Take a screenshot of a visible terminal (the current screen, as the user sees it). Without terminalId it captures the agent\'s most recently active visible terminal (running preferred). format:"text" (default) returns plain visible text; format:"ansi" returns the ANSI screen; format:"png" asks the connected browser to render the screen as an image attachment (falls back to text + warnings when no browser is attached). Use withScrollback:true for the retained scrollback text. Works for TUI/full-screen programs. Only terminals visible to this agent (its own terminals and the user\'s read-only terminals) can be captured.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        terminalId: { type: 'string', description: 'Terminal id from live_terminal_run/list/open; defaults to the agent\'s most recently active visible terminal.' },
        format: { type: 'string', enum: ['text', 'ansi', 'png'], description: 'Output format (default text). png returns an image block when a browser is attached.' },
        withScrollback: { type: 'boolean', description: 'Include retained scrollback text (default false). Legacy alias for scrollback.' },
        scrollback: { type: 'boolean', description: 'Include retained scrollback text (default false).' },
        maxBytes: { type: 'number', description: 'Maximum scrollback/screen bytes to return (default 16KB).' },
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
          scrollback: { type: 'string' },
          ansi: { type: 'string' },
          image: IMAGE_SCHEMA,
          warnings: { type: 'array', items: { type: 'string' } },
          truncated: { type: 'boolean' },
          ports: { type: 'array', items: PORT_SCHEMA },
          sandbox: SANDBOX_SCHEMA,
        },
        required: ['terminalId', 'title', 'state', 'cols', 'rows', 'cursor', 'text', 'warnings', 'truncated', 'ports', 'sandbox'],
      },
      render: (_args, value) => renderScreenshot(value),
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const target = resolveReadTarget(plugin, agent, args.terminalId)
      const format = args.format === 'ansi' || args.format === 'png' ? args.format : 'text'
      const withScrollback = args.withScrollback === true || args.scrollback === true
      const maxBytes = boundedBytes(args.maxBytes, config.maxOutputBytes)
      const warnings = []

      if (target.kind === 'history') {
        const entry = target.entry
        const value = {
          terminalId: entry.id,
          title: entry.title,
          state: 'exited',
          cols: entry.cols,
          rows: entry.rows,
          cursor: { x: 0, y: 0 },
          text: boundText(entry.text),
          warnings: ['this terminal has closed; returning its retained output from history'],
          truncated: entry.truncated,
          ports: entry.ports ?? [],
          sandbox: entry.sandbox ?? sandboxFor(plugin, agent),
        }
        if (format === 'ansi') {
          value.ansi = entry.text
          warnings.push('ANSI is no longer available for a closed terminal; returning plain text')
        }
        return value
      }

      const session = target.session
      const info = session.info ?? session
      const snapshot = session.snapshot({ scrollback: SCREENSHOT_SCROLLBACK })
      let text = withScrollback
        ? boundedScrollbackText(session, maxBytes)
        : boundText(session.visibleText())
      const value = {
        terminalId: info.id ?? session.id,
        title: info.title ?? session.title,
        state: info.state ?? session.state,
        cols: info.cols ?? session.cols,
        rows: info.rows ?? session.rows,
        cursor: snapshot.cursor,
        text,
        warnings,
        truncated: text.includes('[scrollback truncated'),
        ports: infoPorts(session),
        sandbox: info.sandbox ?? session.sandbox ?? sandboxFor(plugin, agent),
      }
      if (withScrollback) value.scrollback = text
      if (format === 'ansi') {
        const ansi = boundedScrollbackText(session, maxBytes, 'ansi')
        value.ansi = ansi
        value.text = boundText(session.visibleText())
      }
      if (format === 'png') {
        try {
          if (typeof session.requestCapture !== 'function') throw new Error('capture is not supported by this terminal session')
          const attachments = plugin.getAttachments?.()
          if (attachments === undefined || attachments === null || typeof attachments.saveImage !== 'function') {
            throw new Error('the attachment service is unavailable')
          }
          const capture = await session.requestCapture({ timeoutMs: 4000 })
          const ref = await attachments.saveImage({
            data: capture.buffer,
            mediaType: 'image/png',
            name: `terminal-${session.id}.png`,
          })
          value.image = {
            attachmentId: String(ref.attachmentId ?? ''),
            mediaType: typeof ref.mediaType === 'string' ? ref.mediaType : 'image/png',
            bytes: Number(ref.bytes ?? capture.buffer.byteLength),
            width: Number(ref.width ?? capture.width ?? session.cols * 8),
            height: Number(ref.height ?? capture.height ?? session.rows * 16),
            ...(typeof ref.name === 'string' ? { name: ref.name } : {}),
          }
          value.text = boundText(session.visibleText())
          warnings.push('png rendered by the attached browser terminal')
        } catch (error) {
          warnings.push(`png capture unavailable; returning text instead: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return value
    },
    isConcurrencySafe: () => true,
  })

  register({
    name: 'live_terminal_send',
    description:
      'Send raw text and/or named keys to the agent\'s interactive terminal in the visible terminal panel. By default Enter is submitted after the text; set submit:false for control characters or incomplete REPL input. Use keys for arrows/Enter/Tab/Escape/PageUp/F1-F12/Ctrl chords (for example ["Up","Enter"] or ["C-c"]), and paste:true to wrap text in bracketed paste. The interactive terminal is created on first use; use live_terminal_open to create an additional visible interactive terminal. Only this agent\'s own terminals are writable: user-owned terminals and other agents\' terminals are rejected.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        terminalId: { type: 'string', description: 'Terminal id; defaults to the agent\'s interactive terminal (created lazily).' },
        text: { type: 'string', description: 'UTF-8 text to write (may contain control characters).' },
        submit: { type: 'boolean', description: 'Append Enter after the text (default true).' },
        keys: { type: 'array', items: { type: 'string' }, description: 'Named keys to send before the final Enter (Enter, Tab, Shift+Tab, Esc, Backspace, Delete, Insert, arrows, Home, End, PageUp, PageDown, F1-F12, C-a..C-z).' },
        paste: { type: 'boolean', description: 'Wrap text in bracketed paste so multi-line input is not executed line by line.' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', const: true },
          terminalId: { type: 'string' },
          sent: { type: 'integer' },
          keys: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok', 'terminalId', 'sent', 'keys'],
      },
      render: (args, value) => {
        const bytes = Buffer.byteLength(String(args.text ?? ''), 'utf8')
        const submit = args.submit === false ? ' (no Enter)' : ' + Enter'
        const keyText = value.keys.length > 0 ? ` keys=${value.keys.join(',')}` : ''
        return textContent(`sent ${bytes} bytes${keyText} to terminal ${value.terminalId}${submit}`)
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const session = await resolveForSend(plugin, agent, args.terminalId, exec.signal)
      if (session.state !== 'running') {
        throw new Error(`terminal ${session.id} has exited; open a new interactive terminal with live_terminal_open first`)
      }
      const keys = normalizeKeys(args.keys)
      const text = typeof args.text === 'string' ? args.text : ''
      let payload = ''
      if (text.length > 0) payload += args.paste === true ? bracketPaste(text) : text
      for (const key of keys) payload += keySequence(key) ?? ''
      if (args.submit !== false) payload += '\r'
      if (payload.length === 0) throw new Error('nothing to send: provide text or keys')
      await session.write(payload)
      return { ok: true, terminalId: session.id, sent: Buffer.byteLength(payload, 'utf8'), keys }
    },
    isConcurrencySafe: () => false,
  })

  register({
    name: 'live_terminal_read',
    description:
      'Read the output of a visible terminal (ANSI stripped) without sending input. Use the terminalId returned by live_terminal_run to read a command terminal (including one started with wait:false); without terminalId it reads the agent\'s interactive terminal. Closed terminals are served from the recent-command history. format:"tail" (default) returns the retained tail; format:"range" reads a slice (offset = lines back from the end, lines = count); format:"all" returns the retained buffer. Only terminals visible to this agent (its own terminals and the user\'s read-only terminals) can be read.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        terminalId: { type: 'string', description: 'Terminal id; defaults to the agent\'s interactive terminal.' },
        maxBytes: { type: 'number', description: 'Maximum retained UTF-8 bytes to return (default 16384).' },
        format: { type: 'string', enum: ['tail', 'range', 'all'], description: 'Read mode (default tail).' },
        offset: { type: 'number', description: 'For format:"range": number of lines back from the end to start (0 = end).' },
        lines: { type: 'number', description: 'For format:"range": number of lines to return (default 50, max 500).' },
        raw: { type: 'boolean', description: 'Reserved: return ANSI rather than plain text when available.' },
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
          truncated: { type: 'boolean' },
          startLine: { type: 'integer' },
          endLine: { type: 'integer' },
          totalLines: { type: 'integer' },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          durationMs: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          ports: { type: 'array', items: PORT_SCHEMA },
        },
        required: ['terminalId', 'state', 'text', 'truncated', 'exitCode', 'signal', 'durationMs', 'ports'],
      },
      render: (_args, value) => textContent(boundText(value.text.length > 0 ? value.text : '(no retained output)')),
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const target = resolveReadTarget(plugin, agent, args.terminalId, 'interactive')
      const maxBytes = boundedBytes(args.maxBytes, config.maxOutputBytes)
      if (target.kind === 'history') {
        const entry = target.entry
        return {
          terminalId: entry.id,
          state: 'exited',
          text: boundText(entry.text),
          truncated: entry.truncated,
          exitCode: entry.exitCode,
          signal: entry.signal,
          durationMs: entry.durationMs,
          ports: entry.ports ?? [],
        }
      }
      const session = target.session
      const info = session.info ?? session
      const format = args.format === 'range' || args.format === 'all' ? args.format : 'tail'
      let text
      let truncated = false
      let startLine
      let endLine
      let totalLines
      if (format === 'range') {
        const offset = Math.max(0, Math.floor(Number(args.offset) || 0))
        const lines = Math.max(1, Math.min(500, Math.floor(Number(args.lines) || 50)))
        const slice = session.readLines({ offset, lines })
        text = slice.text
        startLine = slice.startLine
        endLine = slice.endLine
        totalLines = slice.totalLines
        truncated = slice.truncated === true
      } else if (format === 'all') {
        const all = session.fullText()
        const bounded = tailByBytes(all, maxBytes)
        text = commandOutputText(bounded.text)
        truncated = bounded.truncated
        totalLines = session.readLines({ offset: 0, lines: 1 }).totalLines
      } else {
        const tail = session.plainTail(maxBytes)
        text = tail.text
        truncated = tail.truncated
      }
      return {
        terminalId: info.id ?? session.id,
        state: info.state ?? session.state,
        text: boundText(text),
        truncated,
        ...(startLine === undefined ? {} : { startLine }),
        ...(endLine === undefined ? {} : { endLine }),
        ...(totalLines === undefined ? {} : { totalLines }),
        exitCode: info.exitCode ?? session.exitCode ?? null,
        signal: info.signal ?? session.signal ?? null,
        durationMs: durationOf(session),
        ports: infoPorts(session),
      }
    },
    isConcurrencySafe: () => true,
  })

  register({
    name: 'live_terminal_search',
    description:
      'Search the retained output of a visible terminal (or a recently closed command in history) for a literal string or regular expression. Returns matching line numbers and text, with optional context lines. Prefer this over repeated full reads for long logs.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        terminalId: { type: 'string', description: 'Terminal id; defaults to the agent\'s interactive terminal.' },
        pattern: { type: 'string', description: 'Literal string or regular expression to search for.' },
        regex: { type: 'boolean', description: 'Treat pattern as a JavaScript regular expression (default false).' },
        scope: { type: 'string', enum: ['visible', 'scrollback', 'all'], description: 'Search scope (default all retained text).' },
        maxResults: { type: 'number', description: 'Maximum matches to return (default 20, max 100).' },
        contextLines: { type: 'number', description: 'Lines of context around each match (default 0, max 5).' },
      },
      required: ['pattern'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          terminalId: { type: 'string' },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                line: { type: 'integer' },
                text: { type: 'string' },
                before: { type: 'array', items: { type: 'string' } },
                after: { type: 'array', items: { type: 'string' } },
              },
              required: ['line', 'text'],
            },
          },
          truncated: { type: 'boolean' },
          totalLines: { type: 'integer' },
        },
        required: ['terminalId', 'matches', 'truncated', 'totalLines'],
      },
      render: (_args, value) => textContent(renderSearch(value)),
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const pattern = typeof args.pattern === 'string' ? args.pattern : ''
      if (pattern.length === 0) throw new Error('pattern must be a non-empty string')
      if (pattern.length > MAX_PATTERN_CHARS) throw new Error(`pattern is too long (max ${MAX_PATTERN_CHARS} characters)`)
      let matcher
      if (args.regex === true) {
        try {
          matcher = new RegExp(pattern)
        } catch (error) {
          throw new Error(`invalid regular expression: ${error instanceof Error ? error.message : String(error)}`)
        }
      } else {
        matcher = pattern
      }
      const scope = args.scope === 'visible' || args.scope === 'scrollback' ? args.scope : 'all'
      const maxResults = Math.max(1, Math.min(100, Math.floor(Number(args.maxResults) || 20)))
      const contextLines = Math.max(0, Math.min(5, Math.floor(Number(args.contextLines) || 0)))
      const target = resolveReadTarget(plugin, agent, args.terminalId)
      const text = target.kind === 'history' ? target.entry.text : (scope === 'visible' ? target.session.visibleText() : target.session.fullText())
      const sourceLines = text.split(/\r?\n/u)
      const totalLines = sourceLines.length
      const matches = []
      let truncated = false
      for (let index = 0; index < sourceLines.length; index += 1) {
        const line = sourceLines[index] ?? ''
        const hit = matcher instanceof RegExp ? matcher.test(line) : line.includes(matcher)
        if (!hit) continue
        if (matches.length >= maxResults) {
          truncated = true
          break
        }
        const match = { line: index + 1, text: boundLine(line) }
        if (contextLines > 0) {
          match.before = sourceLines.slice(Math.max(0, index - contextLines), index).map(boundLine)
          match.after = sourceLines.slice(index + 1, index + 1 + contextLines).map(boundLine)
        }
        matches.push(match)
      }
      return { terminalId: targetId(target), matches, truncated, totalLines }
    },
    isConcurrencySafe: () => true,
  })

  register({
    name: 'live_terminal_wait',
    description:
      'Wait for a terminal to exit or for its output to match a pattern, without killing the process. Use this after live_terminal_run(wait:false) instead of polling. Returns the state, exit code, signal, duration and tail. A timeout returns timedOut:true and leaves the process alive.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        terminalId: { type: 'string', description: 'Terminal id; defaults to the agent\'s interactive terminal.' },
        timeoutMs: { type: 'number', description: 'Maximum wait in milliseconds (default from plugin config).' },
        pattern: { type: 'string', description: 'Optional literal string or regular expression to wait for.' },
        mode: { type: 'string', enum: ['exit', 'pattern', 'either'], description: 'Wait for exit, pattern, or either (default exit).' },
        regex: { type: 'boolean', description: 'Treat pattern as a regular expression (default false).' },
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
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          durationMs: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          timedOut: { type: 'boolean' },
          matched: { type: 'boolean' },
          text: { type: 'string' },
          truncated: { type: 'boolean' },
        },
        required: ['terminalId', 'state', 'exitCode', 'signal', 'durationMs', 'timedOut', 'matched', 'text', 'truncated'],
      },
      render: (_args, value) => {
        const status = value.timedOut ? 'timed out' : value.matched ? 'matched' : value.state
        return textContent(`[terminal ${value.terminalId}] ${status} exit=${value.exitCode ?? 'null'} duration=${value.durationMs ?? '—'}ms\n${value.text.length > 0 ? value.text : '(no output)'}`)
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const target = resolveReadTarget(plugin, agent, args.terminalId, 'interactive')
      const timeoutMs = positiveNumber(args.timeoutMs) ?? config.commandTimeoutMs
      if (target.kind === 'history') {
        return waitValue(target.entry.id, 'exited', target.entry.exitCode, target.entry.signal, target.entry.durationMs, false, false, target.entry.text, target.entry.truncated)
      }
      const session = target.session
      const mode = args.mode === 'pattern' || args.mode === 'either' ? args.mode : 'exit'
      const result = await requireRegistry(plugin).waitForExit(session.id, {
        timeoutMs,
        pattern: typeof args.pattern === 'string' && args.pattern.length > 0 ? args.pattern : undefined,
        mode,
        since: 'unread',
        signal: exec.signal,
      })
      return waitValue(result.terminalId, result.state, result.exitCode, result.signal, result.durationMs, result.timedOut, result.matched, result.text, result.truncated)
    },
    isConcurrencySafe: () => true,
  })

  register({
    name: 'live_terminal_expect',
    description:
      'Wait until the terminal output matches a pattern (for example a dev-server URL or an interactive prompt), or until the terminal exits. This is a convenience alias of live_terminal_wait with mode:"pattern". A timeout returns timedOut:true and leaves the process alive.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        terminalId: { type: 'string', description: 'Terminal id; defaults to the agent\'s interactive terminal.' },
        pattern: { type: 'string', description: 'Literal string or regular expression to wait for.' },
        timeoutMs: { type: 'number', description: 'Maximum wait in milliseconds (default from plugin config).' },
        regex: { type: 'boolean', description: 'Treat pattern as a regular expression (default false).' },
      },
      required: ['pattern'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          terminalId: { type: 'string' },
          state: { type: 'string', enum: ['running', 'exited', 'failed'] },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          durationMs: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          timedOut: { type: 'boolean' },
          matched: { type: 'boolean' },
          text: { type: 'string' },
          truncated: { type: 'boolean' },
        },
        required: ['terminalId', 'state', 'exitCode', 'signal', 'durationMs', 'timedOut', 'matched', 'text', 'truncated'],
      },
      render: (_args, value) => textContent(`[terminal ${value.terminalId}] ${value.matched ? 'matched' : value.timedOut ? 'timed out' : value.state}\n${value.text.length > 0 ? value.text : '(no output)'}`),
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const target = resolveReadTarget(plugin, agent, args.terminalId, 'interactive')
      const pattern = typeof args.pattern === 'string' ? args.pattern : ''
      if (pattern.length === 0) throw new Error('pattern must be a non-empty string')
      if (pattern.length > MAX_PATTERN_CHARS) throw new Error(`pattern is too long (max ${MAX_PATTERN_CHARS} characters)`)
      const timeoutMs = positiveNumber(args.timeoutMs) ?? config.commandTimeoutMs
      if (target.kind === 'history') {
        const matcher = buildMatcher(pattern, args.regex === true)
        const matched = matcher === undefined ? false : matcher(target.entry.text)
        return waitValue(target.entry.id, 'exited', target.entry.exitCode, target.entry.signal, target.entry.durationMs, false, matched, target.entry.text, target.entry.truncated)
      }
      const result = await requireRegistry(plugin).waitForExit(target.session.id, {
        timeoutMs,
        pattern: args.regex === true ? pattern : escapeRegExp(pattern),
        mode: 'pattern',
        since: 'unread',
        signal: exec.signal,
      })
      return waitValue(result.terminalId, result.state, result.exitCode, result.signal, result.durationMs, result.timedOut, result.matched, result.text, result.truncated)
    },
    isConcurrencySafe: () => true,
  })

  register({
    name: 'live_terminal_status',
    description:
      'Report one terminal\'s state (running/exited/failed), exit code, signal, duration, title, kind, cwd and detected localhost URLs. Recently closed commands are served from history, so this still answers after auto-close.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        terminalId: { type: 'string', description: 'Terminal id (closed terminals are looked up in history).' },
      },
      required: ['terminalId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          terminalId: { type: 'string' },
          state: { type: 'string', enum: ['running', 'exited', 'failed'] },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          durationMs: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          running: { type: 'boolean' },
          title: { type: 'string' },
          kind: { type: 'string' },
          cwd: { type: 'string' },
          ports: { type: 'array', items: PORT_SCHEMA },
          sandbox: SANDBOX_SCHEMA,
        },
        required: ['terminalId', 'state', 'exitCode', 'signal', 'durationMs', 'running', 'title', 'kind', 'cwd', 'ports', 'sandbox'],
      },
      render: (_args, value) => textContent(
        `${value.terminalId} [${value.kind}] ${value.running ? 'running' : value.state} exit=${value.exitCode ?? 'null'} signal=${value.signal ?? 'null'} duration=${value.durationMs ?? '—'}ms\n${value.title}\n${value.cwd}${value.ports.length > 0 ? `\nports: ${value.ports.map((port) => port.url).join(', ')}` : ''}${value.sandbox.confined ? '' : `\n[sandbox: ${value.sandbox.mode}, unconfined]`}`,
      ),
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const id = typeof args.terminalId === 'string' ? args.terminalId : ''
      if (id.length === 0) throw new Error('terminalId is required')
      const target = resolveReadTarget(plugin, agent, id)
      if (target.kind === 'history') {
        const entry = target.entry
        return {
          terminalId: entry.id,
          state: 'exited',
          exitCode: entry.exitCode,
          signal: entry.signal,
          durationMs: entry.durationMs,
          running: false,
          title: entry.title,
          kind: 'command',
          cwd: entry.cwd,
          ports: entry.ports ?? [],
          sandbox: entry.sandbox ?? sandboxFor(plugin, agent),
        }
      }
      const session = target.session
      const info = session.info ?? session
      return {
        terminalId: info.id ?? session.id,
        state: info.state ?? session.state,
        exitCode: info.exitCode ?? session.exitCode ?? null,
        signal: info.signal ?? session.signal ?? null,
        durationMs: durationOf(session),
        running: (info.state ?? session.state) === 'running',
        title: info.title ?? session.title,
        kind: info.kind ?? session.kind,
        cwd: info.cwd ?? session.cwd ?? '',
        ports: infoPorts(session),
        sandbox: info.sandbox ?? session.sandbox ?? sandboxFor(plugin, agent),
      }
    },
    isConcurrencySafe: () => true,
  })

  register({
    name: 'live_terminal_signal',
    description:
      'Deliver a signal to the agent\'s own running terminal. SIGINT writes Ctrl-C (the process may keep running while it handles the interrupt); SIGTERM/SIGKILL/SIGHUP terminate the process tree. This keeps the screen available (unlike live_terminal_close, which removes the terminal). Only this agent\'s own terminals can be signalled.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        terminalId: { type: 'string', description: 'Terminal id.' },
        signal: { type: 'string', enum: ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP'], description: 'Signal name (default SIGINT).' },
      },
      required: ['terminalId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', const: true },
          delivered: { type: 'string' },
          terminalId: { type: 'string' },
        },
        required: ['ok', 'delivered', 'terminalId'],
      },
      render: (_args, value) => textContent(`delivered ${value.delivered} to terminal ${value.terminalId}`),
    },
    async execute(args, exec) {
      const registry = requireRegistry(plugin)
      const agent = requireAgent(exec)
      const session = requireWritableSession(registry, agent, args.terminalId)
      const name = normalizeSignal(args.signal)
      const result = await session.sendSignal(name)
      return { ok: true, delivered: result?.delivered ?? name, terminalId: session.id }
    },
    isConcurrencySafe: () => false,
  })

  register({
    name: 'live_terminal_resize',
    description:
      'Resize a visible terminal\'s PTY and screen grid. Use before capturing a TUI or a wide table so the screenshot has the dimensions you need. Only running terminals can be resized.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        terminalId: { type: 'string', description: 'Terminal id.' },
        cols: { type: 'integer', description: 'New columns (2..500).' },
        rows: { type: 'integer', description: 'New rows (1..200).' },
      },
      required: ['terminalId', 'cols', 'rows'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', const: true },
          terminalId: { type: 'string' },
          cols: { type: 'integer' },
          rows: { type: 'integer' },
        },
        required: ['ok', 'terminalId', 'cols', 'rows'],
      },
      render: (_args, value) => textContent(`terminal ${value.terminalId} resized to ${value.cols}x${value.rows}`),
    },
    async execute(args, exec) {
      const registry = requireRegistry(plugin)
      const agent = requireAgent(exec)
      const session = requireWritableSession(registry, agent, args.terminalId)
      const cols = Math.max(2, Math.min(500, Math.floor(Number(args.cols) || 0)))
      const rows = Math.max(1, Math.min(200, Math.floor(Number(args.rows) || 0)))
      if (session.state !== 'running') throw new Error(`terminal ${session.id} has exited and cannot be resized`)
      await session.resize(cols, rows)
      return { ok: true, terminalId: session.id, cols, rows }
    },
    isConcurrencySafe: () => false,
  })

  register({
    name: 'live_terminal_exec',
    description:
      'Run one command inside an existing interactive terminal and return its output and exit code, preserving that shell\'s cwd, environment, venv and aliases. Prefer this over live_terminal_run when a previous cd/setup should be reused. The terminal must be running and owned by this agent. Execution is serialized per terminal.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        terminalId: { type: 'string', description: 'Interactive terminal id; defaults to the agent\'s interactive terminal.' },
        command: { type: 'string', description: 'Command to run in the existing shell.' },
        timeoutMs: { type: 'number', description: 'Maximum wait in milliseconds (default from plugin config).' },
        echo: { type: 'boolean', description: 'Include the echoed command line in the output (default false).' },
      },
      required: ['command'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          terminalId: { type: 'string' },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          output: { type: 'string' },
          timedOut: { type: 'boolean' },
          durationMs: { type: 'number' },
        },
        required: ['terminalId', 'exitCode', 'output', 'timedOut', 'durationMs'],
      },
      render: (_args, value) => textContent(
        `[terminal ${value.terminalId}] ${value.timedOut ? 'timed out' : value.exitCode === null ? 'exited' : `exit ${value.exitCode}`} (${value.durationMs}ms)\n${value.output.length > 0 ? value.output : '(no output)'}`,
      ),
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const session = await resolveForSend(plugin, agent, args.terminalId, exec.signal)
      if (session.state !== 'running') throw new Error(`terminal ${session.id} has exited; open a new interactive terminal first`)
      const command = typeof args.command === 'string' ? args.command : ''
      if (command.trim().length === 0) throw new Error('command must be a non-empty string')
      const timeoutMs = positiveNumber(args.timeoutMs) ?? config.commandTimeoutMs
      const result = await execInSession(session, command, { timeoutMs, shellKind: session.shellKind, echo: args.echo === true })
      return {
        terminalId: session.id,
        exitCode: result.exitCode,
        output: boundText(result.output),
        timedOut: result.timedOut === true,
        durationMs: result.durationMs,
      }
    },
    isConcurrencySafe: () => false,
  })

  register({
    name: 'live_terminal_list',
    description: 'List the visible terminal sessions (running and retained exited) and the recent closed-command history count. Only terminals visible to this agent (its own terminals and the user\'s read-only terminals) are listed.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          terminals: { type: 'array', items: SESSION_INFO_SCHEMA },
          historyCount: { type: 'integer' },
        },
        required: ['terminals', 'historyCount'],
      },
      render: (_args, value) => textContent(renderList(value.terminals, value.historyCount)),
    },
    async execute(_args, exec) {
      const registry = requireRegistry(plugin)
      const agent = exec?.agent
      const sessions = registry
        .list()
        .filter((session) => (agent === undefined || agent === null ? session.owner === 'user' : isVisibleToAgent(session, agent)))
      const historyCount = agent === undefined || agent === null
        ? registry.history?.size ?? 0
        : registry.historyList(1000).filter((entry) => historyVisibleToAgent(entry, agent)).length
      return { terminals: sessions, historyCount }
    },
    isConcurrencySafe: () => true,
  })

  register({
    name: 'live_terminal_history',
    description:
      'List recently closed command terminals with their exit code, duration and retained output tail. Use this when a command terminal auto-closed before you could read it. Closed output is also accepted by live_terminal_read, live_terminal_screenshot, live_terminal_search and live_terminal_status via its terminal id.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: 'Maximum entries to return (default 10, max 50).' },
        terminalId: { type: 'string', description: 'Return one entry by its original terminal id.' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: { type: 'array', items: HISTORY_ENTRY_SCHEMA },
        },
        required: ['entries'],
      },
      render: (_args, value) => textContent(renderHistory(value.entries)),
    },
    async execute(args, exec) {
      const registry = requireRegistry(plugin)
      const agent = requireAgent(exec)
      const limit = Math.max(1, Math.min(50, Math.floor(Number(args.limit) || 10)))
      const terminalId = typeof args.terminalId === 'string' ? args.terminalId : undefined
      const entries = registry
        .historyList(terminalId === undefined ? 1000 : 50, terminalId)
        .filter((entry) => historyVisibleToAgent(entry, agent))
        .slice(0, limit)
      return { entries }
    },
    isConcurrencySafe: () => true,
  })

  register({
    name: 'live_terminal_open',
    description:
      'Open a new visible interactive terminal in the terminal panel. Use this for interactive programs, REPLs or long-lived shells the user should watch. The new terminal becomes this agent\'s default interactive terminal for live_terminal_send/read/exec. Returns the new terminal id and info.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Display title for the new terminal.' },
        cwd: { type: 'string', description: 'Working directory (absolute, or relative to the session workspace).' },
        shell: { type: 'string', enum: ['pwsh', 'bash', 'cmd'], description: 'Shell dialect to launch.' },
        cols: { type: 'integer', description: 'Initial columns.' },
        rows: { type: 'integer', description: 'Initial rows.' },
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
      const sandbox = sandboxFor(plugin, agent)
      if (requiresSandbox(config, sandbox) && sandbox.mode !== 'danger-full-access') {
        throw new Error(`SANDBOX_REQUIRED: this deployment requires the DSH file sandbox (mode=${sandbox.mode}); a visible interactive terminal would run unconfined.`)
      }
      const session = await registry.createInteractive({
        agent,
        agentId: agent.id,
        sessionId: agent.session?.id,
        owner: 'agent',
        title: typeof args.title === 'string' && args.title.trim().length > 0 ? args.title.trim().slice(0, 200) : undefined,
        cwd: typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : undefined,
        cols: positiveInteger(args.cols),
        rows: positiveInteger(args.rows),
        shellKindHint: normalizeShell(args.shell),
        signal: exec.signal,
      })
      await session.waitReady({ signal: exec.signal })
      if (typeof registry.setDefaultTerminal === 'function') {
        registry.setDefaultTerminal(agent.id, session.id)
      }
      return { terminalId: session.id, info: session.info ?? session }
    },
    isConcurrencySafe: () => false,
  })

  register({
    name: 'live_terminal_close',
    description: 'Close one visible terminal and terminate its process tree. Exited command terminals are archived into history before removal. Only this agent\'s own terminals can be closed: user-owned terminals and other agents\' terminals are rejected.',
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
          historyId: { type: 'string' },
        },
        required: ['ok', 'historyId'],
      },
      render: (_args, value) => textContent(`closed terminal ${value.historyId}`),
    },
    async execute(args, exec) {
      const registry = requireRegistry(plugin)
      const agent = requireAgent(exec)
      if (typeof args.terminalId !== 'string' || args.terminalId.length === 0) throw new Error('terminalId is required')
      const session = requireWritableSession(registry, agent, args.terminalId)
      const historyId = session.id
      await registry.close(session.id)
      return { ok: true, historyId }
    },
    isConcurrencySafe: () => false,
  })

  register({
    name: 'live_terminal_rename',
    description: 'Rename one of this agent\'s visible terminals so the panel tab is easier to identify.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        terminalId: { type: 'string', description: 'Terminal id.' },
        title: { type: 'string', description: 'New display title (1-200 characters).' },
      },
      required: ['terminalId', 'title'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', const: true },
          info: SESSION_INFO_SCHEMA,
        },
        required: ['ok', 'info'],
      },
      render: (_args, value) => textContent(`renamed terminal ${value.info.id} to "${value.info.title}"`),
    },
    async execute(args, exec) {
      const registry = requireRegistry(plugin)
      const agent = requireAgent(exec)
      const session = requireWritableSession(registry, agent, args.terminalId)
      const title = typeof args.title === 'string' ? args.title.trim().slice(0, 200) : ''
      if (title.length === 0) throw new Error('title must be a non-empty string')
      const info = await registry.setTitle(session.id, title)
      return { ok: true, info: info ?? session.info }
    },
    isConcurrencySafe: () => false,
  })

  register({
    name: 'live_terminal_export',
    description:
      'Export a terminal\'s retained output as plain text or ANSI. Large exports are written to a file and the returned path is given instead of the whole text. Useful for archiving a long build log or sharing exact colored output.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        terminalId: { type: 'string', description: 'Terminal id (live or recently closed).' },
        format: { type: 'string', enum: ['text', 'ansi'], description: 'Export format (default text).' },
      },
      required: ['terminalId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          terminalId: { type: 'string' },
          path: { type: 'string' },
          text: { type: 'string' },
          bytes: { type: 'integer' },
          truncated: { type: 'boolean' },
        },
        required: ['terminalId', 'bytes', 'truncated'],
      },
      render: (_args, value) => textContent(
        value.path !== undefined
          ? `exported terminal ${value.terminalId} (${value.bytes} bytes) to ${value.path}`
          : `exported terminal ${value.terminalId} (${value.bytes} bytes)\n${value.text ?? ''}`,
      ),
    },
    async execute(args, exec) {
      const registry = requireRegistry(plugin)
      const agent = requireAgent(exec)
      const target = resolveReadTarget(plugin, agent, args.terminalId)
      const format = args.format === 'ansi' ? 'ansi' : 'text'
      const exported = target.kind === 'history'
        ? { text: target.entry.text, bytes: Buffer.byteLength(target.entry.text, 'utf8'), truncated: target.entry.truncated }
        : (typeof target.session.exportText === 'function'
            ? target.session.exportText(format)
            : { text: target.session.fullText(), bytes: Buffer.byteLength(target.session.fullText(), 'utf8'), truncated: false })
      const id = targetId(target)
      if (exported.bytes <= EXPORT_INLINE_BYTES) {
        return { terminalId: id, text: exported.text, bytes: exported.bytes, truncated: exported.truncated === true }
      }
      const dir = exportDir(config)
      await mkdir(dir, { recursive: true })
      const file = join(dir, `${id}.${format === 'ansi' ? 'ansi' : 'txt'}`)
      await writeFile(file, exported.text, 'utf8')
      return { terminalId: id, path: file, bytes: exported.bytes, truncated: exported.truncated === true }
    },
    isConcurrencySafe: () => true,
  })
}

/* ------------------------------------------------------------------ */
/* Resolution helpers                                                  */
/* ------------------------------------------------------------------ */

/**
 * Resolve a session or a history entry for read/screenshot/status/export.
 * @param {{ get registry(): any, config?: any }} plugin plugin state.
 * @param {any} agent owning agent.
 * @param {string | undefined} terminalId explicit id.
 * @param {'active' | 'interactive'} [prefer] default target policy.
 * @returns {{ kind: 'session', session: any } | { kind: 'history', entry: any }} target.
 */
function resolveReadTarget(plugin, agent, terminalId, prefer = 'active') {
  const registry = requireRegistry(plugin)
  if (typeof terminalId === 'string' && terminalId.length > 0) {
    const session = registry.lookup(terminalId)
    if (session !== undefined) {
      if (!isVisibleToAgent(session, agent)) throw new Error(ownershipError(session, terminalId, 'visible'))
      return { kind: 'session', session }
    }
    const entry = registry.history?.get?.(terminalId)
    if (entry !== undefined && entry !== null) {
      if (!historyVisibleToAgent(entry, agent)) throw new Error(`terminal ${terminalId} belongs to another agent and is not visible from this agent`)
      return { kind: 'history', entry }
    }
    throw new Error(`terminal ${terminalId} not found (live or in history)`)
  }
  if (prefer === 'interactive') {
    const mapped = registry.resolveForAgent(agent)
    if (mapped !== undefined && mapped !== null) return { kind: 'session', session: mapped }
    const interactives = registry
      .list()
      .filter((session) => session.kind === 'interactive' && session.state === 'running' && isVisibleToAgent(session, agent))
      .sort((left, right) => right.createdAt - left.createdAt)
    if (interactives.length > 0) {
      const session = registry.lookup(interactives[0].id)
      if (session !== undefined) return { kind: 'session', session }
    }
  }
  const recent = typeof registry.resolveRecentForAgent === 'function'
    ? registry.resolveRecentForAgent(agent, { prefer: 'active' })
    : registry.resolveRecentForAgent?.(agent)
  if (recent !== undefined && recent !== null) return { kind: 'session', session: recent }
  const history = (registry.historyList?.(1000) ?? []).filter((entry) => historyVisibleToAgent(entry, agent))
  if (history.length > 0) return { kind: 'history', entry: history[0] }
  throw new Error('no visible terminal for this agent yet; run a command with live_terminal_run or open a terminal with live_terminal_open first')
}

/**
 * Resolve the send/exec/read target: explicit id, else the agent's default
 * interactive terminal, creating that terminal lazily for send/exec.
 * @param {{ get registry(): any }} plugin plugin state.
 * @param {any} agent owning agent.
 * @param {string | undefined} terminalId explicit id.
 * @param {AbortSignal} [signal] creation cancellation.
 * @returns {Promise<any>} interactive session.
 */
async function resolveForSend(plugin, agent, terminalId, signal) {
  const registry = requireRegistry(plugin)
  if (typeof terminalId === 'string' && terminalId.length > 0) return requireWritableSession(registry, agent, terminalId)
  const existing = registry.resolveForAgent(agent)
  if (existing !== undefined && existing !== null && existing.state === 'running') return existing
  const created = await registry.ensureAgentTerminal(agent, { signal })
  if (created === undefined || created === null) throw new Error('could not create an interactive terminal')
  return created
}

/**
 * Resolve a writable session for a tool call.
 * @param {any} registry terminal registry.
 * @param {any} agent owning agent.
 * @param {string | undefined} terminalId terminal id.
 * @returns {any} writable session.
 */
function requireWritableSession(registry, agent, terminalId) {
  if (typeof terminalId !== 'string' || terminalId.length === 0) throw new Error('terminalId is required')
  const session = registry.lookup(terminalId)
  if (session === undefined) {
    const entry = registry.history?.get?.(terminalId)
    if (entry !== undefined) throw new Error(`terminal ${terminalId} has closed; its output is in history but it can no longer be written to`)
    throw new Error(`terminal ${terminalId} not found`)
  }
  if (!isWritableByAgent(session, agent)) throw new Error(ownershipError(session, terminalId, 'writable'))
  return session
}

/**
 * Whether one session is visible (read-only) to an agent: user-owned terminals
 * are visible to every agent, agent-owned terminals only to their owner.
 * @param {any} session terminal session.
 * @param {any} agent owning agent.
 * @returns {boolean} whether the session may be read/screenshotted.
 */
function isVisibleToAgent(session, agent) {
  if (session === undefined || session === null || agent === undefined || agent === null) return false
  if (session.owner === 'user') return true
  return session.owner === 'agent' && session.agentId === agent.id
}

/**
 * Whether an agent may write to / close one session: only its own terminals.
 * @param {any} session terminal session.
 * @param {any} agent owning agent.
 * @returns {boolean} whether the session is writable by the agent.
 */
function isWritableByAgent(session, agent) {
  if (session === undefined || session === null || agent === undefined || agent === null) return false
  return session.owner === 'agent' && session.agentId === agent.id
}

/**
 * @param {any} session offending session.
 * @param {string} terminalId requested id.
 * @param {'visible' | 'writable'} capability requested operation.
 * @returns {string} clear ownership error message.
 */
function ownershipError(session, terminalId, capability) {
  if (session.owner === 'user') {
    return capability === 'writable'
      ? `terminal ${terminalId} is user-owned and read-only to agents; it cannot be written to or closed`
      : `terminal ${terminalId} is user-owned and not visible to this agent`
  }
  return `terminal ${terminalId} belongs to another agent and is not ${capability} from this agent`
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
 * Resolve the current sandbox fact for an agent.
 * @param {{ get registry(): any, resolveSandboxPolicy?: (agent: any) => any }} plugin plugin state.
 * @param {any} agent owning agent.
 * @returns {{ mode: string, confined: boolean, required: boolean }} sandbox info.
 */
function sandboxFor(plugin, agent) {
  let fact
  try {
    fact = plugin.registry?.sandboxFor?.(agent)
  } catch {
    fact = undefined
  }
  if (fact === undefined || fact === null) {
    fact = typeof plugin.resolveSandboxPolicy === 'function' ? plugin.resolveSandboxPolicy(agent) : undefined
  }
  const mode = typeof fact?.mode === 'string' ? fact.mode : 'danger-full-access'
  return {
    mode,
    confined: fact?.confined === true,
    required: plugin.config?.requireSandbox === true || plugin.config?.allowUnconfined === false,
  }
}

/**
 * Terminal id of a resolved read target.
 * @param {{ kind: 'session', session: any } | { kind: 'history', entry: any }} target resolved target.
 * @returns {string} terminal id.
 */
function targetId(target) {
  return target.kind === 'history' ? target.entry.id : target.session.id
}

/**
 * Whether one history entry is visible to an agent. Entries written before
 * 1.2.1 have no agentId; they stay visible in the user panel but are not
 * exposed through agent-facing tools.
 * @param {any} entry history entry.
 * @param {any} agent owning agent (undefined/null = user view).
 * @returns {boolean} visibility.
 */
function historyVisibleToAgent(entry, agent) {
  if (agent === undefined || agent === null) return true
  return entry !== undefined && entry !== null && entry.agentId === agent.id
}

/**
 * @param {any} config plugin config.
 * @param {{ mode: string }} sandbox sandbox info.
 * @returns {boolean} whether the configured policy forbids an unconfined PTY.
 */
function requiresSandbox(config, sandbox) {
  if (config?.requireSandbox !== true && config?.allowUnconfined !== false) return false
  return sandbox.mode !== 'danger-full-access'
}

/**
 * @param {any} session session.
 * @returns {number} elapsed milliseconds.
 */
function durationOf(session) {
  const info = session?.info ?? session
  if (typeof info?.durationMs === 'number') return info.durationMs
  const started = typeof info?.startedAt === 'number' ? info.startedAt : (typeof info?.createdAt === 'number' ? info.createdAt : Date.now())
  const ended = typeof info?.endedAt === 'number' ? info.endedAt : Date.now()
  return Math.max(0, ended - started)
}

/**
 * @param {any} session session.
 * @returns {any[]} ports.
 */
function infoPorts(session) {
  const ports = session?.info?.ports ?? session?.ports
  return Array.isArray(ports) ? ports : []
}

/**
 * @param {unknown} value candidate.
 * @returns {number | undefined} positive integer.
 */
function positiveInteger(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

/**
 * @param {unknown} value candidate.
 * @returns {number | undefined} positive finite number.
 */
function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * @param {unknown} value candidate bytes.
 * @param {number} fallback fallback.
 * @returns {number} bounded bytes.
 */
function boundedBytes(value, fallback) {
  const requested = positiveNumber(value)
  return requested === undefined ? Math.min(DEFAULT_READ_BYTES, fallback) : Math.min(Math.floor(requested), fallback)
}

/**
 * @param {unknown} value shell argument.
 * @returns {'pwsh' | 'bash' | 'cmd' | undefined} normalised hint.
 */
function normalizeShell(value) {
  return value === 'pwsh' || value === 'bash' || value === 'cmd' ? value : undefined
}

/**
 * @param {unknown} value signal argument.
 * @returns {string} normalised signal name.
 */
function normalizeSignal(value) {
  return value === 'SIGTERM' || value === 'SIGKILL' || value === 'SIGHUP' ? value : 'SIGINT'
}

/**
 * @param {unknown} value env object.
 * @returns {Record<string, string> | undefined} sanitised env.
 */
function normalizeEnv(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result = {}
  let total = 0
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') continue
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue
    if (key.startsWith('DSH_')) continue
    total += key.length + entry.length
    if (total > 16 * 1024) break
    result[key] = entry
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * @param {unknown} keys candidate key list.
 * @returns {string[]} validated key names.
 */
function normalizeKeys(keys) {
  if (!Array.isArray(keys)) return []
  const result = []
  for (const key of keys) {
    if (typeof key !== 'string' || key.length === 0) throw new Error('keys must be non-empty strings')
    if (keySequence(key) === undefined) throw new Error(`unknown key name: ${key}`)
    result.push(key)
  }
  return result
}

/**
 * @param {string} text literal text.
 * @returns {string} regular-expression-escaped text.
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * @param {unknown} pattern pattern.
 * @param {boolean} regex whether to compile a RegExp.
 * @returns {((text: string) => boolean) | undefined} matcher.
 */
function buildMatcher(pattern, regex) {
  if (typeof pattern !== 'string' || pattern.length === 0) return undefined
  if (pattern.length > MAX_PATTERN_CHARS) throw new Error(`pattern is too long (max ${MAX_PATTERN_CHARS} characters)`)
  if (regex) {
    let compiled
    try {
      compiled = new RegExp(pattern)
    } catch (error) {
      throw new Error(`invalid regular expression: ${error instanceof Error ? error.message : String(error)}`)
    }
    return (text) => compiled.test(text)
  }
  return (text) => text.includes(pattern)
}

/**
 * @param {string} text text.
 * @returns {string} one bounded line.
 */
function boundLine(text) {
  return text.length > 400 ? `${text.slice(0, 399)}…` : text
}

/**
 * @param {string} text model-facing text.
 * @returns {{ type: 'text', text: string }[]} content blocks.
 */
function textContent(text) {
  return [{ type: 'text', text: boundText(text) }]
}

/**
 * Bound one model-facing text while keeping its tail, by characters and bytes.
 * @param {string} text content.
 * @returns {string} bounded content.
 */
function boundText(text) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= MAX_RENDER_CHARS && Buffer.byteLength(value, 'utf8') <= MAX_RENDER_BYTES) return value
  const tail = tailByBytes(value, MAX_RENDER_BYTES)
  const clipped = tail.text.length > MAX_RENDER_CHARS ? tail.text.slice(-MAX_RENDER_CHARS) : tail.text
  return `[output truncated: showing the last ${clipped.length} characters]\n${clipped}`
}

/**
 * @param {any} session session.
 * @param {number} maxBytes byte bound.
 * @param {'text' | 'ansi'} [format] format.
 * @returns {string} bounded scrollback text.
 */
function boundedScrollbackText(session, maxBytes, format = 'text') {
  const source = format === 'ansi' && typeof session.serialize === 'function'
    ? session.serialize({ scrollback: SCREENSHOT_SCROLLBACK })
    : session.fullText()
  const bounded = tailByBytes(source, maxBytes)
  return bounded.truncated ? `[scrollback truncated: last ${maxBytes} bytes]\n${bounded.text}` : bounded.text
}

/**
 * @param {any} config plugin config.
 * @returns {string} export directory.
 */
function exportDir(config) {
  if (typeof config?.historyPath === 'string' && config.historyPath.length > 0) {
    try {
      return dirname(config.historyPath)
    } catch {
      // fall through
    }
  }
  return join(tmpdir(), 'dsh-live-terminal')
}

/**
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
  lines.push(`cwd: ${value.cwd}${value.durationMs > 0 ? ` · duration: ${value.durationMs}ms` : ''}${value.signal !== null ? ` · signal: ${value.signal}` : ''}`)
  lines.push(value.output.length > 0 ? value.output : '(no output)')
  if (value.ports.length > 0) lines.push(`ports: ${value.ports.map((port) => port.url).join(', ')}`)
  if (value.timedOut) lines.push(`[timed out after ${positiveNumber(args.timeoutMs) ?? config.commandTimeoutMs}ms; terminal terminated]`)
  if (value.aborted) lines.push('[aborted; terminal terminated]')
  if (value.truncated) lines.push('[output truncated; tail retained]')
  if (value.stillRunning) {
    lines.push(
      `[still running; use live_terminal_wait, live_terminal_screenshot or live_terminal_read with terminalId ${value.terminalId} to follow it]`,
    )
  }
  if (!value.sandbox.confined) lines.push('[sandbox: unconfined (runs with the system user\'s permissions)]')
  if (!value.timedOut && !value.aborted && value.exitCode !== null && value.exitCode !== 0) {
    lines.push(`[exit code: ${value.exitCode}]`)
  }
  const failedOutcome = value.timedOut || value.aborted || (value.exitCode !== null && value.exitCode !== 0)
  const closeDelay = failedOutcome ? config.autoCloseFailedDelayMs : config.autoCloseCommandDelayMs
  const autoCloseEnabled = config.autoCloseToolTerminals !== false && closeDelay !== -1
  if (autoCloseEnabled && args.keepOpen !== true && !value.stillRunning) {
    lines.push(`[terminal closes automatically after ${closeDelay}ms; pass keepOpen:true to keep it open]`)
  }
  return boundText(lines.join('\n'))
}

/**
 * @param {any} value tool value.
 * @returns {{ type: string, text?: string, attachment?: any }[]} content blocks.
 */
function renderScreenshot(value) {
  const header = `[terminal ${value.title} ${value.cols}x${value.rows} cursor (${value.cursor.x},${value.cursor.y}) ${value.state}]`
  const blocks = [{ type: 'text', text: boundText(`${header}\n${value.text.length > 0 ? value.text : '(empty screen)'}`) }]
  if (value.image !== undefined && value.image !== null) {
    blocks.push({
      type: 'image',
      attachment: {
        attachmentId: value.image.attachmentId,
        mediaType: value.image.mediaType,
        bytes: value.image.bytes,
        width: value.image.width,
        height: value.image.height,
        ...(value.image.name === undefined ? {} : { name: value.image.name }),
      },
    })
  }
  if (value.warnings.length > 0) {
    blocks[0].text += `\n[warnings: ${value.warnings.join(' | ')}]`
  }
  return blocks
}

/**
 * @param {any[]} terminals session infos.
 * @param {number} historyCount closed history count.
 * @returns {string} rendered list.
 */
function renderList(terminals, historyCount) {
  if (terminals.length === 0) return historyCount > 0 ? `(no live terminals; ${historyCount} closed command(s) in history)` : '(no terminal sessions)'
  return terminals
    .map((session) => {
      const status = session.state === 'running' ? 'running' : `${session.state} exit=${session.exitCode ?? 'null'}${session.signal ? ` signal=${session.signal}` : ''}`
      const auto = session.autoCloseAt ? ` auto-close@${new Date(session.autoCloseAt).toISOString()}` : ''
      return `${session.id} [${session.kind}/${session.owner}] ${status}${auto} ${session.cols}x${session.rows} ${session.title} (${session.cwd})${session.sandbox && session.sandbox.confined === false ? ' [unsandboxed]' : ''}`
    })
    .join('\n')
}

/**
 * @param {any[]} entries history entries.
 * @returns {string} rendered history.
 */
function renderHistory(entries) {
  if (entries.length === 0) return '(no closed command history)'
  return entries
    .map((entry) => {
      const seconds = Math.max(0, Math.round(entry.durationMs / 1000))
      const firstLine = entry.text.split(/\r?\n/u).filter((line) => line.trim() !== '').slice(-1)[0] ?? ''
      return `${entry.id} [exit=${entry.exitCode ?? 'null'}${entry.signal ? ` ${entry.signal}` : ''}] ${seconds}s ${entry.title}\n  ${firstLine.slice(0, 160)}`
    })
    .join('\n')
}

/**
 * @param {any} value search value.
 * @returns {string} rendered search results.
 */
function renderSearch(value) {
  if (value.matches.length === 0) return `(no matches in ${value.totalLines} lines)`
  const lines = [`${value.matches.length}${value.truncated ? '+' : ''} match(es) in ${value.totalLines} lines:`]
  for (const match of value.matches) {
    lines.push(`${match.line}: ${match.text}`)
  }
  return lines.join('\n')
}

/**
 * @param {string} id terminal id.
 * @param {string} state state.
 * @param {number | null} exitCode exit code.
 * @param {string | null} signal signal.
 * @param {number | null} duration duration.
 * @param {boolean} timedOut timed out.
 * @param {boolean} matched pattern matched.
 * @param {string} text output tail.
 * @param {boolean} truncated truncated.
 * @returns {any} wait value.
 */
function waitValue(id, state, exitCode, signal, duration, timedOut, matched, text, truncated) {
  return {
    terminalId: id,
    state,
    exitCode,
    signal,
    durationMs: duration,
    timedOut,
    matched,
    text: boundText(text),
    truncated: truncated === true,
  }
}

/**
 * @param {number} ms milliseconds.
 * @returns {Promise<void>} timer.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
