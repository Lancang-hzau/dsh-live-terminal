/**
 * Localhost URL / port detection for visible terminal output.
 *
 * The detector is intentionally conservative: it only reports loopback-style
 * hosts (`localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0`), because those are the
 * addresses a developer can open from the same machine. Arbitrary external
 * URLs are handled by the client-side link provider, not by this module.
 *
 * `extractPorts()` is pure apart from `Date.now()` and is safe to call on every
 * output chunk. The registry/session layer de-duplicates by URL and keeps the
 * first/last seen timestamps, so this function is allowed to be stateless.
 */

import { stripAnsi } from './ansi.js'

/** Loopback-style hosts a local dev server prints. */
const LOOPBACK_HOSTS = '(?:localhost|127\\.0\\.0\\.1|\\[::1\\]|0\\.0\\.0\\.0)'

/** Full URL: scheme, loopback host, optional explicit port, then path/query. */
const URL_WITH_SCHEME = new RegExp(
  `(https?)://(${LOOPBACK_HOSTS})(?::(\\d{1,5}))?[^\\s"'<>()\\[\\]{}]*`,
  'gi',
)

/** Bare `host:port` occurrence (what many dev servers actually print). */
const BARE_HOST_PORT = new RegExp(`(?<![\\w.:/-])(${LOOPBACK_HOSTS}):(\\d{1,5})(?![\\d])`, 'gi')

/** Trailing punctuation that most likely belongs to prose, not to the URL. */
const TRAILING_PUNCTUATION = /[.,;:!?'"`)\]}>]+$/u

/** Upper bound of ports returned for one chunk, so noisy output cannot flood. */
const MAX_PORTS_PER_CALL = 32

/**
 * @typedef {object} PortInfo
 * @property {string} url normalized URL (with scheme).
 * @property {number} port TCP port.
 * @property {string} host host name as written in the output (lower-case).
 * @property {number} firstSeenAt epoch ms when this module first saw the URL.
 * @property {number} lastSeenAt epoch ms of the most recent sighting.
 */

/**
 * Normalize a host capture to a lowercase comparison form.
 * @param {string} host raw host text.
 * @returns {string} lower-case host.
 */
function normalizeHost(host) {
  return host.toLowerCase()
}

/**
 * Parse a positive TCP port; returns `undefined` for out-of-range values.
 * @param {string | undefined} raw digits.
 * @returns {number | undefined} valid port.
 */
function parsePort(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  const port = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return undefined
  return port
}

/**
 * Extract loopback URLs and bare `host:port` occurrences from one text chunk.
 *
 * The result is de-duplicated by `host:port` and bounded to
 * {@link MAX_PORTS_PER_CALL}. Timestamps are `Date.now()` for both first and
 * last sighting; a caller that keeps a Map updates `firstSeenAt` for URLs it
 * has already seen.
 *
 * @param {string} text raw terminal text (ANSI tolerated).
 * @returns {PortInfo[]} detected ports, in first-sighting order.
 */
export function extractPorts(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const plain = stripAnsi(text)
  if (plain.length === 0) return []

  /** @type {Map<string, PortInfo>} */
  const found = new Map()
  const now = Date.now()

  /**
   * @param {string} url normalized URL.
   * @param {number} port TCP port.
   * @param {string} host host.
   * @returns {void}
   */
  const record = (url, port, host) => {
    const key = `${normalizeHost(host)}:${port}`
    if (found.has(key) || found.size >= MAX_PORTS_PER_CALL) return
    found.set(key, {
      url,
      port,
      host: normalizeHost(host),
      firstSeenAt: now,
      lastSeenAt: now,
    })
  }

  // Scheme URLs first: their explicit port (or the scheme default) wins over a
  // later bare `host:port` hit in the same string.
  for (const match of plain.matchAll(URL_WITH_SCHEME)) {
    const scheme = match[1].toLowerCase()
    const host = match[2]
    const raw = match[0].replace(TRAILING_PUNCTUATION, '')
    const url = `${scheme}${raw.slice(raw.indexOf(':'))}`
    const port = parsePort(match[3]) ?? (scheme === 'https' ? 443 : 80)
    record(url, port, host)
  }

  for (const match of plain.matchAll(BARE_HOST_PORT)) {
    const host = match[1]
    const port = parsePort(match[2])
    if (port === undefined) continue
    record(`http://${normalizeHost(host)}:${port}`, port, host)
  }

  return [...found.values()]
}
