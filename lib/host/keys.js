/**
 * Named key sequences for `live_terminal_send` / `live_terminal_exec`.
 *
 * The model must not have to hand-encode escape sequences: `"\x1b[B"`,
 * `"^[[B"` and a literal `[B` all look plausible in a tool argument, but only
 * the first one is an arrow key — the others are silently typed into the
 * terminal. This module turns a small whitelist of names into bytes and returns
 * `undefined` for anything it does not recognize, so callers can reject the
 * call instead of sending garbage.
 *
 * A single character is still accepted verbatim (for `vim`-style sequences such
 * as `[":", "w", "q", "Enter"]`); multi-character unknown names are rejected.
 */

/** Named keys (lower-case) mapped to the bytes an xterm would send. */
const NAMED_KEYS = Object.freeze({
  enter: '\r',
  return: '\r',
  tab: '\t',
  'shift+tab': '\x1b[Z',
  esc: '\x1b',
  escape: '\x1b',
  backspace: '\x7f',
  delete: '\x1b[3~',
  del: '\x1b[3~',
  insert: '\x1b[2~',
  ins: '\x1b[2~',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  'page-up': '\x1b[5~',
  pagedown: '\x1b[6~',
  'page-down': '\x1b[6~',
  space: ' ',
  f1: '\x1bOP',
  f2: '\x1bOQ',
  f3: '\x1bOR',
  f4: '\x1bOS',
  f5: '\x1b[15~',
  f6: '\x1b[17~',
  f7: '\x1b[18~',
  f8: '\x1b[19~',
  f9: '\x1b[20~',
  f10: '\x1b[21~',
  f11: '\x1b[23~',
  f12: '\x1b[24~',
})

/** Human-readable vocabulary used in tool errors and JSDoc. */
export const KEY_VOCABULARY =
  'Enter / Tab / Shift+Tab / Esc / Backspace / Delete / Insert / Up / Down / Left / Right / Home / End / PageUp / PageDown / Space / F1-F12 / C-a..C-z / 单个字符'

/** Ctrl-<letter> specification: `c-a`, `ctrl-a`, `control-a`. */
const CTRL_SPEC = /^(?:c|ctrl|control)-([a-z])$/u

/** Bracketed-paste start/end markers (DECSET 2004). */
export const BRACKETED_PASTE_START = '\x1b[200~'
export const BRACKETED_PASTE_END = '\x1b[201~'

/**
 * Resolve one named key to the bytes to write.
 *
 * Accepted forms:
 * - a named key from {@link KEY_VOCABULARY} (case-insensitive, trimmed);
 * - `C-a` .. `C-z` (also `ctrl-`/`control-`), mapped to the control code;
 * - a single character, sent verbatim.
 *
 * @param {string} name key name from the model.
 * @returns {string | undefined} bytes, or `undefined` when the name is unknown.
 */
export function keySequence(name) {
  if (typeof name !== 'string') return undefined
  const raw = name.trim()
  if (raw.length === 0) return undefined
  const lower = raw.toLowerCase()
  const named = NAMED_KEYS[lower]
  if (named !== undefined) return named
  const ctrl = CTRL_SPEC.exec(lower)
  if (ctrl !== null) {
    return String.fromCharCode(ctrl[1].charCodeAt(0) & 0x1f)
  }
  if ([...raw].length === 1) return raw
  return undefined
}

/**
 * Resolve an array of key names, throwing on the first unknown name.
 *
 * @param {string[]} keys key names from the model.
 * @returns {string} concatenated bytes.
 * @throws {Error} when one name is unknown (the message lists the vocabulary).
 */
export function resolveKeys(keys) {
  if (!Array.isArray(keys)) throw new Error('keys must be an array of key names')
  let out = ''
  for (const key of keys) {
    const sequence = keySequence(key)
    if (sequence === undefined) {
      throw new Error(`unknown key name: ${JSON.stringify(key)} (allowed: ${KEY_VOCABULARY})`)
    }
    out += sequence
  }
  return out
}

/**
 * Wrap text in a bracketed paste (DECSET 2004) so multi-line input arrives as
 * one paste instead of being submitted line by line.
 *
 * @param {string} text raw paste text.
 * @returns {string} bracketed-paste payload.
 */
export function bracketPaste(text) {
  return `${BRACKETED_PASTE_START}${typeof text === 'string' ? text : ''}${BRACKETED_PASTE_END}`
}

/**
 * Whether every key name in an array is recognized.
 *
 * @param {string[]} keys key names.
 * @returns {boolean} whether all names resolve.
 */
export function isKnownKeys(keys) {
  return Array.isArray(keys) && keys.every((key) => keySequence(key) !== undefined)
}
