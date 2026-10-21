/**
 * Run one command inside an existing interactive terminal and capture its
 * output and exit status.
 *
 * A fresh one-shot command terminal (`live_terminal_run`) is the right tool for
 * stateless commands, but it cannot preserve shell state: `cd`, `export`,
 * an activated virtualenv, aliases or REPL variables vanish with the process.
 * This helper wraps the command in unique start/end markers inside the
 * already-open interactive shell, polls the mirrored plain text for the end
 * marker, and returns exactly that command's output plus its exit status.
 *
 * Marker wrapping reuses `wrapper.js` (the same shape the official persistent
 * pwsh tool uses). The wrapper is written into the PTY, so the shell line editor
 * echoes it; `parseWrappedOutput` strips that echo. The session's visible screen
 * therefore shows the marker lines while the command runs, which is acceptable
 * for an explicit, model-initiated operation.
 *
 * Invariants:
 * - never terminates the session on timeout (the caller decides what to do);
 * - serialized per session (one wrapper in flight at a time, so two concurrent
 *   tool calls cannot interleave markers and steal each other's output);
 * - only `/bin/sh`-family shells and PowerShell are supported; `cmd.exe` has no
 *   portable wrapper and is rejected with a clear error.
 */

import {
  createMarkers,
  parseWrappedOutput,
  partialWrappedOutput,
  wrapPwshCommand,
} from './wrapper.js'

/** Poll interval for the marker parser (matches the wrapper reference design). */
const POLL_INTERVAL_MS = 25

/** Default wait budget. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Smallest accepted wait budget (avoids a busy loop from `timeoutMs: 0`). */
const MIN_TIMEOUT_MS = 100

/** Largest accepted wait budget. */
const MAX_TIMEOUT_MS = 600_000

/** Per-session serialization chains. */
const CHAINS = new WeakMap()

/**
 * @typedef {object} ExecResult
 * @property {number | null} exitCode command exit code (`null` when unknown).
 * @property {string} output captured output between the markers.
 * @property {boolean} timedOut whether the wait budget expired first.
 * @property {number} durationMs wall-clock duration.
 */

/**
 * @param {number} ms milliseconds.
 * @returns {Promise<void>} timer promise.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Classify a shell kind into a wrapper dialect.
 *
 * @param {string | undefined} kind shell kind.
 * @returns {'pwsh' | 'posix' | 'unsupported'} dialect.
 */
function dialectOf(kind) {
  const value = typeof kind === 'string' ? kind.toLowerCase() : ''
  if (value === 'pwsh' || value === 'powershell') return 'pwsh'
  if (value === 'bash' || value === 'zsh' || value === 'sh' || value === 'gitbash') return 'posix'
  return 'unsupported'
}

/**
 * Escape a command for embedding in a POSIX single-quoted string.
 *
 * @param {string} value command text.
 * @returns {string} escaped body (without the surrounding quotes).
 */
function quoteForPosix(value) {
  return String(value).replaceAll("'", "'\\''")
}

/**
 * Build the single wrapper line typed into a POSIX interactive shell.
 *
 * `eval` deliberately runs in the current shell (not a subshell) so state
 * changes such as `cd` / `export` survive the call. The exit status is captured
 * immediately after `eval`.
 *
 * @param {string} command command text.
 * @param {{ start: string, end: string }} marker marker pair.
 * @returns {string} wrapper text (no trailing newline).
 */
export function wrapPosixCommand(command, marker) {
  return [
    `printf '%s\\n' '${marker.start}'`,
    `eval '${quoteForPosix(command)}'`,
    '__dsh_exit=$?',
    `printf '%s%d\\n' '${marker.end}' "$__dsh_exit"`,
  ].join('; ')
}

/**
 * Build the wrapper text for one shell dialect.
 *
 * @param {string} command command text.
 * @param {{ start: string, end: string }} marker marker pair.
 * @param {'pwsh' | 'posix'} dialect wrapper dialect.
 * @returns {string} wrapper text.
 */
function wrapCommand(command, marker, dialect) {
  return dialect === 'pwsh' ? wrapPwshCommand(command, marker) : wrapPosixCommand(command, marker)
}

/**
 * Execute one command inside an existing session, serialized per session.
 *
 * @param {import('./session.js').TerminalPanelSession} session interactive session.
 * @param {string} command command text.
 * @param {{ timeoutMs?: number, shellKind?: string, echo?: boolean }} [options] wait options.
 * @returns {Promise<ExecResult>} outcome (never rejects for a timeout).
 */
export function execInSession(session, command, options = {}) {
  if (session === undefined || session === null) {
    return Promise.reject(new Error('execInSession requires a terminal session'))
  }
  const previous = CHAINS.get(session) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(() => execOnce(session, command, options))
  CHAINS.set(
    session,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

/**
 * One wrapper round-trip. Callers are serialized by {@link execInSession}.
 *
 * @param {import('./session.js').TerminalPanelSession} session interactive session.
 * @param {string} command command text.
 * @param {{ timeoutMs?: number, shellKind?: string, echo?: boolean }} options wait options.
 * @returns {Promise<ExecResult>} outcome.
 */
async function execOnce(session, command, options) {
  if (session === undefined || session === null) throw new Error('execInSession requires a terminal session')
  if (typeof command !== 'string' || command.trim().length === 0) throw new Error('command must be a non-empty string')
  if (session.state !== 'running') throw new Error(`terminal ${session.id} is not running`)
  const dialect = dialectOf(options.shellKind ?? session.shellKind)
  if (dialect === 'unsupported') {
    throw new Error(
      `cannot execute in a ${JSON.stringify(options.shellKind ?? session.shellKind)} shell: only PowerShell and POSIX shells support the marker wrapper`,
    )
  }
  const requestedTimeout = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) ? Math.floor(options.timeoutMs) : DEFAULT_TIMEOUT_MS
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, requestedTimeout))
  const marker = createMarkers()
  const wrapperText = wrapCommand(command, marker, dialect)
  const startedAt = Date.now()
  // The marker parser strips the shell's echo of the wrapper; `echo:true` puts
  // the submitted command back as a leading line for a transparent read.
  const echoPrefix = options.echo === true ? `${command}\n` : ''

  await session.write(`${wrapperText}\r`)

  let lastText = ''
  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastText = session.plainText()
    } catch {
      lastText = ''
    }
    const parsed = parseWrappedOutput(lastText, marker, wrapperText)
    if (parsed !== undefined) {
      return {
        exitCode: parsed.exitCode,
        output: `${echoPrefix}${parsed.output}`,
        timedOut: false,
        durationMs: Date.now() - startedAt,
      }
    }
    if (session.state !== 'running') break
    await sleep(POLL_INTERVAL_MS)
  }

  try {
    lastText = session.plainText()
  } catch {
    lastText = ''
  }
  const parsed = parseWrappedOutput(lastText, marker, wrapperText)
  if (parsed !== undefined) {
    return {
      exitCode: parsed.exitCode,
      output: `${echoPrefix}${parsed.output}`,
      timedOut: false,
      durationMs: Date.now() - startedAt,
    }
  }
  const partial = partialWrappedOutput(lastText, marker, wrapperText)
  return {
    exitCode: session.state === 'running' ? null : (session.exitCode ?? null),
    output: `${echoPrefix}${partial.output}`,
    timedOut: session.state === 'running',
    durationMs: Date.now() - startedAt,
  }
}

/** Exported for tests / callers that need the marker wrapper directly. */
export { POLL_INTERVAL_MS }
