/**
 * Marker-wrapped command execution helper for interactive PowerShell sessions.
 *
 * The wrapper shape is deliberately the same one
 * `@deepseek-ai/dsh-tool-pwsh-persistent` uses: print a random START marker,
 * run the model command through `Invoke-Expression`, then print an END marker
 * carrying the exit status. The host polls the session's plain-text tail for
 * the END marker and extracts the text between the markers.
 *
 * Runtime note: `live_terminal_run` and the shell interceptor no longer write
 * marker wrappers into an interactive shell — both create a dedicated one-shot
 * command session (`commandArgv` in shell.js), so their screen/output is free
 * of wrapper echo and markers. This module is retained because `commandTitle`
 * is still used for command-session titles and because the marker parser is a
 * tested, dependency-free reference implementation for interactive fallbacks.
 */

import { randomUUID } from 'node:crypto'
import { normalizeTerminalText } from './ansi.js'

/** Prefix of every wrapper marker. */
export const MARKER_PREFIX = '__DSH_TERMINAL_PANEL'

/**
 * Create one random marker pair.
 * @param {string} [nonce] deterministic nonce for tests.
 * @returns {{ start: string, end: string }} marker pair (`end` is a prefix: append the exit code).
 */
export function createMarkers(nonce = randomUUID()) {
  const suffix = nonce.replace(/[^A-Za-z0-9]/g, '')
  return {
    start: `${MARKER_PREFIX}_START_${suffix}__`,
    end: `${MARKER_PREFIX}_END_${suffix}:`,
  }
}

/**
 * Escape a command body for embedding in the wrapper's double-quoted string.
 * Backtick escapes keep every character literal: backtick first so escapes
 * inserted here are never re-escaped, then `"`, `$`, CRLF and ESC so a
 * multi-line command rides one physical input line.
 * @param {string} value model command text.
 * @returns {string} escaped double-quoted-string body.
 */
export function quoteForPwsh(value) {
  return String(value)
    .replaceAll('`', '``')
    .replaceAll('"', '`"')
    .replaceAll('$', '`$')
    .replaceAll('\r', '')
    .replaceAll('\n', '`n')
    .replaceAll('\x1B', '`e')
}

/**
 * Build the single-line wrapper typed into the interactive shell.
 *
 * Exit detection is the reference persistent-pwsh logic with one addition:
 * PowerShell 5.1 in an interactive session reports `$? = True` for a command
 * that wrote a non-terminating error (while `pwsh -Command` exits non-zero),
 * so the wrapper also compares `$Error.Count` around `Invoke-Expression` to
 * keep the mirrored exit status aligned with the built-in shell tools.
 *
 * @param {string} command model command text.
 * @param {{ start: string, end: string }} marker marker pair.
 * @returns {string} wrapper text (no trailing newline).
 */
export function wrapPwshCommand(command, marker) {
  const body = quoteForPwsh(command)
  return [
    `Write-Output '${marker.start}'`,
    '$LASTEXITCODE = $null',
    '$__s = 1',
    '$__e0 = $Error.Count',
    `try { Invoke-Expression "${body}"; $__ok = $? -and ($Error.Count -eq $__e0) } catch { $__ok = $false }`,
    'if ($null -ne $LASTEXITCODE) { $__s = [int]$LASTEXITCODE } else { $__s = if ($__ok) { 0 } else { 1 } }',
    `Write-Output ('${marker.end}' + $__s)`,
  ].join('; ')
}

/**
 * Extract the output captured between the last START marker before the last
 * END marker and the END marker itself.
 *
 * The wrapper echo (PowerShell echoes the typed line) is removed wherever it
 * appears, and the exit status following the END marker is parsed.
 *
 * @param {string} plainText plain (ANSI-stripped) session tail.
 * @param {{ start: string, end: string }} marker marker pair.
 * @param {string} wrapperText wrapper line that was typed.
 * @returns {{ output: string, exitCode: number, incomplete: boolean } | undefined} parsed result.
 */
export function parseWrappedOutput(plainText, marker, wrapperText) {
  const text = typeof plainText === 'string' ? plainText : ''
  const end = text.lastIndexOf(marker.end)
  if (end < 0) return undefined
  const statusMatch = /^\s*(\d+)\s*(?:\n|$)/u.exec(text.slice(end + marker.end.length))
  if (statusMatch === null) return undefined
  const startMarker = text.lastIndexOf(marker.start, end)
  const start = startMarker < 0 ? 0 : startMarker + marker.start.length
  let captured = text.slice(start, end)
  if (typeof wrapperText === 'string' && wrapperText.length > 0) {
    captured = captured.split(wrapperText).join('')
  }
  return {
    output: trimCaptured(captured),
    exitCode: Number(statusMatch[1]),
    incomplete: startMarker < 0,
  }
}

/**
 * Extract whatever output the command already produced when it has not
 * finished yet (used for timeouts, aborts and shell exit).
 * @param {string} plainText plain (ANSI-stripped) session tail.
 * @param {{ start: string, end: string }} marker marker pair.
 * @param {string} wrapperText wrapper line that was typed.
 * @param {string} [fallbackText] fallback plain text when the tail lost the START marker.
 * @returns {{ output: string, incomplete: boolean }} captured output.
 */
export function partialWrappedOutput(plainText, marker, wrapperText, fallbackText = '') {
  const text = typeof plainText === 'string' ? plainText : ''
  const startIndex = text.lastIndexOf(marker.start)
  const removeWrapper = (value) => (typeof wrapperText === 'string' && wrapperText.length > 0 ? value.split(wrapperText).join('') : value)
  if (startIndex >= 0) {
    return { output: trimCaptured(removeWrapper(text.slice(startIndex + marker.start.length))), incomplete: false }
  }
  const fallback = typeof fallbackText === 'string' ? fallbackText : ''
  const fallbackStart = fallback.lastIndexOf(marker.start)
  const afterStart = fallbackStart < 0 ? fallback : fallback.slice(fallbackStart + marker.start.length)
  return { output: trimCaptured(removeWrapper(afterStart)), incomplete: fallbackStart < 0 }
}

/**
 * First line of a command, truncated for use as a terminal title.
 * @param {string} command command text.
 * @param {number} [maxLength] maximum title length.
 * @returns {string} display title.
 */
export function commandTitle(command, maxLength = 80) {
  const text = typeof command === 'string' ? command : ''
  const firstLine = text.split(/\r?\n/u)[0]?.trim() ?? ''
  const fallback = firstLine.length > 0 ? firstLine : 'command'
  return fallback.length > maxLength ? `${fallback.slice(0, maxLength - 1)}…` : fallback
}

/**
 * Strip wrapper echo / marker residue and surrounding newlines from a captured
 * region, normalising CRLF into plain newlines.
 * @param {string} captured raw captured text.
 * @returns {string} cleaned output.
 */
function trimCaptured(captured) {
  const normalized = normalizeTerminalText(captured)
  return normalized.replace(/^\n+/u, '').replace(/\n+$/u, '')
}
