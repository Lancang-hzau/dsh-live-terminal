/**
 * ANSI / control-sequence helpers shared by the host half.
 *
 * Everything in this module is pure (no services, no I/O) so it can be
 * exercised directly by `node:test`.
 */

/** OSC sequences terminated by ST (`ESC \`), e.g. window titles with an ST end. */
const OSC_ST = /\u001B\][\s\S]*?\u001B\\/g

/** OSC sequences terminated by BEL, e.g. `ESC ] 0 ; title BEL`. */
const OSC_BEL = /\u001B\][^\u0007]*\u0007/g

/** DCS / SOS / PM / APC strings terminated by ST (`ESC \`). */
const STRING_ST = /\u001B[P^_X][\s\S]*?\u001B\\/g

/**
 * The standard `ansi-regex` pattern: CSI sequences and BEL-terminated OSC
 * sequences (SGR colour, cursor movement, titles, …).
 */
const ANSI = new RegExp(
  [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
  ].join('|'),
  'g',
)

/** C0 control characters that carry no meaning in model-facing text. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/**
 * Remove ANSI escape sequences (CSI / OSC / DCS / single-character ESC).
 * @param {string} text raw terminal text.
 * @returns {string} text without escape sequences.
 */
export function stripAnsi(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  return text
    .replace(OSC_ST, '')
    .replace(OSC_BEL, '')
    .replace(STRING_ST, '')
    .replace(ANSI, '')
}

/**
 * Convert raw PTY text into the plain, line-oriented text used for the wrapper
 * parser and for model-facing "read" output.
 *
 * - strips ANSI escapes,
 * - normalises CRLF / lone CR to `\n` (progress redraws become separate lines),
 * - removes remaining C0 controls (except newline and tab).
 *
 * @param {string} text raw terminal text.
 * @returns {string} plain text.
 */
export function normalizeTerminalText(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  return stripAnsi(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(CONTROL, '')
}

/**
 * Collapse trailing whitespace on every line of a screen snapshot, mirroring
 * the right-trim `translateToString(true)` behaviour of xterm.js.
 * @param {string} text plain text.
 * @returns {string} text with trailing spaces per line removed.
 */
export function trimLineEnds(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  return text
    .split('\n')
    .map((line) => line.replace(/[ \u00A0]+$/u, ''))
    .join('\n')
}

/**
 * Normalise model-facing command output: plain text, CRLF collapsed, trailing
 * blank lines removed.
 * @param {string} text raw terminal text.
 * @returns {string} model-facing output.
 */
export function commandOutputText(text) {
  const normalized = normalizeTerminalText(text)
  return normalized.replace(/\n+$/u, '')
}
