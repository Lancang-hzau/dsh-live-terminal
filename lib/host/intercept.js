/**
 * Built-in shell-tool interception.
 *
 * Every foreground `pwsh` / `bash` call is mirrored into the visible terminal
 * panel: the plugin creates a `kind: 'command'` session, runs the command there,
 * waits for the process to exit and returns a value shaped exactly like the
 * built-in tool's `foreground` output. Any failure falls back to the original
 * implementation (`next()`), so the agent never loses the ability to run a
 * command if the panel backend is unavailable.
 */

import { commandOutputText } from './ansi.js'
import { commandTitle } from './wrapper.js'

/** Default timeout for an intercepted command when the tool call omits one. */
export const INTERCEPT_DEFAULT_TIMEOUT_MS = 120_000
/** Tools whose foreground calls are mirrored into the panel. */
export const INTERCEPTED_TOOLS = ['pwsh', 'bash']
/**
 * Shell-kind hint per intercepted tool name. The intercepted command must run
 * in the same shell dialect the built-in tool would use: `bash` commands must
 * never be executed by PowerShell (or vice versa), otherwise quoting/expansion
 * semantics silently change. When no compatible shell resolves, the
 * interceptor falls back to the original tool.
 */
export const SHELL_KIND_HINTS = { bash: 'bash', pwsh: 'pwsh' }

/**
 * Register the `tools/execute` waterfall interceptor.
 * @param {any} ctx plugin context with the tools service.
 * @param {{ get registry(): any, config: object, logger?: any }} plugin plugin state.
 * @returns {void}
 */
export function registerIntercept(ctx, plugin) {
  if (plugin.config.interceptShellTools !== true) return
  ctx.on('tools/execute', async (exec, next) => {
    if (!shouldIntercept(exec, plugin.config)) return next()
    const registry = plugin.registry
    if (registry === undefined) return next()
    const command = exec.arguments.command
    const timeoutMs = positiveNumber(exec.arguments.timeoutMs) ?? INTERCEPT_DEFAULT_TIMEOUT_MS
    let session
    try {
      const cwd = await registry.resolveCwd(exec.agent, exec.arguments.workdir, exec.signal)
      session = await registry.createCommandSession({
        command,
        cwd,
        agent: exec.agent,
        agentId: exec.agent?.id,
        sessionId: exec.agent?.session?.id,
        timeoutMs,
        title: commandTitle(command),
        signal: exec.signal,
        // Keep the built-in tool's dialect: bash commands run in a POSIX shell,
        // pwsh commands in PowerShell. A hinted-shell resolution failure throws
        // and is handled by the catch below (fall back to the built-in tool).
        shellKindHint: SHELL_KIND_HINTS[exec.name],
        // Intercepted commands are subject to the "don't show fast commands"
        // rule and the auto-close policy (see TerminalRegistry).
        origin: 'intercept',
      })
      const result = await registry.waitForCommandSession(session, { timeoutMs, signal: exec.signal })
      return {
        value: buildForegroundValue({
          cwd,
          output: result.output,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          aborted: result.aborted,
          timeoutMs,
          truncated: result.truncated,
        }),
      }
    } catch (error) {
      if (session !== undefined) {
        registry.close(session.id).catch(() => {})
      }
      plugin.logger?.warn?.(
        `[dsh-live-terminal] visible-command interception fell back to the built-in ${exec.name} tool: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return next()
    }
  })
}

/**
 * Whether this tool execution should be mirrored into the panel.
 *
 * Background calls and sandbox escalation requests keep the built-in semantics
 * (jobs, approvals, sandbox) and are never intercepted.
 *
 * @param {any} exec tool execution context.
 * @param {any} config plugin config.
 * @returns {boolean} whether to intercept.
 */
export function shouldIntercept(exec, config) {
  if (config?.interceptShellTools !== true) return false
  if (exec === undefined || exec === null) return false
  if (!INTERCEPTED_TOOLS.includes(exec.name)) return false
  if (exec.agent === undefined || exec.agent === null) return false
  const args = exec.arguments
  if (args === undefined || args === null || typeof args !== 'object') return false
  if (args.run_in_background === true) return false
  if (args.sandbox_permissions !== undefined) return false
  if (typeof args.command !== 'string' || args.command.trim().length === 0) return false
  if (exec.signal?.aborted === true) return false
  return true
}

/**
 * Build the built-in pwsh/bash `foreground` output value.
 *
 * The shape matches the official tools' output schema exactly:
 * `{ kind, cwd, exitCode, signal, timedOut, aborted, timeoutMs, stdout, stderr }`.
 *
 * @param {object} options value inputs.
 * @param {string} options.cwd resolved working directory.
 * @param {string} options.output merged plain-text output (ANSI stripped).
 * @param {number | null} options.exitCode process exit code.
 * @param {string | null} options.signal termination signal when the plugin killed it.
 * @param {boolean} options.timedOut whether the wait deadline expired.
 * @param {boolean} options.aborted whether the call was cancelled.
 * @param {number} options.timeoutMs effective timeout.
 * @param {boolean} [options.truncated] whether the output tail was truncated.
 * @param {number} [options.maxOutputBytes] output byte budget for the note.
 * @returns {{ kind: 'foreground', cwd: string, exitCode: number | null, signal: string | null, timedOut: boolean, aborted: boolean, timeoutMs: number, stdout: { text: string, truncated: boolean }, stderr: { text: string, truncated: boolean } }} foreground value.
 */
export function buildForegroundValue(options) {
  let text = commandOutputText(options.output ?? '')
  if (options.truncated === true) {
    const budget = options.maxOutputBytes === undefined ? '' : ` (last ${options.maxOutputBytes} bytes)`
    text = `[output truncated${budget}]\n${text}`
  }
  return {
    kind: 'foreground',
    cwd: options.cwd,
    exitCode: options.timedOut || options.aborted ? null : (options.exitCode ?? null),
    signal: options.timedOut || options.aborted ? 'SIGTERM' : (options.signal ?? null),
    timedOut: options.timedOut === true,
    aborted: options.aborted === true,
    timeoutMs: options.timeoutMs,
    stdout: { text, truncated: false },
    stderr: { text: '', truncated: false },
  }
}

/**
 * @param {unknown} value candidate number.
 * @returns {number | undefined} positive finite number.
 */
function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}
