/**
 * Shell resolution for the visible terminal sessions.
 *
 * Windows prefers `pwsh.exe` and falls back to `powershell.exe`; POSIX uses
 * bash. The executable is resolved through `ctx.subprocess.resolveExecutable`
 * so the plugin shares the execution world's PATH/PATHEXT semantics instead of
 * probing the host filesystem itself.
 */

/**
 * @param {string} path executable path or bare name.
 * @returns {string} lower-case executable name without a trailing `.exe`.
 */
export function executableName(path) {
  const text = typeof path === 'string' ? path : ''
  const base = text.slice(Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\')) + 1)
  return base.toLowerCase().replace(/\.exe$/u, '')
}

/**
 * Classify a shell executable.
 * @param {string} path executable path or bare name.
 * @returns {'pwsh' | 'powershell' | 'cmd' | 'bash' | 'zsh' | 'sh' | 'other'} shell kind.
 */
export function shellKind(path) {
  const name = executableName(path)
  if (name === 'pwsh' || name === 'powershell' || name === 'cmd') return name
  if (name === 'bash' || name === 'zsh' || name === 'sh') return name
  return 'other'
}

/**
 * Interactive argv for a shell (no command).
 * @param {{ path: string, kind: string }} shell resolved shell profile.
 * @returns {string[]} argv for a PTY spawn.
 */
export function interactiveArgv(shell) {
  if (shell.kind === 'pwsh' || shell.kind === 'powershell') return [shell.path, '-NoLogo']
  if (shell.kind === 'cmd') return [shell.path]
  return [shell.path, '-i']
}

/**
 * One-shot command argv for a shell. The command string is passed verbatim as
 * one argv element — it is never re-parsed by this plugin.
 *
 * PowerShell command sessions use `-NoProfile -NonInteractive` to match the
 * built-in `pwsh` executor (`dsh-pwsh-local`): loading the interactive shell
 * profile would add startup latency and could pollute the captured command
 * output (and the panel) with profile chatter. Interactive sessions keep
 * loading the profile, exactly like the official user terminal.
 *
 * @param {{ path: string, kind: string }} shell resolved shell profile.
 * @param {string} command command text.
 * @returns {string[]} argv for a PTY spawn.
 */
export function commandArgv(shell, command) {
  if (shell.kind === 'pwsh' || shell.kind === 'powershell') {
    return [shell.path, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
  }
  if (shell.kind === 'cmd') return [shell.path, '/d', '/s', '/c', command]
  return [shell.path, '-c', command]
}

/**
 * Candidate executable names for the running execution environment.
 * @param {'windows' | 'posix'} platform environment platform.
 * @param {string} [configured] configured shell path override.
 * @param {string} [defaultShell] provider default shell (used as the last Windows candidate).
 * @returns {string[]} ordered candidates.
 */
export function shellCandidates(platform, configured, defaultShell) {
  if (typeof configured === 'string' && configured.length > 0) return [configured]
  if (platform === 'windows') {
    const candidates = ['pwsh', 'powershell']
    if (typeof defaultShell === 'string' && defaultShell.length > 0) candidates.push(defaultShell)
    candidates.push('cmd.exe')
    return [...new Set(candidates)]
  }
  const candidates = ['bash']
  if (typeof defaultShell === 'string' && defaultShell.length > 0) candidates.push(defaultShell)
  return [...new Set(candidates)]
}

/**
 * Resolve one shell executable through the subprocess service.
 *
 * A declared `shellPath` is authoritative: when it cannot be resolved this
 * rejects rather than silently falling back, so a misconfigured profile is
 * visible instead of surprising.
 *
 * @param {{ subprocess: any, shellPath?: string, signal?: AbortSignal }} options resolver inputs.
 * @returns {Promise<{ path: string, kind: string }>} resolved shell profile.
 */
export async function resolveShell({ subprocess, shellPath, signal }) {
  if (subprocess === undefined || subprocess === null) {
    throw new Error('dsh-terminal-panel: the subprocess service is unavailable; cannot spawn a terminal')
  }
  const environment = typeof subprocess.terminalEnvironment === 'function' ? await subprocess.terminalEnvironment(signal) : undefined
  const platform = environment?.platform === 'windows' ? 'windows' : 'posix'
  const candidates = shellCandidates(platform, shellPath, environment?.defaultShell)
  const failures = []
  for (const candidate of candidates) {
    try {
      const path = await subprocess.resolveExecutable(candidate, undefined, signal)
      return { path, kind: shellKind(path) }
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (shellPath !== undefined) {
    throw new Error(`dsh-terminal-panel: configured shellPath ${JSON.stringify(shellPath)} could not be resolved (${failures.join('; ')})`)
  }
  throw new Error(`dsh-terminal-panel: no usable shell found (${failures.join('; ')})`)
}
